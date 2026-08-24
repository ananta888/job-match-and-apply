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

  it('runs all five roles without an intermediate browser gate and exposes the final HTML immediately', async () => {
    const finalHtml = '<!doctype html><html lang="de"><head><title>Belegter Vorschlag</title></head><body><h1>Belegter Vorschlag</h1><p>Sicherer Inhalt</p><script>alert(1)</script><!-- evidence: claim-role --></body></html>';
    const value = await apiFixture({
      real: true,
      provider: new FakeAgentProvider({
        steps: [{ kind: 'agent_message_completed', data: { text: finalHtml } }],
        outcome: { state: 'succeeded' },
      }),
    });
    const current = application();
    await value.workspace.saveApplicationCase(current);
    const created = await request(value.app).post('/api/agent-orchestrations').send({
      workflowId: 'evidence-application-package', providerId: 'fake', prompt: 'Prepare an evidence-backed proposal.',
      runtimeTarget, applicationCaseId: current.id,
    });
    expect(created.status, created.text).toBe(202);
    const completed = await waitForStatus(value.app, created.body.id);
    expect(completed.body.status, JSON.stringify(completed.body, null, 2)).toBe('succeeded');
    expect(completed.body.unresolvedGates).toEqual([]);
    expect(completed.body.resolvedGates).toEqual([expect.objectContaining({
      nodeId: 'evidence', gate: 'evidence_complete', authority: 'server_evidence',
    })]);
    expect(Object.values(completed.body.nodeRunIds).flat()).toHaveLength(5);
    expect(completed.body.nodeRunIds.finalizer).toHaveLength(1);
    expect(completed.body.conflicts).toEqual([]);
    expect(completed.body.artifactRefs).toHaveLength(5);
    const finalArtifactId = completed.body.nodes.find((node: { nodeId: string }) => node.nodeId === 'finalizer').artifacts[0].artifactId;
    expect(await value.dependencies.artifacts.get(finalArtifactId)).toMatchObject({
      kind: 'application-final-html', mediaType: 'text/html; charset=utf-8', lifecycle: 'proposed',
      provenance: { identityMode: 'real' },
    });

    const packageReference = completed.body.artifactRefs.find((artifact: { outputRef: string }) => artifact.outputRef === 'final_html');
    const html = await request(value.app)
      .get(`/api/agent-orchestrations/${created.body.id}/result.html`)
      .query({ sha256: packageReference.sha256 });
    expect(html.status, html.text).toBe(200);
    expect(html.headers['content-type']).toMatch(/^text\/html/);
    expect(html.headers['cache-control']).toBe('no-store');
    expect(html.headers['content-security-policy']).toContain("default-src 'none'");
    expect(html.text).toMatch(/^<!doctype html>/i);
    expect(html.text).toContain('Fünfter Agent abgeschlossen · finale HTML-Version');
    expect(html.text).toContain('<h1>Belegter Vorschlag</h1>');
    expect(html.text).toContain('<p>Sicherer Inhalt</p>');
    expect(html.text).not.toContain('alert(1)');
    expect(html.text).not.toContain('evidence:');
    expect(html.text).not.toContain('iterationManifest');

    const stale = await request(value.app)
      .get(`/api/agent-orchestrations/${created.body.id}/result.html`)
      .query({ sha256: '0'.repeat(64) });
    expect(stale.status).toBe(409);
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
