import { chmod, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRuntimeDiscovery, BUILTIN_PROVIDER_DISCOVERY, type DiscoveryCommandExecutor, type ProviderDiscoveryDefinition, validateWorkspaceRoot } from './runtime-discovery.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const definition: ProviderDiscoveryDefinition = {
  provider: 'synthetic', executableNames: ['synthetic-agent'], versionArgs: ['--version'], testedVersionPatterns: [/^synthetic 1\./]
};

describe('AgentRuntimeDiscovery', () => {
  it('marks only the contract-pinned Codex 0.147 line as supported', () => {
    const codex = BUILTIN_PROVIDER_DISCOVERY.find((entry) => entry.provider === 'codex-exec');
    expect(codex?.testedVersionPatterns.some((pattern) => pattern.test('codex-cli 0.147.0'))).toBe(true);
    expect(codex?.testedVersionPatterns.some((pattern) => pattern.test('codex-cli 0.147.1'))).toBe(false);
    expect(codex?.testedVersionPatterns.some((pattern) => pattern.test('codex-cli 0.128.0'))).toBe(false);
    expect(codex?.testedVersionPatterns.some((pattern) => pattern.test('codex-cli 0.148.0'))).toBe(false);
  });

  it('marks only the exact conformance-tested OpenCode and Claude versions as supported', () => {
    const opencode = BUILTIN_PROVIDER_DISCOVERY.find((entry) => entry.provider === 'opencode');
    const claude = BUILTIN_PROVIDER_DISCOVERY.find((entry) => entry.provider === 'claude-cli');
    expect(opencode?.testedVersionPatterns.some((pattern) => pattern.test('1.14.41'))).toBe(true);
    expect(opencode?.testedVersionPatterns.some((pattern) => pattern.test('1.14.42'))).toBe(false);
    expect(claude?.testedVersionPatterns.some((pattern) => pattern.test('2.1.232 (Claude Code)'))).toBe(true);
    expect(claude?.testedVersionPatterns.some((pattern) => pattern.test('2.1.231 (Claude Code)'))).toBe(false);
    expect(claude?.testedVersionPatterns.some((pattern) => pattern.test('2.1.232'))).toBe(false);
  });

  it('discovers WSL installations without shell interpolation and keeps untested versions visible', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const executor: DiscoveryCommandExecutor = {
      async run(executable, args) {
        calls.push({ executable, args });
        if (args[0] === '--list') return { exitCode: 0, stdout: 'Ubuntu\0\r\n', stderr: '' };
        if (args.includes('command -v -- synthetic-agent')) return { exitCode: 0, stdout: '/usr/local/bin/synthetic-agent\n', stderr: '' };
        return { exitCode: 0, stdout: 'synthetic 2.0.0\n', stderr: '' };
      }
    };
    const found = await new AgentRuntimeDiscovery(executor).discoverWsl(definition);
    expect(found[0]).toEqual(expect.objectContaining({ distribution: 'Ubuntu', runtimeExecutable: '/usr/local/bin/synthetic-agent', support: 'untested' }));
    expect(calls.every((call) => call.executable === calls[0]?.executable)).toBe(true);
    expect(calls[0]?.executable).toMatch(/^[A-Za-z]:\\.*\\wsl\.exe$/i);
    expect(calls[1]?.args).toEqual(['-d', 'Ubuntu', '--', 'bash', '-lc', 'command -v -- synthetic-agent']);
  });

  it('gives the CLI version/auth probes a long timeout while enumeration stays quick', async () => {
    const calls: Array<{ args: readonly string[]; timeoutMs?: number }> = [];
    const withAuth: ProviderDiscoveryDefinition = { ...definition, authStatusArgs: ['login', 'status'] };
    const executor: DiscoveryCommandExecutor = {
      async run(_executable, args, timeoutMs) {
        calls.push({ args: [...args], timeoutMs });
        if (args[0] === '--list') return { exitCode: 0, stdout: 'Ubuntu\n', stderr: '' };
        if (args.includes('bash')) return { exitCode: 0, stdout: '/usr/local/bin/synthetic-agent\n', stderr: '' };
        return { exitCode: 0, stdout: 'synthetic 1.0.0\n', stderr: '' };
      }
    };
    await new AgentRuntimeDiscovery(executor).discoverWsl(withAuth);
    expect(calls.find((call) => call.args.includes('--version'))?.timeoutMs).toBeGreaterThanOrEqual(30_000);
    expect(calls.find((call) => call.args.includes('status'))?.timeoutMs).toBeGreaterThanOrEqual(30_000);
    expect(calls.find((call) => call.args[0] === '--list')?.timeoutMs).toBeUndefined();
    expect(calls.find((call) => call.args.includes('bash'))?.timeoutMs).toBeUndefined();
  });

  it('never interpolates an unsafe manifest executable name into the WSL login shell', async () => {
    const calls: string[][] = [];
    const executor: DiscoveryCommandExecutor = { async run(_executable, args) {
      calls.push([...args]);
      return args[0] === '--list' ? { exitCode: 0, stdout: 'Ubuntu\n', stderr: '' } : { exitCode: 1, stdout: '', stderr: '' };
    } };
    await new AgentRuntimeDiscovery(executor).discoverWsl({ ...definition, executableNames: ['safe-agent;touch-pwned'] });
    expect(calls).toHaveLength(1);
  });

  it('drops malformed WSL distribution names before constructing argv', async () => {
    const calls: string[][] = [];
    const executor: DiscoveryCommandExecutor = { async run(_executable, args) {
      calls.push([...args]);
      return args[0] === '--list'
        ? { exitCode: 0, stdout: 'Ubuntu\nbad distribution\n--exec\n', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: '' };
    } };
    await new AgentRuntimeDiscovery(executor).discoverWsl(definition);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.slice(0, 2)).toEqual(['-d', 'Ubuntu']);
  });

  it('maps Windows paths using fixed wslpath arguments', async () => {
    const executor: DiscoveryCommandExecutor = { async run(_executable, args) {
      expect(args).toEqual(['-d', 'Ubuntu', '--', 'wslpath', '-a', '-u', 'C:/Work/With spaces']);
      return { exitCode: 0, stdout: '/mnt/c/Work/With spaces\n', stderr: '' };
    } };
    await expect(new AgentRuntimeDiscovery(executor).windowsPathToWsl('C:\\Work\\With spaces', 'Ubuntu'))
      .resolves.toBe('/mnt/c/Work/With spaces');
    await expect(new AgentRuntimeDiscovery(executor).windowsPathToWsl('/tmp/not-a-windows-path', 'Ubuntu'))
      .rejects.toThrow('Windows-Pfad muss absolut sein');
    await expect(new AgentRuntimeDiscovery(executor).windowsPathToWsl('C:\\Work', '--exec'))
      .rejects.toThrow('WSL-Distribution ist ungueltig');
    await expect(new AgentRuntimeDiscovery(executor).windowsPathToWsl('C:\\Work', 'Ubuntu', 'wsl.exe'))
      .rejects.toThrow('WSL-Host-Executable ist ungueltig');
  });

  it('uses the declared Windows path contract when discovery runs on another host', async () => {
    const executable = 'C:\\Tools\\synthetic-agent.exe';
    const calls: string[] = [];
    const executor: DiscoveryCommandExecutor = { async run(candidate) {
      calls.push(candidate);
      return { exitCode: 0, stdout: 'synthetic 1.0.0\n', stderr: '' };
    } };
    const found = await new AgentRuntimeDiscovery(executor).discoverLocal({
      ...definition, executableNames: [executable]
    }, {}, 'win32');
    expect(calls).toEqual([executable]);
    expect(found).toEqual([expect.objectContaining({ executable, runtimeTarget: 'windows', support: 'supported' })]);
  });
});

describe('validateWorkspaceRoot', () => {
  it('accepts descendants and rejects sibling traversal after realpath normalization', async () => {
    const base = await mkdtemp(join(tmpdir(), 'workspace-root-')); roots.push(base);
    const allowed = join(base, 'allowed'); const child = join(allowed, 'child'); const sibling = join(base, 'sibling');
    await mkdir(child, { recursive: true }); await mkdir(sibling);
    await expect(validateWorkspaceRoot(child, [allowed])).resolves.toBe(await import('node:fs/promises').then(({ realpath }) => realpath(child)));
    await expect(validateWorkspaceRoot(sibling, [allowed])).rejects.toThrow('außerhalb');
  });
});
