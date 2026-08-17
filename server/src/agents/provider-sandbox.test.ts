import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentProviderInstallation } from '../ports/agent-runner.js';
import { assertTrustedHostJobMcpNotNestedInAgentSandbox, WslBubblewrapSandboxBoundary } from './provider-sandbox.js';

const installation: AgentProviderInstallation = {
  provider: 'opencode',
  runtimeTarget: 'wsl',
  distribution: 'Ubuntu',
  executable: 'C:\\Windows\\System32\\wsl.exe',
  runtimeExecutable: '/usr/local/bin/opencode',
  version: '1.14.41',
  support: 'untested'
};

describe('WslBubblewrapSandboxBoundary', () => {
  it('constructs a fixed read-only boundary with a provider-only control plane and no shell tool', async () => {
    const boundary = new WslBubblewrapSandboxBoundary(async () => true, async () => '/home/synthetic');
    const result = await boundary.plan({
      provider: 'opencode',
      installation,
      providerExecutable: '/usr/local/bin/opencode',
      providerArgs: ['run', '--format', 'json', '--dir', '/mnt/c/work', 'safe prompt'],
      workspaceRoot: '/mnt/c/work',
      sandbox: 'read-only',
      network: 'disabled'
    });

    expect(result.executable).toBe(installation.executable);
    expect(result.args.slice(0, 4)).toEqual(['-d', 'Ubuntu', '--', 'bwrap']);
    expect(result.args).not.toContain('--unshare-net');
    expect(result.args).toContain('--ro-bind');
    expect(result.args).not.toContain('--bind');
    expect(result.args.at(-1)).toBe('safe prompt');
    expect(result.networkEnforcement).toBe('provider-tool-capability-policy');
    expect(result.networkMechanism).toBe('server-owned-read-only-tool-allowlist');
    expect(result.networkAccessClaim).toBe('provider-control-plane-only');
    expect(result.args).toContain('--clearenv');
    expect(result.args).toContain('/tmp/agent-home');
    expect(result.args).toContain('OPENCODE_DISABLE_PROJECT_CONFIG');
    const inline = result.args[result.args.indexOf('OPENCODE_CONFIG_CONTENT') + 1] ?? '';
    const config = JSON.parse(inline) as Record<string, unknown>;
    expect(config).toMatchObject({
      share: 'disabled',
      agent: {
        'job-match-read-only': { permission: { '*': 'deny', read: 'allow' } },
        'job-match-no-tools': { permission: { '*': 'deny' } },
      },
    });
    expect(config).not.toHaveProperty('permission');
    // opencode 1.14.41 validates this env-injected config strictly and rejects
    // $schema as an unrecognized key. Carrying it made every sandboxed opencode
    // run die at startup with exit code 1, which surfaced only as 'crash'.
    expect(config).not.toHaveProperty('$schema');
    expect(result.args).toContain('/home/synthetic/.local/share/opencode/auth.json');
  });

  it('binds only the selected workspace for workspace-write', async () => {
    const boundary = new WslBubblewrapSandboxBoundary(async () => true, async () => '/home/synthetic');
    const result = await boundary.plan({
      provider: 'opencode',
      installation,
      providerExecutable: '/usr/local/bin/opencode',
      providerArgs: ['run'],
      workspaceRoot: '/mnt/c/work',
      sandbox: 'workspace-write',
      network: 'disabled'
    });
    const bind = result.args.indexOf('--bind');
    expect(result.args.slice(bind, bind + 3)).toEqual(['--bind', '/mnt/c/work', '/mnt/c/work']);
    expect(result.workspaceAccess).toBe('read_write');
  });

  it('fails closed for unsupported targets, network modes, and missing backends', async () => {
    const available = new WslBubblewrapSandboxBoundary(async () => true, async () => '/home/synthetic');
    await expect(available.plan({
      provider: 'opencode',
      installation: { ...installation, runtimeTarget: 'windows' },
      providerExecutable: '/usr/local/bin/opencode', providerArgs: [], workspaceRoot: '/mnt/c/work',
      sandbox: 'read-only', network: 'disabled'
    })).rejects.toThrow('requires_wsl');
    await expect(available.plan({
      provider: 'opencode',
      installation, providerExecutable: '/usr/local/bin/opencode', providerArgs: [], workspaceRoot: '/mnt/c/work',
      sandbox: 'read-only', network: 'restricted'
    })).rejects.toThrow('network_mode_not_enforceable');
    await expect(new WslBubblewrapSandboxBoundary(async () => false, async () => '/home/synthetic').plan({
      provider: 'opencode',
      installation, providerExecutable: '/usr/local/bin/opencode', providerArgs: [], workspaceRoot: '/mnt/c/work',
      sandbox: 'read-only', network: 'disabled'
    })).rejects.toThrow('backend_unavailable');
    await expect(available.plan({
      provider: 'opencode',
      installation: { ...installation, executable: '/usr/bin/wsl.exe' },
      providerExecutable: '/usr/local/bin/opencode', providerArgs: [], workspaceRoot: '/mnt/c/work',
      sandbox: 'read-only', network: 'disabled'
    })).rejects.toThrow('host_executable_must_be_absolute');
  });
});

describe('trusted-host job MCP separation', () => {
  it('blocks sandboxed providers before a project config can start job-search-mcp', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-mcp-boundary-'));
    try {
      await mkdir(join(root, '.git'));
      await mkdir(join(root, '.opencode'));
      await writeFile(join(root, '.opencode', 'opencode.json'), JSON.stringify({
        mcp: { jobs: { type: 'local', command: ['bash', '-lc', 'exec .venv/bin/job-search-mcp'] } }
      }));
      await expect(assertTrustedHostJobMcpNotNestedInAgentSandbox(root))
        .rejects.toThrow('trusted_host_job_mcp_must_not_run_in_agent_sandbox');
    } finally {
      if (root.startsWith(`${tmpdir()}\\agent-mcp-boundary-`) || root.startsWith(`${tmpdir()}/agent-mcp-boundary-`)) {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it('allows a sandboxed provider when its project has no trusted-host MCP registration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-mcp-boundary-'));
    try {
      await mkdir(join(root, '.git'));
      await writeFile(join(root, 'opencode.json'), JSON.stringify({ permission: { edit: 'deny' } }));
      await expect(assertTrustedHostJobMcpNotNestedInAgentSandbox(root)).resolves.toBeUndefined();
    } finally {
      if (root.startsWith(`${tmpdir()}\\agent-mcp-boundary-`) || root.startsWith(`${tmpdir()}/agent-mcp-boundary-`)) {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it('blocks Codex project MCP and plugin configuration even without the job server name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-mcp-boundary-'));
    try {
      await mkdir(join(root, '.git'));
      await mkdir(join(root, '.codex'));
      await writeFile(join(root, '.codex', 'config.toml'), '[mcp_servers.synthetic]\ncommand = "synthetic-tool"\n');
      await expect(assertTrustedHostJobMcpNotNestedInAgentSandbox(root))
        .rejects.toThrow('agent_managed_mcp_configuration_forbidden');
    } finally {
      if (root.startsWith(`${tmpdir()}\\agent-mcp-boundary-`) || root.startsWith(`${tmpdir()}/agent-mcp-boundary-`)) {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it('blocks common JSON MCP and plugin declarations independent of their configured names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-mcp-boundary-'));
    try {
      await mkdir(join(root, '.git'));
      const declarations = [
        { mcpServers: { synthetic: { command: 'synthetic-tool' } } },
        { plugins: { synthetic: { enabled: true } } },
        { plugin: ['synthetic'] },
        { enabledPlugins: { synthetic: true } }
      ];
      for (const declaration of declarations) {
        await writeFile(join(root, 'opencode.json'), JSON.stringify(declaration));
        await expect(assertTrustedHostJobMcpNotNestedInAgentSandbox(root))
          .rejects.toThrow('agent_managed_mcp_configuration_forbidden');
      }
    } finally {
      if (root.startsWith(`${tmpdir()}\\agent-mcp-boundary-`) || root.startsWith(`${tmpdir()}/agent-mcp-boundary-`)) {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
