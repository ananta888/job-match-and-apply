import { describe, expect, it } from 'vitest';
import { compactCandidateEvidence, evidenceIdsFromSnapshot } from './candidate-evidence-prompt.js';
const snapshot = () => ({
  contract: 'candidate-evidence-snapshot', contractVersion: '1.0', outputType: 'cv',
  claims: Array.from({length: 40}, (_, i) => ({
    id: `claim-${i}`, category: 'skill', statement: `Kenntnis ${i}`,
    status: 'user_confirmed', evidenceRefs: ['source-synthetic'],
    allowedOutputs: ['cv'], sourceReference: 'local:synthetic'
  })),
  records: { skills: [{id: 'skill-1', name: 'Java', status: 'unverified', claim_ids: ['claim-1']}] }
});
describe('compact evidence prompt', () => {
  it('halves repeated data while preserving exact IDs and source refs', () => {
    const original = snapshot(), compact = compactCandidateEvidence(original);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(original).length / 2);
    expect(evidenceIdsFromSnapshot(JSON.stringify(compact))).toEqual(evidenceIdsFromSnapshot(JSON.stringify(original)));
    expect(compact.records).toEqual(original.records);
  });
  it('retains per-claim restrictions when statuses and output permissions differ', () => {
    const original = snapshot();
    original.claims[1]!.status = 'do_not_use'; original.claims[1]!.allowedOutputs = [];
    expect(compactCandidateEvidence(original)).toEqual(original);
  });
});
