import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface AgentIdempotencyResultReference {
  resourceType: string;
  resourceId: string;
}

export interface AgentIdempotencyRecord {
  schemaVersion: 1;
  namespace: string;
  keyHash: string;
  requestFingerprint: string;
  state: 'pending' | 'completed';
  createdAt: string;
  expiresAt: string;
  leaseHash: string;
  completedAt?: string;
  result?: AgentIdempotencyResultReference;
}

export type AgentIdempotencyClaim =
  | { status: 'claimed'; leaseToken: string; expiresAt: string }
  | { status: 'in_progress'; expiresAt: string }
  | { status: 'replay'; result: AgentIdempotencyResultReference; completedAt: string };

function canonical(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('idempotency_fingerprint_value_invalid');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('idempotency_fingerprint_cycle');
    seen.add(value);
    const result = `[${value.map((entry) => canonical(entry, seen)).join(',')}]`;
    seen.delete(value);
    return result;
  }
  if (!value || typeof value !== 'object') throw new Error('idempotency_fingerprint_value_invalid');
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('idempotency_fingerprint_value_invalid');
  if (seen.has(value)) throw new Error('idempotency_fingerprint_cycle');
  seen.add(value);
  const result = `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry, seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}

/** Hashes request parameters without requiring their sensitive values to be persisted. */
export function agentIdempotencyFingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function ensureContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    throw new Error('idempotency_store_escape');
  }
}

function validateRecord(value: unknown): AgentIdempotencyRecord {
  if (!value || typeof value !== 'object') throw new Error('idempotency_record_invalid');
  const record = value as Partial<AgentIdempotencyRecord>;
  if (record.schemaVersion !== 1 || !record.namespace || !SAFE_NAME.test(record.namespace)
    || !record.keyHash || !SHA256.test(record.keyHash) || !record.requestFingerprint || !SHA256.test(record.requestFingerprint)
    || !record.leaseHash || !SHA256.test(record.leaseHash) || !['pending', 'completed'].includes(record.state ?? '')
    || !record.createdAt || !Number.isFinite(Date.parse(record.createdAt))
    || !record.expiresAt || !Number.isFinite(Date.parse(record.expiresAt))) {
    throw new Error('idempotency_record_invalid');
  }
  if (record.state === 'completed') {
    if (!record.completedAt || !Number.isFinite(Date.parse(record.completedAt)) || !record.result
      || !SAFE_NAME.test(record.result.resourceType) || !SAFE_NAME.test(record.result.resourceId)) {
      throw new Error('idempotency_record_invalid');
    }
  } else if (record.completedAt || record.result) throw new Error('idempotency_record_invalid');
  return record as AgentIdempotencyRecord;
}

/**
 * Durable, payload-free idempotency registry. The caller persists only a request
 * fingerprint and an opaque result reference; prompts and request bodies never enter it.
 */
export class JsonAgentIdempotencyStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly root = resolve(process.cwd(), '.local-data', 'agent-idempotency'),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async claim(input: {
    namespace: string;
    key: string;
    requestFingerprint: string;
    ttlMs?: number;
  }): Promise<AgentIdempotencyClaim> {
    return this.serialized(async () => {
      const identity = this.identity(input.namespace, input.key, input.requestFingerprint);
      const ttlMs = input.ttlMs ?? 24 * 60 * 60_000;
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 30 * 24 * 60 * 60_000) {
        throw new Error('idempotency_ttl_invalid');
      }
      const now = this.clock();
      const existing = await this.read(identity.path);
      if (existing && Date.parse(existing.expiresAt) > now.getTime()) {
        if (existing.requestFingerprint !== input.requestFingerprint) throw new Error('idempotency_key_conflict');
        if (existing.state === 'completed') return {
          status: 'replay', result: structuredClone(existing.result!), completedAt: existing.completedAt!
        };
        return { status: 'in_progress', expiresAt: existing.expiresAt };
      }
      const leaseToken = randomBytes(32).toString('base64url');
      const record: AgentIdempotencyRecord = {
        schemaVersion: 1, namespace: input.namespace, keyHash: identity.keyHash,
        requestFingerprint: input.requestFingerprint, state: 'pending',
        createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        leaseHash: hash(leaseToken),
      };
      await this.write(identity.path, record, !existing);
      return { status: 'claimed', leaseToken, expiresAt: record.expiresAt };
    });
  }

  async complete(input: {
    namespace: string;
    key: string;
    requestFingerprint: string;
    leaseToken: string;
    result: AgentIdempotencyResultReference;
  }): Promise<AgentIdempotencyRecord> {
    return this.serialized(async () => {
      const identity = this.identity(input.namespace, input.key, input.requestFingerprint);
      if (!SAFE_NAME.test(input.result.resourceType) || !SAFE_NAME.test(input.result.resourceId)) {
        throw new Error('idempotency_result_reference_invalid');
      }
      const record = await this.read(identity.path);
      if (!record) throw new Error('idempotency_claim_missing');
      if (record.requestFingerprint !== input.requestFingerprint) throw new Error('idempotency_key_conflict');
      if (record.leaseHash !== hash(input.leaseToken)) throw new Error('idempotency_lease_mismatch');
      if (record.state === 'completed') return structuredClone(record);
      if (Date.parse(record.expiresAt) <= this.clock().getTime()) throw new Error('idempotency_claim_expired');
      const completed: AgentIdempotencyRecord = {
        ...record, state: 'completed', completedAt: this.clock().toISOString(), result: structuredClone(input.result)
      };
      await this.write(identity.path, completed, false);
      return structuredClone(completed);
    });
  }

  async abandon(input: { namespace: string; key: string; requestFingerprint: string; leaseToken: string }): Promise<void> {
    await this.serialized(async () => {
      const identity = this.identity(input.namespace, input.key, input.requestFingerprint);
      const record = await this.read(identity.path);
      if (!record) return;
      if (record.requestFingerprint !== input.requestFingerprint) throw new Error('idempotency_key_conflict');
      if (record.leaseHash !== hash(input.leaseToken)) throw new Error('idempotency_lease_mismatch');
      if (record.state === 'completed') throw new Error('idempotency_completed_cannot_be_abandoned');
      await rm(identity.path, { force: false });
    });
  }

  async deleteCompletedResults(resourceType: string, resourceIds: readonly string[]): Promise<number> {
    if (!SAFE_NAME.test(resourceType) || resourceIds.length !== new Set(resourceIds).size
      || resourceIds.some((id) => !SAFE_NAME.test(id))) throw new Error('idempotency_result_selection_invalid');
    return this.serialized(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const selected = new Set(resourceIds); const matches: string[] = [];
      for (const name of await readdir(this.root)) {
        if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
        const path = resolve(this.root, name); ensureContained(this.root, path);
        const record = await this.read(path);
        if (record?.state === 'completed' && record.result?.resourceType === resourceType && selected.has(record.result.resourceId)) matches.push(path);
      }
      for (const path of matches) await rm(path, { force: false });
      return matches.length;
    });
  }

  async pruneExpired(dryRun = true): Promise<{ matched: number; removed: number }> {
    return this.serialized(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const cutoff = this.clock().getTime();
      const matches: string[] = [];
      for (const name of await readdir(this.root)) {
        if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
        const path = resolve(this.root, name); ensureContained(this.root, path);
        const record = await this.read(path);
        if (record && Date.parse(record.expiresAt) <= cutoff) matches.push(path);
      }
      if (!dryRun) for (const path of matches) await rm(path, { force: false });
      return { matched: matches.length, removed: dryRun ? 0 : matches.length };
    });
  }

  private identity(namespace: string, key: string, fingerprint: string): { keyHash: string; path: string } {
    if (!SAFE_NAME.test(namespace) || !key || key.length > 512 || /[\u0000-\u001f\u007f]/.test(key)) {
      throw new Error('idempotency_identity_invalid');
    }
    if (!SHA256.test(fingerprint)) throw new Error('idempotency_fingerprint_invalid');
    const keyHash = hash(`${namespace}\0${key}`);
    const path = resolve(this.root, `${keyHash}.json`); ensureContained(this.root, path);
    return { keyHash, path };
  }

  private async read(path: string): Promise<AgentIdempotencyRecord | undefined> {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('idempotency_record_not_plain_file');
      return validateRecord(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async write(path: string, record: AgentIdempotencyRecord, createOnly: boolean): Promise<void> {
    validateRecord(record);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (createOnly) {
      await writeFile(path, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
      return;
    }
    const temporary = resolve(this.root, `.${randomUUID()}.tmp`); ensureContained(this.root, temporary);
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
  }

  private async serialized<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous;
    try { return await action(); } finally { release(); }
  }
}
