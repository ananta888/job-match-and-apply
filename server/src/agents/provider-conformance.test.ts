import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentProviderInstallation, ProviderRunContext } from '../ports/agent-runner.js';
import { GenericJsonlAgentAdapter } from './generic-jsonl-adapter.js';
import {
  CLAUDE_CLI_MANIFEST,
  OPENCODE_MANIFEST,
  mapClaudeStreamEvent,
  mapOpenCodeJsonEvent,
} from './provider-adapters.js';
import type { SupervisedProcess } from './process-supervisor.js';

interface ConformanceFixture {
  provider: string;
  providerVersion: string;
  versionOutput: string;
  activation: string;
  conformance: {
    runtimeTarget: string;
    argumentTemplate: string[];
    promptTransport: string;
    sandboxBackend: string;
    networkIsolation: string;
    networkAccessClaim: string;
    approvalMode: string;
  };
  events: unknown[];
}

async function fixture(name: string): Promise<ConformanceFixture> {
  return JSON.parse(await readFile(resolve(process.cwd(), '..', 'contracts', 'fixtures', 'v1', name), 'utf8')) as ConformanceFixture;
}

describe('exact provider conformance manifests', () => {
  it('allowlists only OpenCode 1.14.41 with the pure structured WSL contract', () => {
    expect(OPENCODE_MANIFEST.adapterVersion).toBe('1.1.0');
    expect(OPENCODE_MANIFEST.testedVersionPatterns).toEqual(['^1\\.14\\.41$']);
    expect(OPENCODE_MANIFEST.command).toEqual({
      args: ['run', '--pure', '--agent', 'job-match-read-only', '--format', 'json', '--dir', '{workspace}'],
      promptTransport: 'stdin',
      modelArgs: ['--model', '{model}'],
    });
    expect(OPENCODE_MANIFEST.capabilities).toMatchObject({
      resume: false,
      approvals: false,
      sandboxPolicies: ['read-only'],
      extensions: {
        pause: false,
        pauseSemantics: 'unsupported_cancel_only',
        externalSandbox: 'wsl-bubblewrap-v1',
        networkEnforcement: 'provider-tool-capability-policy',
        networkMechanism: 'server-owned-read-only-tool-allowlist',
        networkAccessClaim: 'provider-control-plane-only',
      },
    });
  });

  it('allowlists only Claude Code 2.1.232 with a read-only plan-mode tool allowlist', () => {
    expect(CLAUDE_CLI_MANIFEST.adapterVersion).toBe('1.1.0');
    expect(CLAUDE_CLI_MANIFEST.testedVersionPatterns).toEqual(['^2\\.1\\.23[2-4] \\(Claude Code\\)$']);
    expect(CLAUDE_CLI_MANIFEST.command).toEqual({
      args: [
        '--safe-mode', '-p', '--output-format', 'stream-json', '--verbose',
        '--permission-mode', 'acceptEdits', '--tools', 'Read', '--disallowedTools', 'mcp__*',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--disable-slash-commands', '--no-session-persistence',
      ],
      promptTransport: 'stdin',
      modelArgs: ['--model', '{model}'],
    });
    expect(CLAUDE_CLI_MANIFEST.capabilities).toMatchObject({
      resume: false,
      approvals: false,
      sandboxPolicies: ['read-only'],
      extensions: {
        pause: false,
        pauseSemantics: 'unsupported_cancel_only',
        permissionMode: 'acceptEdits',
        builtinToolAllowlist: ['Read'],
        customizations: 'safe-mode-strict-empty-mcp-and-slash-commands-disabled',
      },
    });
  });

  it.each([
    ['opencode-events.json', OPENCODE_MANIFEST],
    ['claude-cli-events.json', CLAUDE_CLI_MANIFEST],
  ] as const)('binds %s to its exact version, argv and enforcement evidence', async (name, manifest) => {
    const corpus = await fixture(name);
    expect(corpus.provider).toBe(manifest.id);
    expect(new RegExp(manifest.testedVersionPatterns[0] ?? '').test(corpus.versionOutput)).toBe(true);
    expect(corpus.providerVersion).not.toBe('unverified');
    expect(corpus.activation).toBe('supported_exact_version_offline_read_only');
    expect(corpus.conformance).toEqual(expect.objectContaining({
      runtimeTarget: 'wsl',
      argumentTemplate: manifest.command.args,
      promptTransport: 'stdin',
      sandboxBackend: 'wsl-bubblewrap-v1',
      networkIsolation: 'provider-tool-capability-policy',
      networkAccessClaim: 'provider-control-plane-only',
      approvalMode: 'deny',
    }));
  });

  it('publishes only the same exact versions and honest offline profile in the support contract', async () => {
    const support = JSON.parse(await readFile(resolve(process.cwd(), '..', 'contracts', 'v1', 'agent-provider-support.json'), 'utf8')) as {
      unknownVersionPolicy: string;
      providers: Array<Record<string, unknown>>;
    };
    expect(support.unknownVersionPolicy).toBe('block');
    for (const manifest of [OPENCODE_MANIFEST, CLAUDE_CLI_MANIFEST]) {
      expect(support.providers.find((provider) => provider.id === manifest.id)).toEqual(expect.objectContaining({
        adapterVersion: '1.1.0',
        status: 'supported',
        testedVersionPatterns: manifest.testedVersionPatterns,
        runtimeTargets: ['wsl'],
        supportedProfiles: ['read_only_agent_tools_offline'],
        promptTransport: 'stdin',
        approvalMode: 'deny',
        resume: false,
        pause: false,
        networkEnforcement: 'provider-tool-capability-policy',
        networkAccessClaim: 'provider-control-plane-only',
      }));
    }
  });

  it('rejects a stale or forged supported version again at the spawn boundary', async () => {
    const supervisor = { start(): SupervisedProcess { throw new Error('provider must not spawn'); } };
    const adapter = new GenericJsonlAgentAdapter(OPENCODE_MANIFEST, supervisor);
    const installation: AgentProviderInstallation = {
      provider: 'opencode', runtimeTarget: 'wsl', executable: 'C:\\Windows\\System32\\wsl.exe',
      distribution: 'Ubuntu', runtimeExecutable: '/usr/local/bin/opencode', version: '1.14.42', support: 'supported',
    };
    const context: ProviderRunContext = {
      runId: 'stale-version', installation,
      request: {
        provider: 'opencode', task: 'safe synthetic task', workspaceRoot: process.cwd(), runtimeTarget: 'wsl',
        sandbox: 'read-only', network: 'disabled', approvalMode: 'deny',
      },
      async emit() {},
    };
    await expect(adapter.start(context)).rejects.toThrow('Provider-Version ist nicht durch Contract-Fixtures freigegeben.');
    await expect(adapter.start({
      ...context,
      runId: 'forged-version-line',
      installation: { ...installation, version: '1.14.41\n' },
    })).rejects.toThrow('Provider-Version ist nicht durch Contract-Fixtures freigegeben.');
    await expect(adapter.start({
      ...context,
      runId: 'unsupported-runtime',
      installation: { ...installation, runtimeTarget: 'windows', version: '1.14.41' },
      request: { ...context.request, runtimeTarget: 'windows' },
    })).rejects.toThrow('Runtime windows wird von opencode nicht angeboten.');
  });

  it.each([
    ['opencode', OPENCODE_MANIFEST, '1.14.41'],
    ['claude-cli', CLAUDE_CLI_MANIFEST, '2.1.232 (Claude Code)'],
  ] as const)('keeps the %s prompt out of argv and writes it to stdin', async (provider, source, version) => {
    let launched: { args: readonly string[]; stdin?: string } | undefined;
    const supervisor = { start(spec: { args: readonly string[]; stdin?: string }): SupervisedProcess {
      launched = spec;
      return {
        completion: Promise.resolve({ termination: 'exit', exitCode: 0, signal: null, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, startedAt: 'a', finishedAt: 'b' }),
        async writeInput() {}, async cancel() {},
      };
    } };
    const manifest = structuredClone(source);
    manifest.capabilities.supportedRuntimeTargets = ['windows'];
    manifest.capabilities.extensions = { ...manifest.capabilities.extensions, externalSandbox: false };
    const adapter = new GenericJsonlAgentAdapter(manifest, supervisor);
    const prompt = 'synthetic prompt absent from process list';
    const handle = await adapter.start({
      runId: `${provider}-stdin`,
      installation: { provider, runtimeTarget: 'windows', executable: process.execPath, version, support: 'supported' },
      request: { provider, task: prompt, workspaceRoot: process.cwd(), runtimeTarget: 'windows', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny' },
      async emit() {},
    });
    await handle.completion;
    expect(launched?.stdin).toBe(prompt);
    expect(launched?.args).not.toContain(prompt);
  });
});

describe('exact provider event corpora', () => {
  it('maps OpenCode 1.14.41 step, tool, usage and error records structurally', () => {
    expect(mapOpenCodeJsonEvent({
      type: 'tool_use', sessionID: 'ses_synthetic',
      part: { id: 'prt_tool', type: 'tool', tool: 'read', state: { status: 'completed', output: 'synthetic output' } },
    })).toEqual([{
      kind: 'tool_completed',
      data: { id: 'prt_tool', name: 'read', providerEventType: 'tool_use', status: 'completed', output: 'synthetic output' },
    }]);
    expect(mapOpenCodeJsonEvent({
      type: 'step_finish', sessionID: 'ses_synthetic',
      part: { id: 'prt_step', type: 'step-finish', tokens: { input: 8, output: 3, reasoning: 1, cache: { read: 2, write: 0 } }, cost: 0 },
    })).toEqual([{
      kind: 'usage_updated', data: { inputTokens: 8, cachedInputTokens: 2, outputTokens: 3, reasoningTokens: 1 },
    }]);
    expect(mapOpenCodeJsonEvent({ type: 'error', error: { name: 'SyntheticError', data: { message: 'synthetic failure' } } })).toEqual([{
      kind: 'error', data: { code: 'SyntheticError', message: 'synthetic failure', retryable: false },
    }]);
    expect(mapOpenCodeJsonEvent({
      type: 'part_updated',
      part: { type: 'text', text: '{"contract":"ai-cv-structure-proposal"}' },
    })).toEqual([{
      kind: 'agent_message_completed', data: { text: '{"contract":"ai-cv-structure-proposal"}' },
    }]);
    expect(mapOpenCodeJsonEvent({
      contract: 'ai-cv-structure-proposal', contract_version: '1.0', employment: [],
    })[0]).toMatchObject({ kind: 'agent_message_completed' });
  });

  it('validates the Claude 2.1.232 init proof and fails closed on broader runtime capabilities', () => {
    const valid = {
      type: 'system', subtype: 'init', session_id: 'session-synthetic', claude_code_version: '2.1.232',
      permissionMode: 'acceptEdits', tools: ['Read'], mcp_servers: [], plugins: [], skills: [], slash_commands: [],
    };
    expect(mapClaudeStreamEvent(valid)).toEqual([{
      kind: 'heartbeat',
      data: { phase: 'initialized', sessionId: 'session-synthetic', providerVersion: '2.1.232', permissionMode: 'acceptEdits', tools: ['Read'] },
    }]);
    // The pin also accepts the verified 2.1.233 and 2.1.234 lines (identical narrow capability shape).
    expect(mapClaudeStreamEvent({ ...valid, claude_code_version: '2.1.233' })[0]).toMatchObject({
      kind: 'heartbeat', data: { providerVersion: '2.1.233', permissionMode: 'acceptEdits', tools: ['Read'] },
    });
    expect(mapClaudeStreamEvent({ ...valid, claude_code_version: '2.1.234' })[0]).toMatchObject({
      kind: 'heartbeat', data: { providerVersion: '2.1.234', permissionMode: 'acceptEdits', tools: ['Read'] },
    });
    expect(mapClaudeStreamEvent({ ...valid, claude_code_version: '2.1.231' })[0]?.kind).toBe('error');
    expect(mapClaudeStreamEvent({ ...valid, tools: ['Read', 'Bash'] })).toEqual([{
      kind: 'error',
      data: { code: 'claude_runtime_conformance_mismatch', message: 'Claude-Runtime meldet breitere oder unvollstaendige Capabilities.', retryable: false },
    }]);
    expect(mapClaudeStreamEvent({ ...valid, permissionMode: 'bypassPermissions' })[0]?.kind).toBe('error');
    expect(mapClaudeStreamEvent({ ...valid, mcp_servers: [{ name: 'unexpected', status: 'connected' }] })[0]?.kind).toBe('error');
    expect(mapClaudeStreamEvent({
      type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500,
      error: 'Bearer must-not-be-copied',
    })).toEqual([{
      kind: 'warning',
      data: { code: 'provider_api_retry', attempt: 1, maxRetries: 10, retryDelayMs: 500, errorCategory: 'unknown' },
    }]);
  });

  it('maps Claude tool lifecycle without duplicating final result text', () => {
    expect(mapClaudeStreamEvent({
      type: 'assistant', message: { content: [
        { type: 'text', text: 'synthetic result' },
        { type: 'tool_use', id: 'tool-synthetic', name: 'Read', input: { file_path: 'private-path-not-copied' } },
      ] },
    })).toEqual([
      { kind: 'agent_message_completed', data: { text: 'synthetic result' } },
      { kind: 'tool_started', data: { id: 'tool-synthetic', name: 'Read' } },
    ]);
    expect(mapClaudeStreamEvent({
      type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-synthetic', content: 'synthetic output' }] },
    })).toEqual([{
      kind: 'tool_completed', data: { id: 'tool-synthetic', status: 'completed', output: 'synthetic output' },
    }]);
    expect(mapClaudeStreamEvent({
      type: 'result', subtype: 'success', result: 'synthetic result', usage: { input_tokens: 8, output_tokens: 3 },
    })).toEqual([{ kind: 'usage_updated', data: { inputTokens: 8, outputTokens: 3 } }]);
  });

  it.each([
    ['opencode-events.json', mapOpenCodeJsonEvent],
    ['claude-cli-events.json', mapClaudeStreamEvent],
  ] as const)('replays the exact-version %s corpus without copying unknown fields', async (name, mapper) => {
    const corpus = await fixture(name);
    const normalized = corpus.events.flatMap((event) => mapper(event));
    expect(normalized.length).toBeGreaterThan(3);
    expect(normalized.some((event) => event.kind === 'warning')).toBe(true);
    expect(JSON.stringify(normalized)).not.toContain('must-not-be-copied');
  });
});
