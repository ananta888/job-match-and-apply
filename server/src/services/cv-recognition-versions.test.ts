import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SubmoduleCvNormalizationAdapter } from '../adapters/submodule-cv-normalization.js';
import type {
  CvFact, CvNormalizationConflict, CvNormalizationEnvelope, CvNormalizationPort,
} from '../ports/cv-normalization.js';
import {
  CvImportService, JsonCvImportRepository, MemoryCvImportRepository,
  publicCvImportRecord, type CreateAiRecognitionVersionInput,
} from './cv-imports.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
};

const sourceText = 'Original Engineer Example GmbH';
const sourceId = (sha256: string) => `source-cv-${sha256.slice(0, 16)}`;
const importedFact = (
  sourceSha256: string,
  input: Pick<CvFact, 'id' | 'claimId' | 'category' | 'recordId' | 'field' | 'value'>,
): CvFact => ({
  ...input, decision: 'pending',
  provenance: { sourceSha256, anchor: 'line:1', origin: 'imported' },
});

const baseFacts = (sourceSha256: string): CvFact[] => [
  importedFact(sourceSha256, {
    id: 'fact-old-role', claimId: 'claim-old-role', category: 'employment',
    recordId: 'record-old-role', field: 'role', value: 'Original Engineer',
  }),
  importedFact(sourceSha256, {
    id: 'fact-profile-name', claimId: 'claim-profile-name', category: 'profile',
    recordId: 'record-profile', field: 'name', value: 'Synthetic Candidate',
  }),
  importedFact(sourceSha256, {
    id: 'fact-cert-name', claimId: 'claim-cert-name', category: 'certification',
    recordId: 'record-cert', field: 'name', value: 'Synthetic Certificate',
  }),
];

function proposalArtifact(
  facts: CvFact[],
  sourceSha256: string,
  aiAudit?: { baseProposalSha256: string; suggestionIds: string[] },
) {
  const primarySource = {
    id: sourceId(sourceSha256), type: 'cv_import', media_type: 'text/html',
    sha256: sourceSha256, byte_size: Buffer.byteLength(sourceText),
  };
  const records = (category: CvFact['category']) => [...new Set(facts
    .filter((fact) => fact.category === category).map((fact) => fact.recordId))]
    .map((id) => ({ id, status: 'unverified' }));
  return {
    contract: 'cv-import-proposal', contract_version: '1.0', private_canary: 'PRIVATE-RECOGNITION-CANARY-7B31',
    source: primarySource, sources: [structuredClone(primarySource)],
    extraction: {
      text_sha256: digest(sourceText), line_count: 1,
      line_manifest: [{ line: 1, text: sourceText, sha256: digest(sourceText) }],
      warnings: [], conflicts: [],
      ...(aiAudit ? { ai_structuring: [{
        contract: 'validated-ai-cv-structure-proposal', contract_version: '1.0', status: 'unverified',
        mode: 'replace_recognition_version',
        binding: {
          source_id: sourceId(sourceSha256), source_sha256: sourceSha256,
          text_sha256: digest(sourceText), base_proposal_sha256: aiAudit.baseProposalSha256,
        },
        applied_suggestion_ids: [...aiAudit.suggestionIds].sort(),
      }] } : {}),
    },
    proposal: {
      profile: { fact_ids: facts.filter((fact) => fact.category === 'profile').map((fact) => fact.id) },
      facts: facts.map((fact) => ({
        id: fact.id, claim_id: fact.claimId, category: fact.category,
        record_id: fact.recordId, field: fact.field, value: fact.value, status: 'unverified',
        source_anchor: fact.provenance.recognition?.method === 'ai_assisted' ? {
          origin: 'ai_structuring', recognition_method: 'ai_assisted', source_id: sourceId(sourceSha256),
          source_sha256: sourceSha256,
          line_start: fact.provenance.recognition.sourceSpan!.lineStart,
          line_end: fact.provenance.recognition.sourceSpan!.lineEnd,
          char_start: fact.provenance.recognition.sourceSpan!.charStart,
          char_end: fact.provenance.recognition.sourceSpan!.charEnd,
          quote: 'Original', suggestion_id: fact.provenance.recognition.suggestionId,
          alternative_id: fact.provenance.recognition.selectedAlternativeId ?? null,
        } : { source_sha256: sourceSha256, line_start: 1 },
        ...(fact.provenance.recognition?.method === 'ai_assisted' ? { proposal_metadata: {
          confidence: fact.provenance.recognition.confidence,
          questions: fact.provenance.recognition.questions ?? [],
          suggestion_id: fact.provenance.recognition.suggestionId,
          selected_alternative_id: fact.provenance.recognition.selectedAlternativeId ?? null,
        } } : {}),
      })),
      claims: facts.map((fact) => ({ id: fact.claimId, fact_id: fact.id, status: 'unverified' })),
      experience: records('employment'), education: records('education'), projects: records('project'),
      certifications: records('certification'), skills: records('skill'), languages: records('language'),
      additional_facts: records('additional'),
    },
  };
}

class RecognitionNormalization implements CvNormalizationPort {
  constructor(
    private readonly conflicts: CvNormalizationConflict[] = [],
    private readonly includeUnreferencedSource = false,
  ) {}
  async normalize(envelope: CvNormalizationEnvelope) {
    const facts = baseFacts(envelope.source.sha256);
    const artifact = proposalArtifact(facts, envelope.source.sha256);
    if (this.includeUnreferencedSource) artifact.sources.push({
      id: 'source-user-0123456789abcdef', type: 'user_input', media_type: 'text/plain',
      sha256: digest('unreferenced synthetic source'), byte_size: 29,
    });
    return {
      facts, warnings: ['synthetic warning'], conflicts: structuredClone(this.conflicts),
      artifact,
    };
  }
  async validateUserFacts() {}
  async adopt(input: Parameters<CvNormalizationPort['adopt']>[0]) {
    const confirmed = input.facts.filter((fact) => fact.decision === 'confirmed');
    return {
      contract: 'cv-profile-adoption' as const, contractVersion: '1.0' as const,
      adoptedClaimIds: confirmed.map((fact) => fact.claimId!),
      adoptedRecordIds: [...new Set(confirmed.map((fact) => fact.recordId))],
      candidateProfileSha256: 'a'.repeat(64), candidateProfileRevision: `sha256:${'a'.repeat(64)}`,
      transactionId: 'c'.repeat(32),
    };
  }
  async adoptionLedger() {
    return { candidateProfileSha256: 'a'.repeat(64), adoptions: [] };
  }
  async revokeAdoption(input: { transactionId: string }) {
    return {
      contract: 'cv-profile-adoption-revocation' as const, contractVersion: '1.0' as const,
      revokedTransactionId: input.transactionId, revokedClaimIds: [], revokedRecordIds: [],
      candidateProfileSha256: 'd'.repeat(64), candidateProfileRevision: `sha256:${'d'.repeat(64)}`,
    };
  }
  async profileSnapshots() {
    return { candidateProfileSha256: 'a'.repeat(64), snapshots: [] };
  }
  async restoreProfileSnapshot(input: { snapshotId: string }) {
    return {
      contract: 'cv-profile-snapshot-restore' as const, contractVersion: '1.0' as const,
      snapshotId: input.snapshotId,
      candidateProfileSha256: 'e'.repeat(64), candidateProfileRevision: `sha256:${'e'.repeat(64)}`,
    };
  }
}

async function fixture(
  conflicts: CvNormalizationConflict[] = [],
  repository = new MemoryCvImportRepository(),
  includeUnreferencedSource = false,
) {
  const normalization = new RecognitionNormalization(conflicts, includeUnreferencedSource);
  const service = new CvImportService(repository, normalization);
  const record = await service.import({
    fileName: 'synthetic.html', mimeType: 'text/html',
    data: Buffer.from(`<html><body>${sourceText}</body></html>`),
  });
  return { service, normalization, record };
}

async function aiInput(
  service: CvImportService,
  record: Awaited<ReturnType<CvImportService['get']>> & {},
  ordinal = 1,
  role = `AI Structured Role ${ordinal}`,
): Promise<CreateAiRecognitionVersionInput> {
  const source = (await service.loadAiSource(record.id))!;
  const suggestionId = `suggestion-${ordinal.toString(16).padStart(16, '0')}`;
  const runId = `22222222-2222-4222-8222-${ordinal.toString().padStart(12, '0')}`;
  const proposalSha256 = digest(`proposal-${ordinal}`);
  const preserved = baseFacts(record.source.sha256).filter((fact) => ['profile', 'certification'].includes(fact.category));
  const aiFact: CvFact = {
    id: `fact-ai-role-${ordinal}`, claimId: `claim-ai-role-${ordinal}`, category: 'employment',
    recordId: `record-ai-role-${ordinal}`, field: 'role', value: role, decision: 'pending',
    provenance: {
      sourceSha256: record.source.sha256, anchor: `ai:${suggestionId}`, origin: 'imported',
      recognition: {
        method: 'ai_assisted', suggestionId, confidence: 0.94,
        sourceSpan: { lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 8 },
      },
    },
  };
  const facts = [...preserved, aiFact];
  const artifact = proposalArtifact(facts, record.source.sha256, {
    baseProposalSha256: source.baseProposalSha256, suggestionIds: [suggestionId],
  });
  return {
    id: record.id, expectedRevision: record.revision, expectedSha256: record.sha256,
    label: `KI-Erkennung ${ordinal}`, facts, warnings: ['synthetic warning'], unresolvedConflicts: [],
    normalizationArtifact: artifact,
    source: {
      deterministicRecognitionVersionId: source.deterministicRecognitionVersionId,
      sourceSha256: record.source.sha256, baseProposalSha256: source.baseProposalSha256,
    },
    provenance: {
      runId, proposalSha256, artifactSha256: digest(canonical(artifact)),
      selections: [{ suggestionId, alternativeId: null }],
    },
    provider: {
      id: 'claude-cli', runtimeTarget: 'wsl', version: '2.1.232', adapterVersion: '1.1.0',
      witnessSha256: digest('provider-witness'),
    },
  };
}

describe('CV recognition versions', () => {
  it('creates a deterministic version and atomically replaces it with a redacted, idempotent AI version', async () => {
    const { service, record } = await fixture();
    expect(record.recognitionVersions).toHaveLength(1);
    expect(record.recognitionVersions![0]).toMatchObject({
      id: expect.stringMatching(/^recognition-[a-f0-9]{16}$/), ordinal: 1,
      kind: 'deterministic', facts: expect.arrayContaining([expect.objectContaining({ id: 'fact-old-role' })]),
    });
    expect(record.activeRecognitionVersionId).toBe(record.recognitionVersions![0]!.id);
    const baseBefore = (await service.loadAiSource(record.id))!;
    const input = await aiInput(service, record);
    const created = await service.createAiRecognitionVersion(input);
    expect(created).toMatchObject({
      revision: 2, recognitionVersionCount: 2,
      recognitionVersionId: expect.stringMatching(/^recognition-[a-f0-9]{16}$/),
      factIds: ['fact-profile-name', 'fact-cert-name', 'fact-ai-role-1'],
    });
    const saved = (await service.get(record.id))!;
    expect(saved.activeRecognitionVersionId).toBe(created.recognitionVersionId);
    expect(saved.facts.map((fact) => fact.id)).toEqual(created.factIds);
    expect(saved.facts.some((fact) => fact.id === 'fact-old-role')).toBe(false);
    expect(saved.recognitionVersions![0]!.facts.some((fact) => fact.id === 'fact-old-role')).toBe(true);

    const baseAfter = (await service.loadAiSource(record.id))!;
    expect(baseAfter.deterministicRecognitionVersionId).toBe(baseBefore.deterministicRecognitionVersionId);
    expect(baseAfter.baseProposalSha256).toBe(baseBefore.baseProposalSha256);
    expect(baseAfter.lineManifestJson).toBe(baseBefore.lineManifestJson);

    const replay = await service.createAiRecognitionVersion(input);
    expect(replay).toEqual(created);
    expect((await service.recognitionVersions(record.id)).versions).toHaveLength(2);
    const divergent = await aiInput(service, {
      ...record, revision: saved.revision, sha256: saved.sha256,
    }, 1, 'Divergent Role');
    await expect(service.createAiRecognitionVersion(divergent)).rejects.toMatchObject({ statusCode: 503 });

    const summary = await service.recognitionVersions(record.id);
    expect(summary).toMatchObject({
      contract: 'cv-recognition-version-list', contractVersion: '1.0',
      importId: record.id, activeVersionId: created.recognitionVersionId,
      versions: [
        { ordinal: 1, kind: 'deterministic', active: false, factCounts: { total: 3 } },
        { ordinal: 2, kind: 'ai', active: true, factCounts: { total: 3 }, provider: {
          id: 'claude-cli', version: '2.1.232',
        } },
      ],
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('PRIVATE-RECOGNITION-CANARY-7B31');
    expect(serialized).not.toContain('AI Structured Role');
    expect(serialized).not.toContain(input.provenance.runId);
    expect(serialized).not.toContain(input.provenance.proposalSha256);
    expect(serialized).not.toContain('witnessSha256');
    expect(serialized).not.toContain('runtimeTarget');
    expect(serialized).not.toContain('adapterVersion');
    expect(serialized).not.toContain('normalizationArtifact');
    expect(publicCvImportRecord(saved)).not.toHaveProperty('recognitionVersions');
  });

  it('switches back and forth with isolated per-version edits and strict CAS', async () => {
    const { service, record } = await fixture();
    const created = await service.createAiRecognitionVersion(await aiInput(service, record));
    const ai = (await service.get(record.id))!;
    const reviewedAi = await service.review(ai.id, ai.revision, ai.sha256, [
      { factId: 'fact-ai-role-1', action: 'confirm' },
    ]);
    const deterministicId = record.activeRecognitionVersionId!;
    await expect(service.activateRecognitionVersion(
      record.id, ai.revision, ai.sha256, deterministicId, true,
    )).rejects.toMatchObject({ statusCode: 409 });
    const deterministic = await service.activateRecognitionVersion(
      record.id, reviewedAi.revision, reviewedAi.sha256, deterministicId, true,
    );
    expect(deterministic.facts.some((fact) => fact.id === 'fact-ai-role-1')).toBe(false);
    const reviewedDeterministic = await service.review(
      deterministic.id, deterministic.revision, deterministic.sha256,
      [{ factId: 'fact-old-role', action: 'confirm' }],
    );
    const restoredAi = await service.activateRecognitionVersion(
      record.id, reviewedDeterministic.revision, reviewedDeterministic.sha256,
      created.recognitionVersionId, true,
    );
    expect(restoredAi.facts.find((fact) => fact.id === 'fact-ai-role-1')?.decision).toBe('confirmed');
    const restoredDeterministic = await service.activateRecognitionVersion(
      record.id, restoredAi.revision, restoredAi.sha256, deterministicId, true,
    );
    expect(restoredDeterministic.facts.find((fact) => fact.id === 'fact-old-role')?.decision).toBe('confirmed');
  });

  it('accepts only an unchanged ordered subset of sources and preserves profile and certifications exactly', async () => {
    const reduced = await fixture([], new MemoryCvImportRepository(), true);
    const reducedInput = await aiInput(reduced.service, reduced.record);
    const created = await reduced.service.createAiRecognitionVersion(reducedInput);
    expect(created.recognitionVersionCount).toBe(2);
    const saved = (await reduced.service.get(reduced.record.id))!;
    const deterministicSources = (saved.recognitionVersions![0]!.normalizationArtifact as { sources: unknown[] }).sources;
    const aiSources = (saved.recognitionVersions![1]!.normalizationArtifact as { sources: unknown[] }).sources;
    expect(deterministicSources).toHaveLength(2);
    expect(aiSources).toHaveLength(1);

    const changedProfile = await fixture();
    const profileInput = await aiInput(changedProfile.service, changedProfile.record);
    const profileProposal = ((profileInput.normalizationArtifact as Record<string, unknown>)
      .proposal as Record<string, unknown>);
    profileProposal.profile = { facts: ['fact-profile-name', 'fact-injected-profile'] };
    profileInput.provenance.artifactSha256 = digest(canonical(profileInput.normalizationArtifact));
    await expect(changedProfile.service.createAiRecognitionVersion(profileInput))
      .rejects.toMatchObject({ statusCode: 503 });

    const changedCertification = await fixture();
    const certificationInput = await aiInput(changedCertification.service, changedCertification.record);
    const certificationProposal = ((certificationInput.normalizationArtifact as Record<string, unknown>)
      .proposal as Record<string, unknown>);
    certificationProposal.certifications = [{ id: 'record-cert', status: 'unverified', injected: true }];
    certificationInput.provenance.artifactSha256 = digest(canonical(certificationInput.normalizationArtifact));
    await expect(changedCertification.service.createAiRecognitionVersion(certificationInput))
      .rejects.toMatchObject({ statusCode: 503 });

    const changedPreservedFact = await fixture();
    const preservedFactInput = await aiInput(changedPreservedFact.service, changedPreservedFact.record);
    const preserved = preservedFactInput.facts.find((fact) => fact.id === 'fact-profile-name')!;
    preserved.value = 'Injected Candidate';
    const preservedProposal = ((preservedFactInput.normalizationArtifact as Record<string, unknown>)
      .proposal as { facts: Array<Record<string, unknown>> });
    preservedProposal.facts.find((fact) => fact.id === preserved.id)!.value = preserved.value;
    preservedFactInput.provenance.artifactSha256 = digest(canonical(preservedFactInput.normalizationArtifact));
    await expect(changedPreservedFact.service.createAiRecognitionVersion(preservedFactInput))
      .rejects.toMatchObject({ statusCode: 503 });
  });

  it('accepts the complete replacement artifact emitted by the real local materializer', async () => {
    const repositoryRoot = resolve(process.cwd(), '..');
    const adapter = new SubmoduleCvNormalizationAdapter(
      resolve(repositoryRoot, 'integrations', 'bewerbungs-schreib-assistent'),
      resolve(repositoryRoot, '.local-data', 'profiles', 'candidate-profile.yaml'),
      resolve(repositoryRoot, '.local-data', 'profiles', 'style-profile.yaml'),
    );
    const service = new CvImportService(new MemoryCvImportRepository(), adapter);
    const record = await service.import({
      fileName: 'synthetic-materializer.html', mimeType: 'text/html',
      data: Buffer.from([
        '<h1>Konflikt-Testprofil</h1>', '<a href="https://example.invalid/portfolio">Portfolio</a>',
        '<h2>Berufserfahrung</h2>',
        '<p>01/2020 - 12/2021: Entwickler | Beispiel GmbH | Berlin</p>',
        '<p>01/2020 - 12/2021: Lead Entwickler | Beispiel GmbH | Berlin</p>',
      ].join('')),
    });
    expect(record.unresolvedConflicts).toEqual([
      expect.objectContaining({ code: 'ambiguous_employment_role' }),
    ]);
    const source = (await service.loadAiSource(record.id))!;
    const artifact = source.baseProposalArtifact as Record<string, unknown>;
    const artifactSource = artifact.source as { id: string; sha256: string };
    const extraction = artifact.extraction as {
      text_sha256: string;
      line_manifest: Array<{ line: number; text: string }>;
    };
    const anchored = (value: string) => {
      const line = extraction.line_manifest.find((item) => item.text.includes(value));
      expect(line).toBeDefined();
      const start = line!.text.indexOf(value);
      return {
        value,
        source_anchor: {
          line_start: line!.line, line_end: line!.line,
          char_start: start, char_end: start + value.length, quote: value,
        },
        confidence: 0.9, alternatives: [], questions: [], status: 'unverified',
      };
    };
    const providerProposal = {
      contract: 'ai-cv-structure-proposal', contract_version: '1.0', status: 'unverified',
      binding: {
        source_id: artifactSource.id, source_sha256: artifactSource.sha256,
        text_sha256: extraction.text_sha256, base_proposal_sha256: source.baseProposalSha256,
      },
      sections: [{ kind: 'employment', heading: anchored('Berufserfahrung'), status: 'unverified' }],
      employment: [{
        employer: anchored('Beispiel GmbH'), role: anchored('Lead Entwickler'),
        start_date: anchored('01/2020'), end_date: anchored('12/2021'),
        location: anchored('Berlin'), details: [], status: 'unverified',
      }],
      education: [], projects: [], skills: [], languages: [],
    };
    const validated = await adapter.validateProposal({
      baseProposalArtifact: artifact,
      expectedBaseProposalSha256: source.baseProposalSha256,
      aiProposal: providerProposal,
    });
    const materialized = await adapter.materializeRecognitionVersion({
      baseProposalArtifact: artifact,
      expectedBaseProposalSha256: source.baseProposalSha256,
      aiProposalArtifact: validated.privateArtifact,
      expectedAiProposalSha256: validated.proposalSha256,
    });
    const created = await service.createAiRecognitionVersion({
      id: record.id, expectedRevision: record.revision, expectedSha256: record.sha256,
      facts: materialized.facts, warnings: materialized.warnings,
      unresolvedConflicts: materialized.unresolvedConflicts,
      normalizationArtifact: materialized.materializedArtifact,
      source: {
        deterministicRecognitionVersionId: source.deterministicRecognitionVersionId,
        sourceSha256: source.sourceSha256, baseProposalSha256: source.baseProposalSha256,
      },
      provenance: {
        runId: '77777777-7777-4777-8777-777777777777',
        proposalSha256: validated.proposalSha256,
        artifactSha256: materialized.materializedProposalSha256,
        selections: materialized.appliedSuggestionIds.map((suggestionId) => ({ suggestionId, alternativeId: null })),
      },
    });
    expect(created).toMatchObject({ revision: 2, recognitionVersionCount: 2 });
    const active = (await service.get(record.id))!;
    expect(active.activeRecognitionVersionId).toBe(created.recognitionVersionId);
    expect(active.unresolvedConflicts).toEqual([]);
    expect(active.facts.some((fact) => fact.provenance.recognition?.method === 'ai_assisted')).toBe(true);
    expect(active.facts.every((fact) => fact.decision === 'pending')).toBe(true);
    const confirmed = await service.confirmActiveRecognitionVersion(
      active.id, active.revision, active.sha256, created.recognitionVersionId, true,
    );
    expect(confirmed.status).toBe('facts_reviewed');
    expect(confirmed.adoption).toBeUndefined();
  });

  it('bulk-confirms only the active version in one CAS mutation without adopting it', async () => {
    const { service, record } = await fixture();
    const deterministicId = record.activeRecognitionVersionId!;
    const deterministic = await service.confirmActiveRecognitionVersion(
      record.id, record.revision, record.sha256, deterministicId, true,
    );
    expect(deterministic).toMatchObject({ revision: record.revision + 1, status: 'facts_reviewed' });
    expect(deterministic.facts.every((fact) => fact.decision === 'confirmed')).toBe(true);
    expect(deterministic.adoption).toBeUndefined();

    const created = await service.createAiRecognitionVersion(await aiInput(service, deterministic));
    const ai = (await service.get(record.id))!;
    const withRejection = await service.review(ai.id, ai.revision, ai.sha256, [
      { factId: 'fact-cert-name', action: 'reject' },
    ]);
    await expect(service.confirmActiveRecognitionVersion(
      record.id, withRejection.revision, withRejection.sha256, deterministicId, true,
    )).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.confirmActiveRecognitionVersion(
      record.id, ai.revision, ai.sha256, created.recognitionVersionId, true,
    )).rejects.toMatchObject({ statusCode: 409 });
    const confirmed = await service.confirmActiveRecognitionVersion(
      record.id, withRejection.revision, withRejection.sha256, created.recognitionVersionId, true,
    );
    expect(confirmed.revision).toBe(withRejection.revision + 1);
    expect(confirmed.status).toBe('facts_reviewed');
    expect(confirmed.facts.find((fact) => fact.id === 'fact-cert-name')?.decision).toBe('rejected');
    expect(confirmed.facts.filter((fact) => fact.id !== 'fact-cert-name').every((fact) => fact.decision === 'confirmed')).toBe(true);
    expect(confirmed.adoption).toBeUndefined();
    expect(confirmed.recognitionVersions!.find((version) => version.id === deterministicId)!
      .facts.every((fact) => fact.decision === 'confirmed')).toBe(true);
  });

  it('blocks bulk confirmation with conflicts and blocks version changes after adoption', async () => {
    const conflictItem = { id: 'conflict-0123456789abcdef', code: 'ambiguous_period', detail: 'Synthetic ambiguity' };
    const conflicted = await fixture([conflictItem]);
    await expect(conflicted.service.confirmActiveRecognitionVersion(
      conflicted.record.id, conflicted.record.revision, conflicted.record.sha256,
      conflicted.record.activeRecognitionVersionId!, true,
    )).rejects.toMatchObject({ statusCode: 409 });

    const clean = await fixture();
    const sourceBeforeAdoption = await aiInput(clean.service, clean.record);
    const confirmed = await clean.service.confirmActiveRecognitionVersion(
      clean.record.id, clean.record.revision, clean.record.sha256,
      clean.record.activeRecognitionVersionId!, true,
    );
    const adopted = await clean.service.adopt(confirmed.id, confirmed.revision, confirmed.sha256);
    await expect(clean.service.activateRecognitionVersion(
      adopted.id, adopted.revision, adopted.sha256, adopted.activeRecognitionVersionId!, true,
    )).rejects.toMatchObject({ statusCode: 409 });
    await expect(clean.service.createAiRecognitionVersion({
      ...sourceBeforeAdoption, expectedRevision: adopted.revision, expectedSha256: adopted.sha256,
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('drops deterministic structure conflicts from a conflict-free AI replacement before bulk confirmation', async () => {
    const conflictItem = {
      id: 'conflict-0123456789abcdef',
      code: 'ambiguous_employment_role',
      detail: 'Synthetic deterministic ambiguity',
    };
    const { service, record } = await fixture([conflictItem]);
    const created = await service.createAiRecognitionVersion(await aiInput(service, record));
    const ai = (await service.get(record.id))!;

    expect(ai.activeRecognitionVersionId).toBe(created.recognitionVersionId);
    expect(ai.unresolvedConflicts).toEqual([]);

    const confirmed = await service.confirmActiveRecognitionVersion(
      ai.id, ai.revision, ai.sha256, created.recognitionVersionId, true,
    );
    expect(confirmed.status).toBe('facts_reviewed');
    expect(confirmed.facts.every((fact) => fact.decision === 'confirmed')).toBe(true);
    expect(confirmed.adoption).toBeUndefined();
  });

  it('fails closed for an AI materialization without AI facts and caps recognition history at twenty versions', async () => {
    const empty = await fixture();
    const emptyInput = await aiInput(empty.service, empty.record);
    emptyInput.facts = emptyInput.facts.filter((fact) => fact.provenance.recognition?.method !== 'ai_assisted');
    await expect(empty.service.createAiRecognitionVersion(emptyInput)).rejects.toMatchObject({ statusCode: 503 });
    const unchanged = (await empty.service.get(empty.record.id))!;
    expect(unchanged.revision).toBe(empty.record.revision);
    expect(unchanged.activeRecognitionVersionId).toBe(empty.record.activeRecognitionVersionId);
    expect(unchanged.recognitionVersions).toHaveLength(1);

    const capped = await fixture();
    let current = capped.record;
    for (let ordinal = 1; ordinal <= 19; ordinal += 1) {
      await capped.service.createAiRecognitionVersion(await aiInput(capped.service, current, ordinal));
      current = (await capped.service.get(current.id))!;
    }
    expect(current.recognitionVersions).toHaveLength(20);
    await expect(capped.service.createAiRecognitionVersion(
      await aiInput(capped.service, current, 20),
    )).rejects.toMatchObject({ statusCode: 409 });
    expect((await capped.service.get(current.id))!.recognitionVersions).toHaveLength(20);
  });

  it('migrates legacy encrypted records on read, persists on first edit, survives restart and deletes all versions', async () => {
    const memory = await fixture();
    const { recognitionVersions: _versions, activeRecognitionVersionId: _active, ...legacy } = memory.record;
    const root = await mkdtemp(join(tmpdir(), 'cv-recognition-restart-')); roots.push(root);
    const recordsRoot = join(root, 'records'); const keyPath = join(root, 'cv.key');
    const repository = new JsonCvImportRepository(recordsRoot, keyPath);
    await repository.create({ ...legacy, sha256: digest('legacy-cas') });
    const migrated = (await repository.get(legacy.id))!;
    expect(migrated.recognitionVersions).toHaveLength(1);
    expect(migrated.activeRecognitionVersionId).toBe(migrated.recognitionVersions![0]!.id);
    expect(migrated.normalizationArtifact).toEqual(legacy.normalizationArtifact);
    expect(migrated.facts).toEqual(legacy.facts);

    const service = new CvImportService(repository, new RecognitionNormalization());
    const reviewed = await service.review(migrated.id, migrated.revision, migrated.sha256, [
      { factId: 'fact-old-role', action: 'confirm' },
    ]);
    const restarted = new JsonCvImportRepository(recordsRoot, keyPath);
    const recovered = (await restarted.get(reviewed.id))!;
    expect(recovered.recognitionVersions).toHaveLength(1);
    expect(recovered.recognitionVersions![0]!.facts.find((fact) => fact.id === 'fact-old-role')?.decision).toBe('confirmed');
    const encrypted = await readFile(join(recordsRoot, reviewed.id, 'record.enc.json'), 'utf8');
    expect(encrypted).not.toContain('PRIVATE-RECOGNITION-CANARY-7B31');
    expect(encrypted).not.toContain('Original Engineer');
    expect(await service.delete(recovered.id, recovered.revision, recovered.sha256)).toBe(true);
    expect(await restarted.get(recovered.id)).toBeUndefined();
  });
});
