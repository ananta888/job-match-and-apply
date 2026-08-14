import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { RISK_CLASSES, type RiskClass } from './security-policy.js';

export const APPROVAL_LIFECYCLE_JOURNAL_VERSION = 1 as const;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/;

export type ApprovalLifecycleKind =
  | 'approval_requested'
  | 'approval_approved'
  | 'approval_denied'
  | 'approval_superseded'
  | 'approval_revoked'
  | 'approval_consumed'
  | 'approval_expired';

interface ApprovalLifecycleBase {
  journalVersion: typeof APPROVAL_LIFECYCLE_JOURNAL_VERSION;
  eventId: string;
  sequence: number;
  requestId: string;
  runId: string;
  occurredAt: string;
  bindingHash: string;
  kind: ApprovalLifecycleKind;
}

export interface ApprovalRequestedLifecycleEvent extends ApprovalLifecycleBase {
  kind: 'approval_requested';
  parametersHash: string;
  risk: RiskClass;
  expiresAt: string;
}

export interface ApprovalDecisionLifecycleEvent extends ApprovalLifecycleBase {
  kind: 'approval_approved' | 'approval_denied' | 'approval_revoked' | 'approval_consumed' | 'approval_expired';
  actorHash: string;
}

export interface ApprovalSupersededLifecycleEvent extends ApprovalLifecycleBase {
  kind: 'approval_superseded';
  actorHash: string;
  replacementRequestId: string;
}

export type ApprovalLifecycleEvent =
  | ApprovalRequestedLifecycleEvent
  | ApprovalDecisionLifecycleEvent
  | ApprovalSupersededLifecycleEvent;

type WithoutEnvelope<T> = T extends ApprovalLifecycleEvent
  ? Omit<T, 'journalVersion' | 'eventId' | 'sequence'>
  : never;

export type ApprovalLifecycleEventDraft = WithoutEnvelope<ApprovalLifecycleEvent>;
export type DurableApprovalStatus = 'pending' | 'approved' | 'denied' | 'superseded' | 'revoked' | 'consumed' | 'expired';

export interface DurableApprovalState {
  requestId: string;
  runId: string;
  bindingHash: string;
  parametersHash: string;
  risk: RiskClass;
  expiresAt: string;
  requestedAt: string;
  status: DurableApprovalStatus;
  resolvedAt?: string;
  replacementRequestId?: string;
  lastSequence: number;
}

export interface ApprovalLifecycleRecovery {
  truncatedTail: boolean;
  revokedRequestIds: string[];
  states: DurableApprovalState[];
}

export interface ApprovalLifecycleJournal {
  record(draft: ApprovalLifecycleEventDraft): ApprovalLifecycleEvent;
  append(event: ApprovalLifecycleEvent): 'appended' | 'duplicate';
  events(afterSequence?: number): ApprovalLifecycleEvent[];
  recover(now?: Date): ApprovalLifecycleRecovery;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashApprovalLifecycleValue(value: string): string {
  if (!value.trim()) throw new Error('approval_lifecycle_hash_input_required');
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const permitted = new Set(allowed);
  const unexpected = Object.keys(record).filter((key) => !permitted.has(key));
  if (unexpected.length > 0) throw new Error(`approval_lifecycle_fields_forbidden:${unexpected.sort().join(',')}`);
}

function validateEvent(value: unknown): asserts value is ApprovalLifecycleEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('approval_lifecycle_event_invalid');
  const event = value as Record<string, unknown>;
  const baseKeys = ['journalVersion', 'eventId', 'sequence', 'requestId', 'runId', 'occurredAt', 'bindingHash', 'kind'];
  if (event.kind === 'approval_requested') exactKeys(event, [...baseKeys, 'parametersHash', 'risk', 'expiresAt']);
  else if (event.kind === 'approval_superseded') exactKeys(event, [...baseKeys, 'actorHash', 'replacementRequestId']);
  else if (['approval_approved', 'approval_denied', 'approval_revoked', 'approval_consumed', 'approval_expired'].includes(String(event.kind))) {
    exactKeys(event, [...baseKeys, 'actorHash']);
  } else throw new Error(`approval_lifecycle_kind_invalid:${String(event.kind)}`);

  if (event.journalVersion !== APPROVAL_LIFECYCLE_JOURNAL_VERSION) {
    throw new Error(`approval_lifecycle_version_unsupported:${String(event.journalVersion)}`);
  }
  if (!Number.isSafeInteger(event.sequence) || (event.sequence as number) < 1) throw new Error('approval_lifecycle_sequence_invalid');
  for (const field of ['eventId', 'requestId', 'runId'] as const) {
    if (typeof event[field] !== 'string' || !SAFE_ID.test(event[field] as string)) throw new Error(`approval_lifecycle_${field}_invalid`);
  }
  if (!isIsoTimestamp(event.occurredAt)) throw new Error('approval_lifecycle_occurred_at_invalid');
  if (typeof event.bindingHash !== 'string' || !SHA256_BASE64URL.test(event.bindingHash)) throw new Error('approval_lifecycle_binding_hash_invalid');
  if (event.kind === 'approval_requested') {
    if (typeof event.parametersHash !== 'string' || !SHA256_BASE64URL.test(event.parametersHash)) throw new Error('approval_lifecycle_parameters_hash_invalid');
    if (!RISK_CLASSES.includes(event.risk as RiskClass)) throw new Error('approval_lifecycle_risk_invalid');
    if (!isIsoTimestamp(event.expiresAt) || Date.parse(event.expiresAt) <= Date.parse(event.occurredAt as string)) {
      throw new Error('approval_lifecycle_expiry_invalid');
    }
  } else {
    if (typeof event.actorHash !== 'string' || !SHA256_BASE64URL.test(event.actorHash)) throw new Error('approval_lifecycle_actor_hash_invalid');
    if (event.kind === 'approval_superseded' && (typeof event.replacementRequestId !== 'string' || !SAFE_ID.test(event.replacementRequestId))) {
      throw new Error('approval_lifecycle_replacement_invalid');
    }
  }
}

function reduceEvents(events: readonly ApprovalLifecycleEvent[]): Map<string, DurableApprovalState> {
  const states = new Map<string, DurableApprovalState>();
  const eventIds = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    validateEvent(event);
    if (event.sequence !== index + 1) throw new Error(`approval_lifecycle_sequence_gap:${index + 1}:${event.sequence}`);
    if (eventIds.has(event.eventId)) throw new Error(`approval_lifecycle_event_id_duplicate:${event.eventId}`);
    eventIds.add(event.eventId);
    const current = states.get(event.requestId);
    if (event.kind === 'approval_requested') {
      if (current) throw new Error(`approval_lifecycle_request_duplicate:${event.requestId}`);
      states.set(event.requestId, {
        requestId: event.requestId, runId: event.runId, bindingHash: event.bindingHash,
        parametersHash: event.parametersHash, risk: event.risk, expiresAt: event.expiresAt,
        requestedAt: event.occurredAt, status: 'pending', lastSequence: event.sequence,
      });
      continue;
    }
    if (!current) throw new Error(`approval_lifecycle_request_missing:${event.requestId}`);
    if (current.runId !== event.runId || current.bindingHash !== event.bindingHash) {
      throw new Error(`approval_lifecycle_binding_conflict:${event.requestId}`);
    }
    if (Date.parse(event.occurredAt) < Date.parse(current.requestedAt)) throw new Error('approval_lifecycle_time_order_invalid');
    const next: DurableApprovalStatus = event.kind.slice('approval_'.length) as DurableApprovalStatus;
    const allowed = (
      current.status === 'pending' && ['approved', 'denied', 'superseded', 'revoked', 'expired'].includes(next)
    ) || (current.status === 'approved' && ['revoked', 'consumed', 'expired'].includes(next));
    if (!allowed) throw new Error(`approval_lifecycle_transition_invalid:${current.status}:${next}`);
    if (event.kind === 'approval_superseded' && !states.has(event.replacementRequestId)) {
      throw new Error(`approval_lifecycle_replacement_missing:${event.replacementRequestId}`);
    }
    current.status = next;
    current.resolvedAt = event.occurredAt;
    current.lastSequence = event.sequence;
    if (event.kind === 'approval_superseded') current.replacementRequestId = event.replacementRequestId;
  }
  return states;
}

function cloneEvent<T extends ApprovalLifecycleEvent>(event: T): T { return structuredClone(event); }
function cloneStates(states: Map<string, DurableApprovalState>): DurableApprovalState[] {
  return [...states.values()].map((state) => structuredClone(state)).sort((left, right) => left.requestId.localeCompare(right.requestId));
}

abstract class BaseApprovalLifecycleJournal implements ApprovalLifecycleJournal {
  constructor(private readonly ids: () => string = randomUUID) {}
  protected abstract all(): ApprovalLifecycleEvent[];
  protected abstract persist(event: ApprovalLifecycleEvent): void;

  record(draft: ApprovalLifecycleEventDraft): ApprovalLifecycleEvent {
    const events = this.all();
    const event = {
      ...structuredClone(draft), journalVersion: APPROVAL_LIFECYCLE_JOURNAL_VERSION,
      eventId: this.ids(), sequence: events.length + 1,
    } as ApprovalLifecycleEvent;
    this.appendWithExisting(event, events);
    return cloneEvent(event);
  }

  append(event: ApprovalLifecycleEvent): 'appended' | 'duplicate' {
    return this.appendWithExisting(cloneEvent(event), this.all());
  }

  private appendWithExisting(event: ApprovalLifecycleEvent, existing: ApprovalLifecycleEvent[]): 'appended' | 'duplicate' {
    validateEvent(event);
    const byId = existing.find((candidate) => candidate.eventId === event.eventId);
    if (byId) {
      if (stableJson(byId) === stableJson(event)) return 'duplicate';
      throw new Error(`approval_lifecycle_event_id_conflict:${event.eventId}`);
    }
    reduceEvents([...existing, event]);
    this.persist(event);
    return 'appended';
  }

  events(afterSequence = 0): ApprovalLifecycleEvent[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('approval_lifecycle_cursor_invalid');
    return this.all().filter((event) => event.sequence > afterSequence).map(cloneEvent);
  }

  recover(now = new Date()): ApprovalLifecycleRecovery {
    if (!Number.isFinite(now.getTime())) throw new Error('approval_lifecycle_recovery_time_invalid');
    const states = reduceEvents(this.all());
    const revokedRequestIds: string[] = [];
    for (const state of [...states.values()].sort((left, right) => left.requestId.localeCompare(right.requestId))) {
      if (state.status !== 'pending' && state.status !== 'approved') continue;
      this.record({
        kind: 'approval_revoked', requestId: state.requestId, runId: state.runId,
        bindingHash: state.bindingHash, occurredAt: now.toISOString(),
        actorHash: hashApprovalLifecycleValue('system:restart-recovery'),
      });
      revokedRequestIds.push(state.requestId);
    }
    return { truncatedTail: false, revokedRequestIds, states: cloneStates(reduceEvents(this.all())) };
  }
}

export class MemoryApprovalLifecycleJournal extends BaseApprovalLifecycleJournal {
  private readonly log: ApprovalLifecycleEvent[] = [];
  protected all(): ApprovalLifecycleEvent[] { return this.log.map(cloneEvent); }
  protected persist(event: ApprovalLifecycleEvent): void { this.log.push(cloneEvent(event)); }
}

export class JsonlApprovalLifecycleJournal extends BaseApprovalLifecycleJournal {
  private repairedTail = false;
  readonly path: string;

  constructor(path: string, ids: () => string = randomUUID) {
    super(ids);
    if (!path.trim()) throw new Error('approval_lifecycle_path_required');
    this.path = resolve(path);
  }

  protected all(): ApprovalLifecycleEvent[] { return this.read(false).events; }

  protected persist(event: ApprovalLifecycleEvent): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = openSync(this.path, 'a', 0o600);
    try {
      appendFileSync(fd, `${JSON.stringify(event)}\n`, 'utf8');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    chmodSync(this.path, 0o600);
  }

  override recover(now = new Date()): ApprovalLifecycleRecovery {
    const read = this.read(true);
    if (read.validBytes !== undefined) {
      truncateSync(this.path, read.validBytes);
      this.repairedTail = true;
    }
    const result = super.recover(now);
    const truncatedTail = this.repairedTail;
    this.repairedTail = false;
    return { ...result, truncatedTail };
  }

  private read(repairTail: boolean): { events: ApprovalLifecycleEvent[]; validBytes?: number } {
    if (!existsSync(this.path)) return { events: [] };
    const bytes = readFileSync(this.path);
    const completeLength = bytes.length === 0 || bytes.at(-1) === 0x0a ? bytes.length : bytes.lastIndexOf(0x0a) + 1;
    const hasTail = completeLength < bytes.length;
    if (hasTail && !repairTail) throw new Error('approval_lifecycle_recovery_required');
    const completeText = bytes.subarray(0, completeLength).toString('utf8');
    const events: ApprovalLifecycleEvent[] = [];
    for (const [index, line] of completeText.split('\n').entries()) {
      if (!line) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); }
      catch (error) { throw new Error(`approval_lifecycle_log_corrupt:${index + 1}:${(error as Error).message}`); }
      validateEvent(raw);
      events.push(raw);
    }
    reduceEvents(events);
    return { events, ...(hasTail ? { validBytes: completeLength } : {}) };
  }
}
