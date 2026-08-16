import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunHandle, AgentRunRequest, ProviderRunContext } from '../ports/agent-runner.js';
import { AgentControlCenter } from './agent-control-center.js';
import {
  ApplicationAgentOrchestrationService,
  type ApplicationOrchestrationGateAuthority,
  type ApplicationOrchestrationInputResolver,
  type CreateApplicationOrchestrationInput,
} from './application-orchestration-service.js';
import {
  JsonApplicationOrchestrationStore,
  MemoryApplicationOrchestrationStore,
  type ApplicationOrchestrationRecord,
} from './application-orchestration-store.js';
import { AgentArtifactStore } from './artifact-store.js';
import { FakeAgentProvider } from './fake-agent-provider.js';
import { MemoryAgentRunStore } from './run-store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
const HASH = /^[a-f0-9]{64}$/;
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'application-orchestration-'));
  roots.push(root);
  return root;
}

const runtimeTarget = process.platform === 'win32' ? 'windows' as const : 'linux' as const;
const gateAuthority: ApplicationOrchestrationGateAuthority = {
  async evidenceComplete() { return { complete: true, bindingSha256: hash('verified-evidence-binding') }; },
  async verifyRevisionConfirmation({ confirmation }) {
    return { valid: true, bindingSha256: hash(`${confirmation.gate}:${confirmation.confirmationReference}`) };
  },
};
const inputResolver: ApplicationOrchestrationInputResolver = {
  async resolve({ reference }) {
    const content = reference === 'untrusted_mail'
      ? JSON.stringify([{ id: 'mail-42', sourceReference: `local:${hash('mail:mail-42')}`, trust: 'untrusted_data' }])
      : reference === 'application_case'
        ? JSON.stringify({
            primaryApplicationCaseId: 'case-42',
            candidates: [{ id: 'case-42', sourceReference: `local:${hash('case:case-42')}` }],
          })
        : reference === 'company_cases'
          ? JSON.stringify([
              { id: 'case-42', sourceReference: `local:${hash('case:case-42')}` },
              { id: 'case-43', sourceReference: `local:${hash('case:case-43')}` },
            ])
          : reference === 'tracking_events'
            ? JSON.stringify([{ applicationCaseId: 'case-42', events: [{ id: 'event-42', sourceReference: `local:${hash('tracking:event-42')}` }] }])
            : `raw server-owned ${reference}`;
    return { content, sha256: hash(content) };
  },
};
const confirmationReference = (prefix: 'r' | 'u'): string => `${prefix.repeat(32)}.${'s'.repeat(43)}`;

const pipelinePackage = JSON.stringify({
  annotatedContent: '# Synthetic application\n\nEvidence-backed synthetic content.',
  iterationManifest: [
    'schema_version: 1', 'mode: rigorous', 'execution: independent_agents', 'cycle: 1', 'passes:',
    '  - id: evidence-pass', '    role: evidence_reviewer', '    independent_context: true', '    input_revision: job', '    output_revision: evidence', '    findings: []',
    '  - id: author-pass', '    role: author', '    independent_context: true', '    input_revision: evidence', '    output_revision: draft', '    findings: []',
    '  - id: ats-pass', '    role: ats_reviewer', '    independent_context: true', '    input_revision: draft', '    output_revision: ats', '    findings: []',
    '  - id: style-pass', '    role: recruiter_style_reviewer', '    independent_context: true', '    input_revision: ats', '    output_revision: reviewed', '    findings: []',
    '  - id: finalizer-pass', '    role: finalizer', '    independent_context: true', '    input_revision: reviewed', '    output_revision: final', '    findings: []',
  ].join('\n'),
});

const employerResponseProposal = JSON.stringify({
  schemaVersion: 1,
  classification: 'interview',
  confidence: 0.88,
  selectedMailId: 'mail-42',
  sourceReferences: [`local:${hash('mail:mail-42')}`],
  caseCandidates: [{
    caseId: 'case-42', confidence: 0.82, reason: 'Servergebundene Stellenreferenz stimmt ueberein.',
    sourceReferences: [`local:${hash('mail:mail-42')}`, `local:${hash('case:case-42')}`],
    requiredDecision: 'confirm_correlation_or_leave_unassigned',
  }],
  replyDraft: {
    subject: 'Re: Einladung', body: 'Vielen Dank. Ich pruefe den vorgeschlagenen Termin.', language: 'de',
    sourceReferences: [`local:${hash('mail:mail-42')}`],
    requiredDecision: 'review_edit_or_dismiss',
  },
});

const nextActionsProposal = JSON.stringify({
  schemaVersion: 1,
  companyKey: 'example-ag',
  suggestions: [{
    id: 'follow-up-case-42', applicationCaseId: 'case-42', kind: 'follow_up',
    title: 'Rueckfrage pruefen', reason: 'Ein servergebundenes Trackingereignis liegt vor.', confidence: 0.8,
    sourceReferences: [`local:${hash('case:case-42')}`, `local:${hash('tracking:event-42')}`],
    requiredDecision: 'confirm_reminder_or_dismiss',
  }],
  conflicts: [],
});

function applicationProvider(): FakeAgentProvider {
  return new FakeAgentProvider({
    steps: [{ kind: 'agent_message_completed', data: { text: pipelinePackage } }],
    outcome: { state: 'succeeded' },
  });
}

class RoleOutputProvider extends FakeAgentProvider {
  override start(context: ProviderRunContext): Promise<AgentRunHandle> {
    const role = String(context.request.metadata?.nodeRole ?? 'unknown');
    const text = role === 'finalizer' ? pipelinePackage : `${role} review variant`;
    return new FakeAgentProvider({
      steps: [{ kind: 'agent_message_completed', data: { text } }],
      outcome: { state: 'succeeded' },
    }).start(context);
  }
}

function applicationInput(root: string): CreateApplicationOrchestrationInput {
  return {
    workflowId: 'evidence-application-package',
    providerId: 'fake',
    workspaceRoot: root,
    runtimeTarget,
    ownerId: 'local-user',
    prompt: 'Prepare the application for Frank Example <frank.private@example.test>.',
    scope: {
      applicationCaseId: 'case-42',
      applicationCaseRevision: 7,
      jobId: 'job-42',
      companyKey: 'example-ag',
      documentRevisionId: 'document-revision-7',
      workspaceRootId: 'workspace-local',
      identityMode: 'real',
    },
    claimIds: ['claim-verified-1'],
    reviewIds: ['review-ats-1', 'review-style-1'],
    confirmations: [
      {
        nodeId: 'finalizer', gate: 'user_input', applicationCaseId: 'case-42', applicationCaseRevision: 7,
        confirmationReference: confirmationReference('u'),
      },
    ],
  };
}

async function waitForStatus(
  service: ApplicationAgentOrchestrationService,
  id: string,
  accepted: readonly string[] = ['succeeded', 'failed', 'waiting_for_gate', 'cancelled'],
): Promise<ApplicationOrchestrationRecord> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await service.get(id);
    if (value && accepted.includes(value.status)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('orchestration_did_not_settle');
}

describe('ApplicationAgentOrchestrationService root domain tools', () => {
  async function runWithCodexProvider(rootDomainToolsAvailable?: () => Promise<boolean>) {
    const root = await temporaryRoot();
    const requests: AgentRunRequest[] = [];
    // Only codex-exec reaches the root-tool path at all.
    const provider = new FakeAgentProvider({
      steps: [{ kind: 'agent_message_completed', data: { text: pipelinePackage } }],
      outcome: { state: 'succeeded' },
    }, 'codex-exec');
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [provider], {
      maxParallel: 2, maxParallelPerProvider: 2, allowedWorkspaceRoots: [root],
    });
    const observed = {
      enqueue: center.enqueue.bind(center),
      get: center.get.bind(center),
      events: center.events.bind(center),
      cancel: center.cancel.bind(center),
    };
    const service = new ApplicationAgentOrchestrationService(
      { ...observed, enqueue: async (request) => { requests.push(structuredClone(request)); return observed.enqueue(request); } },
      new AgentArtifactStore(join(root, 'artifacts')), new MemoryApplicationOrchestrationStore(),
      gateAuthority, inputResolver,
      {
        runPersistenceProtection: 'ephemeral', maxParallelNodes: 2, pollIntervalMs: 2,
        ...(rootDomainToolsAvailable ? { rootDomainToolsAvailable } : {}),
      },
    );
    const created = await service.create({ ...applicationInput(root), providerId: 'codex-exec' });
    const settled = await waitForStatus(service, created.id);
    return { settled, requests };
  }

  it('falls back to prompt context when the installation cannot serve root tools', async () => {
    // Previously this demanded tools the provider could not supply, so the node
    // failed with required_root_domain_tools_unavailable while every provider
    // without the bridge quietly succeeded on prompt context alone.
    const { settled, requests } = await runWithCodexProvider(async () => false);
    expect(requests[0]?.metadata?.requiredRootMcpTools).toEqual([]);
    expect(settled.nodes[0]?.status).not.toBe('failed');
  });

  it('requests the workflow tools when the installation does serve them', async () => {
    const { requests } = await runWithCodexProvider(async () => true);
    expect(requests[0]?.metadata?.requiredRootMcpTools).toEqual(expect.arrayContaining([
      'applications.get', 'companies.get', 'application.analyze',
    ]));
  });

  it('treats an unconfigured or failing probe as unavailable rather than failing the run', async () => {
    const unconfigured = await runWithCodexProvider();
    expect(unconfigured.requests[0]?.metadata?.requiredRootMcpTools).toEqual([]);
    const failing = await runWithCodexProvider(async () => { throw new Error('discovery_unavailable'); });
    expect(failing.requests[0]?.metadata?.requiredRootMcpTools).toEqual([]);
    expect(failing.settled.nodes[0]?.status).not.toBe('failed');
  });
});

describe('ApplicationAgentOrchestrationService', () => {
  it('executes the Evidence/Author/ATS/Style/Finalizer DAG as separate, bounded AgentControlCenter runs', async () => {
    const root = await temporaryRoot();
    let active = 0; let maximum = 0;
    class TrackingProvider extends FakeAgentProvider {
      override async start(context: ProviderRunContext): Promise<AgentRunHandle> {
        active += 1; maximum = Math.max(maximum, active);
        const handle = await super.start(context);
        return { ...handle, completion: handle.completion.finally(() => { active -= 1; }) };
      }
    }
    const provider = new TrackingProvider({
      steps: [
        { delayMs: 15, kind: 'agent_message_completed', data: { text: pipelinePackage } },
        { kind: 'usage_updated', data: { inputTokens: 20, outputTokens: 10 } },
      ],
      outcome: { state: 'succeeded' },
    });
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [provider], {
      maxParallel: 2, maxParallelPerProvider: 2, allowedWorkspaceRoots: [root],
    });
    const artifactStore = new AgentArtifactStore(join(root, 'artifacts'));
    const service = new ApplicationAgentOrchestrationService(
      center, artifactStore, new MemoryApplicationOrchestrationStore(), gateAuthority, inputResolver,
      { runPersistenceProtection: 'ephemeral', maxParallelNodes: 2, pollIntervalMs: 2 },
    );

    const created = await service.create(applicationInput(root));
    expect(created.status).toBe('queued');
    expect(created.redactedSummary).not.toContain('Frank');
    const completed = await waitForStatus(service, created.id);

    expect(completed.status).toBe('succeeded');
    expect(completed.nodes.map((node) => [node.nodeId, node.role, node.status])).toEqual([
      ['evidence', 'evidence_reviewer', 'succeeded'],
      ['author', 'author', 'succeeded'],
      ['ats', 'ats_reviewer', 'succeeded'],
      ['style', 'recruiter_style_reviewer', 'succeeded'],
      ['finalizer', 'finalizer', 'succeeded'],
    ]);
    expect(Object.values(completed.nodeRunIds).flat()).toHaveLength(5);
    expect(completed.artifactRefs).toHaveLength(5);
    expect(completed.artifactRefs.every((artifact) => artifact.lifecycle === 'proposed')).toBe(true);
    expect(maximum).toBe(2);

    const runs = await center.list();
    expect(runs).toHaveLength(5);
    for (const run of runs) {
      expect(run.request.metadata).toMatchObject({
        orchestrationId: created.id,
        workflowId: 'evidence-application-package',
        producesSuggestionsOnly: true,
      });
      expect(typeof run.request.metadata?.nodeRole).toBe('string');
      expect(run.request.network).toBe('disabled');
      expect(run.request.sandbox).toBe('read-only');
    }
    const finalizer = runs.find((run) => run.request.metadata?.nodeRole === 'finalizer');
    expect(finalizer?.request.task).toContain('Evidence-backed synthetic content');
    expect(finalizer?.request.task).toContain('both raw reviews');
    expect(finalizer?.request.task).toContain('Closed output contract (mandatory)');
    const finalArtifact = completed.artifactRefs.find((artifact) => artifact.outputRef === 'package_proposal')!;
    expect(await artifactStore.get(finalArtifact.artifactId)).toMatchObject({
      kind: 'application-pipeline-package', mediaType: 'application/json', lifecycle: 'proposed',
      provenance: {
        reviewIds: expect.arrayContaining([
          'review-ats-1', 'review-style-1', hash(`user_input:${confirmationReference('u')}`),
        ]),
      },
    });
    for (const reference of completed.artifactRefs) {
      expect(await artifactStore.get(reference.artifactId)).toMatchObject({ lifecycle: 'proposed' });
    }
  });

  it('honours classified retries and creates a new AgentRun for every attempt', async () => {
    const root = await temporaryRoot();
    let starts = 0;
    class FlakyProvider extends FakeAgentProvider {
      override async start(context: ProviderRunContext): Promise<AgentRunHandle> {
        starts += 1;
        if (starts !== 1) return super.start(context);
        const completion = (async () => {
          await context.emit({ kind: 'process_started', data: { pid: 0, synthetic: true } });
          const failure = { code: 'transport_interrupted', message: 'transport_interrupted', retryable: true };
          await context.emit({ kind: 'run_completed', data: { state: 'failed', failure } });
          return { state: 'failed' as const, failure };
        })();
        return { runId: context.runId, completion };
      }
    }
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [new FlakyProvider({
      steps: [{ kind: 'agent_message_completed', data: { text: pipelinePackage } }], outcome: { state: 'succeeded' },
    })], {
      maxParallel: 2, maxParallelPerProvider: 2, allowedWorkspaceRoots: [root],
    });
    const service = new ApplicationAgentOrchestrationService(
      center, new AgentArtifactStore(join(root, 'artifacts')), new MemoryApplicationOrchestrationStore(), gateAuthority, inputResolver,
      { runPersistenceProtection: 'ephemeral', pollIntervalMs: 2, delay: async () => undefined },
    );
    const created = await service.create({
      workflowId: 'guided-job-analysis', providerId: 'fake', workspaceRoot: root, runtimeTarget, ownerId: 'local-user',
      prompt: 'Explain the deterministic ranking.', scope: { identityMode: 'none', workspaceRootId: 'workspace-local' },
    });
    const completed = await waitForStatus(service, created.id);
    expect(completed.status).toBe('succeeded');
    expect(completed.nodeRunIds['source-analysis']).toHaveLength(2);
    expect(completed.nodeRunIds['evidence-ranking']).toHaveLength(1);
    expect(starts).toBe(3);
  });

  it('fails gates closed when the user-input confirmation is not bound to the exact case revision', async () => {
    const root = await temporaryRoot();
    const verify = vi.fn(gateAuthority.verifyRevisionConfirmation);
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [applicationProvider()], {
      maxParallel: 2, maxParallelPerProvider: 2, allowedWorkspaceRoots: [root],
    });
    const service = new ApplicationAgentOrchestrationService(
      center, new AgentArtifactStore(join(root, 'artifacts')), new MemoryApplicationOrchestrationStore(),
      { ...gateAuthority, verifyRevisionConfirmation: verify }, inputResolver,
      { runPersistenceProtection: 'ephemeral', maxParallelNodes: 2, pollIntervalMs: 2 },
    );
    const input = applicationInput(root);
    input.confirmations = input.confirmations?.map((confirmation) => confirmation.gate === 'user_input'
      ? { ...confirmation, applicationCaseRevision: 6 }
      : confirmation);
    const created = await service.create(input);
    const waiting = await waitForStatus(service, created.id);
    expect(waiting.status).toBe('waiting_for_gate');
    expect(waiting.unresolvedGates).toContainEqual({ nodeId: 'finalizer', gate: 'user_input' });
    expect(waiting.nodeRunIds.finalizer).toEqual([]);
    expect(Object.values(waiting.nodeRunIds).flat()).toHaveLength(4);
    expect(verify).not.toHaveBeenCalled();
  });

  it('continues a waiting workflow with revision-bound gates without replaying successful roles', async () => {
    const root = await temporaryRoot();
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [applicationProvider()], {
      maxParallel: 2, maxParallelPerProvider: 2, allowedWorkspaceRoots: [root],
    });
    const service = new ApplicationAgentOrchestrationService(
      center, new AgentArtifactStore(join(root, 'artifacts')), new MemoryApplicationOrchestrationStore(),
      gateAuthority, inputResolver,
      { runPersistenceProtection: 'ephemeral', maxParallelNodes: 2, pollIntervalMs: 2 },
    );
    const input = applicationInput(root);
    const confirmations = input.confirmations!;
    input.confirmations = [];
    const created = await service.create(input);
    const waiting = await waitForStatus(service, created.id);
    expect(waiting.status).toBe('waiting_for_gate');
    expect(Object.values(waiting.nodeRunIds).flat()).toHaveLength(4);
    const completedRunIds = structuredClone(waiting.nodeRunIds);

    const resumed = await service.continue(created.id, confirmations);
    expect(resumed.status).toBe('running');
    const completed = await waitForStatus(service, created.id);
    expect(completed.status).toBe('succeeded');
    expect(Object.values(completed.nodeRunIds).flat()).toHaveLength(5);
    for (const nodeId of ['evidence', 'author', 'ats', 'style']) {
      expect(completed.nodeRunIds[nodeId]).toEqual(completedRunIds[nodeId]);
    }
    expect(completed.nodeRunIds.finalizer).toHaveLength(1);
  });

  it('keeps classified retry limits on the gate-resume path', async () => {
    const root = await temporaryRoot();
    let responseAttempts = 0;
    class GateRetryProvider extends FakeAgentProvider {
      override start(context: ProviderRunContext): Promise<AgentRunHandle> {
        if (context.request.metadata?.nodeRole === 'response_drafter' && ++responseAttempts === 1) {
          const completion = (async () => {
            await context.emit({ kind: 'process_started', data: { pid: 0, synthetic: true } });
            const failure = { code: 'transport_interrupted', message: 'transport_interrupted', retryable: true };
            await context.emit({ kind: 'run_completed', data: { state: 'failed', failure } });
            return { state: 'failed' as const, failure };
          })();
          return Promise.resolve({ runId: context.runId, completion });
        }
        return new FakeAgentProvider({
          steps: [{ kind: 'agent_message_completed', data: { text: context.request.metadata?.nodeRole === 'response_drafter'
            ? employerResponseProposal : 'bounded response proposal' } }],
          outcome: { state: 'succeeded' },
        }).start(context);
      }
    }
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [new GateRetryProvider()], {
      maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root],
    });
    const service = new ApplicationAgentOrchestrationService(
      center, new AgentArtifactStore(join(root, 'artifacts')), new MemoryApplicationOrchestrationStore(),
      gateAuthority, inputResolver,
      { runPersistenceProtection: 'ephemeral', pollIntervalMs: 2, delay: async () => undefined },
    );
    const created = await service.create({
      workflowId: 'employer-response-triage', providerId: 'fake', workspaceRoot: root, runtimeTarget,
      ownerId: 'local-user', prompt: 'Propose, do not send.',
      scope: {
        applicationCaseId: 'case-42', applicationCaseRevision: 7, jobId: 'job-42', companyKey: 'example-ag',
        mailId: 'mail-42', identityMode: 'real', workspaceRootId: 'workspace-local',
      },
    });
    const waiting = await waitForStatus(service, created.id);
    expect(waiting.nodeRunIds.respond).toEqual([]);
    await service.continue(created.id, [{
      nodeId: 'respond', gate: 'user_input', applicationCaseId: 'case-42', applicationCaseRevision: 7,
      confirmationReference: confirmationReference('u'),
    }]);
    const completed = await waitForStatus(service, created.id);
    expect(completed.status).toBe('succeeded');
    expect(completed.nodeRunIds.respond).toHaveLength(2);
    expect(responseAttempts).toBe(2);
  });

  it('persists company next actions only as a scope-bound typed proposal', async () => {
    const root = await temporaryRoot();
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [new FakeAgentProvider({
      steps: [{ kind: 'agent_message_completed', data: { text: nextActionsProposal } }],
      outcome: { state: 'succeeded' },
    })], {
      maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root],
    });
    const artifacts = new AgentArtifactStore(join(root, 'artifacts'));
    const service = new ApplicationAgentOrchestrationService(
      center, artifacts, new MemoryApplicationOrchestrationStore(), gateAuthority, inputResolver,
      { runPersistenceProtection: 'ephemeral', pollIntervalMs: 2 },
    );
    const created = await service.create({
      workflowId: 'application-next-actions', providerId: 'fake', workspaceRoot: root, runtimeTarget,
      ownerId: 'local-user', prompt: 'Nur Vorschlaege erzeugen.',
      scope: { companyKey: 'example-ag', identityMode: 'real', workspaceRootId: 'workspace-local' },
    });
    const completed = await waitForStatus(service, created.id);
    expect(completed.status).toBe('succeeded');
    const reference = completed.artifactRefs.find((candidate) => candidate.outputRef === 'suggestions')!;
    expect(await artifacts.get(reference.artifactId)).toMatchObject({
      kind: 'application-next-actions-proposal', mediaType: 'application/json', lifecycle: 'proposed',
    });
    const projection = JSON.parse((await artifacts.read(reference.artifactId)).content.toString('utf8')) as Record<string, unknown>;
    expect(projection).toMatchObject({ contract: 'application-next-actions-proposal', contractVersion: '1.0' });
    expect(projection.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not add a retry for the finalizer side-effect node after gate resume', async () => {
    const root = await temporaryRoot();
    class FinalizerFailureProvider extends FakeAgentProvider {
      override start(context: ProviderRunContext): Promise<AgentRunHandle> {
        if (context.request.metadata?.nodeRole === 'finalizer') {
          return new FakeAgentProvider({
            steps: [],
            outcome: {
              state: 'failed',
              failure: { code: 'transport_interrupted', message: 'transport_interrupted', retryable: true },
            },
          }).start(context);
        }
        return new FakeAgentProvider({
          steps: [{ kind: 'agent_message_completed', data: { text: 'same reviewer proposal' } }],
          outcome: { state: 'succeeded' },
        }).start(context);
      }
    }
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [new FinalizerFailureProvider()], {
      maxParallel: 2, maxParallelPerProvider: 2, allowedWorkspaceRoots: [root],
    });
    const service = new ApplicationAgentOrchestrationService(
      center, new AgentArtifactStore(join(root, 'artifacts')), new MemoryApplicationOrchestrationStore(),
      gateAuthority, inputResolver,
      { runPersistenceProtection: 'ephemeral', pollIntervalMs: 2, delay: async () => undefined },
    );
    const input = applicationInput(root);
    input.confirmations = [];
    const created = await service.create(input);
    await waitForStatus(service, created.id);
    await service.continue(created.id, [{
      nodeId: 'finalizer', gate: 'user_input', applicationCaseId: 'case-42', applicationCaseRevision: 7,
      confirmationReference: confirmationReference('u'),
    }]);
    const completed = await waitForStatus(service, created.id);
    expect(completed.status).toBe('failed');
    expect(completed.nodeRunIds.finalizer).toHaveLength(1);
  });

  it.each([
    ['wallTimeMs', 30 * 60_000],
    ['tokens', 50_000],
    ['costMicros', 15_000_000],
    ['toolCalls', 25],
    ['iterations', 10],
  ] as const)('fails gate continuation closed when cumulative %s budget is exhausted', async (key, limit) => {
    const root = await temporaryRoot();
    const store = new MemoryApplicationOrchestrationStore();
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [applicationProvider()], {
      maxParallel: 2, maxParallelPerProvider: 2, allowedWorkspaceRoots: [root],
    });
    const service = new ApplicationAgentOrchestrationService(
      center, new AgentArtifactStore(join(root, 'artifacts')), store, gateAuthority, inputResolver,
      { runPersistenceProtection: 'ephemeral', maxParallelNodes: 2, pollIntervalMs: 2 },
    );
    const input = applicationInput(root);
    const confirmations = input.confirmations!;
    input.confirmations = [];
    const created = await service.create(input);
    const waiting = await waitForStatus(service, created.id);
    const saturated: ApplicationOrchestrationRecord = {
      ...waiting,
      revision: waiting.revision + 1,
      budget: { ...waiting.budget, [key]: limit },
      updatedAt: new Date(Date.parse(waiting.updatedAt) + 1).toISOString(),
    };
    await store.compareAndSwap(saturated, waiting.revision);

    await expect(service.continue(created.id, confirmations)).rejects.toThrow(`budget_exceeded:${key}`);
    expect(await service.get(created.id)).toMatchObject({ status: 'failed', failureReason: `budget_exceeded:${key}` });
    expect((await center.list())).toHaveLength(4);
  });

  it('cancels a live node on observed usage overrun and never starts downstream nodes', async () => {
    const root = await temporaryRoot();
    const provider = new FakeAgentProvider({
      steps: [
        { kind: 'usage_updated', data: { inputTokens: 6_001, outputTokens: 0 } },
        { delayMs: 80, kind: 'agent_message_completed', data: { text: 'late result' } },
      ],
      outcome: { state: 'succeeded' },
    });
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [provider], {
      maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root],
    });
    const service = new ApplicationAgentOrchestrationService(
      center, new AgentArtifactStore(join(root, 'artifacts')), new MemoryApplicationOrchestrationStore(),
      gateAuthority, inputResolver, { runPersistenceProtection: 'ephemeral', pollIntervalMs: 2 },
    );
    const created = await service.create({
      workflowId: 'guided-job-analysis', providerId: 'fake', workspaceRoot: root, runtimeTarget, ownerId: 'local-user',
      prompt: 'Inspect live usage.', scope: { identityMode: 'none', workspaceRootId: 'workspace-local' },
    });
    const completed = await waitForStatus(service, created.id);
    expect(completed).toMatchObject({ status: 'failed', failureReason: 'budget_exceeded:tokens' });
    expect(completed.nodes.find((node) => node.nodeId === 'source-analysis')).toMatchObject({ status: 'policy_blocked' });
    expect(completed.nodeRunIds['evidence-ranking']).toEqual([]);
    expect(completed.artifactRefs).toEqual([]);
  });

  it('rejects a terminal overrun before creating an artifact or starting another node', async () => {
    const root = await temporaryRoot();
    const provider = new FakeAgentProvider({
      steps: [
        { kind: 'agent_message_completed', data: { text: 'must not become an artifact' } },
        { kind: 'usage_updated', data: { inputTokens: 5_001, outputTokens: 0 } },
      ],
      outcome: { state: 'succeeded' },
    });
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [provider], {
      maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root],
    });
    const service = new ApplicationAgentOrchestrationService(
      center, new AgentArtifactStore(join(root, 'artifacts')), new MemoryApplicationOrchestrationStore(),
      gateAuthority, inputResolver, { runPersistenceProtection: 'ephemeral', pollIntervalMs: 2 },
    );
    const created = await service.create({
      workflowId: 'guided-job-analysis', providerId: 'fake', workspaceRoot: root, runtimeTarget, ownerId: 'local-user',
      prompt: 'Inspect terminal usage.', scope: { identityMode: 'none', workspaceRootId: 'workspace-local' },
    });
    const completed = await waitForStatus(service, created.id);
    expect(completed).toMatchObject({ status: 'failed', failureReason: 'budget_exceeded:tokens' });
    expect(completed.nodeRunIds['evidence-ranking']).toEqual([]);
    expect(completed.artifactRefs).toEqual([]);
  });

  it('persists conflicting ATS/style variants, rejects stale resolution and resumes only after exact domain resolution', async () => {
    const root = await temporaryRoot();
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [new RoleOutputProvider()], {
      maxParallel: 2, maxParallelPerProvider: 2, allowedWorkspaceRoots: [root],
    });
    const service = new ApplicationAgentOrchestrationService(
      center, new AgentArtifactStore(join(root, 'artifacts')), new MemoryApplicationOrchestrationStore(),
      gateAuthority, inputResolver,
      { runPersistenceProtection: 'ephemeral', maxParallelNodes: 2, pollIntervalMs: 2 },
    );
    const created = await service.create(applicationInput(root));
    const waiting = await waitForStatus(service, created.id);
    expect(waiting.status).toBe('waiting_for_gate');
    expect(waiting.nodeRunIds.finalizer).toEqual([]);
    expect(waiting.conflicts).toHaveLength(1);
    const conflict = waiting.conflicts![0]!;
    expect(conflict).toMatchObject({
      targetNodeId: 'finalizer', kind: 'ats_style_fan_in', status: 'unresolved', requiresDomainResolution: true,
    });
    expect(conflict.variants.map((variant) => variant.sourceNodeId)).toEqual(['ats', 'style']);
    expect(conflict.variants.every((variant) => HASH.test(variant.sha256))).toBe(true);

    await expect(service.resolveConflict(created.id, {
      expectedRevision: waiting.revision - 1,
      conflictId: conflict.id,
      variantsSha256: conflict.variantsSha256,
      strategy: 'accept_complementary',
      resolverId: 'domain-reviewer',
      resolutionReference: 'review-decision-1',
    })).rejects.toThrow('application_orchestration_revision_conflict');
    await expect(service.resolveConflict(created.id, {
      expectedRevision: waiting.revision,
      conflictId: conflict.id,
      variantsSha256: hash('stale-variants'),
      strategy: 'accept_complementary',
      resolverId: 'domain-reviewer',
      resolutionReference: 'review-decision-1',
    })).rejects.toThrow('application_orchestration_conflict_stale');

    const resumed = await service.resolveConflict(created.id, {
      expectedRevision: waiting.revision,
      conflictId: conflict.id,
      variantsSha256: conflict.variantsSha256,
      strategy: 'accept_complementary',
      resolverId: 'domain-reviewer',
      resolutionReference: 'review-decision-1',
    });
    expect(resumed.status).toBe('running');
    const completed = await waitForStatus(service, created.id);
    expect(completed.status).toBe('succeeded');
    expect(completed.conflicts?.[0]).toMatchObject({
      status: 'resolved', requiresDomainResolution: false,
      resolution: { strategy: 'accept_complementary', variantsSha256: conflict.variantsSha256 },
    });
    expect(completed.nodeRunIds.finalizer).toHaveLength(1);
    const finalizer = (await center.list()).find((run) => run.request.metadata?.nodeRole === 'finalizer');
    expect(finalizer?.request.task).toContain('domain_resolution_');
    expect(finalizer?.request.task).toContain('review-decision-1');
  });

  it('persists only prompt hashes/safe summaries and recovers active JSON records as orphaned without PID adoption', async () => {
    const root = await temporaryRoot();
    const orchestrationRoot = join(root, 'orchestrations');
    const store = new JsonApplicationOrchestrationStore(orchestrationRoot);
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [new FakeAgentProvider()], {
      maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root],
    });
    const privatePrompt = 'Contact Frank Private via frank.private@example.test and +49 170 1234567.';
    const privateResolver: ApplicationOrchestrationInputResolver = {
      async resolve({ reference }) { return { content: `PRIVATE-CANDIDATE-DATA:${reference}:Frank Private` }; },
    };
    const service = new ApplicationAgentOrchestrationService(
      center, new AgentArtifactStore(join(root, 'artifacts')), store, gateAuthority, privateResolver,
      { runPersistenceProtection: 'ephemeral', pollIntervalMs: 2 },
    );
    const created = await service.create({
      workflowId: 'guided-job-analysis', providerId: 'fake', workspaceRoot: root, runtimeTarget, ownerId: 'local-user',
      prompt: privatePrompt, scope: { identityMode: 'none', workspaceRootId: 'workspace-local' },
    });
    await waitForStatus(service, created.id);
    const persisted = (await Promise.all((await readdir(orchestrationRoot)).map((name) => readFile(join(orchestrationRoot, name), 'utf8')))).join('\n');
    expect(persisted).not.toContain(privatePrompt);
    expect(persisted).not.toContain('frank.private@example.test');
    expect(persisted).not.toContain('PRIVATE-CANDIDATE-DATA');
    expect(persisted).toContain(hash(privatePrompt));

    const completed = (await store.get(created.id))!;
    const active: ApplicationOrchestrationRecord = {
      ...completed,
      id: 'restart-canary',
      revision: 0,
      status: 'running',
      nodes: completed.nodes.map((node, index) => index === 0 ? { ...node, status: 'running' } : { ...node, status: 'pending' }),
      nodeRunIds: Object.fromEntries(completed.nodes.map((node) => [node.nodeId, [...node.runIds]])),
      artifactRefs: completed.nodes.flatMap((node) => node.artifacts),
      createdAt: '2026-08-14T10:00:00.000Z',
      updatedAt: '2026-08-14T10:01:00.000Z',
      finishedAt: undefined,
      failureReason: undefined,
      recovery: undefined,
    };
    await store.create(active);
    const recovered = await store.recoverOrphaned(new Date('2026-08-14T11:00:00.000Z'));
    expect(recovered).toEqual(['restart-canary']);
    expect(await store.get('restart-canary')).toMatchObject({
      status: 'orphaned',
      failureReason: 'server_restart_no_pid_adoption',
      recovery: { processAdoptionAllowed: false, reason: 'server_restart_no_pid_adoption' },
    });
  });
});
