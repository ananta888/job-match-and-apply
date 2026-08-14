import { createHash } from 'node:crypto';
import { z } from 'zod';

const MAX_RAW_BYTES = 256 * 1024;
const MAX_RAW_NODES = 4_096;
const MAX_RAW_DEPTH = 16;
const CONTRACT_VERSION = '1.0' as const;

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_REFERENCE_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]{0,31}:[^\s\u0000-\u001f\u007f]{1,223}$/;
const SINGLE_LINE_PATTERN = /^[^\u0000-\u001f\u007f]+$/;
const MULTI_LINE_PATTERN = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+$/;

const FORBIDDEN_FIELD_NAMES = new Set([
  '__proto__', 'prototype', 'constructor',
  'authority', 'authorization', 'approval', 'approved', 'approvaltoken',
  'capability', 'capabilitytoken', 'command', 'commands',
  'action', 'actions', 'execute', 'executed', 'execution',
  'send', 'sent', 'submit', 'submitted',
  'tool', 'tools', 'toolcall', 'toolcalls',
  'calendar', 'calendaraction', 'calendarinvitation', 'acceptinvitation',
  'externalaction', 'sideeffect',
]);

const normalizeFieldName = (value: string): string => value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/g, '');

const safeId = z.string().min(1).max(128).regex(SAFE_ID_PATTERN);
const confidence = z.number().finite().min(0).max(1);
const sourceReference = z.string().min(3).max(256).regex(SOURCE_REFERENCE_PATTERN);
const singleLine = (maximum: number) => z.string().trim().min(1).max(maximum).regex(SINGLE_LINE_PATTERN);
const multiLine = (maximum: number) => z.string().trim().min(1).max(maximum).regex(MULTI_LINE_PATTERN);
const dateTime = z.iso.datetime({ offset: true });
const timeZone = z.string().trim().min(1).max(64).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}, 'invalid_time_zone');

function uniqueArray<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

const sourceReferences = z.array(sourceReference).min(1).max(16)
  .refine(uniqueArray, 'source_references_must_be_unique');

const caseCandidate = z.strictObject({
  caseId: safeId,
  confidence,
  reason: singleLine(800),
  sourceReferences,
  requiredDecision: z.literal('confirm_correlation_or_leave_unassigned'),
});

const appointmentProposal = z.strictObject({
  start: dateTime,
  end: dateTime,
  timeZone,
  location: singleLine(500),
  sourceReferences,
  requiredDecision: z.literal('review_only'),
}).refine((value) => Date.parse(value.end) > Date.parse(value.start), {
  message: 'appointment_end_must_be_after_start',
  path: ['end'],
});

const followUpProposal = z.strictObject({
  dueAt: dateTime,
  timeZone,
  reason: singleLine(800),
  sourceReferences,
  requiredDecision: z.literal('confirm_reminder_or_dismiss'),
});

const replyDraft = z.strictObject({
  subject: singleLine(500),
  body: multiLine(20_000),
  language: z.enum(['de', 'en']),
  sourceReferences,
  requiredDecision: z.literal('review_edit_or_dismiss'),
});

export const EmployerResponseTriageProposalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  classification: z.enum(['interview', 'rejection', 'request', 'info', 'offer', 'other']),
  confidence,
  selectedMailId: safeId,
  sourceReferences,
  caseCandidates: z.array(caseCandidate).max(16),
  appointment: appointmentProposal.optional(),
  followUp: followUpProposal.optional(),
  replyDraft: replyDraft.optional(),
}).superRefine((value, context) => {
  const ids = value.caseCandidates.map((candidate) => candidate.caseId);
  if (!uniqueArray(ids)) context.addIssue({ code: 'custom', message: 'case_candidates_must_be_unique', path: ['caseCandidates'] });
});

const nextActionSuggestion = z.strictObject({
  id: safeId,
  applicationCaseId: safeId,
  kind: z.enum(['follow_up', 'status_review', 'document_review', 'duplicate_warning', 'deadline']),
  title: singleLine(240),
  reason: singleLine(1_200),
  confidence,
  sourceReferences,
  dueAt: dateTime.optional(),
  requiredDecision: z.enum([
    'confirm_reminder_or_dismiss',
    'review_status_or_dismiss',
    'review_document_or_dismiss',
    'review_cases_separately_or_dismiss',
  ]),
});

const nextActionConflict = z.strictObject({
  id: safeId,
  kind: z.enum(['duplicate_application', 'status_disagreement', 'timeline_overlap', 'document_disagreement', 'deadline_collision']),
  applicationCaseIds: z.array(safeId).min(1).max(8).refine(uniqueArray, 'conflict_case_ids_must_be_unique'),
  reason: singleLine(1_200),
  sourceReferences,
  requiredDecision: z.literal('resolve_or_dismiss'),
});

export const ApplicationNextActionsProposalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  companyKey: safeId,
  suggestions: z.array(nextActionSuggestion).max(64),
  conflicts: z.array(nextActionConflict).max(32),
}).superRefine((value, context) => {
  const ids = [...value.suggestions.map((suggestion) => suggestion.id), ...value.conflicts.map((conflict) => conflict.id)];
  if (!uniqueArray(ids)) context.addIssue({ code: 'custom', message: 'proposal_ids_must_be_unique', path: [] });
  const decisions: Record<(typeof value.suggestions)[number]['kind'], (typeof value.suggestions)[number]['requiredDecision']> = {
    follow_up: 'confirm_reminder_or_dismiss',
    status_review: 'review_status_or_dismiss',
    document_review: 'review_document_or_dismiss',
    duplicate_warning: 'review_cases_separately_or_dismiss',
    deadline: 'confirm_reminder_or_dismiss',
  };
  value.suggestions.forEach((suggestion, index) => {
    if (suggestion.requiredDecision !== decisions[suggestion.kind]) {
      context.addIssue({ code: 'custom', message: 'required_decision_kind_mismatch', path: ['suggestions', index, 'requiredDecision'] });
    }
  });
});

export type EmployerResponseTriageProposal = z.infer<typeof EmployerResponseTriageProposalSchema>;
export type ApplicationNextActionsProposal = z.infer<typeof ApplicationNextActionsProposalSchema>;

export interface EmployerResponseTriageProposalScope {
  /** Exact server-selected mail. Agent output cannot switch to another message. */
  selectedMailId: string;
  /** Source reference assigned by the server to the selected untrusted mail. */
  selectedMailSourceReference: string;
  /** All application cases resolved by the server for this workflow invocation. */
  allowedApplicationCaseIds: readonly string[];
  /** References exposed in the server-owned workflow inputs. */
  allowedSourceReferences: readonly string[];
}

export interface ApplicationNextActionsProposalScope {
  /** Exact normalized company grouping resolved by the server. */
  companyKey: string;
  /** Every case in that company grouping and no cases from another grouping. */
  allowedApplicationCaseIds: readonly string[];
  /** References exposed in the server-owned workflow inputs. */
  allowedSourceReferences: readonly string[];
}

export type CanonicalApplicationAgentProposal<T, TContract extends string> = Readonly<{
  contract: TContract;
  contractVersion: typeof CONTRACT_VERSION;
  proposal: T;
  sha256: string;
}>;

export class ApplicationAgentProposalValidationError extends Error {
  constructor(public readonly code: string, public readonly paths: readonly string[] = []) {
    super(code);
    this.name = 'ApplicationAgentProposalValidationError';
  }
}

type CanonicalJson = string | number | boolean | null | CanonicalJson[] | { [key: string]: CanonicalJson };

function canonicalValue(value: unknown): CanonicalJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ApplicationAgentProposalValidationError('proposal_must_be_finite_json');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const result: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalValue((value as Record<string, unknown>)[key]);
    return result;
  }
  throw new ApplicationAgentProposalValidationError('proposal_must_be_json');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertSafeRawJson(value: unknown): void {
  let nodes = 0;
  const active = new Set<object>();
  const visit = (entry: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_RAW_NODES) throw new ApplicationAgentProposalValidationError('proposal_structure_too_large');
    if (depth > MAX_RAW_DEPTH) throw new ApplicationAgentProposalValidationError('proposal_structure_too_deep');
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new ApplicationAgentProposalValidationError('proposal_must_be_finite_json');
      return;
    }
    if (!entry || typeof entry !== 'object') throw new ApplicationAgentProposalValidationError('proposal_must_be_json');
    if (active.has(entry)) throw new ApplicationAgentProposalValidationError('proposal_must_not_be_cyclic');
    const prototype = Object.getPrototypeOf(entry);
    if (!Array.isArray(entry) && prototype !== Object.prototype && prototype !== null) {
      throw new ApplicationAgentProposalValidationError('proposal_must_be_plain_json');
    }
    active.add(entry);
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1);
    } else {
      for (const key of Object.keys(entry)) {
        if (FORBIDDEN_FIELD_NAMES.has(normalizeFieldName(key))) {
          throw new ApplicationAgentProposalValidationError('proposal_action_or_authority_field_forbidden', [key]);
        }
        visit((entry as Record<string, unknown>)[key], depth + 1);
      }
    }
    active.delete(entry);
  };
  visit(value, 0);
}

function decodeRaw(input: unknown): unknown {
  if (typeof input !== 'string') {
    assertSafeRawJson(input);
    return input;
  }
  if (Buffer.byteLength(input, 'utf8') > MAX_RAW_BYTES) {
    throw new ApplicationAgentProposalValidationError('proposal_json_too_large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    throw new ApplicationAgentProposalValidationError('proposal_json_invalid');
  }
  assertSafeRawJson(parsed);
  return parsed;
}

function parseSchema<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(decodeRaw(input));
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.map(String).join('.')).filter(Boolean).sort();
    throw new ApplicationAgentProposalValidationError('proposal_contract_invalid', [...new Set(paths)]);
  }
  return parsed.data;
}

function validateScopeIds(values: readonly string[], field: string, allowEmpty: boolean): Set<string> {
  if ((!allowEmpty && values.length === 0) || values.length > 256 || !uniqueArray(values)) {
    throw new ApplicationAgentProposalValidationError(`proposal_scope_${field}_invalid`);
  }
  for (const value of values) {
    if (!safeId.safeParse(value).success) throw new ApplicationAgentProposalValidationError(`proposal_scope_${field}_invalid`);
  }
  return new Set(values);
}

function validateScopeReferences(values: readonly string[]): Set<string> {
  if (values.length === 0 || values.length > 1_024 || !uniqueArray(values)) {
    throw new ApplicationAgentProposalValidationError('proposal_scope_source_references_invalid');
  }
  for (const value of values) {
    if (!sourceReference.safeParse(value).success) {
      throw new ApplicationAgentProposalValidationError('proposal_scope_source_references_invalid');
    }
  }
  return new Set(values);
}

function flattenEmployerReferences(value: EmployerResponseTriageProposal): string[] {
  return [
    ...value.sourceReferences,
    ...value.caseCandidates.flatMap((candidate) => candidate.sourceReferences),
    ...(value.appointment?.sourceReferences ?? []),
    ...(value.followUp?.sourceReferences ?? []),
    ...(value.replyDraft?.sourceReferences ?? []),
  ];
}

function normalizeEmployerProposal(value: EmployerResponseTriageProposal): EmployerResponseTriageProposal {
  const sortReferences = (references: string[]) => [...references].sort();
  return {
    ...value,
    sourceReferences: sortReferences(value.sourceReferences),
    caseCandidates: value.caseCandidates.map((candidate) => ({
      ...candidate, sourceReferences: sortReferences(candidate.sourceReferences),
    })).sort((left, right) => left.caseId.localeCompare(right.caseId)),
    ...(value.appointment ? { appointment: { ...value.appointment, sourceReferences: sortReferences(value.appointment.sourceReferences) } } : {}),
    ...(value.followUp ? { followUp: { ...value.followUp, sourceReferences: sortReferences(value.followUp.sourceReferences) } } : {}),
    ...(value.replyDraft ? { replyDraft: { ...value.replyDraft, sourceReferences: sortReferences(value.replyDraft.sourceReferences) } } : {}),
  };
}

function flattenNextActionReferences(value: ApplicationNextActionsProposal): string[] {
  return [
    ...value.suggestions.flatMap((suggestion) => suggestion.sourceReferences),
    ...value.conflicts.flatMap((conflict) => conflict.sourceReferences),
  ];
}

function normalizeNextActionsProposal(value: ApplicationNextActionsProposal): ApplicationNextActionsProposal {
  const sortReferences = (references: string[]) => [...references].sort();
  return {
    ...value,
    suggestions: value.suggestions.map((suggestion) => ({
      ...suggestion, sourceReferences: sortReferences(suggestion.sourceReferences),
    })).sort((left, right) => left.applicationCaseId.localeCompare(right.applicationCaseId) || left.id.localeCompare(right.id)),
    conflicts: value.conflicts.map((conflict) => ({
      ...conflict,
      applicationCaseIds: [...conflict.applicationCaseIds].sort(),
      sourceReferences: sortReferences(conflict.sourceReferences),
    })).sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function projection<T, TContract extends string>(
  contract: TContract,
  proposal: T,
): CanonicalApplicationAgentProposal<T, TContract> {
  const immutableProposal = deepFreeze(structuredClone(proposal));
  const unsigned = { contract, contractVersion: CONTRACT_VERSION, proposal: immutableProposal };
  return Object.freeze({
    ...unsigned,
    sha256: createHash('sha256').update(canonicalJson(unsigned), 'utf8').digest('hex'),
  });
}

/** Parses an agent result and binds every identifier/reference to server-owned triage input. */
export function parseEmployerResponseTriageProposal(
  input: unknown,
  scope: Readonly<EmployerResponseTriageProposalScope>,
): EmployerResponseTriageProposal {
  if (!safeId.safeParse(scope.selectedMailId).success || !sourceReference.safeParse(scope.selectedMailSourceReference).success) {
    throw new ApplicationAgentProposalValidationError('proposal_scope_selected_mail_invalid');
  }
  const allowedCases = validateScopeIds(scope.allowedApplicationCaseIds, 'application_cases', true);
  const allowedReferences = validateScopeReferences(scope.allowedSourceReferences);
  if (!allowedReferences.has(scope.selectedMailSourceReference)) {
    throw new ApplicationAgentProposalValidationError('proposal_scope_selected_mail_reference_missing');
  }
  const parsed = parseSchema(EmployerResponseTriageProposalSchema, input);
  if (parsed.selectedMailId !== scope.selectedMailId) {
    throw new ApplicationAgentProposalValidationError('proposal_selected_mail_scope_mismatch', ['selectedMailId']);
  }
  if (!parsed.sourceReferences.includes(scope.selectedMailSourceReference)) {
    throw new ApplicationAgentProposalValidationError('proposal_selected_mail_source_missing', ['sourceReferences']);
  }
  for (const candidate of parsed.caseCandidates) {
    if (!allowedCases.has(candidate.caseId)) {
      throw new ApplicationAgentProposalValidationError('proposal_application_case_scope_mismatch', ['caseCandidates']);
    }
  }
  if (flattenEmployerReferences(parsed).some((reference) => !allowedReferences.has(reference))) {
    throw new ApplicationAgentProposalValidationError('proposal_source_reference_scope_mismatch');
  }
  return normalizeEmployerProposal(parsed);
}

export function projectEmployerResponseTriageProposal(
  input: unknown,
  scope: Readonly<EmployerResponseTriageProposalScope>,
): CanonicalApplicationAgentProposal<EmployerResponseTriageProposal, 'employer-response-triage-proposal'> {
  return projection('employer-response-triage-proposal', parseEmployerResponseTriageProposal(input, scope));
}

/** Parses suggestions only; this contract deliberately contains no execution or approval primitive. */
export function parseApplicationNextActionsProposal(
  input: unknown,
  scope: Readonly<ApplicationNextActionsProposalScope>,
): ApplicationNextActionsProposal {
  if (!safeId.safeParse(scope.companyKey).success) {
    throw new ApplicationAgentProposalValidationError('proposal_scope_company_invalid');
  }
  const allowedCases = validateScopeIds(scope.allowedApplicationCaseIds, 'application_cases', false);
  const allowedReferences = validateScopeReferences(scope.allowedSourceReferences);
  const parsed = parseSchema(ApplicationNextActionsProposalSchema, input);
  if (parsed.companyKey !== scope.companyKey) {
    throw new ApplicationAgentProposalValidationError('proposal_company_scope_mismatch', ['companyKey']);
  }
  const referencedCases = [
    ...parsed.suggestions.map((suggestion) => suggestion.applicationCaseId),
    ...parsed.conflicts.flatMap((conflict) => conflict.applicationCaseIds),
  ];
  if (referencedCases.some((applicationCaseId) => !allowedCases.has(applicationCaseId))) {
    throw new ApplicationAgentProposalValidationError('proposal_application_case_scope_mismatch');
  }
  if (flattenNextActionReferences(parsed).some((reference) => !allowedReferences.has(reference))) {
    throw new ApplicationAgentProposalValidationError('proposal_source_reference_scope_mismatch');
  }
  return normalizeNextActionsProposal(parsed);
}

export function projectApplicationNextActionsProposal(
  input: unknown,
  scope: Readonly<ApplicationNextActionsProposalScope>,
): CanonicalApplicationAgentProposal<ApplicationNextActionsProposal, 'application-next-actions-proposal'> {
  return projection('application-next-actions-proposal', parseApplicationNextActionsProposal(input, scope));
}
