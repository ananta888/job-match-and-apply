import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApplicationArtifactRevision, ApplicationCase, SearchRun } from '../domain/models.js';
import { defaultConfig } from '../config/defaults.js';
import { JsonWorkspaceStore } from './workspace-store.js';

let directory = '';
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = ''; });

describe('JsonWorkspaceStore', () => {
  it('serializes concurrent atomic updates without losing search runs', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'workspace-store-'));
    const store = new JsonWorkspaceStore(resolve(directory, 'workspace.json'));
    const run = (id: string): SearchRun => ({
      id, createdAt: '2026-08-13T00:00:00.000Z', profile: structuredClone(defaultConfig.searchProfile), sourceIds: [], matches: []
    });
    await Promise.all([store.saveSearchRun(run('one')), store.saveSearchRun(run('two'))]);
    expect((await store.listSearchRuns()).map((item) => item.id).sort()).toEqual(['one', 'two']);
  });
  it('detects corrupt data and never silently overwrites it', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'workspace-corrupt-'));
    const path = resolve(directory, 'workspace.json');
    await writeFile(path, '{broken', 'utf8');
    const store = new JsonWorkspaceStore(path);
    await expect(store.listSearchRuns()).rejects.toThrow();
    await expect(store.saveSearchRun({ id: 'new', createdAt: '2026-01-01T00:00:00Z', profile: structuredClone(defaultConfig.searchProfile), sourceIds: [], matches: [] })).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('{broken');
  });

  it('retains immutable used-document metadata when an old closed case is purged', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'workspace-used-retention-'));
    const store = new JsonWorkspaceStore(resolve(directory, 'workspace.json'));
    const application: ApplicationCase = {
      id: '10000000-0000-4000-8000-000000000001',
      job: {
        id: 'job-synthetic', sourceId: 'synthetic', title: 'Engineer', company: 'Example GmbH', location: 'Berlin',
        workModel: 'hybrid', employmentType: 'full_time', description: 'Synthetic', skills: [],
      },
      identityId: 'identity-real', identityMode: 'real', documentType: 'cover_letter', state: 'closed',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
      artifactNames: [], warnings: [], revision: 4,
    };
    const used: ApplicationArtifactRevision = {
      id: '20000000-0000-4000-8000-000000000001', applicationCaseId: application.id,
      companyKey: 'example', jobId: application.job.id, type: 'cover_letter', lifecycle: 'used',
      sha256: 'a'.repeat(64), bytes: 123, artifactPath: 'synthetic/used.md', pipelineContractVersion: '2.0',
      createdAt: '2026-01-01T00:00:00.000Z', usedAt: '2026-01-02T00:00:00.000Z',
      usedForApplicationCaseId: application.id,
    };
    const proposed: ApplicationArtifactRevision = {
      ...used, id: '20000000-0000-4000-8000-000000000002', lifecycle: 'proposed', usedAt: undefined,
      usedForApplicationCaseId: undefined,
    };
    await store.saveApplicationCase(application);
    await store.saveArtifactRevision(used);
    await store.saveArtifactRevision(proposed);

    await store.purgeBefore('2026-02-01T00:00:00.000Z');

    expect(await store.getApplicationCase(application.id)).toBeUndefined();
    expect(await store.listArtifactRevisions(application.id)).toEqual([used]);
  });
});
