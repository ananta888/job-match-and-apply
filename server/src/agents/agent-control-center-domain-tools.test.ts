import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentRunHandle,
  AgentRunRequest,
  ProviderDomainToolBridge,
  ProviderRunContext,
} from '../ports/agent-runner.js';
import { AgentControlCenter } from './agent-control-center.js';
import { FakeAgentProvider } from './fake-agent-provider.js';
import { MemoryAgentRunStore } from './run-store.js';

const roots: string[] = [];
const centers: AgentControlCenter[] = [];
afterEach(async () => {
  await Promise.allSettled(centers.splice(0).map((center) => center.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-domain-tools-'));
  roots.push(root);
  return root;
}

function runRequest(root: string): AgentRunRequest {
  return {
    provider: 'fake', task: 'Use the exact run-bound jobs tool.', workspaceRoot: root,
    runtimeTarget: process.platform === 'win32' ? 'windows' : 'linux', sandbox: 'read-only',
    network: 'disabled', approvalMode: 'deny', metadata: { requiredRootMcpTools: ['jobs.search'] },
  };
}

async function waitForTerminal(center: AgentControlCenter, runId: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = (await center.get(runId))?.state;
    if (state && ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('agent_run_did_not_settle');
}

function domainBridge() {
  const revoke = vi.fn(async () => undefined);
  const bridge: ProviderDomainToolBridge = {
    namespace: 'job_match_apply',
    listTools: () => [{
      name: 'jobs.search', title: 'Search jobs', description: 'Server-owned job search.',
      inputSchema: { type: 'object', additionalProperties: false }, requiresApproval: false, risk: 'read',
    }],
    execute: vi.fn(async () => ({ data: { jobs: [] }, sourceReferences: ['search-run:synthetic'] })),
    requestApproval: vi.fn(async () => ({
      id: 'approval-1', title: 'Approval', explanation: 'Synthetic', risk: 'read' as const,
      requestedAt: '2026-08-14T00:00:00.000Z', expiresAt: '2026-08-14T00:05:00.000Z',
    })),
    resolveApproval: vi.fn(async () => undefined),
    revoke,
  };
  return { bridge, revoke };
}

describe('AgentControlCenter run-bound domain tools', () => {
  it('passes a runtime-only bridge to the provider and always revokes it after success', async () => {
    const root = await workspace();
    const observed: ProviderDomainToolBridge[] = [];
    class InspectingProvider extends FakeAgentProvider {
      override async start(context: ProviderRunContext): Promise<AgentRunHandle> {
        if (context.domainTools) observed.push(context.domainTools);
        return super.start(context);
      }
    }
    const value = domainBridge();
    const factory = vi.fn(async () => value.bridge);
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [new InspectingProvider()], {
      maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root], domainToolFactory: factory,
    });
    centers.push(center);
    const run = await center.enqueue(runRequest(root));
    expect(await waitForTerminal(center, run.id)).toBe('succeeded');
    expect(factory).toHaveBeenCalledOnce();
    expect(observed).toEqual([value.bridge]);
    expect(value.revoke).toHaveBeenCalledOnce();
    expect(JSON.stringify(await center.get(run.id))).not.toContain('job_match_apply');
    expect(JSON.stringify(await center.events(run.id))).not.toContain('sourceReferences');
  });

  it('fails closed before provider start when declared Root tools have no bridge', async () => {
    const root = await workspace();
    const start = vi.fn();
    class MustNotStartProvider extends FakeAgentProvider {
      override async start(context: ProviderRunContext): Promise<AgentRunHandle> {
        start(context.runId);
        return super.start(context);
      }
    }
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [new MustNotStartProvider()], {
      maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root],
      domainToolFactory: async () => undefined,
    });
    centers.push(center);
    const run = await center.enqueue(runRequest(root));
    expect(await waitForTerminal(center, run.id)).toBe('failed');
    expect(start).not.toHaveBeenCalled();
    expect(await center.get(run.id)).toMatchObject({
      failure: { code: 'agent_run_failed', message: 'required_root_domain_tools_unavailable', retryable: false },
    });
  });

  it('revokes the bridge when provider startup throws and rejects hot-swapping while a run is active', async () => {
    const root = await workspace();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    class FailingProvider extends FakeAgentProvider {
      override async start(context: ProviderRunContext): Promise<AgentRunHandle> {
        await blocked;
        expect(context.domainTools).toBeDefined();
        throw new Error('synthetic_provider_start_failure');
      }
    }
    const value = domainBridge();
    const center = new AgentControlCenter(new MemoryAgentRunStore(), [new FailingProvider()], {
      maxParallel: 1, maxParallelPerProvider: 1, allowedWorkspaceRoots: [root],
      domainToolFactory: async () => value.bridge,
    });
    centers.push(center);
    const run = await center.enqueue(runRequest(root));
    for (let attempt = 0; attempt < 100 && (await center.get(run.id))?.state !== 'starting'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(() => center.configureDomainToolFactory(async () => value.bridge)).toThrow('runs_active');
    release();
    expect(await waitForTerminal(center, run.id)).toBe('failed');
    expect(value.revoke).toHaveBeenCalledOnce();
  });
});
