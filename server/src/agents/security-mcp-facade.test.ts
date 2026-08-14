import { describe, expect, it, vi } from 'vitest';
import { ApprovalQueue } from './security-approval.js';
import { AGENT_MCP_TOOL_CATALOG, RestrictedAgentMcpFacade, type AgentMcpRunScope } from './security-mcp-facade.js';
import { AgentPolicyEngine, type ToolPolicyRule } from './security-policy.js';

const policyRules: ToolPolicyRule[] = AGENT_MCP_TOOL_CATALOG.map((tool) => ({
  toolName: tool.name,
  risk: tool.risk,
  actionClass: tool.category,
  requiresApproval: tool.requiresApproval,
  requiresApplicationCaseScope: tool.requiresApplicationCaseScope,
}));

function setup() {
  let revision = 3;
  const jobs = {
    search: vi.fn(async () => ({
      items: [{ id: 'job-1', title: 'Engineer', company: 'Example GmbH', sourceId: 'demo', sourceReference: 'demo:job-1', version: '1' }],
      page: 0, pageSize: 10, hasMore: false,
    })),
  };
  const applications = {
    get: vi.fn(async (id: string, view: 'masked' | 'sensitive') => id === 'case-1' ? {
      id, revision, jobId: 'job-1', companyId: 'company-1', status: 'draft', identityMode: 'real' as const,
      sourceReferences: ['case:case-1'], safeSummary: view === 'sensitive' ? 'Sensitive' : 'Masked',
    } : undefined),
    currentRevision: vi.fn(async (id: string) => id === 'case-1' ? revision : undefined),
  };
  const messages = {
    list: vi.fn(async (input: { applicationCaseId: string; page: number; pageSize: number; view: 'masked' | 'sensitive' }) => ({
      items: [{
        id: 'mail-1', applicationCaseId: input.applicationCaseId, receivedAt: '2029-01-01T00:00:00.000Z', senderDomain: 'example.test',
        subject: input.view === 'sensitive' ? 'Interview' : undefined, contentPreview: input.view === 'sensitive' ? 'Private body' : undefined,
        sourceReference: 'mail:1',
      }], page: input.page, pageSize: input.pageSize, hasMore: false,
    })),
  };
  const proposalPort = {
    propose: vi.fn(async (input: { kind: string }) => ({ payload: { recommended: input.kind }, sourceReferences: ['mail:1'] })),
  };
  const commandPort = {
    preview: vi.fn(async () => ({ changes: [{ field: 'status', from: 'draft', to: 'interview' }] })),
    execute: vi.fn(async () => ({ revision: ++revision, result: { changed: true } })),
  };
  const pipeline = {
    analyze: vi.fn(async () => ({ payload: { matchedClaims: ['claim-1'] }, sourceReferences: ['claim:1', 'job:1'] })),
    proposeDocumentRevision: vi.fn(async () => ({ payload: { artifact: 'proposal' }, sourceReferences: ['claim:1'] })),
  };
  const approvals = new ApprovalQueue(Buffer.alloc(32, 9), () => new Date('2029-01-01T00:00:00.000Z'));
  const approve = (toolName: string, args: unknown, target = `application-case:${(args as { applicationCaseId?: string }).applicationCaseId}`) => {
    const risk = AGENT_MCP_TOOL_CATALOG.find((tool) => tool.name === toolName)!.risk;
    return approvals.approve(approvals.request({
      runId: 'run-1', toolName, target, parameters: args, parameterPreview: { reviewed: true }, risk,
    }).id, 'local-user');
  };
  const facade = new RestrictedAgentMcpFacade(new AgentPolicyEngine(policyRules), jobs, applications, messages, proposalPort, commandPort, pipeline, undefined, approvals);
  return { facade, jobs, applications, messages, proposalPort, commandPort, pipeline, approve };
}

const allTools = AGENT_MCP_TOOL_CATALOG.map((tool) => tool.name);
const scope: AgentMcpRunScope = {
  runId: 'run-1', providerId: 'fake', identityMode: 'real', sandboxProfile: 'workspace_write_offline',
  allowedTools: allTools, allowedApplicationCaseIds: ['case-1'], sensitiveReadApproved: false,
};

describe('restricted MCP catalog', () => {
  it('publishes versioned risk metadata and intentionally exposes no send/submit/shell/login tool', () => {
    const names = AGENT_MCP_TOOL_CATALOG.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(AGENT_MCP_TOOL_CATALOG.every((tool) => /^\d+\.\d+\.\d+$/.test(tool.version))).toBe(true);
    expect(names.some((name) => /send|submit|shell|login|credential/i.test(name))).toBe(false);
    expect(AGENT_MCP_TOOL_CATALOG.filter((tool) => tool.category === 'execute').every((tool) => tool.requiresApproval)).toBe(true);
  });

  it('only advertises tools granted to this run', () => {
    const { facade } = setup();
    expect(facade.listTools({ ...scope, allowedTools: ['jobs.search'] }).map((tool) => tool.name)).toEqual(['jobs.search']);
  });
});

describe('RestrictedAgentMcpFacade', () => {
  it('paginates read tools and masks sensitive content when scope lacks sensitive view', async () => {
    const { facade, messages, approve } = setup();
    const jobs = await facade.call(scope, { name: 'jobs.search', arguments: { profileId: 'profile-1', page: 0, pageSize: 10 } });
    expect(jobs.sourceReferences).toEqual(['demo:job-1']);
    const mailArgs = { applicationCaseId: 'case-1', page: 0, pageSize: 10 };
    const mail = await facade.call(scope, { name: 'messages.list', arguments: mailArgs, approvalToken: approve('messages.list', mailArgs) });
    expect(JSON.stringify(mail.data)).not.toContain('Private body');
    expect(messages.list).toHaveBeenCalledWith(expect.objectContaining({ view: 'masked' }));
  });

  it('blocks unknown tools, ungranted tools, missing approvals and guessed cases before a port call', async () => {
    const { facade, applications } = setup();
    await expect(facade.call(scope, { name: 'shell.execute', arguments: {} })).rejects.toThrow('mcp_tool_unknown');
    await expect(facade.call({ ...scope, allowedTools: ['jobs.search'] }, {
      name: 'applications.get', arguments: { applicationCaseId: 'case-1' },
    })).rejects.toThrow('tool_not_in_run_scope');
    await expect(facade.call(scope, { name: 'applications.get', arguments: { applicationCaseId: 'case-1' } }))
      .rejects.toThrow('requires_approval');
    await expect(facade.call(scope, {
      name: 'applications.get', arguments: { applicationCaseId: 'case-guessed' },
    })).rejects.toThrow('application_case_out_of_scope');
    expect(applications.get).not.toHaveBeenCalled();
  });

  it('keeps agent suggestions non-authoritative and uses the application pipeline proxy', async () => {
    const { facade, commandPort, pipeline } = setup();
    const analysis = await facade.call(scope, {
      name: 'application.analyze', arguments: { applicationCaseId: 'case-1', documentType: 'cv' },
    });
    expect(analysis.category).toBe('propose');
    expect(analysis.data).toMatchObject({ kind: 'application_analysis', applicationCaseId: 'case-1', runId: 'run-1' });
    expect(pipeline.analyze).toHaveBeenCalledOnce();
    expect(commandPort.execute).not.toHaveBeenCalled();
  });

  it('requires separate confirm/execute approvals, expected revision and idempotency key', async () => {
    const { facade, commandPort, approve } = setup();
    const proposal = await facade.call(scope, {
      name: 'application.status.propose', arguments: { applicationCaseId: 'case-1', status: 'interview' },
    });
    const proposalId = (proposal.data as { proposalId: string }).proposalId;
    const conflictingArgs = { applicationCaseId: 'case-1', proposalId, expectedRevision: 2, idempotencyKey: 'idem-1' };
    await expect(facade.call(scope, {
      name: 'domain.command.confirm', arguments: conflictingArgs,
      approvalToken: approve('domain.command.confirm', conflictingArgs),
    })).rejects.toThrow('optimistic_concurrency_conflict');
    const confirmArgs = { applicationCaseId: 'case-1', proposalId, expectedRevision: 3, idempotencyKey: 'idem-1' };
    const confirmed = await facade.call(scope, {
      name: 'domain.command.confirm', arguments: confirmArgs, approvalToken: approve('domain.command.confirm', confirmArgs),
    });
    const commandId = (confirmed.data as { commandId: string }).commandId;
    await expect(facade.call(scope, {
      name: 'domain.command.execute_local', arguments: { applicationCaseId: 'case-1', commandId, expectedRevision: 3, idempotencyKey: 'idem-1' },
    })).rejects.toThrow('requires_approval');
    const executeArgs = { applicationCaseId: 'case-1', commandId, expectedRevision: 3, idempotencyKey: 'idem-1' };
    const executed = await facade.call(scope, {
      name: 'domain.command.execute_local', arguments: executeArgs, approvalToken: approve('domain.command.execute_local', executeArgs),
    });
    expect(executed.data).toMatchObject({ duplicate: false, revision: 4 });
    const duplicate = await facade.call(scope, {
      name: 'domain.command.execute_local', arguments: executeArgs, approvalToken: approve('domain.command.execute_local', executeArgs),
    });
    expect(duplicate.data).toMatchObject({ duplicate: true, revision: 4 });
    expect(commandPort.execute).toHaveBeenCalledOnce();
  });

  it('does not let an idempotency key replay a different command', async () => {
    const { facade, approve } = setup();
    const proposal = await facade.call(scope, { name: 'application.status.propose', arguments: { applicationCaseId: 'case-1', status: 'interview' } });
    const confirmArgs = { applicationCaseId: 'case-1', proposalId: (proposal.data as { proposalId: string }).proposalId, expectedRevision: 3, idempotencyKey: 'idem-1' };
    const confirmed = await facade.call(scope, {
      name: 'domain.command.confirm', arguments: confirmArgs, approvalToken: approve('domain.command.confirm', confirmArgs),
    });
    const commandId = (confirmed.data as { commandId: string }).commandId;
    const executeArgs = { applicationCaseId: 'case-1', commandId, expectedRevision: 3, idempotencyKey: 'idem-1' };
    await facade.call(scope, { name: 'domain.command.execute_local', arguments: executeArgs, approvalToken: approve('domain.command.execute_local', executeArgs) });
    const differentArgs = { applicationCaseId: 'case-1', commandId: 'different', expectedRevision: 3, idempotencyKey: 'idem-1' };
    await expect(facade.call(scope, {
      name: 'domain.command.execute_local', arguments: differentArgs, approvalToken: approve('domain.command.execute_local', differentArgs),
    })).rejects.toThrow('idempotency_key_reused_for_different_command');
  });
});
