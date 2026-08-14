import { spawn } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

export const JOB_SEARCH_MCP_LAUNCH_CONTRACT_VERSION = '1.0';

/**
 * @typedef {{contractVersion:'1.0', executionIsolation:'trusted-host', runtimeTarget:'windows'|'wsl', distribution?:string, command:string, args:string[], env:Record<string,string>}} JobSearchMcpLaunch
 */

const DISTRIBUTION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const SANDBOX_WRAPPERS = new Set([
  'bwrap', 'bubblewrap', 'firejail', 'unshare', 'sandbox-exec',
  'docker', 'podman', 'nerdctl', 'lxc-execute', 'systemd-nspawn'
]);

function fail(code) { throw new Error(code); }
function executableName(value) {
  return win32.basename(String(value).replaceAll('/', '\\')).toLocaleLowerCase('en-US').replace(/\.exe$/, '');
}
/** @returns {string[]} */
function stringArray(value) {
  if (!Array.isArray(value) || value.length > 64
    || value.some((item) => typeof item !== 'string' || Buffer.byteLength(item) > 4_096)) {
    fail('job_search_mcp_launch_args_invalid');
  }
  return /** @type {string[]} */ ([...value]);
}
/** @returns {Record<string, string>} */
function stringEnvironment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('job_search_mcp_launch_env_invalid');
  const entries = Object.entries(value);
  if (entries.length > 64 || entries.some(([key, item]) => !ENV_NAME.test(key)
    || typeof item !== 'string' || Buffer.byteLength(item) > 4_096)) fail('job_search_mcp_launch_env_invalid');
  return /** @type {Record<string, string>} */ (Object.fromEntries(entries));
}

/**
 * Parse the versioned launch contract without touching the host. Runtime target,
 * distribution and argv must describe the same direct process boundary.
 * @param {unknown} value
 * @returns {JobSearchMcpLaunch}
 */
export function parseJobSearchMcpLaunch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('job_search_mcp_launch_invalid');
  const input = /** @type {Record<string, unknown>} */ (value);
  const allowedKeys = new Set(['contractVersion', 'executionIsolation', 'runtimeTarget', 'distribution', 'command', 'args', 'env']);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) fail('job_search_mcp_launch_unknown_property');
  if (input.contractVersion !== JOB_SEARCH_MCP_LAUNCH_CONTRACT_VERSION) fail('job_search_mcp_launch_version_unsupported');
  if (input.executionIsolation !== 'trusted-host') fail('job_search_mcp_requires_trusted_host');
  if (input.runtimeTarget !== 'windows' && input.runtimeTarget !== 'wsl') fail('job_search_mcp_runtime_target_invalid');
  if (typeof input.command !== 'string' || Buffer.byteLength(input.command) > 4_096 || !win32.isAbsolute(input.command)) {
    fail('job_search_mcp_command_must_be_absolute');
  }
  const args = stringArray(input.args);
  const env = stringEnvironment(input.env);
  const commandName = executableName(input.command);
  if (SANDBOX_WRAPPERS.has(commandName)
    || args.some((argument) => SANDBOX_WRAPPERS.has(executableName(argument)))) {
    fail('job_search_mcp_sandbox_wrapper_forbidden');
  }

  /** @type {string | undefined} */
  let distribution;
  if (input.runtimeTarget === 'windows') {
    if (input.distribution !== undefined || commandName !== 'job-search-mcp' || args.length !== 0) {
      fail('job_search_mcp_native_launch_invalid');
    }
  } else {
    if (typeof input.distribution !== 'string') fail('job_search_mcp_wsl_launch_invalid');
    distribution = input.distribution;
    if (!DISTRIBUTION.test(distribution)
      || commandName !== 'wsl' || args[0] !== '-d' || args[1] !== distribution || args[2] !== '--') {
      fail('job_search_mcp_wsl_launch_invalid');
    }
    const commandArgs = args.slice(3);
    const executableIndex = commandArgs[0] === 'env'
      ? commandArgs.findIndex((argument, index) => index > 0 && !/^[A-Z][A-Z0-9_]{0,63}=/.test(argument))
      : 0;
    const targetExecutable = commandArgs[executableIndex];
    if (executableIndex < 0 || executableIndex !== commandArgs.length - 1
      || !targetExecutable || !posix.isAbsolute(targetExecutable)
      || executableName(targetExecutable) !== 'job-search-mcp') fail('job_search_mcp_wsl_launch_invalid');
  }

  return /** @type {JobSearchMcpLaunch} */ ({
    contractVersion: JOB_SEARCH_MCP_LAUNCH_CONTRACT_VERSION,
    executionIsolation: /** @type {'trusted-host'} */ ('trusted-host'),
    runtimeTarget: /** @type {'windows'|'wsl'} */ (input.runtimeTarget),
    ...(distribution ? { distribution } : {}),
    command: input.command,
    args,
    env
  });
}

/** @param {string} candidate @param {string} root @param {boolean} insensitive */
function assertInside(candidate, root, insensitive) {
  const normalize = (value) => insensitive ? value.toLocaleLowerCase('en-US') : value;
  const child = normalize(candidate);
  const parent = normalize(root);
  const rel = win32.relative(parent, child);
  if (!rel || rel === '..' || rel.startsWith('..\\') || win32.isAbsolute(rel)) {
    if (child === parent) return;
    fail('job_search_mcp_executable_outside_allowed_venv');
  }
}

function defaultWslRun(command, distribution, args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, ['-d', distribution, '--', ...args], {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('job_search_mcp_wsl_probe_timeout')); }, 5_000);
    child.stdout.on('data', (chunk) => { if (stdout.length < 8_192) stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { if (stderr.length < 8_192) stderr += String(chunk); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`job_search_mcp_wsl_probe_failed:${stderr.trim().slice(0, 200)}`));
      else resolveResult(stdout.trim());
    });
  });
}

/**
 * Validate the executable identity and its integration-owned venv boundary.
 * The WSL probes are fixed argv calls (no shell) and never start the MCP.
 * @param {ReturnType<typeof parseJobSearchMcpLaunch>|unknown} value
 * @param {{projectRoot:string, realpath?:(path:string)=>Promise<string>, access?:(path:string)=>Promise<void>, allowedWslCommand?:string, runWsl?:(command:string, distribution:string, args:string[])=>Promise<string>}} options
 */
export async function validateJobSearchMcpRuntime(value, options) {
  const launch = parseJobSearchMcpLaunch(value);
  const canonical = options.realpath ?? realpath;
  const canAccess = options.access ?? access;
  if (launch.runtimeTarget === 'windows') {
    const integrationRoot = win32.resolve(options.projectRoot, 'integrations', 'job-search-mcp');
    const allowedRoot = win32.resolve(integrationRoot, '.venv', 'Scripts');
    const [commandReal, rootReal, integrationReal] = await Promise.all([
      canonical(launch.command), canonical(allowedRoot), canonical(integrationRoot)
    ]);
    const expectedRoot = win32.resolve(integrationReal, '.venv', 'Scripts');
    if (rootReal.toLocaleLowerCase('en-US') !== expectedRoot.toLocaleLowerCase('en-US')) {
      fail('job_search_mcp_native_venv_realpath_invalid');
    }
    if (executableName(commandReal) !== 'job-search-mcp') fail('job_search_mcp_native_realpath_invalid');
    assertInside(commandReal, rootReal, true);
    if (commandReal.toLocaleLowerCase('en-US') !== win32.resolve(rootReal, 'job-search-mcp.exe').toLocaleLowerCase('en-US')) {
      fail('job_search_mcp_native_realpath_invalid');
    }
    await canAccess(commandReal);
    return { ...launch, command: commandReal, targetExecutable: commandReal, ready: true };
  }

  const allowedWslCommand = options.allowedWslCommand
    ?? (process.env.SystemRoot ? win32.resolve(process.env.SystemRoot, 'System32', 'wsl.exe') : undefined);
  if (!allowedWslCommand) fail('job_search_mcp_wsl_system_command_unavailable');
  const [commandReal, allowedCommandReal] = await Promise.all([canonical(launch.command), canonical(allowedWslCommand)]);
  if (commandReal.toLocaleLowerCase('en-US') !== allowedCommandReal.toLocaleLowerCase('en-US')
    || executableName(commandReal) !== 'wsl') fail('job_search_mcp_wsl_realpath_invalid');
  await canAccess(commandReal);
  const runWsl = options.runWsl ?? defaultWslRun;
  const integrationRoot = win32.resolve(options.projectRoot, 'integrations', 'job-search-mcp');
  const mappedRoot = await runWsl(commandReal, launch.distribution, ['wslpath', '-a', '-u', integrationRoot]);
  if (!mappedRoot.startsWith('/') || mappedRoot.includes('\0') || mappedRoot.includes('\n')) fail('job_search_mcp_wsl_root_mapping_invalid');
  const lexicalVenv = posix.join(posix.normalize(mappedRoot), '.venv-wsl');
  const venvReal = await runWsl(commandReal, launch.distribution, ['readlink', '-f', '--', lexicalVenv]);
  if (venvReal !== lexicalVenv) fail('job_search_mcp_wsl_venv_realpath_invalid');
  const commandArgs = launch.args.slice(3);
  const executableIndex = commandArgs[0] === 'env'
    ? commandArgs.findIndex((argument, index) => index > 0 && !/^[A-Z][A-Z0-9_]{0,63}=/.test(argument))
    : 0;
  const targetExecutable = commandArgs[executableIndex];
  if (!targetExecutable) fail('job_search_mcp_wsl_launch_invalid');
  const targetReal = await runWsl(commandReal, launch.distribution, ['readlink', '-f', '--', targetExecutable]);
  if (targetReal !== posix.join(venvReal, 'bin', 'job-search-mcp')) fail('job_search_mcp_executable_outside_allowed_venv');
  await runWsl(commandReal, launch.distribution, ['test', '-x', targetReal]);
  return { ...launch, command: commandReal, targetExecutable: targetReal, ready: true };
}

/** @param {Record<string, unknown>} settings @param {string} projectRoot */
export function launchFromMcpSettings(settings, projectRoot) {
  const command = typeof settings.command === 'string' && win32.isAbsolute(settings.command)
    ? settings.command : win32.resolve(projectRoot, String(settings.command ?? ''));
  const args = Array.isArray(settings.args) ? settings.args : [];
  const commandName = executableName(command);
  const runtimeTarget = settings.runtimeTarget === 'windows' || settings.runtimeTarget === 'wsl'
    ? settings.runtimeTarget : commandName === 'wsl' ? 'wsl' : 'windows';
  const distribution = runtimeTarget === 'wsl'
    ? (settings.distribution ?? (args[0] === '-d' ? args[1] : undefined)) : undefined;
  return parseJobSearchMcpLaunch({
    contractVersion: JOB_SEARCH_MCP_LAUNCH_CONTRACT_VERSION,
    executionIsolation: settings.executionIsolation,
    runtimeTarget,
    ...(distribution ? { distribution } : {}),
    command,
    args,
    env: settings.env
  });
}
