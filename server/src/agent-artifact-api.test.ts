import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adoptApprovedAgentArtifact, createApp, createDefaultAgentApiDependencies } from './app.js';
import { AgentArtifactStore } from './agents/artifact-store.js';
import type { ApplicationCase } from './domain/models.js';
import { MemoryConfigStore } from './services/config-store.js';
import { MemoryAuditLogger } from './services/audit-logger.js';
import { MemoryWorkspaceStore } from './services/workspace-store.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function application(id: string, mode: 'real' | 'incognito'): ApplicationCase {
  return {
    id,
    job: {
      id: `job-${id}`, sourceId: 'synthetic', title: 'Engineer', company: 'Example GmbH', location: 'Berlin',
      workModel: 'hybrid', employmentType: 'full_time', description: 'Synthetic posting', skills: [],
    },
    identityId: `identity-${mode}`, identityMode: mode, documentType: 'cover_letter', state: 'draft',
    createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z',
    artifactNames: [], warnings: [], revision: 1,
  };
}

async function fixture(mode: 'real' | 'incognito' = 'real') {
  const root = await mkdtemp(join(tmpdir(), 'agent-artifact-api-')); roots.push(root);
  const config = new MemoryConfigStore();
  const audit = new MemoryAuditLogger();
  const workspace = new MemoryWorkspaceStore();
  const applicationCase = application(
    mode === 'real' ? '10000000-0000-4000-8000-000000000001' : '10000000-0000-4000-8000-000000000002',
    mode,
  );
  await workspace.saveApplicationCase(applicationCase);
  const dependencies = createDefaultAgentApiDependencies(true);
  dependencies.artifacts = new AgentArtifactStore(join(root, 'artifacts'));
  const app = createApp(config, audit, workspace, undefined, dependencies);
  const run = await request(app).post('/api/agent-runs').send({
    providerId: 'fake', prompt: 'create a traceable synthetic proposal', workspaceMode: 'read_only', network: false,
    applicationCaseId: applicationCase.id,
  });
  expect(run.status).toBe(201);
  return { root, app, audit, workspace, dependencies, applicationCase, runId: run.body.id as string };
}

describe('agent artifact REST and adoption boundary', () => {
  it('derives complete provenance from server state and never accepts browser provenance', async () => {
    const { app, runId, applicationCase } = await fixture();
    const content = 'PRIVATE-ARTIFACT-CONTENT';
    const forged = await request(app).post(`/api/agent-runs/${runId}/artifacts`).send({
      kind: 'cover-letter', content, mediaType: 'text/plain', provenance: { provider: 'forged' },
    });
    expect(forged.status).toBe(400);
    const created = await request(app).post(`/api/agent-runs/${runId}/artifacts`).send({
      kind: 'cover-letter', content, mediaType: 'text/plain', relativePath: 'drafts/cover-letter.md',
    });
    expect(created.status, created.text).toBe(201);
    expect(created.body).toMatchObject({
      lifecycle: 'proposed', revision: 0, relativePath: 'drafts/cover-letter.md',
      provenance: {
        runId, provider: 'fake', providerVersion: expect.any(String), adapterVersion: expect.any(String),
        templateId: 'workspace-task', templateVersion: '1.0.0', applicationCaseId: applicationCase.id,
        applicationCaseRevision: applicationCase.revision, jobId: applicationCase.job.id,
        companyKey: 'example', identityMode: 'real',
      },
    });
    expect(created.text).not.toContain(content);
    const listed = await request(app).get(`/api/agent-runs/${runId}/artifacts`);
    expect(listed.body.artifacts).toEqual([expect.objectContaining({ id: created.body.id, sha256: created.body.sha256 })]);
    expect(listed.text).not.toContain(content);
    const metadata = await request(app).get(`/api/agent-runs/${runId}/artifacts/${created.body.id}`);
    expect(metadata.text).not.toContain(content);
    const read = await request(app).get(`/api/agent-runs/${runId}/artifacts/${created.body.id}/content`);
    expect(read.body).toMatchObject({ id: created.body.id, content });
    expect(read.headers['cache-control']).toBe('no-store');
  });

  it('provides bounded same-run text diffs and hides artifacts from run exports and logs', async () => {
    const { app, audit, runId } = await fixture();
    const first = await request(app).post(`/api/agent-runs/${runId}/artifacts`).send({ kind: 'draft', content: 'ARTIFACT-RAW-BASE\nARTIFACT-RAW-ALPHA', mediaType: 'text/plain' });
    const second = await request(app).post(`/api/agent-runs/${runId}/artifacts`).send({ kind: 'draft', content: 'ARTIFACT-RAW-BASE\nARTIFACT-RAW-BETA', mediaType: 'text/plain' });
    const diff = await request(app).get(`/api/agent-runs/${runId}/artifacts/diff`).query({ left: first.body.id, right: second.body.id });
    expect(diff.status).toBe(200);
    expect(diff.body.changes).toEqual([{ line: 2, before: 'ARTIFACT-RAW-ALPHA', after: 'ARTIFACT-RAW-BETA' }]);
    const exported = await request(app).get(`/api/agent-runs/${runId}/export`);
    expect(exported.text).not.toContain('ARTIFACT-RAW');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.stringify(audit.events)).not.toContain('ARTIFACT-RAW');
  });

  it('binds review to run, lifecycle and revision and exposes no generic used endpoint', async () => {
    const first = await fixture();
    const created = await request(first.app).post(`/api/agent-runs/${first.runId}/artifacts`).send({ kind: 'draft', content: 'review me', mediaType: 'text/plain' });
    const stale = await request(first.app).post(`/api/agent-runs/${first.runId}/artifacts/${created.body.id}/review`).send({ decision: 'approved', expectedRevision: 1, confirmed: true });
    expect(stale.status).toBe(409);
    const approved = await request(first.app).post(`/api/agent-runs/${first.runId}/artifacts/${created.body.id}/review`).send({ decision: 'approved', expectedRevision: 0, confirmed: true });
    expect(approved.body).toMatchObject({ lifecycle: 'approved', revision: 1 });
    const repeated = await request(first.app).post(`/api/agent-runs/${first.runId}/artifacts/${created.body.id}/review`).send({ decision: 'rejected', expectedRevision: 1, confirmed: true });
    expect(repeated.status).toBe(409);
    expect((await request(first.app).post(`/api/agent-runs/${first.runId}/artifacts/${created.body.id}/use`).send({ confirmed: true })).status).toBe(404);

    const second = await fixture();
    expect((await request(second.app).get(`/api/agent-runs/${second.runId}/artifacts/${created.body.id}`)).status).toBe(404);
  });

  it('marks used only through an injected matching domain adoption and blocks incognito', async () => {
    const real = await fixture();
    const created = await request(real.app).post(`/api/agent-runs/${real.runId}/artifacts`).send({ kind: 'draft', content: 'adopt me', mediaType: 'text/plain' });
    const approved = await request(real.app).post(`/api/agent-runs/${real.runId}/artifacts/${created.body.id}/review`).send({ decision: 'approved', expectedRevision: 0, confirmed: true });
    await expect(adoptApprovedAgentArtifact(real.dependencies, created.body.id, approved.body.revision)).rejects.toMatchObject({ statusCode: 503 });
    const adopt = vi.fn(async () => ({
      applicationCaseId: real.applicationCase.id, jobId: real.applicationCase.job.id, companyKey: 'example',
      sourceReference: 'application-artifact:domain-revision-1',
    }));
    real.dependencies.artifactAdoption = { adopt };
    await expect(adoptApprovedAgentArtifact(real.dependencies, created.body.id, approved.body.revision)).resolves.toMatchObject({ lifecycle: 'used', revision: 2 });
    expect(adopt).toHaveBeenCalledOnce();

    const incognito = await fixture('incognito');
    const incognitoCreated = await request(incognito.app).post(`/api/agent-runs/${incognito.runId}/artifacts`).send({ kind: 'draft', content: 'preview only', mediaType: 'text/plain' });
    const incognitoApproved = await request(incognito.app).post(`/api/agent-runs/${incognito.runId}/artifacts/${incognitoCreated.body.id}/review`).send({ decision: 'approved', expectedRevision: 0, confirmed: true });
    const incognitoAdopt = vi.fn(async () => ({
      applicationCaseId: incognito.applicationCase.id, jobId: incognito.applicationCase.job.id, companyKey: 'example', sourceReference: 'application-artifact:no',
    }));
    incognito.dependencies.artifactAdoption = { adopt: incognitoAdopt };
    await expect(adoptApprovedAgentArtifact(incognito.dependencies, incognitoCreated.body.id, incognitoApproved.body.revision)).rejects.toThrow('incognito');
    expect(incognitoAdopt).not.toHaveBeenCalled();
  });
});
