import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, createDefaultAgentApiDependencies } from './app.js';
import { AgentConfigProfileStore } from './agents/config-profile-store.js';
import { MemoryAuditLogger } from './services/audit-logger.js';
import { MemoryConfigStore } from './services/config-store.js';
import { MemoryWorkspaceStore } from './services/workspace-store.js';

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe('agent config profile API', () => {
  it('provides atomic compare-and-save and classifies invalid nested profiles as client errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-config-api-'));
    temporary.push(root);
    const dependencies = createDefaultAgentApiDependencies(true);
    dependencies.configProfiles = new AgentConfigProfileStore(root);
    const app = createApp(
      new MemoryConfigStore(), new MemoryAuditLogger(), new MemoryWorkspaceStore(), undefined, dependencies,
    );
    const loaded = await request(app).get('/api/agents/config-profile').expect(200);
    expect(loaded.headers['cache-control']).toBe('no-store');
    const expectedUpdatedAt = loaded.body.profile.updatedAt as string;
    const firstProfile = structuredClone(loaded.body.profile) as Record<string, unknown>;
    firstProfile.profileId = 'first-write';
    const secondProfile = structuredClone(loaded.body.profile) as Record<string, unknown>;
    secondProfile.profileId = 'second-write';
    const responses = await Promise.all([
      request(app).put('/api/agents/config-profile').send({ expectedUpdatedAt, confirmed: true, profile: firstProfile }),
      request(app).put('/api/agents/config-profile').send({ expectedUpdatedAt, confirmed: true, profile: secondProfile }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = responses.find((response) => response.status === 200)!;
    expect(Date.parse(winner.body.profile.updatedAt as string)).toBeGreaterThan(Date.parse(expectedUpdatedAt));

    const invalid = await request(app).put('/api/agents/config-profile').send({
      expectedUpdatedAt: winner.body.profile.updatedAt,
      confirmed: true,
      profile: { ...winner.body.profile, apiToken: 'MUST-NOT-PERSIST' },
    });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(invalid.body)).not.toContain('MUST-NOT-PERSIST');
  });
});
