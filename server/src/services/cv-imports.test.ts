import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import type {
  CvAdoptionLedgerEntry, CvFact, CvNormalizationEnvelope, CvNormalizationPort, CvProfileSnapshot, CvTheme,
} from '../ports/cv-normalization.js';
import {
  CvImportService, JsonCvImportRepository, MemoryCvImportRepository, pdfExtractionWarnings, type CvImportRecord,
  publicCvImportRecord, publicCvImportSummary,
} from './cv-imports.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const canonicalFixture = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalFixture).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalFixture(item)}`).join(',')}}`;
  return JSON.stringify(value);
};

class FakeNormalization implements CvNormalizationPort {
  lastEnvelope?: CvNormalizationEnvelope;
  adopted: CvFact[] = [];
  constructor(
    private readonly conflicts: Array<{ id: string; code: string; detail: string }> = [],
    private readonly generatedFactCount = 2,
  ) {}
  async normalize(envelope: CvNormalizationEnvelope) {
    this.lastEnvelope = envelope;
    const provenance = { sourceSha256: envelope.source.sha256, anchor: 'line:1', origin: 'imported' as const };
    const facts = Array.from({ length: this.generatedFactCount }, (_, index) => index === 0
      ? { id: 'fact-role', claimId: 'claim-role', category: 'employment' as const, recordId: 'record-role', field: 'role', value: 'Engineer', decision: 'pending' as const, provenance }
      : index === 1
        ? { id: 'fact-company', claimId: 'claim-company', category: 'employment' as const, recordId: 'record-role', field: 'company', value: 'Example GmbH', decision: 'pending' as const, provenance }
        : { id: `fact-extra-${index}`, claimId: `claim-extra-${index}`, category: 'skill' as const, recordId: `skill-extra-${index}`, field: 'name', value: `Skill ${index}`, decision: 'pending' as const, provenance });
    return {
      facts, warnings: [], conflicts: structuredClone(this.conflicts), artifact: { contract: 'cv-import-proposal' },
    };
  }
  async validateUserFacts(facts: CvFact[]) {
    if (facts.some((fact) => fact.field === 'unsupported')) throw Object.assign(new Error('unsupported user fact'), { statusCode: 400 });
  }
  async adopt(input: Parameters<CvNormalizationPort['adopt']>[0]) {
    this.adopted = structuredClone(input.facts.filter((fact) => fact.decision === 'confirmed'));
    return {
      contract: 'cv-profile-adoption' as const, contractVersion: '1.0' as const,
      adoptedClaimIds: this.adopted.map((fact) => fact.claimId ?? `claim-${fact.id}`),
      adoptedRecordIds: [...new Set(this.adopted.map((fact) => fact.recordId))],
      candidateProfileSha256: 'a'.repeat(64), candidateProfileRevision: `sha256:${'a'.repeat(64)}`,
      transactionId: this.transactionId, replacedSnapshotId: 'profile-snapshot-' + 'b'.repeat(16),
    };
  }
  transactionId = 'c'.repeat(32);
  ledger: CvAdoptionLedgerEntry[] = [];
  revoked: string[] = [];
  restored: string[] = [];
  snapshots: CvProfileSnapshot[] = [];
  async adoptionLedger() {
    return { candidateProfileSha256: 'a'.repeat(64), adoptions: structuredClone(this.ledger) };
  }
  async revokeAdoption(input: { transactionId: string }) {
    this.revoked.push(input.transactionId);
    this.ledger = this.ledger.filter((entry) => entry.transactionId !== input.transactionId);
    return {
      contract: 'cv-profile-adoption-revocation' as const, contractVersion: '1.0' as const,
      revokedTransactionId: input.transactionId, revokedClaimIds: [], revokedRecordIds: [],
      candidateProfileSha256: 'd'.repeat(64), candidateProfileRevision: `sha256:${'d'.repeat(64)}`,
    };
  }
  async profileSnapshots() {
    return { candidateProfileSha256: 'a'.repeat(64), snapshots: structuredClone(this.snapshots) };
  }
  async restoreProfileSnapshot(input: { snapshotId: string }) {
    this.restored.push(input.snapshotId);
    return {
      contract: 'cv-profile-snapshot-restore' as const, contractVersion: '1.0' as const,
      snapshotId: input.snapshotId,
      candidateProfileSha256: 'e'.repeat(64), candidateProfileRevision: `sha256:${'e'.repeat(64)}`,
    };
  }
}

async function imported(fake = new FakeNormalization()) {
  const service = new CvImportService(new MemoryCvImportRepository(), fake);
  const record = await service.import({
    fileName: 'cv.html', mimeType: 'text/html',
    data: Buffer.from('<!doctype html><html><body><p>Engineer</p><script>Hidden Fact</script></body></html>'),
  });
  return { service, fake, record };
}

describe('CV import service', () => {
  it('extracts HTML passively, deletes upload bytes and exposes only versioned public data', async () => {
    const { fake, record } = await imported();
    expect(fake.lastEnvelope?.extractedText).toContain('Engineer');
    expect(fake.lastEnvelope?.extractedText).not.toContain('Hidden Fact');
    expect(record).toMatchObject({ contract: 'cv-import', contractVersion: '1.0', source: { retention: 'upload_deleted_after_local_extraction' } });
    expect(publicCvImportRecord(record)).not.toHaveProperty('normalizationArtifact');
    expect(publicCvImportRecord(record)).not.toHaveProperty('unresolvedConflicts');
    expect(publicCvImportSummary(record)).toMatchObject({
      contract: 'cv-import-summary', factCounts: { total: 2, pending: 2, confirmed: 0, rejected: 0 },
      warningCount: 0, unresolvedConflictCount: 0, hasAdoption: false, hasProposal: false,
    });
    expect(publicCvImportSummary(record)).not.toHaveProperty('facts');
    expect(publicCvImportSummary(record)).not.toHaveProperty('warnings');
  });

  it('uses revision/hash CAS and supports server-ID additions followed by explicit confirmation', async () => {
    const { service, record } = await imported();
    const added = await service.review(record.id, record.revision, record.sha256, [{
      action: 'add', category: 'employment', recordId: 'record-role', field: 'achievement', value: 'Reduced latency',
    }]);
    const addition = added.facts.find((fact) => fact.provenance.origin === 'user_supplied')!;
    expect(addition.id).toMatch(/^fact-user-/); expect(addition.decision).toBe('pending');
    expect(addition.provenance.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(addition.provenance.sourceSha256).not.toBe(record.source.sha256);
    await expect(service.review(record.id, record.revision, record.sha256, [{ factId: 'fact-role', action: 'confirm' }])).rejects.toMatchObject({ statusCode: 409 });
    const confirmed = await service.review(added.id, added.revision, added.sha256, [{ factId: addition.id, action: 'confirm' }]);
    expect(confirmed.facts.find((fact) => fact.id === addition.id)?.decision).toBe('confirmed');
  });

  it('stages a hash-bound AI merge atomically while every suggested fact remains pending', async () => {
    const repository = new MemoryCvImportRepository(); const service = new CvImportService(repository, new FakeNormalization());
    const sourceSha256 = 'b'.repeat(64); const text = 'Software Engineer';
    const baseFact = {
      id: 'fact-base', claimId: 'claim-base', category: 'employment' as const, recordId: 'experience-base',
      field: 'role', value: text, decision: 'pending' as const,
      provenance: { sourceSha256, anchor: 'line:1', origin: 'imported' as const },
    };
    const baseArtifact = {
      contract: 'cv-import-proposal', contract_version: '1.0',
      source: { id: 'source-cv-bbbbbbbbbbbbbbbb', sha256: sourceSha256 },
      extraction: {
        text_sha256: digest(text), line_count: 1,
        line_manifest: [{ line: 1, text, sha256: digest(text) }], warnings: [], conflicts: [],
      },
      proposal: {
        profile: { facts: [] },
        facts: [{
          id: baseFact.id, claim_id: baseFact.claimId, category: 'employment', record_id: baseFact.recordId,
          field: baseFact.field, value: baseFact.value,
          source_anchor: { source_sha256: sourceSha256, line_start: 1 },
        }],
        claims: [{ id: baseFact.claimId, fact_id: baseFact.id, status: 'unverified' }],
        experience: [{ id: baseFact.recordId, role: baseFact.value, status: 'unverified' }],
        education: [], projects: [], certifications: [], skills: [], languages: [], additional_facts: [],
      },
    };
    const now = '2026-08-14T10:00:00.000Z';
    const record: CvImportRecord = {
      contract: 'cv-import', contractVersion: '1.0', id: '11111111-1111-4111-8111-111111111111',
      revision: 1, sha256: 'a'.repeat(64), status: 'facts_pending', createdAt: now, updatedAt: now,
      source: { fileName: 'synthetic.html', mimeType: 'text/html', bytes: 10, sha256: sourceSha256, retention: 'upload_deleted_after_local_extraction' },
      facts: [baseFact], warnings: [], unresolvedConflicts: [], normalizationArtifact: baseArtifact,
    };
    await repository.create(record);
    const source = await service.loadAiSource(record.id);
    expect(source).toMatchObject({ sourceId: 'source-cv-bbbbbbbbbbbbbbbb', lineManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(source!.lineManifestJson).toContain('Software Engineer');
    const suggestionId = 'suggestion-0123456789abcdef'; const runId = '22222222-2222-4222-8222-222222222222';
    const aiFact: CvFact = {
      id: 'fact-ai-company', claimId: 'claim-ai-company', category: 'employment', recordId: 'experience-ai',
      field: 'company', value: 'Example GmbH', decision: 'pending',
      provenance: {
        sourceSha256, anchor: `ai:${suggestionId}`, origin: 'imported',
        recognition: {
          method: 'ai_assisted', suggestionId, confidence: 0.91,
          sourceSpan: { lineStart: 1, lineEnd: 1, charStart: 0, charEnd: 8 },
        },
      },
    };
    const mergedArtifact = structuredClone(baseArtifact) as unknown as {
      [key: string]: unknown;
      proposal: { facts: Array<Record<string, unknown>> };
    };
    mergedArtifact.proposal.facts.push({
      id: aiFact.id, claim_id: aiFact.claimId!, category: 'employment', record_id: aiFact.recordId,
      field: aiFact.field, value: aiFact.value,
      source_anchor: {
        origin: 'ai_structuring', recognition_method: 'ai_assisted', source_id: 'source-cv-bbbbbbbbbbbbbbbb',
        source_sha256: sourceSha256, line_start: 1, line_end: 1, char_start: 0, char_end: 8,
        quote: 'Software', suggestion_id: suggestionId, alternative_id: null,
      },
    });
    (mergedArtifact.proposal as unknown as { claims: Array<Record<string, unknown>> }).claims.push({
      id: aiFact.claimId!, fact_id: aiFact.id, status: 'unverified',
    });
    (mergedArtifact.proposal as unknown as { experience: Array<Record<string, unknown>> }).experience.push({
      id: aiFact.recordId, company: aiFact.value, status: 'unverified',
    });
    (mergedArtifact.extraction as { ai_structuring?: unknown[] }).ai_structuring = [{
      contract: 'validated-ai-cv-structure-proposal', contract_version: '1.0', status: 'unverified',
      binding: {
        source_id: 'source-cv-bbbbbbbbbbbbbbbb', source_sha256: sourceSha256,
        text_sha256: digest(text), base_proposal_sha256: source!.baseProposalSha256,
      },
      applied_suggestion_ids: [suggestionId],
    }];
    const mergedProposalSha256 = digest(canonicalFixture(mergedArtifact));
    const tamperedClaim = structuredClone(mergedArtifact) as typeof mergedArtifact;
    ((tamperedClaim.proposal as unknown as { claims: Array<Record<string, unknown>> }).claims[0]!).status = 'verified';
    const tamperedRecord = structuredClone(mergedArtifact) as typeof mergedArtifact;
    ((tamperedRecord.proposal as unknown as { experience: Array<Record<string, unknown>> }).experience[0]!).role = 'Changed';
    const tamperedAudit = structuredClone(mergedArtifact) as typeof mergedArtifact;
    (((tamperedAudit.extraction as { ai_structuring: Array<{ applied_suggestion_ids: string[] }> }).ai_structuring[0])!)
      .applied_suggestion_ids = ['suggestion-ffffffffffffffff'];
    for (const artifact of [tamperedClaim, tamperedRecord, tamperedAudit]) {
      await expect(service.stageAiStructure({
        id: record.id, expectedRevision: record.revision, expectedSha256: record.sha256, runId,
        aiProposalSha256: 'c'.repeat(64), expectedBaseProposalSha256: source!.baseProposalSha256,
        mergedProposalSha256: digest(canonicalFixture(artifact)), mergedArtifact: artifact, facts: [aiFact],
        selections: [{ suggestionId, alternativeId: null }],
      })).rejects.toMatchObject({ statusCode: 503 });
    }
    await expect(service.stageAiStructure({
      id: record.id, expectedRevision: record.revision, expectedSha256: record.sha256, runId,
      aiProposalSha256: 'c'.repeat(64), expectedBaseProposalSha256: source!.baseProposalSha256,
      mergedProposalSha256, mergedArtifact, facts: [{
        ...aiFact, provenance: { ...aiFact.provenance, recognition: {
          ...aiFact.provenance.recognition!, selectedAlternativeId: 'alternative-0123456789abcdef',
        } },
      }],
      selections: [{ suggestionId, alternativeId: null }],
    })).rejects.toMatchObject({ statusCode: 503 });
    const staged = await service.stageAiStructure({
      id: record.id, expectedRevision: record.revision, expectedSha256: record.sha256, runId,
      aiProposalSha256: 'c'.repeat(64), expectedBaseProposalSha256: source!.baseProposalSha256,
      mergedProposalSha256, mergedArtifact, facts: [aiFact],
      selections: [{ suggestionId, alternativeId: null }],
    });
    expect(staged).toMatchObject({ revision: 2, stagedFactIds: [aiFact.id] });
    const saved = await service.get(record.id);
    expect(saved?.facts.at(-1)).toMatchObject({
      id: aiFact.id, decision: 'pending', provenance: { recognition: {
        method: 'ai_assisted', runId, proposalSha256: 'c'.repeat(64), suggestionId,
      } },
    });
    expect(publicCvImportRecord(saved!)).not.toHaveProperty('normalizationArtifact');
    expect(await service.findAiStage({ id: record.id, runId, aiProposalSha256: 'c'.repeat(64) })).toMatchObject({
      revision: 2, facts: [{ id: aiFact.id, decision: 'pending' }],
    });
    const edited = await service.review(saved!.id, saved!.revision, saved!.sha256, [{
      factId: aiFact.id, action: 'edit', category: 'employment', recordId: aiFact.recordId,
      field: 'company', value: 'Corrected GmbH',
    }]);
    expect(edited.facts.find((fact) => fact.id === aiFact.id)).toMatchObject({
      decision: 'rejected', provenance: { origin: 'imported', recognition: {
        method: 'ai_assisted', runId, proposalSha256: 'c'.repeat(64), suggestionId,
      } },
    });
    expect(edited.facts.filter((fact) => fact.provenance.origin === 'user_supplied')).toEqual([
      expect.objectContaining({
        value: 'Corrected GmbH', decision: 'pending', provenance: expect.objectContaining({ origin: 'user_supplied' }),
      }),
    ]);
    expect(await service.findAiStage({ id: record.id, runId, aiProposalSha256: 'c'.repeat(64) })).toMatchObject({
      revision: 3, facts: [{ id: aiFact.id, decision: 'rejected' }],
    });
  });

  it('rejects additions to a foreign record and never adopts rejected or pending facts', async () => {
    const { service, fake, record } = await imported();
    await expect(service.review(record.id, record.revision, record.sha256, [{
      action: 'add', category: 'employment', recordId: 'foreign-record', field: 'achievement', value: 'Nope',
    }])).rejects.toMatchObject({ statusCode: 409 });
    const reviewed = await service.review(record.id, record.revision, record.sha256, [
      { factId: 'fact-role', action: 'confirm' }, { factId: 'fact-company', action: 'reject' },
    ]);
    const adopted = await service.adopt(reviewed.id, reviewed.revision, reviewed.sha256);
    expect(fake.adopted.map((fact) => fact.id)).toEqual(['fact-role']);
    expect(adopted.status).toBe('adopted');
    await expect(service.review(adopted.id, adopted.revision, adopted.sha256, [
      { factId: 'fact-role', action: 'reject' },
    ])).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.adopt(adopted.id, adopted.revision, adopted.sha256)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('offers only this import\'s own adoptions as revocable', async () => {
    const { service, fake, record } = await imported();
    const reviewed = await service.review(record.id, record.revision, record.sha256, [
      { factId: 'fact-role', action: 'confirm' }, { factId: 'fact-company', action: 'confirm' },
    ]);
    const entry = (sourceSha256: string, transactionId: string): CvAdoptionLedgerEntry => ({
      transactionId, occurredAt: '2026-08-15T10:28:58.136Z', sourceSha256,
      claimCount: 2, presentClaimCount: 2,
    });
    fake.ledger = [entry(reviewed.source.sha256, 'c'.repeat(32)), entry('9'.repeat(64), 'a'.repeat(32))];

    const revocable = await service.revocableAdoptions(reviewed.id);
    expect(revocable.adoptions.map((item) => item.transactionId)).toEqual(['c'.repeat(32)]);

    // A transaction from another source must never be revocable through this import.
    await expect(service.revokeAdoption(
      reviewed.id, reviewed.revision, reviewed.sha256, 'a'.repeat(32),
    )).rejects.toMatchObject({ statusCode: 409 });
    expect(fake.revoked).toEqual([]);
  });

  it('revokes a committed adoption and reopens the import for a fresh adoption', async () => {
    const { service, fake, record } = await imported();
    const reviewed = await service.review(record.id, record.revision, record.sha256, [
      { factId: 'fact-role', action: 'confirm' }, { factId: 'fact-company', action: 'confirm' },
    ]);
    const adopted = await service.adopt(reviewed.id, reviewed.revision, reviewed.sha256);
    expect(adopted.adoption?.transactionId).toBe('c'.repeat(32));
    expect(adopted.adoption?.replacedSnapshotId).toBe('profile-snapshot-' + 'b'.repeat(16));
    fake.ledger = [{
      transactionId: 'c'.repeat(32), occurredAt: '2026-08-15T10:28:58.136Z',
      sourceSha256: adopted.source.sha256, claimCount: 2, presentClaimCount: 2,
    }];

    const revoked = await service.revokeAdoption(
      adopted.id, adopted.revision, adopted.sha256, 'c'.repeat(32),
    );
    expect(fake.revoked).toEqual(['c'.repeat(32)]);
    expect(revoked.adoption).toBeUndefined();
    expect(revoked.status).toBe('facts_reviewed');

    // Reopened: adopting again is allowed instead of blocked as a duplicate.
    const readopted = await service.adopt(revoked.id, revoked.revision, revoked.sha256);
    expect(readopted.status).toBe('adopted');
  });

  it('rejects a stale CAS and an unknown transaction before touching the profile', async () => {
    const { service, fake, record } = await imported();
    const reviewed = await service.review(record.id, record.revision, record.sha256, [
      { factId: 'fact-role', action: 'confirm' }, { factId: 'fact-company', action: 'confirm' },
    ]);
    await expect(service.revokeAdoption(
      reviewed.id, reviewed.revision + 1, reviewed.sha256, 'c'.repeat(32),
    )).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.revokeAdoption(
      reviewed.id, reviewed.revision, reviewed.sha256, 'c'.repeat(32),
    )).rejects.toMatchObject({ statusCode: 409 });
    expect(fake.revoked).toEqual([]);
  });

  it('drops the adoption proof when the profile is rolled back to a snapshot', async () => {
    const { service, fake, record } = await imported();
    const reviewed = await service.review(record.id, record.revision, record.sha256, [
      { factId: 'fact-role', action: 'confirm' }, { factId: 'fact-company', action: 'confirm' },
    ]);
    const adopted = await service.adopt(reviewed.id, reviewed.revision, reviewed.sha256);
    const snapshot: CvProfileSnapshot = {
      id: 'profile-snapshot-' + 'b'.repeat(16), createdAt: '2026-08-15T10:28:58.136Z',
      candidateProfileSha256: 'f'.repeat(64), byteSize: 1_024, reason: 'pre_adoption',
      claimCount: 4, current: false,
    };
    fake.snapshots = [snapshot];

    expect((await service.profileSnapshots(adopted.id)).snapshots).toEqual([snapshot]);
    const restored = await service.restoreProfileSnapshot(
      adopted.id, adopted.revision, adopted.sha256, snapshot.id,
    );
    expect(fake.restored).toEqual([snapshot.id]);
    expect(restored.adoption).toBeUndefined();
    expect(restored.status).toBe('facts_reviewed');
  });

  it('validates user facts before persistence, caps the final fact set and blocks unresolved conflicts', async () => {
    const invalid = await imported();
    await expect(invalid.service.review(invalid.record.id, invalid.record.revision, invalid.record.sha256, [{
      action: 'add', category: 'employment', recordId: 'record-role', field: 'unsupported', value: 'Nope',
    }])).rejects.toMatchObject({ statusCode: 400 });

    const capped = await imported(new FakeNormalization([], 2_000));
    await expect(capped.service.review(capped.record.id, capped.record.revision, capped.record.sha256, [{
      action: 'add', category: 'employment', recordId: 'record-role', field: 'achievement', value: 'One too many',
    }])).rejects.toMatchObject({ statusCode: 409 });

    const conflictNormalization = new FakeNormalization([{
      id: 'conflict-0123456789abcdef', code: 'ambiguous_employment_role', detail: 'Two roles share one period',
    }]);
    const conflicted = await imported(conflictNormalization);
    const reviewed = await conflicted.service.review(conflicted.record.id, conflicted.record.revision, conflicted.record.sha256, [
      { factId: 'fact-role', action: 'confirm' }, { factId: 'fact-company', action: 'reject' },
    ]);
    await expect(conflicted.service.adopt(reviewed.id, reviewed.revision, reviewed.sha256)).rejects.toMatchObject({ statusCode: 409 });
    expect(conflictNormalization.adopted).toEqual([]);
  });

  it('preserves an edited imported fact as rejected provenance and adopts only its new user fact', async () => {
    const { service, fake, record } = await imported();
    const edited = await service.review(record.id, record.revision, record.sha256, [
      { factId: 'fact-role', action: 'edit', category: 'employment', recordId: 'record-role', field: 'role', value: 'Senior Engineer' },
      { factId: 'fact-company', action: 'reject' },
    ]);
    const original = edited.facts.find((fact) => fact.id === 'fact-role')!;
    const replacement = edited.facts.find((fact) => fact.provenance.origin === 'user_supplied')!;
    expect(original).toMatchObject({ value: 'Engineer', decision: 'rejected', claimId: 'claim-role', provenance: { origin: 'imported' } });
    expect(replacement).toMatchObject({ value: 'Senior Engineer', decision: 'pending', provenance: { origin: 'user_supplied' } });
    const confirmed = await service.review(edited.id, edited.revision, edited.sha256, [{ factId: replacement.id, action: 'confirm' }]);
    await service.adopt(confirmed.id, confirmed.revision, confirmed.sha256);
    expect(fake.adopted).toHaveLength(1); expect(fake.adopted[0]).toMatchObject({ id: replacement.id, value: 'Senior Engineer' });
  });

  it('renders only an exact approved pipeline revision as escaped CSP HTML', async () => {
    const { service, record } = await imported();
    const reviewed = await service.review(record.id, record.revision, record.sha256, [
      { factId: 'fact-role', action: 'confirm' }, { factId: 'fact-company', action: 'reject' },
    ]);
    const adopted = await service.adopt(reviewed.id, reviewed.revision, reviewed.sha256);
    const content = '# Jane <script>alert(1)</script>\n## Profil\n- Engineer <img src=x>'; const documentSha256 = digest(content);
    const rendered = await service.renderApproved(adopted.id, adopted.revision, adopted.sha256, {
      applicationCaseId: '11111111-1111-4111-8111-111111111111', jobId: 'job-1', identityMode: 'incognito',
      documentRevisionId: '22222222-2222-4222-8222-222222222222', documentSha256, documentContent: content,
      pipeline: { candidateProfileSha256: 'a'.repeat(64), styleProfileSha256: 'b'.repeat(64), artifactSha256: documentSha256, pipelineContractVersion: '1.0', completedStages: ['finalize'] },
      styleProfile: { revision: 3, sha256: 'b'.repeat(64) }, sourceAgentArtifactId: '33333333-3333-4333-8333-333333333333',
    });
    expect(rendered.proposal?.html).toContain('&lt;script&gt;');
    expect(rendered.proposal?.html).toContain('<main><h1>Jane &lt;script&gt;alert(1)&lt;/script&gt;</h1>');
    expect(rendered.proposal?.html).toContain('<h2>Profil</h2>');
    expect(rendered.proposal?.html).toContain('Engineer &lt;img src=x&gt;');
    expect(rendered.proposal?.html).toContain('Content-Security-Policy');
    expect(rendered.proposal?.downloadAllowed).toBe(false);
    expect(publicCvImportRecord(rendered).proposal).not.toHaveProperty('html');
  });

  it('encrypts fact values and HTML at rest with a separate key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cv-import-vault-')); roots.push(root);
    const repository = new JsonCvImportRepository(join(root, 'records'), join(root, 'cv.key'));
    const fake = new FakeNormalization(); const service = new CvImportService(repository, fake);
    const record = await service.import({ fileName: 'private.html', mimeType: 'text/html', data: Buffer.from('<html><body>Secret Employer</body></html>') });
    const files = await readdir(join(root, 'records', record.id));
    expect(files).toEqual(['record.enc.json']);
    const persisted = await readFile(join(root, 'records', record.id, files[0]!), 'utf8');
    expect(persisted).not.toContain('Example GmbH'); expect(persisted).not.toContain('Secret Employer');
    expect((await readFile(join(root, 'cv.key'))).length).toBe(32);
    expect(await repository.get(record.id)).toMatchObject({ id: record.id, facts: expect.any(Array) });
  });

  it('accepts bounded passive DOCX XML and rejects active Office/PDF/invalid HTML input', async () => {
    const fake = new FakeNormalization(); const service = new CvImportService(new MemoryCvImportRepository(), fake);
    const docx = new JSZip();
    docx.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    docx.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    docx.file('word/document.xml', '<w:document xmlns:w="urn:w"><w:p><w:r><w:t>Engineer</w:t></w:r></w:p></w:document>');
    const validDocx = await docx.generateAsync({ type: 'nodebuffer' });
    await expect(service.import({ fileName: 'cv.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: validDocx })).resolves.toMatchObject({ contract: 'cv-import' });

    const placeholder = new JSZip(); placeholder.file('[Content_Types].xml', '<Types/>'); placeholder.file('word/document.xml', '<w:p xmlns:w="urn:w">Text</w:p>');
    await expect(service.import({ fileName: 'placeholder.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: await placeholder.generateAsync({ type: 'nodebuffer' }) })).rejects.toMatchObject({ statusCode: 400 });
    const external = new JSZip(); external.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    external.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    external.file('word/document.xml', '<w:p xmlns:w="urn:w">Text</w:p>'); external.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship TargetMode="Ext&#x65;rnal" Target="https://example.invalid/x"/></Relationships>');
    await expect(service.import({ fileName: 'external.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: await external.generateAsync({ type: 'nodebuffer' }) })).rejects.toThrow('externen Beziehungen');

    await expect(service.import({ fileName: 'trailing.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: Buffer.concat([validDocx, Buffer.from([0])]) })).rejects.toMatchObject({ statusCode: 400 });
    const brokenLocalHeader = Buffer.from(validDocx); brokenLocalHeader.writeUInt32LE(0, 0);
    await expect(service.import({ fileName: 'broken.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: brokenLocalHeader })).rejects.toMatchObject({ statusCode: 400 });

    const odt = new JSZip(); odt.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
    odt.file('META-INF/manifest.xml', '<manifest:manifest xmlns:manifest="urn:manifest"/>');
    odt.file('content.xml', '<office:document xmlns:office="urn:office" xmlns:text="urn:text"><text:p>Engineer</text:p></office:document>');
    await expect(service.import({ fileName: 'cv.odt', mimeType: 'application/vnd.oasis.opendocument.text', data: await odt.generateAsync({ type: 'nodebuffer' }) })).resolves.toMatchObject({ contract: 'cv-import' });

    const macro = new JSZip(); macro.file('[Content_Types].xml', '<Types ContentType="macroEnabled"/>'); macro.file('word/document.xml', '<w:p xmlns:w="urn:w">Text</w:p>'); macro.file('word/vbaProject.bin', 'active');
    await expect(service.import({ fileName: 'macro.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: await macro.generateAsync({ type: 'nodebuffer' }) })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.import({ fileName: 'active.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.7\n/JavaScript') })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.import({ fileName: 'bad.html', mimeType: 'text/html', data: Buffer.from([0xff, 0xfe]) })).rejects.toMatchObject({ statusCode: 400 });
    expect(pdfExtractionWarnings(101, '')).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'pdf_passive_best_effort' }),
      expect.objectContaining({ code: 'pdf_page_limit' }),
      expect.objectContaining({ code: 'low_pdf_text' }),
    ]));
  });
});

const originalTheme: CvTheme = {
  mode: 'original', template: 'classic', font: 'Arial', accentColor: '#1d4ed8', spacing: 'comfortable',
  sectionOrder: ['profile', 'employment', 'project', 'education', 'skill', 'certification', 'language', 'additional'],
  original: {
    columns: 2, fontFamily: 'sans',
    palette: { text: '#222222', heading: '#111111', accent: '#7c3aed', background: '#ffffff', sidebar: '#0f172a', sidebarText: '#f9fafb' },
    main: ['employment', 'education'], side: ['profile', 'skill', 'language'],
  },
};

async function importedWithLayout() {
  const service = new CvImportService(new MemoryCvImportRepository(), new FakeNormalization());
  const record = await service.import({
    fileName: 'cv.html', mimeType: 'text/html',
    data: Buffer.from(`<!doctype html><html><body>
      <aside class="sidebar" style="width:30%"><h2>Profil</h2><p>x</p><h2>Kenntnisse</h2><p>TS</p></aside>
      <main><h2>Berufserfahrung</h2><p>Rolle</p><h2>Ausbildung</h2><p>Studium</p></main>
      <style>h2{color:#7c3aed}body{color:#222222}.sidebar{background:#0f172a}</style></body></html>`),
  });
  return { service, record };
}

describe('CV import layout fingerprint and format templates', () => {
  it('captures a style-only layout fingerprint at import and exposes it publicly', async () => {
    const { record } = await importedWithLayout();
    expect(record.layoutFingerprint).toMatchObject({ contract: 'cv-layout-fingerprint', sourceFormat: 'html', columns: 2 });
    expect(record.layoutFingerprint!.palette.accent).toBe('#7c3aed');
    expect(publicCvImportRecord(record).layoutFingerprint).toMatchObject({ contract: 'cv-layout-fingerprint' });
    expect(publicCvImportSummary(record)).toMatchObject({ hasLayoutFingerprint: true });
    // The fingerprint must not leak any imported fact value.
    expect(JSON.stringify(record.layoutFingerprint)).not.toMatch(/Engineer|Rolle|Studium/);
  });

  it('persists an original-layout theme and renders a two-column skeleton preview', async () => {
    const { service, record } = await importedWithLayout();
    const saved = await service.setTheme(record.id, record.revision, record.sha256, originalTheme);
    expect(saved.theme).toMatchObject({ mode: 'original', original: { columns: 2 } });
    const preview = await service.previewTheme(saved.id, saved.theme!);
    expect(preview.htmlSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.html).toContain('data-mode="original"');
    expect(preview.html).toContain('grid-template-columns');
    expect(preview.html).toContain('#7c3aed');
    expect(preview.html).toContain('#0f172a');
    expect(preview.html).toContain("default-src 'none'");
    expect(preview.html).not.toMatch(/<script|Engineer/i);
  });

  it('renders an ATS skeleton preview honouring the section order', async () => {
    const { service, record } = await importedWithLayout();
    const atsTheme: CvTheme = {
      mode: 'ats', template: 'modern', font: 'Georgia', accentColor: '#047857', spacing: 'compact',
      sectionOrder: ['skill', 'employment', 'profile', 'education', 'project', 'certification', 'language', 'additional'],
    };
    const preview = await service.previewTheme(record.id, atsTheme);
    expect(preview.html).toContain('data-mode="ats"');
    expect(preview.html).toContain('#047857');
    expect(preview.html).not.toContain('grid-template-columns');
    // skill section appears before employment because it is first in the order
    expect(preview.html.indexOf('data-section="skill"')).toBeLessThan(preview.html.indexOf('data-section="employment"'));
  });

  it('rejects inconsistent or unsafe original layouts', async () => {
    const { service, record } = await importedWithLayout();
    const overlapping = { ...originalTheme, original: { ...originalTheme.original!, main: ['employment', 'skill'] as never, side: ['skill'] as never } };
    await expect(service.setTheme(record.id, record.revision, record.sha256, overlapping)).rejects.toMatchObject({ statusCode: 400 });
    const missingSidebar = { ...originalTheme, original: { ...originalTheme.original!, palette: { text: '#222222', heading: '#111111', accent: '#7c3aed', background: '#ffffff' } as never } };
    await expect(service.setTheme(record.id, record.revision, record.sha256, missingSidebar)).rejects.toMatchObject({ statusCode: 400 });
    const badHex = { ...originalTheme, original: { ...originalTheme.original!, palette: { ...originalTheme.original!.palette, accent: 'red' } as never } };
    await expect(service.setTheme(record.id, record.revision, record.sha256, badHex)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('clears the theme back to the server default', async () => {
    const { service, record } = await importedWithLayout();
    const saved = await service.setTheme(record.id, record.revision, record.sha256, originalTheme);
    const cleared = await service.setTheme(saved.id, saved.revision, saved.sha256, undefined);
    expect(cleared.theme).toBeUndefined();
  });

  it('runs a local ATS check on the theme preview and refuses a missing proposal', async () => {
    const { service, record } = await importedWithLayout();
    const report = await service.atsCheck(record.id, 'theme-preview', { mustHave: ['Angular', 'Kubernetes'] });
    expect(report).toMatchObject({ contract: 'ats-check', engine: 'deterministic-local' });
    expect(report.lint.some((rule) => rule.id === 'single-column')).toBe(true);
    expect(report.coverage?.mustHave.total).toBe(2);
    await expect(service.atsCheck(record.id, 'proposal', {})).rejects.toMatchObject({ statusCode: 409 });
  });
});
