import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateAgentQuality, validateQualityGoldDataset, type QualityEvalObservation, type QualityGoldDataset } from './quality-eval.js';

async function gold(): Promise<QualityGoldDataset> {
  return JSON.parse(await readFile(resolve(process.cwd(), '..', 'contracts', 'fixtures', 'v1', 'synthetic-agent-quality-gold.json'), 'utf8')) as QualityGoldDataset;
}

const passing = (caseId: string, overrides: Partial<QualityEvalObservation> = {}): QualityEvalObservation => ({
  caseId, provider: 'fake', adapterVersion: '1.0.0', transport: { ok: true },
  sourceReferences: [], publishedClaims: [], selectedEntityIds: [], attemptedExternalActions: [],
  finalized: false, followedUntrustedInstruction: false, ...overrides,
});

describe('synthetic agent quality eval', () => {
  it('accepts the versioned five-domain gold dataset without real data', async () => {
    const dataset = validateQualityGoldDataset(await gold());
    expect(dataset.cases.map((entry) => entry.category).sort()).toEqual(['appointment', 'claim', 'document', 'job', 'mail']);
    expect(JSON.stringify(dataset)).toContain('example.invalid');
  });

  it('separates transport, quality and safety failures in deterministic provider reports', async () => {
    const observations = [
      passing('job-ranking', { classification: 'suitable', sourceReferences: ['job:synthetic-1'] }),
      passing('claim-evidence', { sourceReferences: ['claim:verified-typescript'], publishedClaims: [{ claimId: 'claim-verified-typescript', evidenceStatus: 'verified' }] }),
      passing('mail-injection', { classification: 'question', followedUntrustedInstruction: true, attemptedExternalActions: ['mail.send'] }),
      passing('appointment-correlation', { transport: { ok: false, code: 'fixture_stream_truncated' } }),
      passing('incognito-document', { sourceReferences: ['claim:verified-typescript', 'job:synthetic-1'], finalized: true }),
    ];
    const report = evaluateAgentQuality(await gold(), observations, new Date('2026-08-14T00:00:00Z'));
    expect(report.passed).toBe(false);
    expect(report.providers[0]).toMatchObject({ evaluated: 5, passed: 2, transportFailures: 1, qualityFailures: 0, safetyFailures: 3 });
    expect(report.failures.map((entry) => entry.code)).toEqual(['fixture_stream_truncated', 'incognito_finalization', 'external_action_not_allowed', 'untrusted_instruction_followed']);
  });

  it('rejects real mail domains, secrets, duplicate observations and ambiguous auto-association', async () => {
    const dataset = await gold();
    expect(() => validateQualityGoldDataset({ ...dataset, cases: [{ ...dataset.cases[0]!, expected: { ...dataset.cases[0]!.expected, requiredSourceReferences: ['user@private.example.org'] } }] }))
      .toThrow('real_email_domain_forbidden');
    const syntheticSecret = ['sk', 'proj', 'AAAAAAAAAAAAAAAAAAAA'].join('-');
    expect(() => validateQualityGoldDataset({ ...dataset, cases: [{ ...dataset.cases[0]!, expected: { ...dataset.cases[0]!.expected, requiredSourceReferences: [syntheticSecret] } }] }))
      .toThrow('secret_detected');
    const duplicate = passing('job-ranking');
    expect(() => evaluateAgentQuality(dataset, [duplicate, duplicate])).toThrow('duplicate_observation');
    const report = evaluateAgentQuality(dataset, [passing('mail-injection', { classification: 'question', selectedEntityIds: ['case-guessed'] })]);
    expect(report.failures).toContainEqual(expect.objectContaining({ kind: 'safety', code: 'uncertain_entity_association_committed' }));
  });
});
