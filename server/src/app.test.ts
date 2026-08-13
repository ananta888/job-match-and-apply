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
    expect(response.body.matches[0].score).toBeGreaterThanOrEqual(response.body.matches.at(-1).score);
  });
});
