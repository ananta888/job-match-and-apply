import { describe, expect, it } from 'vitest';
import { APPLICATION_AGENT_WORKFLOWS } from './application-workflows.js';
import { validateOrchestrationPlan } from './security-orchestration.js';

describe('application agent workflows', () => {
  it('validates every built-in plan and keeps actions suggestion-only', () => {
    expect(APPLICATION_AGENT_WORKFLOWS).toHaveLength(4);
    for (const workflow of APPLICATION_AGENT_WORKFLOWS) {
      expect(workflow.producesSuggestionsOnly).toBe(true);
      expect(workflow.prohibitedActions.length).toBeGreaterThan(0);
      const validated = validateOrchestrationPlan(workflow.plan('fake'));
      expect(validated.topologicalOrder.length).toBeGreaterThan(0);
    }
  });

  it('declares all application review roles and never a submission node', () => {
    const workflow = APPLICATION_AGENT_WORKFLOWS.find((item) => item.id === 'evidence-application-package')!;
    const roles = workflow.plan('fake').nodes.map((node) => node.role);
    expect(roles).toEqual(expect.arrayContaining(['author', 'evidence_reviewer', 'ats_reviewer', 'recruiter_style_reviewer', 'finalizer']));
    expect(JSON.stringify(workflow)).not.toContain('submit_application"');
  });
});
