import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalQueue, RunCapabilityAuthority } from './agents/security-approval.js';
import { MemoryDomainCommandExecutionStore } from './agents/domain-command-execution-store.js';
import { createRunBoundAgentMcpSession, type RunBoundAgentMcpPorts, type RunBoundAgentMcpSession } from './agent-mcp-run-factory.js';

const open: Array<{ session: RunBoundAgentMcpSession; client: Client }> = [];

async function connect(session: RunBoundAgentMcpSession): Promise<Client> {
  const client = new Client({ name: 'run-bound-offline-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([session.server.server.connect(serverTransport), client.connect(clientTransport)]);
  open.push({ session, client });
  return client;
}

afterEach(async () => {
  await Promise.all(open.splice(0).flatMap(({ session, client }) => [client.close(), session.server.close()]));
});

function setup(allowedTools: string[], allowedApplicationCaseIds = ['case-1']) {
  let current = new Date('2029-01-01T00:00:00.000Z');
  const clock = () => current;
  const jobs = {
    search: vi.fn(async (input: { page: number; pageSize: number }) => ({
      items: [{
        id: 'job-1', title: 'Engineer', company: 'Example GmbH', sourceId: 'synthetic',
        sourceReference: 'job:job-1', version: '1',
      }],
      page: input.page, pageSize: input.pageSize, hasMore: false,
    })),
  };
  const applications = {
    get: vi.fn(async (id: string, view: 'masked' | 'sensitive') => id === 'case-1' ? {
      id, revision: 2, jobId: 'job-1', companyId: 'company-1', status: 'draft', identityMode: 'real' as const,
      sourceReferences: ['case:case-1'], safeSummary: view === 'masked' ? 'Masked summary' : 'Sensitive summary',
    } : undefined),
    currentRevision: vi.fn(async (id: string) => id === 'case-1' ? 2 : undefined),
    getCompany: vi.fn(async (input: { applicationCaseId: string; companyId: string }) => ({
      id: input.companyId, name: 'Example GmbH', version: 'company-version:1',
      applicationCases: [{
        id: input.applicationCaseId, jobId: 'job-1', jobTitle: 'Engineer', status: 'draft', revision: 2,
        sourceReference: 'application:case-1',
      }],
      sourceReferences: ['company:company-1', 'application:case-1'],
    })),
    listTracking: vi.fn(async (input: { page: number; pageSize: number }) => ({
      items: [], page: input.page, pageSize: input.pageSize, hasMore: false, applicationCaseRevision: 2,
      sourceReferences: ['application:case-1'],
    })),
  };
  const messages = {
    list: vi.fn(async (input: { applicationCaseId: string; page: number; pageSize: number; view: 'masked' | 'sensitive' }) => ({
      items: [{
        id: 'mail-1', applicationCaseId: input.applicationCaseId, receivedAt: current.toISOString(),
        senderDomain: 'example.invalid', subject: input.view === 'masked' ? undefined : 'Private subject', sourceReference: 'mail:mail-1',
      }],
      page: input.page, pageSize: input.pageSize, hasMore: false,
    })),
  };
  const jobSearch = {
    capabilities: vi.fn(async () => ({
      contract: 'job-search-root-proxy', contractVersion: '1.0', upstreamContractVersion: '1.0', compatible: true,
      executionIsolation: 'trusted-host', allowedOperations: ['capabilities', 'search'],
      sources: [{
        id: 'stepstone', name: 'StepStone', enabled: true, access: 'browser', filters: ['query'], pagination: false,
        policyStatus: 'configured', authenticationRequiredForSearch: false,
      }],
    })),
    callAllowedTool: vi.fn(async (input: { name: 'search'; arguments: unknown; runId: string }) => {
      const args = input.arguments as { page: number; pageSize: number };
      return ({
      items: [{
        id: `job-id:${'a'.repeat(64)}`, title: 'Platform Engineer', company: 'Example GmbH', sourceId: 'stepstone',
        sourceReference: `job:${'b'.repeat(64)}`, version: '2029-01-01T00:00:00.000Z',
      }],
      page: args.page, pageSize: args.pageSize, hasMore: false, failures: [],
      snapshotReference: `job-search-snapshot:${'c'.repeat(64)}`,
    }); }),
  };
  const ports: RunBoundAgentMcpPorts = {
    jobs,
    applications,
    messages,
    proposals: { async propose() { return { payload: { proposed: true }, sourceReferences: ['case:case-1'] }; } },
    commands: {
      async preview(input) {
        return {
          prepared: {
            kind: 'application_status', execution: 'local_write',
            applicationCaseId: input.proposal.applicationCaseId, proposalId: input.proposal.proposalId,
            proposalPayloadHash: input.proposal.payloadHash, from: 'draft', target: 'review',
          },
          dryRun: { changes: [] },
        };
      },
      async execute() { return { revision: 3, result: { changed: true } }; },
    },
    applicationPipeline: {
      async analyze() { return { payload: { claims: [] }, sourceReferences: ['claim:claim-1'] }; },
      async audit(input) {
        return {
          payload: {
            contract: 'application-pipeline-root-proxy', contractVersion: '1.0',
            applicationCaseId: input.applicationCaseId, applicationCaseRevision: 2,
            jobId: 'job-1', documentType: input.documentType,
            upstream: {
              contract: 'bewerbungs-pipeline', contractVersion: '1.0', compatible: true, networkRequired: false,
            },
            sourceVersion: {
              applicationCaseRevision: 2, jobSnapshotSha256: 'a'.repeat(64), analysisVersion: 'analysis-v1',
              analysisSourceSha256: 'b'.repeat(64), pipelineContractVersion: '1.0',
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
        };
      },
      async proposeDocumentRevision() { return { payload: { draft: true }, sourceReferences: ['claim:claim-1'] }; },
    },
    jobSearch,
  };
  const capabilityAuthority = new RunCapabilityAuthority(Buffer.alloc(32, 7), clock);
  const approvalQueue = new ApprovalQueue(Buffer.alloc(32, 8), clock);
  const session = createRunBoundAgentMcpSession({
    context: {
      runId: 'run-1', providerId: 'fake', identityMode: 'real', sandboxProfile: 'workspace_write_offline',
      allowedTools, allowedApplicationCaseIds, capabilityTtlMs: 1_000,
    },
    ports, capabilityAuthority, approvalQueue, commandExecutionStore: new MemoryDomainCommandExecutionStore(), now: clock,
  });
  return {
    session, jobs, applications, messages, jobSearch,
    advance(ms: number) { current = new Date(current.getTime() + ms); },
  };
}

describe('run-bound Root MCP composition', () => {
  it('advertises only the server-granted run tools and retains normalized source references', async () => {
    const { session, jobs } = setup(['jobs.search']);
    const client = await connect(session);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['agent.health', 'agent.tool_catalog', 'jobs.search']));
    expect(names).not.toContain('applications.get');
    expect(names.some((name) => /shell|send|submit|login/i.test(name))).toBe(false);
    const result = await client.callTool({ name: 'jobs.search', arguments: { profileId: 'profile-1', page: 0, pageSize: 10 } });
    expect(result.isError).not.toBe(true);
    expect(result._meta).toEqual({ sourceReferences: ['job:job-1'] });
    expect(jobs.search).toHaveBeenCalledOnce();
    expect(session.auditEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'capability_issued', runId: 'run-1' }),
      expect.objectContaining({ action: 'tool_allowed', toolName: 'jobs.search', sourceReferences: ['job:job-1'] }),
    ]));
  });

  it('hashes complex source references before transport and audit', async () => {
    const { session, jobs } = setup(['jobs.search']);
    jobs.search.mockResolvedValueOnce({
      items: [{
        id: 'job-1', title: 'Engineer', company: 'Example GmbH', sourceId: 'synthetic',
        sourceReference: 'https://jobs.example.invalid/1?access_token=must-not-leak', version: '1',
      }],
      page: 0, pageSize: 10, hasMore: false,
    });
    const client = await connect(session);
    const result = await client.callTool({ name: 'jobs.search', arguments: { profileId: 'profile-1', page: 0, pageSize: 10 } });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(JSON.stringify(session.auditEvents())).not.toContain('must-not-leak');
    expect(result._meta).toEqual({ sourceReferences: [expect.stringMatching(/^source:/)] });
  });

  it('binds trusted-host proxy calls to the verified run capability and emits only normalized references', async () => {
    const { session, jobSearch } = setup(['job_search.search']);
    const client = await connect(session);
    const result = await client.callTool({
      name: 'job_search.search', arguments: { profileId: 'active', page: 0, pageSize: 10 },
    });
    expect(result.isError).not.toBe(true);
    expect(jobSearch.callAllowedTool).toHaveBeenCalledWith({
      name: 'search', arguments: { profileId: 'active', page: 0, pageSize: 10 }, runId: 'run-1',
    });
    expect(result._meta).toEqual({ sourceReferences: [`job-search-snapshot:${'c'.repeat(64)}`, `job:${'b'.repeat(64)}`] });
    expect(JSON.stringify(result)).not.toMatch(/portal_login|credential|password/i);
  });

  it('never crosses the trusted-host proxy boundary after capability expiry', async () => {
    const { session, jobSearch, advance } = setup(['job_search.search']);
    const client = await connect(session);
    advance(1_001);
    const result = await client.callTool({
      name: 'job_search.search', arguments: { profileId: 'active', page: 0, pageSize: 10 },
    });
    expect(result.isError).toBe(true);
    expect(jobSearch.callAllowedTool).not.toHaveBeenCalled();
  });

  it('blocks a foreign application case before any domain port or approval request', async () => {
    const { session, applications } = setup(['applications.get']);
    await expect(session.requestApproval({ name: 'applications.get', arguments: { applicationCaseId: 'case-foreign' } }))
      .rejects.toThrow('capability_application_case_not_allowed');
    const client = await connect(session);
    const result = await client.callTool({ name: 'applications.get', arguments: { applicationCaseId: 'case-foreign' } });
    expect(result.isError).toBe(true);
    expect(applications.get).not.toHaveBeenCalled();
  });

  it('checks capability expiry on every call', async () => {
    const { session, jobs, advance } = setup(['jobs.search']);
    const client = await connect(session);
    advance(1_001);
    const result = await client.callTool({ name: 'jobs.search', arguments: { profileId: 'profile-1', page: 0, pageSize: 10 } });
    expect(result.isError).toBe(true);
    expect(jobs.search).not.toHaveBeenCalled();
    expect(session.auditEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'tool_denied', reason: 'capability_token_expired' }),
    ]));
  });

  it('revokes the internal capability and invalidates outstanding approvals', async () => {
    const { session, jobs } = setup(['jobs.search']);
    const client = await connect(session);
    await session.revokeCapability();
    const result = await client.callTool({ name: 'jobs.search', arguments: { profileId: 'profile-1', page: 0, pageSize: 10 } });
    expect(result.isError).toBe(true);
    expect(jobs.search).not.toHaveBeenCalled();
    expect(session.auditEvents()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'capability_revoked' })]));
  });

  it('ignores no client approval bypass and releases only a masked server-approved read', async () => {
    const { session, applications } = setup(['applications.get']);
    const args = { applicationCaseId: 'case-1' };
    const request = await session.requestApproval({ name: 'applications.get', arguments: args });
    await session.resolveApproval(request.id, 'approve', 'local-user');
    const client = await connect(session);

    const bypass = await client.callTool({
      name: 'applications.get', arguments: { ...args, approvalToken: 'client-controlled', approvalValidated: true },
    });
    expect(bypass.isError).toBe(true);
    expect(applications.get).not.toHaveBeenCalled();

    const approved = await client.callTool({ name: 'applications.get', arguments: args });
    expect(approved.isError).not.toBe(true);
    expect(applications.get).toHaveBeenCalledWith('case-1', 'masked');
    expect(JSON.stringify(approved)).toContain('Masked summary');
    expect(JSON.stringify(approved)).not.toContain('Sensitive summary');

    const replay = await client.callTool({ name: 'applications.get', arguments: args });
    expect(replay.isError).toBe(true);
    expect(applications.get).toHaveBeenCalledOnce();
  });

  it('keeps a denied approval out of the MCP execution path', async () => {
    const { session, applications } = setup(['applications.get']);
    const args = { applicationCaseId: 'case-1' };
    const request = await session.requestApproval({ name: 'applications.get', arguments: args });
    await session.resolveApproval(request.id, 'deny', 'local-user');
    const client = await connect(session);
    const denied = await client.callTool({ name: 'applications.get', arguments: args });
    expect(denied.isError).toBe(true);
    expect(applications.get).not.toHaveBeenCalled();
    expect(session.auditEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'approval_denied', approvalRequestId: request.id }),
    ]));
  });

  it('rejects forbidden or unknown tools at factory creation', () => {
    expect(() => setup(['shell.execute'])).toThrow('mcp_run_tool_scope_invalid');
    expect(() => setup(['mail.send'])).toThrow('mcp_run_tool_scope_invalid');
  });
});
