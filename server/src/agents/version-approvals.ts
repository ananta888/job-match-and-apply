import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RuntimeTarget } from '../ports/agent-runner.js';

const APPROVAL_ID = /^[a-z][a-z0-9._-]{0,127}$/;
const DISTRIBUTION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION = /^[^\r\n\0]{1,120}$/;
const EXECUTABLE = /^[^\r\n\0]{1,1024}$/;

export interface VersionApproval {
  provider: string;
  executable: string;
  runtimeTarget: RuntimeTarget;
  distribution?: string;
  version: string;
  approvedAt: string;
}

export interface VersionApprovalKey {
  provider: string;
  executable: string;
  runtimeTarget: RuntimeTarget;
  distribution?: string;
  version: string;
}

export interface VersionApprovalSnapshot {
  schemaVersion: 1;
  updatedAt: string | null;
  approvals: VersionApproval[];
}

export interface VersionApprovalStore {
  load(): Promise<VersionApprovalSnapshot>;
  approve(key: VersionApprovalKey, expectedUpdatedAt: string | null): Promise<VersionApprovalSnapshot>;
  revoke(key: VersionApprovalKey, expectedUpdatedAt: string | null): Promise<VersionApprovalSnapshot>;
}

export class VersionApprovalConflictError extends Error {
  constructor() { super('version_approval_revision_conflict'); this.name = 'VersionApprovalConflictError'; }
}

export class VersionApprovalNotFoundError extends Error {
  constructor() { super('version_approval_not_found'); this.name = 'VersionApprovalNotFoundError'; }
}

/** Normalizes a path for cross-runtime comparison without case folding (Linux paths are case-sensitive). */
function normalizeExecutable(value: string): string {
  return value.replace(/\\/g, '/');
}

export function parseVersionApprovalKey(input: unknown): VersionApprovalKey {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('version_approval_invalid');
  const record = input as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !['provider', 'executable', 'runtimeTarget', 'distribution', 'version'].includes(key));
  if (unknownKeys.length) throw new Error('version_approval_unknown_field');
  if (typeof record.provider !== 'string' || !APPROVAL_ID.test(record.provider)) throw new Error('version_approval_invalid_provider');
  if (typeof record.executable !== 'string' || !EXECUTABLE.test(record.executable)) throw new Error('version_approval_invalid_executable');
  if (record.runtimeTarget !== 'windows' && record.runtimeTarget !== 'wsl' && record.runtimeTarget !== 'linux' && record.runtimeTarget !== 'darwin') {
    throw new Error('version_approval_invalid_runtime');
  }
  if (record.distribution !== undefined && (typeof record.distribution !== 'string' || !DISTRIBUTION.test(record.distribution))) {
    throw new Error('version_approval_invalid_distribution');
  }
  if (typeof record.version !== 'string' || !VERSION.test(record.version) || !record.version.trim()) throw new Error('version_approval_invalid_version');
  const key: VersionApprovalKey = {
    provider: record.provider,
    executable: record.executable,
    runtimeTarget: record.runtimeTarget,
    version: record.version.trim(),
  };
  if (record.distribution !== undefined) key.distribution = record.distribution;
  return key;
}

function sameKey(left: VersionApprovalKey, right: VersionApprovalKey): boolean {
  return left.provider === right.provider
    && left.runtimeTarget === right.runtimeTarget
    && (left.distribution ?? '') === (right.distribution ?? '')
    && normalizeExecutable(left.executable) === normalizeExecutable(right.executable)
    && left.version === right.version;
}

/** Exact-match predicate: an approval only ever covers the exact installation it was granted for. */
export function isVersionApproved(
  approvals: readonly VersionApproval[],
  probe: VersionApprovalKey,
): boolean {
  return approvals.some((approval) => sameKey(approval, probe));
}

function emptySnapshot(): VersionApprovalSnapshot {
  return { schemaVersion: 1, updatedAt: null, approvals: [] };
}

function parseSnapshot(raw: string): VersionApprovalSnapshot {
  const parsed = JSON.parse(raw) as VersionApprovalSnapshot;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.approvals)) throw new Error('version_approval_store_invalid');
  return {
    schemaVersion: 1,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    approvals: parsed.approvals.map((entry) => {
      const { approvedAt, ...key } = entry ?? {};
      const parsedKey = parseVersionApprovalKey(key);
      if (typeof approvedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(approvedAt)) throw new Error('version_approval_store_invalid');
      return { ...parsedKey, approvedAt };
    }),
  };
}

export class JsonVersionApprovalStore implements VersionApprovalStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<VersionApprovalSnapshot> {
    try {
      return parseSnapshot(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySnapshot();
      if (error instanceof SyntaxError) throw new Error('version_approval_store_invalid');
      throw error;
    }
  }

  async approve(key: VersionApprovalKey, expectedUpdatedAt: string | null): Promise<VersionApprovalSnapshot> {
    const current = await this.load();
    if (current.updatedAt !== expectedUpdatedAt) throw new VersionApprovalConflictError();
    const now = new Date().toISOString();
    const approvals = current.approvals.filter((entry) => !sameKey(entry, key));
    approvals.push({ ...key, approvedAt: now });
    return this.persist({ schemaVersion: 1, updatedAt: now, approvals });
  }

  async revoke(key: VersionApprovalKey, expectedUpdatedAt: string | null): Promise<VersionApprovalSnapshot> {
    const current = await this.load();
    if (current.updatedAt !== expectedUpdatedAt) throw new VersionApprovalConflictError();
    if (!current.approvals.some((entry) => sameKey(entry, key))) throw new VersionApprovalNotFoundError();
    const approvals = current.approvals.filter((entry) => !sameKey(entry, key));
    return this.persist({ schemaVersion: 1, updatedAt: new Date().toISOString(), approvals });
  }

  private async persist(snapshot: VersionApprovalSnapshot): Promise<VersionApprovalSnapshot> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.filePath);
    return snapshot;
  }
}

export class MemoryVersionApprovalStore implements VersionApprovalStore {
  private snapshot: VersionApprovalSnapshot = emptySnapshot();

  async load(): Promise<VersionApprovalSnapshot> {
    return structuredClone(this.snapshot);
  }

  async approve(key: VersionApprovalKey, expectedUpdatedAt: string | null): Promise<VersionApprovalSnapshot> {
    if (this.snapshot.updatedAt !== expectedUpdatedAt) throw new VersionApprovalConflictError();
    const now = new Date().toISOString();
    this.snapshot = {
      schemaVersion: 1,
      updatedAt: now,
      approvals: [...this.snapshot.approvals.filter((entry) => !sameKey(entry, key)), { ...key, approvedAt: now }],
    };
    return structuredClone(this.snapshot);
  }

  async revoke(key: VersionApprovalKey, expectedUpdatedAt: string | null): Promise<VersionApprovalSnapshot> {
    if (this.snapshot.updatedAt !== expectedUpdatedAt) throw new VersionApprovalConflictError();
    if (!this.snapshot.approvals.some((entry) => sameKey(entry, key))) throw new VersionApprovalNotFoundError();
    this.snapshot = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      approvals: this.snapshot.approvals.filter((entry) => !sameKey(entry, key)),
    };
    return structuredClone(this.snapshot);
  }
}
