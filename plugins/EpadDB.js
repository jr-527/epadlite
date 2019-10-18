const fp = require('fastify-plugin');
const fs = require('fs-extra');
const path = require('path');
const Sequelize = require('sequelize');
const config = require('../config/index');
const {
  InternalError,
  ResourceNotFoundError,
  BadRequestError,
  UnauthorizedError,
} = require('../utils/EpadErrors');

async function epaddb(fastify, options, done) {
  const models = {};

  fastify.decorate('initMariaDB', async () => {
    const sequelizeConfig = {
      dialect: 'mariadb',
      database: config.thickDb.name,
      host: config.thickDb.host,
      port: config.thickDb.port,
      username: config.thickDb.user,
      password: config.thickDb.pass,
      pool: {
        max: 5,
        min: 0,
        acquire: 30000,
        idle: 10000,
      },
      define: {
        timestamps: false,
      },
      logging: config.thickDb.logger,
    };

    // code from https://github.com/lyquocnam/fastify-sequelize/blob/master/index.js
    // used sequelize itself to get the latest version with mariadb support
    await new Promise(async (resolve, reject) => {
      try {
        const sequelize = new Sequelize(sequelizeConfig);
        fastify.decorate('orm', sequelize);
        await fastify.orm.authenticate();
      } catch (err) {
        if (config.env === 'test') {
          try {
            sequelizeConfig.database = '';
            const sequelize = new Sequelize(sequelizeConfig);
            await sequelize.query(`CREATE DATABASE ${config.thickDb.name};`);
            await fastify.orm.authenticate();
          } catch (testDBErr) {
            reject(new InternalError('Creating test mariadb database', testDBErr));
          }
        } else {
          reject(new InternalError(`Connecting to mariadb ${config.thickDb.name}`, err));
        }
      }
      try {
        const filenames = fs.readdirSync(`${__dirname}/../models`);
        for (let i = 0; i < filenames.length; i += 1) {
          models[filenames[i].replace(/\.[^/.]+$/, '')] = fastify.orm.import(
            path.join(__dirname, '/../models', filenames[i])
          );
        }
        models.user.belongsToMany(models.project, {
          through: 'project_user',
          as: 'projects',
          foreignKey: 'user_id',
        });
        models.worklist.hasMany(models.worklist_study, {
          foreignKey: 'worklist_id',
        });
        models.project.belongsToMany(models.user, {
          through: 'project_user',
          as: 'users',
          foreignKey: 'project_id',
        });
        // models.worklist.belongsTo(models.user, { foreignKey: 'user_id' });

        models.worklist.belongsToMany(models.user, {
          through: 'worklist_user',
          as: 'users',
          foreignKey: 'worklist_id',
        });

        models.user.belongsToMany(models.worklist, {
          through: 'worklist_user',
          as: 'worklists',
          foreignKey: 'user_id',
        });

        await fastify.orm.sync();
        if (config.env === 'test') {
          try {
            await models.user.create({
              username: 'admin',
              firstname: 'admin',
              lastname: 'admin',
              email: 'admin@gmail.com',
              admin: true,
              createdtime: Date.now(),
              updatetime: Date.now(),
            });
          } catch (userCreateErr) {
            reject(new InternalError('Creating admin user in testdb', userCreateErr));
          }
        }
        resolve();
      } catch (err) {
        reject(new InternalError('Leading models and syncing db', err));
      }
    });
  });

  fastify.decorate('findUserIdInternal', username => {
    const query = new Promise(async (resolve, reject) => {
      try {
        // find user id
        const user = await models.user.findOne({ where: { username }, attributes: ['id'] });
        if (user === null) reject(new ResourceNotFoundError('User', username));
        const userId = user.dataValues.id;
        // find project id
        resolve(userId);
      } catch (err) {
        reject(new InternalError('Retrieving user info', err));
      }
    });
    return query;
  });

  // PROJECTS
  fastify.decorate('createProject', (request, reply) => {
    models.project
      .create({
        name: request.body.projectName,
        projectid: request.body.projectId,
        description: request.body.projectDescription,
        defaulttemplate: request.body.defaultTemplate,
        type: request.body.type,
        updatetime: Date.now(),
        createdtime: Date.now(),
        creator: request.epadAuth.username,
      })
      .then(async project => {
        // create relation as owner
        try {
          const userId = await fastify.findUserIdInternal(request.epadAuth.username);
          const entry = {
            project_id: project.id,
            user_id: userId,
            role: 'Owner',
            createdtime: Date.now(),
            updatetime: Date.now(),
            creator: request.epadAuth.username,
          };
          await models.project_user.create(entry);
          fastify.log.info(`Project with id ${project.id} is created successfully`);
          reply.code(200).send(`Project with id ${project.id} is created successfully`);
        } catch (errPU) {
          reply.send(
            new InternalError(
              'Getting user info for project owner and creating project owner relationship',
              errPU
            )
          );
        }
      })
      .catch(err => {
        reply.send(new InternalError('Creating project', err));
      });
  });

  fastify.decorate('updateProject', (request, reply) => {
    const query = {};
    const keys = Object.keys(request.query);
    const values = Object.values(request.query);
    for (let i = 0; i < keys.length; i += 1) {
      if (keys[i] === 'projectName') {
        query.name = values[i];
      } else {
        query[keys[i]] = values[i];
      }
    }
    query.updated_by = request.epadAuth.username;
    query.updatetime = Date.now();
    models.project
      .update(query, {
        where: {
          projectid: request.params.project,
        },
      })
      .then(() => {
        fastify.log.info(`Project ${request.params.project} is updated`);
        reply.code(200).send(`Project ${request.params.project} is updated successfully`);
      })
      .catch(err => {
        reply.send(new InternalError('Updating project', err));
      });
  });

  fastify.decorate(
    'deleteRelationAndOrphanedCouchDocInternal',
    (dbProjectId, relationTable, uidField) =>
      new Promise(async (resolve, reject) => {
        try {
          const uidsToDeleteObjects = await models[relationTable].findAll({
            attributes: [uidField],
            where: { project_id: dbProjectId },
            order: [[uidField, 'ASC']],
          });
          const uidsToDelete = [];
          if (uidsToDeleteObjects) {
            for (let i = 0; i < uidsToDeleteObjects.length; i += 1)
              uidsToDelete.push(uidsToDeleteObjects[i][uidField]);
            if (uidsToDelete.length > 0) {
              const numDeleted = await models[relationTable].destroy({
                where: { project_id: dbProjectId },
              });
              const uidsLeftObjects = await models[relationTable].findAll({
                attributes: [uidField],
                distinct: true,
                where: { [uidField]: uidsToDelete },
                order: [[uidField, 'ASC']],
              });
              if (uidsToDelete.length === uidsLeftObjects.length)
                fastify.log.info(
                  `All ${relationTable} entries of project ${dbProjectId} are being used by other projects`
                );
              else {
                const safeToDelete = [];
                let i = 0;
                let j = 0;
                // traverse the arrays once to find the ones that only exists in the first
                // assumptions arrays are both sorted according to uid, second list is a subset of first
                while (i < uidsToDelete.length && j < uidsLeftObjects.length) {
                  if (uidsToDelete[i] === uidsLeftObjects[j][uidField]) {
                    i += 1;
                    j += 1;
                  } else if (uidsToDelete[i] < uidsLeftObjects[j][uidField]) {
                    safeToDelete.push(uidsToDelete[i]);
                    i += 1;
                  } else if (uidsToDelete[i] > uidsLeftObjects[j][uidField]) {
                    // cannot happen!
                  }
                }
                // add leftovers
                while (i < uidsToDelete.length) {
                  safeToDelete.push(uidsToDelete[i]);
                  i += 1;
                }
                if (safeToDelete.length > 0) await fastify.deleteCouchDocsInternal(safeToDelete);
                fastify.log.info(
                  `Deleted ${numDeleted} records from ${relationTable} and ${
                    safeToDelete.length
                  } docs from couchdb`
                );
              }
            }
          }
          resolve();
        } catch (err) {
          reject(
            new InternalError(`Deleting ${relationTable} entries of project ${dbProjectId}`, err)
          );
        }
      })
  );

  fastify.decorate(
    'deleteRelationAndOrphanedSubjectsInternal',
    (dbProjectId, projectId, epadAuth) =>
      new Promise(async (resolve, reject) => {
        try {
          const projectSubjects = await models.project_subject.findAll({
            where: { project_id: dbProjectId },
          });
          if (projectSubjects) {
            for (let i = 0; i < projectSubjects.length; i += 1) {
              // eslint-disable-next-line no-await-in-loop
              await fastify.deleteSubjectFromProjectInternal(
                { project: projectId, subject: projectSubjects[i].subject_uid },
                {},
                epadAuth
              );
            }
          }
          resolve();
        } catch (err) {
          reject(new InternalError(`Deleting subjects of project ${projectId}`, err));
        }
      })
  );

  fastify.decorate('deleteProject', async (request, reply) => {
    try {
      const project = await models.project.findOne({
        where: { projectid: request.params.project },
      });
      if (!project) {
        reply.code(404).send(`Project ${request.params.project} not found`);
      } else {
        // delete projects files (delete orphan files)
        await fastify.deleteRelationAndOrphanedCouchDocInternal(
          project.id,
          'project_file',
          'file_uid'
        );
        // delete projects aims (delete orphan aims)
        await fastify.deleteRelationAndOrphanedCouchDocInternal(
          project.id,
          'project_aim',
          'aim_uid'
        );
        // delete projects templates (delete orphan templates)
        await fastify.deleteRelationAndOrphanedCouchDocInternal(
          project.id,
          'project_template',
          'template_uid'
        );

        // delete projects subjects (delete orphan dicom files)
        await fastify.deleteRelationAndOrphanedSubjectsInternal(
          project.id,
          request.params.project,
          request.epadAuth
        );

        await models.project.destroy({
          where: {
            projectId: request.params.project,
          },
        });
        reply.code(200).send(`Project ${request.params.project} deleted successfully`);
      }
    } catch (err) {
      reply.send(new InternalError(`Deleting project ${request.params.project}`, err));
    }
  });

  // TODO is it needed? ozge
  fastify.decorate('getCircularReplacer', () => {
    const seen = new WeakSet();
    return (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return;
        }
        seen.add(value);
      }
      // eslint-disable-next-line consistent-return
      return value;
    };
  });

  fastify.decorate('getProjects', (request, reply) => {
    models.project
      .findAll({
        include: ['users'],
      })
      .then(projects => {
        // projects will be an array of all Project instances
        const result = [];
        projects.forEach(project => {
          const obj = {
            id: project.projectid,
            name: project.name,
            // numberOfAnnotations:
            // numberOfStudies:
            // numberOfSubjects:
            // subjectIDs:
            description: project.description,
            loginNames: [],
            type: project.type,
          };

          project.users.forEach(user => {
            obj.loginNames.push(user.username);
          });
          if (request.epadAuth.admin || obj.loginNames.includes(request.epadAuth.username))
            result.push(obj);
        });
        reply.code(200).send(result);
      })
      .catch(err => {
        reply.send(
          new InternalError(
            `Getting and filtering project list for user ${request.epadAuth.username}, isAdmin ${
              request.epadAuth.admin
            }`,
            err
          )
        );
      });
  });

  fastify.decorate('createWorklist', (request, reply) => {
    try {
      const assigneeInfoArr = [];
      const assigneeIDArr = [];
      request.body.assignees.forEach(el => {
        assigneeInfoArr.push(fastify.findUserIdInternal(el));
      });
      Promise.all(assigneeInfoArr)
        .then(results => {
          results.forEach(el => {
            assigneeIDArr.push(el);
          });
          models.worklist
            .create({
              name: request.body.worklistName,
              worklistid: request.body.worklistId,
              user_id: null,
              description: request.body.description,
              updatetime: Date.now(),
              createdtime: Date.now(),
              duedate: request.body.dueDate ? new Date(`${request.body.dueDate}T00:00:00`) : null,
              creator: request.epadAuth.username,
            })
            .then(worklist => {
              const relationArr = [];
              assigneeIDArr.forEach(el => {
                relationArr.push(
                  models.worklist_user.create({
                    worklist_id: worklist.id,
                    user_id: el,
                    role: 'Assignee',
                    createdtime: Date.now(),
                    creator: request.epadAuth.username,
                  })
                );
              });
              // after resolving all send 200 or in catch send 503
              Promise.all(relationArr)
                .then(() => {
                  reply.code(200).send(`Worklist ${worklist.id} is created successfully`);
                })
                .catch(relationErr => {
                  reply.send(new InternalError('Creating worklist user association', relationErr));
                });
            })
            .catch(worklistCreationErr => {
              reply.send(new InternalError('Creating worklist', worklistCreationErr));
            });
        })
        .catch(userIDErr => {
          if (userIDErr instanceof ResourceNotFoundError)
            reply.send(new BadRequestError('Creating worklist', userIDErr));
          else reply.send(userIDErr);
        });
      // TODO: give more detailed err  message about not finding assignee id
    } catch (err) {
      if (err instanceof ResourceNotFoundError)
        reply.send(
          new BadRequestError(
            `Worklist ${request.body.worklistid} creation by user ${request.epadAuth.username}`,
            err
          )
        );
      else
        reply.send(
          new InternalError(
            `Worklist ${request.body.worklistid} creation by user ${request.epadAuth.username}`,
            err
          )
        );
    }
  });

  // ozge why these request.body.studyId : null, can they be empty
  fastify.decorate('linkWorklistToStudy', (request, reply) => {
    fastify
      .upsert(
        models.worklist_study,
        {
          worklist_id: request.params.worklist,
          project_id: request.params.project,
          updatetime: Date.now(),
          study_id: request.body.studyId ? request.body.studyId : null,
          subject_id: request.body.subjectId ? request.body.subjectId : null,
        },
        {
          worklist_id: request.params.worklist,
          project_id: request.params.project,
          study_id: request.body.studyId ? request.body.studyId : null,
          subject_id: request.body.subjectId ? request.body.subjectId : null,
        },
        request.epadAuth.username
      )
      .then(res => {
        reply
          .code(200)
          .send(
            `Study ${request.body.studyId} is linked to Worklist ${
              request.params.worklist
            } with id ${res.id}`
          );
      })
      .catch(err => {
        reply.send(
          new InternalError(
            `Linking Study ${request.body.studyId} is to Worklist ${request.params.worklist}`,
            err
          )
        );
      });
  });

  fastify.decorate('updateWorklistAssignee', async (request, reply) => {
    try {
      let oldUserId;
      let newUserId;
      // try {
      // find user id
      oldUserId = await models.user.findOne({
        where: { username: request.params.user },
        attributes: ['id'],
      });
      oldUserId = oldUserId.dataValues.id;

      newUserId = await models.user.findOne({
        where: { username: request.body.user },
        attributes: ['id'],
      });
      newUserId = newUserId.dataValues.id;
      // } catch (err) {
      //   console.log(err);
      // }
      models.worklist.update(
        { user_id: newUserId, updatetime: Date.now(), updated_by: request.epadAuth.username },
        {
          where: {
            user_id: oldUserId,
            worklistid: request.params.worklist,
          },
        }
      );
      reply.code(200).send(`Worklist ${request.params.worklist} updated successfully`);
    } catch (err) {
      if (err instanceof ResourceNotFoundError)
        reply.send(
          new BadRequestError(
            `Worklist ${request.params.worklist} update by user ${request.epadAuth.username}`,
            err
          )
        );
      else
        reply.send(
          new InternalError(
            `Worklist ${request.params.worklist} update by user ${request.epadAuth.username}`,
            err
          )
        );
    }
  });

  fastify.decorate('updateWorklist', (request, reply) => {
    models.worklist
      .update(
        { ...request.body, updatetime: Date.now(), updated_by: request.epadAuth.username },
        {
          where: {
            worklistid: request.params.worklist,
          },
        }
      )
      .then(() => {
        reply.code(200).send('Update successful');
      })
      .catch(err => reply.send(new InternalError('Updating worklist', err)));
  });

  fastify.decorate('getWorklistsOfCreator', async (request, reply) => {
    try {
      const worklists = await models.worklist.findAll({
        where: {
          creator: request.epadAuth.username,
        },
        include: [
          {
            model: models.worklist_study,
          },
          'users',
        ],
      });

      const result = [];
      for (let i = 0; i < worklists.length; i += 1) {
        const obj = {
          completionDate: worklists[i].completedate,
          dueDate: worklists[i].duedate,
          name: worklists[i].name,
          startDate: worklists[i].startdate,
          username: worklists[i].user_id,
          workListID: worklists[i].worklistid,
          description: worklists[i].description,
          projectIDs: [],
          studyStatus: [],
          studyIDs: [],
          subjectIDs: [],
        };
        const studiesArr = worklists[i].worklist_studies;
        for (let k = 0; k < studiesArr.length; k += 1) {
          obj.projectIDs.push(studiesArr[k].dataValues.project_id);
          obj.studyStatus.push(studiesArr[k].dataValues.status);
          obj.studyIDs.push(studiesArr[k].dataValues.study_id);
          obj.subjectIDs.push(studiesArr[k].dataValues.subject_id);
        }
        result.push(obj);
      }
      reply.code(200).send(result);
    } catch (err) {
      if (err instanceof ResourceNotFoundError)
        reply.send(new BadRequestError('Getting worklists', err));
      else reply.send(new InternalError('Getting worklists', err));
    }
  });

  fastify.decorate('getWorklistsOfAssignee', (request, reply) => {
    fastify
      .findUserIdInternal(request.params.user)
      .then(userId => {
        models.worklist_user
          .findAll({ where: { user_id: userId }, attributes: ['worklist_id'] })
          .then(worklistIDs => {
            const worklistPromises = [];
            worklistIDs.forEach(listID => {
              worklistPromises.push(
                models.worklist.findOne({
                  where: { id: listID.dataValues.worklist_id },
                })
              );
            });

            Promise.all(worklistPromises)
              .then(worklist => {
                const result = [];
                worklist.forEach(el => {
                  const obj = {
                    worklistID: el.worklistid,
                    name: el.name,
                    dueDate: el.duedate,
                    projectIDs: [],
                  };
                  result.push(obj);
                });
                reply.code(200).send(result);
              })
              .catch(err => {
                reply.send(new InternalError('Get worklists of assignee', err));
              });
          })
          .catch(err => {
            reply.send(new InternalError('Get worklists of assignee', err));
          });
      })
      .catch(err => {
        reply.send(new InternalError('Get worklists of assignee', err));
      });
  });

  fastify.decorate('deleteWorklist', async (request, reply) => {
    try {
      await models.worklist.destroy({
        where: {
          creator: request.epadAuth.username,
          worklistid: request.params.worklist,
        },
      });

      reply.code(200).send(`Worklist ${request.params.worklist} deleted successfully`);
    } catch (err) {
      if (err instanceof ResourceNotFoundError)
        reply.send(new BadRequestError(`Deleting worklist ${request.params.worklist}`, err));
      else reply.send(new InternalError(`Deleting worklist ${request.params.worklist}`, err));
    }
  });

  fastify.decorate('assignStudyToWorklist', (request, reply) => {
    const ids = [];
    const promises = [];

    promises.push(
      models.worklist.findOne({
        where: { worklistid: request.params.worklist },
        attributes: ['id'],
      })
    );
    promises.push(
      models.project.findOne({
        where: { projectid: request.params.project },
        attributes: ['id'],
      })
    );

    Promise.all(promises)
      .then(result => {
        ids.push(result[0].dataValues.id);
        ids.push(result[1].dataValues.id);
        models.worklist_study
          .create({
            worklist_id: ids[0],
            study_uid: request.params.study,
            subject_uid: request.params.subject,
            project_id: ids[1],
            creator: request.epadAuth.username,
            createdtime: Date.now(),
            updatetime: Date.now(),
            updated_by: request.epadAuth.username,
          })
          .then(id => reply.code(200).send(`Saving successful - ${id}`))
          .catch(err => {
            reply.send(new InternalError('Creating worklist study association in db', err));
          });
      })
      .catch(err => reply.send(new InternalError('Creating worklist study association', err)));
  });

  fastify.decorate('saveTemplateToProject', async (request, reply) => {
    try {
      let templateUid = request.params.uid;
      const project = await models.project.findOne({
        where: { projectid: request.params.project },
      });
      if (project === null) {
        reply.send(
          new BadRequestError(
            'Template saving to project',
            new ResourceNotFoundError('Project', request.params.project)
          )
        );
      } else {
        if (request.body) {
          await fastify.saveTemplateInternal(request.body);
          if (templateUid !== request.body.TemplateContainer.uid) {
            fastify.log.info(
              `The template uid sent in the url ${templateUid} is different than the template that is sent ${
                request.body.TemplateContainer.uid
              }. Using ${request.body.TemplateContainer.uid} `
            );
            templateUid = request.body.TemplateContainer.uid;
          }
        }
        await models.project_template.upsert(
          {
            project_id: project.id,
            template_uid: templateUid,
            enabled: request.query.enable === 'true',
            updatetime: Date.now(),
          },
          {
            project_id: project.id,
            template_uid: templateUid,
          },
          request.epadAuth.username
        );
        reply.code(200).send('Saving successful');
      }
    } catch (err) {
      reply.send(new InternalError(`Saving template in project ${request.params.project}`, err));
    }
  });

  fastify.decorate('getProjectTemplates', async (request, reply) => {
    try {
      const project = await models.project.findOne({
        where: { projectid: request.params.project },
      });
      if (project === null) {
        reply.send(
          new BadRequestError(
            'Template saving to project',
            new ResourceNotFoundError('Project', request.params.project)
          )
        );
      } else {
        const templateUids = [];
        const enabled = {};
        const projectTemplates = await models.project_template.findAll({
          where: { project_id: project.id },
        });
        // projects will be an array of Project instances with the specified name
        for (let i = 0; i < projectTemplates.length; i += 1) {
          templateUids.push(projectTemplates[i].template_uid);
          enabled[projectTemplates[i].template_uid] = projectTemplates[i].enabled;
        }
        const result = await fastify.getTemplatesFromUIDsInternal(request.query, templateUids);
        if (request.query.format === 'summary') {
          // add enable disable
          const editedResult = result;
          for (let i = 0; i < editedResult.length; i += 1) {
            editedResult[i].enabled = enabled[editedResult[i].containerUID] === 1;
          }
          reply.code(200).send(editedResult);
        } else {
          if (request.query.format === 'stream') {
            reply.header('Content-Disposition', `attachment; filename=templates.zip`);
          }
          reply.code(200).send(result);
        }
      }
    } catch (err) {
      reply.send(new InternalError(`Getting templates for project ${request.params.project}`, err));
    }
  });

  fastify.decorate('deleteTemplateFromProject', async (request, reply) => {
    try {
      const templateUid = request.params.uid;
      const project = await models.project.findOne({
        where: { projectid: request.params.project },
      });
      if (project === null) {
        reply.send(
          new BadRequestError(
            'Deleting template from project',
            new ResourceNotFoundError('Project', request.params.project)
          )
        );
      } else if (
        request.query.all &&
        request.query.all === 'true' &&
        request.epadAuth.admin === false
      )
        reply.send(new UnauthorizedError('User is not admin, cannot delete from system'));
      else {
        const numDeleted = await models.project_template.destroy({
          where: { project_id: project.id, template_uid: templateUid },
        });
        // if delete from all or it doesn't exist in any other project, delete from system
        if (request.query.all && request.query.all === 'true') {
          const deletednum = await models.project_template.destroy({
            where: { template_uid: templateUid },
          });
          await fastify.deleteTemplateInternal(request.params);
          reply
            .code(200)
            .send(
              `Template deleted from system and removed from ${deletednum + numDeleted} projects`
            );
        } else {
          const count = await models.project_template.count({
            where: { template_uid: templateUid },
          });
          if (count === 0) {
            await fastify.deleteTemplateInternal(request.params);
            reply
              .code(200)
              .send(`Template deleted from system as it didn't exist in any other project`);
          } else
            reply.code(200).send(`Template not deleted from system as it exists in other project`);
        }
      }
    } catch (err) {
      reply.send(
        new InternalError(
          `Template ${request.params.uid} deletion from ${request.params.project}`,
          err
        )
      );
    }
  });

  fastify.decorate('deleteTemplateFromSystem', async (request, reply) => {
    try {
      const templateUid = request.params.uid;
      const numDeleted = await models.project_template.destroy({
        where: { template_uid: templateUid },
      });
      await fastify.deleteTemplateInternal(request.params);
      reply.code(200).send(`Template deleted from system and removed from ${numDeleted} projects`);
    } catch (err) {
      reply.send(new InternalError(`Template ${request.params.uid} deletion from system`, err));
    }
  });

  fastify.decorate('addSubjectToProject', async (request, reply) => {
    try {
      const project = await models.project.findOne({
        where: { projectid: request.params.project },
      });
      if (project === null) {
        reply.send(
          new BadRequestError(
            'Adding subject to project',
            new ResourceNotFoundError('Project', request.params.project)
          )
        );
      } else {
        const projectSubject = await fastify.upsert(
          models.project_subject,
          {
            project_id: project.id,
            subject_uid: request.params.subject,
            updatetime: Date.now(),
          },
          {
            project_id: project.id,
            subject_uid: request.params.subject,
          },
          request.epadAuth.username
        );
        const studies = await fastify.getPatientStudiesInternal(
          request.params,
          undefined,
          request.epadAuth
        );
        for (let i = 0; i < studies.length; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await fastify.upsert(
            models.project_subject_study,
            {
              proj_subj_id: projectSubject.id,
              study_uid: studies[i].studyUID,
              updatetime: Date.now(),
            },
            {
              proj_subj_id: projectSubject.id,
              study_uid: studies[i].studyUID,
            },
            request.epadAuth.username
          );
        }
        reply.code(200).send('Saving successful');
      }
    } catch (err) {
      reply.send(
        new InternalError(
          `Adding subject ${request.params.subject} to project ${request.params.project}`,
          err
        )
      );
    }
  });

  fastify.decorate('getPatientsFromProject', async (request, reply) => {
    try {
      const project = await models.project.findOne({
        where: { projectid: request.params.project },
      });
      if (project === null) {
        reply.send(
          new BadRequestError(
            'Getting subjects from project',
            new ResourceNotFoundError('Project', request.params.project)
          )
        );
      } else {
        const subjectUids = [];
        const projectSubjects = await models.project_subject.findAll({
          where: { project_id: project.id },
        });
        if (projectSubjects) {
          // projects will be an array of Project instances with the specified name
          for (let i = 0; i < projectSubjects.length; i += 1) {
            subjectUids.push(projectSubjects[i].subject_uid);
          }
        }

        const result = await fastify.getPatientsInternal(
          request.params,
          subjectUids,
          request.epadAuth
        );
        if (subjectUids.length !== result.length)
          fastify.log.warn(
            `There are ${subjectUids.length} subjects associated with this project. But only ${
              result.length
            } of them have dicom files`
          );
        reply.code(200).send(result);
      }
    } catch (err) {
      reply.send(new InternalError(`Getting patients from project ${request.params.project}`, err));
    }
  });

  fastify.decorate('deleteSubjectFromProject', (request, reply) => {
    fastify
      .deleteSubjectFromProjectInternal(request.params, request.query, request.epadAuth)
      .then(result => reply.code(200).send(result))
      .catch(err => reply.send(err));
  });

  fastify.decorate(
    'deleteSubjectFromProjectInternal',
    (params, query, epadAuth) =>
      new Promise(async (resolve, reject) => {
        try {
          const project = await models.project.findOne({
            where: { projectid: params.project },
          });
          if (project === null)
            reject(
              new BadRequestError(
                'Deleting subject from project',
                new ResourceNotFoundError('Project', params.project)
              )
            );
          else if (query.all && query.all === 'true' && epadAuth.admin === false)
            reject(new UnauthorizedError('User is not admin, cannot delete from system'));
          else {
            const projectSubject = await models.project_subject.findOne({
              where: { project_id: project.id, subject_uid: params.subject },
            });
            if (projectSubject === null)
              reject(
                new BadRequestError(
                  'Deleting subject from project',
                  new ResourceNotFoundError('Project subject association', params.project)
                )
              );
            else {
              await models.project_subject_study.destroy({
                where: { proj_subj_id: projectSubject.id },
              });
              const numDeleted = await models.project_subject.destroy({
                where: { project_id: project.id, subject_uid: params.subject },
              });
              // if delete from all or it doesn't exist in any other project, delete from system
              try {
                if (query.all && query.all === 'true') {
                  const projectSubjects = await models.project_subject.findAll({
                    where: { subject_uid: params.subject },
                  });
                  const projSubjIds = [];
                  if (projectSubjects) {
                    for (let i = 0; i < projectSubjects.length; i += 1) {
                      projSubjIds.push(projectSubjects[i].id);
                      // eslint-disable-next-line no-await-in-loop
                      await models.project_subject_study.destroy({
                        where: { proj_subj_id: projectSubjects[i].id },
                      });
                    }
                    await models.project_subject.destroy({
                      where: { id: projSubjIds },
                    });
                  }
                  await fastify.deleteSubjectInternal(params, epadAuth);
                  resolve(`Subject deleted from system and removed from ${numDeleted} projects`);
                } else {
                  const projectSubjects = await models.project_subject.findAll({
                    where: { subject_uid: params.subject },
                  });
                  if (projectSubjects.length === 0) {
                    await models.project_subject_study.destroy({
                      where: { proj_subj_id: projectSubject.id },
                    });
                    await fastify.deleteSubjectInternal(params, epadAuth);
                    resolve(`Subject deleted from system as it didn't exist in any other project`);
                  } else resolve(`Subject not deleted from system as it exists in other project`);
                }
              } catch (deleteErr) {
                reject(
                  new InternalError(
                    `Study assosiation deletion during subject ${
                      params.subject
                    } deletion from project`,
                    deleteErr
                  )
                );
              }
            }
          }
        } catch (err) {
          reject(new InternalError(`Subject deletion from project ${params.subject}`, err));
        }
      })
  );

  // from CouchDB
  // fastify.decorate('getSeriesAimsFromProject', async (request, reply) => {
  //   const project = await models.project.findOne({ where: { projectid: request.params.project } });
  //     const aimUids = [];
  //     const projectSubjects = await models.project_subject.findAll({ where: { project_id: project.id } });
  //     if (projectSubjects)
  //       // projects will be an array of Project instances with the specified name
  //       projectSubjects.forEach(projectSubject => subjectUids.push(projectSubject.subject_uid));
  //     const result = await fastify.getPatientsInternal(subjectUids);
  //     reply.code(200).send(result);
  //   fastify
  //     .getAimsInternal(request.query.format, request.params)
  //     .then(result => {
  //       if (request.query.format === 'stream') {
  //         reply.header('Content-Disposition', `attachment; filename=annotations.zip`);
  //       }
  //       reply.code(200).send(result);
  //     })
  //     .catch(err => reply.code(503).send(err));
  // });

  // fastify.decorate('getStudyAims', (request, reply) => {
  //   fastify
  //     .getAimsInternal(request.query.format, request.params)
  //     .then(result => {
  //       if (request.query.format === 'stream') {
  //         reply.header('Content-Disposition', `attachment; filename=annotations.zip`);
  //       }
  //       reply.code(200).send(result);
  //     })
  //     .catch(err => reply.code(503).send(err));
  // });

  // fastify.decorate('getSubjectAims', (request, reply) => {
  //   fastify
  //     .getAimsInternal(request.query.format, request.params)
  //     .then(result => {
  //       if (request.query.format === 'stream') {
  //         reply.header('Content-Disposition', `attachment; filename=annotations.zip`);
  //       }
  //       reply.code(200).send(result);
  //     })
  //     .catch(err => reply.code(503).send(err));
  // });

  fastify.decorate('getProjectAims', async (request, reply) => {
    try {
      const project = await models.project.findOne({
        where: { projectid: request.params.project },
      });
      if (project === null)
        reply.send(
          new BadRequestError(
            'Getting aims from project',
            new ResourceNotFoundError('Project', request.params.project)
          )
        );
      else {
        const aimUids = [];
        const projectAims = await models.project_aim.findAll({ where: { project_id: project.id } });
        // projects will be an array of Project instances with the specified name
        for (let i = 0; i < projectAims.length; i += 1) {
          aimUids.push(projectAims[i].aim_uid);
        }

        const result = await fastify.getAimsInternal(
          request.query.format,
          request.params,
          aimUids,
          request.epadAuth
        );
        // .then(result => {
        if (request.query.format === 'stream') {
          reply.header('Content-Disposition', `attachment; filename=annotations.zip`);
        }
        reply.code(200).send(result);
        // })
        // .catch(err =>
        //   reply.send(
        //     new InternalError(
        //       `Getting aims from couchdb for project ${request.params.project}`,
        //       err
        //     )
        //   )
        // );
      }
    } catch (err) {
      reply.send(new InternalError(`Getting aims for project ${request.params.project}`, err));
    }
  });

  fastify.decorate('getProjectAim', async (request, reply) => {
    try {
      const project = await models.project.findOne({
        where: { projectid: request.params.project },
      });
      if (project === null)
        reply.send(
          new BadRequestError(
            `Getting aim ${request.params.aimuid} from project`,
            new ResourceNotFoundError('Project', request.params.project)
          )
        );
      else {
        const projectAimCount = await models.project_aim.count({
          where: { project_id: project.id, aim_uid: request.params.aimuid },
        });
        if (projectAimCount !== 1)
          reply.send(new ResourceNotFoundError('Project aim', request.params.aimuid));
        else {
          const result = await fastify.getAimsInternal(
            request.query.format,
            request.params,
            [request.params.aimuid],
            request.epadAuth
          );
          // .then(result => {
          if (request.query.format === 'stream') {
            reply.header('Content-Disposition', `attachment; filename=annotations.zip`);
          }
          if (result.length === 1) reply.code(200).send(result[0]);
          else {
            reply.send(new ResourceNotFoundError('Aim', request.params.aimuid));
          }
          // })
          // .catch(err => reply.send(new InternalError(`Getting project aim from couchdb`, err)));
        }
      }
    } catch (err) {
      reply.send(new InternalError(`Getting project aim`, err));
    }
  });

  fastify.decorate('saveAimToProject', async (request, reply) => {
    try {
      let aimUid = request.params.aimuid;
      let aim = request.body;
      if (!request.params.aimuid)
        aimUid = request.body.ImageAnnotationCollection.uniqueIdentifier.root;
      const project = await models.project.findOne({
        where: { projectid: request.params.project },
      });
      if (project === null)
        reply.send(
          new BadRequestError(
            `Saving aim ${aimUid} from project`,
            new ResourceNotFoundError('Project', request.params.project)
          )
        );
      else {
        if (aim) {
          // get the uid from the json and check if it is same with param, then put as id in couch document
          if (aimUid !== aim.ImageAnnotationCollection.uniqueIdentifier.root) {
            reply.send(
              new BadRequestError(
                `Saving aim to project ${request.params.project}`,
                new Error(
                  `Conflicting aimuids: the uid sent in the url ${aimUid} should be the same with imageAnnotations.ImageAnnotationCollection.uniqueIdentifier.root ${
                    aim.ImageAnnotationCollection.uniqueIdentifier.root
                  }`
                )
              )
            );
          } else await fastify.saveAimInternal(aim);
          // TODO check if the aim is already associated with any project. warn and update the project_aim entries accordingly
        } else {
          // get aim to populate project_aim data
          [aim] = await fastify.getAimsInternal('json', request.params, [aimUid], request.epadAuth);
        }
        const user =
          aim && aim.ImageAnnotationCollection.user
            ? aim.ImageAnnotationCollection.user.loginName.value
            : '';
        const template =
          aim && aim.ImageAnnotationCollection.imageAnnotations.ImageAnnotation[0].typeCode[0].code
            ? aim.ImageAnnotationCollection.imageAnnotations.ImageAnnotation[0].typeCode[0].code
            : '';
        const subjectUid =
          aim && aim.ImageAnnotationCollection.person
            ? aim.ImageAnnotationCollection.person.id.value
            : '';
        const studyUid =
          aim &&
          aim.ImageAnnotationCollection.imageAnnotations.ImageAnnotation[0]
            .imageReferenceEntityCollection.ImageReferenceEntity[0]
            ? aim.ImageAnnotationCollection.imageAnnotations.ImageAnnotation[0]
                .imageReferenceEntityCollection.ImageReferenceEntity[0].imageStudy.instanceUid.root
            : '';
        const seriesUid =
          aim &&
          aim.ImageAnnotationCollection.imageAnnotations.ImageAnnotation[0]
            .imageReferenceEntityCollection.ImageReferenceEntity[0].imageStudy.imageSeries
            ? aim.ImageAnnotationCollection.imageAnnotations.ImageAnnotation[0]
                .imageReferenceEntityCollection.ImageReferenceEntity[0].imageStudy.imageSeries
                .instanceUid.root
            : '';
        const imageUid =
          aim &&
          aim.ImageAnnotationCollection.imageAnnotations.ImageAnnotation[0]
            .imageReferenceEntityCollection.ImageReferenceEntity[0].imageStudy.imageSeries
            .imageCollection.Image[0]
            ? aim.ImageAnnotationCollection.imageAnnotations.ImageAnnotation[0]
                .imageReferenceEntityCollection.ImageReferenceEntity[0].imageStudy.imageSeries
                .imageCollection.Image[0].sopInstanceUid.root
            : '';

        await fastify.upsert(
          models.project_aim,
          {
            project_id: project.id,
            aim_uid: aimUid,
            user,
            template,
            subject_uid: subjectUid,
            study_uid: studyUid,
            series_uid: seriesUid,
            image_uid: imageUid,
            updatetime: Date.now(),
          },
          {
            project_id: project.id,
            aim_uid: aimUid,
          },
          request.epadAuth.username
        );
        // disable for now
        // update the worklist completeness if in any
        fastify.updateWorklistCompleteness(
          project.id,
          subjectUid,
          studyUid,
          user,
          request.epadAuth
        );
        reply.code(200).send('Saving successful');
      }
    } catch (err) {
      reply.send(new InternalError(`Saving aim to project ${request.params.project}`, err));
    }
  });

  fastify.decorate(
    'addWorklistRequirement',
    async (worklistId, epadAuth, level, numOfAims, template, required) => {
      await models.worklist_requirements.insert({
        worklist_id: worklistId,
        updatetime: Date.now(),
        createdtime: Date.now(),
        creator: epadAuth.username,
        level,
        numOfAims,
        template,
        required: required === true,
      });
    }
  );

  fastify.decorate(
    'updateWorklistRequirement',
    async (worklistId, reqId, epadAuth, level, numOfAims, template, required) => {
      await models.worklist_requirements.upsert(
        {
          worklist_id: worklistId,
          updatetime: Date.now(),
          level,
          numOfAims,
          template,
          required: required === true,
        },
        {
          worklist_id: worklistId,
          id: reqId,
        },
        epadAuth.username
      );
    }
  );

  fastify.decorate('setWorklistRequirement', async (request, reply) => {
    try {
      const worklist = await models.worklist.findOne({
        where: { worklistid: request.params.worklist },
        attributes: ['id'],
        raw: true,
      });
      if (!worklist)
        reply.send(
          new BadRequestError(
            `Worklist requirement ${request.params.requirement} add/update`,
            new ResourceNotFoundError('Worklist', request.params.worklist)
          )
        );
      else {
        if (request.params.requirement !== undefined)
          await fastify.updateWorklistRequirement(
            worklist.id,
            request.params.requirement,
            request.epadAuth,
            ...request.body
          );
        else await fastify.addWorklistRequirement(worklist.id, request.epadAuth, ...request.body);
        reply.code(200).send(`Worklist requirement ${request.params.requirement} added/updated`);
      }
    } catch (err) {
      reply.send(
        new InternalError(`Worklist requirement ${request.params.requirement} add/update`, err)
      );
    }
  });

  fastify.decorate(
    'updateWorklistCompleteness',
    async (projectId, subjectUid, studyUid, user, epadAuth) => {
      // TODO check if the user is an assignee

      // get worklist studies that belong to this study and user
      const worklistsStudies = await models.worklist_study.findAll({
        where: { project_id: projectId, subject_uid: subjectUid, study_uid: studyUid },
        raw: true,
      });

      // for each worklist study
      for (let i = 0; i < worklistsStudies.length; i += 1) {
        //  get requirements
        // eslint-disable-next-line no-await-in-loop
        const requirements = await models.worklist_requirements.findAll({
          where: { worklist_id: worklistsStudies[i].worklist_id },
          raw: true,
        });

        for (let j = 0; j < requirements.length; j += 1) {
          //  compute worklist completeness
          fastify.computeWorklistCompleteness(
            worklistsStudies[i].id,
            requirements[j],
            {
              numOfSeries: worklistsStudies[i].numOfSeries,
              numOfImages: worklistsStudies[i].numOfImages,
            },
            projectId,
            subjectUid,
            studyUid,
            user,
            epadAuth
          );
        }
      }
    }
  );

  fastify.decorate(
    'computeWorklistCompleteness',
    async (
      worklistStudyId,
      worklistReq,
      worklistStats,
      projectId,
      subjectUid,
      studyUid,
      user,
      epadAuth
    ) => {
      // sample worklistReq
      // eslint-disable-next-line no-param-reassign
      // worklistReq = [{ id: 1, level: 'study', numOfAims: 1, template: 'ROI', required: true }];
      // get all aims
      const aims = await models.project_aim.findAll({
        where: { project_id: projectId, subject_uid: subjectUid, study_uid: studyUid, user },
        raw: true,
      });
      // do a one pass off aims and get stats
      const aimStats = {};
      for (let i = 0; i < aims.length; i += 1) {
        if (!(aims[i].template in aimStats)) {
          aimStats[aims[i].template] = {
            subjectUids: {},
            studyUids: {},
            seriesUids: {},
            imageUids: {},
          };
        }
        if (!(aims[i].subject_uid in aimStats[aims[i].template].subjectUids))
          aimStats[aims[i].template].subjectUids[aims[i].subject_uid] = 1;
        else aimStats[aims[i].template].subjectUids[aims[i].subject_uid] += 1;
        if (!(aims[i].study_uid in aimStats[aims[i].template].studyUids))
          aimStats[aims[i].template].studyUids[aims[i].study_uid] = 1;
        else aimStats[aims[i].template].studyUids[aims[i].study_uid] += 1;
        if (!(aims[i].series_uid in aimStats[aims[i].template].seriesUids))
          aimStats[aims[i].template].seriesUids[aims[i].series_uid] = 1;
        else aimStats[aims[i].template].seriesUids[aims[i].series_uid] += 1;
        if (!(aims[i].image_uid in aimStats[aims[i].template].imageUids))
          aimStats[aims[i].template].imageUids[aims[i].image_uid] = 1;
        else aimStats[aims[i].template].imageUids[aims[i].image_uid] += 1;
      }
      for (let j = 0; j < worklistReq.length; j += 1) {
        // filter by template first
        let completenessPercent = 0;
        // not even started yet
        if (!(worklistReq[j].template in aimStats)) {
          console.log(
            `There are no aims for the worklist req for template ${worklistReq[j].template}`
          );
        } else {
          // compare and calculate completeness
          let matchCounts = {};
          switch (worklistReq[j].level) {
            // case 'subject':
            //   matched = fastify.getMatchingCount(
            //     aimStats[worklistReq[j].template].subjectUids,
            //     worklistReq[j].numOfAims,
            //     worklistStats.numOfSubjects
            //   );

            //   break;
            case 'study':
              matchCounts = fastify.getMatchingCount(
                aimStats[worklistReq[j].template].studyUids,
                worklistReq[j].numOfAims,
                1
              );
              break;
            case 'series':
              matchCounts = fastify.getMatchingCount(
                aimStats[worklistReq[j].template].seriesUids,
                worklistReq[j].numOfAims,
                worklistStats.numOfSeries
              );

              break;
            case 'image':
              matchCounts = fastify.getMatchingCount(
                aimStats[worklistReq[j].template].imageUids,
                worklistReq[j].numOfAims,
                worklistStats.numOfImages
              );

              break;
            default:
              console.log(`What is this unknown level ${worklistReq[j].level}`);
          }
          completenessPercent = (matchCounts.completed * 100) / matchCounts.required;
        }
        // update worklist study completeness req
        // eslint-disable-next-line no-await-in-loop
        await models.worklist_study_assignee.upsert(
          {
            worklist_study_id: worklistStudyId,
            updatetime: Date.now(),
            user,
            requirement: worklistReq[j].id,
            completeness: completenessPercent,
          },
          {
            worklist_study_id: worklistStudyId,
            user,
            requirement: worklistReq[j].id,
          },
          epadAuth.username
        );
      }
    }
  );

  fastify.decorate('getMatchingCount', (map, singleMatch, required) => {
    let completed = 0;
    // eslint-disable-next-line no-restricted-syntax
    for (const value in map.values()) {
      if (value >= singleMatch) completed += 1;
    }
    return { completed, required };
  });
  fastify.decorate('deleteAimFromProject', async (request, reply) => {
    try {
      const project = await models.project.findOne({
        where: { projectid: request.params.project },
      });
      if (project === null)
        reply.send(
          new BadRequestError(
            `Deleting aim ${request.params.aimuid} from project`,
            new ResourceNotFoundError('Project', request.params.project)
          )
        );
      else if (
        request.query.all &&
        request.query.all === 'true' &&
        request.epadAuth.admin === false
      )
        reply.send(new UnauthorizedError('User is not admin, cannot delete from system'));
      else {
        const numDeleted = await models.project_aim.destroy({
          where: { project_id: project.id, aim_uid: request.params.aimuid },
        });

        // if delete from all or it doesn't exist in any other project, delete from system
        try {
          if (request.query.all && request.query.all === 'true') {
            const deletednum = await models.project_aim.destroy({
              where: { aim_uid: request.params.aimuid },
            });
            await fastify.deleteAimInternal(request.params.aimuid);
            reply
              .code(200)
              .send(`Aim deleted from system and removed from ${deletednum + numDeleted} projects`);
          } else {
            const count = await models.project_aim.count({
              where: { aim_uid: request.params.aimuid },
            });
            if (count === 0) {
              await fastify.deleteAimInternal(request.params.aimuid);
              reply
                .code(200)
                .send(`Aim deleted from system as it didn't exist in any other project`);
            } else
              reply.code(200).send(`Aim not deleted from system as it exists in other project`);
          }
        } catch (deleteErr) {
          reply.send(
            new InternalError(
              `Aim ${request.params.aimuid} deletion from system ${request.params.project}`,
              deleteErr
            )
          );
        }
      }
    } catch (err) {
      reply.send(
        new InternalError(
          `Aim ${request.params.aimuid} deletion from project ${request.params.project}`,
          err
        )
      );
    }
  });
  fastify.decorate('deleteAimFromSystem', async (request, reply) => {
    try {
      const aimUid = request.params.aimuid;
      const numDeleted = await models.project_aim.destroy({
        where: { aim_uid: aimUid },
      });
      await fastify.deleteAimInternal(request.params.aimuid);
      reply.code(200).send(`Aim deleted from system and removed from ${numDeleted} projects`);
    } catch (err) {
      reply.send(new InternalError(`Aim ${request.params.aimuid} deletion from system`, err));
    }
  });

  // from DicomwebServer
  // fastify.decorate('getPatientStudies', (request, reply) => {
  //   fastify
  //     .getPatientStudiesInternal(request.params)
  //     .then(result => reply.code(200).send(result))
  //     .catch(err => reply.code(503).send(err.message));
  // });
  fastify.decorate('addPatientStudyToProject', (request, reply) => {
    fastify
      .addPatientStudyToProjectInternal(request.params, request.epadAuth)
      .then(result => reply.code(200).send(result))
      .catch(err => reply.send(err));
  });

  fastify.decorate(
    'addPatientStudyToProjectInternal',
    (params, epadAuth) =>
      new Promise(async (resolve, reject) => {
        try {
          const project = await models.project.findOne({ where: { projectid: params.project } });
          if (project === null)
            reject(
              new BadRequestError(
                'Adding study to project',
                new ResourceNotFoundError('Project', params.project)
              )
            );
          else {
            let projectSubject = await models.project_subject.findOne({
              where: { project_id: project.id, subject_uid: params.subject },
            });
            if (!projectSubject)
              projectSubject = await models.project_subject.create({
                project_id: project.id,
                subject_uid: params.subject,
                creator: epadAuth.username,
                updatetime: Date.now(),
                createdtime: Date.now(),
              });
            // create only when that is not already there
            const projectSubjectStudy = await models.project_subject_study.findOne({
              where: { proj_subj_id: projectSubject.id, study_uid: params.study },
            });
            if (!projectSubjectStudy)
              await models.project_subject_study.create({
                proj_subj_id: projectSubject.id,
                study_uid: params.study,
                creator: epadAuth.username,
                updatetime: Date.now(),
                createdtime: Date.now(),
              });
            resolve();
          }
        } catch (err) {
          reject(
            new InternalError(`Adding study ${params.study} to project ${params.project}`, err)
          );
        }
      })
  );

  fastify.decorate('getPatientStudiesFromProject', async (request, reply) => {
    try {
      const project = await models.project.findOne({
        where: { projectid: request.params.project },
      });
      if (project === null)
        reply.send(
          new BadRequestError(
            'Get studies from project',
            new ResourceNotFoundError('Project', request.params.project)
          )
        );
      else {
        const studyUids = [];
        const projectSubjects = await models.project_subject.findAll({
          where: { project_id: project.id, subject_uid: request.params.subject },
        });
        if (projectSubjects === null) {
          reply.send(
            new BadRequestError(
              'Get studies from project',
              new ResourceNotFoundError('Project subject association', request.params.subject)
            )
          );
        } else {
          // projects will be an array of Project instances with the specified name
          for (let i = 0; i < projectSubjects.length; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            const projectSubjectStudies = await models.project_subject_study.findAll({
              where: { proj_subj_id: projectSubjects[i].id },
            });
            if (projectSubjectStudies)
              for (let j = 0; j < projectSubjectStudies.length; j += 1) {
                studyUids.push(projectSubjectStudies[j].study_uid);
              }
          }
          const result = await fastify.getPatientStudiesInternal(
            request.params,
            studyUids,
            request.epadAuth
          );
          if (studyUids.length !== result.length)
            fastify.log.warn(
              `There are ${studyUids.length} studies associated with this project. But only ${
                result.length
              } of them have dicom files`
            );
          reply.code(200).send(result);
        }
      }
    } catch (err) {
      reply.send(
        new InternalError(
          `Getting studies of ${request.params.subject} from project ${request.params.project}`
        ),
        err
      );
    }
  });

  fastify.decorate('deletePatientStudyFromProject', async (request, reply) => {
    try {
      const project = await models.project.findOne({
        where: { projectid: request.params.project },
      });
      if (project === null)
        reply.send(
          new BadRequestError(
            'Delete study from project',
            new ResourceNotFoundError('Project', request.params.project)
          )
        );
      else {
        const projectSubject = await models.project_subject.findOne({
          where: { project_id: project.id, subject_uid: request.params.subject },
        });
        if (projectSubject === null) {
          reply.send(
            new BadRequestError(
              'Delete study from project',
              new ResourceNotFoundError('Project subject association', request.params.subject)
            )
          );
        } else if (
          request.query.all &&
          request.query.all === 'true' &&
          request.epadAuth.admin === false
        )
          reply.send(new UnauthorizedError('User is not admin, cannot delete from system'));
        else {
          let numDeleted = await models.project_subject_study.destroy({
            where: { proj_subj_id: projectSubject.id, study_uid: request.params.study },
          });
          // see if there is any other study refering to this subject in ths project
          const studyCount = await models.project_subject_study.count({
            where: { proj_subj_id: projectSubject.id },
          });
          if (studyCount === 0)
            await models.project_subject.destroy({
              where: { id: projectSubject.id },
            });

          // if delete from all or it doesn't exist in any other project, delete from system
          try {
            if (request.query.all && request.query.all === 'true') {
              const projectSubjectStudies = await models.project_subject_study.findAll({
                where: { study_uid: request.params.study },
              });
              const projSubjIds = [];
              const projectSubjectStudyIds = [];
              if (projectSubjectStudies) {
                for (let i = 0; i < projectSubjectStudies.length; i += 1) {
                  // eslint-disable-next-line no-await-in-loop
                  const existingStudyCount = await models.project_subject_study.count({
                    where: { proj_subj_id: projectSubjectStudies[i].proj_subj_id },
                  });
                  if (existingStudyCount === 1)
                    projSubjIds.push(projectSubjectStudies[i].proj_subj_id);
                  projectSubjectStudyIds.push(projectSubjectStudies[i].id);
                }
                numDeleted += await models.project_subject_study.destroy({
                  where: { id: projectSubjectStudyIds },
                });
                await models.project_subject.destroy({
                  where: { id: projSubjIds },
                });
              }
              await fastify.deleteStudyInternal(request.params, request.epadAuth);
              reply
                .code(200)
                .send(`Study deleted from system and removed from ${numDeleted} projects`);
            } else {
              const count = await models.project_subject_study.count({
                where: { study_uid: request.params.study },
              });
              if (count === 0) {
                await fastify.deleteStudyInternal(request.params, request.epadAuth);
                reply
                  .code(200)
                  .send(`Study deleted from system as it didn't exist in any other project`);
              } else
                reply.code(200).send(`Study not deleted from system as it exists in other project`);
            }
          } catch (deleteErr) {
            reply.send(
              new InternalError(`Study ${request.params.study} deletion from system`, deleteErr)
            );
          }
        }
      }
    } catch (err) {
      reply.send(
        new InternalError(
          `Study ${request.params.study} deletion from project ${request.params.project}`,
          err
        )
      );
    }
  });
  fastify.decorate('getStudySeriesFromProject', (request, reply) => {
    // TODO project filtering
    fastify
      .getStudySeriesInternal(request.params, request.query, request.epadAuth)
      .then(result => reply.code(200).send(result))
      .catch(err => reply.send(err));
  });
  fastify.decorate('getSeriesImagesFromProject', (request, reply) => {
    // TODO project filtering
    fastify
      .getSeriesImagesInternal(request.params, request.query)
      .then(result => reply.code(200).send(result))
      .catch(err => reply.send(err));
  });

  fastify.decorate('createUser', (request, reply) => {
    // TODO user exists check! ozge
    // TODO permissions added as string, retrieve as array. errorprone if there is space like 'CreateProject, CreateWorklist' ozge
    if (!request.body) {
      reply.send(new BadRequestError('User Creation', new Error('No body sent')));
    } else {
      models.user
        .create({
          ...request.body,
          createdtime: Date.now(),
          updatetime: Date.now(),
          creator: request.epadAuth.username,
        })
        .then(async user => {
          const { id } = user.dataValues;
          if (request.body.projects && request.body.projects.length > 0) {
            const queries = [];
            try {
              for (let i = 0; i < request.body.projects.length; i += 1) {
                // eslint-disable-next-line no-await-in-loop
                const project = await models.project.findOne({
                  where: { projectid: request.body.projects[i].project },
                  attributes: ['id'],
                });
                if (project === null) {
                  reply.send(
                    new BadRequestError(
                      'Create user with project associations',
                      new ResourceNotFoundError('Project', request.params.project)
                    )
                  );
                } else {
                  const projectId = project.dataValues.id;
                  const entry = {
                    project_id: projectId,
                    user_id: id,
                    role: request.body.projects[i].role,
                    createdtime: Date.now(),
                    updatetime: Date.now(),
                  };
                  queries.push(models.project_user.create(entry));
                }
              }

              Promise.all(queries)
                .then(() => {
                  reply.code(200).send(`User succesfully created`);
                })
                .catch(err => {
                  reply.send(new InternalError('Create user project associations', err));
                });
            } catch (err) {
              reply.send(new InternalError('Create user project associations', err));
            }
          } else {
            reply.code(200).send(`User succesfully created`);
          }
        })
        .catch(err => {
          reply.send(new InternalError('Create user in db', err));
        });
    }
  });

  fastify.decorate('getProject', (request, reply) => {
    models.project
      .findOne({ where: { projectid: request.params.project } })
      .then(project => {
        if (project === null)
          reply.send(new ResourceNotFoundError('Project', request.params.project));
        else reply.code(200).send(project);
      })
      .catch(err => {
        reply.send(new InternalError(`Getting project ${request.params.project}`, err));
      });
  });

  fastify.decorate('updateProjectUser', async (request, reply) => {
    const rowsUpdated = {
      ...request.body,
      updated_by: request.epadAuth.username,
      updatetime: Date.now(),
    };
    // what is this?? ozge
    // if (request.body.updatedBy) {
    //   rowsUpdated.updated_by = request.body.updatedBy;
    // }
    // delete rowsUpdated.updatedBy;
    let result;
    try {
      const { userId, projectId } = await fastify.getUserProjectIdsInternal(
        request.params.user,
        request.params.project
      );
      if (rowsUpdated.role.toLowerCase().trim() === 'none') {
        await models.project_user.destroy({ where: { project_id: projectId, user_id: userId } });
        reply.code(200).send(`update sucessful`);
      } else {
        result = await models.project_user.findOrCreate({
          where: { project_id: projectId, user_id: userId },
          defaults: { ...rowsUpdated, creator: request.epadAuth.username },
        });
        // check if new entry created
        // if not created, get the id and update the relation
        if (result[1]) {
          reply.code(200).send(`new relation created sucessfully on update`);
        } else {
          await models.project_user.update(rowsUpdated, { where: { id: result[0].dataValues.id } });
          reply.code(200).send(`update sucessful`);
        }
      }
    } catch (err) {
      if (err instanceof ResourceNotFoundError)
        reply.send(
          new BadRequestError(
            `Updating project ${request.params.project} user ${request.params.user} association`,
            err
          )
        );
      else
        reply.send(
          new InternalError(
            `Updating project ${request.params.project} user ${request.params.user} association`,
            err
          )
        );
    }
  });

  fastify.decorate('getUserProjectIdsInternal', (username, projectid) => {
    const query = new Promise(async (resolve, reject) => {
      try {
        // find user id
        const user = await models.user.findOne({ where: { username }, attributes: ['id'] });
        if (user === null) reject(new ResourceNotFoundError('User', username));
        // find project id
        const project = await models.project.findOne({ where: { projectid }, attributes: ['id'] });
        if (project === null) reject(new ResourceNotFoundError('Project', projectid));

        const res = { userId: user.dataValues.id, projectId: project.dataValues.id };
        resolve(res);
      } catch (err) {
        reject(
          new InternalError(`Retrieving user ${username} and project ${projectid} db ids`, err)
        );
      }
    });
    return query;
  });

  fastify.decorate('getUsers', (request, reply) => {
    models.user
      .findAll({
        include: ['projects'],
      })
      .then(users => {
        const result = [];
        users.forEach(user => {
          const projects = [];
          const projectToRole = [];
          user.projects.forEach(project => {
            projects.push(project.projectid);
            projectToRole.push(`${project.projectid}:${project.project_user.role}`);
          });

          const permissions = user.permissions ? user.permissions.split(',') : [''];
          const obj = {
            colorpreference: user.colorpreference,
            creator: user.creator,
            admin: user.admin === 1,
            enabled: user.enabled === 1,
            displayname: `${user.firstname} ${user.lastname}`,
            email: user.email,
            firstname: user.firstname,
            lastname: user.lastname,
            passwordExpired: user.passwordexpired,
            permissions,
            projectToRole,
            projects,
            username: user.username,
            role: user.role,
          };
          result.push(obj);
        });
        reply.code(200).send(result);
      })
      .catch(err => {
        reply.send(new InternalError('Getting users', err));
      });
  });

  fastify.decorate('getUser', (request, reply) => {
    fastify
      .getUserInternal(request.params)
      .then(res => reply.code(200).send(res))
      .catch(err => {
        reply.send(err);
      });
  });

  fastify.decorate('updateUser', (request, reply) => {
    const rowsUpdated = {
      ...request.body,
      updated_by: request.epadAuth.username,
      updatetime: Date.now(),
    };
    models.user
      .update(rowsUpdated, { where: { username: request.params.user } })
      .then(() => {
        reply.code(200).send(`User ${request.params.user} updated sucessfully`);
      })
      .catch(err => {
        reply.send(new InternalError(`Updating user ${request.params.user}`, err));
      });
  });

  fastify.decorate(
    'getUserInternal',
    params =>
      new Promise(async (resolve, reject) => {
        try {
          const user = await models.user.findAll({
            where: {
              username: params.user,
            },
            include: ['projects'],
          });
          if (user.length === 1) {
            const permissions = user[0].permissions ? user[0].permissions.split(',') : [''];
            const projects = [];
            const projectToRole = [];
            user[0].projects.forEach(project => {
              projects.push(project.projectid);
              projectToRole.push(`${project.projectid}:${project.project_user.role}`);
            });
            const obj = {
              colorpreference: user[0].colorpreference,
              creator: user[0].creator,
              admin: user[0].admin === 1,
              enabled: user[0].enabled === 1,
              displayname: `${user[0].firstname} ${user[0].lastname}`,
              email: user[0].email,
              firstname: user[0].firstname,
              lastname: user[0].lastname,
              passwordExpired: user[0].passwordexpired === 1,
              permissions,
              projectToRole,
              projects,
              username: user[0].username,
            };
            resolve(obj);
          } else {
            reject(new ResourceNotFoundError('User', params.user));
          }
        } catch (err) {
          reject(new InternalError(`Getting user ${params.user}`, err));
        }
      })
  );

  fastify.decorate('deleteUser', (request, reply) => {
    models.user
      .destroy({
        where: {
          username: request.params.user,
        },
      })
      .then(() => {
        reply.code(200).send(`User ${request.params.user} is deleted successfully`);
      })
      .catch(err => {
        reply.send(new InternalError(`Deleting ${request.params.user}`, err));
      });
  });

  fastify.decorate('getPatientStudyFromProject', async (request, reply) => {
    try {
      // TODO check if it is in the project
      const studyUids = [request.params.study];
      const result = await fastify.getPatientStudiesInternal(
        request.params,
        studyUids,
        request.epadAuth
      );
      if (result.length === 1) reply.code(200).send(result[0]);
      else reply.send(new ResourceNotFoundError('Study', request.params.study));
    } catch (err) {
      reply.send(new InternalError(`Get study ${request.params.study}`, err));
    }
  });

  fastify.decorate('getSubjectFromProject', async (request, reply) => {
    try {
      // TODO check if it is in the project
      const subjectUids = [request.params.subject];
      const result = await fastify.getPatientsInternal(
        request.params,
        subjectUids,
        request.epadAuth
      );
      if (result.length === 1) reply.code(200).send(result[0]);
      else reply.send(new ResourceNotFoundError('Subject', request.params.subject));
    } catch (err) {
      reply.send(new InternalError(`Get subject ${request.params.subject}`, err));
    }
  });

  fastify.decorate('putOtherFileToProject', (request, reply) => {
    fastify
      .putOtherFileToProjectInternal(request.params.filename, request.params, request.epadAuth)
      .then(() =>
        reply
          .code(200)
          .send(
            `File ${request.params.filename} successfully saved in project  ${
              request.params.project
            }`
          )
      )
      .catch(err => reply.send(err));
  });

  fastify.decorate(
    'checkProjectAssociation',
    (projectId, params) =>
      new Promise(async (resolve, reject) => {
        try {
          if (params.subject) {
            const projectSubject = await models.project_subject.findOne({
              where: { project_id: projectId, subject_uid: params.subject },
            });
            if (!projectSubject) {
              reject(
                new ResourceNotFoundError(
                  `Project ${params.project} subject association`,
                  params.subject
                )
              );
            } else if (params.study) {
              const projectSubjectStudy = await models.project_subject_study.findOne({
                where: { proj_subj_id: projectSubject.id, study_uid: params.study },
              });
              if (!projectSubjectStudy) {
                reject(
                  new ResourceNotFoundError(
                    `Project ${params.project} study association`,
                    params.study
                  )
                );
              }
            }
          }
          resolve();
        } catch (err) {
          reject(new InternalError('Project association check', err));
        }
      })
  );

  fastify.decorate(
    'putOtherFileToProjectInternal',
    (filename, params, epadAuth) =>
      new Promise(async (resolve, reject) => {
        try {
          const project = await models.project.findOne({ where: { projectid: params.project } });
          // if the subjects and/or study is given, make sure that subject and/or study is assosiacted with the project
          if (project === null) reject(new ResourceNotFoundError('Project', params.project));
          else {
            fastify
              .checkProjectAssociation(project.id, params)
              .then(async () => {
                await models.project_file.create({
                  project_id: project.id,
                  file_uid: filename,
                  creator: epadAuth.username,
                  updatetime: Date.now(),
                  createdtime: Date.now(),
                });
                resolve();
              })
              .catch(errAssoc => {
                if (errAssoc instanceof ResourceNotFoundError)
                  reject(
                    new BadRequestError(
                      'The subject and/or study the file is being put is not associated with project',
                      errAssoc
                    )
                  );
                else reject(errAssoc);
              });
          }
        } catch (err) {
          reject(new InternalError('Putting file to project', err));
        }
      })
  );

  fastify.decorate('getProjectFiles', async (request, reply) => {
    try {
      const project = await models.project.findOne({
        where: { projectid: request.params.project },
      });
      if (project === null)
        reply.send(
          new BadRequestError(
            'Getting project files',
            new ResourceNotFoundError('Project', request.params.project)
          )
        );
      else {
        const fileUids = [];
        const projectFiles = await models.project_file.findAll({
          where: { project_id: project.id },
        });
        // projects will be an array of Project instances with the specified name
        projectFiles.forEach(projectFile => fileUids.push(projectFile.file_uid));
        const result = await fastify.getFilesFromUIDsInternal(
          request.query,
          fileUids,
          (({ subject, study, series }) => ({ subject, study, series }))(request.params)
        );

        if (request.query.format === 'stream') {
          reply.header('Content-Disposition', `attachment; filename=files.zip`);
        }
        reply.code(200).send(result);
      }
    } catch (err) {
      reply.send(new InternalError(`Getting files for project ${request.params.project}`, err));
    }
  });

  // TODO filter for user??
  fastify.decorate('getFiles', (request, reply) => {
    try {
      fastify
        .getFilesInternal(request.query)
        .then(result => {
          if (request.query.format === 'stream') {
            reply.header('Content-Disposition', `attachment; filename=files.zip`);
          }
          reply.code(200).send(result);
        })
        .catch(err => reply.send(err));
    } catch (err) {
      reply.send(new InternalError('Getting system files', err));
    }
  });

  fastify.decorate('getProjectFile', async (request, reply) => {
    try {
      const project = await models.project.findOne({
        where: { projectid: request.params.project },
      });
      if (project === null)
        reply.send(
          new BadRequestError(
            'Getting project file',
            new ResourceNotFoundError('Project', request.params.project)
          )
        );
      else {
        const projectFile = await models.project_file.findOne({
          where: { project_id: project.id, file_uid: request.params.filename },
        });
        if (projectFile === null)
          reply.send(
            new BadRequestError(
              'Getting project file',
              new ResourceNotFoundError('Project file association', request.params.project)
            )
          );
        else {
          const result = await fastify.getFilesFromUIDsInternal(request.query, [
            request.params.filename,
          ]);

          if (request.query.format === 'stream') {
            reply.header('Content-Disposition', `attachment; filename=files.zip`);
            reply.code(200).send(result);
          } else if (result.length === 1) reply.code(200).send(result[0]);
          else {
            fastify.log.warn(`Was expecting to find 1 record, found ${result.length}`);
            reply.send(new ResourceNotFoundError('File', request.params.filename));
          }
        }
      }
    } catch (err) {
      reply.send(new InternalError('Getting project file', err));
    }
  });

  fastify.decorate('deleteFileFromProject', async (request, reply) => {
    try {
      const project = await models.project.findOne({
        where: { projectid: request.params.project },
      });
      if (project === null)
        reply.send(
          new BadRequestError(
            'Deleting project file',
            new ResourceNotFoundError('Project', request.params.project)
          )
        );
      else if (
        request.query.all &&
        request.query.all === 'true' &&
        request.epadAuth.admin === false
      )
        reply.send(new UnauthorizedError('User is not admin, cannot delete from system'));
      else {
        const numDeleted = await models.project_file.destroy({
          where: { project_id: project.id, file_uid: request.params.filename },
        });
        // if delete from all or it doesn't exist in any other project, delete from system
        try {
          if (request.query.all && request.query.all === 'true') {
            const deletednum = await models.project_file.destroy({
              where: { file_uid: request.params.filename },
            });
            await fastify.deleteFileInternal(request.params);
            reply
              .code(200)
              .send(
                `File deleted from system and removed from ${deletednum + numDeleted} projects`
              );
          } else {
            const count = await models.project_file.count({
              where: { file_uid: request.params.filename },
            });
            if (count === 0) {
              await fastify.deleteFileInternal(request.params);
              reply
                .code(200)
                .send(`File deleted from system as it didn't exist in any other project`);
            } else
              reply.code(200).send(`File not deleted from system as it exists in other project`);
          }
        } catch (deleteErr) {
          reply.send(
            new InternalError(
              `File ${request.params.filename} check and deletion from system`,
              deleteErr
            )
          );
        }
      }
    } catch (err) {
      reply.send(
        new InternalError(
          `File ${request.params.filename} check and deletion from project ${
            request.params.project
          }`,
          err
        )
      );
    }
  });

  fastify.decorate('deleteFileFromSystem', async (request, reply) => {
    try {
      const { filename } = request.params;
      const numDeleted = await models.project_template.destroy({
        where: { file_uid: filename },
      });
      await fastify.deleteFileInternal(request.params);
      reply.code(200).send(`File deleted from system and removed from ${numDeleted} projects`);
    } catch (err) {
      reply.send(
        new InternalError(`File ${request.params.filename} check and deletion from system`, err)
      );
    }
  });

  fastify.decorate('getFile', (request, reply) => {
    fastify
      .getFilesFromUIDsInternal(request.query, [request.params.filename])
      .then(result => {
        if (request.query.format === 'stream') {
          reply.header('Content-Disposition', `attachment; filename=files.zip`);
          reply.code(200).send(result);
        } else if (result.length === 1) reply.code(200).send(result[0]);
        else {
          fastify.log.warn(`Was expecting to find 1 record, found ${result.length}`);
          reply.send(new ResourceNotFoundError('File', request.params.filename));
        }
      })
      .catch(err => reply.send(err));
  });

  fastify.decorate('getStudiesFromProject', async (request, reply) => {
    try {
      const project = await models.project.findOne({
        where: { projectid: request.params.project },
      });
      if (project === null)
        reply.send(
          new BadRequestError(
            'Get studies from project',
            new ResourceNotFoundError('Project', request.params.project)
          )
        );
      else {
        const studyUids = [];
        const projectSubjects = await models.project_subject.findAll({
          where: { project_id: project.id },
        });
        if (projectSubjects === null) {
          reply.send(
            new BadRequestError(
              'Get studies from project',
              new ResourceNotFoundError('Project subject association', request.params.project)
            )
          );
        } else {
          // projects will be an array of Project instances with the specified name
          for (let i = 0; i < projectSubjects.length; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            const projectSubjectStudies = await models.project_subject_study.findAll({
              where: { proj_subj_id: projectSubjects[i].id },
            });
            if (projectSubjectStudies)
              for (let j = 0; j < projectSubjectStudies.length; j += 1) {
                studyUids.push(projectSubjectStudies[j].study_uid);
              }
          }
          const result = await fastify.getPatientStudiesInternal(
            request.params,
            studyUids,
            request.epadAuth
          );
          if (studyUids.length !== result.length)
            fastify.log.warning(
              `There are ${studyUids.length} studies associated with this project. But only ${
                result.length
              } of them have dicom files`
            );
          reply.code(200).send(result);
        }
      }
    } catch (err) {
      reply.send(
        new InternalError(
          `Getting studies of ${request.params.subject} from project ${request.params.project}`
        ),
        err
      );
    }
  });

  fastify.decorate(
    'getObjectCreator',
    (level, objectId) =>
      new Promise(async (resolve, reject) => {
        try {
          let uidField = '';
          let model = '';
          // see if it is a db object and check the creator
          switch (level) {
            case 'project':
              uidField = 'projectid';
              model = 'project';
              break;
            // case 'aim':
            // uidField='projectid';
            // model='project';
            // break;
            // case 'template':
            // uidField='projectid';
            // model='project';
            // break;
            // case 'file':
            // uidField='projectid';
            // model='project';
            // break;
            // case 'connection':
            // uidField='projectid';
            // model='project';
            // break;
            // case 'query':
            // uidField='projectid';
            // model='project';
            // break;
            case 'worklist':
              uidField = 'worklistid';
              model = 'worklist';
              break;
            case 'user':
              uidField = 'username';
              model = 'user';
              break;
            // case 'plugin':
            // uidField='projectid';
            // model='project';
            // break;
            default:
              uidField = undefined;
              model = undefined;
              break;
          }
          if (model) {
            const object = await models[model].findOne({
              where: { [uidField]: objectId },
            });
            if (object) resolve(object.creator);
          }
          resolve();
        } catch (err) {
          reject(new InternalError(`Getting object creator for ${level} ${objectId}`, err));
        }
      })
  );
  fastify.decorate('upsert', (model, values, condition, user) =>
    model.findOne({ where: condition }).then(obj => {
      // update
      if (obj) return obj.update({ ...values, updated_by: user });
      // insert
      return model.create({ ...values, creator: user, createdtime: Date.now() });
    })
  );
  fastify.after(async () => {
    try {
      await fastify.initMariaDB();
      done();
    } catch (err) {
      fastify.log.error(`Cannot connect to mariadb (err:${err.message}), shutting down the server`);
      fastify.close();
    }
    // need to add hook for close to remove the db if test;
    fastify.addHook('onClose', async (instance, doneClose) => {
      if (config.env === 'test') {
        try {
          // if it is test remove the database
          await instance.orm.query(`DROP DATABASE ${config.thickDb.name};`);
          fastify.log.info('Destroying mariadb test database');
        } catch (err) {
          fastify.log.error(`Cannot destroy mariadb test database (err:${err.message})`);
        }
      }
      await instance.orm.close();
      doneClose();
    });
  });
}
// expose as plugin so the module using it can access the decorated methods
module.exports = fp(epaddb);
