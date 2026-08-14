import { describe, expect, it } from 'vitest';
import { ApprovalQueue, RunCapabilityAuthority } from './security-approval.js';
import { AgentPolicyEngine, RISK_CLASSES, type PolicyRequest, type RiskClass, type ToolPolicyRule } from './security-policy.js';

const key = Buffer.alloc(32, 53);
const start = new Date('2026-08-14T00:00:00.000Z');
const parameters = {
  applicationCaseId: 'case-sensitive-1',
  command: ['write', '--target', 'proposal.md'],
  nested: { enabled: true, count: 2 },
};

function approval(queue: ApprovalQueue, risk: RiskClass = 'local_write') {
  return queue.request({
    runId: 'run-approval-property', toolName: 'document.save', target: 'application-case:case-sensitive-1',
    parameters, parameterPreview: { target: 'proposal.md' }, risk, expiresInMs: 1_000,
  });
}

const expectation = {
  runId: 'run-approval-property', toolName: 'document.save', target: 'application-case:case-sensitive-1', parameters,
};

describe('approval binding and replay mutation properties', () => {
  it('binds every nested parameter and rejects replay after one valid consumption', () => {
    const queue = new ApprovalQueue(key, () => start);
    const request = approval(queue);
    const token = queue.approve(request.id, 'operator-property');
    const mutations = [
      { ...parameters, applicationCaseId: 'CASE-SENSITIVE-1' },
      { ...parameters, command: ['write', '--target', 'other.md'] },
      { ...parameters, nested: { ...parameters.nested, enabled: false } },
      { ...parameters, nested: { ...parameters.nested, count: 3 } },
      { ...parameters, injectedApproval: true },
    ];
    for (const mutated of mutations) {
      expect(() => queue.consume(token, { ...expectation, parameters: mutated })).toThrow('parameters_mismatch');
    }
    expect(() => queue.consume(token, { ...expectation, runId: 'run-mutated' })).toThrow('run_mismatch');
    expect(() => queue.consume(token, { ...expectation, toolName: 'document.delete' })).toThrow('tool_mismatch');
    expect(() => queue.consume(token, { ...expectation, target: 'application-case:CASE-SENSITIVE-1' })).toThrow('target_mismatch');
    expect(queue.consume(token, expectation)).toMatchObject({ requestId: request.id, risk: 'local_write' });
    expect(() => queue.consume(token, expectation)).toThrow('already_used');
  });

  it('expires pending and approved grants at the exact boundary and never promotes denial', () => {
    let now = new Date(start);
    const queue = new ApprovalQueue(key, () => now);
    const pending = approval(queue);
    now = new Date(start.getTime() + 1_000);
    expect(queue.get(pending.id)?.status).toBe('expired');
    expect(() => queue.approve(pending.id, 'operator-property')).toThrow('not_pending:expired');

    now = new Date(start);
    const approved = approval(queue);
    const token = queue.approve(approved.id, 'operator-property');
    now = new Date(start.getTime() + 1_000);
    expect(() => queue.consume(token, expectation)).toThrow('token_expired');

    now = new Date(start);
    const denied = approval(queue);
    queue.deny(denied.id, 'operator-property');
    expect(() => queue.approve(denied.id, 'operator-property')).toThrow('not_pending:denied');
  });

  it('round-trips each canonical risk without permitting a caller risk downgrade', () => {
    for (const risk of RISK_CLASSES) {
      const queue = new ApprovalQueue(key, () => start);
      const request = approval(queue, risk);
      const token = queue.approve(request.id, 'operator-property');
      expect(queue.consume(token, expectation).risk, risk).toBe(risk);

      const rule: ToolPolicyRule = { toolName: `risk.${risk}`, risk, actionClass: 'execute', requiresApproval: true };
      const policy = new AgentPolicyEngine([rule]);
      const base: PolicyRequest = {
        runId: 'run-risk', providerId: 'fake', toolName: rule.toolName, actionClass: 'execute',
        requestedRisk: risk, runProfile: risk === 'network' ? 'workspace_write_limited_network' : 'workspace_write_offline',
        identityMode: 'real', allowedTools: [rule.toolName], allowedApplicationCaseIds: [],
        networkDomain: risk === 'network' ? 'api.example.test' : undefined,
        networkGrant: risk === 'network' ? { domains: ['api.example.test'], expiresAt: '2026-08-15T00:00:00.000Z' } : undefined,
        now: start,
      };
      const canonicalPolicy = risk === 'network'
        ? new AgentPolicyEngine([{ ...rule, allowedNetworkDomains: ['api.example.test'] }])
        : policy;
      expect(canonicalPolicy.evaluate(base).outcome, `${risk}:approval`).toBe('requires_approval');
      expect(canonicalPolicy.evaluate({ ...base, hasValidApproval: true }).outcome, `${risk}:approved`).toBe('allow');
      const downgrade = risk === 'read' ? 'local_write' : 'read';
      const decision = canonicalPolicy.evaluate({ ...base, requestedRisk: downgrade });
      expect(decision.outcome, `${risk}:downgrade`).toBe('deny');
      expect(decision.reasonCodes).toContain('risk_mismatch');
    }
  });

  it('keeps application-case capabilities case-sensitive and rejects a case-scope bypass', () => {
    const authority = new RunCapabilityAuthority(key, () => start);
    const token = authority.issue({
      runId: 'run-case', providerId: 'fake', allowedTools: ['applications.get'],
      allowedApplicationCaseIds: ['Case-ABC'], expiresInMs: 1_000,
    });
    expect(authority.verify(token, {
      runId: 'run-case', providerId: 'fake', toolName: 'applications.get', applicationCaseId: 'Case-ABC',
    }).allowedApplicationCaseIds).toEqual(['Case-ABC']);
    for (const mutation of ['case-abc', 'CASE-ABC', 'Case-ABC ', 'Case-AB']) {
      expect(() => authority.verify(token, {
        runId: 'run-case', providerId: 'fake', toolName: 'applications.get', applicationCaseId: mutation,
      }), mutation).toThrow('application_case_not_allowed');
    }
  });
});
