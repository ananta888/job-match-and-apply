import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentArtifactStore, textDiff, type AgentArtifactProvenance } from './artifact-store.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const provenance = (mode: 'real' | 'incognito' = 'real'): AgentArtifactProvenance => ({
  runId: 'run-1', provider: 'fake', providerVersion: '1.0.0', adapterVersion: '1.0.0',
  templateId: 'application-draft', templateVersion: '1.0.0', workflowId: 'evidence-application-package',
  workflowVersion: '1.0.0', applicationCaseId: 'case-1', applicationCaseRevision: 3,
  jobId: 'job-1', companyKey: 'example-gmbh', identityMode: mode,
});

async function fixture(mode: 'real' | 'incognito' = 'real') {
  const root = await mkdtemp(join(tmpdir(), 'agent-artifacts-')); roots.push(root);
  const store = new AgentArtifactStore(root);
  const record = await store.create({
    kind: 'cover-letter', content: 'synthetic', mediaType: 'text/plain', relativePath: 'drafts/letter.txt', provenance: provenance(mode),
  });
  return { root, store, record };
}

describe('AgentArtifactStore', () => {
  it('deduplicates immutable content while preserving separate complete provenance records', async () => {
    const { store, record: first } = await fixture();
    const second = await store.create({ kind: 'cover-letter', content: 'synthetic', mediaType: 'text/plain', provenance: { ...provenance(), runId: 'run-2' } });
    expect(first.id).not.toBe(second.id);
    expect(first.sha256).toBe(second.sha256);
    expect(first).toMatchObject({ revision: 0, lifecycle: 'proposed', provenance: { runId: 'run-1', jobId: 'job-1', companyKey: 'example-gmbh' } });
    expect((await store.read(first.id)).content.toString()).toBe('synthetic');
    expect((await store.list({ runId: 'run-1' })).map((item) => item.id)).toEqual([first.id]);
    expect(await store.verify()).toEqual(expect.arrayContaining([expect.objectContaining({ id: first.id, valid: true })]));
  });

  it('enforces relative paths, media types and revision-bound terminal review', async () => {
    const { store, record } = await fixture();
    await expect(store.create({ kind: 'draft', content: 'x', mediaType: 'text/plain', relativePath: '../escape', provenance: provenance() })).rejects.toThrow('artifact_path');
    await expect(store.create({ kind: 'draft', content: 'x', mediaType: 'text/html', provenance: provenance() })).rejects.toThrow('media_type');
    await expect(store.review(record.id, 'approved', 1, 'local-user')).rejects.toMatchObject({ statusCode: 409 });
    expect((await store.review(record.id, 'approved', 0, 'local-user'))).toMatchObject({ lifecycle: 'approved', revision: 1 });
    await expect(store.review(record.id, 'rejected', 0, 'local-user')).rejects.toMatchObject({ statusCode: 409 });
    await expect(store.review(record.id, 'rejected', 1, 'local-user')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects a pre-existing blob that does not match its content address', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-artifacts-corrupt-')); roots.push(root);
    const content = 'expected immutable content';
    const hash = createHash('sha256').update(content).digest('hex');
    const directory = join(root, 'blobs', hash.slice(0, 2));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, hash), 'corrupted');
    await expect(new AgentArtifactStore(root).create({
      kind: 'draft', content, mediaType: 'text/plain', provenance: provenance(),
    })).rejects.toThrow('collision_or_corruption');
  });

  it.runIf(process.platform === 'win32')('uses canonical Windows root identity for safe deletion staging', async () => {
    const physicalRoot = await mkdtemp(join(tmpdir(), 'agent-artifacts-path-case-')); roots.push(physicalRoot);
    const store = new AgentArtifactStore(physicalRoot.toUpperCase());
    const record = await store.create({
      kind: 'draft', content: 'case-insensitive-root', mediaType: 'text/plain', provenance: provenance(),
    });
    const preview = await store.previewDeletion([record.id]);
    await expect(store.applyDeletion(preview)).resolves.toMatchObject({
      deletedRecords: [record.id], deletedBlobs: [record.sha256],
    });
    await expect(store.get(record.id)).resolves.toBeUndefined();
  });

  it('allows used only through the injected validated adoption port', async () => {
    const { store, record } = await fixture();
    const approved = await store.review(record.id, 'approved', 0, 'local-user');
    const adopt = vi.fn(async (input: { content: Buffer; idempotencyKey: string }) => {
      expect(input.content.toString()).toBe('synthetic');
      expect(input.idempotencyKey).toContain(record.sha256);
      return { applicationCaseId: 'case-1', jobId: 'job-1', companyKey: 'example-gmbh', sourceReference: 'application-artifact:revision-1' };
    });
    const used = await store.adopt(record.id, approved.revision, { adopt });
    expect(used).toMatchObject({ lifecycle: 'used', revision: 2, adoption: { sourceReference: 'application-artifact:revision-1' } });
    expect(adopt).toHaveBeenCalledOnce();
    await expect(store.adopt(record.id, used.revision, { adopt })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('fails closed on incognito and mismatched domain adoption', async () => {
    const incognito = await fixture('incognito');
    const approvedIncognito = await incognito.store.review(incognito.record.id, 'approved', 0, 'local-user');
    const port = { adopt: vi.fn(async () => ({ applicationCaseId: 'case-1', jobId: 'job-1', companyKey: 'example-gmbh', sourceReference: 'application-artifact:one' })) };
    await expect(incognito.store.adopt(incognito.record.id, approvedIncognito.revision, port)).rejects.toThrow('incognito');
    expect(port.adopt).not.toHaveBeenCalled();

    const real = await fixture();
    const approved = await real.store.review(real.record.id, 'approved', 0, 'local-user');
    await expect(real.store.adopt(real.record.id, approved.revision, { adopt: async () => ({
      applicationCaseId: 'case-foreign', jobId: 'job-1', companyKey: 'example-gmbh', sourceReference: 'application-artifact:two',
    }) })).rejects.toThrow('adoption_result_mismatch');
    expect((await real.store.get(real.record.id))?.lifecycle).toBe('approved');
  });

  it('serializes concurrent reviews so only one expected revision wins', async () => {
    const { store, record } = await fixture();
    const results = await Promise.allSettled([
      store.review(record.id, 'approved', 0, 'one'),
      store.review(record.id, 'rejected', 0, 'two'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('creates bounded deterministic text comparisons', () => {
    expect(textDiff('a\nb', 'a\nc\nd')).toEqual([
      { line: 2, before: 'b', after: 'c' }, { line: 3, before: undefined, after: 'd' },
    ]);
    expect(() => textDiff('x'.repeat(2 * 1024 * 1024), 'y')).toThrow('artifact_diff_too_large');
  });
});
