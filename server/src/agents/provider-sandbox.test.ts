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
  it('constructs a fixed offline read-only boundary without a shell', async () => {
    const boundary = new WslBubblewrapSandboxBoundary(async () => true);
    const result = await boundary.plan({
      installation,
      providerExecutable: '/usr/local/bin/opencode',
      providerArgs: ['run', '--format', 'json', '--dir', '/mnt/c/work', 'safe prompt'],
      workspaceRoot: '/mnt/c/work',
      sandbox: 'read-only',
      network: 'disabled'
    });

    expect(result.executable).toBe(installation.executable);
    expect(result.args.slice(0, 4)).toEqual(['-d', 'Ubuntu', '--', 'bwrap']);
    expect(result.args).toContain('--unshare-net');
    expect(result.args).toContain('--ro-bind');
    expect(result.args).not.toContain('--bind');
    expect(result.args.at(-1)).toBe('safe prompt');
    expect(result.network).toBe('none');
    expect(result.args).toContain('--clearenv');
    expect(result.args).toContain('/tmp/agent-home');
  });

  it('binds only the selected workspace for workspace-write', async () => {
    const boundary = new WslBubblewrapSandboxBoundary(async () => true);
    const result = await boundary.plan({
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
    const available = new WslBubblewrapSandboxBoundary(async () => true);
    await expect(available.plan({
      installation: { ...installation, runtimeTarget: 'windows' },
      providerExecutable: '/usr/local/bin/opencode', providerArgs: [], workspaceRoot: '/mnt/c/work',
      sandbox: 'read-only', network: 'disabled'
    })).rejects.toThrow('requires_wsl');
    await expect(available.plan({
      installation, providerExecutable: '/usr/local/bin/opencode', providerArgs: [], workspaceRoot: '/mnt/c/work',
      sandbox: 'read-only', network: 'restricted'
    })).rejects.toThrow('network_mode_not_enforceable');
    await expect(new WslBubblewrapSandboxBoundary(async () => false).plan({
      installation, providerExecutable: '/usr/local/bin/opencode', providerArgs: [], workspaceRoot: '/mnt/c/work',
      sandbox: 'read-only', network: 'disabled'
    })).rejects.toThrow('backend_unavailable');
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
