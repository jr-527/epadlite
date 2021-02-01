const chai = require('chai');
const chaiHttp = require('chai-http');

chai.use(chaiHttp);
const { expect } = chai;

describe.only('Ontology Tests', () => {
  before(async () => {
    try {
      await chai
        .request(`http://${process.env.host}:${process.env.port}`)
        .post('/ontology')
        .send({
          codemeaning: 'testcodemeaning1',
          referenceuid: 'testcodevalue1',
          referencename: 'plugin1',
          referencetype: 'p',
          creator: 'admin',
        })
        .set('Authorization', 'apikey 1111');
      await chai
        .request(`http://${process.env.host}:${process.env.port}`)
        .post('/ontology')
        .send({
          codemeaning: 'testcodemeaning2',
          referenceuid: 'testcodevalue2',
          referencename: 'plugin2',
          referencetype: 'p',
          creator: 'admin',
        })
        .set('Authorization', 'apikey 1111');
    } catch (err) {
      console.log(`Ontology Tests before error: ${err.message}`);
    }
  });
  after(async () => {
    try {
      await chai
        .request(`http://${process.env.host}:${process.env.port}`)
        .delete('/ontology/99EPAD_1')
        .query({ username: 'admin' })
        .set('Authorization', 'apikey 1111');
      await chai
        .request(`http://${process.env.host}:${process.env.port}`)
        .delete('/ontology/99EPAD_2')
        .query({ username: 'admin' })
        .set('Authorization', 'apikey 1111');
    } catch (err) {
      console.log(`Ontology Tests after error: ${err.message}`);
    }
  });
  it('should have 2 lexicon data', (done) => {
    chai
      .request(`http://${process.env.host}:${process.env.port}`)
      .get('/ontology')
      .auth('admin', 'admin')
      .then((res) => {
        expect(res.statusCode).to.equal(200);
        expect(res.body.length).to.be.eql(2);
        done();
      })
      .catch((e) => {
        done(e);
      });
  });
  it('no apikey provided, should return 401', (done) => {
    chai
      .request(`http://${process.env.host}:${process.env.port}`)
      .post('/ontology')
      .send({
        codemeaning: 'testcodemeaningx',
        referenceuid: 'testcodevaluex',
        referencename: 'pluginx',
        referencetype: 'p',
        creator: 'admin',
      })
      .then((res) => {
        expect(res.statusCode).to.equal(401);
        done();
      })
      .catch((e) => {
        done(e);
      });
  });
});
