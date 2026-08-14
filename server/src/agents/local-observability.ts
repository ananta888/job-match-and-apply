import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const SAFE_CODE = /^[a-z][a-z0-9_.:-]{0,127}$/;
const SAFE_PROVIDER = /^[a-z][a-z0-9-]{0,63}$/;

export interface AgentLocalLogRecord {
  schemaVersion: 1;
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  component: string;
  operation: string;
  code: string;
  correlationHash?: string;
  runHash?: string;
  provider?: string;
  providerVersion?: string;
  durationMs?: number;
  eventSequence?: number;
  errorClass?: string;
}

export type AgentLocalLogInput = Omit<AgentLocalLogRecord, 'schemaVersion' | 'timestamp' | 'correlationHash' | 'runHash'> & {
  correlationId?: string;
  runId?: string;
};

function opaque(value: string): string { return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`; }
function bounded(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new Error('observability_value_invalid');
  return value;
}
function safeOptionalCode(value: string | undefined, error: string): string | undefined {
  if (value !== undefined && !SAFE_CODE.test(value)) throw new Error(error);
  return value;
}

/**
 * Allowlist-only local trace sink. It deliberately has no message/details/prompt
 * parameter, including at debug level.
 */
export class AgentLocalObservability {
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private readonly path = resolve(process.cwd(), '.local-data', 'agent-observability', 'events.jsonl'),
    localDataRoot = resolve(process.cwd(), '.local-data'),
  ) {
    if (!isAbsolute(this.path)) throw new Error('observability_path_must_be_absolute');
    assertLocalObservabilityPath(localDataRoot, this.path);
  }

  async record(input: AgentLocalLogInput, now = new Date()): Promise<AgentLocalLogRecord> {
    const allowed = new Set(['level', 'component', 'operation', 'code', 'correlationId', 'runId', 'provider', 'providerVersion', 'durationMs', 'eventSequence', 'errorClass']);
    if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('observability_field_not_allowed');
    if (!['debug', 'info', 'warn', 'error'].includes(input.level) || !SAFE_CODE.test(input.component)
      || !SAFE_CODE.test(input.operation) || !SAFE_CODE.test(input.code)
      || (input.provider !== undefined && !SAFE_PROVIDER.test(input.provider))
      || (input.providerVersion !== undefined && !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(input.providerVersion))) {
      throw new Error('observability_record_invalid');
    }
    if (!Number.isFinite(now.getTime())) throw new Error('observability_timestamp_invalid');
    const timestamp = now.toISOString();
    const record: AgentLocalLogRecord = {
      schemaVersion: 1, timestamp, level: input.level, component: input.component,
      operation: input.operation, code: input.code,
      correlationHash: input.correlationId ? opaque(input.correlationId) : undefined,
      runHash: input.runId ? opaque(input.runId) : undefined,
      provider: input.provider, providerVersion: input.providerVersion,
      durationMs: bounded(input.durationMs), eventSequence: bounded(input.eventSequence),
      errorClass: safeOptionalCode(input.errorClass, 'observability_error_class_invalid')
    };
    await this.serialized(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      try {
        const info = await lstat(this.path);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error('observability_log_not_plain_file');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await appendFile(this.path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
      const handle = await open(this.path, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
    });
    return structuredClone(record);
  }

  async readLocal(): Promise<AgentLocalLogRecord[]> {
    let text: string;
    try { text = await readFile(this.path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return text.split('\n').filter(Boolean).map((line, index) => {
      try { return JSON.parse(line) as AgentLocalLogRecord; }
      catch { throw new Error(`observability_log_corrupt:${index + 1}`); }
    });
  }

  private async serialized<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.queue; let release!: () => void;
    this.queue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous; try { return await action(); } finally { release(); }
  }
}

/** Utility for verifying an explicitly configured log remains below a local data root. */
export function assertLocalObservabilityPath(localDataRoot: string, logPath: string): void {
  const root = resolve(localDataRoot); const candidate = resolve(logPath); const rel = relative(root, candidate);
  if (candidate === root || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('observability_path_outside_local_data');
}
