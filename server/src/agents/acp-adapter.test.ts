import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpAgentAdapter } from './acp-adapter.js';
import type { AgentEventDraft, AgentProviderInstallation, AgentRunRequest } from '../ports/agent-runner.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'acp-adapter-'));
  await mkdir(join(root, '.git'));
  roots.push(root);
  return root;
}

function request(cwd: string): AgentRunRequest {
  return {
    provider: 'acp',
    task: 'Summarize the synthetic workspace.',
    workspaceRoot: cwd,
    runtimeTarget: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux',
    sandbox: 'read-only',
    network: 'disabled',
    approvalMode: 'deny',
  };
}

function installation(cwd: string): AgentProviderInstallation {
  return {
    provider: 'acp',
    runtimeTarget: request(cwd).runtimeTarget,
    executable: process.execPath,
    version: 'acp-synthetic 0.1.0',
    support: 'supported',
    authStatus: 'not_required',
  };
}

describe('AcpAgentAdapter', () => {
  it('completes a synthetic ACP turn and collects the agent text', async () => {
    const cwd = await workspace();
    const events: AgentEventDraft[] = [];
    const adapter = new AcpAgentAdapter(undefined, undefined, true);
    const handle = await adapter.start({
      runId: '11111111-1111-4111-8111-111111111111',
      request: request(cwd),
      installation: installation(cwd),
      async emit(event) { events.push(event); },
    });
    await expect(handle.completion).resolves.toMatchObject({ state: 'succeeded' });
    expect(events.some((event) => event.kind === 'process_started')).toBe(true);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'agent_message_delta', data: expect.objectContaining({ text: 'synthetic acp result' }) }),
      expect.objectContaining({ kind: 'run_completed', data: expect.objectContaining({ state: 'succeeded' }) }),
    ]));
    expect(JSON.stringify(events)).not.toMatch(/sk-|password|BEGIN /);
  }, 15_000);

  it('rejects WSL, network, workspace-write and untested versions', async () => {
    const cwd = await workspace();
    const adapter = new AcpAgentAdapter();
    const base = {
      runId: '22222222-2222-4222-8222-222222222222',
      installation: { ...installation(cwd), support: 'untested' as const, version: 'codex-acp 9.9.9' },
      async emit() { /* unused */ },
    };
    await expect(adapter.start({ ...base, request: request(cwd) })).rejects.toThrow(/nicht durch Contract-Fixtures/);
    await expect(adapter.start({
      ...base,
      installation: installation(cwd),
      request: { ...request(cwd), runtimeTarget: 'wsl', wslDistribution: 'Ubuntu' },
    })).rejects.toThrow(/nicht in WSL/);
    await expect(adapter.start({
      ...base,
      installation: installation(cwd),
      request: { ...request(cwd), network: 'restricted' },
    })).rejects.toThrow(/Netzwerk/);
    await expect(adapter.start({
      ...base,
      installation: installation(cwd),
      request: { ...request(cwd), sandbox: 'workspace-write' },
    })).rejects.toThrow(/read-only/);
  });

  it('does not advertise root tools or a CV-AI zero-tools contract', async () => {
    const cwd = await workspace();
    const capabilities = await new AcpAgentAdapter().capabilities(installation(cwd));
    expect(capabilities.tools).toBe(false);
    expect(capabilities.approvals).toBe(false);
    expect(capabilities.resume).toBe(false);
    expect(capabilities.extensions?.serverOwnedNoToolsMode).toBeUndefined();
    expect(capabilities.extensions?.externalSandbox).toBeUndefined();
    expect(capabilities.extensions?.fsClientMethods).toBe(false);
    expect(capabilities.extensions?.terminalClientMethods).toBe(false);
    expect(capabilities.extensions?.mcpServers).toEqual([]);
    expect(capabilities.extensions?.experimental).toBe(true);
  });

  it('cancels an in-flight prompt through session/cancel', async () => {
    const cwd = await workspace();
    const events: AgentEventDraft[] = [];
    const adapter = new AcpAgentAdapter(undefined, undefined, true, { syntheticHoldPrompt: true });
    const handle = await adapter.start({
      runId: '33333333-3333-4333-8333-333333333333',
      request: request(cwd),
      installation: installation(cwd),
      async emit(event) { events.push(event); },
    });
    for (let attempt = 0; attempt < 50 && !events.some((event) => event.kind === 'process_started'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await adapter.cancel(handle.runId);
    await expect(handle.completion).resolves.toMatchObject({ state: 'cancelled' });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'run_completed', data: expect.objectContaining({ state: 'cancelled' }) }),
    ]));
  }, 15_000);
});
