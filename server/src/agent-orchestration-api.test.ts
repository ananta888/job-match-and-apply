import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import request, { type Response } from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, createDefaultAgentApiDependencies } from './app.js';
import { AgentControlCenter } from './agents/agent-control-center.js';
import { AgentArtifactStore } from './agents/artifact-store.js';
import { FakeAgentProvider } from './agents/fake-agent-provider.js';
import { MemoryAgentRunStore } from './agents/run-store.js';
import { defaultConfig } from './config/defaults.js';
import type { ApplicationCase, IdentityProfile } from './domain/models.js';
import type { AgentRunHandle, ProviderRunContext } from './ports/agent-runner.js';
import { MemoryAuditLogger } from './services/audit-logger.js';
import {
  ApplicationPipelineProofAuthority,
  StaticApplicationPipelineProofKeyProvider,
} from './services/application-pipeline-proof.js';
import { MemoryConfigStore } from './services/config-store.js';
import { MemoryWorkspaceStore } from './services/workspace-store.js';

const roots: string[] = [];
const centers: AgentControlCenter[] = [];
afterEach(async () => {
  await Promise.allSettled(centers.splice(0).map((center) => center.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const runtimeTarget = process.platform === 'win32' ? 'windows' as const : 'linux' as const;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const repositoryRoot = resolve(process.cwd(), '..');
const realIdentity: IdentityProfile = {
  id: 'real-candidate', label: 'Real candidate', mode: 'real', fullName: 'Erika Beispiel',
  email: 'erika@example.test', phone: '', location: 'Berlin', linkedin: '', placeholders: {},
};

function configuredStore(real = false): MemoryConfigStore {
  const configuration = structuredClone(defaultConfig);
  configuration.assistant = {
    skillPath: resolve(repositoryRoot, 'integrations', 'bewerbungs-schreib-assistent'),
    candidateProfilePath: resolve(repositoryRoot, 'integrations', 'bewerbungs-schreib-assistent', 'tests', 'fixtures', 'valid-candidate.yaml'),
    styleProfilePath: resolve(repositoryRoot, 'integrations', 'bewerbungs-schreib-assistent', 'tests', 'fixtures', 'valid-style.yaml'),
  };
  if (real) {
    configuration.identities = [realIdentity];
    configuration.activeIdentityId = realIdentity.id;
  }
  return new MemoryConfigStore(configuration);
}

async function apiFixture(options: { real?: boolean; provider?: FakeAgentProvider } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'agent-orchestration-api-'));
  roots.push(root);
  const store = configuredStore(options.real);
  const workspace = new MemoryWorkspaceStore();
  const proofAuthority = new ApplicationPipelineProofAuthority(
    new StaticApplicationPipelineProofKeyProvider(randomBytes(32)),
  );
  const workRoot = resolve(root, 'application-work');
  const dependencies = createDefaultAgentApiDependencies(true);
  dependencies.artifacts = new AgentArtifactStore(resolve(root, 'agent-artifacts'));
  if (options.provider) {
    const runStore = new MemoryAgentRunStore();
    const center = new AgentControlCenter(runStore, [options.provider], {
      maxParallel: 2, maxParallelPerProvider: 2, allowedWorkspaceRoots: [dependencies.workspaceRoot],
    });
    dependencies.center = center;
    dependencies.store = runStore;
    dependencies.providers = [options.provider];
  }
  centers.push(dependencies.center);
  const app = createApp(
    store, new MemoryAuditLogger(), workspace, undefined, dependencies,
    { proofAuthority, workRoot },
  );
  return { app, root, store, workspace, proofAuthority, workRoot, dependencies };
}

async function waitForStatus(
  app: ReturnType<typeof createApp>,
  id: string,
  statuses: readonly string[] = ['succeeded', 'failed', 'waiting_for_gate', 'cancelled'],
): Promise<Response> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await request(app).get(`/api/agent-orchestrations/${id}`);
    if (response.status === 200 && statuses.includes(String(response.body.status))) return response;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`orchestration_did_not_reach:${statuses.join(',')}`);
}

function application(): ApplicationCase {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    job: {
      id: 'JOB-ORCHESTRATION-1', sourceId: 'test', title: 'Senior Software Engineer', company: 'Example GmbH',
      location: 'Berlin', workModel: 'hybrid', employmentType: 'full_time', description: 'RabbitMQ', skills: ['RabbitMQ'],
    },
    identityId: realIdentity.id,
    identityMode: 'real',
    documentType: 'cover_letter',
    state: 'review',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    artifactNames: [], warnings: [], revision: 4,
  };
}

class BlockingFakeProvider extends FakeAgentProvider {
  private readonly releases = new Map<string, () => void>();

  override async start(context: ProviderRunContext): Promise<AgentRunHandle> {
    let release!: () => void;
    const blocked = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    this.releases.set(context.runId, release);
    const completion = (async () => {
      await context.emit({ kind: 'process_started', data: { pid: 0, synthetic: true } });
      await blocked;
      this.releases.delete(context.runId);
      return { state: 'cancelled' as const };
    })();
    return { runId: context.runId, completion };
  }

  override async cancel(runId: string): Promise<void> { this.releases.get(runId)?.(); }
  override async dispose(): Promise<void> {
    for (const release of this.releases.values()) release();
    this.releases.clear();
  }
}

describe('public agent orchestration API', () => {
  it('creates guided server-owned analysis and exposes only the persisted safe projection via get/list', async () => {
    const value = await apiFixture();
    const privatePrompt = 'Find jobs for Erika Private via erika.private@example.test.';
    const created = await request(value.app).post('/api/agent-orchestrations').send({
      workflowId: 'guided-job-analysis', providerId: 'fake', prompt: privatePrompt, runtimeTarget,
    });
    expect(created.status, created.text).toBe(202);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.text).not.toContain(privatePrompt);
    expect(created.text).not.toContain('erika.private@example.test');
    expect(created.body).toMatchObject({
      workflowId: 'guided-job-analysis', providerId: 'fake', status: 'queued',
      producesSuggestionsOnly: true, promptSha256: digest(privatePrompt),
      scope: { workspaceRootId: 'workspace-local', identityMode: 'incognito' },
    });

    const completed = await waitForStatus(value.app, created.body.id);
    expect(completed.body.status, JSON.stringify(completed.body, null, 2)).toBe('succeeded');
    expect(completed.body.nodes.map((node: { nodeId: string; status: string }) => [node.nodeId, node.status])).toEqual([
      ['source-analysis', 'succeeded'], ['evidence-ranking', 'succeeded'],
    ]);
    expect(completed.body.artifactRefs).toHaveLength(2);
    expect(completed.body.artifactRefs.every((artifact: { lifecycle: string }) => artifact.lifecycle === 'proposed')).toBe(true);
    expect(completed.headers['cache-control']).toBe('no-store');

    const listed = await request(value.app).get('/api/agent-orchestrations');
    expect(listed.status).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.body.orchestrations).toContainEqual(expect.objectContaining({ id: created.body.id, status: 'succeeded' }));
    expect(listed.text).not.toContain(privatePrompt);
    expect((await request(value.app).get('/api/agent-orchestrations/33333333-3333-4333-8333-333333333333')).status).toBe(404);
  });

  it('runs a first-time five-node package chain without an unrelated old revision and leaves the new package proposed', async () => {
    const pipelinePackage = JSON.stringify({
      annotatedContent: 'Belegter Vorschlag. <!-- evidence: claim-role -->',
      iterationManifest: 'schema_version: 1\nmode: standard\nexecution: independent_agents\ncycle: 1\npasses: []\n',
    });
    const value = await apiFixture({
      real: true,
      provider: new FakeAgentProvider({
        steps: [{ kind: 'agent_message_completed', data: { text: pipelinePackage } }],
        outcome: { state: 'succeeded' },
      }),
    });
    const current = application();
    await value.workspace.saveApplicationCase(current);
    const premature = await request(value.app).post('/api/agent-orchestrations').send({
      workflowId: 'evidence-application-package', providerId: 'fake', prompt: 'Premature confirmation must fail.',
      runtimeTarget, applicationCaseId: current.id, confirmations: { userInput: { confirmed: true } },
    });
    expect(premature.status).toBe(400);
    const created = await request(value.app).post('/api/agent-orchestrations').send({
      workflowId: 'evidence-application-package', providerId: 'fake', prompt: 'Prepare an evidence-backed proposal.',
      runtimeTarget, applicationCaseId: current.id,
    });
    expect(created.status, created.text).toBe(202);
    const waiting = await waitForStatus(value.app, created.body.id, ['waiting_for_gate', 'failed']);
    expect(waiting.body.status).toBe('waiting_for_gate');
    expect(waiting.body.unresolvedGates).toEqual([{ nodeId: 'finalizer', gate: 'user_input' }]);
    expect(waiting.body.resolvedGates).toContainEqual(expect.objectContaining({
      nodeId: 'evidence', gate: 'evidence_complete', authority: 'server_evidence',
    }));
    const successfulRunIds = structuredClone(waiting.body.nodeRunIds);
    expect(Object.values(successfulRunIds).flat()).toHaveLength(4);
    expect(successfulRunIds.finalizer).toEqual([]);

    const stale = await request(value.app).post(`/api/agent-orchestrations/${created.body.id}/continue`).send({
      expectedRevision: waiting.body.revision - 1,
      userInput: { confirmed: true },
    });
    expect(stale.status).toBe(409);

    const continued = await request(value.app).post(`/api/agent-orchestrations/${created.body.id}/continue`).send({
      expectedRevision: waiting.body.revision,
      userInput: { confirmed: true },
    });
    expect(continued.status, continued.text).toBe(200);
    expect(continued.body.status).toBe('running');
    expect(continued.body.unresolvedGates).toEqual([]);
    expect(continued.body.resolvedGates).toContainEqual(expect.objectContaining({
      nodeId: 'finalizer', gate: 'user_input', authority: 'server_revision_confirmation',
    }));

    const completed = await waitForStatus(value.app, created.body.id);
    expect(completed.body.status, JSON.stringify(completed.body, null, 2)).toBe('succeeded');
    expect(Object.values(completed.body.nodeRunIds).flat()).toHaveLength(5);
    for (const nodeId of ['evidence', 'author', 'ats', 'style']) {
      expect(completed.body.nodeRunIds[nodeId]).toEqual(successfulRunIds[nodeId]);
    }
    expect(completed.body.nodeRunIds.finalizer).toHaveLength(1);
    expect(completed.body.artifactRefs).toHaveLength(5);
    const finalArtifactId = completed.body.nodes.find((node: { nodeId: string }) => node.nodeId === 'finalizer').artifacts[0].artifactId;
    expect(await value.dependencies.artifacts.get(finalArtifactId)).toMatchObject({
      kind: 'application-pipeline-package', mediaType: 'application/json', lifecycle: 'proposed',
      provenance: { identityMode: 'real' },
    });
  }, 30_000);

  it('cancels a running orchestration only with the current revision and explicit confirmation', async () => {
    const provider = new BlockingFakeProvider();
    const value = await apiFixture({ provider });
    const created = await request(value.app).post('/api/agent-orchestrations').send({
      workflowId: 'guided-job-analysis', providerId: 'fake', prompt: 'Run a cancellable analysis.', runtimeTarget,
    });
    expect(created.status, created.text).toBe(202);
    let running: Response | undefined;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const candidate = await request(value.app).get(`/api/agent-orchestrations/${created.body.id}`);
      const source = candidate.body.nodes?.find((node: { nodeId: string }) => node.nodeId === 'source-analysis');
      if (candidate.body.status === 'running' && source?.status === 'running' && source.runIds?.length === 1) {
        running = candidate;
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    expect(running?.body.status).toBe('running');

    expect((await request(value.app).post(`/api/agent-orchestrations/${created.body.id}/cancel`).send({
      expectedRevision: running!.body.revision - 1, confirmed: true,
    })).status).toBe(409);
    expect((await request(value.app).post(`/api/agent-orchestrations/${created.body.id}/cancel`).send({
      expectedRevision: running!.body.revision, confirmed: false,
    })).status).toBe(400);

    const latest = await request(value.app).get(`/api/agent-orchestrations/${created.body.id}`);
    const cancelled = await request(value.app).post(`/api/agent-orchestrations/${created.body.id}/cancel`).send({
      expectedRevision: latest.body.revision, confirmed: true,
    });
    expect(cancelled.status, cancelled.text).toBe(200);
    const terminal = await waitForStatus(value.app, created.body.id, ['cancelled', 'failed']);
    expect(terminal.body).toMatchObject({ status: 'cancelled', failureReason: 'orchestration_cancelled' });
  });
});
