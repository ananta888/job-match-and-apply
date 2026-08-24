import { spawn } from 'node:child_process';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, posix, resolve, win32 } from 'node:path';
import type { AgentProviderInstallation, RuntimeTarget } from '../ports/agent-runner.js';
import { buildMinimalLocalChildEnvironment } from '../services/process-environment.js';
import { CODEX_CONFORMED_VERSION_PATTERN } from './codex-offline-policy.js';

export interface ProviderDiscoveryDefinition {
  provider: string;
  executableNames: readonly string[];
  versionArgs: readonly string[];
  testedVersionPatterns: readonly RegExp[];
  authStatusArgs?: readonly string[];
}

export const BUILTIN_PROVIDER_DISCOVERY: readonly ProviderDiscoveryDefinition[] = [
  { provider: 'codex-exec', executableNames: ['codex'], versionArgs: ['--version'], testedVersionPatterns: [new RegExp(CODEX_CONFORMED_VERSION_PATTERN, 'i')], authStatusArgs: ['login', 'status'] },
  { provider: 'opencode', executableNames: ['opencode'], versionArgs: ['--version'], testedVersionPatterns: [/^1\.14\.41$/i] },
  { provider: 'claude-cli', executableNames: ['claude'], versionArgs: ['--version'], testedVersionPatterns: [/^2\.1\.23[2-4] \(Claude Code\)$/i] },
  { provider: 'acp', executableNames: ['codex-acp', 'claude-agent-acp', 'acp-synthetic'], versionArgs: ['--version'], testedVersionPatterns: [/^acp-synthetic 0\.1\.0$/i] },
];

export interface DiscoveryCommandResult { exitCode: number | null; stdout: string; stderr: string; }
export interface DiscoveryCommandExecutor {
  run(executable: string, args: readonly string[], timeoutMs?: number): Promise<DiscoveryCommandResult>;
}

/**
 * Version and auth probes run the actual provider CLI. Node-based CLIs (e.g. opencode, claude) can
 * take far longer to print `--version` than the fast enumeration calls (`--list`, `command -v`) —
 * observed up to ~30s for opencode through WSL. A short timeout silently killed those probes, so the
 * providers were reported without a version and downgraded to `untested`. Enumeration stays quick;
 * only the CLI-execution probes get the longer budget.
 */
const PROBE_TIMEOUT_MS = 45_000;

export class SpawnDiscoveryCommandExecutor implements DiscoveryCommandExecutor {
  async run(executable: string, args: readonly string[], timeoutMs = 5_000): Promise<DiscoveryCommandResult> {
    return new Promise((resolveResult) => {
      const child = spawn(executable, [...args], {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: buildMinimalLocalChildEnvironment()
      });
      let stdout = ''; let stderr = ''; let done = false;
      const finish = (exitCode: number | null): void => {
        if (done) return; done = true; clearTimeout(timer);
        resolveResult({ exitCode, stdout: stdout.slice(0, 64 * 1024), stderr: stderr.slice(0, 64 * 1024) });
      };
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.once('error', (error) => { stderr += error.message; finish(null); });
      child.once('close', (code) => finish(code));
      const timer = setTimeout(() => { child.kill(); finish(null); }, timeoutMs);
      timer.unref();
    });
  }
}

function platformTarget(platform = process.platform): RuntimeTarget {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'darwin';
  return 'linux';
}

function supportFor(version: string | undefined, definition: ProviderDiscoveryDefinition): Pick<AgentProviderInstallation, 'support' | 'reason'> {
  if (!version) return { support: 'untested', reason: 'Version konnte nicht bestimmt werden.' };
  if (definition.testedVersionPatterns.some((pattern) => pattern.test(version))) return { support: 'supported' };
  return { support: 'untested', reason: 'Installierte Version besitzt noch keine freigegebene Contract-Fixture.' };
}

export function isFullyQualifiedWindowsPath(value: string): boolean {
  if (!win32.isAbsolute(value)) return false;
  const root = win32.parse(value).root;
  if (/^[A-Za-z]:[\\/]$/.test(root)) return true;
  if (!root.startsWith('\\\\') || root.startsWith('\\\\?\\') || root.startsWith('\\\\.\\')) return false;
  return root.split(/[\\/]+/).filter(Boolean).length === 2;
}

export function isSafeWslDistribution(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

export function defaultWslHostExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const configuredRoot = env.SystemRoot ?? env.WINDIR;
  const root = configuredRoot && /^[A-Za-z]:[\\/]/.test(configuredRoot) ? configuredRoot : 'C:\\Windows';
  return win32.join(root, 'System32', 'wsl.exe');
}

function isSafeWslHostExecutable(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value)
    && isFullyQualifiedWindowsPath(value)
    && win32.basename(value).toLocaleLowerCase('en-US') === 'wsl.exe';
}

async function executableCandidates(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string[]> {
  const pathContract = platform === 'win32' ? win32 : posix;
  if (pathContract.isAbsolute(name)) return [pathContract.normalize(name)];
  const pathEntries = (env.PATH ?? env.Path ?? '').split(pathContract.delimiter).filter(Boolean);
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.COM;.CMD;.BAT').split(';').map((value) => value.toLowerCase())
    : [''];
  const names = platform === 'win32' && !extensions.some((extension) => name.toLowerCase().endsWith(extension))
    ? extensions.map((extension) => `${name}${extension}`)
    : [name];
  const found: string[] = [];
  for (const directory of pathEntries) {
    for (const candidateName of names) {
      const candidate = pathContract.resolve(directory.replace(/^"|"$/g, ''), candidateName);
      try { await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK); found.push(await realpath(candidate)); }
      catch { /* not installed at this path */ }
    }
  }
  return [...new Set(found)];
}

export class AgentRuntimeDiscovery {
  constructor(private readonly executor: DiscoveryCommandExecutor = new SpawnDiscoveryCommandExecutor()) {}

  async discoverLocal(
    definition: ProviderDiscoveryDefinition,
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform
  ): Promise<AgentProviderInstallation[]> {
    const paths = (await Promise.all(definition.executableNames.map((name) => executableCandidates(name, env, platform)))).flat();
    const installations: AgentProviderInstallation[] = [];
    for (const executable of [...new Set(paths)]) {
      if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
        installations.push({ provider: definition.provider, runtimeTarget: 'windows', executable, support: 'unsupported', reason: 'Shell-Wrapper ist für den sicheren Runner nicht zulässig.' });
        continue;
      }
      const result = await this.executor.run(executable, definition.versionArgs, PROBE_TIMEOUT_MS);
      const version = result.exitCode === 0 ? (result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0] : undefined;
      const support = supportFor(version, definition);
      const auth = definition.authStatusArgs ? await this.executor.run(executable, definition.authStatusArgs, PROBE_TIMEOUT_MS) : undefined;
      const authStatus = auth ? auth.exitCode === 0 ? 'authenticated' as const : 'unauthenticated' as const : 'unknown' as const;
      installations.push({
        provider: definition.provider, runtimeTarget: platformTarget(platform), executable, version,
        ...support, ...(authStatus === 'unauthenticated' ? { support: 'unavailable' as const, reason: 'CLI ist installiert, aber nicht authentifiziert.' } : {}),
        authStatus, authNote: auth ? (authStatus === 'authenticated' ? 'Authentifizierung bestätigt.' : 'Authentifizierung erforderlich.') : 'Kein sicherer Auth-Status-Probevertrag hinterlegt.'
      });
    }
    return installations;
  }

  async discoverWsl(definition: ProviderDiscoveryDefinition, wslExecutable = defaultWslHostExecutable()): Promise<AgentProviderInstallation[]> {
    if (!isSafeWslHostExecutable(wslExecutable)) throw new Error('WSL-Host-Executable ist ungueltig.');
    const listed = await this.executor.run(wslExecutable, ['--list', '--quiet']);
    if (listed.exitCode !== 0) return [];
    const distributions = listed.stdout.replace(/\0/g, '').split(/\r?\n/).map((line) => line.trim()).filter(isSafeWslDistribution);
    const installations: AgentProviderInstallation[] = [];
    for (const distribution of distributions) {
      for (const name of definition.executableNames) {
        // wsl.exe does not preserve bash -lc positional arguments consistently
        // across Windows releases. Interpolation is restricted to this strict
        // executable-name grammar; no browser/user value reaches the shell.
        if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(name)) continue;
        const which = await this.executor.run(wslExecutable, [
          '-d', distribution, '--', 'bash', '-lc', `command -v -- ${name}`
        ]);
        const runtimeExecutable = which.exitCode === 0 ? which.stdout.trim().split(/\r?\n/, 1)[0] : undefined;
        if (!runtimeExecutable?.startsWith('/')) continue;
        const versionResult = await this.executor.run(wslExecutable, ['-d', distribution, '--', runtimeExecutable, ...definition.versionArgs], PROBE_TIMEOUT_MS);
        const version = versionResult.exitCode === 0 ? (versionResult.stdout || versionResult.stderr).trim().split(/\r?\n/, 1)[0] : undefined;
        const auth = definition.authStatusArgs ? await this.executor.run(wslExecutable, ['-d', distribution, '--', runtimeExecutable, ...definition.authStatusArgs], PROBE_TIMEOUT_MS) : undefined;
        const authStatus = auth ? auth.exitCode === 0 ? 'authenticated' as const : 'unauthenticated' as const : 'unknown' as const;
        installations.push({
          provider: definition.provider, runtimeTarget: 'wsl', executable: wslExecutable,
          runtimeExecutable, distribution, version, ...supportFor(version, definition),
          ...(authStatus === 'unauthenticated' ? { support: 'unavailable' as const, reason: 'CLI ist in WSL installiert, aber nicht authentifiziert.' } : {}),
          authStatus, authNote: auth ? (authStatus === 'authenticated' ? 'Authentifizierung bestätigt.' : 'Authentifizierung erforderlich.') : 'Kein sicherer Auth-Status-Probevertrag hinterlegt.'
        });
      }
    }
    return installations;
  }

  async windowsPathToWsl(windowsPath: string, distribution: string, wslExecutable = defaultWslHostExecutable()): Promise<string> {
    if (!isFullyQualifiedWindowsPath(windowsPath)) throw new Error('Windows-Pfad muss absolut sein.');
    if (!isSafeWslDistribution(distribution)) throw new Error('WSL-Distribution ist ungueltig.');
    if (!isSafeWslHostExecutable(wslExecutable)) throw new Error('WSL-Host-Executable ist ungueltig.');
    // wsl.exe forwards argv through the Linux command-line parser. A native
    // Windows path therefore loses backslashes (for example `C:\Work` becomes
    // `C:Work`) even though Node spawned wsl.exe with `shell:false`. wslpath
    // accepts the equivalent drive-qualified forward-slash form as one fixed
    // argv value, including spaces, without introducing shell interpretation.
    const wslpathInput = windowsPath.replaceAll('\\', '/');
    const result = await this.executor.run(wslExecutable, ['-d', distribution, '--', 'wslpath', '-a', '-u', wslpathInput]);
    const mapped = result.stdout.trim();
    if (result.exitCode !== 0 || !mapped.startsWith('/')) throw new Error(`WSL-Pfadabbildung fehlgeschlagen: ${result.stderr.trim()}`);
    return mapped;
  }
}

export type PathFlavor = 'windows' | 'posix';

/** Pure containment predicate for already-resolved paths; useful for cross-platform policy tests. */
export function isPathWithinRoot(requested: string, allowedRoot: string, flavor: PathFlavor): boolean {
  const implementation = flavor === 'windows' ? win32 : posix;
  if (flavor === 'windows') {
    if (!isFullyQualifiedWindowsPath(requested) || !isFullyQualifiedWindowsPath(allowedRoot)) return false;
  } else if (!implementation.isAbsolute(requested) || !implementation.isAbsolute(allowedRoot)) return false;
  const difference = implementation.relative(implementation.normalize(allowedRoot), implementation.normalize(requested));
  return difference === '' || (difference !== '..' && !difference.startsWith(`..${implementation.sep}`) && !implementation.isAbsolute(difference));
}

export async function validateWorkspaceRoot(requested: string, allowedRoots: readonly string[]): Promise<string> {
  if (!isAbsolute(requested)) throw new Error('Workspace-Pfad muss absolut sein.');
  const resolvedRequested = await realpath(requested);
  if (!(await stat(resolvedRequested)).isDirectory()) throw new Error('Workspace-Pfad muss ein Verzeichnis sein.');
  for (const allowed of allowedRoots) {
    if (!isAbsolute(allowed)) continue;
    const resolvedAllowed = await realpath(allowed);
    if (!(await stat(resolvedAllowed)).isDirectory()) continue;
    if (isPathWithinRoot(resolvedRequested, resolvedAllowed, process.platform === 'win32' ? 'windows' : 'posix')) return resolvedRequested;
  }
  throw new Error('Workspace liegt außerhalb der freigegebenen Wurzeln.');
}
