import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from './security-approval.js';
import type { ApprovalExpectation } from './security-approval.js';
import type { AgentPolicyEngine, IdentityMode, RiskClass, SandboxProfile, ToolActionClass } from './security-policy.js';

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
    name: 'applications.get', version: '1.0.0', title: 'Bewerbungsfall lesen', category: 'read', risk: 'sensitive_read',
    description: 'Liest einen explizit freigegebenen Bewerbungsfall mit minimierten personenbezogenen Feldern.', externalSideEffect: false,
    requiresApproval: true, requiresApplicationCaseScope: true,
    inputSchema: { type: 'object', required: ['applicationCaseId'] }, outputSchema: { type: 'object', required: ['id', 'revision', 'sourceReferences'] },
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
    inputSchema: { type: 'object', required: ['applicationCaseId', 'documentType'] }, outputSchema: { type: 'object', required: ['proposalId', 'kind', 'payload', 'sourceReferences'] },
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
    name: 'document.revision.propose', version: '1.0.0', title: 'Dokumentrevision vorschlagen', category: 'propose', risk: 'read',
    description: 'Erzeugt nur einen pipelinegeprueften Entwurf; keine Finalisierung und kein Versand.', externalSideEffect: false,
    requiresApproval: false, requiresApplicationCaseScope: true,
    inputSchema: { type: 'object', required: ['applicationCaseId', 'documentType'] }, outputSchema: { type: 'object', required: ['proposalId', 'kind', 'payload', 'sourceReferences'] },
  },
  {
    name: 'domain.command.confirm', version: '1.0.0', title: 'Domaincommand bestaetigen', category: 'confirm', risk: 'local_write',
    description: 'Validiert Vorschlag, erwartete Revision, Idempotency-Key und Freigabe und erzeugt einen ausfuehrbaren Command.', externalSideEffect: false,
    requiresApproval: true, requiresApplicationCaseScope: true,
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
}

export interface MessageReadPort {
  list(input: { applicationCaseId: string; page: number; pageSize: number; view: 'masked' | 'sensitive' }): Promise<Page<MinimizedMessage>>;
}

export interface ApplicationPipelineProxy {
  analyze(input: { applicationCaseId: string; documentType: 'cv' | 'cover_letter' | 'email' }): Promise<{ payload: unknown; sourceReferences: string[] }>;
  proposeDocumentRevision(input: { applicationCaseId: string; documentType: 'cv' | 'cover_letter' | 'email' }): Promise<{ payload: unknown; sourceReferences: string[] }>;
}

export interface JobSearchProxy {
  capabilities(): Promise<unknown>;
  callAllowedTool(input: { name: string; arguments: unknown; runId: string }): Promise<unknown>;
}

export interface DomainProposalPort {
  propose(input: { kind: string; applicationCaseId: string; payload: unknown; runId: string }): Promise<{ payload: unknown; sourceReferences: string[] }>;
}

export interface ConfirmedDomainCommand {
  commandId: string;
  proposalId: string;
  applicationCaseId: string;
  expectedRevision: number;
  idempotencyKey: string;
  dryRun: unknown;
}

export interface DomainCommandPort {
  preview(input: { proposal: StoredProposal; expectedRevision: number; idempotencyKey: string }): Promise<unknown>;
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
  private readonly commands = new Map<string, ConfirmedDomainCommand>();
  private readonly idempotencyResults = new Map<string, {
    commandId: string;
    applicationCaseId: string;
    expectedRevision: number;
    revision: number;
    result: unknown;
  }>();

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
      case 'applications.get': {
        const id = stringField(args, 'applicationCaseId');
        const data = await this.applications.get(id, scope.sensitiveReadApproved ? 'sensitive' : 'masked');
        if (!data) throw new Error('mcp_application_case_not_found');
        return { tool: call.name, category: descriptor.category, data, sourceReferences: data.sourceReferences };
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
        const id = stringField(args, 'applicationCaseId');
        const documentType = stringField(args, 'documentType');
        if (!['cv', 'cover_letter', 'email'].includes(documentType)) throw new Error('mcp_document_type_invalid');
        const proposed = await this.applicationPipeline.analyze({ applicationCaseId: id, documentType: documentType as 'cv' | 'cover_letter' | 'email' });
        return this.storeProposal(scope, descriptor, 'application_analysis', id, proposed);
      }
      case 'document.revision.propose': {
        const id = stringField(args, 'applicationCaseId');
        const documentType = stringField(args, 'documentType');
        if (!['cv', 'cover_letter', 'email'].includes(documentType)) throw new Error('mcp_document_type_invalid');
        const proposed = await this.applicationPipeline.proposeDocumentRevision({ applicationCaseId: id, documentType: documentType as 'cv' | 'cover_letter' | 'email' });
        return this.storeProposal(scope, descriptor, 'document_revision', id, proposed);
      }
      case 'mail.correlation.propose':
      case 'application.status.propose': {
        const id = stringField(args, 'applicationCaseId');
        const kind = call.name === 'mail.correlation.propose' ? 'mail_correlation' : 'application_status';
        const proposed = await this.proposalPort.propose({ kind, applicationCaseId: id, payload: structuredClone(args), runId: scope.runId });
        return this.storeProposal(scope, descriptor, kind, id, proposed);
      }
      case 'domain.command.confirm': {
        const id = stringField(args, 'applicationCaseId');
        const proposalId = stringField(args, 'proposalId');
        const expectedRevision = integerField(args, 'expectedRevision', 0);
        const idempotencyKey = stringField(args, 'idempotencyKey');
        const proposal = this.proposals.get(proposalId);
        if (!proposal || proposal.applicationCaseId !== id || proposal.runId !== scope.runId) throw new Error('mcp_proposal_not_in_run_scope');
        const revision = await this.applications.currentRevision(id);
        if (revision === undefined) throw new Error('mcp_application_case_not_found');
        if (revision !== expectedRevision) throw new Error('mcp_optimistic_concurrency_conflict');
        const dryRun = await this.commandPort.preview({ proposal: structuredClone(proposal), expectedRevision, idempotencyKey });
        const command: ConfirmedDomainCommand = { commandId: randomUUID(), proposalId, applicationCaseId: id, expectedRevision, idempotencyKey, dryRun };
        this.commands.set(command.commandId, command);
        return { tool: call.name, category: descriptor.category, data: structuredClone(command), sourceReferences: proposal.sourceReferences };
      }
      case 'domain.command.execute_local': {
        const id = stringField(args, 'applicationCaseId');
        const commandId = stringField(args, 'commandId');
        const expectedRevision = integerField(args, 'expectedRevision', 0);
        const idempotencyKey = stringField(args, 'idempotencyKey');
        const existing = this.idempotencyResults.get(idempotencyKey);
        if (existing) {
          if (existing.commandId !== commandId || existing.applicationCaseId !== id || existing.expectedRevision !== expectedRevision) {
            throw new Error('mcp_idempotency_key_reused_for_different_command');
          }
          return { tool: call.name, category: descriptor.category, data: { commandId, revision: existing.revision, result: existing.result, duplicate: true }, sourceReferences: [] };
        }
        const command = this.commands.get(commandId);
        if (!command || command.applicationCaseId !== id || command.expectedRevision !== expectedRevision || command.idempotencyKey !== idempotencyKey) {
          throw new Error('mcp_confirmed_command_mismatch');
        }
        const revision = await this.applications.currentRevision(id);
        if (revision !== expectedRevision) throw new Error('mcp_optimistic_concurrency_conflict');
        const result = await this.commandPort.execute(structuredClone(command));
        this.idempotencyResults.set(idempotencyKey, { commandId, applicationCaseId: id, expectedRevision, ...structuredClone(result) });
        this.commands.delete(commandId);
        return { tool: call.name, category: descriptor.category, data: { commandId, revision: result.revision, result: result.result, duplicate: false }, sourceReferences: [] };
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
