import { createHash } from 'node:crypto';
import type { AgentProviderInstallation, AgentRun } from '../ports/agent-runner.js';
import type { AgentQueueDiagnostics, AgentRecoveryDiagnostic } from './agent-control-center.js';
import type { AgentTelemetrySnapshot } from './telemetry.js';

export interface AgentSupportBundleInput {
  appVersion: string;
  generatedAt?: Date;
  providers: readonly { id: string; available: boolean; installations?: readonly AgentProviderInstallation[] }[];
  runs: readonly AgentRun[];
  queue: AgentQueueDiagnostics;
  recovery: readonly AgentRecoveryDiagnostic[];
  telemetry: AgentTelemetrySnapshot;
  features: { realtimeWebSocket: boolean };
  jobSearchMcp: {
    mode: 'demo' | 'stdio';
    executionIsolation: 'trusted-host';
    runtimeStatus: 'demo' | 'configured_not_probed' | 'diagnose_required';
  };
}

export interface AgentSupportBundle {
  contract: 'agent-support-bundle';
  contractVersion: '1.0';
  redacted: true;
  generatedAt: string;
  payload: Readonly<Record<string, unknown>>;
  sha256: string;
}

function canonical(value: unknown): string {
  const sort = (input: unknown): unknown => Array.isArray(input) ? input.map(sort)
    : input && typeof input === 'object'
      ? Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sort(item)]))
      : input;
  return JSON.stringify(sort(value));
}

function opaque(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function safeCode(value: string | undefined): string | undefined {
  return value && /^[a-z][a-z0-9_.:-]{0,127}$/i.test(value) ? value : value ? 'redacted_error' : undefined;
}

/** Creates an allowlist-based bundle; raw configuration and event payloads are never traversed. */
export function createAgentSupportBundle(input: AgentSupportBundleInput): AgentSupportBundle {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(input.appVersion)) throw new Error('support_bundle_app_version_invalid');
  if (input.jobSearchMcp.executionIsolation !== 'trusted-host') throw new Error('support_bundle_job_mcp_boundary_invalid');
  const payload = {
    appVersion: input.appVersion,
    features: { ...input.features },
    jobSearchMcp: { ...input.jobSearchMcp },
    providers: input.providers.map((provider) => ({
      id: provider.id,
      available: provider.available,
      installations: (provider.installations ?? []).map((installation) => ({
        runtimeTarget: installation.runtimeTarget,
        distribution: installation.distribution,
        version: installation.version,
        support: installation.support,
        authStatus: installation.authStatus,
        reasonCode: safeCode(installation.reason)
      }))
    })),
    runs: input.runs.map((run) => ({
      id: opaque(run.id), provider: run.provider, state: run.state,
      requestedAt: run.requestedAt, startedAt: run.startedAt, finishedAt: run.finishedAt, updatedAt: run.updatedAt,
      currentSequence: run.currentSequence, runtimeTarget: run.request.runtimeTarget,
      sandbox: run.request.sandbox, network: run.request.network,
      applicationCase: run.request.applicationCaseId ? opaque(run.request.applicationCaseId) : undefined,
      correlation: typeof run.request.metadata?.correlationId === 'string' ? opaque(run.request.metadata.correlationId) : undefined,
      failureCode: safeCode(run.failure?.code)
    })),
    queue: {
      capturedAt: input.queue.capturedAt, depth: input.queue.depth, active: input.queue.active,
      limits: input.queue.limits, activeByProvider: input.queue.activeByProvider,
      entries: input.queue.queue.map((entry) => ({
        runId: opaque(entry.runId), provider: entry.provider, position: entry.position,
        effectivePriority: entry.effectivePriority, waitMs: entry.waitMs, blockedBy: entry.blockedBy
      }))
    },
    recovery: input.recovery.map((entry) => ({
      runId: opaque(entry.runId), state: entry.state, provider: entry.provider,
      providerSessionPresent: entry.providerSessionPresent, processAdoptionAllowed: false,
      allowedDecisions: entry.allowedDecisions
    })),
    telemetry: structuredClone(input.telemetry)
  } satisfies Readonly<Record<string, unknown>>;
  const generatedAt = (input.generatedAt ?? new Date()).toISOString();
  const envelope = { contract: 'agent-support-bundle', contractVersion: '1.0', redacted: true, generatedAt, payload } as const;
  return { ...envelope, sha256: createHash('sha256').update(canonical(envelope)).digest('hex') };
}

export function verifyAgentSupportBundle(bundle: AgentSupportBundle): boolean {
  const { sha256, ...envelope } = bundle;
  return /^[0-9a-f]{64}$/.test(sha256)
    && createHash('sha256').update(canonical(envelope)).digest('hex') === sha256;
}
