import { resolve } from 'node:path';
import type { AppConfig } from '../domain/models.js';
import { inspectTrustedHostMcpRuntime } from '../adapters/mcp-job-source.js';
import { AgentRuntimeDiscovery, defaultWslHostExecutable, isSafeWslDistribution } from '../agents/runtime-discovery.js';

type McpSettings = AppConfig['mcp'];

/**
 * Actively discovers the job-search MCP in both supported trusted-host runtimes — the native Windows
 * venv and the WSL venv — so the user can see which are installed/valid and switch between them.
 * Each candidate is validated with the same launch-path contract the runtime status endpoint uses;
 * a candidate that fails validation (missing venv, stale path) is reported as unavailable rather than
 * throwing, so one broken runtime never hides the other.
 */
export interface JobSearchMcpRuntimeCandidate {
  runtimeTarget: 'windows' | 'wsl';
  available: boolean;
  active: boolean;
  distribution?: string;
  note: string;
}

function nativeCandidateSettings(projectRoot: string, env: Readonly<Record<string, string>>): McpSettings {
  return {
    mode: 'stdio', executionIsolation: 'trusted-host', runtimeTarget: 'windows',
    command: resolve(projectRoot, 'integrations', 'job-search-mcp', '.venv', 'Scripts', 'job-search-mcp.exe'),
    args: [],
    env: {
      ALLOW_EXTERNAL_PORTALS: env.ALLOW_EXTERNAL_PORTALS ?? '0',
      JOB_MCP_STATE_DIR: resolve(projectRoot, '.local-data', 'mcp-state'),
    },
  };
}

async function wslCandidateSettings(
  projectRoot: string, distribution: string, env: Readonly<Record<string, string>>,
): Promise<McpSettings> {
  const wslExecutable = defaultWslHostExecutable();
  const discovery = new AgentRuntimeDiscovery();
  const integrationRoot = await discovery.windowsPathToWsl(resolve(projectRoot, 'integrations', 'job-search-mcp'), distribution, wslExecutable);
  const stateRoot = await discovery.windowsPathToWsl(resolve(projectRoot, '.local-data', 'mcp-state'), distribution, wslExecutable);
  const wslExe = `${integrationRoot}/.venv-wsl/bin/job-search-mcp`;
  return {
    mode: 'stdio', executionIsolation: 'trusted-host', runtimeTarget: 'wsl', distribution,
    command: wslExecutable, args: ['-d', distribution, '--', wslExe],
    env: {
      ALLOW_EXTERNAL_PORTALS: env.ALLOW_EXTERNAL_PORTALS ?? '0',
      JOB_MCP_STATE_DIR: stateRoot,
      WSLENV: 'ALLOW_EXTERNAL_PORTALS:JOB_MCP_STATE_DIR',
    },
  };
}

function isActive(config: McpSettings, candidate: McpSettings): boolean {
  return config.mode === 'stdio' && config.runtimeTarget === candidate.runtimeTarget && config.command === candidate.command;
}

async function evaluate(
  candidate: McpSettings, projectRoot: string, active: boolean,
): Promise<JobSearchMcpRuntimeCandidate> {
  const status = await inspectTrustedHostMcpRuntime(candidate, projectRoot);
  return {
    runtimeTarget: candidate.runtimeTarget as 'windows' | 'wsl',
    available: status.state === 'ready_to_connect', active,
    ...(candidate.distribution ? { distribution: candidate.distribution } : {}),
    note: status.note,
  };
}

/** Build the validated launch settings for a chosen runtime, or throw if it is not available. */
export async function buildJobSearchMcpRuntimeSettings(
  runtimeTarget: 'windows' | 'wsl', config: AppConfig, projectRoot: string,
): Promise<McpSettings> {
  const distribution = config.mcp.distribution && isSafeWslDistribution(config.mcp.distribution) ? config.mcp.distribution : 'Ubuntu';
  const candidate = runtimeTarget === 'windows'
    ? nativeCandidateSettings(projectRoot, config.mcp.env)
    : await wslCandidateSettings(projectRoot, distribution, config.mcp.env);
  const status = await inspectTrustedHostMcpRuntime(candidate, projectRoot);
  if (status.state !== 'ready_to_connect') {
    throw Object.assign(new Error(`Die ${runtimeTarget === 'windows' ? 'native' : 'WSL'}-MCP-Runtime ist nicht verfügbar: ${status.note}`), { statusCode: 409 });
  }
  return candidate;
}

export async function discoverJobSearchMcpRuntimes(
  config: AppConfig, projectRoot = resolve(process.cwd(), '..'),
): Promise<JobSearchMcpRuntimeCandidate[]> {
  const results: JobSearchMcpRuntimeCandidate[] = [];
  const native = nativeCandidateSettings(projectRoot, config.mcp.env);
  results.push(await evaluate(native, projectRoot, isActive(config.mcp, native)));

  const distribution = config.mcp.distribution && isSafeWslDistribution(config.mcp.distribution) ? config.mcp.distribution : 'Ubuntu';
  try {
    const wsl = await wslCandidateSettings(projectRoot, distribution, config.mcp.env);
    results.push(await evaluate(wsl, projectRoot, isActive(config.mcp, wsl)));
  } catch (error) {
    results.push({
      runtimeTarget: 'wsl', available: false, active: config.mcp.mode === 'stdio' && config.mcp.runtimeTarget === 'wsl',
      distribution, note: error instanceof Error ? error.message.slice(0, 200) : 'WSL-Runtime nicht prüfbar.',
    });
  }
  return results;
}
