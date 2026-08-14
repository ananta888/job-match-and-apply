import { parameterHash, RunCapabilityAuthority, type ApprovalQueue, type ApprovalRequest } from './agents/security-approval.js';
import {
  AGENT_MCP_TOOL_CATALOG,
  RestrictedAgentMcpFacade,
  type AgentMcpRunScope,
  type ApplicationPipelineProxy,
  type ApplicationReadPort,
  type DomainCommandPort,
  type DomainProposalPort,
  type JobReadPort,
  type JobSearchProxy,
  type McpToolCall,
  type McpToolDescriptor,
  type MessageReadPort,
} from './agents/security-mcp-facade.js';
import { AgentPolicyEngine, type IdentityMode, type SandboxProfile, type ToolPolicyRule } from './agents/security-policy.js';
import { JsonDomainCommandExecutionStore, type DomainCommandExecutionStore } from './agents/domain-command-execution-store.js';
import { createAgentMcpServer, type AgentMcpServer, type AgentMcpToolExecutor } from './agent-mcp-server.js';

export interface RunBoundAgentMcpPorts {
  jobs: JobReadPort;
  applications: ApplicationReadPort;
  messages: MessageReadPort;
  proposals: DomainProposalPort;
  commands: DomainCommandPort;
  applicationPipeline: ApplicationPipelineProxy;
  jobSearch?: JobSearchProxy;
}

export interface RunBoundAgentMcpContext {
  runId: string;
  providerId: string;
  identityMode: IdentityMode;
  sandboxProfile: SandboxProfile;
  allowedTools: readonly string[];
  allowedApplicationCaseIds: readonly string[];
  capabilityTtlMs?: number;
}

export type AgentMcpAuditAction =
  | 'capability_issued'
  | 'capability_revoked'
  | 'approval_requested'
  | 'approval_approved'
  | 'approval_denied'
  | 'tool_allowed'
  | 'tool_denied';

export interface AgentMcpAuditEvent {
  occurredAt: string;
  runId: string;
  providerId: string;
  action: AgentMcpAuditAction;
  toolName?: string;
  applicationCaseId?: string;
  argumentHash?: string;
  sourceReferences?: string[];
  reason?: string;
  approvalRequestId?: string;
}

export interface AgentMcpAuditSink {
  append(event: Readonly<AgentMcpAuditEvent>): void | Promise<void>;
}

export interface RunBoundAgentMcpFactoryOptions {
  context: RunBoundAgentMcpContext;
  ports: RunBoundAgentMcpPorts;
  capabilityAuthority: RunCapabilityAuthority;
  approvalQueue: ApprovalQueue;
  commandExecutionStore?: DomainCommandExecutionStore;
  auditSink?: AgentMcpAuditSink;
  now?: () => Date;
}

export interface RunBoundAgentMcpSession {
  server: AgentMcpServer;
  listTools(): McpToolDescriptor[];
  execute(call: Readonly<Pick<McpToolCall, 'name' | 'arguments'>>): Promise<Awaited<ReturnType<AgentMcpToolExecutor['execute']>>>;
  requestApproval(call: Readonly<Pick<McpToolCall, 'name' | 'arguments'>>): Promise<ApprovalRequest>;
  resolveApproval(requestId: string, decision: 'approve' | 'deny', actor: string): Promise<void>;
  revokeCapability(): Promise<void>;
  auditEvents(): AgentMcpAuditEvent[];
}

interface PendingApprovalContext {
  key: string;
  toolName: string;
  applicationCaseId?: string;
  argumentHash: string;
}

const forbiddenTools = /(?:^|\.)(?:shell|send|submit|login|credential|network)(?:\.|$)/i;
const forbiddenClientAuthorityFields = /(?:approval|capability)(?:Token|Validated)?$/i;
const sourceReferencePattern = /^[a-z][a-z0-9+.-]{1,31}:[A-Za-z0-9][A-Za-z0-9._~:/-]{0,479}$/;

function asArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('mcp_tool_arguments_invalid');
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some((key) => forbiddenClientAuthorityFields.test(key))) throw new Error('mcp_client_authority_bypass');
  return args;
}

function applicationCaseId(args: Readonly<Record<string, unknown>>): string | undefined {
  return typeof args.applicationCaseId === 'string' && args.applicationCaseId.trim() ? args.applicationCaseId : undefined;
}

function approvalTarget(runId: string, caseId: string | undefined): string {
  return caseId ? `application-case:${caseId}` : `run:${runId}`;
}

function approvalKey(toolName: string, target: string, args: unknown): string {
  return `${toolName}\0${target}\0${parameterHash(args)}`;
}

function safeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^(?:mcp|capability|approval|policy)_[a-z0-9_:,.-]+$/i.test(message) ? message.slice(0, 240) : 'mcp_tool_failed';
}

function normalizeSourceReferences(values: readonly string[]): string[] {
  if (values.length > 100) throw new Error('mcp_source_references_invalid');
  const normalized = values.map((value) => {
    if (typeof value !== 'string' || !value || value.length > 2_048 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error('mcp_source_references_invalid');
    }
    // Complex URLs remain traceable without leaking query strings, fragments or
    // credentials into MCP responses and audit events.
    return sourceReferencePattern.test(value) ? value : `source:${parameterHash(value)}`;
  });
  return [...new Set(normalized)];
}

function sanitizeSourceReferencesInData(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeSourceReferencesInData(entry, seen));
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) throw new Error('mcp_tool_result_not_serializable');
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'sourceReference' && typeof entry === 'string') output[key] = normalizeSourceReferences([entry])[0];
    else if (key === 'sourceReferences' && Array.isArray(entry) && entry.every((item) => typeof item === 'string')) {
      output[key] = normalizeSourceReferences(entry);
    } else output[key] = sanitizeSourceReferencesInData(entry, seen);
  }
  seen.delete(value);
  return output;
}

function policyRules(): ToolPolicyRule[] {
  return AGENT_MCP_TOOL_CATALOG.map((tool) => ({
    toolName: tool.name,
    risk: tool.risk,
    actionClass: tool.category,
    requiresApproval: tool.requiresApproval,
    requiresApplicationCaseScope: tool.requiresApplicationCaseScope,
  }));
}

/**
 * Creates the only productive Root-MCP composition. The capability is issued
 * inside this closure and is deliberately absent from all public call shapes.
 */
export function createRunBoundAgentMcpSession(options: RunBoundAgentMcpFactoryOptions): RunBoundAgentMcpSession {
  const now = options.now ?? (() => new Date());
  const descriptors = new Map(AGENT_MCP_TOOL_CATALOG.map((tool) => [tool.name, tool]));
  const allowedTools = [...new Set(options.context.allowedTools)];
  if (!allowedTools.length || allowedTools.some((name) => !descriptors.has(name) || forbiddenTools.test(name))) {
    throw new Error('mcp_run_tool_scope_invalid');
  }
  const allowedCases = [...new Set(options.context.allowedApplicationCaseIds)];
  if (allowedCases.some((id) => !id.trim() || id.length > 256)) throw new Error('mcp_run_case_scope_invalid');

  // The raw bearer value never leaves this factory closure.
  const capability = options.capabilityAuthority.issue({
    runId: options.context.runId,
    providerId: options.context.providerId,
    allowedTools,
    allowedApplicationCaseIds: allowedCases,
    expiresInMs: options.context.capabilityTtlMs,
  });
  const policy = new AgentPolicyEngine(policyRules());
  const facade = new RestrictedAgentMcpFacade(
    policy,
    options.ports.jobs,
    options.ports.applications,
    options.ports.messages,
    options.ports.proposals,
    options.ports.commands,
    options.ports.applicationPipeline,
    options.ports.jobSearch,
    options.approvalQueue,
    options.commandExecutionStore ?? new JsonDomainCommandExecutionStore(),
  );
  const audit: AgentMcpAuditEvent[] = [];
  const pendingApprovals = new Map<string, PendingApprovalContext>();
  const approvedTokens = new Map<string, string>();

  const appendAudit = async (event: Omit<AgentMcpAuditEvent, 'occurredAt' | 'runId' | 'providerId'>): Promise<void> => {
    const complete: AgentMcpAuditEvent = {
      occurredAt: now().toISOString(), runId: options.context.runId, providerId: options.context.providerId, ...event,
    };
    audit.push(structuredClone(complete));
    await options.auditSink?.append(structuredClone(complete));
  };
  const auditReady = appendAudit({ action: 'capability_issued' });

  const verifiedScope = (toolName?: string, caseId?: string): AgentMcpRunScope => {
    const verified = options.capabilityAuthority.verify(capability, {
      runId: options.context.runId,
      providerId: options.context.providerId,
      toolName,
      applicationCaseId: caseId,
    });
    return {
      runId: verified.runId,
      providerId: verified.providerId,
      identityMode: options.context.identityMode,
      sandboxProfile: options.context.sandboxProfile,
      allowedTools: verified.allowedTools,
      allowedApplicationCaseIds: verified.allowedApplicationCaseIds,
      // Even an approved sensitive read receives the masked port view. Approval
      // authorizes access to the minimized record, never an unmasked payload.
      sensitiveReadApproved: false,
    };
  };

  const executor: AgentMcpToolExecutor = {
    async execute(call) {
      let toolName = call.name;
      let caseId: string | undefined;
      let argumentHash: string | undefined;
      try {
        await auditReady;
        const args = asArguments(call.arguments);
        caseId = applicationCaseId(args);
        argumentHash = parameterHash(args);
        const scope = verifiedScope(toolName, caseId);
        const descriptor = descriptors.get(toolName);
        if (!descriptor) throw new Error('mcp_tool_unknown');
        const target = approvalTarget(scope.runId, caseId);
        const key = approvalKey(toolName, target, args);
        const approvalToken = approvedTokens.get(key);
        if (approvalToken) approvedTokens.delete(key);
        const result = await facade.call(scope, { name: toolName, arguments: structuredClone(args), approvalToken });
        const sourceReferences = normalizeSourceReferences(result.sourceReferences);
        await appendAudit({ action: 'tool_allowed', toolName, applicationCaseId: caseId, argumentHash, sourceReferences });
        return { ...result, data: sanitizeSourceReferencesInData(result.data), sourceReferences };
      } catch (error) {
        await appendAudit({ action: 'tool_denied', toolName, applicationCaseId: caseId, argumentHash, reason: safeReason(error) });
        throw new Error(safeReason(error));
      }
    },
  };

  const server = createAgentMcpServer({ executor, toolNames: allowedTools, now });

  return {
    server,
    listTools() { return facade.listTools(verifiedScope()); },
    execute(call) { return executor.execute(call); },
    async requestApproval(call) {
      await auditReady;
      const args = asArguments(call.arguments);
      const caseId = applicationCaseId(args);
      const scope = verifiedScope(call.name, caseId);
      const descriptor = descriptors.get(call.name);
      if (!descriptor || !descriptor.requiresApproval) throw new Error('mcp_approval_not_required');
      const policyDecision = policy.evaluate({
        runId: scope.runId,
        providerId: scope.providerId,
        toolName: descriptor.name,
        actionClass: descriptor.category,
        requestedRisk: descriptor.risk,
        runProfile: scope.sandboxProfile,
        identityMode: scope.identityMode,
        allowedTools: scope.allowedTools,
        allowedApplicationCaseIds: scope.allowedApplicationCaseIds,
        applicationCaseId: caseId,
        hasValidApproval: false,
      });
      if (policyDecision.outcome === 'deny') throw new Error(`mcp_policy_deny:${policyDecision.reasonCodes.join(',')}`);
      if (policyDecision.outcome !== 'requires_approval') throw new Error('mcp_approval_not_required');
      const target = approvalTarget(scope.runId, caseId);
      const key = approvalKey(descriptor.name, target, args);
      if (approvedTokens.has(key) || [...pendingApprovals.values()].some((pending) => pending.key === key)) {
        throw new Error('mcp_approval_already_pending');
      }
      const request = options.approvalQueue.request({
        runId: scope.runId,
        toolName: descriptor.name,
        target,
        parameters: args,
        parameterPreview: { applicationCaseId: caseId ?? null, argumentHash: parameterHash(args) },
        risk: descriptor.risk,
      });
      pendingApprovals.set(request.id, {
        key, toolName: descriptor.name,
        applicationCaseId: caseId, argumentHash: parameterHash(args),
      });
      await appendAudit({
        action: 'approval_requested', toolName: descriptor.name, applicationCaseId: caseId,
        argumentHash: parameterHash(args), approvalRequestId: request.id,
      });
      return request;
    },
    async resolveApproval(requestId, decision, actor) {
      await auditReady;
      const context = pendingApprovals.get(requestId);
      if (!context) throw new Error('mcp_approval_request_not_in_session');
      if (!actor.trim()) throw new Error('mcp_approval_actor_required');
      if (decision === 'approve') {
        const token = options.approvalQueue.approve(requestId, actor);
        approvedTokens.set(context.key, token);
        await appendAudit({
          action: 'approval_approved', toolName: context.toolName, applicationCaseId: context.applicationCaseId,
          argumentHash: context.argumentHash, approvalRequestId: requestId,
        });
      } else {
        options.approvalQueue.deny(requestId, actor);
        await appendAudit({
          action: 'approval_denied', toolName: context.toolName, applicationCaseId: context.applicationCaseId,
          argumentHash: context.argumentHash, approvalRequestId: requestId,
        });
      }
      pendingApprovals.delete(requestId);
    },
    async revokeCapability() {
      await auditReady;
      options.capabilityAuthority.revoke(capability);
      approvedTokens.clear();
      pendingApprovals.clear();
      await appendAudit({ action: 'capability_revoked' });
    },
    auditEvents() { return structuredClone(audit); },
  };
}
