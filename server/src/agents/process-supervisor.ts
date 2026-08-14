import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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
  constructor(private readonly resourceProbe?: ResourceProbe) {}

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
    let forceTimer: NodeJS.Timeout | undefined;
    let lastResourceUsage: ProcessResourceUsage | undefined;
    let resourceProbeRunning = false;
    let settled = false;
    let resolveCompletion!: (result: ProcessResult) => void;
    const completion = new Promise<ProcessResult>((resolve) => { resolveCompletion = resolve; });
    let idleTimer: NodeJS.Timeout;

    const killTree = async (force: boolean): Promise<void> => {
      if (!child.pid || (!force && (child.exitCode !== null || child.killed))) return;
      if (process.platform === 'win32') {
        await new Promise<void>((resolveKill) => {
          const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', ...(force ? ['/f'] : [])], {
            shell: false, windowsHide: true, stdio: 'ignore'
          });
          killer.once('error', () => resolveKill());
          killer.once('close', () => resolveKill());
        });
      } else {
        try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
    };

    const requestTermination = async (kind: ProcessTermination, error?: string): Promise<void> => {
      if (settled || requestedTermination) return;
      requestedTermination = kind;
      terminationError = error;
      await killTree(false);
      forceTimer = setTimeout(() => { void killTree(true); }, limits.cancelGraceMs);
      forceTimer.unref();
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
        lastResourceUsage = { ...usage };
        const violation = classifyProcessResourceUsage(usage, limits);
        if (violation === 'memory_limit') {
          await requestTermination('memory_limit', `Speicherlimit ueberschritten: ${usage.residentMemoryBytes} > ${limits.maxResidentMemoryBytes}.`);
        } else if (violation === 'child_process_limit') {
          await requestTermination('child_process_limit', `Kindprozesslimit ueberschritten: ${usage.childProcessCount} > ${limits.maxChildProcesses}.`);
        }
      } catch (error) {
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
      void probeResources();
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

    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer); clearTimeout(idleTimer); clearInterval(heartbeatTimer);
      if (resourceTimer) clearInterval(resourceTimer);
      if (forceTimer) {
        clearTimeout(forceTimer);
        // A direct child may exit before a descendant does. One final forced
        // tree cleanup preserves the cancel contract after the root close.
        void killTree(true);
      }
      const termination = requestedTermination ?? (signal ? 'signal' : 'exit');
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
