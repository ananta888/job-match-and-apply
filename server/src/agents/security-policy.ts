export const RISK_CLASSES = [
  'read',
  'local_write',
  'sensitive_read',
  'network',
  'external_write',
  'destructive',
] as const;

export type RiskClass = (typeof RISK_CLASSES)[number];
export type ToolActionClass = 'read' | 'propose' | 'confirm' | 'execute';
export type IdentityMode = 'none' | 'real' | 'incognito';
export type SandboxProfile =
  | 'read_only_offline'
  | 'workspace_write_offline'
  | 'workspace_write_limited_network'
  | 'isolated_full';

export type SensitiveOperation =
  | 'finalize_document'
  | 'send_message'
  | 'submit_application'
  | 'mark_artifact_used'
  | 'delete_data';

export interface ToolPolicyRule {
  toolName: string;
  risk: RiskClass;
  actionClass: ToolActionClass;
  allowedProviders?: readonly string[];
  allowedProfiles?: readonly SandboxProfile[];
  requiresApplicationCaseScope?: boolean;
  requiresApproval?: boolean;
  blockedInIncognito?: boolean;
  allowedNetworkDomains?: readonly string[];
  operation?: SensitiveOperation;
}

export interface NetworkGrant {
  domains: readonly string[];
  expiresAt: string;
}

export interface PolicyRequest {
  runId: string;
  providerId: string;
  toolName: string;
  actionClass: ToolActionClass;
  requestedRisk?: RiskClass;
  runProfile: SandboxProfile;
  identityMode: IdentityMode;
  allowedTools: readonly string[];
  allowedApplicationCaseIds: readonly string[];
  applicationCaseId?: string;
  networkDomain?: string;
  networkGrant?: NetworkGrant;
  hasValidApproval?: boolean;
  emergencyStop?: boolean;
  now?: Date;
}

export type PolicyOutcome = 'allow' | 'requires_approval' | 'deny';

export interface PolicyDecision {
  policyVersion: string;
  outcome: PolicyOutcome;
  toolName: string;
  canonicalRisk?: RiskClass;
  actionClass: ToolActionClass;
  reasonCodes: string[];
  explanation: string;
  requiredApproval: boolean;
}

const INCOGNITO_BLOCKED_OPERATIONS = new Set<SensitiveOperation>([
  'finalize_document',
  'send_message',
  'submit_application',
  'mark_artifact_used',
]);

const DEFAULT_APPROVAL_RISKS = new Set<RiskClass>([
  'local_write',
  'sensitive_read',
  'network',
  'external_write',
  'destructive',
]);

const SIDE_EFFECT_RISKS = new Set<RiskClass>([
  'local_write',
  'network',
  'external_write',
  'destructive',
]);

const NETWORK_PROFILES = new Set<SandboxProfile>([
  'workspace_write_limited_network',
  'isolated_full',
]);

const WRITE_PROFILES = new Set<SandboxProfile>([
  'workspace_write_offline',
  'workspace_write_limited_network',
  'isolated_full',
]);

function normalizeDomain(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed || trimmed.length > 253 || trimmed.includes('/') || trimmed.includes(':')) return undefined;
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(trimmed)) return undefined;
  return trimmed;
}

function domainIsGranted(domain: string, domains: readonly string[]): boolean {
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;
  return domains.some((candidate) => normalizeDomain(candidate) === normalized);
}

function explanationFor(codes: readonly string[]): string {
  const safeExplanations: Record<string, string> = {
    unknown_tool: 'Das Werkzeug ist in der lokalen Policy nicht registriert.',
    tool_not_in_run_scope: 'Das Werkzeug ist fuer diesen Lauf nicht freigegeben.',
    risk_mismatch: 'Die angeforderte Risikoklasse entspricht nicht der kanonischen Werkzeugpolicy.',
    action_class_mismatch: 'Der angeforderte Aktionspfad entspricht nicht dem Werkzeugvertrag.',
    provider_not_allowed: 'Der Provider ist fuer dieses Werkzeug nicht freigegeben.',
    profile_not_allowed: 'Das aktive Sandboxprofil ist fuer dieses Werkzeug nicht freigegeben.',
    workspace_write_blocked: 'Das aktive Sandboxprofil erlaubt keine lokalen Schreibzugriffe.',
    network_blocked: 'Das aktive Sandboxprofil erlaubt keinen Netzwerkzugriff.',
    network_target_missing: 'Ein Netzwerkzugriff benoetigt ein explizites Ziel.',
    network_target_not_allowed: 'Das Netzwerkziel ist nicht freigegeben.',
    network_grant_expired: 'Die zeitlich begrenzte Netzwerkfreigabe ist abgelaufen.',
    application_case_scope_missing: 'Das Werkzeug benoetigt einen expliziten Bewerbungsfall.',
    application_case_out_of_scope: 'Der Bewerbungsfall gehoert nicht zum Laufkontext.',
    incognito_external_action_blocked: 'Inkognito-Identitaeten duerfen keine finale oder externe Aktion ausfuehren.',
    emergency_stop: 'Der lokale Emergency Stop blockiert neue Seiteneffekte.',
    approval_required: 'Die Aktion benoetigt eine neue, kontextgebundene Nutzerfreigabe.',
    allowed: 'Die Aktion entspricht der aktuellen lokalen Policy.',
  };
  return codes.map((code) => safeExplanations[code] ?? 'Die Aktion wurde durch eine Sicherheitsregel eingeschraenkt.').join(' ');
}

/**
 * Deterministic, deny-by-default policy evaluation. The caller cannot lower a
 * tool's risk or turn an execute tool into a proposal by changing request data.
 */
export class AgentPolicyEngine {
  readonly policyVersion: string;
  private readonly rules = new Map<string, ToolPolicyRule>();

  constructor(rules: readonly ToolPolicyRule[], policyVersion = '1.0.0') {
    this.policyVersion = policyVersion;
    for (const rule of rules) {
      if (!rule.toolName.trim()) throw new Error('policy_tool_name_required');
      if (this.rules.has(rule.toolName)) throw new Error(`duplicate_policy_rule:${rule.toolName}`);
      this.rules.set(rule.toolName, Object.freeze({ ...rule }));
    }
  }

  evaluate(request: PolicyRequest): PolicyDecision {
    const rule = this.rules.get(request.toolName);
    const denyReasons: string[] = [];
    const now = request.now ?? new Date();

    if (!rule) return this.decision(request, undefined, 'deny', ['unknown_tool'], false);

    if (!request.allowedTools.includes(rule.toolName)) denyReasons.push('tool_not_in_run_scope');
    if (request.requestedRisk && request.requestedRisk !== rule.risk) denyReasons.push('risk_mismatch');
    if (request.actionClass !== rule.actionClass) denyReasons.push('action_class_mismatch');
    if (rule.allowedProviders && !rule.allowedProviders.includes(request.providerId)) denyReasons.push('provider_not_allowed');
    if (rule.allowedProfiles && !rule.allowedProfiles.includes(request.runProfile)) denyReasons.push('profile_not_allowed');

    if (SIDE_EFFECT_RISKS.has(rule.risk) && rule.risk !== 'network' && !WRITE_PROFILES.has(request.runProfile)) {
      denyReasons.push('workspace_write_blocked');
    }

    if (rule.risk === 'network') {
      if (!NETWORK_PROFILES.has(request.runProfile)) denyReasons.push('network_blocked');
      if (!request.networkDomain) {
        denyReasons.push('network_target_missing');
      } else {
        const policyAllowsTarget = domainIsGranted(request.networkDomain, rule.allowedNetworkDomains ?? []);
        const grantAllowsTarget = request.networkGrant
          ? domainIsGranted(request.networkDomain, request.networkGrant.domains)
          : false;
        if (!policyAllowsTarget || !grantAllowsTarget) denyReasons.push('network_target_not_allowed');
      }
      if (!request.networkGrant || Date.parse(request.networkGrant.expiresAt) <= now.getTime()) {
        denyReasons.push('network_grant_expired');
      }
    }

    if (rule.requiresApplicationCaseScope) {
      if (!request.applicationCaseId) denyReasons.push('application_case_scope_missing');
      else if (!request.allowedApplicationCaseIds.includes(request.applicationCaseId)) denyReasons.push('application_case_out_of_scope');
    } else if (request.applicationCaseId && !request.allowedApplicationCaseIds.includes(request.applicationCaseId)) {
      denyReasons.push('application_case_out_of_scope');
    }

    const incognitoBlocked = rule.blockedInIncognito
      || (rule.operation ? INCOGNITO_BLOCKED_OPERATIONS.has(rule.operation) : false)
      || rule.risk === 'external_write';
    if (request.identityMode === 'incognito' && incognitoBlocked) denyReasons.push('incognito_external_action_blocked');

    if (request.emergencyStop && (SIDE_EFFECT_RISKS.has(rule.risk) || rule.actionClass === 'execute')) {
      denyReasons.push('emergency_stop');
    }

    if (denyReasons.length > 0) return this.decision(request, rule, 'deny', [...new Set(denyReasons)], false);

    const approvalRequired = rule.requiresApproval ?? DEFAULT_APPROVAL_RISKS.has(rule.risk);
    if (approvalRequired && !request.hasValidApproval) {
      return this.decision(request, rule, 'requires_approval', ['approval_required'], true);
    }
    return this.decision(request, rule, 'allow', ['allowed'], approvalRequired);
  }

  explain(request: PolicyRequest): PolicyDecision {
    return this.evaluate(request);
  }

  private decision(
    request: PolicyRequest,
    rule: ToolPolicyRule | undefined,
    outcome: PolicyOutcome,
    reasonCodes: string[],
    requiredApproval: boolean,
  ): PolicyDecision {
    return {
      policyVersion: this.policyVersion,
      outcome,
      toolName: request.toolName,
      canonicalRisk: rule?.risk,
      actionClass: rule?.actionClass ?? request.actionClass,
      reasonCodes,
      explanation: explanationFor(reasonCodes),
      requiredApproval,
    };
  }
}

export interface SandboxEnforcement {
  requested: SandboxProfile;
  effective: SandboxProfile;
  workspaceAccess: 'read_only' | 'read_write';
  network: 'none' | 'limited' | 'isolated';
  allowedDomains: readonly string[];
  enforcedBy: string;
}

export interface SandboxBackend {
  readonly id: string;
  enforce(profile: SandboxProfile, allowedDomains: readonly string[]): Promise<SandboxEnforcement | undefined>;
}

const PROFILE_PERMISSIONS: Record<SandboxProfile, { write: boolean; network: number }> = {
  read_only_offline: { write: false, network: 0 },
  workspace_write_offline: { write: true, network: 0 },
  workspace_write_limited_network: { write: true, network: 1 },
  isolated_full: { write: true, network: 2 },
};

/** Blocks startup when the backend cannot prove an equal or stricter policy. */
export async function enforceSandboxProfile(
  backend: SandboxBackend,
  requested: SandboxProfile,
  allowedDomains: readonly string[] = [],
): Promise<SandboxEnforcement> {
  const effective = await backend.enforce(requested, allowedDomains);
  if (!effective) throw new Error(`sandbox_profile_not_enforceable:${requested}`);
  if (effective.requested !== requested) throw new Error('sandbox_request_proof_mismatch');
  const requestedPermissions = PROFILE_PERMISSIONS[requested];
  const effectivePermissions = PROFILE_PERMISSIONS[effective.effective];
  if (effectivePermissions.write && !requestedPermissions.write) throw new Error('sandbox_effective_policy_broader');
  if (effectivePermissions.network > requestedPermissions.network) throw new Error('sandbox_effective_policy_broader');
  if (effective.network !== 'none') {
    const requestedSet = new Set(allowedDomains.map(normalizeDomain).filter((value): value is string => Boolean(value)));
    if (effective.allowedDomains.some((domain) => !requestedSet.has(normalizeDomain(domain) ?? ''))) {
      throw new Error('sandbox_effective_network_broader');
    }
  }
  return effective;
}
