import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { MemoryConfigStore } from './services/config-store.js';
import { MemoryAuditLogger } from './services/audit-logger.js';
import { MemoryWorkspaceStore } from './services/workspace-store.js';
import { defaultConfig } from './config/defaults.js';

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
    const workspace = new MemoryWorkspaceStore();
    const response = await request(createApp(new MemoryConfigStore(), new MemoryAuditLogger(), workspace))
      .post('/api/jobs/search')
      .send({})
      .expect(200);
    expect(response.body.matches.length).toBeGreaterThan(0);
    expect(response.body.matches[0].searchPreferenceScore).toBeGreaterThanOrEqual(response.body.matches.at(-1).searchPreferenceScore);
    expect(response.body.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await workspace.getSearchRun(response.body.runId)).toBeTruthy();
  });

  it('publishes compatible source capabilities', async () => {
    const response = await request(createApp(new MemoryConfigStore()))
      .get('/api/capabilities')
      .expect(200);
    expect(response.body.contractVersion).toBe('1.0');
    expect(response.body.compatible).toBe(true);
    expect(response.body.sources.some((source: { id: string }) => source.id === 'stepstone')).toBe(true);
  });

  it('does not report MCP connectivity from the configured mode alone', async () => {
    const response = await request(createApp(new MemoryConfigStore()))
      .get('/api/sources/runtime')
      .expect(200);
    expect(response.body).toMatchObject({
      contract: 'job-search-mcp-runtime-status', contractVersion: '1.0', mode: 'demo',
      state: 'demo', launchValidated: false, connected: false
    });
  });

  it('does not return configured MCP environment values to Angular or portable exports', async () => {
    const config = structuredClone(defaultConfig);
    config.mcp.env = { ALLOW_EXTERNAL_PORTALS: '1', JOB_MCP_STATE_DIR: 'private-runtime-location' };
    const app = createApp(new MemoryConfigStore(config));
    const response = await request(app).get('/api/config').expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.mcp.env).toEqual({ ALLOW_EXTERNAL_PORTALS: '', JOB_MCP_STATE_DIR: '' });
    expect(response.body.mcp.configuredEnvironmentKeys).toEqual(['ALLOW_EXTERNAL_PORTALS', 'JOB_MCP_STATE_DIR']);
    expect(JSON.stringify(response.body)).not.toContain('private-runtime-location');
    const exported = await request(app).post('/api/data/export').send({}).expect(200);
    expect(exported.body.config.mcp.env).toEqual({ ALLOW_EXTERNAL_PORTALS: '[REDACTED]', JOB_MCP_STATE_DIR: '[REDACTED]' });
    expect(JSON.stringify(exported.body)).not.toContain('private-runtime-location');
  });

  it('preserves redacted MCP environment values across ordinary config updates', async () => {
    const config = structuredClone(defaultConfig);
    config.mcp.env = { ALLOW_EXTERNAL_PORTALS: '1', JOB_MCP_STATE_DIR: 'private-runtime-location' };
    const store = new MemoryConfigStore(config);
    const app = createApp(store);
    const publicConfig = (await request(app).get('/api/config').expect(200)).body;
    publicConfig.searchProfile.name = 'Geänderte Suche';
    const response = await request(app).put('/api/config').send(publicConfig).expect(200);
    expect(response.body.mcp.env).toEqual({ ALLOW_EXTERNAL_PORTALS: '', JOB_MCP_STATE_DIR: '' });
    expect(response.body.mcp.configuredEnvironmentKeys).toEqual(['ALLOW_EXTERNAL_PORTALS', 'JOB_MCP_STATE_DIR']);
    expect((await store.load()).mcp.env).toEqual({ ALLOW_EXTERNAL_PORTALS: '1', JOB_MCP_STATE_DIR: 'private-runtime-location' });
    expect(response.body.searchProfile.name).toBe('Geänderte Suche');
    expect(response.body.revision).toBe(publicConfig.revision + 1);
  });

  it('rejects unknown or malformed nested config fields as 400 before entering the store CAS', async () => {
    const store = new MemoryConfigStore();
    const app = createApp(store);
    const publicConfig = (await request(app).get('/api/config').expect(200)).body;
    const compareAndSave = vi.spyOn(store, 'compareAndSave');
    const malformed = [
      { ...structuredClone(publicConfig), searchProfile: { ...publicConfig.searchProfile, browserInjected: true } },
      { ...structuredClone(publicConfig), identities: [{ ...publicConfig.identities[0], browserInjected: true }] },
      { ...structuredClone(publicConfig), mcp: { ...publicConfig.mcp, env: { ALLOW_EXTERNAL_PORTALS: 1 } } },
      { ...structuredClone(publicConfig), assistant: { ...publicConfig.assistant, browserInjected: true } }
    ];

    for (const body of malformed) {
      const response = await request(app).put('/api/config').send(body).expect(400);
      expect(response.body.category).toBe('validation');
    }
    expect(compareAndSave).not.toHaveBeenCalled();
    expect((await store.loadSnapshot()).revision).toBe(0);
  });

  it('allows only one concurrent update for the same config revision', async () => {
    const config = structuredClone(defaultConfig);
    config.mcp.env = { ALLOW_EXTERNAL_PORTALS: '0', JOB_MCP_STATE_DIR: 'private-runtime-location' };
    const store = new MemoryConfigStore(config);
    const app = createApp(store);
    const current = (await request(app).get('/api/config').expect(200)).body;
    const first = structuredClone(current); first.searchProfile.name = 'CAS A';
    const second = structuredClone(current); second.searchProfile.name = 'CAS B';

    const responses = await Promise.all([
      request(app).put('/api/config').send(first),
      request(app).put('/api/config').send(second)
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const successful = responses.find((response) => response.status === 200)!;
    expect(successful.body.revision).toBe(1);
    expect(successful.body.mcp.env).toEqual({ ALLOW_EXTERNAL_PORTALS: '', JOB_MCP_STATE_DIR: '' });
    expect(JSON.stringify(successful.body)).not.toContain('private-runtime-location');
    expect((await store.loadSnapshot()).revision).toBe(1);
    expect((await store.load()).searchProfile.name).toBe(successful.body.searchProfile.name);
  });

  it('keeps integration commands, paths and environment server-owned', async () => {
    const config = structuredClone(defaultConfig);
    config.mcp.env = { ALLOW_EXTERNAL_PORTALS: '0', JOB_MCP_STATE_DIR: 'private-runtime-location' };
    const store = new MemoryConfigStore(config);
    const app = createApp(store);
    const publicConfig = (await request(app).get('/api/config').expect(200)).body;

    const injectedEnvironment = structuredClone(publicConfig);
    delete injectedEnvironment.mcp.configuredEnvironmentKeys;
    injectedEnvironment.mcp.env = { ALLOW_EXTERNAL_PORTALS: '1', JOB_MCP_STATE_DIR: 'attacker-location' };
    await request(app).put('/api/config').send(injectedEnvironment).expect(409);

    const bypassConfirmedPortalRoute = structuredClone(publicConfig);
    bypassConfirmedPortalRoute.mcp.env.ALLOW_EXTERNAL_PORTALS = '1';
    await request(app).put('/api/config').send(bypassConfirmedPortalRoute).expect(409);

    const injectedCommand = structuredClone(publicConfig);
    injectedCommand.mcp.command = 'C:\\synthetic\\job-search-mcp.exe';
    await request(app).put('/api/config').send(injectedCommand).expect(409);

    const injectedAssistantPath = structuredClone(publicConfig);
    injectedAssistantPath.assistant.skillPath = 'C:\\synthetic\\pipeline';
    await request(app).put('/api/config').send(injectedAssistantPath).expect(409);

    expect(await store.load()).toEqual(config);
  });

  it('updates portal permission atomically without exposing or deleting other MCP values', async () => {
    const config = structuredClone(defaultConfig);
    config.mcp.env = { ALLOW_EXTERNAL_PORTALS: '1', JOB_MCP_STATE_DIR: 'private-runtime-location' };
    const store = new MemoryConfigStore(config);
    const response = await request(createApp(store))
      .put('/api/config/mcp/portal-access')
      .send({ enabled: false, confirmed: true, expectedRevision: 0 })
      .expect(200);
    expect(response.body.revision).toBe(1);
    expect(response.body.mcp.env).toEqual({ ALLOW_EXTERNAL_PORTALS: '', JOB_MCP_STATE_DIR: '' });
    expect(JSON.stringify(response.body)).not.toContain('private-runtime-location');
    expect((await store.load()).mcp.env).toEqual({ ALLOW_EXTERNAL_PORTALS: '0', JOB_MCP_STATE_DIR: 'private-runtime-location' });
  });

  it('serializes concurrent portal permission updates and rejects the stale revision', async () => {
    const config = structuredClone(defaultConfig);
    config.mcp.env = { ALLOW_EXTERNAL_PORTALS: '1', JOB_MCP_STATE_DIR: 'private-runtime-location' };
    const store = new MemoryConfigStore(config);
    const app = createApp(store);
    const responses = await Promise.all([
      request(app).put('/api/config/mcp/portal-access').send({ enabled: false, confirmed: true, expectedRevision: 0 }),
      request(app).put('/api/config/mcp/portal-access').send({ enabled: false, confirmed: true, expectedRevision: 0 })
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await store.loadSnapshot()).revision).toBe(1);
    expect((await store.load()).mcp.env).toEqual({ ALLOW_EXTERNAL_PORTALS: '0', JOB_MCP_STATE_DIR: 'private-runtime-location' });
  });

  it('does not enable external portals without a validated trusted-host launch', async () => {
    await request(createApp(new MemoryConfigStore()))
      .put('/api/config/mcp/portal-access')
      .send({ enabled: true, confirmed: true, expectedRevision: 0 })
      .expect(409);
  });

  it('reports an invalid stdio runtime instead of treating mode=stdio as connected', async () => {
    const config = structuredClone(defaultConfig);
    config.mcp.mode = 'stdio';
    config.mcp.runtimeTarget = 'windows';
    const response = await request(createApp(new MemoryConfigStore(config)))
      .get('/api/sources/runtime')
      .expect(503);
    expect(response.body).toMatchObject({
      mode: 'stdio', state: 'invalid', launchValidated: false, connected: false
    });
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

  it('publishes compatible local application pipeline capabilities', async () => {
    const response = await request(createApp(new MemoryConfigStore()))
      .get('/api/assistant/capabilities')
      .expect(200);
    expect(response.body.contractVersion).toBe('1.0');
    expect(response.body.stages).toContain('finalize');
    expect(response.body.networkRequired).toBe(false);
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
    expect(response.body.category).toBe('policy');
    expect(response.body.correlationId).toBeTruthy();
  });

  it('returns a correlation id and writes only request metadata to the audit log', async () => {
    const audit = new MemoryAuditLogger();
    const response = await request(createApp(new MemoryConfigStore(), audit))
      .get('/api/health')
      .set('x-correlation-id', 'contract-test-123')
      .expect(200);
    expect(response.headers['x-correlation-id']).toBe('contract-test-123');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(audit.events[0]).toMatchObject({ correlationId: 'contract-test-123', status: 200 });
    expect(JSON.stringify(audit.events)).not.toContain('password');
  });

  it('persists application cases and blocks incognito approval', async () => {
    const workspace = new MemoryWorkspaceStore();
    const app = createApp(new MemoryConfigStore(), new MemoryAuditLogger(), workspace);
    const search = await request(app).post('/api/jobs/search').send({}).expect(200);
    const created = await request(app).post('/api/application-cases').send({
      match: search.body.matches[0], identityId: 'incognito-default', documentType: 'cover_letter'
    }).expect(201);
    expect((await workspace.getApplicationCase(created.body.id))?.state).toBe('selected');
    await request(app).post(`/api/application-cases/${created.body.id}/transition`).send({ state: 'analysis' }).expect(200);
    await request(app).post(`/api/application-cases/${created.body.id}/transition`).send({ state: 'draft' }).expect(200);
    await request(app).post(`/api/application-cases/${created.body.id}/transition`).send({ state: 'review' }).expect(200);
    const blocked = await request(app).post(`/api/application-cases/${created.body.id}/transition`).send({
      state: 'approved', revisionId: '00000000-0000-4000-8000-000000000000', expectedSha256: '0'.repeat(64), confirmed: true
    }).expect(409);
    expect(blocked.body.category).toBe('policy');
    const history = await request(app).get(`/api/application-cases/${created.body.id}/history`).expect(200);
    expect(history.body.map((event: { to: string }) => event.to)).toEqual(['selected', 'analysis', 'draft', 'review']);
  });

  it('exports data without identities by default and deletes only confirmed scope', async () => {
    const workspace = new MemoryWorkspaceStore();
    const app = createApp(new MemoryConfigStore(), new MemoryAuditLogger(), workspace);
    await request(app).post('/api/jobs/search').send({}).expect(200);
    const exported = await request(app).post('/api/data/export').send({}).expect(200);
    expect(exported.body.containsPersonalData).toBe(false);
    expect(exported.body.config.identities).toEqual([]);
    expect(Object.values(exported.body.config.mcp.env)).not.toContain('0');
    await request(app).delete('/api/data/search_runs').send({ confirmation: 'wrong' }).expect(409);
    const deleted = await request(app).delete('/api/data/search_runs').send({ confirmation: 'DELETE search_runs' }).expect(200);
    expect(deleted.body.removed).toBe(1);
  });

  it('persists reversible job decisions and exportable comparison notes', async () => {
    const app = createApp(new MemoryConfigStore());
    await request(app).put('/api/job-decisions/job-1').send({ state: 'hidden' }).expect(200);
    const decisions = await request(app).get('/api/job-decisions').expect(200);
    expect(decisions.body).toMatchObject([{ jobId: 'job-1', state: 'hidden' }]);
    await request(app).put('/api/job-decisions/job-1').send({ state: 'neutral' }).expect(200);
    const note = await request(app).post('/api/comparison-notes').send({
      jobIds: ['job-1', 'job-2', 'job-3'], note: 'Synthetische Vergleichsnotiz',
      weights: { searchPreference: 1, evidenceCoverage: 2, gaps: 3, salary: 1 }
    }).expect(201);
    const exported = await request(app).get('/api/comparison-notes-export.json').expect(200);
    expect(exported.body.notes[0].note).toBe('Synthetische Vergleichsnotiz');
    await request(app).delete(`/api/comparison-notes/${note.body.id}`).send({ confirmation: `DELETE comparison-note ${note.body.id}` }).expect(200);
  });

  it('requires provenance for portal tracking and keeps explicit corrections append-only', async () => {
    const app = createApp(new MemoryConfigStore());
    const search = await request(app).post('/api/jobs/search').send({}).expect(200);
    const created = await request(app).post('/api/application-cases').send({ match: search.body.matches[0], identityId: 'incognito-default', documentType: 'cover_letter' }).expect(201);
    await request(app).post(`/api/application-cases/${created.body.id}/tracking`).send({ status: 'confirmed', source: 'portal' }).expect(400);
    const planned = await request(app).post(`/api/application-cases/${created.body.id}/tracking`).send({ status: 'planned', source: 'user' }).expect(201);
    await request(app).post(`/api/application-cases/${created.body.id}/tracking`).send({ status: 'withdrawn', source: 'user', correctionOf: planned.body.id }).expect(201);
    const history = await request(app).get(`/api/application-cases/${created.body.id}/tracking`).expect(200);
    expect(history.body).toHaveLength(2);
    expect(history.body[1].correctionOf).toBe(planned.body.id);
  });
});
