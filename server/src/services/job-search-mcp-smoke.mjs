import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseJobSearchMcpLaunch, validateJobSearchMcpRuntime } from './job-search-mcp-launch.mjs';

const REQUIRED_TOOLS = [
  'capabilities', 'browser_status', 'mehrportal_suche', 'portal_login',
  'portal_sitzung_loeschen'
];
const HOST_ENVIRONMENT_KEYS = [
  'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA',
  'LOCALAPPDATA', 'LANG', 'LC_ALL', 'PATH', 'Path'
];
const DEFAULT_ENVIRONMENT_PROBE_TIMEOUT_MS = 15_000;
const MAX_ENVIRONMENT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_MCP_TIMEOUT_MS = 60_000;
const PROCESS_TERMINATION_GRACE_MS = 1_000;

function fail(code) { throw new Error(code); }

/**
 * Keep the smoke process on the same least-privilege environment boundary as
 * the production adapter. In particular, provider/API secrets never cross it.
 * @param {Record<string,string>} explicit
 * @param {NodeJS.ProcessEnv} host
 */
export function buildOfflineSmokeEnvironment(explicit, host = process.env) {
  if (explicit.ALLOW_EXTERNAL_PORTALS !== '0') fail('job_search_mcp_smoke_requires_portals_disabled');
  const environment = {};
  for (const key of HOST_ENVIRONMENT_KEYS) if (host[key] !== undefined) environment[key] = host[key];
  return { ...environment, ...explicit };
}

/** @param {unknown} result */
function toolPayload(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) {
    fail('job_search_mcp_smoke_capabilities_result_invalid');
  }
  const text = result.content
    .filter((item) => item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text).join('\n');
  try { return JSON.parse(text); }
  catch { fail('job_search_mcp_smoke_capabilities_json_invalid'); }
}

/**
 * Validate only protocol metadata. The smoke deliberately never invokes a
 * search, login, credential, browser or portal tool.
 * @param {unknown} listed
 * @param {unknown} capabilityResult
 */
export function assertOfflineMcpCapabilities(listed, capabilityResult) {
  if (!listed || typeof listed !== 'object' || !Array.isArray(listed.tools)) {
    fail('job_search_mcp_smoke_tool_list_invalid');
  }
  const toolNames = new Set(listed.tools.map((tool) => tool && typeof tool === 'object' ? tool.name : undefined));
  for (const tool of REQUIRED_TOOLS) if (!toolNames.has(tool)) fail(`job_search_mcp_smoke_tool_missing:${tool}`);

  const payload = toolPayload(capabilityResult);
  if (!payload || typeof payload !== 'object' || payload.contract !== 'job-search-mcp'
    || typeof payload.contract_version !== 'string' || !payload.contract_version.startsWith('1.')) {
    fail('job_search_mcp_smoke_contract_incompatible');
  }
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  const stepStone = sources.find((source) => source && typeof source === 'object' && source.id === 'stepstone');
  if (!stepStone || stepStone.enabled !== true || stepStone.supports_login !== true) {
    fail('job_search_mcp_smoke_stepstone_capability_missing');
  }
  return {
    contract: payload.contract,
    contractVersion: payload.contract_version,
    toolCount: toolNames.size,
    requiredTools: [...REQUIRED_TOOLS],
    stepStone: {
      enabled: true,
      supportsLogin: true,
      loginRequiredForSearch: Boolean(stepStone.login_required_for_search),
      policyStatus: String(stepStone.policy_status ?? 'unknown')
    }
  };
}

/**
 * Run the side-effect-free WSL environment probe with bounded cleanup. The
 * injectable process factory is intentionally narrow and exists so timeout
 * cleanup can be verified without starting WSL in unit tests.
 * @param {string} command
 * @param {string[]} args
 * @param {Record<string,string>} environment
 * @param {number} timeoutMs
 * @param {{spawnProcess?:(command:string,args:string[],options:object)=>any,terminationGraceMs?:number}} options
 */
export function collectOfflineProbeProcess(command, args, environment, timeoutMs, options = {}) {
  return new Promise((resolveResult, reject) => {
    const spawnProcess = options.spawnProcess ?? spawn;
    const terminationGraceMs = options.terminationGraceMs ?? PROCESS_TERMINATION_GRACE_MS;
    const child = spawnProcess(command, args, {
      env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let terminationTimer;
    let forcedTerminationTimer;
    const timeoutError = new Error('job_search_mcp_smoke_environment_probe_timeout');
    const clearTimers = () => {
      clearTimeout(timer);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (forcedTerminationTimer) clearTimeout(forcedTerminationTimer);
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimers();
      callback();
    };
    const detachAfterForcedTermination = () => {
      try { child.stdout?.destroy(); } catch { /* best effort */ }
      try { child.stderr?.destroy(); } catch { /* best effort */ }
      try { child.stdin?.destroy(); } catch { /* best effort */ }
      try { child.unref(); } catch { /* best effort */ }
      settle(() => reject(timeoutError));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* continue to bounded cleanup */ }
      terminationTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* continue to detach */ }
        forcedTerminationTimer = setTimeout(detachAfterForcedTermination, terminationGraceMs);
      }, terminationGraceMs);
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { if (stdout.length < 64 * 1024) stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { if (stderr.length < 8 * 1024) stderr += String(chunk); });
    child.once('error', (error) => settle(() => reject(timedOut ? timeoutError : error)));
    child.once('close', (code) => {
      if (timedOut) settle(() => reject(timeoutError));
      else if (code !== 0) {
        settle(() => reject(new Error(`job_search_mcp_smoke_environment_probe_failed:${stderr.trim().slice(0, 200)}`)));
      } else settle(() => resolveResult(stdout));
    });
  });
}

async function assertWslEnvironmentBridge(runtime, environment, timeoutMs) {
  if (runtime.runtimeTarget !== 'wsl') return { checked: false, reason: 'native-runtime' };
  const output = await collectOfflineProbeProcess(
    runtime.command, ['-d', runtime.distribution, '--', 'env'], environment, timeoutMs
  );
  const values = new Map(String(output).split(/\r?\n/).map((line) => {
    const separator = line.indexOf('=');
    return separator > 0 ? [line.slice(0, separator), line.slice(separator + 1)] : ['', ''];
  }));
  if (values.get('ALLOW_EXTERNAL_PORTALS') !== '0'
    || values.get('JOB_MCP_STATE_DIR') !== runtime.env.JOB_MCP_STATE_DIR) {
    fail('job_search_mcp_smoke_wsl_environment_bridge_failed');
  }
  return { checked: true, variables: ['ALLOW_EXTERNAL_PORTALS', 'JOB_MCP_STATE_DIR'] };
}

/**
 * Positive, side-effect-free stdio MCP smoke. It validates the canonical
 * executable first and refuses to run unless portal networking is disabled.
 * @param {{projectRoot?:string,launchPath?:string,timeoutMs?:number,environmentProbeTimeoutMs?:number}} options
 */
export async function runOfflineJobSearchMcpSmoke(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? resolve(import.meta.dirname, '..', '..', '..'));
  const launchPath = resolve(options.launchPath ?? resolve(projectRoot, '.local-data', 'job-search-mcp-launch.json'));
  // A cold WSL/Python import can legitimately take more than 20 seconds on a
  // Windows host. Only the MCP handshake gets the larger budget; the simple
  // environment bridge remains independently and strictly bounded.
  const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const environmentProbeTimeoutMs = Math.min(
    options.environmentProbeTimeoutMs ?? DEFAULT_ENVIRONMENT_PROBE_TIMEOUT_MS,
    MAX_ENVIRONMENT_PROBE_TIMEOUT_MS
  );
  const launch = parseJobSearchMcpLaunch(JSON.parse(await readFile(launchPath, 'utf8')));
  const runtime = await validateJobSearchMcpRuntime(launch, { projectRoot });
  const environment = buildOfflineSmokeEnvironment(runtime.env);
  const environmentBridge = await assertWslEnvironmentBridge(runtime, environment, environmentProbeTimeoutMs);
  const transport = new StdioClientTransport({
    command: runtime.command, args: runtime.args, env: environment, cwd: projectRoot, stderr: 'pipe'
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { if (stderr.length < 8_192) stderr += String(chunk); });
  const client = new Client({ name: 'job-match-and-apply-offline-smoke', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: timeoutMs, maxTotalTimeout: timeoutMs });
    const listed = await client.listTools(undefined, { timeout: timeoutMs, maxTotalTimeout: timeoutMs });
    const result = await client.callTool(
      { name: 'capabilities', arguments: {} }, undefined,
      { timeout: timeoutMs, maxTotalTimeout: timeoutMs }
    );
    const capabilities = assertOfflineMcpCapabilities(listed, result);
    return {
      status: 'ok', contract: 'job-search-mcp-offline-smoke', contractVersion: '1.0',
      portalNetwork: 'disabled', invokedTools: ['tools/list', 'capabilities'],
      launch: {
        executionIsolation: 'trusted-host', runtimeTarget: runtime.runtimeTarget,
        ...(runtime.distribution ? { distribution: runtime.distribution } : {}),
        hostCommandRealpath: runtime.command, targetExecutableRealpath: runtime.targetExecutable,
        directExecutable: true, sandboxWrapper: false
      },
      environmentBridge, capabilities
    };
  } catch (error) {
    const detail = stderr.trim().slice(0, 300);
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `; mcp_stderr=${detail}` : ''}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  runOfflineJobSearchMcpSmoke({ launchPath: argument('--launch-contract') })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(JSON.stringify({ status: 'failed', error: error instanceof Error ? error.message : String(error) }, null, 2));
      process.exitCode = 1;
    });
}
