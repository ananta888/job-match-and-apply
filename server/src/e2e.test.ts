import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { MemoryConfigStore } from './services/config-store.js';

describe('synthetic incognito end-to-end path', () => {
  it('searches, previews, creates a case and blocks every external/final side effect', async () => {
    const app = createApp(new MemoryConfigStore());
    const config = await request(app).get('/api/config').expect(200);
    const identity = config.body.identities.find((item: { mode: string }) => item.mode === 'incognito');
    expect(identity.email).toContain('.invalid');
    const search = await request(app).post('/api/jobs/search').send(config.body.searchProfile).expect(200);
    expect(search.body.matches.length).toBeGreaterThan(0);
    const match = search.body.matches[0];
    const draft = await request(app).post('/api/applications/draft').send({ match, identityId: identity.id, documentType: 'cover_letter' }).expect(200);
    expect(draft.body.lifecycle).toBe('preview');
    expect(draft.body.content).not.toContain('@gmail.com');
    const application = await request(app).post('/api/application-cases').send({ match, identityId: identity.id, documentType: 'cover_letter' }).expect(201);
    await request(app).post(`/api/application-cases/${application.body.id}/transition`).send({ state: 'analysis' }).expect(200);
    await request(app).post(`/api/application-cases/${application.body.id}/transition`).send({ state: 'questions' }).expect(200);
    await request(app).post(`/api/application-cases/${application.body.id}/transition`).send({ state: 'draft' }).expect(200);
    await request(app).post(`/api/application-cases/${application.body.id}/transition`).send({ state: 'review' }).expect(200);
    await request(app).post(`/api/application-cases/${application.body.id}/transition`).send({ state: 'approved' }).expect(409);
    await request(app).post('/api/applications/finalize').send({ match, identityId: identity.id, documentType: 'cover_letter', annotatedContent: 'Text', iterationManifest: 'passes: []' }).expect(409);
  });
});
