import {
  AGENT_CONTRACT_VERSION,
  type AgentCapabilities,
  type AgentProviderInstallation,
  type AgentRunnerPort,
  type AgentRunHandle,
  type ApprovalDecision,
  type ProviderRunContext
} from '../ports/agent-runner.js';

export interface FakeAgentScriptStep {
  delayMs?: number;
  kind: string;
  data: Readonly<Record<string, unknown>>;
}

export interface FakeAgentScript {
  steps: readonly FakeAgentScriptStep[];
  outcome?: Awaited<AgentRunHandle['completion']>;
}

interface ActiveFakeRun {
  cancelled: boolean;
  context: ProviderRunContext;
  approvalId?: string;
  resolveApproval?: (decision: ApprovalDecision) => void;
  resolveInput?: (input: string) => void;
}

export class FakeAgentProvider implements AgentRunnerPort {
  private readonly active = new Map<string, ActiveFakeRun>();

  constructor(private readonly script: FakeAgentScript = {
    steps: [
      { kind: 'agent_message_delta', data: { text: 'synthetic ' } },
      { kind: 'agent_message_completed', data: { text: 'synthetic result' } }
    ],
    outcome: { state: 'succeeded' }
  }, readonly provider = 'fake') {}

  async discover(): Promise<AgentProviderInstallation[]> {
    const installation: AgentProviderInstallation = {
      provider: this.provider, runtimeTarget: process.platform === 'win32' ? 'windows' : 'linux',
      executable: process.execPath, version: 'fake 1.0.0', support: 'supported', authStatus: 'not_required'
    };
    installation.capabilities = await this.capabilities(installation);
    return [installation];
  }

  async capabilities(installation: AgentProviderInstallation): Promise<AgentCapabilities> {
    const interactiveInput = this.script.steps.some((step) => step.kind === 'user_input_requested');
    const approvals = this.script.steps.some((step) => step.kind === 'approval_requested');
    return {
      schemaVersion: AGENT_CONTRACT_VERSION, provider: this.provider, providerVersion: installation.version,
      adapterVersion: '1.0.0', protocolVersion: '1.0', streaming: true, resume: false,
      interactiveInput, approvals, tools: false, images: false, structuredOutput: true,
      sandboxPolicies: ['read-only', 'workspace-write'], usage: true,
      supportedRuntimeTargets: ['windows', 'wsl', 'linux', 'darwin']
    };
  }

  async start(context: ProviderRunContext): Promise<AgentRunHandle> {
    if (this.active.has(context.runId)) throw new Error('Fake-Run läuft bereits.');
    const active: ActiveFakeRun = { cancelled: false, context };
    this.active.set(context.runId, active);
    const completion = (async () => {
      await context.emit({ kind: 'process_started', data: { pid: 0, synthetic: true } });
      for (const step of this.script.steps) {
        if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
        if (active.cancelled) {
          await context.emit({ kind: 'run_completed', data: { state: 'cancelled' } });
          this.active.delete(context.runId);
          return { state: 'cancelled' as const };
        }
        await context.emit({ kind: step.kind, data: step.data });
        if (step.kind === 'approval_requested') {
          active.approvalId = typeof step.data.id === 'string' ? step.data.id : `approval-${context.runId}`;
          const decision = await new Promise<ApprovalDecision>((resolve) => { active.resolveApproval = resolve; });
          active.resolveApproval = undefined;
          await context.emit({ kind: 'approval_resolved', data: { id: active.approvalId, decision } });
          if (decision !== 'approved') {
            await context.emit({ kind: 'run_completed', data: { state: 'cancelled', reason: 'synthetic_approval_denied' } });
            this.active.delete(context.runId);
            return { state: 'cancelled' as const };
          }
        }
        if (step.kind === 'user_input_requested') {
          await new Promise<string>((resolve) => { active.resolveInput = resolve; });
          active.resolveInput = undefined;
        }
      }
      const outcome = this.script.outcome ?? { state: 'succeeded' as const };
      await context.emit({ kind: 'run_completed', data: { state: outcome.state } });
      this.active.delete(context.runId);
      return outcome;
    })();
    return { runId: context.runId, completion };
  }

  async sendInput(runId: string, input: string): Promise<void> {
    const active = this.active.get(runId);
    if (!active) throw new Error('Fake-Run ist nicht aktiv.');
    if (!active.resolveInput) throw new Error('Fake-Run wartet nicht auf Eingabe.');
    active.resolveInput(input);
  }
  async resolveApproval(runId: string, approvalId: string, decision: ApprovalDecision): Promise<void> {
    const active = this.active.get(runId);
    if (!active?.resolveApproval || active.approvalId !== approvalId) throw new Error('Fake-Freigabe ist nicht offen oder stimmt nicht überein.');
    active.resolveApproval(decision);
  }
  async cancel(runId: string): Promise<void> {
    const active = this.active.get(runId);
    if (active) {
      active.cancelled = true;
      active.resolveApproval?.('cancelled');
      active.resolveInput?.('');
    }
  }
  async resume(_runId: string): Promise<AgentRunHandle> { throw new Error('Fake-Provider unterstützt kein Resume.'); }
  async dispose(): Promise<void> { for (const active of this.active.values()) active.cancelled = true; }
}
