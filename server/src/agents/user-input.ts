import type { AgentEvent } from '../ports/agent-runner.js';

export const USER_INPUT_REQUEST_KINDS = ['text', 'selection', 'file', 'confirmation'] as const;
export type UserInputRequestKind = typeof USER_INPUT_REQUEST_KINDS[number];

export interface AgentUserInputActor {
  id: string;
  type: 'local' | 'authenticated';
}

export interface UserInputRequest {
  readonly [key: string]: unknown;
  id: string;
  kind: UserInputRequestKind;
  title: string;
  prompt: string;
  sensitive: boolean;
  requestedAt: string;
  expiresAt: string;
  maxAttempts: number;
  options?: readonly string[];
}

export interface PendingUserInputRequest extends UserInputRequest {
  requestedSequence: number;
}

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9@._:-]{0,127}$/;
const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_TTL_MS = 60 * 60_000;

function isAuthorityField(key: string): boolean {
  const compact = key.replace(/[_-]/g, '').toLocaleLowerCase('en-US');
  return ['approval', 'authorization', 'permission', 'capability', 'toolinvocation', 'risk', 'decision']
    .some((prefix) => compact.startsWith(prefix));
}

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > maximum) {
    throw new Error(`user_input_request_${field}_invalid`);
  }
  return value.trim();
}

function isoTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`user_input_request_${field}_invalid`);
  return new Date(value).toISOString();
}

/**
 * Provider questions are converted into a closed, domain-only contract. Any
 * approval-shaped field is rejected instead of being forwarded to a client as
 * an apparent security decision.
 */
export function normalizeUserInputRequest(
  value: Readonly<Record<string, unknown>>,
  now = new Date(),
): UserInputRequest {
  for (const key of Object.keys(value)) {
    if (isAuthorityField(key)) throw new Error('user_input_request_cannot_grant_approval');
  }
  const kind = value.kind;
  if (typeof kind !== 'string' || !(USER_INPUT_REQUEST_KINDS as readonly string[]).includes(kind)) {
    throw new Error('user_input_request_kind_invalid');
  }
  // The provider may supply the field for wire compatibility, but it cannot
  // choose the authoritative server receipt time.
  if (value.requestedAt !== undefined) isoTimestamp(value.requestedAt, 'requested_at');
  const requestedAt = now.toISOString();
  const expiresAt = value.expiresAt === undefined
    ? new Date(now.getTime() + DEFAULT_TTL_MS).toISOString()
    : isoTimestamp(value.expiresAt, 'expires_at');
  if (Date.parse(expiresAt) <= now.getTime() || Date.parse(expiresAt) > now.getTime() + MAX_TTL_MS) {
    throw new Error('user_input_request_expiry_invalid');
  }

  const maxAttempts = value.maxAttempts === undefined ? 3 : value.maxAttempts;
  if (!Number.isSafeInteger(maxAttempts) || Number(maxAttempts) < 1 || Number(maxAttempts) > 10) {
    throw new Error('user_input_request_max_attempts_invalid');
  }

  const request: UserInputRequest = {
    id: requiredText(value.id, 'id', 128),
    kind: kind as UserInputRequestKind,
    title: requiredText(value.title, 'title', 200),
    prompt: requiredText(value.prompt, 'prompt', 4_096),
    // Fail closed: a provider must explicitly mark a question non-sensitive.
    sensitive: value.sensitive !== false,
    requestedAt,
    expiresAt,
    maxAttempts: Number(maxAttempts),
  };
  if (!REQUEST_ID.test(request.id)) throw new Error('user_input_request_id_invalid');

  if (request.kind === 'selection') {
    if (!Array.isArray(value.options) || value.options.length < 1 || value.options.length > 100) {
      throw new Error('user_input_request_options_invalid');
    }
    const options = value.options.map((option) => requiredText(option, 'option', 512));
    if (new Set(options).size !== options.length) throw new Error('user_input_request_options_invalid');
    request.options = options;
  } else if (value.options !== undefined) {
    throw new Error('user_input_request_options_invalid');
  }
  return request;
}

export function assertUserInputActor(actor: AgentUserInputActor): void {
  if (!actor || !ACTOR_ID.test(actor.id) || !['local', 'authenticated'].includes(actor.type)) {
    throw new Error('user_input_actor_invalid');
  }
}

/** The current question is derived from the canonical run sequence, never from a client id. */
export function pendingUserInputRequest(events: readonly AgentEvent[], now = new Date()): PendingUserInputRequest {
  const lastInteraction = [...events].reverse().find((event) =>
    event.kind === 'user_input_requested' || event.kind === 'user_input_received' || event.kind === 'approval_requested');
  if (!lastInteraction || lastInteraction.kind !== 'user_input_requested') {
    if (lastInteraction?.kind === 'approval_requested') throw new Error('user_input_cannot_resolve_approval');
    throw new Error('user_input_request_not_pending');
  }
  const request = normalizeUserInputRequest(lastInteraction.data as Readonly<Record<string, unknown>>, new Date(lastInteraction.timestamp));
  if (Date.parse(request.expiresAt) <= now.getTime()) throw new Error('user_input_request_expired');
  return { ...request, requestedSequence: lastInteraction.sequence };
}

export function validateUserInputAnswer(request: PendingUserInputRequest, input: string, maximumBytes: number): void {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0') || Buffer.byteLength(input, 'utf8') > maximumBytes) {
    throw new Error(`user_input_invalid_or_exceeds_${maximumBytes}_bytes`);
  }
  if (request.kind === 'selection' && !request.options?.includes(input)) throw new Error('user_input_selection_invalid');
  if (request.kind === 'confirmation' && !['confirm', 'cancel'].includes(input)) throw new Error('user_input_confirmation_invalid');
  if (request.kind === 'file' && input.length > 4_096) throw new Error('user_input_file_reference_invalid');
}

/**
 * Per-run exact-value redaction. It intentionally accepts short answers too:
 * over-redaction is safer than leaking a short confirmation or PIN.
 */
export class SensitiveUserInputRedactor {
  private readonly variants: Array<{ value: string; marker: string }> = [];

  add(secret: string): void {
    const marker = '[REDACTED:USER_INPUT]';
    let urlEncoded: string | undefined;
    try { urlEncoded = encodeURIComponent(secret); } catch { /* Invalid UTF-16 still gets exact/base64 redaction. */ }
    const values = [secret, urlEncoded, Buffer.from(secret, 'utf8').toString('base64')];
    for (const value of new Set(values.filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0))) {
      if (!this.variants.some((entry) => entry.value === value)) this.variants.push({ value, marker });
    }
    this.variants.sort((left, right) => right.value.length - left.value.length);
  }

  redact(value: unknown): unknown {
    const seen = new WeakSet<object>();
    const visit = (current: unknown): unknown => {
      if (typeof current === 'string') {
        let output = current;
        for (const variant of this.variants) output = output.split(variant.value).join(variant.marker);
        return output;
      }
      if (current === null || typeof current !== 'object') return current;
      if (seen.has(current)) return '[REDACTED:CYCLE]';
      seen.add(current);
      if (Array.isArray(current)) return current.map(visit);
      return Object.fromEntries(Object.entries(current as Record<string, unknown>).map(([key, entry]) => [key, visit(entry)]));
    };
    return visit(value);
  }
}
