import {
  assertCompatibleAgentContract,
  type AgentEvent,
  type AgentRun,
} from '../ports/agent-runner.js';

export const AGENT_PERSISTENCE_VERSION = 1 as const;
const VERSION_FIELD = 'persistenceVersion';

type JsonRecord = Record<string, unknown>;
type Migration = (record: Readonly<JsonRecord>) => JsonRecord;

export type PersistenceMigrationErrorCode =
  | 'record_not_object'
  | 'version_invalid'
  | 'version_unsupported'
  | 'migration_missing'
  | 'migration_invalid'
  | 'record_invalid';

/**
 * A distinct error lets recovery distinguish a corrupt/truncated JSON snapshot
 * (which an authoritative event stream can rebuild) from a readable but
 * unsupported persistence contract (which must never be silently downgraded).
 */
export class AgentPersistenceMigrationError extends Error {
  constructor(
    readonly code: PersistenceMigrationErrorCode,
    readonly recordKind: string,
    message: string,
  ) {
    super(`agent_persistence_${recordKind}_${code}:${message}`);
    this.name = 'AgentPersistenceMigrationError';
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

/** Small, deterministic, forward-only registry used by every disk record. */
export class PersistenceMigrationRegistry {
  private readonly migrations = new Map<number, { to: number; migrate: Migration }>();

  constructor(
    readonly recordKind: string,
    readonly currentVersion: number,
    readonly legacyVersion = 0,
  ) {
    if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
      throw new Error('persistence_current_version_invalid');
    }
    if (!Number.isSafeInteger(legacyVersion) || legacyVersion < 0 || legacyVersion >= currentVersion) {
      throw new Error('persistence_legacy_version_invalid');
    }
  }

  register(from: number, to: number, migrate: Migration): this {
    if (!Number.isSafeInteger(from) || to !== from + 1 || from < this.legacyVersion || to > this.currentVersion) {
      throw new Error('persistence_migration_step_invalid');
    }
    if (this.migrations.has(from)) throw new Error(`persistence_migration_duplicate:${from}`);
    this.migrations.set(from, { to, migrate });
    return this;
  }

  migrate(value: unknown): { record: JsonRecord; migrated: boolean } {
    if (!isRecord(value)) {
      throw new AgentPersistenceMigrationError('record_not_object', this.recordKind, 'root');
    }
    let record = structuredClone(value);
    const declared = record[VERSION_FIELD];
    let version = declared === undefined ? this.legacyVersion : declared;
    if (!Number.isSafeInteger(version) || (version as number) < this.legacyVersion) {
      throw new AgentPersistenceMigrationError('version_invalid', this.recordKind, String(version));
    }
    if ((version as number) > this.currentVersion) {
      throw new AgentPersistenceMigrationError(
        'version_unsupported', this.recordKind, `${String(version)}>${this.currentVersion}`,
      );
    }
    const initialVersion = version as number;
    while ((version as number) < this.currentVersion) {
      const step = this.migrations.get(version as number);
      if (!step) {
        throw new AgentPersistenceMigrationError('migration_missing', this.recordKind, String(version));
      }
      let migrated: JsonRecord;
      try { migrated = step.migrate(Object.freeze(structuredClone(record))); }
      catch (error) {
        throw new AgentPersistenceMigrationError(
          'migration_invalid', this.recordKind, error instanceof Error ? error.message : String(error),
        );
      }
      if (!isRecord(migrated) || migrated[VERSION_FIELD] !== step.to) {
        throw new AgentPersistenceMigrationError('migration_invalid', this.recordKind, `${version}->${step.to}`);
      }
      record = migrated;
      version = step.to;
    }
    if (record[VERSION_FIELD] !== this.currentVersion) {
      throw new AgentPersistenceMigrationError('migration_invalid', this.recordKind, 'terminal-version');
    }
    return { record, migrated: initialVersion !== this.currentVersion };
  }
}

function registry(kind: string): PersistenceMigrationRegistry {
  return new PersistenceMigrationRegistry(kind, AGENT_PERSISTENCE_VERSION)
    .register(0, 1, (record) => ({ ...record, [VERSION_FIELD]: 1 }));
}

const runMigrations = registry('run');
const eventMigrations = registry('event');

function withoutPersistenceVersion<T>(record: JsonRecord): T {
  const copy = structuredClone(record);
  delete copy[VERSION_FIELD];
  return copy as T;
}

function validateRun(record: JsonRecord): void {
  try {
    assertCompatibleAgentContract(String(record.schemaVersion));
    const request = record.request;
    if (
      typeof record.id !== 'string' || typeof record.provider !== 'string'
      || typeof record.state !== 'string' || !isRecord(request)
      || request.provider !== record.provider
      || !Number.isSafeInteger(record.currentSequence) || (record.currentSequence as number) < 0
      || !finiteTimestamp(record.requestedAt) || !finiteTimestamp(record.updatedAt)
    ) throw new Error('required-fields');
  } catch (error) {
    throw new AgentPersistenceMigrationError(
      'record_invalid', 'run', error instanceof Error ? error.message : String(error),
    );
  }
}

function validateEvent(record: JsonRecord): void {
  try {
    assertCompatibleAgentContract(String(record.schemaVersion));
    if (
      typeof record.runId !== 'string' || typeof record.provider !== 'string'
      || !Number.isSafeInteger(record.sequence) || (record.sequence as number) < 1
      || !finiteTimestamp(record.timestamp) || typeof record.correlationId !== 'string'
      || !record.correlationId || typeof record.kind !== 'string' || !record.kind
      || !isRecord(record.data)
    ) throw new Error('required-fields');
  } catch (error) {
    throw new AgentPersistenceMigrationError(
      'record_invalid', 'event', error instanceof Error ? error.message : String(error),
    );
  }
}

export function decodeAgentRunSnapshot(value: unknown): { value: AgentRun; migrated: boolean } {
  const result = runMigrations.migrate(value);
  validateRun(result.record);
  return { value: withoutPersistenceVersion<AgentRun>(result.record), migrated: result.migrated };
}

export function encodeAgentRunSnapshot(value: AgentRun): JsonRecord {
  const record = { ...structuredClone(value), [VERSION_FIELD]: AGENT_PERSISTENCE_VERSION };
  validateRun(record);
  return record;
}

export function decodeAgentEventSnapshot(value: unknown): { value: AgentEvent; migrated: boolean } {
  const result = eventMigrations.migrate(value);
  validateEvent(result.record);
  return { value: withoutPersistenceVersion<AgentEvent>(result.record), migrated: result.migrated };
}

export function encodeAgentEventSnapshot(value: AgentEvent): JsonRecord {
  const record = { ...structuredClone(value), [VERSION_FIELD]: AGENT_PERSISTENCE_VERSION };
  validateEvent(record);
  return record;
}
