import { createHash } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApp } from './app.js';
import { MemoryConfigStore } from './services/config-store.js';
import {
  CvImportService, MemoryCvImportRepository,
  type CvImportRecord, type CvRecognitionVersion,
} from './services/cv-imports.js';
import type { CvFact, CvNormalizationPort } from './ports/cv-normalization.js';
import { ApplicationPipelineProofAuthority, StaticApplicationPipelineProofKeyProvider } from './services/application-pipeline-proof.js';
import { MemoryAuditLogger } from './services/audit-logger.js';
import { classifyCvContractRejection } from './adapters/submodule-cv-normalization.js';
import type { CvAiStructuringService } from './services/cv-ai-structuring.js';

const normalization: CvNormalizationPort = {
  async normalize(envelope) {
    return {
      facts: [{
        id: 'fact-synthetic', claimId: 'claim-synthetic', category: 'skill', recordId: 'skill-synthetic',
        field: 'name', value: 'TypeScript', decision: 'pending',
        provenance: { sourceSha256: envelope.source.sha256, anchor: 'line:1', origin: 'imported' },
      }], warnings: [], conflicts: [], artifact: { private: 'normalization artifact' },
    };
  },
  async validateUserFacts() {},
  async adopt(input) {
    return {
      contract: 'cv-profile-adoption', contractVersion: '1.0',
      adoptedClaimIds: input.facts.filter((fact) => fact.decision === 'confirmed').map((fact) => fact.claimId!),
      adoptedRecordIds: ['skill-synthetic'], candidateProfileSha256: 'a'.repeat(64), candidateProfileRevision: `sha256:${'a'.repeat(64)}`,
      transactionId: 'c'.repeat(32),
    };
  },
  async adoptionLedger() {
    return { candidateProfileSha256: 'a'.repeat(64), adoptions: [] };
  },
  async revokeAdoption(input) {
    return {
      contract: 'cv-profile-adoption-revocation', contractVersion: '1.0',
      revokedTransactionId: input.transactionId, revokedClaimIds: [], revokedRecordIds: [],
      candidateProfileSha256: 'd'.repeat(64), candidateProfileRevision: `sha256:${'d'.repeat(64)}`,
    };
  },
  async profileSnapshots() {
    return { candidateProfileSha256: 'a'.repeat(64), snapshots: [] };
  },
  async restoreProfileSnapshot(input) {
    return {
      contract: 'cv-profile-snapshot-restore', contractVersion: '1.0', snapshotId: input.snapshotId,
      candidateProfileSha256: 'e'.repeat(64), candidateProfileRevision: `sha256:${'e'.repeat(64)}`,
    };
  },
};

function appWithCvImports(
  cvImports: CvImportService,
  audit?: MemoryAuditLogger,
  cvAiStructuring?: CvAiStructuringService,
) {
  return createApp(new MemoryConfigStore(), audit, undefined, undefined, undefined, {
    proofAuthority: new ApplicationPipelineProofAuthority(new StaticApplicationPipelineProofKeyProvider(Buffer.alloc(32, 7))),
    workRoot: '.application-work', cvImports,
    ...(cvAiStructuring ? { cvAiStructuring } : {}),
  });
}

function app(
  normalizationPort: CvNormalizationPort = normalization,
  audit?: MemoryAuditLogger,
  cvAiStructuring?: CvAiStructuringService,
) {
  return appWithCvImports(new CvImportService(new MemoryCvImportRepository(), normalizationPort), audit, cvAiStructuring);
}

function recognitionApp(normalizationPort: CvNormalizationPort = normalization) {
  const repository = new MemoryCvImportRepository();
  const service = new CvImportService(repository, normalizationPort);
  return { server: appWithCvImports(service), service, repository };
}

async function importSyntheticCv(server: ReturnType<typeof createApp>): Promise<CvImportRecord> {
  const base64 = Buffer.from('<html><body>TypeScript</body></html>').toString('base64');
  const response = await request(server).post('/api/cv-imports').send({
    fileName: 'synthetic-cv.html', mimeType: 'text/html', base64, confirmed: true,
  }).expect(201);
  return response.body as CvImportRecord;
}

const cvRecognitionVersionListSchema = z.object({
  contract: z.literal('cv-recognition-version-list'),
  contractVersion: z.literal('1.0'),
  importId: z.string().uuid(),
  activeVersionId: z.string().regex(/^recognition-[a-f0-9]{16}$/),
  versions: z.array(z.object({
    id: z.string().regex(/^recognition-[a-f0-9]{16}$/),
    ordinal: z.number().int().min(1).max(20),
    kind: z.enum(['deterministic', 'ai']),
    label: z.string().min(1).max(120),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    active: z.boolean(),
    factCounts: z.object({
      total: z.number().int().min(0).max(2_000),
      pending: z.number().int().min(0).max(2_000),
      confirmed: z.number().int().min(0).max(2_000),
      rejected: z.number().int().min(0).max(2_000),
    }).strict(),
    warningCount: z.number().int().min(0).max(100),
    provider: z.object({ id: z.string().min(1).max(128), version: z.string().min(1).max(256) }).strict().optional(),
  }).strict()).min(1).max(20),
}).strict().superRefine((value, context) => {
  const active = value.versions.filter((version) => version.active);
  if (active.length !== 1 || active[0]?.id !== value.activeVersionId) {
    context.addIssue({ code: 'custom', message: 'active recognition version mismatch' });
  }
  value.versions.forEach((version, index) => {
    if (version.ordinal !== index + 1) context.addIssue({ code: 'custom', message: 'recognition ordinal mismatch' });
    const counts = version.factCounts;
    if (counts.pending + counts.confirmed + counts.rejected !== counts.total) {
      context.addIssue({ code: 'custom', message: 'recognition fact counts mismatch' });
    }
  });
});

async function seedAiRecognitionVersion(input: ReturnType<typeof recognitionApp>, imported: CvImportRecord) {
  const current = await input.service.get(imported.id);
  if (!current?.recognitionVersions?.[0] || !current.activeRecognitionVersionId) throw new Error('recognition fixture missing');
  const deterministic = current.recognitionVersions[0];
  const runId = '22222222-2222-4222-8222-222222222222';
  const proposalSha256 = 'b'.repeat(64);
  const aiFact: CvFact = {
    id: 'fact-ai-role', claimId: 'claim-ai-role', category: 'employment',
    recordId: 'record-ai-role', field: 'role', value: 'PRIVATE_AI_FACT_CANARY', decision: 'pending',
    provenance: {
      sourceSha256: current.source.sha256, anchor: 'PRIVATE_AI_ANCHOR_CANARY', origin: 'imported',
      recognition: {
        method: 'ai_assisted', runId, proposalSha256,
        suggestionId: 'suggestion-0123456789abcdef', confidence: 0.94,
        sourceSpan: { lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 8 },
      },
    },
  };
  const now = new Date().toISOString();
  const artifact = { private: 'PRIVATE_AI_ARTIFACT_CANARY', providerOutput: 'PRIVATE_PROVIDER_OUTPUT_CANARY' };
  const aiVersion: CvRecognitionVersion = {
    id: 'recognition-fedcba9876543210', ordinal: 2, kind: 'ai', label: 'KI-Erkennung 2',
    createdAt: now, updatedAt: now, facts: [aiFact], warnings: ['PRIVATE_AI_WARNING_CANARY'],
    unresolvedConflicts: [], normalizationArtifact: artifact,
    provider: {
      id: 'claude-cli', runtimeTarget: 'wsl', version: '2.1.232', adapterVersion: '1.1.0',
      witnessSha256: 'c'.repeat(64),
    },
    binding: {
      deterministicRecognitionVersionId: deterministic.id,
      sourceSha256: current.source.sha256,
      baseProposalSha256: 'd'.repeat(64), runSha256: createHash('sha256').update(runId).digest('hex'),
      proposalSha256, artifactSha256: 'e'.repeat(64),
    },
  };
  const seeded: CvImportRecord = {
    ...current, revision: current.revision + 1, sha256: '9'.repeat(64), updatedAt: now,
    status: 'facts_pending', activeRecognitionVersionId: aiVersion.id,
    facts: structuredClone(aiVersion.facts), warnings: structuredClone(aiVersion.warnings),
    unresolvedConflicts: [], normalizationArtifact: structuredClone(artifact),
    recognitionVersions: [structuredClone(deterministic), aiVersion],
    adoption: undefined, proposal: undefined,
  };
  await input.repository.compareAndSave(current.id, current.revision, current.sha256, seeded);
  const saved = await input.service.get(current.id);
  if (!saved) throw new Error('seeded recognition fixture missing');
  return saved;
}

describe('CV import API', () => {
  it('imports and lists only public, versioned machine records', async () => {
    const server = app(); const base64 = Buffer.from('<html><body>TypeScript</body></html>').toString('base64');
    const created = await request(server).post('/api/cv-imports').send({ fileName: 'cv.html', mimeType: 'text/html', base64, confirmed: true }).expect(201);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.body).toMatchObject({ contract: 'cv-import', contractVersion: '1.0', revision: 1 });
    expect(created.body).not.toHaveProperty('normalizationArtifact');
    const listed = await request(server).get('/api/cv-imports').expect(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({
      contract: 'cv-import-summary', contractVersion: '1.0', id: created.body.id,
      factCounts: { total: 1, pending: 1, confirmed: 0, rejected: 0 }, warningCount: 0,
    });
    expect(listed.body[0]).not.toHaveProperty('facts');
    expect(listed.body[0]).not.toHaveProperty('warnings');
    expect(listed.body[0]).not.toHaveProperty('normalizationArtifact');
  });

  it('lists recognition versions through the closed public schema without private facts or provider witnesses', async () => {
    const setup = recognitionApp();
    const imported = await importSyntheticCv(setup.server);
    const seeded = await seedAiRecognitionVersion(setup, imported);

    const response = await request(setup.server)
      .get(`/api/cv-imports/${imported.id}/recognition-versions`)
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const parsed = cvRecognitionVersionListSchema.parse(response.body);
    expect(parsed).toMatchObject({
      contract: 'cv-recognition-version-list', contractVersion: '1.0', importId: imported.id,
      activeVersionId: 'recognition-fedcba9876543210',
      versions: [
        { ordinal: 1, kind: 'deterministic', active: false, factCounts: { total: 1, pending: 1 } },
        {
          ordinal: 2, kind: 'ai', active: true, factCounts: { total: 1, pending: 1 },
          provider: { id: 'claude-cli', version: '2.1.232' },
        },
      ],
    });
    expect(response.body.versions[1].provider).toEqual({ id: 'claude-cli', version: '2.1.232' });
    const serialized = JSON.stringify(response.body);
    for (const privateValue of [
      'PRIVATE_AI_FACT_CANARY', 'PRIVATE_AI_ANCHOR_CANARY', 'PRIVATE_AI_ARTIFACT_CANARY',
      'PRIVATE_PROVIDER_OUTPUT_CANARY', 'PRIVATE_AI_WARNING_CANARY', 'normalizationArtifact',
      'runtimeTarget', 'adapterVersion', 'witnessSha256', 'runSha256', 'proposalSha256',
      '22222222-2222-4222-8222-222222222222',
    ]) expect(serialized).not.toContain(privateValue);
    expect(seeded.revision).toBe(2);

    await request(setup.server)
      .get('/api/cv-imports/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/recognition-versions')
      .expect(404);
  });

  it('activates an inactive recognition version with strict confirmation and exact CAS', async () => {
    const setup = recognitionApp();
    const imported = await importSyntheticCv(setup.server);
    const seeded = await seedAiRecognitionVersion(setup, imported);
    const deterministicId = seeded.recognitionVersions![0]!.id;
    const path = `/api/cv-imports/${imported.id}/recognition-versions/${deterministicId}/activate`;
    const cas = { expectedRevision: seeded.revision, expectedSha256: seeded.sha256 };

    await request(setup.server).post(path).send({ ...cas, confirmed: false }).expect(400);
    await request(setup.server).post(path).send({ ...cas, confirmed: true, unexpected: 'blocked' }).expect(400);
    await request(setup.server)
      .post(`/api/cv-imports/${imported.id}/recognition-versions/recognition-ffffffffffffffff/activate`)
      .send({ ...cas, confirmed: true }).expect(404);
    await request(setup.server)
      .post(`/api/cv-imports/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/recognition-versions/${deterministicId}/activate`)
      .send({ ...cas, confirmed: true }).expect(404);

    const activated = await request(setup.server).post(path).send({ ...cas, confirmed: true }).expect(200);
    expect(activated.headers['cache-control']).toBe('no-store');
    expect(activated.body).toMatchObject({
      id: imported.id, revision: seeded.revision + 1, activeRecognitionVersionId: deterministicId,
      status: 'facts_pending', facts: [expect.objectContaining({ id: 'fact-synthetic', decision: 'pending' })],
    });
    expect(activated.body.sha256).not.toBe(seeded.sha256);
    expect(activated.body).not.toHaveProperty('recognitionVersions');
    expect(JSON.stringify(activated.body)).not.toContain('PRIVATE_AI_FACT_CANARY');

    await request(setup.server)
      .post(`/api/cv-imports/${imported.id}/recognition-versions/recognition-fedcba9876543210/activate`)
      .send({ ...cas, confirmed: true }).expect(409);
    const listed = await request(setup.server).get(`/api/cv-imports/${imported.id}/recognition-versions`).expect(200);
    expect(listed.body.activeVersionId).toBe(deterministicId);
    expect(listed.body.versions.map((version: { active: boolean }) => version.active)).toEqual([true, false]);
  });

  it('confirms only the active recognition version in one strict CAS mutation without adopting facts', async () => {
    const setup = recognitionApp();
    const imported = await importSyntheticCv(setup.server);
    const seeded = await seedAiRecognitionVersion(setup, imported);
    const activeId = seeded.activeRecognitionVersionId!;
    const inactiveId = seeded.recognitionVersions![0]!.id;
    const cas = { expectedRevision: seeded.revision, expectedSha256: seeded.sha256 };

    await request(setup.server)
      .post(`/api/cv-imports/${imported.id}/recognition-versions/${inactiveId}/confirm`)
      .send({ ...cas, confirmed: true }).expect(409);
    await request(setup.server)
      .post(`/api/cv-imports/${imported.id}/recognition-versions/recognition-ffffffffffffffff/confirm`)
      .send({ ...cas, confirmed: true }).expect(404);
    await request(setup.server)
      .post(`/api/cv-imports/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/recognition-versions/${activeId}/confirm`)
      .send({ ...cas, confirmed: true }).expect(404);
    const path = `/api/cv-imports/${imported.id}/recognition-versions/${activeId}/confirm`;
    await request(setup.server).post(path).send({ ...cas, confirmed: false }).expect(400);
    await request(setup.server).post(path).send({ ...cas, confirmed: true, unexpected: 'blocked' }).expect(400);

    const confirmed = await request(setup.server).post(path).send({ ...cas, confirmed: true }).expect(200);
    expect(confirmed.headers['cache-control']).toBe('no-store');
    expect(confirmed.body).toMatchObject({
      id: imported.id, revision: seeded.revision + 1, status: 'facts_reviewed',
      activeRecognitionVersionId: activeId,
      facts: [expect.objectContaining({ id: 'fact-ai-role', decision: 'confirmed' })],
    });
    expect(confirmed.body).not.toHaveProperty('adoption');
    expect(confirmed.body).not.toHaveProperty('recognitionVersions');
    await request(setup.server).post(path).send({ ...cas, confirmed: true }).expect(409);

    const listed = await request(setup.server).get(`/api/cv-imports/${imported.id}/recognition-versions`).expect(200);
    expect(listed.body.versions[1]).toMatchObject({
      id: activeId, active: true,
      factCounts: { total: 1, pending: 0, confirmed: 1, rejected: 0 },
    });
    expect(listed.body.versions[0]).toMatchObject({
      id: inactiveId, active: false,
      factCounts: { total: 1, pending: 1, confirmed: 0, rejected: 0 },
    });
  });

  it('blocks recognition mutations after adoption and bulk confirmation when conflicts remain', async () => {
    const adoptedSetup = recognitionApp();
    const imported = await importSyntheticCv(adoptedSetup.server);
    const importedInternal = await adoptedSetup.service.get(imported.id);
    const versionId = importedInternal!.activeRecognitionVersionId!;
    const confirmed = await request(adoptedSetup.server)
      .post(`/api/cv-imports/${imported.id}/recognition-versions/${versionId}/confirm`)
      .send({ expectedRevision: imported.revision, expectedSha256: imported.sha256, confirmed: true })
      .expect(200);
    const adopted = await request(adoptedSetup.server).post(`/api/cv-imports/${imported.id}/adopt`).send({
      expectedRevision: confirmed.body.revision, expectedSha256: confirmed.body.sha256, confirmed: true,
    }).expect(200);
    expect(adopted.body.status).toBe('adopted');
    for (const action of ['activate', 'confirm']) {
      await request(adoptedSetup.server)
        .post(`/api/cv-imports/${imported.id}/recognition-versions/${versionId}/${action}`)
        .send({ expectedRevision: adopted.body.revision, expectedSha256: adopted.body.sha256, confirmed: true })
        .expect(409);
    }

    const conflictNormalization: CvNormalizationPort = {
      ...normalization,
      async normalize(envelope) {
        const result = await normalization.normalize(envelope);
        return {
          ...result,
          conflicts: [{ id: 'conflict-0123456789abcdef', code: 'ambiguous-period', detail: 'Synthetic ambiguity' }],
        };
      },
    };
    const conflictSetup = recognitionApp(conflictNormalization);
    const conflicted = await importSyntheticCv(conflictSetup.server);
    const conflictedInternal = await conflictSetup.service.get(conflicted.id);
    const conflictedVersionId = conflictedInternal!.activeRecognitionVersionId!;
    await request(conflictSetup.server)
      .post(`/api/cv-imports/${conflicted.id}/recognition-versions/${conflictedVersionId}/confirm`)
      .send({ expectedRevision: conflicted.revision, expectedSha256: conflicted.sha256, confirmed: true })
      .expect(409);
    const unchanged = await request(conflictSetup.server).get(`/api/cv-imports/${conflicted.id}`).expect(200);
    expect(unchanged.body).toMatchObject({ revision: conflicted.revision, sha256: conflicted.sha256, status: 'facts_pending' });
  });

  it('rejects non-canonical Base64 and deletes only with exact typed confirmation', async () => {
    const deleteForImport = vi.fn(async () => [] as string[]);
    const cvAiStructuring = { deleteForImport } as unknown as CvAiStructuringService;
    const server = app(normalization, undefined, cvAiStructuring);
    await request(server).post('/api/cv-imports').send({ fileName: 'cv.html', mimeType: 'text/html', base64: 'Zh==', confirmed: true }).expect(400);
    const base64 = Buffer.from('<html><body>TypeScript</body></html>').toString('base64');
    const created = await request(server).post('/api/cv-imports').send({ fileName: 'cv.html', mimeType: 'text/html', base64, confirmed: true }).expect(201);
    await request(server).delete(`/api/cv-imports/${created.body.id}`).send({ confirmation: 'DELETE cv-import wrong', expectedRevision: created.body.revision, expectedSha256: created.body.sha256 }).expect(400);
    await request(server).delete(`/api/cv-imports/${created.body.id}`).send({ confirmation: `DELETE cv-import ${created.body.id}`, expectedRevision: created.body.revision, expectedSha256: '0'.repeat(64) }).expect(409);
    expect(deleteForImport).not.toHaveBeenCalled();
    const deleted = await request(server).delete(`/api/cv-imports/${created.body.id}`).send({ confirmation: `DELETE cv-import ${created.body.id}`, expectedRevision: created.body.revision, expectedSha256: created.body.sha256 }).expect(200);
    expect(deleted.headers['cache-control']).toBe('no-store');
    expect(deleteForImport).toHaveBeenCalledOnce();
    expect(deleteForImport).toHaveBeenCalledWith(created.body.id);
    await request(server).get(`/api/cv-imports/${created.body.id}`).expect(404);
  });

  it('keeps the import when the confirmed CV-AI deletion cascade fails', async () => {
    const deleteForImport = vi.fn(async () => {
      throw Object.assign(new Error('synthetic purge failure'), { statusCode: 503 });
    });
    const server = app(normalization, undefined, { deleteForImport } as unknown as CvAiStructuringService);
    const base64 = Buffer.from('<html><body>TypeScript</body></html>').toString('base64');
    const created = await request(server).post('/api/cv-imports').send({
      fileName: 'cv.html', mimeType: 'text/html', base64, confirmed: true,
    }).expect(201);

    await request(server).delete(`/api/cv-imports/${created.body.id}`).send({
      confirmation: `DELETE cv-import ${created.body.id}`,
      expectedRevision: created.body.revision,
      expectedSha256: created.body.sha256,
    }).expect(503);
    expect(deleteForImport).toHaveBeenCalledWith(created.body.id);
    await request(server).get(`/api/cv-imports/${created.body.id}`).expect(200);
  });

  it('returns a correlated, data-minimized 422 for a known normalization rejection', async () => {
    const audit = new MemoryAuditLogger();
    const rejectingNormalization: CvNormalizationPort = {
      ...normalization,
      async normalize() {
        throw classifyCvContractRejection('normalize-extracted', {
          status: 'rejected', error: {
            code: 'normalization_failed',
            safe_detail: 'CANARY_PRIVATE_CONTENT C:/private/resume.html token=secret',
          },
        });
      },
    };
    const base64 = Buffer.from(
      '<!doctype html><html><body><h2>Skills</h2><p>TypeScript, TypeScript</p></body></html>',
    ).toString('base64');
    const response = await request(app(rejectingNormalization, audit))
      .post('/api/cv-imports')
      .set('x-correlation-id', 'cv-import-contract-422')
      .send({ fileName: 'private-resume-name.html', mimeType: 'text/html', base64, confirmed: true })
      .expect(422);
    expect(response.headers['x-correlation-id']).toBe('cv-import-contract-422');
    expect(response.body).toMatchObject({
      status: 422, category: 'validation', errorCode: 'normalization_failed',
      stage: 'cv_import_normalization', retryable: false, correlationId: 'cv-import-contract-422',
    });
    const serialized = JSON.stringify(response.body);
    for (const privateValue of [
      'CANARY_PRIVATE_CONTENT', 'private/resume.html', 'token=secret', 'private-resume-name.html', base64,
    ]) expect(serialized).not.toContain(privateValue);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(audit.events).toContainEqual(expect.objectContaining({
      correlationId: 'cv-import-contract-422', status: 422, category: 'cv_import_normalization',
    }));
    expect(JSON.stringify(audit.events)).not.toContain('CANARY_PRIVATE_CONTENT');
    expect(JSON.stringify(audit.events)).not.toContain('private-resume-name.html');
  });

  it('keeps an unknown CV contract rejection a redacted retryable dependency failure', async () => {
    const rejectingNormalization: CvNormalizationPort = {
      ...normalization,
      async normalize() {
        throw classifyCvContractRejection('normalize-extracted', {
          status: 'rejected', error: {
            code: 'private_C:/resume.html', safe_detail: 'CANARY_PRIVATE_CONTENT token=secret',
          },
        });
      },
    };
    const base64 = Buffer.from(
      '<!doctype html><html><body><p>Synthetic CV</p></body></html>',
    ).toString('base64');
    const response = await request(app(rejectingNormalization))
      .post('/api/cv-imports')
      .send({ fileName: 'synthetic.html', mimeType: 'text/html', base64, confirmed: true })
      .expect(503);
    expect(response.body).toMatchObject({
      status: 503, category: 'retryable_dependency', errorCode: 'cv_skill_protocol_error',
      stage: 'cv_skill_contract', retryable: true,
    });
    expect(JSON.stringify(response.body)).not.toContain('CANARY_PRIVATE_CONTENT');
    expect(JSON.stringify(response.body)).not.toContain('resume.html');
  });
});
