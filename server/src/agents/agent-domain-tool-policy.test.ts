import { describe, expect, it } from 'vitest';
import { allowedRootDomainTools } from './agent-domain-tool-policy.js';

describe('agent domain tool policy', () => {
  it('keeps CV AI structuring isolated from every Root MCP tool', () => {
    expect(allowedRootDomainTools({
      metadata: { workflowId: 'cv-ai-structuring' },
    })).toEqual([]);
  });

  it('does not weaken existing no-case defaults for ordinary runs', () => {
    expect(allowedRootDomainTools({ metadata: {} })).toEqual([
      'jobs.search', 'job_search.capabilities', 'job_search.search',
    ]);
  });
});
