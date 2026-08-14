import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from './security-approval.js';
import type { ApprovalExpectation } from './security-approval.js';
import type { AgentPolicyEngine, IdentityMode, RiskClass, SandboxProfile, ToolActionClass } from './security-policy.js';
import {
  domainCommandHash,
  MemoryDomainCommandExecutionStore,
  type DomainCommandExecutionStore,
} from './domain-command-execution-store.js';

export type McpToolCategory = 'read' | 'propose' | 'confirm' | 'execute';

export interface McpToolDescriptor {
  name: string;
  version: string;
  title: string;
  category: McpToolCategory;
  risk: RiskClass;
  description: string;
  externalSideEffect: boolean;
  requiresApproval: boolean;
  requiresApplicationCaseScope: boolean;
  executionMode?: 'proposal_only' | 'confirmable_local';
  inputSchema: Readonly<Record<string, unknown>>;
  outputSchema: Readonly<Record<string, unknown>>;
}

export const AGENT_MCP_TOOL_CATALOG: readonly McpToolDescriptor[] = Object.freeze([
  {
    name: 'jobs.search', version: '1.0.0', title: 'Stellen suchen', category: 'read', risk: 'read',
    description: 'Liest minimierte Stellenlisten ueber den JobSource-Vertrag; fuehrt keine Bewerbung aus.', externalSideEffect: false,
    requiresApproval: false, requiresApplicationCaseScope: false,
    inputSchema: { type: 'object', required: ['profileId', 'page', 'pageSize'] }, outputSchema: { type: 'object', required: ['items', 'page', 'hasMore'] },
  },
  {
    name: 'job_search.capabilities', version: '1.0.0', title: 'Trusted-Host-Jobsuche beschreiben', category: 'read', risk: 'read',
    description: 'Liest ausschliesslich den reduzierten Suchvertrag des Root-seitig gestarteten Job-Search-MCP. Login-, Sitzungs- und Credential-Werkzeuge werden nicht vermittelt.', externalSideEffect: false,
    requiresApproval: false, requiresApplicationCaseScope: false,
    inputSchema: { type: 'object', additionalProperties: false, maxProperties: 0 },
    outputSchema: {
      type: 'object', additionalProperties: false,
      required: ['contract', 'contractVersion', 'upstreamContractVersion', 'compatible', 'executionIsolation', 'allowedOperations', 'sources'],
      properties: {
        contract: { const: 'job-search-root-proxy' },
        contractVersion: { const: '1.0' },
        upstreamContractVersion: { type: 'string', minLength: 1, maxLength: 32 },
        compatible: { const: true },
        executionIsolation: { const: 'trusted-host' },
        allowedOperations: { type: 'array', prefixItems: [{ const: 'capabilities' }, { const: 'search' }], minItems: 2, maxItems: 2 },
        sources: { type: 'array', maxItems: 50, items: { type: 'object' } },
      },
    },
  },
  {
    name: 'job_search.search', version: '1.0.0', title: 'Trusted-Host-Jobsuche ausfuehren', category: 'read', risk: 'read',
    description: 'Durchsucht nur die serverseitig aktive Suchkonfiguration ueber den Trusted-Host-Port und gibt minimierte, paginierte Treffer zurueck.', externalSideEffect: false,
    requiresApproval: false, requiresApplicationCaseScope: false,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['profileId', 'page', 'pageSize'],
      properties: {
        profileId: { const: 'active' },
        page: { type: 'integer', minimum: 0, maximum: 99 },
        pageSize: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    outputSchema: {
      type: 'object', additionalProperties: false,
      required: ['items', 'page', 'pageSize', 'hasMore', 'failures', 'snapshotReference'],
      properties: {
        items: { type: 'array', maxItems: 50, items: { type: 'object' } },
        page: { type: 'integer', minimum: 0, maximum: 99 },
        pageSize: { type: 'integer', minimum: 1, maximum: 50 },
        hasMore: { type: 'boolean' },
        failures: { type: 'array', maxItems: 50, items: { type: 'object' } },
        snapshotReference: { type: 'string', minLength: 1, maxLength: 512 },
      },
    },
  },
  {
    name: 'applications.get', version: '1.0.0', title: 'Bewerbungsfall lesen', category: 'read', risk: 'sensitive_read',
    description: 'Liest einen explizit freigegebenen Bewerbungsfall mit minimierten personenbezogenen Feldern.', externalSideEffect: false,
    requiresApproval: true, requiresApplicationCaseScope: true,
    inputSchema: { type: 'object', required: ['applicationCaseId'] }, outputSchema: { type: 'object', required: ['id', 'revision', 'sourceReferences'] },
  },
  {
    name: 'companies.get', version: '1.0.0', title: 'Firma im Fallkontext lesen', category: 'read', risk: 'sensitive_read',
    description: 'Liest eine minimierte Firmenansicht ausschliesslich aus den fuer den Run freigegebenen Bewerbungsfaellen derselben Firma.', externalSideEffect: false,
    requiresApproval: true, requiresApplicationCaseScope: true,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['applicationCaseId', 'companyId'],
      properties: { applicationCaseId: { type: 'string' }, companyId: { type: 'string' } },
    },
    outputSchema: { type: 'object', required: ['id', 'name', 'version', 'applicationCases', 'sourceReferences'] },
  },
  {
    name: 'application.tracking.list', version: '1.0.0', title: 'Bewerbungsverlauf lesen', category: 'read', risk: 'sensitive_read',
    description: 'Liest paginierte, minimierte Trackingereignisse eines explizit freigegebenen Bewerbungsfalls ohne Notizen oder Mailinhalte.', externalSideEffect: false,
    requiresApproval: true, requiresApplicationCaseScope: true,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['applicationCaseId', 'page', 'pageSize'],
      properties: {
        applicationCaseId: { type: 'string' }, page: { type: 'integer', minimum: 0, maximum: 99 },
        pageSize: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    outputSchema: { type: 'object', required: ['items', 'page', 'pageSize', 'hasMore', 'applicationCaseRevision', 'sourceReferences'] },
  },
  {
    name: 'messages.list', version: '1.0.0', title: 'Nachrichten lesen', category: 'read', risk: 'sensitive_read',
    description: 'Liest reduzierte Nachrichtenmetadaten eines freigegebenen Bewerbungsfalls; Mailinhalt bleibt untrusted.', externalSideEffect: false,
    requiresApproval: true, requiresApplicationCaseScope: true,
    inputSchema: { type: 'object', required: ['applicationCaseId', 'page', 'pageSize'] }, outputSchema: { type: 'object', required: ['items', 'page', 'hasMore'] },
  },
  {
    name: 'application.analyze', version: '1.0.0', title: 'Bewerbung analysieren', category: 'propose', risk: 'read',
    description: 'Ruft die Evidence-basierte Bewerbungsanalyse ueber einen schmalen Submodule-Vertrag auf.', externalSideEffect: false,
    requiresApproval: false, requiresApplicationCaseScope: true,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['applicationCaseId', 'documentType'],
      properties: {
        applicationCaseId: { type: 'string', minLength: 1, maxLength: 256 },
        documentType: { enum: ['cv', 'cover_letter', 'email'] },
      },
    },
    outputSchema: { type: 'object', required: ['proposalId', 'kind', 'payload', 'sourceReferences'] },
  },
  {
    name: 'application.pipeline.audit', version: '1.0.0', title: 'Evidence-Matrix pruefen', category: 'read', risk: 'sensitive_read',
    description: 'Erzeugt Analyse und Match-Matrix ausschliesslich aus dem serverseitig gebundenen Fall und prueft sie gegen das serverseitig konfigurierte Kandidatenprofil. Der Audit kann weder finalisieren noch Claims oder Dateipfade entgegennehmen.',
    externalSideEffect: false, requiresApproval: true, requiresApplicationCaseScope: true,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['applicationCaseId', 'documentType'],
      properties: {
        applicationCaseId: { type: 'string', minLength: 1, maxLength: 256 },
        documentType: { enum: ['cv', 'cover_letter', 'email'] },
      },
    },
    outputSchema: {
      type: 'object', additionalProperties: false,
      required: [
        'contract', 'contractVersion', 'applicationCaseId', 'applicationCaseRevision', 'jobId',
        'documentType', 'upstream', 'sourceVersion', 'jobAnalysis', 'matchMatrix', 'validation', 'finalization',
      ],
      properties: {
        contract: { const: 'application-pipeline-root-proxy' }, contractVersion: { const: '1.0' },
        applicationCaseId: { type: 'string' }, applicationCaseRevision: { type: 'integer', minimum: 0 },
        jobId: { type: 'string' }, documentType: { enum: ['cv', 'cover_letter', 'email'] },
        upstream: { type: 'object' }, sourceVersion: { type: 'object' }, jobAnalysis: { type: 'object' },
        matchMatrix: { type: 'object' }, validation: { type: 'object' }, finalization: { type: 'object' },
      },
    },
  },
  {
    name: 'mail.correlation.propose', version: '1.0.0', title: 'Mailzuordnung vorschlagen', category: 'propose', risk: 'read',
    description: 'Erzeugt nur einen Zuordnungsvorschlag; autoritative Daten bleiben unveraendert.', externalSideEffect: false,
    requiresApproval: false, requiresApplicationCaseScope: true,
    inputSchema: { type: 'object', required: ['applicationCaseId', 'messageId'] }, outputSchema: { type: 'object', required: ['proposalId', 'kind', 'payload', 'sourceReferences'] },
  },
  {
    name: 'application.status.propose', version: '1.0.0', title: 'Status vorschlagen', category: 'propose', risk: 'read',
    description: 'Erzeugt einen Statusvorschlag ohne Domainaenderung.', externalSideEffect: false,
    requiresApproval: false, requiresApplicationCaseScope: true,
    inputSchema: { type: 'object', required: ['applicationCaseId', 'status'] }, outputSchema: { type: 'object', required: ['proposalId', 'kind', 'payload', 'sourceReferences'] },
  },
  {
    name: 'reminder.propose', version: '1.0.0', title: 'Wiedervorlage vorschlagen', category: 'propose', risk: 'read',
    description: 'Erzeugt eine lokale Wiedervorlage nur als Vorschlag; kein Versand und keine Kalenderaktion.', externalSideEffect: false,
    requiresApproval: false, requiresApplicationCaseScope: true,
    inputSchema: { type: 'object', required: ['applicationCaseId', 'dueAt', 'timeZone', 'note'] }, outputSchema: { type: 'object', required: ['proposalId', 'kind', 'payload', 'sourceReferences'] },
  },
  {
    name: 'document.revision.propose', version: '1.0.0', title: 'Dokumentrevision vorschlagen', category: 'propose', risk: 'read',
    description: 'Erzeugt nur eine nicht-autoritative Vorschau. Sie ist nicht bestaetigbar; sichere Uebernahme erfolgt ausschliesslich ueber die serverseitige Artifact-Review- und Bewerbungs-Pipeline.', externalSideEffect: false,
    requiresApproval: false, requiresApplicationCaseScope: true,
    executionMode: 'proposal_only',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['applicationCaseId', 'documentType'],
      properties: {
        applicationCaseId: { type: 'string', minLength: 1, maxLength: 256 },
        documentType: { enum: ['cv', 'cover_letter', 'email'] },
      },
    },
    outputSchema: { type: 'object', required: ['proposalId', 'kind', 'payload', 'sourceReferences'] },
  },
  {
    name: 'domain.command.confirm', version: '1.0.0', title: 'Domaincommand bestaetigen', category: 'confirm', risk: 'local_write',
    description: 'Validiert Vorschlag, erwartete Revision, Idempotency-Key und Freigabe und erzeugt einen ausfuehrbaren Command.', externalSideEffect: false,
    requiresApproval: true, requiresApplicationCaseScope: true,
    executionMode: 'confirmable_local',
    inputSchema: { type: 'object', required: ['applicationCaseId', 'proposalId', 'expectedRevision', 'idempotencyKey'] }, outputSchema: { type: 'object', required: ['commandId', 'dryRun', 'expectedRevision'] },
  },
  {
    name: 'domain.command.execute_local', version: '1.0.0', title: 'Lokalen Domaincommand ausfuehren', category: 'execute', risk: 'local_write',
    description: 'Fuehrt ausschliesslich einen bestaetigten lokalen Domaincommand aus; kein Versand und keine Portalaktion.', externalSideEffect: false,
    requiresApproval: true, requiresApplicationCaseScope: true,
    inputSchema: { type: 'object', required: ['applicationCaseId', 'commandId', 'expectedRevision', 'idempotencyKey'] }, outputSchema: { type: 'object', required: ['commandId', 'revision', 'duplicate'] },
  },
]);

export interface AgentMcpRunScope {
  runId: string;
  providerId: string;
  identityMode: IdentityMode;
  sandboxProfile: SandboxProfile;
  allowedTools: readonly string[];
  allowedApplicationCaseIds: readonly string[];
  sensitiveReadApproved: boolean;
}

export interface MinimizedJob {
  id: string;
  title: string;
  company: string;
  location?: string;
  sourceId: string;
  sourceReference: string;
  version: string;
}

export interface MinimizedApplicationCase {
  id: string;
  revision: number;
  jobId: string;
  companyId: string;
  status: string;
  identityMode: IdentityMode;
  sourceReferences: string[];
  safeSummary?: string;
}

export interface MinimizedCompany {
  id: string;
  name: string;
  version: string;
  applicationCases: Array<{
    id: string;
    jobId: string;
    jobTitle: string;
    status: string;
    revision: number;
    sourceReference: string;
  }>;
  sourceReferences: string[];
}

export interface MinimizedTrackingEvent {
  id: string;
  status: string;
  occurredAt: string;
  source: 'user' | 'portal';
  version: string;
  sourceReference: string;
}

export interface MinimizedMessage {
  id: string;
  applicationCaseId: string;
  receivedAt: string;
  senderDomain: string;
  subject?: string;
  classification?: string;
  contentPreview?: string;
  sourceReference: string;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface JobReadPort {
  search(input: { profileId: string; page: number; pageSize: number }): Promise<Page<MinimizedJob>>;
}

export interface ApplicationReadPort {
  get(applicationCaseId: string, view: 'masked' | 'sensitive'): Promise<MinimizedApplicationCase | undefined>;
  currentRevision(applicationCaseId: string): Promise<number | undefined>;
  getCompany(input: {
    applicationCaseId: string;
    companyId: string;
    allowedApplicationCaseIds: readonly string[];
  }): Promise<MinimizedCompany | undefined>;
  listTracking(input: {
    applicationCaseId: string;
    page: number;
    pageSize: number;
  }): Promise<Page<MinimizedTrackingEvent> & { applicationCaseRevision: number; sourceReferences: string[] }>;
}

export interface MessageReadPort {
  list(input: { applicationCaseId: string; page: number; pageSize: number; view: 'masked' | 'sensitive' }): Promise<Page<MinimizedMessage>>;
}

export interface ApplicationPipelineAuditPayload {
  contract: 'application-pipeline-root-proxy';
  contractVersion: '1.0';
  applicationCaseId: string;
  applicationCaseRevision: number;
  jobId: string;
  documentType: 'cv' | 'cover_letter' | 'email';
  upstream: {
    contract: 'bewerbungs-pipeline';
    contractVersion: string;
    compatible: true;
    networkRequired: false;
  };
  sourceVersion: {
    applicationCaseRevision: number;
    jobSnapshotSha256: string;
    analysisVersion: string;
    analysisSourceSha256: string;
    pipelineContractVersion: string;
  };
  jobAnalysis: Record<string, unknown>;
  matchMatrix: Record<string, unknown>;
  validation: { valid: boolean; errors: string[] };
  finalization: {
    executable: false;
    route: 'approved-artifact-review-adoption';
    proofContract: 'application-pipeline-proof@1.0';
  };
}

export interface ApplicationPipelineProxy {
  analyze(input: { applicationCaseId: string; documentType: 'cv' | 'cover_letter' | 'email' }): Promise<{ payload: unknown; sourceReferences: string[] }>;
  audit(input: { applicationCaseId: string; documentType: 'cv' | 'cover_letter' | 'email' }): Promise<{ payload: unknown; sourceReferences: string[] }>;
  proposeDocumentRevision(input: { applicationCaseId: string; documentType: 'cv' | 'cover_letter' | 'email' }): Promise<{ payload: unknown; sourceReferences: string[] }>;
}

export interface JobSearchProxy {
  capabilities(input: { runId: string }): Promise<unknown>;
  callAllowedTool(input: { name: 'search'; arguments: unknown; runId: string }): Promise<unknown>;
}

export interface DomainProposalPort {
  propose(input: { kind: string; applicationCaseId: string; payload: unknown; runId: string }): Promise<{ payload: unknown; sourceReferences: string[] }>;
}

export interface ConfirmedDomainCommand {
  commandId: string;
  proposalId: string;
  proposalPayloadHash: string;
  applicationCaseId: string;
  expectedRevision: number;
  idempotencyKeySha256: string;
  prepared: PreparedDomainCommand;
  dryRun: unknown;
}

interface PreparedDomainCommandBase {
  applicationCaseId: string;
  proposalId: string;
  proposalPayloadHash: string;
}

export type PreparedDomainCommand =
  | (PreparedDomainCommandBase & { kind: 'application_status'; execution: 'local_write'; from: string; target: string })
  | (PreparedDomainCommandBase & { kind: 'mail_correlation'; execution: 'local_write'; messageId: string })
  | (PreparedDomainCommandBase & {
      kind: 'follow_up_reminder'; execution: 'local_write'; dueAt: string; timeZone: string; note: string;
    })
  | (PreparedDomainCommandBase & {
      kind: 'document_revision'; execution: 'proposal_only'; documentType: 'cv' | 'cover_letter' | 'email';
    });

export interface DomainCommandPreview {
  prepared: PreparedDomainCommand;
  dryRun: unknown;
}

export interface DomainCommandPort {
  preview(input: { proposal: StoredProposal; expectedRevision: number; idempotencyKeySha256: string }): Promise<DomainCommandPreview>;
  execute(input: ConfirmedDomainCommand): Promise<{ revision: number; result: unknown }>;
}

export interface StoredProposal {
  proposalId: string;
  kind: string;
  applicationCaseId: string;
  runId: string;
  payload: unknown;
  payloadHash: string;
  sourceReferences: string[];
  createdAt: string;
}

export interface McpToolCall {
  name: string;
  arguments: unknown;
  approvalToken?: string;
}

export interface ToolApprovalVerifier {
  consume(token: string, expected: ApprovalExpectation): unknown;
}

export interface McpToolResult {
  tool: string;
  category: McpToolCategory;
  data: unknown;
  sourceReferences: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('mcp_tool_arguments_invalid');
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !field.trim()) throw new Error(`mcp_tool_argument_required:${key}`);
  return field;
}

function integerField(value: Record<string, unknown>, key: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const field = value[key];
  if (!Number.isSafeInteger(field) || (field as number) < min || (field as number) > max) throw new Error(`mcp_tool_argument_invalid:${key}`);
  return field as number;
}

function idempotencyKeyField(value: Record<string, unknown>): string {
  const key = stringField(value, 'idempotencyKey');
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) throw new Error('mcp_idempotency_key_invalid');
  return key;
}

function exactArguments(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('mcp_tool_arguments_additional_properties');
}

function exactObject(value: Record<string, unknown>, allowed: readonly string[], code: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(code);
}

function preparedDomainCommand(value: unknown): PreparedDomainCommand {
  const item = asRecord(value);
  const kind = stringField(item, 'kind');
  const applicationCaseId = stringField(item, 'applicationCaseId');
  const proposalId = stringField(item, 'proposalId');
  const proposalPayloadHash = stringField(item, 'proposalPayloadHash');
  if (!/^[A-Za-z0-9_-]{43}$/.test(proposalPayloadHash)) throw new Error('mcp_domain_command_preparation_invalid');
  if (kind === 'application_status') {
    exactObject(item, ['kind', 'execution', 'applicationCaseId', 'proposalId', 'proposalPayloadHash', 'from', 'target'], 'mcp_domain_command_preparation_invalid');
    if (item.execution !== 'local_write') throw new Error('mcp_domain_command_preparation_invalid');
    return {
      kind, execution: 'local_write', applicationCaseId, proposalId, proposalPayloadHash,
      from: stringField(item, 'from'), target: stringField(item, 'target'),
    };
  }
  if (kind === 'mail_correlation') {
    exactObject(item, ['kind', 'execution', 'applicationCaseId', 'proposalId', 'proposalPayloadHash', 'messageId'], 'mcp_domain_command_preparation_invalid');
    if (item.execution !== 'local_write') throw new Error('mcp_domain_command_preparation_invalid');
    return { kind, execution: 'local_write', applicationCaseId, proposalId, proposalPayloadHash, messageId: stringField(item, 'messageId') };
  }
  if (kind === 'follow_up_reminder') {
    exactObject(item, ['kind', 'execution', 'applicationCaseId', 'proposalId', 'proposalPayloadHash', 'dueAt', 'timeZone', 'note'], 'mcp_domain_command_preparation_invalid');
    if (item.execution !== 'local_write') throw new Error('mcp_domain_command_preparation_invalid');
    return {
      kind, execution: 'local_write', applicationCaseId, proposalId, proposalPayloadHash,
      dueAt: stringField(item, 'dueAt'), timeZone: stringField(item, 'timeZone'), note: stringField(item, 'note'),
    };
  }
  if (kind === 'document_revision') {
    exactObject(item, ['kind', 'execution', 'applicationCaseId', 'proposalId', 'proposalPayloadHash', 'documentType'], 'mcp_domain_command_preparation_invalid');
    const documentType = stringField(item, 'documentType');
    if (item.execution !== 'proposal_only' || !['cv', 'cover_letter', 'email'].includes(documentType)) {
      throw new Error('mcp_domain_command_preparation_invalid');
    }
    return {
      kind, execution: 'proposal_only', applicationCaseId, proposalId, proposalPayloadHash,
      documentType: documentType as 'cv' | 'cover_letter' | 'email',
    };
  }
  throw new Error('mcp_domain_command_preparation_invalid');
}

function confirmedDomainCommand(value: unknown): ConfirmedDomainCommand {
  const item = asRecord(value);
  exactObject(item, [
    'commandId', 'proposalId', 'proposalPayloadHash', 'applicationCaseId', 'expectedRevision',
    'idempotencyKeySha256', 'prepared', 'dryRun',
  ], 'mcp_confirmed_command_invalid');
  const prepared = preparedDomainCommand(item.prepared);
  const command: ConfirmedDomainCommand = {
    commandId: stringField(item, 'commandId'),
    proposalId: stringField(item, 'proposalId'),
    proposalPayloadHash: stringField(item, 'proposalPayloadHash'),
    applicationCaseId: stringField(item, 'applicationCaseId'),
    expectedRevision: integerField(item, 'expectedRevision', 0),
    idempotencyKeySha256: stringField(item, 'idempotencyKeySha256'),
    prepared,
    dryRun: structuredClone(item.dryRun),
  };
  if (!/^[a-f0-9]{64}$/.test(command.idempotencyKeySha256)
    || command.proposalId !== prepared.proposalId
    || command.proposalPayloadHash !== prepared.proposalPayloadHash
    || command.applicationCaseId !== prepared.applicationCaseId) {
    throw new Error('mcp_confirmed_command_invalid');
  }
  return command;
}

function safeText(value: unknown, key: string, maxLength: number): string {
  if (typeof value !== 'string' || !value || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`mcp_job_search_result_invalid:${key}`);
  }
  return value;
}

function opaqueJobId(value: unknown): string {
  const id = safeText(value, 'job.id', 71);
  if (!/^job-id:[a-f0-9]{64}$/.test(id)) throw new Error('mcp_job_search_result_invalid:job.id');
  return id;
}

function jobSourceId(value: unknown, key = 'job.sourceId'): string {
  const id = safeText(value, key, 64);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error(`mcp_job_search_result_invalid:${key}`);
  return id;
}

function jobSourceReference(value: unknown, kind: 'job' | 'snapshot'): string {
  const expected = kind === 'job' ? /^job:[a-f0-9]{64}$/ : /^job-search-snapshot:[a-f0-9]{64}$/;
  const reference = safeText(value, kind === 'job' ? 'job.sourceReference' : 'snapshotReference', 84);
  if (!expected.test(reference)) throw new Error(`mcp_job_search_result_invalid:${kind}_reference`);
  return reference;
}

function jobSearchCapabilities(value: unknown): Record<string, unknown> {
  const result = asRecord(value);
  if (result.contract !== 'job-search-root-proxy' || result.contractVersion !== '1.0'
    || result.executionIsolation !== 'trusted-host' || result.compatible !== true) {
    throw new Error('mcp_job_search_capabilities_invalid');
  }
  const allowedOperations = result.allowedOperations;
  if (!Array.isArray(allowedOperations) || allowedOperations.length !== 2
    || allowedOperations[0] !== 'capabilities' || allowedOperations[1] !== 'search') {
    throw new Error('mcp_job_search_capabilities_invalid');
  }
  if (!Array.isArray(result.sources) || result.sources.length > 50) throw new Error('mcp_job_search_capabilities_invalid');
  const sources = result.sources.map((source) => {
    const item = asRecord(source);
    if (typeof item.enabled !== 'boolean' || typeof item.authenticationRequiredForSearch !== 'boolean'
      || typeof item.pagination !== 'boolean' || !Array.isArray(item.filters) || item.filters.length > 20) {
      throw new Error('mcp_job_search_capabilities_invalid');
    }
    return {
      id: jobSourceId(item.id, 'source.id'),
      name: safeText(item.name, 'source.name', 160),
      enabled: item.enabled,
      access: safeText(item.access, 'source.access', 80),
      filters: item.filters.map((filter) => safeText(filter, 'source.filter', 80)),
      pagination: item.pagination,
      policyStatus: safeText(item.policyStatus, 'source.policyStatus', 160),
      authenticationRequiredForSearch: item.authenticationRequiredForSearch,
    };
  });
  return {
    contract: 'job-search-root-proxy', contractVersion: '1.0',
    upstreamContractVersion: safeText(result.upstreamContractVersion, 'upstreamContractVersion', 32),
    compatible: true, executionIsolation: 'trusted-host', allowedOperations: ['capabilities', 'search'], sources,
  };
}

function jobSearchPage(value: unknown, expectedPage: number, expectedPageSize: number): Page<MinimizedJob> & {
  failures: Array<{ sourceId: string; category: string; retryable: boolean }>;
  snapshotReference: string;
} {
  const result = asRecord(value);
  if (result.page !== expectedPage || result.pageSize !== expectedPageSize || typeof result.hasMore !== 'boolean'
    || !Array.isArray(result.items) || result.items.length > expectedPageSize || !Array.isArray(result.failures)
    || result.failures.length > 50) throw new Error('mcp_job_search_result_invalid');
  const items = result.items.map((raw) => {
    const item = asRecord(raw);
    return {
      id: opaqueJobId(item.id),
      title: safeText(item.title, 'job.title', 300),
      company: safeText(item.company, 'job.company', 300),
      ...(item.location === undefined ? {} : { location: safeText(item.location, 'job.location', 300) }),
      sourceId: jobSourceId(item.sourceId),
      sourceReference: jobSourceReference(item.sourceReference, 'job'),
      version: safeText(item.version, 'job.version', 128),
    };
  });
  const failures = result.failures.map((raw) => {
    const failure = asRecord(raw);
    if (typeof failure.retryable !== 'boolean') throw new Error('mcp_job_search_result_invalid:failure.retryable');
    return {
      sourceId: jobSourceId(failure.sourceId, 'failure.sourceId'),
      category: safeText(failure.category, 'failure.category', 64),
      retryable: failure.retryable,
    };
  });
  return {
    items, page: expectedPage, pageSize: expectedPageSize, hasMore: result.hasMore,
    failures, snapshotReference: jobSourceReference(result.snapshotReference, 'snapshot'),
  };
}

const sha256Pattern = /^[a-f0-9]{64}$/;

function pipelineText(value: unknown, key: string, maxLength = 256): string {
  if (typeof value !== 'string' || !value || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`mcp_application_pipeline_audit_invalid:${key}`);
  }
  return value;
}

function pipelineSha256(value: unknown, key: string): string {
  const result = pipelineText(value, key, 64);
  if (!sha256Pattern.test(result)) throw new Error(`mcp_application_pipeline_audit_invalid:${key}`);
  return result;
}

function applicationPipelineAudit(
  value: unknown,
  expectedApplicationCaseId: string,
  expectedDocumentType: 'cv' | 'cover_letter' | 'email',
): ApplicationPipelineAuditPayload {
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 1_048_576) {
    throw new Error('mcp_application_pipeline_audit_invalid:payload_size');
  }
  const result = asRecord(value);
  exactObject(result, [
    'contract', 'contractVersion', 'applicationCaseId', 'applicationCaseRevision', 'jobId', 'documentType',
    'upstream', 'sourceVersion', 'jobAnalysis', 'matchMatrix', 'validation', 'finalization',
  ], 'mcp_application_pipeline_audit_invalid:additional_properties');
  if (result.contract !== 'application-pipeline-root-proxy' || result.contractVersion !== '1.0'
    || result.applicationCaseId !== expectedApplicationCaseId || result.documentType !== expectedDocumentType
    || !Number.isSafeInteger(result.applicationCaseRevision) || (result.applicationCaseRevision as number) < 0) {
    throw new Error('mcp_application_pipeline_audit_invalid:binding');
  }
  const upstream = asRecord(result.upstream);
  exactObject(upstream, ['contract', 'contractVersion', 'compatible', 'networkRequired'], 'mcp_application_pipeline_audit_invalid:upstream');
  const upstreamVersion = pipelineText(upstream.contractVersion, 'upstream.contractVersion', 32);
  if (upstream.contract !== 'bewerbungs-pipeline' || !/^1\./.test(upstreamVersion)
    || upstream.compatible !== true || upstream.networkRequired !== false) {
    throw new Error('mcp_application_pipeline_audit_invalid:upstream');
  }
  const sourceVersion = asRecord(result.sourceVersion);
  exactObject(sourceVersion, [
    'applicationCaseRevision', 'jobSnapshotSha256', 'analysisVersion', 'analysisSourceSha256', 'pipelineContractVersion',
  ], 'mcp_application_pipeline_audit_invalid:source_version');
  const applicationCaseRevision = result.applicationCaseRevision as number;
  const analysisVersion = pipelineText(sourceVersion.analysisVersion, 'sourceVersion.analysisVersion', 64);
  const analysisSourceSha256 = pipelineSha256(sourceVersion.analysisSourceSha256, 'sourceVersion.analysisSourceSha256');
  if (sourceVersion.applicationCaseRevision !== applicationCaseRevision
    || sourceVersion.pipelineContractVersion !== upstreamVersion) {
    throw new Error('mcp_application_pipeline_audit_invalid:source_version');
  }
  const jobAnalysis = asRecord(result.jobAnalysis);
  const matchMatrix = asRecord(result.matchMatrix);
  const analyzedJob = asRecord(jobAnalysis.job);
  if (jobAnalysis.contract !== 'bewerbungs-pipeline' || jobAnalysis.contract_version !== upstreamVersion
    || jobAnalysis.analysis_version !== analysisVersion || jobAnalysis.source_sha256 !== analysisSourceSha256
    || analyzedJob.id !== result.jobId || matchMatrix.contract !== 'bewerbungs-pipeline'
    || matchMatrix.contract_version !== upstreamVersion || !Array.isArray(matchMatrix.matches)) {
    throw new Error('mcp_application_pipeline_audit_invalid:cross_contract_binding');
  }
  const validation = asRecord(result.validation);
  exactObject(validation, ['valid', 'errors'], 'mcp_application_pipeline_audit_invalid:validation');
  if (typeof validation.valid !== 'boolean' || !Array.isArray(validation.errors) || validation.errors.length > 100) {
    throw new Error('mcp_application_pipeline_audit_invalid:validation');
  }
  const errors = validation.errors.map((error) => pipelineText(error, 'validation.errors', 1_000));
  if (validation.valid !== (errors.length === 0)) throw new Error('mcp_application_pipeline_audit_invalid:validation');
  const finalization = asRecord(result.finalization);
  exactObject(finalization, ['executable', 'route', 'proofContract'], 'mcp_application_pipeline_audit_invalid:finalization');
  if (finalization.executable !== false || finalization.route !== 'approved-artifact-review-adoption'
    || finalization.proofContract !== 'application-pipeline-proof@1.0') {
    throw new Error('mcp_application_pipeline_audit_invalid:finalization');
  }
  return {
    contract: 'application-pipeline-root-proxy', contractVersion: '1.0',
    applicationCaseId: expectedApplicationCaseId, applicationCaseRevision,
    jobId: pipelineText(result.jobId, 'jobId', 256), documentType: expectedDocumentType,
    upstream: {
      contract: 'bewerbungs-pipeline', contractVersion: upstreamVersion, compatible: true, networkRequired: false,
    },
    sourceVersion: {
      applicationCaseRevision,
      jobSnapshotSha256: pipelineSha256(sourceVersion.jobSnapshotSha256, 'sourceVersion.jobSnapshotSha256'),
      analysisVersion, analysisSourceSha256, pipelineContractVersion: upstreamVersion,
    },
    jobAnalysis: structuredClone(jobAnalysis), matchMatrix: structuredClone(matchMatrix),
    validation: { valid: validation.valid, errors },
    finalization: {
      executable: false, route: 'approved-artifact-review-adoption', proofContract: 'application-pipeline-proof@1.0',
    },
  };
}

function assertScope(scope: AgentMcpRunScope, applicationCaseId: string): void {
  if (!scope.allowedApplicationCaseIds.includes(applicationCaseId)) throw new Error('mcp_application_case_out_of_scope');
}

/**
 * Narrow provider-neutral domain facade. It deliberately has no send, submit,
 * portal-login, shell or arbitrary-file tool. Proposals never mutate state.
 */
export class RestrictedAgentMcpFacade {
  private readonly catalog = new Map(AGENT_MCP_TOOL_CATALOG.map((tool) => [tool.name, tool]));
  private readonly proposals = new Map<string, StoredProposal>();

  constructor(
    private readonly policy: AgentPolicyEngine,
    private readonly jobs: JobReadPort,
    private readonly applications: ApplicationReadPort,
    private readonly messages: MessageReadPort,
    private readonly proposalPort: DomainProposalPort,
    private readonly commandPort: DomainCommandPort,
    private readonly applicationPipeline: ApplicationPipelineProxy,
    readonly jobSearchProxy?: JobSearchProxy,
    private readonly approvalVerifier?: ToolApprovalVerifier,
    private readonly commandExecutions: DomainCommandExecutionStore = new MemoryDomainCommandExecutionStore(),
  ) {}

  listTools(scope: AgentMcpRunScope): McpToolDescriptor[] {
    return AGENT_MCP_TOOL_CATALOG.filter((tool) => scope.allowedTools.includes(tool.name)).map((tool) => structuredClone(tool));
  }

  async call(scope: AgentMcpRunScope, call: McpToolCall): Promise<McpToolResult> {
    const descriptor = this.catalog.get(call.name);
    if (!descriptor) throw new Error('mcp_tool_unknown');
    const args = asRecord(call.arguments);
    const applicationCaseId = typeof args.applicationCaseId === 'string' ? args.applicationCaseId : undefined;
    const policyRequest = {
      runId: scope.runId,
      providerId: scope.providerId,
      toolName: descriptor.name,
      actionClass: descriptor.category as ToolActionClass,
      requestedRisk: descriptor.risk,
      runProfile: scope.sandboxProfile,
      identityMode: scope.identityMode,
      allowedTools: scope.allowedTools,
      allowedApplicationCaseIds: scope.allowedApplicationCaseIds,
      applicationCaseId,
    } as const;
    // Check all non-approval rules before consuming a one-use approval token.
    const preliminaryDecision = this.policy.evaluate({ ...policyRequest, hasValidApproval: true });
    if (preliminaryDecision.outcome === 'deny') {
      throw new Error(`mcp_policy_deny:${preliminaryDecision.reasonCodes.join(',')}`);
    }
    if (applicationCaseId) assertScope(scope, applicationCaseId);
    let approvalValidated = false;
    if (preliminaryDecision.requiredApproval) {
      if (!call.approvalToken || !this.approvalVerifier) throw new Error('mcp_policy_requires_approval:approval_required');
      this.approvalVerifier.consume(call.approvalToken, {
        runId: scope.runId,
        toolName: descriptor.name,
        target: applicationCaseId ? `application-case:${applicationCaseId}` : `run:${scope.runId}`,
        parameters: args,
      });
      approvalValidated = true;
    } else if (call.approvalToken) {
      throw new Error('mcp_approval_not_required');
    }
    const decision = this.policy.evaluate({ ...policyRequest, hasValidApproval: approvalValidated });
    if (decision.outcome !== 'allow') throw new Error(`mcp_policy_${decision.outcome}:${decision.reasonCodes.join(',')}`);

    switch (call.name) {
      case 'jobs.search': {
        const data = await this.jobs.search({
          profileId: stringField(args, 'profileId'),
          page: integerField(args, 'page', 0),
          pageSize: integerField(args, 'pageSize', 1, 100),
        });
        return { tool: call.name, category: descriptor.category, data, sourceReferences: data.items.map((item) => item.sourceReference) };
      }
      case 'job_search.capabilities': {
        exactArguments(args, []);
        if (!this.jobSearchProxy) throw new Error('mcp_job_search_proxy_unavailable');
        const data = jobSearchCapabilities(await this.jobSearchProxy.capabilities({ runId: scope.runId }));
        return { tool: call.name, category: descriptor.category, data, sourceReferences: [] };
      }
      case 'job_search.search': {
        exactArguments(args, ['profileId', 'page', 'pageSize']);
        if (stringField(args, 'profileId') !== 'active') throw new Error('mcp_job_search_profile_out_of_scope');
        const page = integerField(args, 'page', 0, 99);
        const pageSize = integerField(args, 'pageSize', 1, 50);
        if (!this.jobSearchProxy) throw new Error('mcp_job_search_proxy_unavailable');
        const data = jobSearchPage(await this.jobSearchProxy.callAllowedTool({
          name: 'search', arguments: { profileId: 'active', page, pageSize }, runId: scope.runId,
        }), page, pageSize);
        return {
          tool: call.name, category: descriptor.category, data,
          sourceReferences: [data.snapshotReference, ...data.items.map((item) => item.sourceReference)],
        };
      }
      case 'applications.get': {
        exactArguments(args, ['applicationCaseId']);
        const id = stringField(args, 'applicationCaseId');
        const data = await this.applications.get(id, scope.sensitiveReadApproved ? 'sensitive' : 'masked');
        if (!data) throw new Error('mcp_application_case_not_found');
        return { tool: call.name, category: descriptor.category, data, sourceReferences: data.sourceReferences };
      }
      case 'companies.get': {
        exactArguments(args, ['applicationCaseId', 'companyId']);
        const id = stringField(args, 'applicationCaseId');
        const data = await this.applications.getCompany({
          applicationCaseId: id,
          companyId: stringField(args, 'companyId'),
          allowedApplicationCaseIds: scope.allowedApplicationCaseIds,
        });
        if (!data) throw new Error('mcp_company_not_in_application_scope');
        return { tool: call.name, category: descriptor.category, data, sourceReferences: data.sourceReferences };
      }
      case 'application.tracking.list': {
        exactArguments(args, ['applicationCaseId', 'page', 'pageSize']);
        const id = stringField(args, 'applicationCaseId');
        const data = await this.applications.listTracking({
          applicationCaseId: id,
          page: integerField(args, 'page', 0, 99),
          pageSize: integerField(args, 'pageSize', 1, 50),
        });
        return {
          tool: call.name, category: descriptor.category, data,
          sourceReferences: data.sourceReferences,
        };
      }
      case 'messages.list': {
        const id = stringField(args, 'applicationCaseId');
        const data = await this.messages.list({
          applicationCaseId: id,
          page: integerField(args, 'page', 0),
          pageSize: integerField(args, 'pageSize', 1, 100),
          view: scope.sensitiveReadApproved ? 'sensitive' : 'masked',
        });
        return { tool: call.name, category: descriptor.category, data, sourceReferences: data.items.map((item) => item.sourceReference) };
      }
      case 'application.analyze': {
        exactArguments(args, ['applicationCaseId', 'documentType']);
        const id = stringField(args, 'applicationCaseId');
        const documentType = stringField(args, 'documentType');
        if (!['cv', 'cover_letter', 'email'].includes(documentType)) throw new Error('mcp_document_type_invalid');
        const proposed = await this.applicationPipeline.analyze({ applicationCaseId: id, documentType: documentType as 'cv' | 'cover_letter' | 'email' });
        return this.storeProposal(scope, descriptor, 'application_analysis', id, proposed);
      }
      case 'application.pipeline.audit': {
        exactArguments(args, ['applicationCaseId', 'documentType']);
        const id = stringField(args, 'applicationCaseId');
        const documentType = stringField(args, 'documentType');
        if (!['cv', 'cover_letter', 'email'].includes(documentType)) throw new Error('mcp_document_type_invalid');
        const expectedDocumentType = documentType as 'cv' | 'cover_letter' | 'email';
        const audited = await this.applicationPipeline.audit({ applicationCaseId: id, documentType: expectedDocumentType });
        const data = applicationPipelineAudit(audited.payload, id, expectedDocumentType);
        return {
          tool: call.name, category: descriptor.category, data,
          sourceReferences: [...audited.sourceReferences],
        };
      }
      case 'document.revision.propose': {
        exactArguments(args, ['applicationCaseId', 'documentType']);
        const id = stringField(args, 'applicationCaseId');
        const documentType = stringField(args, 'documentType');
        if (!['cv', 'cover_letter', 'email'].includes(documentType)) throw new Error('mcp_document_type_invalid');
        const proposed = await this.applicationPipeline.proposeDocumentRevision({ applicationCaseId: id, documentType: documentType as 'cv' | 'cover_letter' | 'email' });
        return this.storeProposal(scope, descriptor, 'document_revision', id, proposed);
      }
      case 'mail.correlation.propose':
      case 'application.status.propose':
      case 'reminder.propose': {
        const id = stringField(args, 'applicationCaseId');
        const kind = call.name === 'mail.correlation.propose' ? 'mail_correlation'
          : call.name === 'reminder.propose' ? 'follow_up_reminder' : 'application_status';
        const proposed = await this.proposalPort.propose({ kind, applicationCaseId: id, payload: structuredClone(args), runId: scope.runId });
        return this.storeProposal(scope, descriptor, kind, id, proposed);
      }
      case 'domain.command.confirm': {
        exactArguments(args, ['applicationCaseId', 'proposalId', 'expectedRevision', 'idempotencyKey']);
        const id = stringField(args, 'applicationCaseId');
        const proposalId = stringField(args, 'proposalId');
        const expectedRevision = integerField(args, 'expectedRevision', 0);
        const idempotencyKey = idempotencyKeyField(args);
        const idempotencyKeySha256 = createHash('sha256').update(idempotencyKey, 'utf8').digest('hex');
        const proposal = this.proposals.get(proposalId);
        if (!proposal || proposal.applicationCaseId !== id || proposal.runId !== scope.runId) throw new Error('mcp_proposal_not_in_run_scope');
        if (proposal.kind === 'document_revision') throw new Error('mcp_document_revision_proposal_only_use_artifact_review_api');
        const revision = await this.applications.currentRevision(id);
        if (revision === undefined) throw new Error('mcp_application_case_not_found');
        if (revision !== expectedRevision) throw new Error('mcp_optimistic_concurrency_conflict');
        const preview = await this.commandPort.preview({
          proposal: structuredClone(proposal), expectedRevision, idempotencyKeySha256,
        });
        const prepared = preparedDomainCommand(preview.prepared);
        if (prepared.execution !== 'local_write' || prepared.kind !== proposal.kind
          || prepared.applicationCaseId !== id || prepared.proposalId !== proposalId
          || prepared.proposalPayloadHash !== proposal.payloadHash) {
          throw new Error('mcp_domain_command_preparation_invalid');
        }
        const commandId = `cmd-${createHash('sha256').update(canonicalJson({
          runId: scope.runId, proposalId, proposalPayloadHash: proposal.payloadHash,
          applicationCaseId: id, expectedRevision, idempotencyKeySha256, prepared,
        }), 'utf8').digest('hex')}`;
        const command: ConfirmedDomainCommand = {
          commandId, proposalId, proposalPayloadHash: proposal.payloadHash, applicationCaseId: id,
          expectedRevision, idempotencyKeySha256, prepared, dryRun: structuredClone(preview.dryRun),
        };
        const persisted = await this.commandExecutions.confirm({
          commandId, applicationCaseId: id, expectedRevision, idempotencyKeySha256, command,
        });
        return {
          tool: call.name, category: descriptor.category,
          data: confirmedDomainCommand(persisted.command), sourceReferences: proposal.sourceReferences,
        };
      }
      case 'domain.command.execute_local': {
        exactArguments(args, ['applicationCaseId', 'commandId', 'expectedRevision', 'idempotencyKey']);
        const id = stringField(args, 'applicationCaseId');
        const commandId = stringField(args, 'commandId');
        const expectedRevision = integerField(args, 'expectedRevision', 0);
        const idempotencyKey = idempotencyKeyField(args);
        const idempotencyKeySha256 = createHash('sha256').update(idempotencyKey, 'utf8').digest('hex');
        const claim = await this.commandExecutions.begin({
          commandId, applicationCaseId: id, expectedRevision, idempotencyKeySha256,
        });
        const command = confirmedDomainCommand(claim.record.command);
        if (domainCommandHash(command) !== claim.record.commandSha256
          || command.commandId !== commandId || command.applicationCaseId !== id
          || command.expectedRevision !== expectedRevision || command.idempotencyKeySha256 !== idempotencyKeySha256
          || command.prepared.execution !== 'local_write') {
          throw new Error('mcp_confirmed_command_mismatch');
        }
        if (claim.outcome === 'duplicate') {
          return {
            tool: call.name, category: descriptor.category,
            data: { commandId, revision: claim.result.revision, result: claim.result.result, duplicate: true },
            sourceReferences: [],
          };
        }
        try {
          const revision = await this.applications.currentRevision(id);
          if (!claim.resumed && revision !== expectedRevision) throw new Error('mcp_optimistic_concurrency_conflict');
          const result = await this.commandPort.execute(structuredClone(command));
          await this.commandExecutions.complete({ idempotencyKeySha256, leaseToken: claim.leaseToken, result });
          return {
            tool: call.name, category: descriptor.category,
            data: { commandId, revision: result.revision, result: result.result, duplicate: false }, sourceReferences: [],
          };
        } catch (error) {
          await this.commandExecutions.abandon({ idempotencyKeySha256, leaseToken: claim.leaseToken });
          throw error;
        }
      }
      default:
        throw new Error('mcp_tool_not_implemented');
    }
  }

  private storeProposal(
    scope: AgentMcpRunScope,
    descriptor: McpToolDescriptor,
    kind: string,
    applicationCaseId: string,
    proposed: { payload: unknown; sourceReferences: string[] },
  ): McpToolResult {
    const proposal: StoredProposal = {
      proposalId: randomUUID(),
      kind,
      applicationCaseId,
      runId: scope.runId,
      payload: structuredClone(proposed.payload),
      payloadHash: createHash('sha256').update(canonicalJson(proposed.payload), 'utf8').digest('base64url'),
      sourceReferences: [...proposed.sourceReferences],
      createdAt: new Date().toISOString(),
    };
    this.proposals.set(proposal.proposalId, proposal);
    return { tool: descriptor.name, category: descriptor.category, data: structuredClone(proposal), sourceReferences: proposal.sourceReferences };
  }
}
