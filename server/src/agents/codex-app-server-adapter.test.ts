import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  AgentCapabilities, AgentEventDraft, AgentProviderInstallation, AgentRunnerPort, AgentRunHandle,
  ApprovalDecision, ProviderRunContext
} from '../ports/agent-runner.js';
import {
  CODEX_APP_SERVER_FEATURE_FLAG,
  CODEX_APP_SERVER_MANIFEST,
  CodexAppServerAgentAdapter,
  FeatureFlaggedCodexAgentAdapter,
  mapCodexAppServerNotification
} from './codex-app-server-adapter.js';
import { PROVIDER_RESOURCE_CEILINGS } from './generic-jsonl-adapter.js';
import type { ProcessCallbacks, ProcessLaunchSpec, ProcessResult, SupervisedProcess } from './process-supervisor.js';

const installation: AgentProviderInstallation = {
  provider: 'codex-exec', runtimeTarget: 'windows', executable: process.execPath,
  version: 'codex-cli 0.147.0', support: 'supported', authStatus: 'authenticated'
};

function context(events: AgentEventDraft[], approvalMode: 'deny' | 'explicit' = 'deny'): ProviderRunContext {
  return {
    runId: 'run-app-server', installation,
    request: {
      provider: 'codex-exec', task: 'synthetic private task', workspaceRoot: process.cwd(), runtimeTarget: 'windows',
      sandbox: 'read-only', network: 'disabled', approvalMode
    },
    async emit(event) { events.push(event); }
  };
}

function result(termination: ProcessResult['termination'] = 'cancelled'): ProcessResult {
  return {
    termination, exitCode: termination === 'exit' ? 0 : null, signal: null, stdout: '', stderr: '',
    stdoutTruncated: false, stderrTruncated: false, startedAt: '2026-08-13T00:00:00Z', finishedAt: '2026-08-13T00:00:01Z'
  };
}

class SyntheticAppServerSupervisor {
  spec?: ProcessLaunchSpec;
  callbacks?: ProcessCallbacks;
  writes: Record<string, unknown>[] = [];
  private complete!: (value: ProcessResult) => void;
  readonly completion = new Promise<ProcessResult>((resolve) => { this.complete = resolve; });
  autoComplete = true;

  start(spec: ProcessLaunchSpec, callbacks: ProcessCallbacks): SupervisedProcess {
    this.spec = spec; this.callbacks = callbacks;
    queueMicrotask(() => callbacks.onStart?.(1234));
    return {
      pid: 1234, completion: this.completion,
      writeInput: async (input) => {
        const message = JSON.parse(input.trim()) as Record<string, unknown>;
        this.writes.push(message);
        const method = message.method;
        if (method === 'initialize') this.send({ id: message.id, result: { userAgent: 'synthetic', platformFamily: 'windows' } });
        if (method === 'thread/start' || method === 'thread/resume') {
          this.send({ id: message.id, result: { thread: { id: 'thr_synthetic' } } });
          this.send({ method: 'thread/started', params: { thread: { id: 'thr_synthetic' } } });
        }
        if (method === 'turn/start') {
          this.send({ id: message.id, result: { turn: { id: 'turn_synthetic', status: 'inProgress', items: [] } } });
          this.send({ method: 'turn/started', params: { turn: { id: 'turn_synthetic', status: 'inProgress', items: [] } } });
          if (this.autoComplete) {
            this.send({ method: 'item/agentMessage/delta', params: { threadId: 'thr_synthetic', turnId: 'turn_synthetic', itemId: 'msg_1', delta: 'synthetic ' } });
            this.send({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'msg_1', text: 'synthetic result' } } });
            this.send({ method: 'turn/completed', params: { turn: { id: 'turn_synthetic', status: 'completed', items: [] } } });
          }
        }
        if (method === 'turn/steer') this.send({ id: message.id, result: { turnId: 'turn_synthetic' } });
        if (method === 'turn/interrupt') this.send({ id: message.id, result: {} });
      },
      cancel: async () => { this.complete(result()); }
    };
  }

  send(message: unknown): void { queueMicrotask(() => this.callbacks?.onStdout?.(`${JSON.stringify(message)}\n`)); }
  finishTurn(): void { this.send({ method: 'turn/completed', params: { turn: { id: 'turn_synthetic', status: 'completed', items: [] } } }); }
}

class FallbackStub implements AgentRunnerPort {
  readonly provider = 'codex-exec'; starts = 0;
  async discover() { return [installation]; }
  async capabilities(): Promise<AgentCapabilities> {
    return { schemaVersion: '1.0', provider: this.provider, adapterVersion: 'fallback', streaming: true, resume: false, interactiveInput: false, approvals: false, tools: true, images: false, structuredOutput: true, sandboxPolicies: ['read-only'], usage: true, supportedRuntimeTargets: ['windows'] };
  }
  async start(run: ProviderRunContext): Promise<AgentRunHandle> { this.starts++; return { runId: run.runId, completion: Promise.resolve({ state: 'succeeded' }) }; }
  async sendInput() { throw new Error('unsupported'); }
  async resolveApproval(_runId: string, _approvalId: string, _decision: ApprovalDecision) { throw new Error('unsupported'); }
  async cancel() {}
  async resume(): Promise<AgentRunHandle> { throw new Error('unsupported'); }
  async dispose() {}
}

describe('Codex App Server experimental adapter', () => {
  it('has a versioned, stdio-only and opt-in manifest', () => {
    expect(CODEX_APP_SERVER_MANIFEST).toMatchObject({
      schemaVersion: '1.0', protocol: 'codex-app-server-jsonrpc-v2', transport: 'stdio-jsonl',
      featureFlag: CODEX_APP_SERVER_FEATURE_FLAG, fallbackProviderId: 'codex-exec'
    });
    expect(CODEX_APP_SERVER_MANIFEST.commandArgs).toEqual([
      'app-server', '--strict-config',
      '-c', 'sandbox_workspace_write.network_access=false',
      '-c', 'web_search="disabled"',
      '--listen', 'stdio://'
    ]);
    expect(CODEX_APP_SERVER_MANIFEST.testedVersionPatterns).toEqual(['^(?:codex-cli|codex)\\s+0\\.147\\.0$']);
    expect(CODEX_APP_SERVER_MANIFEST.commandArgs.join(' ')).not.toMatch(/ws:|wss:|0\.0\.0\.0/);
  });

  it('reports pause as unsupported instead of simulating process suspension', async () => {
    const adapter = new CodexAppServerAgentAdapter(new SyntheticAppServerSupervisor(), undefined, { userConfigIsolationVerified: true });
    await expect(adapter.capabilities(installation)).resolves.toEqual(expect.objectContaining({
      resume: true,
      extensions: expect.objectContaining({
        pause: false,
        pauseSemantics: 'unsupported_cancel_only',
        networkControl: true,
        networkEnforcement: 'codex-cli-0.147.0-fixed-offline-config-v1',
        networkAccessClaim: 'provider-control-plane-only',
        webSearch: 'disabled',
        sandboxNetworkAccess: false,
      }),
    }));
  });

  it('replays the versioned App Server fixture corpus', async () => {
    const fixture = JSON.parse(await readFile(resolve(process.cwd(), '..', 'contracts', 'fixtures', 'v1', 'codex-app-server-events.json'), 'utf8')) as {
      notifications: Array<{ method: string; params: unknown }>;
    };
    const mapped = fixture.notifications.flatMap((notification) => mapCodexAppServerNotification(notification.method, notification.params));
    expect(mapped.map((event) => event.kind)).toEqual(expect.arrayContaining(['agent_message_delta', 'agent_message_completed', 'usage_updated']));
  });

  it('performs initialize/thread/turn healthchecks over stdio and maps a complete turn', async () => {
    const supervisor = new SyntheticAppServerSupervisor(); const events: AgentEventDraft[] = [];
    const adapter = new CodexAppServerAgentAdapter(supervisor, undefined, { requestTimeoutMs: 1_000, userConfigIsolationVerified: true });
    const handle = await adapter.start(context(events));
    expect((await handle.completion).state).toBe('succeeded');
    expect(supervisor.spec?.args).toEqual([
      'app-server', '--strict-config',
      '-c', 'sandbox_workspace_write.network_access=false',
      '-c', 'web_search="disabled"',
      '--listen', 'stdio://'
    ]);
    expect(supervisor.spec?.stdin).toBeUndefined();
    expect(supervisor.spec?.limits).toEqual(expect.objectContaining(PROVIDER_RESOURCE_CEILINGS));
    expect(supervisor.writes.map((entry) => entry.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
    // The protocol mixes casing on purpose and rejects the wrong shape outright
    // (`unknown variant \`onRequest\``), so both are pinned to the values from
    // `codex app-server generate-json-schema`:
    //   AskForApproval -> untrusted | on-request | never   (kebab)
    //   SandboxMode    -> read-only | workspace-write      (kebab)
    //   SandboxPolicy  -> readOnly  | workspaceWrite       (camel)
    expect(supervisor.writes.find((entry) => entry.method === 'thread/start')).toMatchObject({
      params: { approvalPolicy: 'never', sandbox: 'read-only' },
    });
    expect(supervisor.writes.find((entry) => entry.method === 'turn/start')).toMatchObject({
      params: { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } },
    });
    expect(JSON.stringify(supervisor.writes)).not.toContain('onRequest');
    expect(JSON.stringify(supervisor.writes)).not.toContain('"sandbox":"readOnly"');
    expect(JSON.stringify(supervisor.writes)).toContain('synthetic private task');
    expect(events.map((event) => event.kind)).toContain('agent_message_delta');
    expect(events.map((event) => event.kind)).toContain('agent_message_completed');
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'process_started',
      data: expect.objectContaining({
        networkEnforcement: 'codex-cli-0.147.0-fixed-offline-config-v1',
        networkMechanism: 'server-owned-config-plus-codex-sandbox-policy',
        networkAccessClaim: 'provider-control-plane-only',
        webSearch: 'disabled',
        sandboxNetworkAccess: false
      })
    }));
    expect(events.at(-1)).toMatchObject({ kind: 'run_completed', data: { state: 'succeeded', transport: 'codex-app-server' } });
  });

  it('maps turn steering and one-shot approval responses to the active thread and turn', async () => {
    const supervisor = new SyntheticAppServerSupervisor(); supervisor.autoComplete = false;
    const events: AgentEventDraft[] = [];
    const adapter = new CodexAppServerAgentAdapter(supervisor, undefined, { requestTimeoutMs: 1_000, userConfigIsolationVerified: true });
    const handle = await adapter.start(context(events, 'explicit'));
    supervisor.send({ id: 77, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thr_synthetic', turnId: 'turn_synthetic', itemId: 'cmd_1', reason: 'Run tests', command: ['npm', 'test'], cwd: process.cwd()
    } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'approval_requested', data: expect.objectContaining({ id: 'codex-77', itemId: 'cmd_1' }) }));
    await adapter.sendInput('run-app-server', 'focus tests');
    await adapter.resolveApproval('run-app-server', 'codex-77', 'approved');
    expect(supervisor.writes).toContainEqual(expect.objectContaining({ method: 'turn/steer', params: expect.objectContaining({ expectedTurnId: 'turn_synthetic' }) }));
    expect(supervisor.writes).toContainEqual({ id: 77, result: { decision: 'accept' } });
    supervisor.finishTurn();
    expect((await handle.completion).state).toBe('succeeded');
  });

  it('cancels open approvals and the supervised process after a bounded interrupt grace period', async () => {
    const supervisor = new SyntheticAppServerSupervisor(); supervisor.autoComplete = false;
    const events: AgentEventDraft[] = [];
    const adapter = new CodexAppServerAgentAdapter(supervisor, undefined, {
      requestTimeoutMs: 1_000, cancelGraceMs: 25, userConfigIsolationVerified: true,
    });
    const handle = await adapter.start(context(events, 'explicit'));
    supervisor.send({ id: 88, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thr_synthetic', turnId: 'turn_synthetic', itemId: 'cmd_cancel',
      reason: 'synthetic pending command', command: ['node', '--version'], cwd: process.cwd(),
    } });
    await new Promise((resolve) => setImmediate(resolve));
    await adapter.cancel('run-app-server');
    expect(supervisor.writes).toContainEqual({ id: 88, result: { decision: 'cancel' } });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'approval_resolved', data: { id: 'codex-88', decision: 'cancelled' },
    }));
    expect((await handle.completion).state).toBe('cancelled');
  });

  it('resumes the recorded thread in a fresh local stdio process', async () => {
    const sessions: SyntheticAppServerSupervisor[] = [];
    const supervisor = { start(spec: ProcessLaunchSpec, callbacks: ProcessCallbacks): SupervisedProcess {
      const session = new SyntheticAppServerSupervisor(); sessions.push(session); return session.start(spec, callbacks);
    } };
    const adapter = new CodexAppServerAgentAdapter(supervisor, undefined, { requestTimeoutMs: 1_000, userConfigIsolationVerified: true });
    const first = await adapter.start(context([]));
    expect((await first.completion).state).toBe('succeeded');
    const resumed = await adapter.resume('run-app-server', 'continue synthetic work');
    expect((await resumed.completion).state).toBe('succeeded');
    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.writes).toContainEqual(expect.objectContaining({
      method: 'thread/resume', params: expect.objectContaining({ threadId: 'thr_synthetic' })
    }));
  });

  it('fails closed for unknown notification and item types', async () => {
    expect(() => mapCodexAppServerNotification('future/event', {})).toThrow('Unbekanntes');
    expect(() => mapCodexAppServerNotification('item/completed', { item: { id: 'x', type: 'futureItem' } })).toThrow('Unbekannter');
    const supervisor = new SyntheticAppServerSupervisor(); supervisor.autoComplete = false;
    const adapter = new CodexAppServerAgentAdapter(supervisor, undefined, { requestTimeoutMs: 1_000, userConfigIsolationVerified: true });
    const handle = await adapter.start(context([]));
    supervisor.send({ method: 'future/event', params: { secret: 'not-forwarded' } });
    expect(await handle.completion).toMatchObject({ state: 'failed', failure: { code: 'codex_app_server_protocol_error', retryable: false } });
  });

  it('falls back to codex exec for an unknown version before spawning app-server', async () => {
    const appSupervisor = { start(): SupervisedProcess { throw new Error('app-server must not spawn'); } };
    const app = new CodexAppServerAgentAdapter(appSupervisor);
    const fallback = new FallbackStub();
    const adapter = new FeatureFlaggedCodexAgentAdapter(app, fallback, true);
    const events: AgentEventDraft[] = [];
    const unknown = { ...installation, version: 'codex-cli 9.99.0' };
    const handle = await adapter.start({ ...context(events), installation: unknown });
    expect((await handle.completion).state).toBe('succeeded');
    expect(fallback.starts).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'warning', data: expect.objectContaining({ code: 'codex_app_server_fallback', reason: 'version_not_allowlisted' }) }));
  });

  it('keeps app-server disabled unless the feature flag is explicitly enabled', async () => {
    const appSupervisor = { start(): SupervisedProcess { throw new Error('app-server must not spawn'); } };
    const fallback = new FallbackStub();
    const adapter = new FeatureFlaggedCodexAgentAdapter(new CodexAppServerAgentAdapter(appSupervisor), fallback, false);
    const handle = await adapter.start(context([]));
    expect((await handle.completion).state).toBe('succeeded');
    expect(fallback.starts).toBe(1);
  });

  it('fails closed before spawn when the selected offline app-server cannot isolate user config', async () => {
    const appSupervisor = { start(): SupervisedProcess { throw new Error('unisolated app-server must not spawn'); } };
    const fallback = new FallbackStub(); const events: AgentEventDraft[] = [];
    const adapter = new FeatureFlaggedCodexAgentAdapter(new CodexAppServerAgentAdapter(appSupervisor), fallback, true);
    await expect(adapter.start(context(events))).rejects.toThrow('user_config_isolation_unverified');
    expect(fallback.starts).toBe(0);
  });

  it('does not advertise app-server network control without isolated config or for another patch version', async () => {
    const unisolated = new CodexAppServerAgentAdapter(new SyntheticAppServerSupervisor());
    await expect(unisolated.capabilities(installation)).rejects.toThrow('codex_offline_network_control_unverified');
    const isolated = new CodexAppServerAgentAdapter(new SyntheticAppServerSupervisor(), undefined, { userConfigIsolationVerified: true });
    await expect(isolated.capabilities({ ...installation, version: 'codex-cli 0.147.1' }))
      .rejects.toThrow('Codex-Version');
  });

  it('does not weaken an offline preflight claim when the app-server healthcheck fails', async () => {
    const failingSupervisor = { start(): SupervisedProcess {
      return { completion: Promise.resolve(result('exit')), async writeInput() { throw new Error('stdio unavailable'); }, async cancel() {} };
    } };
    const fallback = new FallbackStub(); const events: AgentEventDraft[] = [];
    const adapter = new FeatureFlaggedCodexAgentAdapter(new CodexAppServerAgentAdapter(failingSupervisor, undefined, { requestTimeoutMs: 50, userConfigIsolationVerified: true }), fallback, true);
    await expect(adapter.start(context(events))).rejects.toThrow('stdio unavailable');
    expect(fallback.starts).toBe(0);
  });
});
