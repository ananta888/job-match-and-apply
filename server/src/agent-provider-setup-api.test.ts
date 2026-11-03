import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp, createDefaultAgentApiDependencies } from './app.js';
import { MemoryAuditLogger } from './services/audit-logger.js';
import { MemoryConfigStore } from './services/config-store.js';
import { MemoryWorkspaceStore } from './services/workspace-store.js';

function fixture() {
  const dependencies = createDefaultAgentApiDependencies(true);
  const app = createApp(
    new MemoryConfigStore(), new MemoryAuditLogger(), new MemoryWorkspaceStore(), undefined, dependencies,
  );
  return { app, dependencies };
}

describe('agent wsl distribution view', () => {
  it('reports enumerated distributions plus discovered installations without secrets', async () => {
    const { app } = fixture();
    const response = await request(app).get('/api/agents/wsl-distributions').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual(expect.objectContaining({
      contract: 'agent-wsl-distributions', contractVersion: '1.0',
      available: expect.any(Boolean), distributions: expect.any(Array), note: expect.any(String),
    }));
    for (const distribution of response.body.distributions) {
      expect(distribution).toEqual(expect.objectContaining({
        name: expect.any(String), enumerated: expect.any(Boolean),
        installations: expect.any(Number), supported: expect.any(Number),
      }));
    }
  });
});

const approval = {
  provider: 'opencode',
  executable: 'C:\\tools\\opencode.exe',
  runtimeTarget: 'windows',
  version: '1.15.7',
};

describe('agent provider setup API', () => {
  it('grants and revokes exact version approvals with compare-and-save', async () => {
    const { app } = fixture();
    const initial = await request(app).get('/api/agents/version-approvals').expect(200);
    expect(initial.body).toEqual({ schemaVersion: 1, updatedAt: null, approvals: [] });

    const approved = await request(app).put('/api/agents/version-approvals').send({
      expectedUpdatedAt: null, confirmed: true, approval,
    });
    expect(approved.status, approved.text).toBe(200);
    expect(approved.body.approvals).toEqual([{ ...approval, approvedAt: expect.any(String) }]);

    const conflict = await request(app).put('/api/agents/version-approvals').send({
      expectedUpdatedAt: null, confirmed: true, approval: { ...approval, version: '1.15.8' },
    });
    expect(conflict.status).toBe(409);

    const invalid = await request(app).put('/api/agents/version-approvals').send({
      expectedUpdatedAt: approved.body.updatedAt, confirmed: true,
      approval: { ...approval, confirmed: true },
    });
    expect(invalid.status).toBe(400);

    const revoked = await request(app).post('/api/agents/version-approvals/revoke').send({
      expectedUpdatedAt: approved.body.updatedAt, confirmed: true, approval,
    });
    expect(revoked.status, revoked.text).toBe(200);
    expect(revoked.body.approvals).toEqual([]);

    const missing = await request(app).post('/api/agents/version-approvals/revoke').send({
      expectedUpdatedAt: revoked.body.updatedAt, confirmed: true, approval,
    });
    expect(missing.status).toBe(404);
  });

  it('stores provider API keys without ever returning their values', async () => {
    const { app } = fixture();
    const secret = 'sk-live-must-not-be-echoed';
    const listed = await request(app).get('/api/agents/providers/credentials').expect(200);
    expect(listed.body).toEqual([]);

    const saved = await request(app)
      .put('/api/agents/providers/opencode/credentials')
      .send({ confirmed: true, env: { OPENAI_API_KEY: secret } });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.body).toEqual({
      providerId: 'opencode', hasSecret: true, envKeys: ['OPENAI_API_KEY'], updatedAt: expect.any(String),
    });
    expect(JSON.stringify(saved.body)).not.toContain(secret);

    const forbidden = await request(app)
      .put('/api/agents/providers/opencode/credentials')
      .send({ confirmed: true, env: { PATH: '/evil/bin' } });
    expect(forbidden.status).toBe(400);
    expect(JSON.stringify(forbidden.body)).not.toContain('/evil/bin');

    const confirmedMissing = await request(app)
      .put('/api/agents/providers/opencode/credentials')
      .send({ env: { OPENAI_API_KEY: secret } });
    expect(confirmedMissing.status).toBe(400);

    const summary = await request(app).get('/api/agents/providers/credentials').expect(200);
    expect(summary.body).toEqual([expect.objectContaining({ providerId: 'opencode', hasSecret: true })]);

    const removed = await request(app)
      .delete('/api/agents/providers/opencode/credentials')
      .send({ confirmed: true });
    expect(removed.status, removed.text).toBe(200);
    expect(removed.body).toEqual({ providerId: 'opencode', hasSecret: false, envKeys: [] });

    const after = await request(app).get('/api/agents/providers/credentials').expect(200);
    expect(after.body).toEqual([]);
  });
});
