import { describe, expect, it } from 'vitest';
import { AgentPolicyEngine, enforceSandboxProfile, RISK_CLASSES, type PolicyRequest, type ToolPolicyRule } from './security-policy.js';

const rules: ToolPolicyRule[] = [
  { toolName: 'jobs.list', risk: 'read', actionClass: 'read', requiresApproval: false },
  { toolName: 'applications.get', risk: 'sensitive_read', actionClass: 'read', requiresApplicationCaseScope: true },
  { toolName: 'document.save', risk: 'local_write', actionClass: 'execute', requiresApplicationCaseScope: true },
  { toolName: 'mail.send', risk: 'external_write', actionClass: 'execute', requiresApplicationCaseScope: true, operation: 'send_message' },
  { toolName: 'artifact.mark_used', risk: 'local_write', actionClass: 'execute', requiresApplicationCaseScope: true, operation: 'mark_artifact_used' },
  { toolName: 'remote.fetch', risk: 'network', actionClass: 'execute', allowedNetworkDomains: ['api.example.test'] },
  { toolName: 'data.delete', risk: 'destructive', actionClass: 'execute', operation: 'delete_data' },
];

const base: PolicyRequest = {
  runId: 'run-1', providerId: 'fake', toolName: 'jobs.list', actionClass: 'read', runProfile: 'read_only_offline',
  identityMode: 'real', allowedTools: rules.map((rule) => rule.toolName), allowedApplicationCaseIds: ['case-1'],
};

describe('AgentPolicyEngine', () => {
  const policy = new AgentPolicyEngine(rules);

  it('is deny-by-default and prevents caller risk downgrades', () => {
    expect(policy.evaluate({ ...base, toolName: 'shell.execute', actionClass: 'execute' }).outcome).toBe('deny');
    const downgrade = policy.evaluate({
      ...base, toolName: 'document.save', actionClass: 'execute', requestedRisk: 'read',
      runProfile: 'workspace_write_offline', applicationCaseId: 'case-1', hasValidApproval: true,
    });
    expect(downgrade.outcome).toBe('deny');
    expect(downgrade.reasonCodes).toContain('risk_mismatch');
  });

  it('allows simple scoped reads and requires approval for every other risk class', () => {
    expect(policy.evaluate(base).outcome).toBe('allow');
    for (const risk of RISK_CLASSES.filter((entry) => entry !== 'read')) {
      const tool = rules.find((rule) => rule.risk === risk)!;
      const request: PolicyRequest = {
        ...base, toolName: tool.toolName, actionClass: tool.actionClass,
        requestedRisk: risk, runProfile: risk === 'network' ? 'workspace_write_limited_network' : 'workspace_write_offline',
        applicationCaseId: tool.requiresApplicationCaseScope ? 'case-1' : undefined,
        networkDomain: risk === 'network' ? 'api.example.test' : undefined,
        networkGrant: risk === 'network' ? { domains: ['api.example.test'], expiresAt: '2030-01-01T00:00:00.000Z' } : undefined,
        now: new Date('2029-01-01T00:00:00.000Z'),
      };
      expect(policy.evaluate(request).outcome, risk).toBe('requires_approval');
    }
  });

  it('blocks guessed application cases and mismatched action classes', () => {
    const result = policy.evaluate({
      ...base, toolName: 'applications.get', actionClass: 'execute', requestedRisk: 'sensitive_read',
      applicationCaseId: 'case-guessed', hasValidApproval: true,
    });
    expect(result.outcome).toBe('deny');
    expect(result.reasonCodes).toEqual(expect.arrayContaining(['action_class_mismatch', 'application_case_out_of_scope']));
  });

  it.each(['mail.send', 'artifact.mark_used'] as const)('blocks %s server-side in incognito mode', (toolName) => {
    const result = policy.evaluate({
      ...base, toolName, actionClass: 'execute', requestedRisk: toolName === 'mail.send' ? 'external_write' : 'local_write',
      runProfile: 'workspace_write_offline', identityMode: 'incognito', applicationCaseId: 'case-1', hasValidApproval: true,
    });
    expect(result.outcome).toBe('deny');
    expect(result.reasonCodes).toContain('incognito_external_action_blocked');
  });

  it('requires target-bound, unexpired network grants', () => {
    const request: PolicyRequest = {
      ...base, toolName: 'remote.fetch', actionClass: 'execute', requestedRisk: 'network',
      runProfile: 'workspace_write_limited_network', networkDomain: 'api.example.test',
      networkGrant: { domains: ['other.example.test'], expiresAt: '2029-01-01T00:00:00.000Z' },
      now: new Date('2029-01-02T00:00:00.000Z'), hasValidApproval: true,
    };
    const result = policy.evaluate(request);
    expect(result.outcome).toBe('deny');
    expect(result.reasonCodes).toEqual(expect.arrayContaining(['network_target_not_allowed', 'network_grant_expired']));
  });

  it('lets emergency stop block side effects but not local read-only diagnosis', () => {
    expect(policy.evaluate({ ...base, emergencyStop: true }).outcome).toBe('allow');
    const write = policy.evaluate({
      ...base, toolName: 'document.save', actionClass: 'execute', runProfile: 'workspace_write_offline',
      applicationCaseId: 'case-1', hasValidApproval: true, emergencyStop: true,
    });
    expect(write.outcome).toBe('deny');
    expect(write.reasonCodes).toContain('emergency_stop');
  });
});

describe('sandbox enforcement proof', () => {
  it('accepts an equal-or-stricter effective profile', async () => {
    const result = await enforceSandboxProfile({
      id: 'test',
      async enforce(requested) {
        return { requested, effective: 'read_only_offline', workspaceAccess: 'read_only', network: 'none', allowedDomains: [], enforcedBy: 'test' };
      },
    }, 'workspace_write_offline');
    expect(result.effective).toBe('read_only_offline');
  });

  it('blocks missing enforcement and broader network access', async () => {
    await expect(enforceSandboxProfile({ id: 'none', async enforce() { return undefined; } }, 'read_only_offline'))
      .rejects.toThrow('sandbox_profile_not_enforceable');
    await expect(enforceSandboxProfile({
      id: 'broad',
      async enforce(requested) {
        return { requested, effective: 'isolated_full', workspaceAccess: 'read_write', network: 'isolated', allowedDomains: ['evil.example'], enforcedBy: 'bad' };
      },
    }, 'workspace_write_limited_network', ['api.example.test'])).rejects.toThrow('sandbox_effective_policy_broader');
  });
});
