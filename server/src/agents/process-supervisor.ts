import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { buildMinimalLocalChildEnvironment } from '../services/process-environment.js';

export interface ProcessLimits {
  wallTimeMs: number;
  idleTimeMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  totalOutputBytes: number;
  maxInputBytes: number;
  cancelGraceMs: number;
  heartbeatMs: number;
  resourceProbeIntervalMs?: number;
  maxResidentMemoryBytes?: number;
  maxChildProcesses?: number;
}

export const DEFAULT_PROCESS_LIMITS: ProcessLimits = {
  wallTimeMs: 30 * 60_000,
  idleTimeMs: 5 * 60_000,
  stdoutBytes: 8 * 1024 * 1024,
  stderrBytes: 2 * 1024 * 1024,
  totalOutputBytes: 10 * 1024 * 1024,
  maxInputBytes: 256 * 1024,
  cancelGraceMs: 2_000,
  heartbeatMs: 30_000,
  resourceProbeIntervalMs: 1_000,
};

export interface ProcessResourceUsage {
  /** Resident bytes attributed to the supervised process tree. */
  residentMemoryBytes: number;
  /** Descendants below the supervised root process; the root itself is not counted. */
  childProcessCount: number;
}

export interface ResourceProbe {
  sample(rootPid: number): Promise<ProcessResourceUsage>;
}

export interface ProcessTableEntry {
  pid: number;
  parentPid: number;
  residentMemoryBytes: number;
}

export interface ProcessTableCommandResult { exitCode: number | null; stdout: string; stderr: string; }
export interface ProcessTableCommandExecutor {
  run(executable: string, args: readonly string[], timeoutMs: number): Promise<ProcessTableCommandResult>;
}

class ProcessTreeRootNotVisibleError extends Error {
  constructor() {
    super('Supervidierter Root-Prozess fehlt in der Prozesstabelle.');
    this.name = 'ProcessTreeRootNotVisibleError';
  }
}

/** Fixed-command executor used only for OS process accounting; no run/client value reaches argv. */
export class SpawnProcessTableCommandExecutor implements ProcessTableCommandExecutor {
  async run(executable: string, args: readonly string[], timeoutMs: number): Promise<ProcessTableCommandResult> {
    return new Promise((resolveResult) => {
      execFile(executable, [...args], {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: buildMinimalLocalChildEnvironment(),
      }, (error, stdout, stderr) => {
        const errorCode = (error as { code?: unknown } | null)?.code;
        const exitCode = error
          ? typeof errorCode === 'number' ? errorCode : null
          : 0;
        resolveResult({ exitCode, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }
}

function safeProcessInteger(value: unknown, field: string): number {
  const numeric = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(numeric) || Number(numeric) < 0) throw new Error(`Ungueltiger Prozesswert ${field}.`);
  return Number(numeric);
}

/** Computes aggregate RSS for the root and all descendants from one process-table snapshot. */
export function summarizeProcessTree(rootPid: number, entries: readonly ProcessTableEntry[]): ProcessResourceUsage {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error('Root-PID ist ungueltig.');
  const byPid = new Map<number, ProcessTableEntry>();
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    const normalized = {
      pid: safeProcessInteger(entry.pid, 'pid'),
      parentPid: safeProcessInteger(entry.parentPid, 'parentPid'),
      residentMemoryBytes: safeProcessInteger(entry.residentMemoryBytes, 'residentMemoryBytes'),
    };
    if (normalized.pid < 1 || byPid.has(normalized.pid)) throw new Error('Prozesstabelle enthaelt eine ungueltige oder doppelte PID.');
    byPid.set(normalized.pid, normalized);
    const siblings = children.get(normalized.parentPid) ?? [];
    siblings.push(normalized.pid);
    children.set(normalized.parentPid, siblings);
  }
  if (!byPid.has(rootPid)) throw new ProcessTreeRootNotVisibleError();

  const pending = [rootPid];
  const visited = new Set<number>();
  let residentMemoryBytes = 0;
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const entry = byPid.get(pid);
    if (!entry) continue;
    residentMemoryBytes += entry.residentMemoryBytes;
    if (!Number.isSafeInteger(residentMemoryBytes)) throw new Error('Aggregierter Speicherwert ist ungueltig.');
    pending.push(...(children.get(pid) ?? []));
  }
  return { residentMemoryBytes, childProcessCount: Math.max(0, visited.size - 1) };
}

const WINDOWS_PROCESS_TABLE_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$automationAssembly = [System.Management.Automation.PSObject].Assembly
$platformType = $automationAssembly.GetType(
  "System.Management.Automation.PlatformInvokes",
  $true
)
$entryType = $automationAssembly.GetType(
  "System.Management.Automation.PlatformInvokes+PROCESSENTRY32",
  $true
)
$snapshotFlagsType = $automationAssembly.GetType(
  "System.Management.Automation.PlatformInvokes+SnapshotFlags",
  $true
)
$bindingFlags = [System.Reflection.BindingFlags]"Static,Public,NonPublic"
$createSnapshot = $platformType.GetMethod("CreateToolhelp32Snapshot", $bindingFlags)
$processFirst = $platformType.GetMethod("Process32First", $bindingFlags)
$processNext = $platformType.GetMethod("Process32Next", $bindingFlags)
$snapshot = $createSnapshot.Invoke(
  $null,
  @([System.Enum]::ToObject($snapshotFlagsType, 2), [uint32]0)
)
try {
  if ($snapshot.IsInvalid) {
    throw "CreateToolhelp32Snapshot failed."
  }

  $memoryByPid = @{}
  foreach ($process in [System.Diagnostics.Process]::GetProcesses()) {
    try {
      $memoryByPid[[long]$process.Id] = [long]$process.WorkingSet64
    } catch {
      # A process may leave between enumeration and sampling. Its snapshot row
      # remains useful for parentage and is conservatively recorded with 0 RSS.
    } finally {
      $process.Dispose()
    }
  }

  $pidField = $entryType.GetField("th32ProcessID")
  $parentPidField = $entryType.GetField("th32ParentProcessID")
  $sizeField = $entryType.GetField("dwSize")
  $entry = [System.Activator]::CreateInstance($entryType)
  $sizeField.SetValue(
    $entry,
    [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($entry)
  )
  $arguments = [object[]]@($snapshot, $entry)
  $hasEntry = [bool]$processFirst.Invoke($null, $arguments)
  $rows = [System.Collections.Generic.List[object]]::new()
  while ($hasEntry) {
    $entry = $arguments[1]
    $processId = [long]$pidField.GetValue($entry)
    if ($processId -gt 0) {
      $workingSetSize = if ($memoryByPid.ContainsKey($processId)) {
        [long]$memoryByPid[$processId]
      } else {
        [long]0
      }
      $rows.Add([PSCustomObject]@{
        ProcessId = $processId
        ParentProcessId = [long]$parentPidField.GetValue($entry)
        WorkingSetSize = $workingSetSize
      })
    }
    $arguments[1] = $entry
    $hasEntry = [bool]$processNext.Invoke($null, $arguments)
  }
  ConvertTo-Json -InputObject $rows -Compress
} finally {
  $snapshot.Dispose()
}
`;

const WINDOWS_PROCESS_TABLE_COMMAND = [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from(WINDOWS_PROCESS_TABLE_SCRIPT, 'utf16le').toString('base64'),
] as const;
const WINDOWS_RESOURCE_PROBE_TIMEOUT_MS = 5_000;
const POSIX_RESOURCE_PROBE_TIMEOUT_MS = 5_000;

function windowsSystemExecutable(name: 'powershell.exe' | 'taskkill.exe'): string {
  const configuredRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const root = configuredRoot && win32.isAbsolute(configuredRoot) ? configuredRoot : 'C:\\Windows';
  return name === 'powershell.exe'
    ? win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', name)
    : win32.join(root, 'System32', name);
}

function parseWindowsProcessTable(stdout: string): ProcessTableEntry[] {
  const parsed = JSON.parse(stdout) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => {
    if (!row || typeof row !== 'object') throw new Error('Windows-Prozesstabelle besitzt ein ungueltiges Format.');
    const record = row as Record<string, unknown>;
    return {
      pid: safeProcessInteger(record.ProcessId, 'ProcessId'),
      parentPid: safeProcessInteger(record.ParentProcessId, 'ParentProcessId'),
      residentMemoryBytes: safeProcessInteger(record.WorkingSetSize, 'WorkingSetSize'),
    };
  }).filter((entry) => entry.pid > 0);
}

function processTreeIds(rootPid: number, entries: readonly ProcessTableEntry[]): number[] {
  // Reuse the strict table validation before any PID is considered a kill
  // target. The returned order is root-first and deterministic.
  summarizeProcessTree(rootPid, entries);
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    const siblings = children.get(entry.parentPid) ?? [];
    siblings.push(entry.pid);
    children.set(entry.parentPid, siblings);
  }
  for (const siblings of children.values()) siblings.sort((left, right) => left - right);
  const result: number[] = [];
  const pending = [rootPid];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const pid = pending.shift()!;
    if (visited.has(pid)) continue;
    visited.add(pid); result.push(pid); pending.unshift(...(children.get(pid) ?? []));
  }
  return result;
}

async function snapshotWindowsProcessTree(
  rootPid: number,
  executor: ProcessTableCommandExecutor,
): Promise<number[]> {
  // Cleanup has to fit inside ordinary request/test deadlines. If the Windows
  // process table is cold or unavailable, the caller immediately falls back
  // to forceful taskkill /T while the root PID still owns its descendants.
  const result = await executor.run(windowsSystemExecutable('powershell.exe'), WINDOWS_PROCESS_TABLE_COMMAND, 2_000);
  if (result.exitCode !== 0) throw new Error(`Windows-Prozessbaum konnte nicht gelesen werden: ${result.stderr.trim().slice(0, 512)}`);
  return processTreeIds(rootPid, parseWindowsProcessTable(result.stdout));
}

function parsePosixProcessTable(stdout: string): ProcessTableEntry[] {
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = /^(\d+)\s+(\d+)\s+(\d+)$/.exec(line);
    if (!match) throw new Error('POSIX-Prozesstabelle besitzt ein ungueltiges Format.');
    const rssKiB = safeProcessInteger(match[3], 'rssKiB');
    const residentMemoryBytes = rssKiB * 1024;
    if (!Number.isSafeInteger(residentMemoryBytes)) throw new Error('POSIX-Speicherwert ist ungueltig.');
    return {
      pid: safeProcessInteger(match[1], 'pid'),
      parentPid: safeProcessInteger(match[2], 'ppid'),
      residentMemoryBytes,
    };
  }).filter((entry) => entry.pid > 0);
}

/** Host process-tree probe for Windows and POSIX/WSL. Unsupported hosts fail closed on first sample. */
export class HostProcessTreeResourceProbe implements ResourceProbe {
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly executor: ProcessTableCommandExecutor = new SpawnProcessTableCommandExecutor(),
  ) {}

  async sample(rootPid: number): Promise<ProcessResourceUsage> {
    const command = this.platform === 'win32'
      ? { executable: windowsSystemExecutable('powershell.exe'), args: WINDOWS_PROCESS_TABLE_COMMAND }
      : this.platform === 'linux'
        ? { executable: '/usr/bin/ps', args: ['-axo', 'pid=,ppid=,rss='] as const }
        : this.platform === 'darwin'
          ? { executable: '/bin/ps', args: ['-axo', 'pid=,ppid=,rss='] as const }
        : undefined;
    if (!command) throw new Error(`ResourceProbe wird auf ${this.platform} nicht unterstuetzt.`);
    const timeoutMs = this.platform === 'win32'
      ? WINDOWS_RESOURCE_PROBE_TIMEOUT_MS
      : POSIX_RESOURCE_PROBE_TIMEOUT_MS;
    const result = await this.executor.run(command.executable, command.args, timeoutMs);
    if (result.exitCode !== 0) throw new Error(`Prozesstabelle konnte nicht gelesen werden: ${result.stderr.trim().slice(0, 512)}`);
    const entries = this.platform === 'win32' ? parseWindowsProcessTable(result.stdout) : parsePosixProcessTable(result.stdout);
    return summarizeProcessTree(rootPid, entries);
  }
}

export function classifyProcessResourceUsage(
  usage: ProcessResourceUsage,
  limits: Pick<ProcessLimits, 'maxResidentMemoryBytes' | 'maxChildProcesses'>,
): 'memory_limit' | 'child_process_limit' | undefined {
  if (limits.maxResidentMemoryBytes !== undefined && usage.residentMemoryBytes > limits.maxResidentMemoryBytes) return 'memory_limit';
  if (limits.maxChildProcesses !== undefined && usage.childProcessCount > limits.maxChildProcesses) return 'child_process_limit';
  return undefined;
}

export interface RawProcessLogOptions {
  /** Existing, explicitly configured local directory which owns all run-log directories. */
  rootDirectory: string;
  /** Safe identifier used as a single directory segment below rootDirectory. */
  runId: string;
  maxBytesPerFile: number;
  /** Maximum retained files per stream (stdout and stderr are isolated). */
  maxFiles: number;
}

export interface ProcessLaunchSpec {
  executable: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  limits?: Partial<ProcessLimits>;
  /** Disabled unless explicitly configured for this launch. */
  rawLog?: RawProcessLogOptions;
}

export type ProcessTermination =
  | 'exit'
  | 'crash'
  | 'signal'
  | 'cancelled'
  | 'timeout'
  | 'idle_timeout'
  | 'output_limit'
  | 'memory_limit'
  | 'child_process_limit'
  | 'resource_probe_error'
  | 'raw_log_error'
  | 'spawn_error';

/** Natural exits are canonicalized independently from supervisor-requested termination. */
export function classifyNaturalProcessTermination(exitCode: number | null, signal: NodeJS.Signals | null): 'exit' | 'crash' | 'signal' {
  if (signal) return 'signal';
  return exitCode === 0 ? 'exit' : 'crash';
}

export interface ProcessResult {
  termination: ProcessTermination;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  startedAt: string;
  finishedAt: string;
  error?: string;
  lastResourceUsage?: ProcessResourceUsage;
}

export interface ProcessCallbacks {
  onStart?(pid: number): void;
  onStdout?(chunk: string): void;
  onStderr?(chunk: string): void;
  onHeartbeat?(): void;
}

export interface SupervisedProcess {
  readonly pid?: number;
  readonly completion: Promise<ProcessResult>;
  writeInput(input: string, close?: boolean): Promise<void>;
  cancel(reason?: string): Promise<void>;
}

function ensureLaunchSpec(spec: ProcessLaunchSpec): void {
  if (!spec.executable || /[\r\n\0]/.test(spec.executable)) throw new Error('Ungültiges Executable.');
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(spec.executable)) {
    throw new Error('CMD-/BAT-Wrapper werden ohne Shell nicht ausgeführt; verwende eine native EXE oder WSL.');
  }
  if (!isAbsolute(spec.cwd)) throw new Error('Das Arbeitsverzeichnis muss absolut sein.');
  for (const argument of spec.args) if (argument.includes('\0')) throw new Error('Argument enthält ein NUL-Zeichen.');
}

const RAW_LOG_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function containedBy(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function assertSafeNode(path: string, kind: 'directory' | 'file'): void {
  const status = lstatSync(path);
  if (status.isSymbolicLink()) throw new Error(`Rohlog-${kind} darf kein Symlink sein.`);
  if (kind === 'directory' ? !status.isDirectory() : !status.isFile()) throw new Error(`Rohlog-${kind} besitzt einen ungueltigen Dateityp.`);
}

class RotatingRawProcessLog {
  readonly directory: string;
  private readonly root: string;
  private readonly sizes = new Map<'stdout' | 'stderr', number>();

  constructor(private readonly options: RawProcessLogOptions) {
    if (!isAbsolute(options.rootDirectory) || /[\r\n\0]/.test(options.rootDirectory) || /^\\\\|^\/\//.test(options.rootDirectory)) {
      throw new Error('Rohlog-Wurzel muss ein expliziter lokaler absoluter Pfad sein.');
    }
    if (!RAW_LOG_RUN_ID.test(options.runId)) throw new Error('Rohlog-Run-ID ist ungueltig.');
    if (!Number.isSafeInteger(options.maxBytesPerFile) || options.maxBytesPerFile < 1) throw new Error('Rohlog-Dateigroesse muss mindestens 1 Byte sein.');
    if (!Number.isSafeInteger(options.maxFiles) || options.maxFiles < 1 || options.maxFiles > 100) throw new Error('Rohlog-Dateilimit muss zwischen 1 und 100 liegen.');

    const configuredRoot = resolve(options.rootDirectory);
    assertSafeNode(configuredRoot, 'directory');
    this.root = realpathSync.native(configuredRoot);
    const requestedDirectory = resolve(this.root, options.runId);
    if (!containedBy(this.root, requestedDirectory) || requestedDirectory === this.root) throw new Error('Rohlog-Verzeichnis verlaesst die validierte Wurzel.');
    if (!existsSync(requestedDirectory)) mkdirSync(requestedDirectory, { recursive: false, mode: 0o700 });
    assertSafeNode(requestedDirectory, 'directory');
    this.directory = realpathSync.native(requestedDirectory);
    if (!containedBy(this.root, this.directory) || this.directory === this.root) throw new Error('Rohlog-Verzeichnis verlaesst ueber einen Symlink die validierte Wurzel.');

    for (const entry of readdirSync(this.directory)) {
      const match = /^(stdout|stderr)(?:\.(\d+))?\.log$/.exec(entry);
      if (!match) continue;
      const index = match[2] === undefined ? 0 : Number(match[2]);
      const path = join(this.directory, entry);
      assertSafeNode(path, 'file');
      if (index >= options.maxFiles) throw new Error('Vorhandene Rohlogs ueberschreiten das konfigurierte Dateilimit.');
      if (lstatSync(path).size > options.maxBytesPerFile) throw new Error('Vorhandenes Rohlog ueberschreitet das konfigurierte Groessenlimit.');
    }

    for (const stream of ['stdout', 'stderr'] as const) {
      for (let index = 0; index < options.maxFiles; index += 1) {
        const path = this.path(stream, index);
        if (existsSync(path)) {
          assertSafeNode(path, 'file');
          if (!containedBy(this.directory, realpathSync.native(path))) throw new Error('Rohlog-Datei verlaesst die validierte Run-Wurzel.');
        }
      }
      const current = this.path(stream, 0);
      this.sizes.set(stream, existsSync(current) ? lstatSync(current).size : 0);
    }
  }

  write(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    this.assertDirectorySafe();
    let offset = 0;
    while (offset < chunk.length) {
      let size = this.sizes.get(stream) ?? 0;
      if (size >= this.options.maxBytesPerFile) { this.rotate(stream); size = 0; }
      const length = Math.min(chunk.length - offset, this.options.maxBytesPerFile - size);
      const path = this.path(stream, 0);
      if (existsSync(path)) assertSafeNode(path, 'file');
      const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
      const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollow, 0o600);
      try {
        let written = 0;
        while (written < length) written += writeSync(descriptor, chunk, offset + written, length - written);
      } finally { closeSync(descriptor); }
      offset += length;
      this.sizes.set(stream, size + length);
    }
  }

  private rotate(stream: 'stdout' | 'stderr'): void {
    this.assertDirectorySafe();
    const last = this.path(stream, this.options.maxFiles - 1);
    if (existsSync(last)) { assertSafeNode(last, 'file'); unlinkSync(last); }
    for (let index = this.options.maxFiles - 1; index >= 1; index -= 1) {
      const source = this.path(stream, index - 1);
      if (!existsSync(source)) continue;
      assertSafeNode(source, 'file');
      const target = this.path(stream, index);
      if (existsSync(target)) { assertSafeNode(target, 'file'); unlinkSync(target); }
      renameSync(source, target);
    }
    this.sizes.set(stream, 0);
  }

  private path(stream: 'stdout' | 'stderr', index: number): string {
    return join(this.directory, index === 0 ? `${stream}.log` : `${stream}.${index}.log`);
  }

  private assertDirectorySafe(): void {
    assertSafeNode(this.directory, 'directory');
    const actual = realpathSync.native(this.directory);
    if (!containedBy(this.root, actual) || actual !== this.directory) throw new Error('Rohlog-Run-Verzeichnis wurde unsicher ersetzt.');
  }
}

export class ProcessSupervisor {
  constructor(
    private readonly resourceProbe: ResourceProbe | null = new HostProcessTreeResourceProbe(),
    private readonly processTableExecutor: ProcessTableCommandExecutor = new SpawnProcessTableCommandExecutor(),
  ) {}

  start(spec: ProcessLaunchSpec, callbacks: ProcessCallbacks = {}): SupervisedProcess {
    ensureLaunchSpec(spec);
    const limits = { ...DEFAULT_PROCESS_LIMITS, ...spec.limits };
    for (const [key, value] of Object.entries(limits)) {
      const valid = key === 'maxChildProcesses'
        ? Number.isSafeInteger(value) && value >= 0
        : Number.isSafeInteger(value) && value > 0;
      if (!valid) throw new Error(`Ungültiges Prozesslimit ${key}.`);
    }
    const resourceLimitsEnabled = limits.maxResidentMemoryBytes !== undefined || limits.maxChildProcesses !== undefined;
    if (resourceLimitsEnabled && !this.resourceProbe) throw new Error('Ressourcenlimits erfordern einen expliziten ResourceProbe.');
    const rawLog = spec.rawLog ? new RotatingRawProcessLog(spec.rawLog) : undefined;

    let child: ChildProcessWithoutNullStreams;
    const startedAt = new Date();
    try {
      child = spawn(spec.executable, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env ?? process.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      const result: ProcessResult = {
        termination: 'spawn_error', exitCode: null, signal: null, stdout: '', stderr: '',
        stdoutTruncated: false, stderrTruncated: false, startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(), error: (error as Error).message
      };
      return { completion: Promise.resolve(result), async writeInput() { throw error; }, async cancel() {} };
    }

    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let acceptedOutputBytes = 0;
    let inputBytes = 0;
    let requestedTermination: ProcessTermination | undefined;
    let terminationError: string | undefined;
    let terminationCleanup: Promise<void> | undefined;
    let lastResourceUsage: ProcessResourceUsage | undefined;
    let resourceProbeRunning = false;
    let resourceRootVisibilityMisses = 0;
    let settled = false;
    let resolveCompletion!: (result: ProcessResult) => void;
    const completion = new Promise<ProcessResult>((resolve) => { resolveCompletion = resolve; });
    let idleTimer: NodeJS.Timeout;

    const killWindowsTree = async (pid: number, force: boolean): Promise<void> => {
      await new Promise<void>((resolveKill) => {
          const killer = spawn(windowsSystemExecutable('taskkill.exe'), ['/pid', String(pid), '/t', ...(force ? ['/f'] : [])], {
            shell: false, windowsHide: true, stdio: 'ignore'
          });
          killer.once('error', () => resolveKill());
          killer.once('close', () => resolveKill());
      });
    };

    const isProcessAlive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        // EPERM still proves that the PID exists. Keep it as a kill target and
        // let taskkill report whether the supervisor may terminate it.
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
        throw error;
      }
    };

    const killTree = async (force: boolean): Promise<void> => {
      if (!child.pid || (!force && (child.exitCode !== null || child.killed))) return;
      if (process.platform === 'win32') {
        if (force) await killWindowsTree(child.pid, true);
        else child.kill('SIGTERM');
      } else {
        try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    };

    const requestTermination = async (kind: ProcessTermination, error?: string): Promise<void> => {
      if (requestedTermination) { await terminationCleanup; return; }
      if (settled) return;
      requestedTermination = kind;
      terminationError = error;
      terminationCleanup = (async () => {
        let windowsTree: number[] | undefined;
        if (process.platform === 'win32' && child.pid) {
          try { windowsTree = await snapshotWindowsProcessTree(child.pid, this.processTableExecutor); }
          catch {
            // Without a trustworthy snapshot there is no safe way to find a
            // re-parented descendant after the root exits. Fail closed by
            // forcing taskkill /T while the root PID is still owned.
            await killTree(true);
            return;
          }
        }
        await killTree(false);
        // POSIX process groups receive SIGTERM and get the configured grace
        // period. Windows has no equivalent graceful signal for console
        // process trees: Node's SIGTERM emulation terminates only the root, so
        // waiting would merely leave snapshotted descendants alive longer.
        if (process.platform !== 'win32') {
          await new Promise<void>((resolveGrace) => { setTimeout(resolveGrace, limits.cancelGraceMs); });
        }
        if (windowsTree) {
          // Once the Windows root exits, taskkill /T on that root can no
          // longer discover re-parented descendants. Force every *surviving*
          // validated snapshot PID,
          // deepest first. Avoiding taskkill processes for PIDs which are
          // already gone keeps cleanup bounded on cold Windows CI hosts.
          for (const pid of [...windowsTree].reverse()) {
            if (isProcessAlive(pid)) await killWindowsTree(pid, true);
          }
        } else await killTree(true);
      })();
      await terminationCleanup;
    };

    const resetIdle = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { void requestTermination('idle_timeout', 'Idle-Zeitlimit überschritten.'); }, limits.idleTimeMs);
      idleTimer.unref();
    };

    const probeResources = async (): Promise<void> => {
      if (!resourceLimitsEnabled || !this.resourceProbe || !child.pid || resourceProbeRunning || settled || requestedTermination) return;
      resourceProbeRunning = true;
      try {
        const usage = await this.resourceProbe.sample(child.pid);
        if (!Number.isSafeInteger(usage.residentMemoryBytes) || usage.residentMemoryBytes < 0
          || !Number.isSafeInteger(usage.childProcessCount) || usage.childProcessCount < 0) {
          throw new Error('ResourceProbe lieferte ungueltige Messwerte.');
        }
        resourceRootVisibilityMisses = 0;
        lastResourceUsage = { ...usage };
        const violation = classifyProcessResourceUsage(usage, limits);
        if (violation === 'memory_limit') {
          await requestTermination('memory_limit', `Speicherlimit ueberschritten: ${usage.residentMemoryBytes} > ${limits.maxResidentMemoryBytes}.`);
        } else if (violation === 'child_process_limit') {
          await requestTermination('child_process_limit', `Kindprozesslimit ueberschritten: ${usage.childProcessCount} > ${limits.maxChildProcesses}.`);
        }
      } catch (error) {
        // Host process tables can lag the Node `spawn` event briefly. Tolerate
        // one specifically classified visibility miss, then fail closed on
        // the next sample. All other probe failures terminate immediately.
        if (error instanceof ProcessTreeRootNotVisibleError
          && resourceRootVisibilityMisses === 0
          && child.exitCode === null
          && !child.killed) {
          resourceRootVisibilityMisses += 1;
          return;
        }
        await requestTermination('resource_probe_error', `ResourceProbe fehlgeschlagen: ${(error as Error).message}`);
      } finally { resourceProbeRunning = false; }
    };

    const consume = (stream: 'stdout' | 'stderr', value: Buffer | string): void => {
      if (requestedTermination === 'output_limit') return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (rawLog) {
        try { rawLog.write(stream, chunk); }
        catch (error) {
          void requestTermination('raw_log_error', `Rohlog-Schreiben fehlgeschlagen: ${(error as Error).message}`);
          return;
        }
      }
      resetIdle();
      const current = stream === 'stdout' ? stdout : stderr;
      const streamLimit = stream === 'stdout' ? limits.stdoutBytes : limits.stderrBytes;
      const acceptedBytes = Math.min(
        chunk.length,
        Math.max(0, streamLimit - current.length),
        Math.max(0, limits.totalOutputBytes - acceptedOutputBytes)
      );
      const acceptedChunk = chunk.subarray(0, acceptedBytes);
      const truncated = acceptedBytes < chunk.length;
      acceptedOutputBytes += acceptedBytes;
      if (stream === 'stdout') {
        if (acceptedBytes > 0) stdout = Buffer.concat([stdout, acceptedChunk]);
        stdoutTruncated ||= truncated;
        if (acceptedBytes > 0) callbacks.onStdout?.(acceptedChunk.toString('utf8'));
      } else {
        if (acceptedBytes > 0) stderr = Buffer.concat([stderr, acceptedChunk]);
        stderrTruncated ||= truncated;
        if (acceptedBytes > 0) callbacks.onStderr?.(acceptedChunk.toString('utf8'));
      }
      if (truncated) {
        void requestTermination('output_limit', 'Prozessausgabe-Limit überschritten.');
      }
    };

    child.stdout.on('data', (chunk: Buffer) => consume('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => consume('stderr', chunk));
    child.once('spawn', () => {
      if (child.pid) callbacks.onStart?.(child.pid);
    });
    child.once('error', (error) => {
      if (!requestedTermination) { requestedTermination = 'spawn_error'; terminationError = error.message; }
    });

    const wallTimer = setTimeout(() => { void requestTermination('timeout', 'Walltime-Limit überschritten.'); }, limits.wallTimeMs);
    wallTimer.unref();
    const heartbeatTimer = setInterval(() => callbacks.onHeartbeat?.(), limits.heartbeatMs);
    heartbeatTimer.unref();
    const resourceTimer = resourceLimitsEnabled
      ? setInterval(() => { void probeResources(); }, limits.resourceProbeIntervalMs)
      : undefined;
    resourceTimer?.unref();
    resetIdle();

    child.once('close', async (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer); clearTimeout(idleTimer); clearInterval(heartbeatTimer);
      if (resourceTimer) clearInterval(resourceTimer);
      // Completion is not observable until the grace-period cleanup has
      // finished. This prevents tests and callers from racing a surviving
      // descendant after an early root exit.
      await terminationCleanup;
      const termination = requestedTermination ?? classifyNaturalProcessTermination(exitCode, signal as NodeJS.Signals | null);
      resolveCompletion({
        termination, exitCode, signal: signal as NodeJS.Signals | null,
        stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'),
        stdoutTruncated, stderrTruncated, startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(), error: terminationError,
        ...(lastResourceUsage ? { lastResourceUsage: { ...lastResourceUsage } } : {})
      });
    });

    if (spec.stdin !== undefined) {
      inputBytes += Buffer.byteLength(spec.stdin);
      if (inputBytes > limits.maxInputBytes) void requestTermination('output_limit', 'Initiale Eingabe überschreitet das Eingabelimit.');
      else child.stdin.end(spec.stdin);
    }

    return {
      pid: child.pid,
      completion,
      async writeInput(input: string, close = false): Promise<void> {
        const bytes = Buffer.byteLength(input);
        inputBytes += bytes;
        if (inputBytes > limits.maxInputBytes) throw new Error('Eingabelimit des Runs überschritten.');
        if (child.stdin.destroyed || !child.stdin.writable) throw new Error('Provider akzeptiert keine weitere Eingabe.');
        await new Promise<void>((resolveWrite, reject) => child.stdin.write(input, (error) => error ? reject(error) : resolveWrite()));
        if (close) child.stdin.end();
      },
      async cancel(reason = 'Vom Nutzer abgebrochen.'): Promise<void> { await requestTermination('cancelled', reason); }
    };
  }
}
