import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { MemoryConfigStore } from './services/config-store.js';

describe('API', () => {
  it('creates a safe incognito identity', async () => {
    const response = await request(createApp(new MemoryConfigStore()))
      .post('/api/identities/incognito')
      .send({ location: 'Köln' })
      .expect(201);
    expect(response.body.mode).toBe('incognito');
    expect(response.body.email).toMatch(/@example\.invalid$/);
    expect(response.body.placeholders['{{ORT}}']).toBe('Köln');
  });

  it('returns ranked demo search results', async () => {
    const response = await request(createApp(new MemoryConfigStore()))
      .post('/api/jobs/search')
      .send({})
      .expect(200);
    expect(response.body.matches.length).toBeGreaterThan(0);
    expect(response.body.matches[0].searchPreferenceScore).toBeGreaterThanOrEqual(response.body.matches.at(-1).searchPreferenceScore);
  });

  it('creates only a preview from search preferences', async () => {
    const app = createApp(new MemoryConfigStore());
    const search = await request(app).post('/api/jobs/search').send({}).expect(200);
    const response = await request(app)
      .post('/api/applications/draft')
      .send({ match: search.body.matches[0], identityId: 'incognito-default', documentType: 'cover_letter' })
      .expect(200);
    expect(response.body.lifecycle).toBe('preview');
    expect(response.body.strongestMatches).toEqual([]);
    expect(response.body.content).toContain('nur eine Vorschau');
  });

  it('blocks finalization for an incognito identity before running external checks', async () => {
    const app = createApp(new MemoryConfigStore());
    const search = await request(app).post('/api/jobs/search').send({}).expect(200);
    const response = await request(app)
      .post('/api/applications/finalize')
      .send({
        match: search.body.matches[0],
        identityId: 'incognito-default',
        documentType: 'cover_letter',
        annotatedContent: 'Test <!-- evidence: editorial -->',
        iterationManifest: 'schema_version: 1'
      })
      .expect(409);
    expect(response.body.error).toContain('Inkognito-Identitäten dürfen nur Vorschauen erzeugen');
  });
});
