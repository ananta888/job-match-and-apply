import { describe, expect, it } from 'vitest';
import type { ReviewAgentPort, ReviewRequest, ReviewRole } from '../ports/review-agent.js';
import { applyFindingDispositions, executeReviewChain, executeReviewWorkflow } from './review-coordinator.js';

describe('review coordinator', () => {
  it('runs role-specific independent contexts in the required order', async () => {
    const requests: ReviewRequest[] = [];
    const factory = (_role: ReviewRole): ReviewAgentPort => ({ execute: async (request) => {
      requests.push(request); return { revision: `${request.revision}\n${request.role}`, findings: [] };
    }});
    const result = await executeReviewChain(factory, { jobAnalysis: { raw: true }, candidateClaims: [], styleProfile: {}, revision: 'draft' }, true);
    expect(requests.map((item) => item.role)).toEqual(['author', 'evidence_ats_reviewer', 'recruiter_style_reviewer', 'finalizer']);
    expect(requests[1]?.criteria).not.toEqual(requests[0]?.criteria);
    expect(result.manifest.execution).toBe('independent_agents');
  });

  it('blocks unresolved high findings', async () => {
    const agent: ReviewAgentPort = { execute: async (request) => ({
      revision: request.revision,
      findings: request.role === 'evidence_ats_reviewer' ? [{ id: 'high-1', severity: 'high', category: 'evidence', description: 'Unsupported', status: 'open' }] : []
    }) };
    await expect(executeReviewChain(() => agent, { jobAnalysis: {}, candidateClaims: [], styleProfile: {}, revision: 'draft' }, false)).rejects.toThrow('blockieren');
  });
});

describe('review workflow limits', () => {
  it('returns an honest partial result after the configured maximum', async () => {
    const result = await executeReviewWorkflow(
      (role) => ({ execute: async (request) => ({ revision: request.revision, findings: role === 'finalizer' ? [{ id: 'block', category: 'review', severity: 'high', status: 'open', description: 'offen' }] : [] }) }),
      { revision: 'draft', jobAnalysis: {}, candidateClaims: [], styleProfile: {} }, false, 2
    );
    expect(result).toMatchObject({ status: 'partial', cycles: 2 });
    expect(result.blockingFindings[0]?.severity).toBe('high');
  });
  it('requires an explicit justification before accepting blocking risk', () => {
    const findings = [{ id: 'high', category: 'evidence', severity: 'high' as const, description: 'Offen', status: 'open' as const }];
    expect(() => applyFindingDispositions(findings, [{ findingId: 'high', action: 'accepted_risk', justification: 'kurz' }])).toThrow('Begründung');
    expect(applyFindingDispositions(findings, [{ findingId: 'high', action: 'accepted_risk', justification: 'Bewusste fachliche Ausnahme durch den Nutzer.' }])[0]).toMatchObject({ status: 'accepted_risk' });
  });
});
