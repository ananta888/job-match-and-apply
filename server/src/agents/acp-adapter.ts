import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_CONTRACT_VERSION,
  type AgentCapabilities,
  type AgentEventDraft,
  type AgentProviderInstallation,
  type AgentRunnerPort,
  type AgentRunHandle,
  type ApprovalDecision,
  type ProviderRunContext,
} from '../ports/agent-runner.js';
import { AgentRuntimeDiscovery, type ProviderDiscoveryDefinition } from './runtime-discovery.js';
import { DEFAULT_PROCESS_LIMITS, ProcessSupervisor } from './process-supervisor.js';
import { assertTrustedHostJobMcpNotNestedInAgentSandbox } from './provider-sandbox.js';
import {
  ACP_CLIENT_VERSION,
  ACP_PROTOCOL_VERSION,
  acpClientInitializeParams,
  acpPermissionDeniedResult,
  acpPromptParams,
  acpSessionNewParams,
  assertAcpInitializeResult,
  isForbiddenAcpClientMethod,
  mapAcpJsonRpcMessage,
  sessionIdFromNewResult,
} from './acp-protocol.js';
import { AcpJsonRpcClient } from './acp-jsonrpc.js';
import { PROVIDER_RESOURCE_CEILINGS, buildMinimalProviderEnvironment } from './generic-jsonl-adapter.js';

export const ACP_SYNTHETIC_VERSION = 'acp-synthetic 0.1.0';
export const ACP_MANIFEST_ID = 'acp';

const SYNTHETIC_CLI = fileURLToPath(new URL('./fixtures/fake-acp-cli.mjs', import.meta.url));

export class AcpAgentAdapter implements AgentRunnerPort {
  readonly provider = ACP_MANIFEST_ID;
  private readonly active = new Map<string, { cancel: () => Promise<void> }>();

  constructor(
    private readonly supervisor = new ProcessSupervisor(),
    private readonly discovery = new AgentRuntimeDiscovery(),
    private readonly allowUntestedVersions = false,
    private readonly options: { syntheticHoldPrompt?: boolean } = {},
  ) {}

  private discoveryDefinition(): ProviderDiscoveryDefinition {
    return {
      provider: this.provider,
      executableNames: ['codex-acp', 'claude-agent-acp', 'acp-synthetic'],
      versionArgs: ['--version'],
      testedVersionPatterns: [/^acp-synthetic 0\.1\.0$/i],
    };
  }

  async discover(): Promise<AgentProviderInstallation[]> {
    const found = await this.discovery.discoverLocal(this.discoveryDefinition());
    if (found.length) return found;
    if (this.allowUntestedVersions) {
      return [{
        provider: this.provider,
        runtimeTarget: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux',
        executable: process.execPath,
        version: ACP_SYNTHETIC_VERSION,
        support: 'supported',
        authStatus: 'not_required',
      }];
    }
    return [];
  }

  async capabilities(installation: AgentProviderInstallation): Promise<AgentCapabilities> {
    if (installation.provider !== this.provider) throw new Error('Installation gehört zu einem anderen Provider.');
    return {
      schemaVersion: AGENT_CONTRACT_VERSION,
      provider: this.provider,
      providerVersion: installation.version,
      adapterVersion: '0.1.0',
      protocolVersion: String(ACP_PROTOCOL_VERSION),
      streaming: true,
      resume: false,
      interactiveInput: false,
      approvals: false,
      tools: false,
      images: false,
      structuredOutput: true,
      sandboxPolicies: ['read-only'],
      usage: true,
      supportedRuntimeTargets: ['windows', 'linux', 'darwin'],
      extensions: {
        experimental: true,
        protocol: 'acp-jsonrpc',
        protocolMajor: ACP_PROTOCOL_VERSION,
        clientVersion: ACP_CLIENT_VERSION,
        networkControl: true,
        networkAccessClaim: 'provider-control-plane-only',
        mcpServers: [],
        fsClientMethods: false,
        terminalClientMethods: false,
        serverOwnedNoToolsMode: undefined,
        maturity: 'experimental',
        fixture: 'contracts/fixtures/v1/acp-events.json',
      },
    };
  }

  async start(context: ProviderRunContext): Promise<AgentRunHandle> {
    if (this.active.has(context.runId)) throw new Error('ACP-Run läuft bereits.');
    const { installation, request } = context;
    if (installation.provider !== this.provider || request.provider !== this.provider) {
      throw new Error('Run-Anfrage gehört nicht zum ACP-Adapter.');
    }
    if (installation.support === 'unsupported' || installation.support === 'unavailable') {
      throw new Error(installation.reason ?? 'ACP-Installation ist nicht nutzbar.');
    }
    const version = installation.version;
    const exact = version !== undefined && /^acp-synthetic 0\.1\.0$/i.test(version);
    if (!this.allowUntestedVersions && (installation.support === 'untested' || !exact)) {
      throw new Error('Provider-Version ist nicht durch Contract-Fixtures freigegeben.');
    }
    if (!isAbsolute(request.workspaceRoot)) throw new Error('Workspace muss absolut sein.');
    if (!request.task.trim() || request.task.includes('\0')) throw new Error('Agentenaufgabe ist leer oder ungültig.');
    if (request.sandbox !== 'read-only') throw new Error('ACP ist in dieser Version nur read-only freigegeben.');
    if (request.network !== 'disabled') throw new Error('ACP-Netzwerkmodus ist nicht freigegeben.');
    if (request.approvalMode === 'explicit') throw new Error('ACP besitzt keine interaktive Approval-Brücke.');
    if (request.runtimeTarget === 'wsl' || request.runtimeTarget === 'container') {
      throw new Error('ACP läuft in dieser Version nicht in WSL oder Containern.');
    }
    await assertTrustedHostJobMcpNotNestedInAgentSandbox(request.workspaceRoot);

    const useSynthetic = exact || this.allowUntestedVersions;
    let emitQueue = Promise.resolve();
    const queue = (draft: AgentEventDraft): void => {
      emitQueue = emitQueue.then(() => context.emit(draft));
    };
    const rpcBox: { client?: AcpJsonRpcClient } = {};

    const processHandle = this.supervisor.start({
      executable: useSynthetic ? process.execPath : installation.executable,
      args: useSynthetic
        ? [SYNTHETIC_CLI, ...(this.options.syntheticHoldPrompt ? ['--hold-prompt'] : [])]
        : [],
      cwd: request.workspaceRoot,
      env: buildMinimalProviderEnvironment(this.provider, installation),
      limits: {
        ...DEFAULT_PROCESS_LIMITS,
        ...request.limits,
        maxResidentMemoryBytes: Math.min(
          request.limits?.maxResidentMemoryBytes ?? PROVIDER_RESOURCE_CEILINGS.maxResidentMemoryBytes,
          PROVIDER_RESOURCE_CEILINGS.maxResidentMemoryBytes,
        ),
        maxChildProcesses: Math.min(
          request.limits?.maxChildProcesses ?? PROVIDER_RESOURCE_CEILINGS.maxChildProcesses,
          PROVIDER_RESOURCE_CEILINGS.maxChildProcesses,
        ),
      },
    }, {
      onStart: (pid) => queue({
        kind: 'process_started',
        data: { pid, runtimeTarget: installation.runtimeTarget, protocol: 'acp-jsonrpc' },
      }),
      onStdout: (chunk) => rpcBox.client?.feed(chunk),
      onStderr: (chunk) => queue({ kind: 'warning', data: { code: 'provider_stderr', message: String(chunk).slice(0, 500) } }),
      onHeartbeat: () => queue({ kind: 'heartbeat', data: {} }),
    });

    const rpc = new AcpJsonRpcClient(
      (line) => processHandle.writeInput(line),
      {
        onNotification(method, params) {
          for (const draft of mapAcpJsonRpcMessage({ jsonrpc: '2.0', method, params })) queue(draft);
        },
        async onRequest(incoming) {
          if (incoming.method === 'session/request_permission' || isForbiddenAcpClientMethod(incoming.method)) {
            for (const draft of mapAcpJsonRpcMessage({
              jsonrpc: '2.0', id: incoming.id, method: incoming.method, params: incoming.params,
            })) queue(draft);
            if (incoming.method === 'session/request_permission') {
              await rpcBox.client?.respond(incoming.id, acpPermissionDeniedResult());
            } else {
              await rpcBox.client?.respondError(incoming.id, { code: -32601, message: 'Client method is not advertised.' });
            }
            return {};
          }
          await rpcBox.client?.respondError(incoming.id, { code: -32601, message: 'Method not found.' });
          return {};
        },
      },
    );
    rpcBox.client = rpc;

    const active = {
      cancel: async () => {
        void rpc.notify('session/cancel', { sessionId: sessionId ?? 'unknown' }).catch(() => undefined);
        rpc.rejectAll(Object.assign(new Error('acp_cancelled'), { code: 'acp_cancelled' }));
        await processHandle.cancel('ACP-Lauf abgebrochen.');
      },
    };
    this.active.set(context.runId, active);
    let sessionId: string | undefined;
    void processHandle.completion.finally(() => {
      rpc.rejectAll(new Error('acp_jsonrpc_closed'));
    });

    const completion = (async () => {
      try {
        queue({ kind: 'capabilities_negotiated', data: { protocol: 'acp-jsonrpc', protocolVersion: ACP_PROTOCOL_VERSION } });
        const initialized = assertAcpInitializeResult(await rpc.request('initialize', acpClientInitializeParams()));
        sessionId = sessionIdFromNewResult(await rpc.request('session/new', acpSessionNewParams(request.workspaceRoot)));
        const promptResult = await rpc.request('session/prompt', acpPromptParams(sessionId, request.task));
        const stopReason = promptResult && typeof promptResult === 'object' && 'stopReason' in promptResult
          ? String((promptResult as { stopReason?: unknown }).stopReason) : 'end_turn';
        if (stopReason === 'cancelled') {
          queue({ kind: 'run_completed', data: { state: 'cancelled', stopReason } });
          return { state: 'cancelled' as const };
        }
        if (stopReason === 'refusal' || stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
          queue({ kind: 'error', data: { code: `acp_${stopReason}`, retryable: false } });
          queue({ kind: 'run_completed', data: { state: 'failed', stopReason } });
          return { state: 'failed' as const, failure: { code: `acp_${stopReason}`, message: stopReason, retryable: false } };
        }
        queue({ kind: 'run_completed', data: { state: 'succeeded', stopReason, sessionId, loadSession: initialized.sessionLoad } });
        try { await processHandle.writeInput('', true); } catch { /* stdin may already be closed */ }
        return { state: 'succeeded' as const };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'acp_run_failed';
        if (message === 'acp_cancelled') {
          queue({ kind: 'run_completed', data: { state: 'cancelled', stopReason: 'cancelled' } });
          return { state: 'cancelled' as const };
        }
        queue({ kind: 'error', data: { code: 'acp_run_failed', message: message.slice(0, 200), retryable: false } });
        queue({ kind: 'run_completed', data: { state: 'failed' } });
        try { await processHandle.cancel(message); } catch { /* already ending */ }
        return { state: 'failed' as const, failure: { code: 'acp_run_failed', message, retryable: false } };
      } finally {
        rpc.end();
        this.active.delete(context.runId);
        await emitQueue;
        await processHandle.completion.catch(() => undefined);
      }
    })();

    return { runId: context.runId, completion };
  }

  async sendInput(): Promise<void> {
    throw new Error('ACP unterstützt in dieser Version keine laufende Eingabe.');
  }

  async resolveApproval(_runId: string, _approvalId: string, _decision: ApprovalDecision): Promise<void> {
    throw new Error('ACP besitzt keine interaktive Approval-Brücke.');
  }

  async cancel(runId: string): Promise<void> {
    await this.active.get(runId)?.cancel();
  }

  async resume(): Promise<AgentRunHandle> {
    throw new Error('ACP-Resume ist nicht unterstützt.');
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.active.values()].map((item) => item.cancel()));
  }
}
