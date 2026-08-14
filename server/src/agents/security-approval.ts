import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RiskClass } from './security-policy.js';

type JsonPrimitive = string | number | boolean | null;
export type CanonicalJson = JsonPrimitive | CanonicalJson[] | { [key: string]: CanonicalJson };

function normalizeJson(value: unknown, seen = new Set<object>()): CanonicalJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('approval_parameters_must_be_finite_json');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('approval_parameters_must_not_be_cyclic');
    seen.add(value);
    const normalized = value.map((entry) => normalizeJson(entry, seen));
    seen.delete(value);
    return normalized;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new Error('approval_parameters_must_not_be_cyclic');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('approval_parameters_must_be_plain_json');
    seen.add(value);
    const record = value as Record<string, unknown>;
    const normalized: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol' || typeof entry === 'bigint') {
        throw new Error('approval_parameters_must_be_json');
      }
      normalized[key] = normalizeJson(entry, seen);
    }
    seen.delete(value);
    return normalized;
  }
  throw new Error('approval_parameters_must_be_json');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function parameterHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('base64url');
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'superseded' | 'revoked' | 'consumed' | 'expired';

export interface ApprovalRequestInput {
  runId: string;
  toolName: string;
  target: string;
  parameters: unknown;
  parameterPreview: unknown;
  diff?: string;
  risk: RiskClass;
  alternatives?: readonly string[];
  expiresInMs?: number;
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  toolName: string;
  target: string;
  parametersHash: string;
  parameterPreview: CanonicalJson;
  diff?: string;
  risk: RiskClass;
  alternatives: string[];
  createdAt: string;
  expiresAt: string;
  status: ApprovalStatus;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNote?: string;
  tokenId?: string;
  supersededBy?: string;
}

interface ApprovalTokenPayload {
  v: 1;
  jti: string;
  requestId: string;
  runId: string;
  toolName: string;
  target: string;
  parametersHash: string;
  risk: RiskClass;
  issuedAt: number;
  expiresAt: number;
}

export interface ApprovalExpectation {
  runId: string;
  toolName: string;
  target: string;
  parameters: unknown;
}

export interface ConsumedApproval {
  requestId: string;
  tokenId: string;
  runId: string;
  toolName: string;
  target: string;
  parametersHash: string;
  risk: RiskClass;
  consumedAt: string;
}

export interface ApprovalAuditEntry {
  requestId: string;
  action: 'requested' | 'approved' | 'denied' | 'edited' | 'revoked' | 'consumed' | 'expired';
  actor: string;
  occurredAt: string;
  tokenId?: string;
}

function cloneRequest(request: ApprovalRequest): ApprovalRequest {
  return structuredClone(request);
}

function canonicalBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : undefined;
}

function base64UrlDecodeJson(encoded: string): ApprovalTokenPayload {
  let raw: unknown;
  try {
    const decoded = canonicalBase64Url(encoded);
    if (!decoded) throw new Error('non_canonical_base64url');
    raw = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw new Error('approval_token_malformed');
  }
  if (!raw || typeof raw !== 'object') throw new Error('approval_token_malformed');
  const value = raw as Partial<ApprovalTokenPayload>;
  if (
    value.v !== 1
    || typeof value.jti !== 'string'
    || typeof value.requestId !== 'string'
    || typeof value.runId !== 'string'
    || typeof value.toolName !== 'string'
    || typeof value.target !== 'string'
    || typeof value.parametersHash !== 'string'
    || typeof value.risk !== 'string'
    || typeof value.issuedAt !== 'number'
    || typeof value.expiresAt !== 'number'
  ) throw new Error('approval_token_malformed');
  return value as ApprovalTokenPayload;
}

/**
 * In-memory approval authority. Persistence adapters can reconstruct requests,
 * but signing keys and raw command parameters never need to be persisted here.
 */
export class ApprovalQueue {
  readonly audit: ApprovalAuditEntry[] = [];
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly revokedTokenIds = new Set<string>();
  private readonly consumedTokenIds = new Set<string>();
  private readonly key: Buffer;

  constructor(
    signingKey: Buffer | string,
    private readonly clock: () => Date = () => new Date(),
    private readonly defaultTtlMs = 5 * 60_000,
  ) {
    this.key = Buffer.isBuffer(signingKey) ? Buffer.from(signingKey) : Buffer.from(signingKey, 'utf8');
    if (this.key.byteLength < 32) throw new Error('approval_signing_key_too_short');
    if (!Number.isSafeInteger(defaultTtlMs) || defaultTtlMs < 1_000 || defaultTtlMs > 60 * 60_000) {
      throw new Error('approval_ttl_out_of_range');
    }
  }

  request(input: ApprovalRequestInput): ApprovalRequest {
    if (!input.runId || !input.toolName || !input.target) throw new Error('approval_context_required');
    const now = this.clock();
    const ttl = input.expiresInMs ?? this.defaultTtlMs;
    if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 60 * 60_000) throw new Error('approval_ttl_out_of_range');
    const request: ApprovalRequest = {
      id: randomUUID(),
      runId: input.runId,
      toolName: input.toolName,
      target: input.target,
      parametersHash: parameterHash(input.parameters),
      parameterPreview: normalizeJson(input.parameterPreview),
      diff: input.diff,
      risk: input.risk,
      alternatives: [...(input.alternatives ?? [])],
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
      status: 'pending',
    };
    this.requests.set(request.id, request);
    this.audit.push({ requestId: request.id, action: 'requested', actor: 'system', occurredAt: request.createdAt });
    return cloneRequest(request);
  }

  list(runId?: string): ApprovalRequest[] {
    const now = this.clock();
    return [...this.requests.values()]
      .filter((request) => !runId || request.runId === runId)
      .map((request) => {
        this.expireIfNecessary(request, now);
        return cloneRequest(request);
      });
  }

  get(requestId: string): ApprovalRequest | undefined {
    const request = this.requests.get(requestId);
    if (!request) return undefined;
    this.expireIfNecessary(request, this.clock());
    return cloneRequest(request);
  }

  approve(requestId: string, actor: string): string {
    const request = this.requirePending(requestId);
    if (!actor.trim()) throw new Error('approval_actor_required');
    const now = this.clock();
    const payload: ApprovalTokenPayload = {
      v: 1,
      jti: randomUUID(),
      requestId: request.id,
      runId: request.runId,
      toolName: request.toolName,
      target: request.target,
      parametersHash: request.parametersHash,
      risk: request.risk,
      issuedAt: now.getTime(),
      expiresAt: Date.parse(request.expiresAt),
    };
    request.status = 'approved';
    request.resolvedAt = now.toISOString();
    request.resolvedBy = actor;
    request.tokenId = payload.jti;
    this.audit.push({ requestId, action: 'approved', actor, occurredAt: now.toISOString(), tokenId: payload.jti });
    return this.sign(payload);
  }

  editAndApprove(
    requestId: string,
    actor: string,
    parameters: unknown,
    parameterPreview: unknown,
    diff?: string,
  ): { request: ApprovalRequest; token: string } {
    const original = this.requirePending(requestId);
    const now = this.clock();
    const remainingTtl = Math.max(1_000, Date.parse(original.expiresAt) - now.getTime());
    const replacement = this.request({
      runId: original.runId,
      toolName: original.toolName,
      target: original.target,
      parameters,
      parameterPreview,
      diff,
      risk: original.risk,
      alternatives: original.alternatives,
      expiresInMs: remainingTtl,
    });
    original.status = 'superseded';
    original.resolvedAt = now.toISOString();
    original.resolvedBy = actor;
    original.supersededBy = replacement.id;
    this.audit.push({ requestId: original.id, action: 'edited', actor, occurredAt: now.toISOString() });
    return { request: replacement, token: this.approve(replacement.id, actor) };
  }

  deny(requestId: string, actor: string, note?: string): ApprovalRequest {
    const request = this.requirePending(requestId);
    const now = this.clock();
    request.status = 'denied';
    request.resolvedAt = now.toISOString();
    request.resolvedBy = actor;
    request.resolutionNote = note;
    this.audit.push({ requestId, action: 'denied', actor, occurredAt: now.toISOString() });
    return cloneRequest(request);
  }

  revoke(requestId: string, actor: string): ApprovalRequest {
    const request = this.requests.get(requestId);
    if (!request) throw new Error('approval_request_not_found');
    this.expireIfNecessary(request, this.clock());
    if (request.status !== 'pending' && request.status !== 'approved') throw new Error(`approval_not_revocable:${request.status}`);
    const now = this.clock();
    request.status = 'revoked';
    request.resolvedAt = now.toISOString();
    request.resolvedBy = actor;
    if (request.tokenId) this.revokedTokenIds.add(request.tokenId);
    this.audit.push({ requestId, action: 'revoked', actor, occurredAt: now.toISOString(), tokenId: request.tokenId });
    return cloneRequest(request);
  }

  revokeAll(actor: string, runId?: string): ApprovalRequest[] {
    if (!actor.trim()) throw new Error('approval_actor_required');
    const revoked: ApprovalRequest[] = [];
    for (const request of this.list(runId)) {
      if (request.status !== 'pending' && request.status !== 'approved') continue;
      revoked.push(this.revoke(request.id, actor));
    }
    return revoked;
  }

  /** Atomically validates and consumes a run/tool/target/parameter-bound token. */
  consume(token: string, expected: ApprovalExpectation): ConsumedApproval {
    const payload = this.verifySignature(token);
    const now = this.clock();
    if (payload.expiresAt <= now.getTime()) throw new Error('approval_token_expired');
    if (this.revokedTokenIds.has(payload.jti)) throw new Error('approval_token_revoked');
    if (this.consumedTokenIds.has(payload.jti)) throw new Error('approval_token_already_used');
    if (payload.runId !== expected.runId) throw new Error('approval_token_run_mismatch');
    if (payload.toolName !== expected.toolName) throw new Error('approval_token_tool_mismatch');
    if (payload.target !== expected.target) throw new Error('approval_token_target_mismatch');
    if (payload.parametersHash !== parameterHash(expected.parameters)) throw new Error('approval_token_parameters_mismatch');

    const request = this.requests.get(payload.requestId);
    if (!request || request.status !== 'approved' || request.tokenId !== payload.jti) {
      throw new Error('approval_token_request_invalid');
    }
    this.consumedTokenIds.add(payload.jti);
    request.status = 'consumed';
    request.resolvedAt = now.toISOString();
    this.audit.push({ requestId: request.id, action: 'consumed', actor: 'system', occurredAt: now.toISOString(), tokenId: payload.jti });
    return {
      requestId: request.id,
      tokenId: payload.jti,
      runId: payload.runId,
      toolName: payload.toolName,
      target: payload.target,
      parametersHash: payload.parametersHash,
      risk: payload.risk,
      consumedAt: now.toISOString(),
    };
  }

  private requirePending(requestId: string): ApprovalRequest {
    const request = this.requests.get(requestId);
    if (!request) throw new Error('approval_request_not_found');
    this.expireIfNecessary(request, this.clock());
    if (request.status !== 'pending') throw new Error(`approval_request_not_pending:${request.status}`);
    return request;
  }

  private expireIfNecessary(request: ApprovalRequest, now: Date): void {
    if ((request.status === 'pending' || request.status === 'approved') && Date.parse(request.expiresAt) <= now.getTime()) {
      request.status = 'expired';
      if (request.tokenId) this.revokedTokenIds.add(request.tokenId);
      this.audit.push({ requestId: request.id, action: 'expired', actor: 'system', occurredAt: now.toISOString(), tokenId: request.tokenId });
    }
  }

  private sign(payload: ApprovalTokenPayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.key).update(body, 'utf8').digest('base64url');
    return `${body}.${signature}`;
  }

  private verifySignature(token: string): ApprovalTokenPayload {
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('approval_token_malformed');
    const expectedSignature = createHmac('sha256', this.key).update(parts[0], 'utf8').digest();
    let actualSignature: Buffer | undefined;
    try {
      actualSignature = canonicalBase64Url(parts[1]);
      if (!actualSignature) throw new Error('non_canonical_base64url');
    } catch {
      throw new Error('approval_token_signature_invalid');
    }
    if (actualSignature.byteLength !== expectedSignature.byteLength || !timingSafeEqual(actualSignature, expectedSignature)) {
      throw new Error('approval_token_signature_invalid');
    }
    return base64UrlDecodeJson(parts[0]);
  }
}

export interface RunCapabilityScope {
  runId: string;
  providerId: string;
  allowedTools: readonly string[];
  allowedApplicationCaseIds: readonly string[];
  issuedAt: string;
  expiresAt: string;
  tokenId: string;
}

interface RunCapabilityPayload {
  v: 1;
  jti: string;
  runId: string;
  providerId: string;
  allowedTools: string[];
  allowedApplicationCaseIds: string[];
  issuedAt: number;
  expiresAt: number;
}

function uniqueSorted(values: readonly string[], field: string): string[] {
  const result = [...new Set(values)];
  if (result.some((value) => !value.trim() || value.length > 256)) throw new Error(`capability_${field}_invalid`);
  return result.sort();
}

/** Signed, revocable bearer scope for the local MCP connection of one run. */
export class RunCapabilityAuthority {
  private readonly key: Buffer;
  private readonly revoked = new Set<string>();

  constructor(signingKey: Buffer | string, private readonly clock: () => Date = () => new Date()) {
    this.key = Buffer.isBuffer(signingKey) ? Buffer.from(signingKey) : Buffer.from(signingKey, 'utf8');
    if (this.key.byteLength < 32) throw new Error('capability_signing_key_too_short');
  }

  issue(input: {
    runId: string;
    providerId: string;
    allowedTools: readonly string[];
    allowedApplicationCaseIds: readonly string[];
    expiresInMs?: number;
  }): string {
    if (!input.runId.trim() || !input.providerId.trim()) throw new Error('capability_context_required');
    const ttl = input.expiresInMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 24 * 60 * 60_000) throw new Error('capability_ttl_out_of_range');
    const now = this.clock();
    const payload: RunCapabilityPayload = {
      v: 1,
      jti: randomUUID(),
      runId: input.runId,
      providerId: input.providerId,
      allowedTools: uniqueSorted(input.allowedTools, 'tools'),
      allowedApplicationCaseIds: uniqueSorted(input.allowedApplicationCaseIds, 'application_cases'),
      issuedAt: now.getTime(),
      expiresAt: now.getTime() + ttl,
    };
    if (payload.allowedTools.length === 0) throw new Error('capability_tools_required');
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.key).update(body, 'utf8').digest('base64url');
    return `${body}.${signature}`;
  }

  verify(token: string, expected: { runId: string; providerId: string; toolName?: string; applicationCaseId?: string }): RunCapabilityScope {
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra !== undefined) throw new Error('capability_token_malformed');
    const expectedSignature = createHmac('sha256', this.key).update(body, 'utf8').digest();
    const actualSignature = canonicalBase64Url(signature);
    if (!actualSignature) throw new Error('capability_token_signature_invalid');
    if (actualSignature.byteLength !== expectedSignature.byteLength || !timingSafeEqual(actualSignature, expectedSignature)) {
      throw new Error('capability_token_signature_invalid');
    }
    let raw: unknown;
    try {
      const decoded = canonicalBase64Url(body);
      if (!decoded) throw new Error('non_canonical_base64url');
      raw = JSON.parse(decoded.toString('utf8'));
    } catch {
      throw new Error('capability_token_malformed');
    }
    const payload = raw as Partial<RunCapabilityPayload>;
    if (
      payload.v !== 1 || typeof payload.jti !== 'string' || typeof payload.runId !== 'string'
      || typeof payload.providerId !== 'string' || !Array.isArray(payload.allowedTools)
      || !payload.allowedTools.every((value) => typeof value === 'string')
      || !Array.isArray(payload.allowedApplicationCaseIds)
      || !payload.allowedApplicationCaseIds.every((value) => typeof value === 'string')
      || typeof payload.issuedAt !== 'number' || typeof payload.expiresAt !== 'number'
    ) throw new Error('capability_token_malformed');
    if (payload.expiresAt <= this.clock().getTime()) throw new Error('capability_token_expired');
    if (this.revoked.has(payload.jti)) throw new Error('capability_token_revoked');
    if (payload.runId !== expected.runId || payload.providerId !== expected.providerId) throw new Error('capability_token_run_scope_mismatch');
    if (expected.toolName && !payload.allowedTools.includes(expected.toolName)) throw new Error('capability_tool_not_allowed');
    if (expected.applicationCaseId && !payload.allowedApplicationCaseIds.includes(expected.applicationCaseId)) {
      throw new Error('capability_application_case_not_allowed');
    }
    return {
      runId: payload.runId,
      providerId: payload.providerId,
      allowedTools: [...payload.allowedTools],
      allowedApplicationCaseIds: [...payload.allowedApplicationCaseIds],
      issuedAt: new Date(payload.issuedAt).toISOString(),
      expiresAt: new Date(payload.expiresAt).toISOString(),
      tokenId: payload.jti,
    };
  }

  revoke(token: string): void {
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra !== undefined) throw new Error('capability_token_malformed');
    const expectedSignature = createHmac('sha256', this.key).update(body, 'utf8').digest();
    const actualSignature = canonicalBase64Url(signature);
    if (!actualSignature) throw new Error('capability_token_signature_invalid');
    if (actualSignature.byteLength !== expectedSignature.byteLength || !timingSafeEqual(actualSignature, expectedSignature)) {
      throw new Error('capability_token_signature_invalid');
    }
    let raw: unknown;
    try {
      const decoded = canonicalBase64Url(body);
      if (!decoded) throw new Error('non_canonical_base64url');
      raw = JSON.parse(decoded.toString('utf8'));
    } catch { throw new Error('capability_token_malformed'); }
    const tokenId = (raw as { jti?: unknown }).jti;
    if (typeof tokenId !== 'string') throw new Error('capability_token_malformed');
    this.revoked.add(tokenId);
  }
}
