import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_CONTRACT_VERSION, type AgentEventDraft, type AgentProviderInstallation, type ProviderRunContext } from '../ports/agent-runner.js';
import { GenericJsonlAgentAdapter, agentManifestFingerprint, type AgentAdapterManifest } from './generic-jsonl-adapter.js';
import { CODEX_EXEC_MANIFEST, CLAUDE_CLI_MANIFEST, OPENCODE_MANIFEST, mapClaudeStreamEvent, mapCodexJsonlEvent, mapOpenCodeJsonEvent } from './provider-adapters.js';
import type { ProcessLaunchSpec, ProcessCallbacks, SupervisedProcess } from './process-supervisor.js';

describe('provider manifests', () => {
  it('uses the documented safe Codex exec contract', () => {
    expect(CODEX_EXEC_MANIFEST.command.args).toEqual(['exec', '--ignore-user-config', '--json', '--color', 'never', '--sandbox', '{sandbox}', '--cd', '{workspace}', '-']);
    expect(CODEX_EXEC_MANIFEST.testedVersionPatterns).toEqual(['^(?:codex-cli|codex)\\s+0\\.147\\.']);
    expect(CODEX_EXEC_MANIFEST.command.args).not.toContain('--yolo');
    expect(CODEX_EXEC_MANIFEST.command.promptTransport).toBe('stdin');
  });

  it('checks Codex project MCP configuration before any provider process is spawned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-project-mcp-'));
    try {
      await mkdir(join(root, '.git'));
      await mkdir(join(root, '.codex'));
      await writeFile(join(root, '.codex', 'config.toml'), '[mcp_servers.jobs]\ncommand = "job-search-mcp"\n');
      const supervisor = { start(): SupervisedProcess { throw new Error('provider must not spawn'); } };
      const adapter = new GenericJsonlAgentAdapter(CODEX_EXEC_MANIFEST, supervisor);
      const installation: AgentProviderInstallation = {
        provider: 'codex-exec', runtimeTarget: 'windows', executable: process.execPath,
        version: 'codex 0.147.0', support: 'supported'
      };
      await expect(adapter.start({
        runId: 'codex-project-mcp', installation,
        request: { provider: 'codex-exec', task: 'safe task', workspaceRoot: root, runtimeTarget: 'windows', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny' },
        async emit() {}
      })).rejects.toThrow('trusted_host_job_mcp_must_not_run_in_agent_sandbox');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps OpenCode and Claude bypass flags out of built-in manifests', () => {
    expect(OPENCODE_MANIFEST.command.args).toEqual(['run', '--format', 'json', '--dir', '{workspace}', '{prompt}']);
    expect(OPENCODE_MANIFEST.command.args).not.toContain('--auto');
    expect(CLAUDE_CLI_MANIFEST.command.args).toContain('plan');
    expect(CLAUDE_CLI_MANIFEST.command.args.join(' ')).not.toContain('bypassPermissions');
    expect(CLAUDE_CLI_MANIFEST.command.args).not.toContain('--dangerously-skip-permissions');
  });

  it('requires explicit fingerprint trust for local manifests', () => {
    const local: AgentAdapterManifest = { ...structuredClone(OPENCODE_MANIFEST), id: 'local-test', trust: 'local' };
    expect(() => new GenericJsonlAgentAdapter(local)).toThrow('explizit freigegeben');
    expect(() => new GenericJsonlAgentAdapter(local, undefined, undefined, undefined, new Set([agentManifestFingerprint(local)]))).not.toThrow();
  });
});

describe('provider event mapping', () => {
  it('maps known Codex events and preserves unknown types as warnings', () => {
    expect(mapCodexJsonlEvent({ type: 'item.completed', item: { id: '1', type: 'agent_message', text: 'done' } })).toEqual([
      { kind: 'agent_message_completed', data: { text: 'done', itemId: '1' } }
    ]);
    expect(mapCodexJsonlEvent({ type: 'future.event', secret: 'not copied' })).toEqual([
      { kind: 'warning', data: { code: 'unknown_codex_event', providerEventType: 'future.event' } }
    ]);
    expect(mapCodexJsonlEvent({ type: 'turn.completed', usage: { input_tokens: 3 } })[0]).toEqual({ kind: 'usage_updated', data: { inputTokens: 3 } });
  });

  it('normalizes synthetic OpenCode and Claude fixtures', () => {
    expect(mapOpenCodeJsonEvent({ type: 'text', text: 'hello' })[0]?.kind).toBe('agent_message_completed');
    expect(mapClaudeStreamEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } })[0]?.data).toEqual({ text: 'hello' });
    expect(mapClaudeStreamEvent({ type: 'result', result: 'done', usage: { input_tokens: 2 } }).map((event) => event.kind)).toEqual(['agent_message_completed', 'usage_updated']);
  });

  it('replays every versioned provider corpus without losing unknown additive types', async () => {
    const fixtures = [
      ['codex-exec-events.json', mapCodexJsonlEvent],
      ['opencode-events.json', mapOpenCodeJsonEvent],
      ['claude-cli-events.json', mapClaudeStreamEvent]
    ] as const;
    for (const [name, mapper] of fixtures) {
      const corpus = JSON.parse(await readFile(resolve(process.cwd(), '..', 'contracts', 'fixtures', 'v1', name), 'utf8')) as { events: unknown[] };
      const normalized = corpus.events.flatMap((event) => mapper(event));
      expect(normalized.length, name).toBeGreaterThan(0);
      expect(normalized.some((event) => event.kind === 'warning'), name).toBe(true);
      expect(JSON.stringify(normalized), name).not.toContain('must-not-be-copied');
    }
  });
});

describe('GenericJsonlAgentAdapter process boundary', () => {
  it('constructs fixed argv, sends the prompt via stdin and emits parsed events', async () => {
    let captured: ProcessLaunchSpec | undefined; let callbacks: ProcessCallbacks | undefined;
    const supervisor = { start(spec: ProcessLaunchSpec, handlers: ProcessCallbacks): SupervisedProcess {
      captured = spec; callbacks = handlers;
      queueMicrotask(() => { handlers.onStart?.(42); handlers.onStdout?.('{"kind":"agent_message_completed","data":{"text":"ok"}}\n'); });
      return { pid: 42, completion: Promise.resolve({ termination: 'exit', exitCode: 0, signal: null, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, startedAt: 'a', finishedAt: 'b' }), async writeInput() {}, async cancel() {} };
    } };
    const manifest = { ...structuredClone(CODEX_EXEC_MANIFEST), id: 'fixture', protocol: 'canonical-jsonl' as const, testedVersionPatterns: ['^fixture 1\\.'] };
    const adapter = new GenericJsonlAgentAdapter(manifest, supervisor, undefined, undefined, undefined, false);
    const emitted: AgentEventDraft[] = [];
    const installation: AgentProviderInstallation = { provider: 'fixture', runtimeTarget: 'windows', executable: process.execPath, version: 'fixture 1.0', support: 'supported' };
    const context: ProviderRunContext = {
      runId: 'run', installation,
      request: { provider: 'fixture', task: 'private task', workspaceRoot: process.cwd(), runtimeTarget: 'windows', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny' },
      async emit(event) { emitted.push(event); }
    };
    const handle = await adapter.start(context);
    expect((await handle.completion).state).toBe('succeeded');
    expect(captured?.args).toEqual(['exec', '--ignore-user-config', '--json', '--color', 'never', '--sandbox', 'read-only', '--cd', process.cwd(), '-']);
    expect(captured?.stdin).toBe('private task');
    expect(captured?.args).not.toContain('private task');
    expect(captured?.env).not.toHaveProperty('SYNTHETIC_PRIVATE_TOKEN');
    expect(emitted.map((event) => event.kind)).toEqual(['process_started', 'agent_message_completed', 'run_completed']);
    expect(callbacks).toBeDefined();
  });

  it('rejects option-like positional prompts and model/profile argument injection', async () => {
    const supervisor = { start(): SupervisedProcess { throw new Error('must not spawn'); } };
    const installation: AgentProviderInstallation = { provider: 'opencode', runtimeTarget: 'windows', executable: process.execPath, version: 'fixture', support: 'supported' };
    const adapter = new GenericJsonlAgentAdapter(OPENCODE_MANIFEST, supervisor, undefined, undefined, undefined, true);
    const base: ProviderRunContext = {
      runId: 'run', installation,
      request: { provider: 'opencode', task: '--auto', workspaceRoot: process.cwd(), runtimeTarget: 'windows', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny' },
      async emit() {}
    };
    await expect(adapter.start(base)).rejects.toThrow('Optionspräfix');
    await expect(adapter.start({ ...base, request: { ...base.request, task: 'safe', model: '--dangerous' } })).rejects.toThrow('Modell');
  });
});
