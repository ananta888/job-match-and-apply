import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApplicationCase } from '../domain/models.js';
import { createArtifactRevision, markArtifactUsed } from './artifact-revisions.js';
import { MemoryWorkspaceStore } from './workspace-store.js';

const application = (mode: 'real' | 'incognito'): ApplicationCase => ({ id: '11111111-1111-4111-8111-111111111111', job: { id: 'JOB-1', sourceId: 'test', title: 'Engineer', company: 'Acme GmbH', location: 'Berlin', workModel: 'hybrid', employmentType: 'full_time', description: '', skills: [] }, identityId: mode, identityMode: mode, documentType: 'cover_letter', state: 'draft', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', artifactNames: [], warnings: [], revision: 1 });

describe('artifact revisions', () => {
  it('stores a hashed revision and makes a used revision immutable', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'application-artifact-')); const store = new MemoryWorkspaceStore(); const app = application('real');
    const revision = await createArtifactRevision(store, app, { type: 'cover_letter', content: 'Belegter Entwurf', pipelineContractVersion: '1.0.0' }, root);
    expect(revision.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(resolve(root, revision.artifactPath), 'utf8')).toBe('Belegter Entwurf');
    const used = await markArtifactUsed(store, app, revision.id); expect(used.lifecycle).toBe('used');
    await expect(store.saveArtifactRevision({ ...used, type: 'cv' })).rejects.toThrow('unveränderlich');
  });

  it('does not allow incognito artifacts to be marked as sent', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'application-artifact-')); const store = new MemoryWorkspaceStore(); const app = application('incognito');
    const revision = await createArtifactRevision(store, app, { type: 'cv', content: 'Vorschau', pipelineContractVersion: '1.0.0' }, root);
    await expect(markArtifactUsed(store, app, revision.id)).rejects.toThrow('Inkognito');
  });
});
