import { describe, expect, it } from 'vitest';
import { allowedRootDomainTools } from './agent-domain-tool-policy.js';

describe('agent domain tool policy', () => {
  it('keeps CV AI structuring isolated from every Root MCP tool', () => {
    expect(allowedRootDomainTools({
      metadata: { workflowId: 'cv-ai-structuring' },
    })).toEqual([]);
  });

  it('keeps the fully materialized application workflow free of approval-triggering reads', () => {
    expect(allowedRootDomainTools({
      applicationCaseId: 'case-1', metadata: { workflowId: 'evidence-application-package' },
    })).toEqual([]);
  });

  it('does not weaken existing no-case defaults for ordinary runs', () => {
    expect(allowedRootDomainTools({ metadata: {} })).toEqual([
      'jobs.search', 'job_search.capabilities', 'job_search.search',
    ]);
  });
});
