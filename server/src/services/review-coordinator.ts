import type { ReviewAgentPort, ReviewFinding, ReviewRequest, ReviewRole } from '../ports/review-agent.js';

const roles: ReviewRole[] = ['author', 'evidence_ats_reviewer', 'recruiter_style_reviewer', 'finalizer'];
const criteria: Record<ReviewRole, string[]> = {
  author: ['Draft only from supplied claims', 'Annotate every factual line'],
  evidence_ats_reviewer: ['Reject unsupported claims', 'Classify requirement coverage without fabricated percentages'],
  recruiter_style_reviewer: ['Check relevance, readability and configured style'],
  finalizer: ['Block unresolved high or critical findings', 'Do not expose evidence annotations']
};

export interface ReviewChainResult {
  revision: string;
  findings: ReviewFinding[];
  manifest: { execution: 'independent_agents' | 'sequential_single_agent'; passes: Array<{ role: ReviewRole; independentContext: boolean }> };
}

export interface ReviewWorkflowResult extends ReviewChainResult {
  status: 'finalizable' | 'partial'; cycles: number; blockingFindings: ReviewFinding[];
}

export async function executeReviewChain(
  agentFactory: (role: ReviewRole) => ReviewAgentPort,
  input: Omit<ReviewRequest, 'role' | 'criteria' | 'revision'> & { revision: string },
  independentContexts: boolean
): Promise<ReviewChainResult> {
  let revision = input.revision;
  const findings: ReviewFinding[] = [];
  const passes: ReviewChainResult['manifest']['passes'] = [];
  for (const role of roles) {
    const result = await agentFactory(role).execute({
      role, jobAnalysis: structuredClone(input.jobAnalysis), candidateClaims: structuredClone(input.candidateClaims),
      styleProfile: structuredClone(input.styleProfile), revision, criteria: [...criteria[role]]
    });
    revision = result.revision;
    findings.push(...result.findings);
    passes.push({ role, independentContext: independentContexts });
  }
  const blocking = findings.filter((item) => ['high', 'critical'].includes(item.severity) && item.status === 'open');
  if (blocking.length > 0) throw Object.assign(new Error(`${blocking.length} offene High/Critical Review-Findings blockieren die Finalisierung.`), { statusCode: 409 });
  return {
    revision, findings,
    manifest: { execution: independentContexts ? 'independent_agents' : 'sequential_single_agent', passes }
  };
}

export async function executeReviewWorkflow(
  agentFactory: (role: ReviewRole) => ReviewAgentPort,
  input: Omit<ReviewRequest, 'role' | 'criteria' | 'revision'> & { revision: string },
  independentContexts: boolean,
  maxCycles: number
): Promise<ReviewWorkflowResult> {
  if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > 10) throw new Error('maxCycles muss zwischen 1 und 10 liegen.');
  let revision = input.revision;
  let last: ReviewChainResult | undefined;
  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    try {
      last = await executeReviewChain(agentFactory, { ...input, revision }, independentContexts);
      return { ...last, status: 'finalizable', cycles: cycle, blockingFindings: [] };
    } catch (error) {
      if (!(typeof error === 'object' && error && 'statusCode' in error && error.statusCode === 409)) throw error;
      // Agents receive only the current revision on the next cycle; hidden reasoning is never forwarded.
      revision = `${revision}\n<!-- review-cycle:${cycle} -->`;
      if (cycle === maxCycles) {
        return {
          revision, findings: [], status: 'partial', cycles: cycle,
          blockingFindings: [{ id: `review-limit-${cycle}`, category: 'review_limit', severity: 'high', status: 'open', description: error instanceof Error ? error.message : 'Reviewlimit erreicht.' }],
          manifest: { execution: independentContexts ? 'independent_agents' : 'sequential_single_agent', passes: [] }
        };
      }
    }
  }
  throw new Error('Unerreichbarer Reviewzustand.');
}

export function applyFindingDispositions(
  findings: ReviewFinding[],
  dispositions: Array<{ findingId: string; action: 'resolved' | 'accepted_risk'; justification?: string }>
): ReviewFinding[] {
  const byId = new Map(dispositions.map((item) => [item.findingId, item]));
  return findings.map((finding) => {
    const decision = byId.get(finding.id); if (!decision) return structuredClone(finding);
    if (decision.action === 'accepted_risk' && (!decision.justification || decision.justification.trim().length < 10)) {
      throw Object.assign(new Error(`Finding ${finding.id}: akzeptiertes Risiko benötigt eine Begründung.`), { statusCode: 409 });
    }
    return { ...finding, status: decision.action, disposition: decision.justification?.trim() };
  });
}
