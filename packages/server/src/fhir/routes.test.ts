import express from 'express';
import request from 'supertest';
import { destroyApp, initApp } from '../app';

const app = express();

beforeAll(async () => {
  await initApp(app);
});

afterAll(async () => {
  await destroyApp(app);
});

test('Create batch', (done) => {
  request(app)
    .post('/fhir/R4/')
    .send({ resourceType: 'Bundle', entry: [] })
    .expect(201, done);
});

test('Create resource', (done) => {
  request(app)
    .post('/fhir/R4/Patient')
    .send({ resourceType: 'Patient' })
    .expect(201, done);
});

test('Create resource invalid resource type', (done) => {
  request(app)
    .post('/fhir/R4/Patientx')
    .send({ resourceType: 'Patientx' })
    .expect(400, done);
});

test('Read resource', (done) => {
  request(app)
    .get('/fhir/R4/Patient/8a54c7db-654b-4c3d-ba85-e0909f51c12b')
    .expect(200, done);
});

test('Read resource invalid resource type', (done) => {
  request(app)
    .get('/fhir/R4/Patientx/8a54c7db-654b-4c3d-ba85-e0909f51c12b')
    .expect(400, done);
});

test('Read resource not found', (done) => {
  request(app)
    .get('/fhir/R4/Patient/8a54c7db-654b-4c3d-ba85-e0909f51c12c')
    .expect(404, done);
});

test('Read resource history', (done) => {
  request(app)
    .get('/fhir/R4/Patient/8a54c7db-654b-4c3d-ba85-e0909f51c12b/_history')
    .expect(200, done);
});

test('Read resource version', (done) => {
  request(app)
    .get('/fhir/R4/Patient/8a54c7db-654b-4c3d-ba85-e0909f51c12b/_history/6eef5db6-534d-4de2-b1d4-212a2df0e5cd')
    .expect(200, done);
});

test('Update resource', (done) => {
  request(app)
    .put('/fhir/R4/Patient/8a54c7db-654b-4c3d-ba85-e0909f51c12b')
    .send({ resourceType: 'Patient', id: '8a54c7db-654b-4c3d-ba85-e0909f51c12b' })
    .expect(200, done);
});

test('Delete resource', (done) => {
  request(app)
    .delete('/fhir/R4/Patient/8a54c7db-654b-4c3d-ba85-e0909f51c12b')
    .expect(200, done);
});

test('Patch resource', (done) => {
  request(app)
    .patch('/fhir/R4/Patient/8a54c7db-654b-4c3d-ba85-e0909f51c12b')
    .send({})
    .expect(200, done);
});

test('Search', (done) => {
  request(app)
    .get('/fhir/R4/Patient')
    .expect(200, done);
});

test('Search invalid resource', (done) => {
  request(app)
    .get('/fhir/R4/Patientx')
    .expect(400, done);
});

test('Validate create success', (done) => {
  request(app)
    .post('/fhir/R4/Patient/$validate')
    .send({ resourceType: 'Patient' })
    .expect(200, done);
});

test('Validate create failure', (done) => {
  request(app)
    .post('/fhir/R4/Patient/$validate')
    .send({ resourceType: 'Patient', badProperty: 'bad' })
    .expect(400, done);
});
