import { createHash, randomBytes, randomUUID } from 'node:crypto';

const SENSITIVE_KEY_PATTERN = /(?:^|[_-])(authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|access[_-]?key)(?:$|[_-])/i;

export interface RedactionSummary {
  value: unknown;
  replacements: number;
  secretFingerprints: string[];
}

function fingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 12);
}

function encodedVariants(secret: string): string[] {
  const candidates = [secret, encodeURIComponent(secret), Buffer.from(secret, 'utf8').toString('base64')];
  return [...new Set(candidates.filter((candidate) => candidate.length >= 4))].sort((a, b) => b.length - a.length);
}

/** Exact-value redaction for argv, env, events, tool output and crash payloads. */
export class SecretRedactor {
  private readonly variants: Array<{ value: string; marker: string }> = [];
  private readonly fingerprints = new Set<string>();

  constructor(secrets: readonly string[] = []) {
    for (const secret of secrets) this.add(secret);
  }

  add(secret: string): string {
    if (secret.length < 4) throw new Error('redaction_secret_too_short');
    const id = fingerprint(secret);
    this.fingerprints.add(id);
    for (const value of encodedVariants(secret)) {
      if (!this.variants.some((entry) => entry.value === value)) this.variants.push({ value, marker: `[REDACTED:${id}]` });
    }
    this.variants.sort((a, b) => b.value.length - a.value.length);
    return id;
  }

  redactText(text: string): { text: string; replacements: number } {
    let redacted = text;
    let replacements = 0;
    for (const variant of this.variants) {
      if (!redacted.includes(variant.value)) continue;
      const pieces = redacted.split(variant.value);
      replacements += pieces.length - 1;
      redacted = pieces.join(variant.marker);
    }
    return { text: redacted, replacements };
  }

  redact(value: unknown): RedactionSummary {
    let replacements = 0;
    const seen = new WeakSet<object>();
    const visit = (current: unknown, key?: string): unknown => {
      if (key && SENSITIVE_KEY_PATTERN.test(key)) {
        if (current !== undefined) replacements += 1;
        return '[REDACTED:SENSITIVE_FIELD]';
      }
      if (typeof current === 'string') {
        const result = this.redactText(current);
        replacements += result.replacements;
        return result.text;
      }
      if (current === null || typeof current !== 'object') return current;
      if (seen.has(current)) return '[REDACTED:CYCLE]';
      seen.add(current);
      if (Array.isArray(current)) return current.map((entry) => visit(entry));
      const output: Record<string, unknown> = {};
      for (const [entryKey, entryValue] of Object.entries(current as Record<string, unknown>)) {
        output[entryKey] = visit(entryValue, entryKey);
      }
      return output;
    };
    return { value: visit(value), replacements, secretFingerprints: [...this.fingerprints].sort() };
  }
}

export interface CredentialSecretSource {
  readSecret(credentialId: string): Promise<string | undefined>;
}

export interface CredentialHandle {
  handle: string;
  runId: string;
  purpose: string;
  expiresAt: string;
}

interface StoredCredentialHandle extends CredentialHandle {
  credentialId: string;
  consumed: boolean;
}

/** Issues opaque, short-lived, one-use handles; it has no secret-list/export API. */
export class RunCredentialBroker {
  private readonly handles = new Map<string, StoredCredentialHandle>();

  constructor(
    private readonly source: CredentialSecretSource,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  issue(runId: string, credentialId: string, purpose: string, ttlMs = 60_000): CredentialHandle {
    if (!runId || !credentialId || !purpose) throw new Error('credential_handle_context_required');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 10 * 60_000) throw new Error('credential_handle_ttl_invalid');
    const now = this.clock();
    const stored: StoredCredentialHandle = {
      handle: `cred_${randomBytes(32).toString('base64url')}`,
      runId,
      credentialId,
      purpose,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      consumed: false,
    };
    this.handles.set(stored.handle, stored);
    return { handle: stored.handle, runId, purpose, expiresAt: stored.expiresAt };
  }

  async materialize(handle: string, runId: string, purpose: string): Promise<string> {
    const stored = this.handles.get(handle);
    if (!stored) throw new Error('credential_handle_unknown');
    if (stored.consumed) throw new Error('credential_handle_already_used');
    if (stored.runId !== runId || stored.purpose !== purpose) throw new Error('credential_handle_scope_mismatch');
    if (Date.parse(stored.expiresAt) <= this.clock().getTime()) throw new Error('credential_handle_expired');
    const secret = await this.source.readSecret(stored.credentialId);
    if (!secret) throw new Error('credential_unavailable');
    stored.consumed = true;
    return secret;
  }

  revokeRun(runId: string): number {
    let revoked = 0;
    for (const [handle, stored] of this.handles) {
      if (stored.runId === runId) {
        this.handles.delete(handle);
        revoked += 1;
      }
    }
    return revoked;
  }
}

/** Builds a minimal child environment instead of forwarding process.env wholesale. */
export function buildIsolatedEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
  allowedKeys: readonly string[],
  injected: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const key of allowedKeys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('environment_key_invalid');
    if (SENSITIVE_KEY_PATTERN.test(key)) throw new Error(`sensitive_environment_key_not_allowlisted:${key}`);
    const value = sourceEnvironment[key];
    if (value !== undefined) output[key] = value;
  }
  for (const [key, value] of Object.entries(injected)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0')) throw new Error('environment_injection_invalid');
    output[key] = value;
  }
  return output;
}

export type ContentOrigin =
  | 'system_policy'
  | 'user_instruction'
  | 'job_posting'
  | 'employer_email'
  | 'tool_result'
  | 'candidate_evidence'
  | 'application_state'
  | 'search_preference';

export type ContentTrust = 'trusted_instruction' | 'trusted_evidence' | 'untrusted_data' | 'preference_only';

const ORIGIN_TRUST: Record<ContentOrigin, ContentTrust> = {
  system_policy: 'trusted_instruction',
  user_instruction: 'trusted_instruction',
  job_posting: 'untrusted_data',
  employer_email: 'untrusted_data',
  tool_result: 'untrusted_data',
  candidate_evidence: 'trusted_evidence',
  application_state: 'trusted_evidence',
  search_preference: 'preference_only',
};

export interface ContentEnvelope {
  id: string;
  origin: ContentOrigin;
  trust: ContentTrust;
  dataOnly: boolean;
  sourceReference: string;
  applicationCaseId?: string;
  companyId?: string;
  content: string;
  warnings: string[];
}

const INJECTION_SIGNALS: RegExp[] = [
  /ignore (?:all |any )?(?:previous|prior|system) instructions/i,
  /reveal (?:the )?(?:system prompt|secret|credential|api key)/i,
  /(?:approve|authorize|grant) (?:this )?(?:tool|action|request)/i,
  /send (?:all|the) (?:files|data|credentials) to/i,
  /disable (?:the )?(?:sandbox|policy|safety)/i,
];

export function detectInjectionSignals(content: string): string[] {
  const warnings: string[] = [];
  for (const [index, pattern] of INJECTION_SIGNALS.entries()) {
    if (pattern.test(content)) warnings.push(`untrusted_instruction_signal_${index + 1}`);
  }
  return warnings;
}

/** Trust is derived from origin and cannot be supplied by mail/job/tool content. */
export function createContentEnvelope(input: {
  id?: string;
  origin: ContentOrigin;
  sourceReference: string;
  content: string;
  applicationCaseId?: string;
  companyId?: string;
}): ContentEnvelope {
  if (!input.sourceReference.trim()) throw new Error('content_source_reference_required');
  const content = input.content.replace(/\0/g, '').slice(0, 1_000_000);
  const trust = ORIGIN_TRUST[input.origin];
  return {
    id: input.id ?? randomUUID(),
    origin: input.origin,
    trust,
    dataOnly: trust !== 'trusted_instruction',
    sourceReference: input.sourceReference,
    applicationCaseId: input.applicationCaseId,
    companyId: input.companyId,
    content,
    warnings: trust === 'untrusted_data' ? detectInjectionSignals(content) : [],
  };
}

export interface AuthorizationEvidence {
  directUserConfirmation: boolean;
  source: ContentEnvelope;
}

export class UntrustedDataGuard {
  assertMayAuthorize(evidence: AuthorizationEvidence): void {
    if (!evidence.directUserConfirmation || evidence.source.origin !== 'user_instruction' || evidence.source.trust !== 'trusted_instruction') {
      throw new Error('untrusted_content_cannot_authorize_action');
    }
  }

  assertScope(envelope: ContentEnvelope, allowedCaseIds: readonly string[], allowedCompanyIds: readonly string[]): void {
    if (envelope.applicationCaseId && !allowedCaseIds.includes(envelope.applicationCaseId)) {
      throw new Error('content_application_case_out_of_scope');
    }
    if (envelope.companyId && !allowedCompanyIds.includes(envelope.companyId)) {
      throw new Error('content_company_out_of_scope');
    }
  }
}
