import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute as isNativeAbsolute, join, posix, win32 } from 'node:path';
import { promisify } from 'node:util';
import type { AgentProviderInstallation, SandboxPolicy } from '../ports/agent-runner.js';
import { buildMinimalLocalChildEnvironment } from '../services/process-environment.js';

const execFileAsync = promisify(execFile);

const PROJECT_AGENT_CONFIGS = [
  'opencode.json', 'opencode.jsonc', join('.opencode', 'opencode.json'), join('.opencode', 'opencode.jsonc'),
  '.mcp.json', join('.claude', 'settings.json'), join('.claude', 'settings.local.json'),
  join('.codex', 'config.toml')
] as const;
const JOB_MCP_REFERENCE = /(?:job-search-mcp|job_search_mcp)/i;
const AGENT_MANAGED_MCP_DECLARATION = /(?:\[\s*(?:mcp_servers|plugins)(?:\.|\])|["'](?:mcp|mcpServers|mcp_servers|plugin|plugins|enabledPlugins)["']\s*:)/i;

async function existingKind(path: string): Promise<'file' | 'directory' | undefined> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('agent_config_symlink_forbidden');
    return stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * A trusted-host portal MCP must never become a descendant of an agent sandbox.
 * Sandboxed providers are therefore blocked if their effective project config
 * could auto-start job-search-mcp. The host-owned MCP remains available through
 * the separate Root stdio adapter.
 */
export async function assertTrustedHostJobMcpNotNestedInAgentSandbox(workspaceRoot: string): Promise<void> {
  if (!isNativeAbsolute(workspaceRoot)) throw new Error('agent_workspace_must_be_absolute');
  let current = workspaceRoot;
  for (let depth = 0; depth < 32; depth += 1) {
    for (const relative of PROJECT_AGENT_CONFIGS) {
      const candidate = join(current, relative);
      if (await existingKind(candidate) !== 'file') continue;
      const contents = await readFile(candidate, 'utf8');
      if (Buffer.byteLength(contents) > 256 * 1024) throw new Error('agent_project_config_too_large');
      if (JOB_MCP_REFERENCE.test(contents)) throw new Error('trusted_host_job_mcp_must_not_run_in_agent_sandbox');
      if (AGENT_MANAGED_MCP_DECLARATION.test(contents)) throw new Error('agent_managed_mcp_configuration_forbidden');
    }
    const gitBoundary = await existingKind(join(current, '.git'));
    if (gitBoundary) return;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
  throw new Error('agent_project_boundary_not_found');
}

export interface ExternalSandboxLaunchRequest {
  provider: 'opencode' | 'claude-cli';
  installation: AgentProviderInstallation;
  providerExecutable: string;
  providerArgs: readonly string[];
  workspaceRoot: string;
  sandbox: SandboxPolicy;
  network: 'disabled' | 'restricted' | 'enabled';
  /** WSL path of a host-created empty directory. OpenCode may write session files there. */
  recoverableStateRoot?: string;
}

export interface ExternalSandboxLaunchPlan {
  executable: string;
  args: string[];
  enforcedBy: 'wsl-bubblewrap-v1';
  workspaceAccess: 'read_only' | 'read_write';
  /** The model control plane may use the network; agent-callable network,
   * shell, MCP and subagent tools are removed by an exact provider policy. */
  networkEnforcement: 'provider-tool-capability-policy';
  networkMechanism: 'server-owned-read-only-tool-allowlist';
  networkAccessClaim: 'provider-control-plane-only';
}

export interface ExternalSandboxBoundary {
  plan(request: ExternalSandboxLaunchRequest): Promise<ExternalSandboxLaunchPlan>;
}

export type WslBubblewrapProbe = (installation: AgentProviderInstallation) => Promise<boolean>;
export type WslUserHomeProbe = (installation: AgentProviderInstallation) => Promise<string>;

function safeDistribution(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value));
}

function isDriveQualifiedWindowsPath(value: string): boolean {
  const root = win32.parse(value).root;
  return win32.isAbsolute(value) && /^[A-Za-z]:[\\/]$/.test(root);
}

/**
 * Executes a fixed, shell-free availability probe. A provider is never started
 * when the local WSL distribution cannot prove that Bubblewrap is executable.
 */
export const probeWslBubblewrap: WslBubblewrapProbe = async (installation) => {
  if (installation.runtimeTarget !== 'wsl' || !safeDistribution(installation.distribution) || !isDriveQualifiedWindowsPath(installation.executable)) return false;
  try {
    await execFileAsync(installation.executable, [
      '-d', installation.distribution, '--', 'bwrap', '--die-with-parent', '--new-session',
      '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
      '--tmpfs', '/tmp', '--chdir', '/tmp', '--', '/bin/true'
    ], { timeout: 5_000, windowsHide: true, maxBuffer: 64 * 1024, env: buildMinimalLocalChildEnvironment() });
    return true;
  } catch {
    return false;
  }
};

/** Resolve the default WSL user's home with fixed, shell-free argv. */
export const probeWslUserHome: WslUserHomeProbe = async (installation) => {
  if (installation.runtimeTarget !== 'wsl' || !safeDistribution(installation.distribution) || !isDriveQualifiedWindowsPath(installation.executable)) {
    throw new Error('external_sandbox_wsl_identity_invalid');
  }
  const options = { timeout: 5_000, windowsHide: true, maxBuffer: 64 * 1024, env: buildMinimalLocalChildEnvironment() } as const;
  const uidResult = await execFileAsync(installation.executable, ['-d', installation.distribution, '--', '/usr/bin/id', '-u'], options);
  const uid = uidResult.stdout.trim();
  if (!/^\d{1,10}$/.test(uid)) throw new Error('external_sandbox_wsl_uid_invalid');
  const passwdResult = await execFileAsync(installation.executable, ['-d', installation.distribution, '--', '/usr/bin/getent', 'passwd', uid], options);
  const fields = passwdResult.stdout.trim().split(':');
  const home = fields[5];
  if (!home || !posix.isAbsolute(home) || home.includes('\0') || home === '/') throw new Error('external_sandbox_wsl_home_invalid');
  return home;
};

// No $schema key: opencode 1.14.41 validates OPENCODE_CONFIG_CONTENT strictly
// and rejects it as an unrecognized key, so every run died at startup with
// "Configuration is invalid at OPENCODE_CONFIG_CONTENT" and exit code 1 — which
// the adapter could only report as a generic crash. A config *file* may carry
// $schema (see integrations/job-search-mcp/.opencode/opencode.json); the
// env-injected content may not.
const OPENCODE_READ_ONLY_CONFIG = JSON.stringify({
  share: 'disabled',
  autoupdate: false,
  plugin: [],
  mcp: {},
  agent: {
    'job-match-read-only': {
      description: 'Server-owned read-only analysis agent.',
      mode: 'primary',
      permission: { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow' },
    },
    'job-match-no-tools': {
      description: 'Server-owned data-only agent with every model-callable tool denied.',
      mode: 'primary',
      permission: { '*': 'deny' },
    },
  },
  default_agent: 'job-match-read-only',
});

/**
 * WSL isolation for CLIs without a verified native sandbox contract.
 *
 * The distribution root is mounted read-only and /tmp is ephemeral. Provider
 * control-plane networking remains available, while the exact provider policy
 * removes model-callable shell, write, MCP and network tools. Only an explicitly
 * selected workspace may be rebound read-write. No value is interpreted by a
 * shell.
 */
export class WslBubblewrapSandboxBoundary implements ExternalSandboxBoundary {
  constructor(
    private readonly probe: WslBubblewrapProbe = probeWslBubblewrap,
    private readonly homeProbe: WslUserHomeProbe = probeWslUserHome,
  ) {}

  async plan(request: ExternalSandboxLaunchRequest): Promise<ExternalSandboxLaunchPlan> {
    const { installation } = request;
    if (installation.runtimeTarget !== 'wsl') throw new Error('external_sandbox_requires_wsl');
    if (!safeDistribution(installation.distribution)) throw new Error('external_sandbox_distribution_invalid');
    // WSL is a Windows-host runtime contract even when this pure planning code
    // is exercised by the Ubuntu CI job. Never interpret its executable with
    // the path rules of the machine running the test.
    if (!isDriveQualifiedWindowsPath(installation.executable)) throw new Error('external_sandbox_host_executable_must_be_absolute');
    if (!posix.isAbsolute(request.providerExecutable) || !posix.isAbsolute(request.workspaceRoot)) {
      throw new Error('external_sandbox_wsl_paths_must_be_absolute');
    }
    if (request.providerExecutable.includes('\0') || request.workspaceRoot.includes('\0') || request.providerArgs.some((value) => value.includes('\0'))) {
      throw new Error('external_sandbox_argument_invalid');
    }
    if (request.network !== 'disabled') throw new Error('external_sandbox_network_mode_not_enforceable');
    if (request.sandbox === 'danger-full-access') throw new Error('external_sandbox_full_access_forbidden');
    if (!await this.probe(installation)) throw new Error('external_sandbox_backend_unavailable');
    if (!['opencode', 'claude-cli'].includes(request.provider)) throw new Error('external_sandbox_provider_not_allowlisted');
    const userHome = await this.homeProbe(installation);

    const workspaceAccess = request.sandbox === 'workspace-write' ? 'read_write' : 'read_only';
    const bubblewrapArgs = [
      'bwrap', '--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc',
      '--unshare-uts', '--ro-bind', '/', '/', '--dev', '/dev',
      '--proc', '/proc', '--tmpfs', '/tmp', '--clearenv',
      '--setenv', 'PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      '--setenv', 'HOME', '/tmp/agent-home', '--setenv', 'XDG_CONFIG_HOME', '/tmp/agent-home/.config',
      '--setenv', 'TMPDIR', '/tmp', '--setenv', 'XDG_CACHE_HOME', '/tmp/agent-cache',
      '--dir', '/tmp/agent-home', '--dir', '/tmp/agent-home/.config', '--dir', '/tmp/agent-cache'
    ];
    if (request.provider === 'opencode') {
      bubblewrapArgs.push(
        '--dir', '/tmp/agent-home/.local', '--dir', '/tmp/agent-home/.local/share',
        '--dir', '/tmp/agent-home/.local/share/opencode',
      );
      if (request.recoverableStateRoot) {
        if (!posix.isAbsolute(request.recoverableStateRoot) || request.recoverableStateRoot.includes('\0')) {
          throw new Error('external_sandbox_argument_invalid');
        }
        bubblewrapArgs.push(
          '--bind', request.recoverableStateRoot, '/tmp/agent-home/.local/share/opencode',
        );
      }
      bubblewrapArgs.push(
        '--ro-bind-try', posix.join(userHome, '.local/share/opencode/auth.json'), '/tmp/agent-home/.local/share/opencode/auth.json',
        '--setenv', 'XDG_DATA_HOME', '/tmp/agent-home/.local/share',
        '--setenv', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'true',
        '--setenv', 'OPENCODE_CONFIG_CONTENT', OPENCODE_READ_ONLY_CONFIG,
      );
    } else {
      bubblewrapArgs.push(
        '--dir', '/tmp/agent-home/.claude',
        '--ro-bind-try', posix.join(userHome, '.claude/.credentials.json'), '/tmp/agent-home/.claude/.credentials.json',
        '--setenv', 'CLAUDE_CONFIG_DIR', '/tmp/agent-home/.claude',
      );
    }
    if (workspaceAccess === 'read_write') bubblewrapArgs.push('--bind', request.workspaceRoot, request.workspaceRoot);
    bubblewrapArgs.push('--chdir', request.workspaceRoot, '--', request.providerExecutable, ...request.providerArgs);

    return {
      executable: installation.executable,
      args: ['-d', installation.distribution, '--', ...bubblewrapArgs],
      enforcedBy: 'wsl-bubblewrap-v1',
      workspaceAccess,
      networkEnforcement: 'provider-tool-capability-policy',
      networkMechanism: 'server-owned-read-only-tool-allowlist',
      networkAccessClaim: 'provider-control-plane-only'
    };
  }
}
