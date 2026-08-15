import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EncryptedCvAiStructuringRunStore, MemoryCvAiStructuringRunStore,
  sealCvAiStructuringRun, type CvAiStructuringRunRecord,
} from './cv-ai-structuring-store.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function record(overrides: Partial<CvAiStructuringRunRecord> = {}): CvAiStructuringRunRecord {
  return sealCvAiStructuringRun({
    contract: 'cv-ai-structuring-run', contractVersion: '1.0',
    id: '11111111-1111-4111-8111-111111111111', cvImportId: '22222222-2222-4222-8222-222222222222',
    revision: 1, status: 'suggestions_ready', attempt: 1,
    createdAt: '2026-08-14T10:00:00.000Z', updatedAt: '2026-08-14T10:00:00.000Z', expiresAt: '2026-08-15T10:00:00.000Z',
    provider: {
      id: 'fake', runtimeTarget: 'windows', version: 'fake 1.0.0', adapterVersion: '1.0.0',
    },
    disclosure: {
      version: '1.0', confirmedAt: '2026-08-14T10:00:00.000Z', confirmedBy: { id: 'local-user', type: 'local' },
      extractedCvTextShared: true, providerControlPlaneNetworkAcknowledged: true,
      toolNetwork: 'disabled', rootMcpTools: [], jobSearchMcpAccessible: false,
    },
    binding: {
      cvImportRevision: 3, cvImportSha256: 'a'.repeat(64), sourceId: 'source-cv-aaaaaaaaaaaaaaaa', sourceSha256: 'b'.repeat(64),
      extractedTextSha256: 'c'.repeat(64), baseProposalSha256: '4'.repeat(64), lineManifestSha256: 'd'.repeat(64),
      promptTemplateVersion: 'cv-ai-structuring/1.0', promptSha256: 'e'.repeat(64),
      outputContractVersion: '1.0', outputSchemaSha256: 'f'.repeat(64), inputSha256: '1'.repeat(64),
    },
    agentRunId: '33333333-3333-4333-8333-333333333333',
    proposal: {
      sha256: '2'.repeat(64), outputSha256: '3'.repeat(64),
      suggestions: [{
        id: 'suggestion-1111111111111111', path: 'employment[0].role', collection: 'experience',
        recordId: 'record-synthetic', field: 'role', category: 'employment', mergeable: true,
        value: 'SYNTHETIC SECRET ROLE',
        sourceAnchor: { lineStart: 2, lineEnd: 2, charStart: 0, charEnd: 21, quote: 'SYNTHETIC SECRET ROLE' },
        confidence: 0.9, alternatives: [], questions: [], status: 'unverified',
      }],
      privateArtifact: { canary: 'PRIVATE-PROPOSAL-CANARY' },
    },
    auditTrail: [{ sequence: 1, occurredAt: '2026-08-14T10:00:00.000Z', action: 'started', actorId: 'local-user' }],
    ...overrides,
  });
}

describe('EncryptedCvAiStructuringRunStore', () => {
  it('encrypts proposal values and private artifacts at rest while preserving a verified round trip', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cv-ai-store-')); roots.push(root);
    const store = new EncryptedCvAiStructuringRunStore(join(root, 'runs'), join(root, 'key'));
    const input = record();
    await store.create(input);

    expect(await store.get(input.id)).toEqual(input);
    const persisted = await readFile(join(root, 'runs', input.id, 'record.enc.json'), 'utf8');
    expect(persisted).not.toContain('SYNTHETIC SECRET ROLE');
    expect(persisted).not.toContain('PRIVATE-PROPOSAL-CANARY');
    expect(persisted).not.toContain(input.cvImportId);
  });

  it('enforces revision and SHA CAS, lists only one import, and deletes with CAS', async () => {
    const store = new MemoryCvAiStructuringRunStore();
    const first = record();
    const other = record({
      id: '44444444-4444-4444-8444-444444444444',
      cvImportId: '55555555-5555-4555-8555-555555555555',
    });
    await store.create(first); await store.create(other);
    const next = sealCvAiStructuringRun({
      ...first, revision: 2, updatedAt: '2026-08-14T10:01:00.000Z', status: 'applied',
      result: {
        cvImportRevision: 4, cvImportSha256: '5'.repeat(64),
        stagedFactIds: ['fact-synthetic'], factsRemainPending: true,
      },
    });
    await store.compareAndSave(first.id, first.revision, first.sha256, next);
    await expect(store.compareAndSave(first.id, first.revision, first.sha256, next)).rejects.toThrow('cv_ai_run_revision_conflict');
    expect(await store.listByImport(first.cvImportId)).toEqual([next]);
    await expect(store.compareAndDelete(first.id, 2, '0'.repeat(64))).rejects.toThrow('cv_ai_run_sha_conflict');
    expect(await store.compareAndDelete(first.id, 2, next.sha256)).toBe(true);
    expect(await store.get(first.id)).toBeUndefined();
  });

  it('lists expired records for explicit CAS cleanup and leaves no plaintext inventory metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cv-ai-store-prune-')); roots.push(root);
    const store = new EncryptedCvAiStructuringRunStore(join(root, 'runs'), join(root, 'key'));
    const expired = record({ expiresAt: '2026-08-14T10:00:01.000Z' });
    const live = record({ id: '66666666-6666-4666-8666-666666666666', expiresAt: '2026-08-14T10:00:03.000Z' });
    await store.create(expired); await store.create(live);

    expect(await store.listExpired(new Date('2026-08-14T10:00:02.000Z'))).toEqual([expired]);
    expect(await store.compareAndDelete(expired.id, expired.revision, expired.sha256)).toBe(true);
    expect(await store.get(expired.id)).toBeUndefined();
    expect(await store.get(live.id)).toEqual(live);
    expect((await readdir(join(root, 'runs'))).sort()).toEqual([live.id]);
  });

  it('enforces the per-import inventory cap atomically in create', async () => {
    const store = new MemoryCvAiStructuringRunStore();
    for (let index = 1; index <= 19; index += 1) {
      await store.create(record({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` }));
    }
    const raced = await Promise.allSettled([
      store.create(record({ id: '00000000-0000-4000-8000-000000000020' })),
      store.create(record({ id: '00000000-0000-4000-8000-000000000021' })),
    ]);
    expect(raced.map((item) => item.status).sort()).toEqual(['fulfilled', 'rejected']);
    await expect(store.assertCanCreate('22222222-2222-4222-8222-222222222222'))
      .rejects.toThrow('cv_ai_import_run_limit');
    await expect(store.create(record({ id: '00000000-0000-4000-8000-000000000022' })))
      .rejects.toThrow('cv_ai_import_run_limit');
    expect(await store.listByImport('22222222-2222-4222-8222-222222222222', 1_001)).toHaveLength(20);
  });

  it('requires a bound private apply intent only while applying', () => {
    const applying = record({ status: 'applying', applyIntent: {
      expectedCvImportRevision: 3, expectedCvImportSha256: 'a'.repeat(64),
      selections: [{ suggestionId: 'suggestion-1111111111111111', alternativeId: null }],
      confirmedBy: { id: 'local-user', type: 'local' }, correlationId: 'apply-recovery-test',
    } });
    expect(applying.applyIntent?.selections).toHaveLength(1);
    expect(() => record({ status: 'applying' })).toThrow('cv_ai_run_status_payload_invalid');
    expect(() => record({ applyIntent: applying.applyIntent })).toThrow('cv_ai_run_status_payload_invalid');
  });

  it('binds replacement-mode results to a recognition version while accepting legacy records without mode', () => {
    expect(record().mode).toBeUndefined();
    const replacement = record({
      mode: 'replace_with_ai_version', status: 'applied',
      result: {
        cvImportRevision: 4, cvImportSha256: '5'.repeat(64),
        stagedFactIds: ['fact-synthetic'], factsRemainPending: true,
        recognitionVersionId: 'recognition-aaaaaaaaaaaaaaaa', recognitionVersionCount: 2,
      },
    });
    expect(replacement.result?.recognitionVersionId).toBe('recognition-aaaaaaaaaaaaaaaa');
    expect(() => record({
      mode: 'replace_with_ai_version', status: 'applied',
      result: {
        cvImportRevision: 4, cvImportSha256: '5'.repeat(64),
        stagedFactIds: ['fact-synthetic'], factsRemainPending: true,
      },
    })).toThrow('cv_ai_run_result_invalid');
  });
});
