import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationCase, SearchRun } from '../domain/models.js';
import { defaultConfig } from '../config/defaults.js';
import { MemoryConfigStore } from './config-store.js';
import {
  LocalAgentDomainCommandPort,
  LocalAgentDomainProposalPort,
  LocalAgentApplicationPipelineProxy,
  TrustedHostAgentJobSearchProxy,
  WorkspaceAgentApplicationReadPort,
  WorkspaceAgentJobReadPort
} from './agent-domain-ports.js';
import { MemoryWorkspaceStore } from './workspace-store.js';

const temporaryRoots: string[] = [];
afterEach(async () => Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const application: ApplicationCase = {
  id: 'case-1',
  job: { id: 'job-1', sourceId: 'demo', title: 'Engineer', company: 'Example GmbH', location: 'Berlin', workModel: 'hybrid', employmentType: 'full_time', description: 'UNTRUSTED-JOB-DESCRIPTION', skills: [] },
  identityId: 'real', identityMode: 'real', documentType: 'cover_letter', state: 'draft',
  createdAt: '2026-08-14T00:00:00Z', updatedAt: '2026-08-14T00:00:00Z', artifactNames: [], warnings: [], revision: 2
};

describe('run-bound domain ports', () => {
  it('audits the server-bound case through the real versioned submodule contract without accepting raw profile input', async () => {
    const workRoot = await mkdtemp(resolve(tmpdir(), 'agent-application-pipeline-audit-'));
    temporaryRoots.push(workRoot);
    const workspace = new MemoryWorkspaceStore();
    const current = {
      ...structuredClone(application),
      job: { ...structuredClone(application.job), skills: ['RabbitMQ', 'Kafka'] },
    };
    await workspace.saveApplicationCase(current);
    const repositoryRoot = resolve(process.cwd(), '..');
    const configuration = structuredClone(defaultConfig);
    configuration.assistant = {
      skillPath: resolve(repositoryRoot, 'integrations', 'bewerbungs-schreib-assistent'),
      candidateProfilePath: resolve(
        repositoryRoot, 'integrations', 'bewerbungs-schreib-assistent', 'tests', 'fixtures', 'valid-candidate.yaml',
      ),
      styleProfilePath: resolve(
        repositoryRoot, 'integrations', 'bewerbungs-schreib-assistent', 'tests', 'fixtures', 'valid-style.yaml',
      ),
    };
    const proxy = new LocalAgentApplicationPipelineProxy(
      workspace, new MemoryConfigStore(configuration), workRoot,
    );

    const audited = await proxy.audit({ applicationCaseId: current.id, documentType: current.documentType });
    expect(audited.payload).toMatchObject({
      contract: 'application-pipeline-root-proxy', contractVersion: '1.0',
      applicationCaseId: current.id, applicationCaseRevision: current.revision,
      jobId: current.job.id, documentType: current.documentType,
      upstream: {
        contract: 'bewerbungs-pipeline', contractVersion: '1.0', compatible: true, networkRequired: false,
      },
      validation: { valid: true, errors: [] },
      finalization: {
        executable: false, route: 'approved-artifact-review-adoption',
        proofContract: 'application-pipeline-proof@1.0',
      },
    });
    const payload = audited.payload as unknown as { matchMatrix: { matches: Array<{ competency: string; classification: string }> } };
    expect(payload.matchMatrix.matches.find((match) => match.competency === 'RabbitMQ'))
      .toMatchObject({ classification: 'direct_match' });
    expect(payload.matchMatrix.matches.find((match) => match.competency === 'Kafka'))
      .toMatchObject({ classification: 'gap' });
    expect(audited.sourceReferences).toEqual([
      expect.stringMatching(/^application:[a-f0-9]{64}$/),
      expect.stringMatching(/^job:[a-f0-9]{64}$/),
      expect.stringMatching(/^pipeline-contract:[a-f0-9]{64}$/),
    ]);
    expect(JSON.stringify(audited)).not.toContain(configuration.assistant.candidateProfilePath);
    expect(JSON.stringify(audited)).not.toContain(configuration.assistant.styleProfilePath);
    await expect(proxy.audit({ applicationCaseId: current.id, documentType: 'cv' }))
      .rejects.toThrow('document_type_mismatch');
  }, 20_000);

  it('uses only the validated trusted-host read port and keeps portal capabilities and credentials behind the proxy', async () => {
    const configValue = structuredClone(defaultConfig);
    configValue.mcp = {
      mode: 'stdio', executionIsolation: 'trusted-host', runtimeTarget: 'wsl', distribution: 'Ubuntu',
      command: 'C:\\Windows\\System32\\wsl.exe',
      args: ['-d', 'Ubuntu', '--', '/mnt/c/work/integrations/job-search-mcp/.venv-wsl/bin/job-search-mcp'],
      env: {
        ALLOW_EXTERNAL_PORTALS: '1', JOB_MCP_STATE_DIR: '/mnt/c/work/.local-data/mcp-state',
        WSLENV: 'ALLOW_EXTERNAL_PORTALS:JOB_MCP_STATE_DIR',
      },
    };
    const config = new MemoryConfigStore(configValue);
    const source = {
      capabilities: vi.fn(async () => ({
        contract: 'job-search-mcp' as const, contractVersion: '1.0', compatible: true,
        tools: ['capabilities', 'mehrportal_suche', 'portal_login', 'portal_sitzung_loeschen'], errorCategories: ['authentication'],
        sources: [{
          id: 'stepstone', name: 'StepStone', enabled: true, access: 'browser', supportsLogin: true,
          loginRequiredForSearch: true, filters: ['query', 'location'], pagination: false, policyStatus: 'configured',
        }],
      })),
      searchDetailed: vi.fn(async () => ({
        jobs: [
          {
            id: 'job-1', sourceId: 'stepstone', title: 'Engineer', company: 'Example GmbH', location: 'Berlin',
            workModel: 'hybrid' as const, employmentType: 'full_time' as const, description: 'PRIVATE DESCRIPTION', skills: [],
            url: 'https://jobs.example.test/1?access_token=secret', fetchedAt: '2029-01-01T00:00:00.000Z',
            sourceReferences: [{
              sourceId: 'stepstone', externalId: 'external-1', url: 'https://jobs.example.test/1?token=secret',
              fetchedAt: '2029-01-01T00:00:00.000Z',
            }],
          },
          {
            id: 'job-2', sourceId: 'stepstone', title: 'Staff Engineer', company: 'Example GmbH', location: 'Remote',
            workModel: 'remote' as const, employmentType: 'full_time' as const, description: 'SECOND PRIVATE DESCRIPTION', skills: [],
            fetchedAt: '2029-01-01T00:00:00.000Z',
          },
        ],
        failures: [{ sourceId: 'stepstone', category: 'authentication', retryable: false, detail: 'PRIVATE UPSTREAM DETAIL' }],
      })),
      login: vi.fn(), logout: vi.fn(), statuses: vi.fn(), search: vi.fn(),
    };
    const factory = vi.fn(() => source);
    let now = Date.parse('2029-01-01T00:00:00.000Z');
    const proxy = new TrustedHostAgentJobSearchProxy(config, factory, () => now);

    const capabilities = await proxy.capabilities({ runId: 'run-1' });
    expect(capabilities).toMatchObject({
      contract: 'job-search-root-proxy', executionIsolation: 'trusted-host', allowedOperations: ['capabilities', 'search'],
    });
    expect(JSON.stringify(capabilities)).not.toMatch(/portal_login|sitzung_loeschen|credential|password/i);

    const first = await proxy.callAllowedTool({
      name: 'search', arguments: { profileId: 'active', page: 0, pageSize: 1 }, runId: 'run-1',
    });
    now += 1_000;
    const second = await proxy.callAllowedTool({
      name: 'search', arguments: { profileId: 'active', page: 1, pageSize: 1 }, runId: 'run-1',
    });
    expect(source.searchDetailed).toHaveBeenCalledOnce();
    expect(source.searchDetailed).toHaveBeenCalledWith(configValue.searchProfile);
    expect(first).toMatchObject({ page: 0, pageSize: 1, hasMore: true, failures: [{ sourceId: 'stepstone', category: 'authentication', retryable: false }] });
    expect(second).toMatchObject({ page: 1, pageSize: 1, hasMore: false });
    expect(JSON.stringify({ first, second })).not.toMatch(/PRIVATE|access_token|secret/i);
    expect(first).toMatchObject({ items: [{ id: expect.stringMatching(/^job-id:[a-f0-9]{64}$/), sourceReference: expect.stringMatching(/^job:[a-f0-9]{64}$/) }] });
    expect(source.login).not.toHaveBeenCalled();
    expect(source.logout).not.toHaveBeenCalled();

    source.searchDetailed.mockResolvedValueOnce({
      jobs: [{
        id: 'foreign-job', sourceId: 'foreign-portal', title: 'Foreign', company: 'Foreign GmbH', location: 'Berlin',
        workModel: 'hybrid', employmentType: 'full_time', description: 'out of scope', skills: [],
        url: 'https://foreign.example.test/1', fetchedAt: '2029-01-01T00:00:00.000Z',
        sourceReferences: [{ sourceId: 'foreign-portal', externalId: 'foreign-1', url: 'https://foreign.example.test/1', fetchedAt: '2029-01-01T00:00:00.000Z' }],
      }],
      failures: [],
    });
    const foreignProxy = new TrustedHostAgentJobSearchProxy(config, factory, () => now);
    await expect(foreignProxy.callAllowedTool({
      name: 'search', arguments: { profileId: 'active', page: 0, pageSize: 10 }, runId: 'run-foreign',
    })).rejects.toThrow('source_out_of_scope');
  });

  it('fails closed before source construction for demo mode or forbidden raw MCP operations', async () => {
    const sourceFactory = vi.fn(() => { throw new Error('must-not-create-source'); });
    const proxy = new TrustedHostAgentJobSearchProxy(new MemoryConfigStore(), sourceFactory);
    await expect(proxy.capabilities({ runId: 'run-1' })).rejects.toThrow('trusted_host_required');
    await expect(proxy.callAllowedTool({
      name: 'portal_login' as never, arguments: { username: 'x', password: 'y' }, runId: 'run-1',
    })).rejects.toThrow('operation_forbidden');
    expect(sourceFactory).not.toHaveBeenCalled();
  });

  it('returns only normalized, paged jobs and minimized application data', async () => {
    const workspace = new MemoryWorkspaceStore();
    const run: SearchRun = {
      id: 'run-1', createdAt: '2026-08-14T00:00:00Z', sourceIds: ['demo'],
      profile: structuredClone(defaultConfig.searchProfile),
      matches: [{
        job: application.job, searchPreferenceScore: 80, accepted: true, matchedMustHave: [], missingMustHave: [], matchedNiceToHave: [], exclusions: [],
        scoreBreakdown: { mustHave: 0, niceToHave: 0, region: 0, workModel: 0, exclusions: 0 }
      }]
    };
    await workspace.saveSearchRun(run);
    await workspace.saveApplicationCase(application);
    const jobs = await new WorkspaceAgentJobReadPort(workspace).search({ profileId: 'active', page: 0, pageSize: 10 });
    expect(jobs.items[0]).toMatchObject({ id: 'job-1', title: 'Engineer', sourceId: 'demo' });
    expect(JSON.stringify(jobs)).not.toContain(application.job.description);
    expect(await new WorkspaceAgentApplicationReadPort(workspace).get(application.id, 'masked')).toMatchObject({
      id: application.id, revision: 2, identityMode: 'real'
    });
  });

  it('minimizes company and tracking views to explicitly allowed case scope with stable revisions and sources', async () => {
    const workspace = new MemoryWorkspaceStore();
    const sameCompany = {
      ...structuredClone(application), id: 'case-2', revision: 4,
      job: { ...structuredClone(application.job), id: 'job-2', title: 'Staff Engineer' },
    };
    const foreignCompany = {
      ...structuredClone(application), id: 'case-3', revision: 1,
      job: { ...structuredClone(application.job), id: 'job-3', company: 'Other AG', title: 'Private Role' },
    };
    await workspace.saveApplicationCase(application);
    await workspace.saveApplicationCase(sameCompany);
    await workspace.saveApplicationCase(foreignCompany);
    const trackingEvent = {
      id: 'tracking-1', applicationCaseId: application.id, status: 'planned',
      occurredAt: '2029-01-01T00:00:00.000Z', source: 'user', note: 'PRIVATE TRACKING NOTE',
      sourceReference: 'https://portal.example.test/private?id=1',
    } as const;
    await workspace.appendTrackingEvent(trackingEvent);
    await workspace.appendTrackingEvent(trackingEvent);
    expect(await workspace.listTrackingEvents(application.id)).toHaveLength(1);
    const port = new WorkspaceAgentApplicationReadPort(workspace);
    const company = await port.getCompany({
      applicationCaseId: application.id, companyId: 'example',
      allowedApplicationCaseIds: [application.id, sameCompany.id],
    });
    expect(company?.applicationCases).toEqual([
      expect.objectContaining({ id: application.id, revision: 2 }),
      expect.objectContaining({ id: sameCompany.id, revision: 4 }),
    ]);
    expect(company?.version).toMatch(/^company-version:[a-f0-9]{64}$/);
    expect(JSON.stringify(company)).not.toMatch(/case-3|Private Role|identity|description/i);
    await expect(port.getCompany({
      applicationCaseId: application.id, companyId: 'other', allowedApplicationCaseIds: [application.id],
    })).resolves.toBeUndefined();

    const tracking = await port.listTracking({ applicationCaseId: application.id, page: 0, pageSize: 1 });
    expect(tracking).toMatchObject({ page: 0, pageSize: 1, hasMore: false, applicationCaseRevision: 2 });
    expect(tracking.items[0]).toMatchObject({ status: 'planned', source: 'user' });
    expect(tracking.items[0]?.id).toMatch(/^tracking-event-id:[a-f0-9]{64}$/);
    expect(JSON.stringify(tracking)).not.toMatch(/PRIVATE TRACKING NOTE|portal\.example|note/i);
  });

  it('executes only a previously previewed local status proposal with optimistic revision binding', async () => {
    const workspace = new MemoryWorkspaceStore();
    await workspace.saveApplicationCase(application);
    const mailVault = { listMessages: async () => [], confirmCorrelation: async () => { throw new Error('unused'); } };
    const port = new LocalAgentDomainCommandPort(workspace, mailVault as never);
    const proposalPort = new LocalAgentDomainProposalPort();
    expect(await proposalPort.propose({ kind: 'application_status', applicationCaseId: application.id, payload: {}, runId: 'run-1' }))
      .toHaveProperty('sourceReferences');
    const proposal = {
      proposalId: 'proposal-1', kind: 'application_status', applicationCaseId: application.id, runId: 'run-1',
      payload: { applicationCaseId: application.id, status: 'review' }, payloadHash: 'hash', sourceReferences: [], createdAt: 'now'
    };
    await expect(port.preview({ proposal, expectedRevision: 1, idempotencyKeySha256: 'a'.repeat(64) })).rejects.toThrow('concurrency');
    await expect(port.preview({
      proposal: { ...proposal, proposalId: 'proposal-gate', payload: { applicationCaseId: application.id, status: 'approved' } },
      expectedRevision: 2, idempotencyKeySha256: 'b'.repeat(64)
    })).rejects.toThrow('pipeline_gate_cannot_be_bypassed');
    const preview = await port.preview({ proposal, expectedRevision: 2, idempotencyKeySha256: 'a'.repeat(64) });
    expect(await workspace.listApplicationEvents(application.id)).toEqual([]);
    const result = await port.execute({
      commandId: 'command-1', proposalId: proposal.proposalId, proposalPayloadHash: proposal.payloadHash,
      applicationCaseId: application.id, expectedRevision: 2, idempotencyKeySha256: 'a'.repeat(64),
      prepared: preview.prepared, dryRun: preview.dryRun,
    });
    expect(result).toMatchObject({ revision: 3, result: { state: 'review' } });
    await expect(port.execute({
      commandId: 'command-1', proposalId: proposal.proposalId, proposalPayloadHash: proposal.payloadHash,
      applicationCaseId: application.id, expectedRevision: 2, idempotencyKeySha256: 'a'.repeat(64),
      prepared: preview.prepared, dryRun: preview.dryRun,
    })).resolves.toMatchObject({ revision: 3, result: { state: 'review' } });
    expect(await workspace.listApplicationEvents(application.id)).toHaveLength(1);
  });

  it('creates a local reminder only after preview and confirmed execution', async () => {
    const workspace = new MemoryWorkspaceStore();
    await workspace.saveApplicationCase(application);
    const mailVault = { listMessages: async () => [], confirmCorrelation: async () => { throw new Error('unused'); } };
    const port = new LocalAgentDomainCommandPort(workspace, mailVault as never);
    const proposal = {
      proposalId: 'proposal-reminder', kind: 'follow_up_reminder', applicationCaseId: application.id, runId: 'run-1',
      payload: { applicationCaseId: application.id, dueAt: '2099-08-20T08:00:00.000Z', timeZone: 'Europe/Berlin', note: 'Nachfassen' },
      payloadHash: 'hash', sourceReferences: [], createdAt: 'now'
    };
    const preview = await port.preview({ proposal, expectedRevision: 2, idempotencyKeySha256: 'c'.repeat(64) });
    expect(preview.dryRun).toMatchObject({ action: 'follow_up_reminder', timeZone: 'Europe/Berlin' });
    expect(await workspace.listReminders()).toEqual([]);
    const executed = await port.execute({
      commandId: 'command-reminder', proposalId: proposal.proposalId, proposalPayloadHash: proposal.payloadHash,
      applicationCaseId: application.id, expectedRevision: 2, idempotencyKeySha256: 'c'.repeat(64),
      prepared: preview.prepared, dryRun: preview.dryRun,
    });
    expect(executed).toMatchObject({ revision: 2, result: { timeZone: 'Europe/Berlin' } });
    expect(await workspace.listReminders()).toEqual([
      expect.objectContaining({ applicationCaseId: application.id, dueAt: '2099-08-20T08:00:00.000Z', note: 'Nachfassen', completed: false }),
    ]);
    await port.execute({
      commandId: 'command-reminder-retry', proposalId: proposal.proposalId, proposalPayloadHash: proposal.payloadHash,
      applicationCaseId: application.id, expectedRevision: 2, idempotencyKeySha256: 'd'.repeat(64),
      prepared: preview.prepared, dryRun: preview.dryRun,
    });
    expect(await workspace.listReminders()).toHaveLength(1);
  });

  it('does not confirm the same mail correlation twice across command retries', async () => {
    const workspace = new MemoryWorkspaceStore();
    await workspace.saveApplicationCase(application);
    const message: {
      id: string;
      correlation: { confirmed: boolean; applicationCaseId?: string; companyKey?: string };
    } = {
      id: 'mail-1', correlation: { confirmed: false, applicationCaseId: undefined, companyKey: undefined },
    };
    let confirmations = 0;
    const mailVault = {
      listMessages: async () => [structuredClone(message)],
      confirmCorrelation: async (_messageId: string, applicationCaseId: string, scopedCompanyKey: string) => {
        confirmations += 1;
        message.correlation = { confirmed: true, applicationCaseId, companyKey: scopedCompanyKey };
        return structuredClone(message);
      },
    };
    const port = new LocalAgentDomainCommandPort(workspace, mailVault as never);
    const proposal = {
      proposalId: 'proposal-mail', kind: 'mail_correlation', applicationCaseId: application.id, runId: 'run-1',
      payload: { applicationCaseId: application.id, messageId: message.id }, payloadHash: 'mail-hash',
      sourceReferences: [], createdAt: 'now',
    };
    const preview = await port.preview({ proposal, expectedRevision: 2, idempotencyKeySha256: 'e'.repeat(64) });
    const base = {
      proposalId: proposal.proposalId, proposalPayloadHash: proposal.payloadHash, applicationCaseId: application.id,
      expectedRevision: 2, prepared: preview.prepared, dryRun: preview.dryRun,
    };
    await port.execute({ ...base, commandId: 'mail-command-1', idempotencyKeySha256: 'e'.repeat(64) });
    await port.execute({ ...base, commandId: 'mail-command-2', idempotencyKeySha256: 'f'.repeat(64) });
    expect(confirmations).toBe(1);
  });

  it('keeps document previews proposal-only because artifact review and adoption own authoritative revisions', async () => {
    const workspace = new MemoryWorkspaceStore();
    await workspace.saveApplicationCase(application);
    const port = new LocalAgentDomainCommandPort(workspace, {
      listMessages: async () => [], confirmCorrelation: async () => { throw new Error('unused'); },
    } as never);
    const proposal = {
      proposalId: 'proposal-document', kind: 'document_revision', applicationCaseId: application.id, runId: 'run-1',
      payload: { documentType: 'cv', lifecycle: 'preview', content: 'Nicht autoritative Vorschau' },
      payloadHash: 'document-hash', sourceReferences: [], createdAt: 'now',
    };
    await expect(port.preview({
      proposal, expectedRevision: application.revision, idempotencyKeySha256: '0'.repeat(64),
    })).rejects.toThrow('proposal_only_use_artifact_review_api');
    expect(await workspace.listArtifactRevisions(application.id)).toEqual([]);
    expect((await workspace.getApplicationCase(application.id))?.revision).toBe(application.revision);
  });
});
