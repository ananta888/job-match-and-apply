import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type {
  AgentEventDraft,
  AgentProviderInstallation,
  ProviderDomainToolBridge,
  ProviderRunContext,
} from '../ports/agent-runner.js';
import { CodexAppServerAgentAdapter } from './codex-app-server-adapter.js';
import type { ProcessCallbacks, ProcessLaunchSpec, ProcessResult, SupervisedProcess } from './process-supervisor.js';

const installation: AgentProviderInstallation = {
  provider: 'codex-exec', runtimeTarget: 'windows', executable: process.execPath,
  version: 'codex-cli 0.147.0', support: 'supported', authStatus: 'authenticated',
};

class DomainToolSupervisor {
  writes: Record<string, unknown>[] = [];
  callbacks?: ProcessCallbacks;
  spec?: ProcessLaunchSpec;
  private finish!: (result: ProcessResult) => void;
  readonly completion = new Promise<ProcessResult>((resolve) => { this.finish = resolve; });

  start(spec: ProcessLaunchSpec, callbacks: ProcessCallbacks): SupervisedProcess {
    this.spec = spec; this.callbacks = callbacks;
    return {
      pid: 42,
      completion: this.completion,
      writeInput: async (line) => {
        const message = JSON.parse(line.trim()) as Record<string, unknown>;
        this.writes.push(message);
        if (message.method === 'initialize') this.send({ id: message.id, result: { userAgent: 'fixture' } });
        if (message.method === 'thread/start') {
          this.send({ id: message.id, result: { thread: { id: 'thread-1' } } });
          this.send({ method: 'thread/started', params: { thread: { id: 'thread-1' } } });
        }
        if (message.method === 'turn/start') {
          this.send({ id: message.id, result: { turn: { id: 'turn-1' } } });
          this.send({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
        }
      },
      cancel: async () => this.finish({
        termination: 'cancelled', exitCode: null, signal: null, stdout: '', stderr: '',
        stdoutTruncated: false, stderrTruncated: false,
        startedAt: '2026-08-14T00:00:00.000Z', finishedAt: '2026-08-14T00:00:01.000Z',
      }),
    };
  }

  send(value: unknown): void {
    queueMicrotask(() => this.callbacks?.onStdout?.(`${JSON.stringify(value)}\n`));
  }
}

describe('Codex App Server run-bound Root tools', () => {
  it('negotiates exact dynamicTools and services item/tool/call without exposing a capability', async () => {
    const supervisor = new DomainToolSupervisor();
    const calls: Array<{ name: string; args: Readonly<Record<string, unknown>> }> = [];
    let revoked = 0;
    const bridge: ProviderDomainToolBridge = {
      namespace: 'job_match_apply',
      listTools: () => [{
        name: 'jobs.search', title: 'Stellen suchen', description: 'Liest normalisierte Stellen.',
        inputSchema: { type: 'object', properties: { profileId: { type: 'string' } }, required: ['profileId'], additionalProperties: false },
        requiresApproval: false, risk: 'read',
      }],
      async execute(name, args) {
        calls.push({ name, args });
        return { data: { items: [{ id: 'job-1' }] }, sourceReferences: ['job:fixture'] };
      },
      async requestApproval() { throw new Error('mcp_approval_not_required'); },
      async resolveApproval() { throw new Error('mcp_approval_not_required'); },
      async revoke() { revoked += 1; },
    };
    const events: AgentEventDraft[] = [];
    const context: ProviderRunContext = {
      runId: 'domain-tools-run', installation, domainTools: bridge,
      request: {
        provider: 'codex-exec', task: 'Nutze die Root-Werkzeuge.', workspaceRoot: process.cwd(),
        runtimeTarget: 'windows', sandbox: 'read-only', network: 'disabled', approvalMode: 'explicit',
      },
      async emit(event) { events.push(event); },
    };
    const adapter = new CodexAppServerAgentAdapter(supervisor, undefined, {
      userConfigIsolationVerified: true, requestTimeoutMs: 1_000,
    });
    const handle = await adapter.start(context);
    const initialize = supervisor.writes.find((entry) => entry.method === 'initialize')!;
    expect(initialize).toMatchObject({ params: { capabilities: { experimentalApi: true } } });
    const thread = supervisor.writes.find((entry) => entry.method === 'thread/start')!;
    expect(thread).toMatchObject({ params: {
      ephemeral: true,
      dynamicTools: [{ type: 'namespace', name: 'job_match_apply', tools: [{ type: 'function', name: 'jobs__search' }] }],
    } });
    expect(JSON.stringify(supervisor.writes)).not.toMatch(/capabilityToken|approvalToken|Bearer/);

    supervisor.send({
      id: 60, method: 'item/tool/call', params: {
        threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1',
        namespace: 'job_match_apply', tool: 'jobs__search', arguments: { profileId: 'active' },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual([{ name: 'jobs.search', args: { profileId: 'active' } }]);
    expect(supervisor.writes).toContainEqual({
      id: 60,
      result: {
        contentItems: [{ type: 'inputText', text: JSON.stringify({ data: { items: [{ id: 'job-1' }] }, sourceReferences: ['job:fixture'] }) }],
        success: true,
      },
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'tool_requested', data: expect.objectContaining({ name: 'jobs.search' }) }),
      expect.objectContaining({ kind: 'tool_output', data: expect.objectContaining({ success: true }) }),
    ]));

    supervisor.send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
    expect((await handle.completion).state).toBe('succeeded');
    // The control center owns capability revocation; direct adapter use does not
    // pretend to be that composition root.
    expect(revoked).toBe(0);
    await expect(access(String(supervisor.spec?.env?.CODEX_HOME))).rejects.toBeDefined();
  });
});
