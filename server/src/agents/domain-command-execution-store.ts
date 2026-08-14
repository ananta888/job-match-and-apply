import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { canonicalJson } from './security-approval.js';

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const writeQueues = new Map<string, Promise<unknown>>();

export interface DomainCommandResult {
  revision: number;
  result: unknown;
}

export interface DomainCommandExecutionRecord {
  schemaVersion: 1;
  commandId: string;
  applicationCaseId: string;
  expectedRevision: number;
  idempotencyKeySha256: string;
  commandSha256: string;
  command: unknown;
  state: 'confirmed' | 'executing' | 'completed';
  confirmedAt: string;
  updatedAt: string;
  leaseSha256?: string;
  leaseExpiresAt?: string;
  resultSha256?: string;
  result?: DomainCommandResult;
}

export type DomainCommandExecutionClaim =
  | { outcome: 'execute'; record: DomainCommandExecutionRecord; leaseToken: string; resumed: boolean }
  | { outcome: 'duplicate'; record: DomainCommandExecutionRecord; result: DomainCommandResult };

export interface DomainCommandExecutionStore {
  confirm(input: {
    commandId: string;
    applicationCaseId: string;
    expectedRevision: number;
    idempotencyKeySha256: string;
    command: unknown;
  }): Promise<DomainCommandExecutionRecord>;
  begin(input: {
    commandId: string;
    applicationCaseId: string;
    expectedRevision: number;
    idempotencyKeySha256: string;
  }): Promise<DomainCommandExecutionClaim>;
  complete(input: {
    idempotencyKeySha256: string;
    leaseToken: string;
    result: DomainCommandResult;
  }): Promise<DomainCommandExecutionRecord>;
  abandon(input: { idempotencyKeySha256: string; leaseToken: string }): Promise<void>;
}

export function domainCommandHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function validateIdentity(input: {
  commandId: string;
  applicationCaseId: string;
  expectedRevision: number;
  idempotencyKeySha256: string;
}): void {
  if (!SAFE_ID.test(input.commandId) || !SAFE_ID.test(input.applicationCaseId)
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
    || !SHA256.test(input.idempotencyKeySha256)) {
    throw new Error('mcp_domain_command_identity_invalid');
  }
}

function validateResult(value: unknown): DomainCommandResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('mcp_domain_command_result_invalid');
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 0 || !('result' in candidate)) {
    throw new Error('mcp_domain_command_result_invalid');
  }
  return { revision: candidate.revision as number, result: structuredClone(candidate.result) };
}

function checkedRecord(value: unknown): DomainCommandExecutionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('mcp_domain_command_record_invalid');
  const record = value as DomainCommandExecutionRecord;
  validateIdentity(record);
  if (record.schemaVersion !== 1 || !['confirmed', 'executing', 'completed'].includes(record.state)
    || !SHA256.test(record.commandSha256) || domainCommandHash(record.command) !== record.commandSha256
    || !Number.isFinite(Date.parse(record.confirmedAt)) || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new Error('mcp_domain_command_record_invalid');
  }
  if (record.state === 'executing') {
    if (!record.leaseSha256 || !SHA256.test(record.leaseSha256) || !record.leaseExpiresAt
      || !Number.isFinite(Date.parse(record.leaseExpiresAt)) || record.result !== undefined || record.resultSha256 !== undefined) {
      throw new Error('mcp_domain_command_record_invalid');
    }
  } else if (record.leaseSha256 !== undefined || record.leaseExpiresAt !== undefined) {
    throw new Error('mcp_domain_command_record_invalid');
  }
  if (record.state === 'completed') {
    const result = validateResult(record.result);
    if (!record.resultSha256 || !SHA256.test(record.resultSha256) || domainCommandHash(result) !== record.resultSha256) {
      throw new Error('mcp_domain_command_record_invalid');
    }
  } else if (record.result !== undefined || record.resultSha256 !== undefined) {
    throw new Error('mcp_domain_command_record_invalid');
  }
  return structuredClone(record);
}

function assertSameCommand(record: DomainCommandExecutionRecord, input: {
  commandId: string;
  applicationCaseId: string;
  expectedRevision: number;
  idempotencyKeySha256: string;
}): void {
  if (record.commandId !== input.commandId || record.applicationCaseId !== input.applicationCaseId
    || record.expectedRevision !== input.expectedRevision || record.idempotencyKeySha256 !== input.idempotencyKeySha256) {
    throw new Error('mcp_idempotency_key_reused_for_different_command');
  }
}

function newRecord(input: {
  commandId: string;
  applicationCaseId: string;
  expectedRevision: number;
  idempotencyKeySha256: string;
  command: unknown;
}, now: Date): DomainCommandExecutionRecord {
  validateIdentity(input);
  const command = structuredClone(input.command);
  return {
    schemaVersion: 1,
    commandId: input.commandId,
    applicationCaseId: input.applicationCaseId,
    expectedRevision: input.expectedRevision,
    idempotencyKeySha256: input.idempotencyKeySha256,
    commandSha256: domainCommandHash(command),
    command,
    state: 'confirmed',
    confirmedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

abstract class BaseDomainCommandExecutionStore implements DomainCommandExecutionStore {
  constructor(
    private readonly clock: () => Date = () => new Date(),
    private readonly leaseMs = 60_000,
  ) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 10 * 60_000) {
      throw new Error('mcp_domain_command_lease_invalid');
    }
  }

  protected abstract transact<T>(idempotencyKeySha256: string, operation: (
    current: DomainCommandExecutionRecord | undefined,
  ) => { value: T; next?: DomainCommandExecutionRecord }): Promise<T>;

  async confirm(input: {
    commandId: string;
    applicationCaseId: string;
    expectedRevision: number;
    idempotencyKeySha256: string;
    command: unknown;
  }): Promise<DomainCommandExecutionRecord> {
    validateIdentity(input);
    const proposed = newRecord(input, this.clock());
    return this.transact(input.idempotencyKeySha256, (current) => {
      if (current) {
        assertSameCommand(current, input);
        if (current.commandSha256 !== proposed.commandSha256) throw new Error('mcp_idempotency_key_reused_for_different_command');
        return { value: structuredClone(current) };
      }
      return { value: structuredClone(proposed), next: proposed };
    });
  }

  async begin(input: {
    commandId: string;
    applicationCaseId: string;
    expectedRevision: number;
    idempotencyKeySha256: string;
  }): Promise<DomainCommandExecutionClaim> {
    validateIdentity(input);
    return this.transact<DomainCommandExecutionClaim>(input.idempotencyKeySha256, (current) => {
      if (!current) throw new Error('mcp_confirmed_command_mismatch');
      assertSameCommand(current, input);
      if (current.state === 'completed') {
        return { value: { outcome: 'duplicate', record: structuredClone(current), result: validateResult(current.result) } };
      }
      const now = this.clock();
      const resumed = current.state === 'executing';
      if (resumed && Date.parse(current.leaseExpiresAt!) > now.getTime()) {
        throw new Error('mcp_domain_command_execution_in_progress');
      }
      const leaseToken = randomUUID();
      const next: DomainCommandExecutionRecord = {
        ...current,
        state: 'executing',
        updatedAt: now.toISOString(),
        leaseSha256: domainCommandHash(leaseToken),
        leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
      };
      return { value: { outcome: 'execute', record: structuredClone(next), leaseToken, resumed }, next };
    });
  }

  async complete(input: {
    idempotencyKeySha256: string;
    leaseToken: string;
    result: DomainCommandResult;
  }): Promise<DomainCommandExecutionRecord> {
    if (!SHA256.test(input.idempotencyKeySha256) || !input.leaseToken) throw new Error('mcp_domain_command_identity_invalid');
    const result = validateResult(input.result);
    return this.transact(input.idempotencyKeySha256, (current) => {
      if (!current || current.state !== 'executing' || current.leaseSha256 !== domainCommandHash(input.leaseToken)) {
        throw new Error('mcp_domain_command_lease_mismatch');
      }
      const now = this.clock();
      const next: DomainCommandExecutionRecord = {
        ...current,
        state: 'completed',
        updatedAt: now.toISOString(),
        leaseSha256: undefined,
        leaseExpiresAt: undefined,
        resultSha256: domainCommandHash(result),
        result,
      };
      return { value: structuredClone(next), next };
    });
  }

  async abandon(input: { idempotencyKeySha256: string; leaseToken: string }): Promise<void> {
    if (!SHA256.test(input.idempotencyKeySha256) || !input.leaseToken) throw new Error('mcp_domain_command_identity_invalid');
    await this.transact(input.idempotencyKeySha256, (current) => {
      if (!current || current.state === 'completed') return { value: undefined };
      if (current.state !== 'executing' || current.leaseSha256 !== domainCommandHash(input.leaseToken)) {
        throw new Error('mcp_domain_command_lease_mismatch');
      }
      const next: DomainCommandExecutionRecord = {
        ...current,
        state: 'confirmed',
        updatedAt: this.clock().toISOString(),
        leaseSha256: undefined,
        leaseExpiresAt: undefined,
      };
      return { value: undefined, next };
    });
  }
}

export class MemoryDomainCommandExecutionStore extends BaseDomainCommandExecutionStore {
  private readonly records = new Map<string, DomainCommandExecutionRecord>();

  protected async transact<T>(idempotencyKeySha256: string, operation: (
    current: DomainCommandExecutionRecord | undefined,
  ) => { value: T; next?: DomainCommandExecutionRecord }): Promise<T> {
    const result = operation(this.records.get(idempotencyKeySha256));
    if (result.next) this.records.set(idempotencyKeySha256, checkedRecord(result.next));
    return structuredClone(result.value);
  }
}

export class JsonDomainCommandExecutionStore extends BaseDomainCommandExecutionStore {
  constructor(
    private readonly root = resolve(process.cwd(), '..', '.local-data', 'agent-domain-commands'),
    clock: () => Date = () => new Date(),
    leaseMs = 60_000,
  ) { super(clock, leaseMs); }

  protected async transact<T>(idempotencyKeySha256: string, operation: (
    current: DomainCommandExecutionRecord | undefined,
  ) => { value: T; next?: DomainCommandExecutionRecord }): Promise<T> {
    if (!SHA256.test(idempotencyKeySha256)) throw new Error('mcp_domain_command_identity_invalid');
    const path = resolve(this.root, `${idempotencyKeySha256}.json`);
    if (dirname(path) !== resolve(this.root)) throw new Error('mcp_domain_command_store_escape');
    const previous = writeQueues.get(path) ?? Promise.resolve();
    const queued = previous.then(async () => {
      const current = await this.read(path);
      const result = operation(current);
      if (result.next) await this.write(path, checkedRecord(result.next));
      return structuredClone(result.value);
    });
    writeQueues.set(path, queued);
    try { return await queued; }
    finally { if (writeQueues.get(path) === queued) writeQueues.delete(path); }
  }

  private async read(path: string): Promise<DomainCommandExecutionRecord | undefined> {
    try { return checkedRecord(JSON.parse(await readFile(path, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async write(path: string, record: DomainCommandExecutionRecord): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  }
}
