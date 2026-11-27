import { randomBytes } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { ConfigStore } from '../services/config-store.js';
import { MemoryConfigStore } from '../services/config-store.js';
import type { AuditLogger } from '../services/audit-logger.js';
import { JsonLinesAuditLogger, MemoryAuditLogger } from '../services/audit-logger.js';
import type { WorkspaceStore } from '../services/workspace-store.js';
import { JsonWorkspaceStore, MemoryWorkspaceStore } from '../services/workspace-store.js';
import { EncryptedMailVault } from '../services/mail-vault.js';
import type { AgentRun, AgentRunStore, RuntimeTarget } from '../ports/agent-runner.js';
import { APPLICATION_AGENT_WORKFLOWS } from '../agents/application-workflows.js';
import { RunCapabilityAuthority } from '../agents/security-approval.js';
import {
  ApplicationPipelineProofAuthority,
  FileApplicationPipelineProofKeyProvider,
  StaticApplicationPipelineProofKeyProvider
} from '../services/application-pipeline-proof.js';
import { createRunBoundAgentMcpSession } from '../agent-mcp-run-factory.js';
import { createProviderDomainToolBridge } from '../agents/agent-domain-tool-bridge.js';
import { allowedRootDomainTools, providerSupportsRootDomainTools } from '../agents/agent-domain-tool-policy.js';
import { createRunBoundAgentDomainPorts } from '../services/agent-domain-ports.js';
import { VerifiedApplicationArtifactAdoptionPort } from '../services/agent-artifact-adoption.js';
import { ApplicationAgentOrchestrationService, type RevisionBoundGateConfirmation } from '../agents/application-orchestration-service.js';
import { JsonApplicationOrchestrationStore, MemoryApplicationOrchestrationStore } from '../agents/application-orchestration-store.js';
import { LocalApplicationOrchestrationDomain } from '../services/application-orchestration-domain.js';
import { ApplicationStyleProfileStore } from '../services/style-profile.js';
import { SubmoduleCvNormalizationAdapter } from '../adapters/submodule-cv-normalization.js';
import { CvImportService, JsonCvImportRepository } from '../services/cv-imports.js';
import type { CvNormalizationPort } from '../ports/cv-normalization.js';
import { safeDefaultAgentConfigProfile } from '../agents/config-profile-store.js';
import { CvAiStructuringService } from '../services/cv-ai-structuring.js';
import {
  EncryptedCvAiStructuringRunStore, MemoryCvAiStructuringRunStore,
} from '../services/cv-ai-structuring-store.js';
import {
  installationPinSchema, resolveInstallation, AgentApiDependencies,
  ApplicationPipelineApiDependencies, localRuntimeTarget, prepareCvAiWorkspace,
} from './app-support.js';

/**
 * Builds the services, stores and shared helpers every route module closes over. Formerly the
 * preamble of createApp(); route handlers receive it as `ctx`.
 */
export function createAppContext(
  store: ConfigStore,
  audit: AuditLogger | undefined,
  workspace: WorkspaceStore | undefined,
  mailVault: EncryptedMailVault,
  agentApi: AgentApiDependencies,
  applicationPipeline: ApplicationPipelineApiDependencies | undefined,
) {
  audit ??= store instanceof MemoryConfigStore ? new MemoryAuditLogger() : new JsonLinesAuditLogger();
  workspace ??= store instanceof MemoryConfigStore ? new MemoryWorkspaceStore() : new JsonWorkspaceStore();
  applicationPipeline ??= {
    proofAuthority: new ApplicationPipelineProofAuthority(
      store instanceof MemoryConfigStore
        ? new StaticApplicationPipelineProofKeyProvider(randomBytes(32))
        : new FileApplicationPipelineProofKeyProvider()
    ),
    workRoot: resolve(process.cwd(), '..', '.application-work')
  };
  let cvImportService = applicationPipeline.cvImports;
  let cvNormalization: CvNormalizationPort | undefined;
  let cvAiValidation = applicationPipeline.cvAiValidation;
  const cvImports = async () => {
    if (!cvImportService) {
      const config = await store.load();
      const skillRoot = isAbsolute(config.assistant.skillPath)
        ? config.assistant.skillPath : resolve(process.cwd(), '..', config.assistant.skillPath);
      const candidatePath = isAbsolute(config.assistant.candidateProfilePath)
        ? config.assistant.candidateProfilePath : resolve(process.cwd(), '..', config.assistant.candidateProfilePath);
      const stylePath = isAbsolute(config.assistant.styleProfilePath)
        ? config.assistant.styleProfilePath : resolve(process.cwd(), '..', config.assistant.styleProfilePath);
      const adapter = new SubmoduleCvNormalizationAdapter(skillRoot, candidatePath, stylePath);
      cvNormalization = adapter;
      cvAiValidation ??= adapter;
      cvImportService = new CvImportService(
        new JsonCvImportRepository(), cvNormalization,
      );
    }
    return cvImportService;
  };
  let cvAiStructuringService = applicationPipeline.cvAiStructuring;
  let cvAiStructuringPromise: Promise<CvAiStructuringService> | undefined;
  const cvAiStructuring = (): Promise<CvAiStructuringService> => {
    if (cvAiStructuringService) return Promise.resolve(cvAiStructuringService);
    cvAiStructuringPromise ??= (async () => {
      const imports = await cvImports();
      if (!cvAiValidation) {
        throw Object.assign(new Error('CV-KI-Validator ist in dieser Serverkomposition nicht verfügbar.'), { statusCode: 503 });
      }
      const isolatedWorkspace = await prepareCvAiWorkspace(
        applicationPipeline!.workRoot, agentApi.workspaceRoot,
      );
      const deletableStore = agentApi.store as AgentRunStore & {
        deleteRuns?: (runIds: readonly string[]) => Promise<Array<{ runId: string; events: number }>>;
      };
      if (typeof deletableStore.deleteRuns !== 'function') {
        throw Object.assign(new Error('Sichere Löschung temporärer CV-Agentenläufe ist nicht verfügbar.'), { statusCode: 503 });
      }
      cvAiStructuringService = new CvAiStructuringService({
        store: store instanceof MemoryConfigStore
          ? new MemoryCvAiStructuringRunStore()
          : new EncryptedCvAiStructuringRunStore(
            resolve(process.cwd(), '..', '.local-data', 'cv-ai-structuring-runs'),
            resolve(process.cwd(), '..', '.local-data', 'cv-ai-structuring-runs.key'),
          ),
        imports,
        validation: cvAiValidation,
        agentRuns: agentApi.center,
        purger: { deleteRuns: async (runIds) => {
          const deleted = await deletableStore.deleteRuns!(runIds);
          for (const entry of deleted) agentApi.telemetry.forgetRun(entry.runId);
          return deleted;
        } },
        observability: agentApi.observability,
        providers: agentApi.providers,
        configProfiles: agentApi.configProfiles ?? {
          load: async () => ({ profile: safeDefaultAgentConfigProfile(), source: 'primary' as const }),
        },
        workspaceRoot: isolatedWorkspace,
        isEmergencyStopEnabled: () => agentApi.emergencyStop.enabled,
      });
      return cvAiStructuringService;
    })().catch((error) => { cvAiStructuringPromise = undefined; throw error; });
    return cvAiStructuringPromise;
  };
  if (!(store instanceof MemoryConfigStore)) {
    const sweepCvAiRetention = () => {
      void cvAiStructuring().then((service) => service.expireAndPrune()).catch(() => undefined);
    };
    sweepCvAiRetention();
    const retentionTimer = setInterval(sweepCvAiRetention, 5 * 60_000);
    retentionTimer.unref();
  }
  agentApi.artifactAdoption ??= new VerifiedApplicationArtifactAdoptionPort(
    workspace, store, applicationPipeline.proofAuthority, applicationPipeline.workRoot,
  );
  const orchestrationDomain = new LocalApplicationOrchestrationDomain(
    workspace, store, mailVault, applicationPipeline.proofAuthority, applicationPipeline.workRoot, randomBytes(32),
  );
  const orchestrationStore = store instanceof MemoryConfigStore
    ? new MemoryApplicationOrchestrationStore()
    : new JsonApplicationOrchestrationStore(resolve(process.cwd(), '..', '.local-data', 'agent-orchestrations'));
  const orchestrationService = new ApplicationAgentOrchestrationService(
    agentApi.center, agentApi.artifacts, orchestrationStore, orchestrationDomain, orchestrationDomain,
    {
      runPersistenceProtection: store instanceof MemoryConfigStore ? 'ephemeral' : 'encrypted', maxParallelNodes: 2,
      // Same source and same condition the single-run path uses, so a provider
      // that cannot serve root domain tools falls back to prompt context here
      // too instead of failing the node.
      rootDomainToolsAvailable: async (providerId, runtimeTarget) => {
        const status = (await discoverAgentProviders()).find((provider) => provider.id === providerId);
        const capabilities = status?.capabilities;
        return providerSupportsRootDomainTools(providerId, runtimeTarget)
          && Boolean(capabilities && typeof capabilities === 'object'
            && (capabilities as Record<string, unknown>).rootDomainTools === true);
      },
    },
  );
  let styleProfileService: ApplicationStyleProfileStore | undefined;
  const styleProfiles = async (): Promise<ApplicationStyleProfileStore> => {
    if (!styleProfileService) styleProfileService = new ApplicationStyleProfileStore((await store.load()).assistant);
    return styleProfileService;
  };
  const domainCapabilityAuthority = new RunCapabilityAuthority(randomBytes(32));
  const domainPorts = createRunBoundAgentDomainPorts({ workspace, config: store, mailVault });
  agentApi.center.configureDomainToolFactory(({ run, installation, capabilities }) => {
    if (!providerSupportsRootDomainTools(run.provider, installation.runtimeTarget)
      || capabilities.extensions?.dynamicTools !== true) return undefined;
    const allowedTools = allowedRootDomainTools(run.request);
    // A fully materialized workflow deliberately needs no live domain tools.
    // Do not create a run-bound MCP session for that case: the session factory
    // correctly rejects empty scopes, while the provider can run tool-free.
    if (allowedTools.length === 0) return undefined;
    const declared = Array.isArray(run.request.metadata?.requiredRootMcpTools)
      ? run.request.metadata.requiredRootMcpTools.filter((value): value is string => typeof value === 'string') : allowedTools;
    if (JSON.stringify([...declared].sort()) !== JSON.stringify([...allowedTools].sort())) {
      throw new Error('root_domain_tool_scope_mismatch');
    }
    const metadataCases = Array.isArray(run.request.metadata?.allowedApplicationCaseIds)
      ? run.request.metadata.allowedApplicationCaseIds.filter((value): value is string => typeof value === 'string') : [];
    const allowedApplicationCaseIds = [...new Set([
      ...metadataCases,
      ...(run.request.applicationCaseId ? [run.request.applicationCaseId] : []),
    ])];
    const rawIdentityMode = run.request.metadata?.identityMode;
    const identityMode = rawIdentityMode === 'incognito' ? 'incognito' : rawIdentityMode === 'real' ? 'real' : 'none';
    const session = createRunBoundAgentMcpSession({
      context: {
        runId: run.id, providerId: run.provider, identityMode,
        sandboxProfile: run.request.sandbox === 'workspace-write' ? 'workspace_write_offline' : 'read_only_offline',
        allowedTools, allowedApplicationCaseIds,
        capabilityTtlMs: Math.min(24 * 60 * 60_000, (run.request.limits?.wallTimeMs ?? 30 * 60_000) + 5 * 60_000),
      },
      ports: domainPorts,
      capabilityAuthority: domainCapabilityAuthority,
      approvalQueue: agentApi.approvalQueue,
      auditSink: {
        append: async (event) => {
          const correlationId = typeof run.request.metadata?.correlationId === 'string'
            ? run.request.metadata.correlationId : `agent-mcp-${event.runId}`;
          await audit!.write({
            correlationId,
            operation: `agent.mcp.${event.action}`,
            status: event.action === 'tool_denied' || event.action === 'approval_denied' ? 403 : 200,
            category: 'agent_mcp', occurredAt: event.occurredAt,
          });
          await agentApi.observability?.record({
            level: event.action === 'tool_denied' || event.action === 'approval_denied' ? 'warn' : 'info',
            component: 'mcp', operation: event.action, code: 'domain_tool_audit',
            correlationId, runId: event.runId, provider: event.providerId,
          });
        },
      },
    });
    return createProviderDomainToolBridge(session);
  });
  type IdempotentRunEntry =
    | { requestHash: string; pending: Promise<AgentRun>; expiresAt: number }
    | { requestHash: string; runId: string; expiresAt: number };
  const idempotentAgentRuns = new Map<string, IdempotentRunEntry>();
  const pruneIdempotentAgentRuns = (): void => {
    const now = Date.now();
    for (const [key, entry] of idempotentAgentRuns) if (entry.expiresAt <= now) idempotentAgentRuns.delete(key);
    while (idempotentAgentRuns.size > 2_048) {
      const oldest = idempotentAgentRuns.keys().next().value as string | undefined;
      if (!oldest) break;
      idempotentAgentRuns.delete(oldest);
    }
  };

  const loadAgentConfigProfile = async () => {
    if (!agentApi.configProfiles) throw Object.assign(new Error('Agenten-Konfigurationsprofile sind nicht persistent konfiguriert.'), { statusCode: 503 });
    try { return await agentApi.configProfiles.load(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const profile = await agentApi.configProfiles.reset();
      return { profile, source: 'primary' as const };
    }
  };

  type AgentProfileRequest = {
    providerId: string;
    runtimeTarget: Exclude<RuntimeTarget, 'container'>;
    wslDistribution?: string;
    workspaceMode: 'read_only' | 'workspace_write';
    network: boolean;
  };
  const evaluateAgentProfile = async (input: AgentProfileRequest) => {
    if (!agentApi.configProfiles) return { profile: undefined, provider: undefined, blockers: [] as Array<{ code: string; field?: string; message: string }> };
    const profile = (await loadAgentConfigProfile()).profile;
    const provider = profile.providers.find((candidate) => candidate.provider === input.providerId);
    const blockers: Array<{ code: string; field?: string; message: string }> = [];
    if (!provider || !provider.enabled) blockers.push({ code: 'provider_disabled_by_profile', field: 'providerId', message: 'Der Provider ist im aktiven lokalen Sicherheitsprofil deaktiviert.' });
    else {
      if (provider.runtimeTarget !== input.runtimeTarget) blockers.push({ code: 'runtime_blocked_by_profile', field: 'runtimeTarget', message: `Das aktive Profil erlaubt fuer diesen Provider nur ${provider.runtimeTarget}.` });
      if (provider.wslDistribution && provider.wslDistribution !== input.wslDistribution) blockers.push({ code: 'distribution_blocked_by_profile', field: 'wslDistribution', message: 'Die WSL-Distribution stimmt nicht mit dem aktiven Profil ueberein.' });
      if (input.workspaceMode === 'workspace_write' && provider.sandbox !== 'workspace-write') blockers.push({ code: 'workspace_write_blocked_by_profile', field: 'workspaceMode', message: 'Das aktive Profil erlaubt nur einen schreibgeschuetzten Workspace.' });
      if (input.network && provider.network === 'disabled') blockers.push({ code: 'network_blocked_by_profile', field: 'network', message: 'Das aktive Profil erlaubt keinen Agenten-Netzwerkzugriff.' });
    }
    return { profile, provider, blockers };
  };

  const requireAgentProfile = async (input: AgentProfileRequest) => {
    const decision = await evaluateAgentProfile(input);
    if (decision.blockers.length) {
      throw Object.assign(new Error(decision.blockers.map((blocker) => blocker.message).join(' ')), { statusCode: 409 });
    }
    return decision;
  };

  let providerDiscoveryCache: { expiresAt: number; value: AgentProviderView[] } | undefined;

  const providerNames: Record<string, string> = {
    fake: 'Synthetischer Offline-Agent', 'fake-interactive': 'Interaktiver Offline-Agent',
    'codex-exec': 'Codex CLI', opencode: 'OpenCode', 'claude-cli': 'Claude CLI',
    acp: 'Agent Client Protocol',
  };
  const capabilitiesAreExperimental = (capabilities?: { extensions?: Readonly<Record<string, unknown>> }) =>
    capabilities?.extensions?.experimental === true || capabilities?.extensions?.maturity === 'experimental';
  type AgentProviderInstallationView = {
    runtimeTarget: RuntimeTarget; distribution?: string; version?: string;
    adapterVersion?: string; executable: string; support: string; authStatus?: string; note?: string;
  };
  type AgentProviderView = {
    id: string; name: string; available: boolean; version?: string; note?: string;
    transport?: string; authStatus?: string; capabilities?: unknown;
    installations?: AgentProviderInstallationView[];
    experimental?: boolean; fallbackProviderId?: string;
  };
  const discoverAgentProviders = async (refresh = false): Promise<AgentProviderView[]> => {
    if (!refresh && providerDiscoveryCache && providerDiscoveryCache.expiresAt > Date.now()) return providerDiscoveryCache.value;
    const value = await Promise.all(agentApi.providers.map(async (provider) => {
      try {
        const installations = await provider.discover();
        const preferred = installations.find((item) => item.runtimeTarget === localRuntimeTarget() && item.support === 'supported')
          ?? installations.find((item) => item.support === 'supported') ?? installations[0];
        if (!preferred) {
          let experimental = false;
          try {
            experimental = capabilitiesAreExperimental(await provider.capabilities({
              provider: provider.provider, runtimeTarget: localRuntimeTarget(),
              executable: process.execPath, support: 'unavailable',
            }));
          } catch { /* Adapter kann sich ohne Installation nicht beschreiben. */ }
          return {
            id: provider.provider, name: providerNames[provider.provider] ?? provider.provider,
            available: false, experimental,
            note: 'CLI nicht gefunden; es wurde nichts automatisch installiert.',
          };
        }
        const capabilities = preferred.capabilities ?? await provider.capabilities(preferred);
        const available = installations.some((item) => item.support === 'supported');
        return {
          id: provider.provider, name: providerNames[provider.provider] ?? provider.provider, available,
          version: preferred.version, transport: capabilities.protocolVersion, authStatus: preferred.authStatus ?? 'unknown',
          capabilities: {
            interactiveInput: capabilities.interactiveInput, approvals: capabilities.approvals,
            networkControl: capabilities.extensions?.networkControl === true,
            workspaceModes: capabilities.sandboxPolicies.flatMap((policy) => policy === 'read-only' ? ['read_only'] : policy === 'workspace-write' ? ['workspace_write'] : []),
            rootDomainTools: capabilities.extensions?.dynamicTools === true,
          },
          experimental: capabilitiesAreExperimental(capabilities),
          fallbackProviderId: provider.provider === 'codex-exec' ? 'codex-exec' : undefined,
          installations: installations.map((item) => ({
            runtimeTarget: item.runtimeTarget, distribution: item.distribution, version: item.version,
            adapterVersion: item.capabilities?.adapterVersion ?? (item === preferred ? capabilities.adapterVersion : undefined),
            executable: item.runtimeExecutable ?? item.executable,
            support: item.support, authStatus: item.authStatus, note: item.reason ?? item.authNote,
            userApproved: item.userApproved
          })),
          note: available ? (provider.provider === 'fake' ? 'Offline-Testprovider ohne Konto oder Netzwerk.' : `Gefunden auf ${preferred.runtimeTarget}: ${preferred.executable}${preferred.authNote ? ` · ${preferred.authNote}` : ''}`) : preferred.reason
        };
      } catch (error) {
        return { id: provider.provider, name: providerNames[provider.provider] ?? provider.provider, available: false, note: error instanceof Error ? error.message : String(error) };
      }
    }));
    providerDiscoveryCache = { expiresAt: Date.now() + 30_000, value };
    return value;
  };

  const orchestrationCreateSchema = z.object({
    workflowId: z.enum(['guided-job-analysis', 'evidence-application-package', 'employer-response-triage', 'application-next-actions']),
    providerId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    prompt: z.string().min(1).max(64 * 1024),
    runtimeTarget: z.enum(['windows', 'wsl', 'linux', 'darwin']).default(localRuntimeTarget),
    wslDistribution: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
    installation: installationPinSchema.optional(),
    clarifications: z.boolean().optional(),
    applicationCaseId: z.string().uuid().optional(),
    mailId: z.string().uuid().optional(),
    documentRevisionId: z.string().uuid().optional(),
  }).strict();

  const providerForOrchestration = async (
    providerId: string,
    runtimeTarget: RuntimeTarget,
    wslDistribution?: string,
    installationPin?: { version: string; executable: string },
  ) => {
    if (runtimeTarget === 'container') throw Object.assign(new Error('Container-Runtimes sind fuer diese lokale Orchestrierung nicht freigegeben.'), { statusCode: 409 });
    const profileDecision = await requireAgentProfile({
      providerId, runtimeTarget, wslDistribution, workspaceMode: 'read_only', network: false,
    });
    if (profileDecision.profile && !profileDecision.profile.features.multiAgentExperimental) {
      throw Object.assign(new Error('Die suggestion-only Multi-Agent-Kette ist im aktiven lokalen Profil deaktiviert.'), { statusCode: 409 });
    }
    const provider = (await discoverAgentProviders()).find((candidate) => candidate.id === providerId);
    const installation = provider
      ? resolveInstallation(provider.installations ?? [], runtimeTarget, wslDistribution, installationPin)
      : undefined;
    if (!provider || !provider.available || !installation || installation.support !== 'supported') {
      throw Object.assign(new Error(installation?.note ?? provider?.note ?? 'Die Providerinstallation ist nicht freigegeben.'), { statusCode: 409 });
    }
    if (runtimeTarget === 'wsl' && !wslDistribution) throw Object.assign(new Error('Fuer WSL muss die Distribution explizit gewaehlt werden.'), { statusCode: 400 });
    if (installation.authStatus === 'unauthenticated') throw Object.assign(new Error('Der Provider ist nicht authentifiziert.'), { statusCode: 409 });
    return { installation, profile: profileDecision.profile, providerProfile: profileDecision.provider };
  };

  const orchestrationConfirmations = (
    workflowId: string,
    workflowVersion: string,
    applicationCaseId: string,
    applicationCaseRevision: number,
    review: { documentRevisionId: string; expectedSha256: string; confirmed: true } | undefined,
    userInput: { confirmed: true } | undefined,
  ): RevisionBoundGateConfirmation[] => {
    const workflow = APPLICATION_AGENT_WORKFLOWS.find((candidate) => candidate.id === workflowId)!;
    const confirmations: RevisionBoundGateConfirmation[] = [];
    for (const node of workflow.plan('server-validation').nodes) {
      if (node.gates.includes('review_complete') && review) {
        const body = {
          workflowId, workflowVersion, nodeId: node.id, gate: 'review_complete' as const,
          applicationCaseId, applicationCaseRevision,
          documentRevisionId: review.documentRevisionId, documentRevisionSha256: review.expectedSha256,
        };
        confirmations.push({
          nodeId: node.id, gate: body.gate, applicationCaseId, applicationCaseRevision,
          documentRevisionId: body.documentRevisionId, documentRevisionSha256: body.documentRevisionSha256,
          confirmationReference: orchestrationDomain.issueConfirmation(body),
        });
      }
      if (node.gates.includes('user_input') && userInput) {
        const body = {
          workflowId, workflowVersion, nodeId: node.id, gate: 'user_input' as const,
          applicationCaseId, applicationCaseRevision,
        };
        confirmations.push({
          nodeId: node.id, gate: body.gate, applicationCaseId, applicationCaseRevision,
          confirmationReference: orchestrationDomain.issueConfirmation(body),
        });
      }
    }
    return confirmations;
  };

  const artifactIdSchema = z.string().uuid();
  const artifactRun = async (rawRunId: unknown): Promise<AgentRun> => {
    const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).parse(rawRunId);
    const run = await agentApi.center.get(runId);
    if (!run) throw Object.assign(new Error('Agentenlauf nicht gefunden.'), { statusCode: 404 });
    return run;
  };
  const artifactForRun = async (runId: string, rawArtifactId: unknown) => {
    const artifactId = artifactIdSchema.parse(rawArtifactId);
    const artifact = await agentApi.artifacts.get(artifactId);
    if (!artifact || artifact.provenance.runId !== runId) throw Object.assign(new Error('Agentenartefakt nicht gefunden.'), { statusCode: 404 });
    return artifact;
  };

  const hasCvAiStructuringService = (): boolean => cvAiStructuringService !== undefined;
  const invalidateProviderDiscovery = (): void => { providerDiscoveryCache = undefined; };

  return {
    store, audit, workspace, mailVault, agentApi, applicationPipeline, cvImports, cvAiStructuring,
    orchestrationService, styleProfiles, idempotentAgentRuns, pruneIdempotentAgentRuns,
    loadAgentConfigProfile, evaluateAgentProfile, requireAgentProfile, discoverAgentProviders,
    orchestrationCreateSchema, providerForOrchestration, orchestrationConfirmations, artifactRun,
    artifactForRun, hasCvAiStructuringService, invalidateProviderDiscovery,
  };
}

export type AppContext = ReturnType<typeof createAppContext>;
