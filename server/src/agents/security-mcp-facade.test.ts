import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { JsonDomainCommandExecutionStore, type DomainCommandExecutionStore } from './domain-command-execution-store.js';
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

function setup(commandExecutions?: DomainCommandExecutionStore, state = { revision: 3 }) {
  const jobs = {
    search: vi.fn(async () => ({
      items: [{ id: 'job-1', title: 'Engineer', company: 'Example GmbH', sourceId: 'demo', sourceReference: 'demo:job-1', version: '1' }],
      page: 0, pageSize: 10, hasMore: false,
    })),
  };
  const applications = {
    get: vi.fn(async (id: string, view: 'masked' | 'sensitive') => id === 'case-1' ? {
      id, revision: state.revision, jobId: 'job-1', companyId: 'company-1', status: 'draft', identityMode: 'real' as const,
      sourceReferences: ['case:case-1'], safeSummary: view === 'sensitive' ? 'Sensitive' : 'Masked',
    } : undefined),
    currentRevision: vi.fn(async (id: string) => id === 'case-1' ? state.revision : undefined),
    getCompany: vi.fn(async (input: { applicationCaseId: string; companyId: string }) =>
      input.applicationCaseId === 'case-1' && input.companyId === 'company-1' ? {
        id: 'company-1', name: 'Example GmbH', version: 'company-version:1',
        applicationCases: [{
          id: 'case-1', jobId: 'job-1', jobTitle: 'Engineer', status: 'draft', revision: state.revision,
          sourceReference: 'application:case-1',
        }],
        sourceReferences: ['company:company-1', 'application:case-1'],
      } : undefined),
    listTracking: vi.fn(async (input: { applicationCaseId: string; page: number; pageSize: number }) => ({
      items: [{
        id: 'tracking-event:1', status: 'planned', occurredAt: '2029-01-01T00:00:00.000Z',
        source: 'user' as const, version: 'tracking-version:1', sourceReference: 'tracking:1',
      }],
      page: input.page, pageSize: input.pageSize, hasMore: false, applicationCaseRevision: state.revision,
      sourceReferences: ['application:case-1', 'tracking:1'],
    })),
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
    preview: vi.fn(async (input: { proposal: { proposalId: string; payloadHash: string; applicationCaseId: string } }) => ({
      prepared: {
        kind: 'application_status' as const, execution: 'local_write' as const,
        applicationCaseId: input.proposal.applicationCaseId, proposalId: input.proposal.proposalId,
        proposalPayloadHash: input.proposal.payloadHash, from: 'draft', target: 'interview',
      },
      dryRun: { changes: [{ field: 'status', from: 'draft', to: 'interview' }] },
    })),
    execute: vi.fn(async () => ({ revision: ++state.revision, result: { changed: true } })),
  };
  const pipeline = {
    analyze: vi.fn(async () => ({ payload: { matchedClaims: ['claim-1'] }, sourceReferences: ['claim:1', 'job:1'] })),
    audit: vi.fn(async (input: { applicationCaseId: string; documentType: 'cv' | 'cover_letter' | 'email' }) => ({
      payload: {
        contract: 'application-pipeline-root-proxy', contractVersion: '1.0',
        applicationCaseId: input.applicationCaseId, applicationCaseRevision: state.revision,
        jobId: 'job-1', documentType: input.documentType,
        upstream: {
          contract: 'bewerbungs-pipeline', contractVersion: '1.0', compatible: true, networkRequired: false,
        },
        sourceVersion: {
          applicationCaseRevision: state.revision, jobSnapshotSha256: 'a'.repeat(64),
          analysisVersion: 'analysis-v1', analysisSourceSha256: 'b'.repeat(64), pipelineContractVersion: '1.0',
        },
        jobAnalysis: {
          contract: 'bewerbungs-pipeline', contract_version: '1.0', analysis_version: 'analysis-v1',
          source_sha256: 'b'.repeat(64), job: { id: 'job-1' }, requirements: [],
        },
        matchMatrix: { contract: 'bewerbungs-pipeline', contract_version: '1.0', matches: [] },
        validation: { valid: true, errors: [] },
        finalization: {
          executable: false, route: 'approved-artifact-review-adoption',
          proofContract: 'application-pipeline-proof@1.0',
        },
      },
      sourceReferences: ['application:case-1', 'pipeline-contract:v1'],
    })),
    proposeDocumentRevision: vi.fn(async () => ({ payload: { artifact: 'proposal' }, sourceReferences: ['claim:1'] })),
  };
  const jobSearch = {
    capabilities: vi.fn(async (input: { runId: string }) => ({
      contract: 'job-search-root-proxy', contractVersion: '1.0', upstreamContractVersion: '1.0',
      compatible: true, executionIsolation: 'trusted-host', allowedOperations: ['capabilities', 'search'],
      sources: [{
        id: 'stepstone', name: 'StepStone', enabled: true, access: 'browser', filters: ['query', 'location'],
        pagination: false, policyStatus: 'configured', authenticationRequiredForSearch: true,
      }], runId: input.runId,
    })),
    callAllowedTool: vi.fn(async () => ({
      items: [{
        id: `job-id:${'a'.repeat(64)}`, title: 'Engineer', company: 'Example GmbH', location: 'Berlin', sourceId: 'stepstone',
        sourceReference: `job:${'b'.repeat(64)}`, version: '2029-01-01T00:00:00.000Z',
      }], page: 0, pageSize: 10, hasMore: false, failures: [], snapshotReference: `job-search-snapshot:${'c'.repeat(64)}`,
    })),
  };
  const approvals = new ApprovalQueue(Buffer.alloc(32, 9), () => new Date('2029-01-01T00:00:00.000Z'));
  const approve = (toolName: string, args: unknown, target = `application-case:${(args as { applicationCaseId?: string }).applicationCaseId}`) => {
    const risk = AGENT_MCP_TOOL_CATALOG.find((tool) => tool.name === toolName)!.risk;
    return approvals.approve(approvals.request({
      runId: 'run-1', toolName, target, parameters: args, parameterPreview: { reviewed: true }, risk,
    }).id, 'local-user');
  };
  const facade = new RestrictedAgentMcpFacade(
    new AgentPolicyEngine(policyRules), jobs, applications, messages, proposalPort, commandPort,
    pipeline, jobSearch, approvals, commandExecutions,
  );
  return { facade, jobs, applications, messages, proposalPort, commandPort, pipeline, jobSearch, approve };
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
    expect(names.some((name) => /finalize|claim|raw.?path/i.test(name))).toBe(false);
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

  it('binds minimized company and tracking reads to the approved case and company scope', async () => {
    const { facade, applications, approve } = setup();
    const companyArgs = { applicationCaseId: 'case-1', companyId: 'company-1' };
    const company = await facade.call(scope, {
      name: 'companies.get', arguments: companyArgs, approvalToken: approve('companies.get', companyArgs),
    });
    expect(company.data).toMatchObject({
      id: 'company-1', applicationCases: [{ id: 'case-1', revision: 3 }],
    });
    expect(applications.getCompany).toHaveBeenCalledWith(expect.objectContaining({
      allowedApplicationCaseIds: ['case-1'],
    }));

    const trackingArgs = { applicationCaseId: 'case-1', page: 0, pageSize: 10 };
    const tracking = await facade.call(scope, {
      name: 'application.tracking.list', arguments: trackingArgs,
      approvalToken: approve('application.tracking.list', trackingArgs),
    });
    expect(tracking.data).toMatchObject({ applicationCaseRevision: 3, items: [{ status: 'planned' }] });
    expect(JSON.stringify(tracking.data)).not.toMatch(/note|mail|identity/i);

    const guessedArgs = { applicationCaseId: 'case-guessed', companyId: 'company-1' };
    await expect(facade.call(scope, {
      name: 'companies.get', arguments: guessedArgs,
      approvalToken: approve('companies.get', guessedArgs, 'application-case:case-guessed'),
    })).rejects.toThrow('application_case_out_of_scope');
  });

  it('mediates only minimized trusted-host capabilities and paged active-profile search', async () => {
    const { facade, jobSearch } = setup();
    const capabilities = await facade.call(scope, { name: 'job_search.capabilities', arguments: {} });
    expect(capabilities.data).toMatchObject({
      contract: 'job-search-root-proxy', executionIsolation: 'trusted-host',
      allowedOperations: ['capabilities', 'search'],
    });
    expect(JSON.stringify(capabilities)).not.toMatch(/portal_login|credential|password/i);

    const search = await facade.call(scope, {
      name: 'job_search.search', arguments: { profileId: 'active', page: 0, pageSize: 10 },
    });
    expect(search.sourceReferences).toEqual([`job-search-snapshot:${'c'.repeat(64)}`, `job:${'b'.repeat(64)}`]);
    expect(jobSearch.callAllowedTool).toHaveBeenCalledWith({
      name: 'search', arguments: { profileId: 'active', page: 0, pageSize: 10 }, runId: 'run-1',
    });
  });

  it('rejects scope-broadening or credential-shaped search arguments before the proxy boundary', async () => {
    const { facade, jobSearch } = setup();
    await expect(facade.call(scope, {
      name: 'job_search.search',
      arguments: { profileId: 'active', page: 0, pageSize: 10, portal_login: { username: 'x', password: 'y' } },
    })).rejects.toThrow('additional_properties');
    await expect(facade.call(scope, {
      name: 'job_search.search', arguments: { profileId: 'foreign', page: 0, pageSize: 10 },
    })).rejects.toThrow('profile_out_of_scope');
    expect(jobSearch.callAllowedTool).not.toHaveBeenCalled();
  });

  it('fails closed on malformed trusted-host proxy results', async () => {
    const { facade, jobSearch } = setup();
    jobSearch.callAllowedTool.mockResolvedValueOnce({
      items: [{ id: 'job-1', title: 'Engineer', company: '', location: 'Berlin', sourceId: 'stepstone', sourceReference: 'job:1', version: '1' }],
      page: 0, pageSize: 10, hasMore: false, failures: [], snapshotReference: 'snapshot:1',
    });
    await expect(facade.call(scope, {
      name: 'job_search.search', arguments: { profileId: 'active', page: 0, pageSize: 10 },
    })).rejects.toThrow('result_invalid');
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

  it('audits only a server-built, case-bound Evidence matrix and keeps finalization non-executable', async () => {
    const { facade, pipeline, commandPort, approve } = setup();
    const auditArgs = { applicationCaseId: 'case-1', documentType: 'cv' as const };
    await expect(facade.call(scope, {
      name: 'application.pipeline.audit', arguments: auditArgs,
    })).rejects.toThrow('requires_approval');
    const audit = await facade.call(scope, {
      name: 'application.pipeline.audit', arguments: auditArgs,
      approvalToken: approve('application.pipeline.audit', auditArgs),
    });
    expect(audit).toMatchObject({
      category: 'read',
      data: {
        contract: 'application-pipeline-root-proxy', contractVersion: '1.0',
        applicationCaseId: 'case-1', applicationCaseRevision: 3,
        validation: { valid: true, errors: [] },
        finalization: {
          executable: false, route: 'approved-artifact-review-adoption',
          proofContract: 'application-pipeline-proof@1.0',
        },
      },
      sourceReferences: ['application:case-1', 'pipeline-contract:v1'],
    });
    expect(pipeline.audit).toHaveBeenCalledWith(auditArgs);
    expect(commandPort.preview).not.toHaveBeenCalled();
    expect(commandPort.execute).not.toHaveBeenCalled();
  });

  it('rejects finalize, claim and raw-path input bypasses before any application-pipeline port call', async () => {
    const { facade, pipeline, approve } = setup();
    await expect(facade.call(scope, {
      name: 'application.pipeline.finalize', arguments: { applicationCaseId: 'case-1' },
    })).rejects.toThrow('mcp_tool_unknown');
    await expect(facade.call(scope, {
      name: 'application.analyze',
      arguments: { applicationCaseId: 'case-1', documentType: 'cv', candidateProfilePath: 'C:\\private\\candidate.yaml' },
    })).rejects.toThrow('additional_properties');
    const poisonedAudit = {
      applicationCaseId: 'case-1', documentType: 'cv', matchMatrix: { matches: [] },
      claims: [{ id: 'forged' }], rawPath: 'C:\\private\\candidate.yaml', finalize: true,
    };
    await expect(facade.call(scope, {
      name: 'application.pipeline.audit', arguments: poisonedAudit,
      approvalToken: approve('application.pipeline.audit', poisonedAudit),
    })).rejects.toThrow('additional_properties');
    await expect(facade.call(scope, {
      name: 'document.revision.propose',
      arguments: { applicationCaseId: 'case-1', documentType: 'cv', finalize: true },
    })).rejects.toThrow('additional_properties');
    expect(pipeline.analyze).not.toHaveBeenCalled();
    expect(pipeline.audit).not.toHaveBeenCalled();
    expect(pipeline.proposeDocumentRevision).not.toHaveBeenCalled();
  });

  it('fails closed when a pipeline proxy tries to mark an audit as executable', async () => {
    const { facade, pipeline, approve } = setup();
    const args = { applicationCaseId: 'case-1', documentType: 'cv' as const };
    const baseline = await pipeline.audit(args);
    pipeline.audit.mockResolvedValueOnce({
      ...baseline,
      payload: {
        ...(baseline.payload as Record<string, unknown>),
        finalization: {
          executable: true, route: 'direct', proofContract: 'agent-forged',
        },
      } as unknown as typeof baseline.payload,
    });
    await expect(facade.call(scope, {
      name: 'application.pipeline.audit', arguments: args,
      approvalToken: approve('application.pipeline.audit', args),
    })).rejects.toThrow('audit_invalid:finalization');
  });

  it('declares document revisions proposal-only and refuses confirm instead of bypassing artifact review', async () => {
    const { facade, commandPort, approve } = setup();
    const descriptor = AGENT_MCP_TOOL_CATALOG.find((tool) => tool.name === 'document.revision.propose');
    expect(descriptor).toMatchObject({ executionMode: 'proposal_only', externalSideEffect: false });
    const proposal = await facade.call(scope, {
      name: 'document.revision.propose', arguments: { applicationCaseId: 'case-1', documentType: 'cv' },
    });
    const confirmArgs = {
      applicationCaseId: 'case-1', proposalId: (proposal.data as { proposalId: string }).proposalId,
      expectedRevision: 3, idempotencyKey: 'document-0001',
    };
    await expect(facade.call(scope, {
      name: 'domain.command.confirm', arguments: confirmArgs,
      approvalToken: approve('domain.command.confirm', confirmArgs),
    })).rejects.toThrow('proposal_only_use_artifact_review_api');
    expect(commandPort.preview).not.toHaveBeenCalled();
    expect(commandPort.execute).not.toHaveBeenCalled();
  });

  it('requires separate confirm/execute approvals, expected revision and idempotency key', async () => {
    const { facade, commandPort, approve } = setup();
    const proposal = await facade.call(scope, {
      name: 'application.status.propose', arguments: { applicationCaseId: 'case-1', status: 'interview' },
    });
    const proposalId = (proposal.data as { proposalId: string }).proposalId;
    const conflictingArgs = { applicationCaseId: 'case-1', proposalId, expectedRevision: 2, idempotencyKey: 'idem-0001' };
    await expect(facade.call(scope, {
      name: 'domain.command.confirm', arguments: conflictingArgs,
      approvalToken: approve('domain.command.confirm', conflictingArgs),
    })).rejects.toThrow('optimistic_concurrency_conflict');
    const confirmArgs = { applicationCaseId: 'case-1', proposalId, expectedRevision: 3, idempotencyKey: 'idem-0001' };
    const confirmed = await facade.call(scope, {
      name: 'domain.command.confirm', arguments: confirmArgs, approvalToken: approve('domain.command.confirm', confirmArgs),
    });
    const commandId = (confirmed.data as { commandId: string }).commandId;
    await expect(facade.call(scope, {
      name: 'domain.command.execute_local', arguments: { applicationCaseId: 'case-1', commandId, expectedRevision: 3, idempotencyKey: 'idem-0001' },
    })).rejects.toThrow('requires_approval');
    const executeArgs = { applicationCaseId: 'case-1', commandId, expectedRevision: 3, idempotencyKey: 'idem-0001' };
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
    const confirmArgs = { applicationCaseId: 'case-1', proposalId: (proposal.data as { proposalId: string }).proposalId, expectedRevision: 3, idempotencyKey: 'idem-0001' };
    const confirmed = await facade.call(scope, {
      name: 'domain.command.confirm', arguments: confirmArgs, approvalToken: approve('domain.command.confirm', confirmArgs),
    });
    const commandId = (confirmed.data as { commandId: string }).commandId;
    const executeArgs = { applicationCaseId: 'case-1', commandId, expectedRevision: 3, idempotencyKey: 'idem-0001' };
    await facade.call(scope, { name: 'domain.command.execute_local', arguments: executeArgs, approvalToken: approve('domain.command.execute_local', executeArgs) });
    const differentArgs = { applicationCaseId: 'case-1', commandId: 'different', expectedRevision: 3, idempotencyKey: 'idem-0001' };
    await expect(facade.call(scope, {
      name: 'domain.command.execute_local', arguments: differentArgs, approvalToken: approve('domain.command.execute_local', differentArgs),
    })).rejects.toThrow('idempotency_key_reused_for_different_command');
  });

  it('replays a completed command after facade restart without executing the port twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-command-restart-'));
    const commandExecutions = new JsonDomainCommandExecutionStore(root);
    const state = { revision: 3 };
    const first = setup(commandExecutions, state);
    const proposal = await first.facade.call(scope, {
      name: 'application.status.propose', arguments: { applicationCaseId: 'case-1', status: 'interview' },
    });
    const confirmArgs = {
      applicationCaseId: 'case-1', proposalId: (proposal.data as { proposalId: string }).proposalId,
      expectedRevision: 3, idempotencyKey: 'restart-0001',
    };
    const confirmed = await first.facade.call(scope, {
      name: 'domain.command.confirm', arguments: confirmArgs,
      approvalToken: first.approve('domain.command.confirm', confirmArgs),
    });
    const executeArgs = {
      applicationCaseId: 'case-1', commandId: (confirmed.data as { commandId: string }).commandId,
      expectedRevision: 3, idempotencyKey: 'restart-0001',
    };
    await first.facade.call(scope, {
      name: 'domain.command.execute_local', arguments: executeArgs,
      approvalToken: first.approve('domain.command.execute_local', executeArgs),
    });
    expect(first.commandPort.execute).toHaveBeenCalledOnce();

    const restarted = setup(new JsonDomainCommandExecutionStore(root), state);
    const replay = await restarted.facade.call(scope, {
      name: 'domain.command.execute_local', arguments: executeArgs,
      approvalToken: restarted.approve('domain.command.execute_local', executeArgs),
    });
    expect(replay.data).toMatchObject({ duplicate: true, revision: 4 });
    expect(restarted.commandPort.execute).not.toHaveBeenCalled();
  });
});
