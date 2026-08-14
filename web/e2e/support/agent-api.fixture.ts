import { expect, test as base, type Page, type Route } from '@playwright/test';
import type {
  AgentApproval,
  AgentProvider,
  AgentQueueSnapshot,
  AgentRecoveryLease,
  AgentRecoveryRun,
  AgentRun,
  AgentRunEvent,
  AgentRunPreflight,
  AgentRunRequest,
  AgentRunStatus,
  AgentWorkflow,
  AppConfig,
  McpRuntimeStatus
} from '../../src/app/models';

const FIXED_TIME = '2026-08-13T18:00:00.000Z';

const CONFIG: AppConfig = {
  searchProfile: {
    name: 'Synthetisches E2E-Profil', query: 'Angular', regions: ['Testregion'], radiusKm: 25,
    workModels: ['hybrid'], employmentTypes: ['full_time'], mustHave: ['TypeScript'], niceToHave: ['Angular'], exclude: [], sourceIds: []
  },
  identities: [{
    id: 'fixture-incognito', label: 'E2E-Inkognito', mode: 'incognito', fullName: 'Testperson Beispiel',
    email: 'testperson@example.invalid', phone: '', location: 'Testregion', linkedin: '', placeholders: {}
  }],
  activeIdentityId: 'fixture-incognito',
  mcp: {
    mode: 'demo', executionIsolation: 'trusted-host', command: '', args: [],
    env: { ALLOW_EXTERNAL_PORTALS: '', JOB_MCP_STATE_DIR: '' },
    configuredEnvironmentKeys: ['ALLOW_EXTERNAL_PORTALS', 'JOB_MCP_STATE_DIR']
  },
  assistant: { skillPath: '', candidateProfilePath: '', styleProfilePath: '' }
};

const PROVIDERS: AgentProvider[] = [{
  id: 'fake-interactive', name: 'Synthetischer Offline-Agent', available: true, version: '1.0.0',
  authStatus: 'not_required', transport: 'fixture-jsonl', note: 'Offline-Fixture ohne Konto, Netzwerk oder persönliche Daten.',
  installations: [
    { runtimeTarget: 'windows', version: '1.0.0', support: 'supported', authStatus: 'not_required', note: 'Synthetische Windows-Laufzeit.' },
    { runtimeTarget: 'wsl', distribution: 'E2E-Ubuntu', version: '1.0.0', support: 'supported', authStatus: 'not_required', note: 'Synthetische WSL-Laufzeit.' }
  ],
  capabilities: { interactiveInput: true, approvals: true, networkControl: false, workspaceModes: ['read_only', 'workspace_write'] }
}];

const WORKFLOWS: AgentWorkflow[] = [{
  id: 'guided-job-analysis', version: '1.0.0', title: 'Geführte Stellenanalyse',
  description: 'Analysiert ausschließlich synthetischen Stellenkontext.', requiredScope: 'search_profile',
  producesSuggestionsOnly: true, prohibitedActions: ['submit_application', 'send_message']
}];

function clone<T>(value: T): T { return structuredClone(value); }

function event(sequence: number, type: string, message: string, level: AgentRunEvent['level'] = 'info'): AgentRunEvent {
  return { sequence, type, timestamp: FIXED_TIME, correlationId: 'fixture-correlation', message, level };
}

function runFixture(id: string, status: AgentRunStatus, prompt: string, pendingApprovals: AgentApproval[] = []): AgentRun {
  return {
    id, providerId: 'fake-interactive', status,
    request: {
      providerId: 'fake-interactive', prompt, runtimeTarget: 'windows', workspaceMode: 'read_only', network: false,
      workflowId: 'guided-job-analysis', budget: { wallTimeMinutes: 30, maxOutputMiB: 10 }
    },
    createdAt: FIXED_TIME, updatedAt: FIXED_TIME, startedAt: FIXED_TIME,
    usage: { inputTokens: 120, outputTokens: 42, toolCalls: 1, durationMs: 2_500, cost: 0, currency: 'EUR' },
    pendingApprovals, lastEventSequence: 0,
    providerVersion: '1.0.0', workflowVersion: '1.0.0', policyVersion: 'fixture-policy-1',
    contextSummary: { scope: 'synthetic-workspace', sourceCount: 1, redactedHash: 'fixture-redacted-witness' }
  };
}

export class AgentApiStub {
  readonly configSaveRequests: AppConfig[] = [];
  readonly portalAccessRequests: Array<{ enabled: boolean; confirmed: boolean }> = [];
  readonly preflightRequests: AgentRunRequest[] = [];
  readonly createRequests: AgentRunRequest[] = [];
  readonly inputRequests: Array<{ runId: string; body: Record<string, unknown> }> = [];
  readonly approvalRequests: Array<{ runId: string; approvalId: string; body: Record<string, unknown> }> = [];
  readonly cancelRequests: Array<{ runId: string; body: Record<string, unknown> }> = [];
  readonly recoveryLeaseRequests: Array<{ runId: string; body: Record<string, unknown> }> = [];
  readonly recoveryResolveRequests: Array<{ runId: string; body: Record<string, unknown> }> = [];
  readonly unknownRequests: string[] = [];
  readonly externalRequests: string[] = [];

  private config = clone(CONFIG);
  private runtimeStatus: McpRuntimeStatus = {
    contract: 'job-search-mcp-runtime-status', contractVersion: '1.0', mode: 'demo', state: 'demo',
    launchValidated: false, connected: false, note: 'Deterministischer Offline-Demomodus ohne externen Zugriff.'
  };
  private readonly runs = new Map<string, AgentRun>();
  private readonly events = new Map<string, AgentRunEvent[]>();
  private readonly recoveries = new Map<string, AgentRecoveryRun>();
  private readonly recoveryLeases = new Map<string, AgentRecoveryLease>();
  private createdRuns = 0;
  private readonly queueSnapshot: AgentQueueSnapshot = {
    capturedAt: '2026-08-14T08:00:00.000Z', depth: 1, active: 2,
    limits: { global: 3, perProvider: 1, perWorkspace: 1, perOwner: 2, queuedGlobal: 20, queuedPerWorkspace: 4, queuedPerOwner: 5 },
    activeByProvider: { 'fake-interactive': 1, 'fixture-reviewer': 1 },
    activeByWorkspace: { 'X:\\Synthetic\\Fixture\\Workspace': 1, 'X:\\Synthetic\\Fixture\\Review': 1 },
    activeByOwner: { 'fixture-owner': 2 },
    queue: [{
      runId: 'fixture-queued-diagnostic', provider: 'fake-interactive', workspaceRoot: 'X:\\Synthetic\\Fixture\\Workspace', ownerId: 'fixture-owner',
      position: 1, basePriority: 20, effectivePriority: 35, waitMs: 65_000, blockedBy: ['provider_limit', 'workspace_limit']
    }]
  };

  async install(page: Page): Promise<void> {
    await page.route(/^https?:\/\/(?!(?:127\.0\.0\.1|localhost)(?::\d+)?\/)/i, async (route) => {
      this.externalRequests.push(route.request().url());
      await route.abort('blockedbyclient');
    });
    await page.route('**/api/**', (route) => this.handle(route));
  }

  seedReadyMcpRuntime(): void {
    this.config.mcp = {
      mode: 'stdio', executionIsolation: 'trusted-host', runtimeTarget: 'windows',
      command: 'X:\\Synthetic\\job-search-mcp\\runtime.exe', args: [],
      env: { ALLOW_EXTERNAL_PORTALS: '', JOB_MCP_STATE_DIR: '' },
      configuredEnvironmentKeys: ['ALLOW_EXTERNAL_PORTALS', 'JOB_MCP_STATE_DIR']
    };
    this.runtimeStatus = {
      contract: 'job-search-mcp-runtime-status', contractVersion: '1.0', mode: 'stdio', state: 'ready_to_connect',
      runtimeTarget: 'windows', launchValidated: true, connected: false,
      note: 'Synthetischer Windows-Startpfad wurde validiert; es besteht noch keine Protokollverbindung.'
    };
  }

  seedInvalidMcpRuntime(): void {
    this.seedReadyMcpRuntime();
    this.runtimeStatus = {
      contract: 'job-search-mcp-runtime-status', contractVersion: '1.0', mode: 'stdio', state: 'invalid',
      runtimeTarget: 'windows', launchValidated: false, connected: false,
      note: 'Der synthetische Startpfad ist absichtlich ungültig.'
    };
  }

  seedRunningRun(id = 'fixture-running'): AgentRun {
    const run = runFixture(id, 'running', 'Synthetischen Projektstand nachvollziehbar prüfen');
    this.seed(run, [
      event(1, 'run_started', 'Offline-Run wurde gestartet.'),
      event(2, 'tool_started', 'Read-only Analysewerkzeug wurde aufgerufen.'),
      event(3, 'tool_completed', 'Analysewerkzeug wurde ohne externe Aktion beendet.')
    ]);
    return clone(run);
  }

  seedWaitingForInputRun(id = 'fixture-interactive'): AgentRun {
    const run = runFixture(id, 'waiting_for_input', 'Rückfrage und Freigabe kontrolliert prüfen');
    this.seed(run, [
      event(1, 'run_started', 'Interaktiver Offline-Run wurde gestartet.'),
      event(2, 'input_requested', 'Welche synthetische Prüftiefe soll verwendet werden?', 'warning')
    ]);
    return clone(run);
  }

  seedVisualRun(): AgentRun {
    const approval: AgentApproval = {
      id: 'fixture-approval-visual', kind: 'workspace_write', title: 'Synthetische Dateiänderung prüfen',
      description: 'Diese Freigabe verändert ausschließlich den lokalen Fixture-Zustand.', risk: 'medium',
      target: 'fixture/workspace/result.txt', diff: '+ synthetische Prüfnotiz', expectedRevision: 3,
      requestedAt: FIXED_TIME, expiresAt: '2099-08-13T19:00:00.000Z', status: 'pending'
    };
    const run = runFixture('fixture-visual', 'waiting_for_approval', 'Agent Center visuell und barrierefrei prüfen', [approval]);
    run.request.runtimeTarget = 'wsl';
    run.request.wslDistribution = 'E2E-Ubuntu';
    this.seed(run, [
      event(1, 'run_started', 'Synthetischer visueller Run wurde gestartet.'),
      event(2, 'assistant_message', 'Die lokale Analyse ist abgeschlossen.'),
      event(3, 'approval_requested', 'Eine ausdrückliche Fixture-Freigabe ist erforderlich.', 'warning')
    ]);
    this.seedRecoveryRun('fixture-orphan-visual');
    return clone(run);
  }

  seedRecoveryRun(id = 'fixture-orphan'): AgentRun {
    const run = runFixture(id, 'orphaned', 'Verwaisten synthetischen Run sicher entscheiden');
    this.seed(run, [
      event(1, 'run_started', 'Früherer Fixture-Prozess wurde gestartet.'),
      event(2, 'tool_started', 'Synthetischer Providerprozess war aktiv.'),
      event(3, 'warning', 'Serverneustart hat den Run als verwaist markiert.', 'warning')
    ]);
    this.recoveries.set(id, {
      runId: id, state: 'orphaned', provider: 'fake-interactive', providerSessionPresent: true,
      processAdoptionAllowed: false, allowedDecisions: ['cleanup', 'resume']
    });
    return clone(run);
  }

  seedLargeTimelineRun(id = 'fixture-large'): AgentRun {
    const run = runFixture(id, 'running', 'Große synthetische Timeline prüfen');
    const events = Array.from({ length: 450 }, (_, index) => {
      const sequence = index + 1;
      const type = sequence % 3 === 0 ? 'tool_output' : sequence % 3 === 1 ? 'agent_message_completed' : 'usage_updated';
      const message = sequence === 25 ? 'needle-event-025 mit testperson@example.invalid und token=fixture-secret' : `Synthetisches Timeline-Ereignis ${sequence}`;
      return event(sequence, type, message, sequence % 50 === 0 ? 'warning' : 'info');
    });
    this.seed(run, events);
    return clone(run);
  }

  seedApprovalInboxRuns(): AgentRun[] {
    const actionable = runFixture('fixture-approval-actionable', 'waiting_for_approval', 'Globale Freigabe prüfen', [{
      id: 'approval-actionable', kind: 'external_write', title: 'Externe Fixture-Aktion', risk: 'external_write',
      description: 'Nur ein synthetisches Ziel wird geprüft.', target: 'fixture://company/example', diff: '+ fixture proposal',
      expectedRevision: 2, requestedAt: FIXED_TIME, expiresAt: '2099-01-01T00:00:00.000Z', status: 'pending'
    }]);
    const expired = runFixture('fixture-approval-expired', 'waiting_for_approval', 'Abgelaufene Freigabe prüfen', [{
      id: 'approval-expired', kind: 'destructive', title: 'Abgelaufene Fixture-Aktion', risk: 'destructive', target: 'fixture://expired',
      expectedRevision: 2, requestedAt: FIXED_TIME, expiresAt: '2000-01-01T00:00:00.000Z', status: 'pending'
    }]);
    const stale = runFixture('fixture-approval-stale', 'waiting_for_approval', 'Veraltete Freigabe prüfen', [{
      id: 'approval-stale', kind: 'workspace_write', title: 'Veraltete Fixture-Aktion', risk: 'high', target: 'fixture/workspace/stale.txt',
      expectedRevision: 1, requestedAt: FIXED_TIME, expiresAt: '2099-01-01T00:00:00.000Z', status: 'pending'
    }]);
    for (const run of [actionable, expired, stale]) this.seed(run, [event(1, 'run_started', 'Fixture-Run gestartet.'), event(2, 'approval_requested', 'Fixture-Freigabe angefordert.', 'warning')]);
    return [actionable, expired, stale].map(clone);
  }

  seedComparisonRuns(): { parent: AgentRun; child: AgentRun } {
    const parent = runFixture('fixture-parent', 'succeeded', 'Synthetischen Ausgangslauf analysieren');
    parent.output = 'Ausgangsvorschlag'; parent.completedAt = FIXED_TIME;
    parent.contextSummary = { scope: 'fixture-case', sourceCount: 2, redactedHash: 'parent-witness' };
    const child = runFixture('fixture-child', 'succeeded', 'Synthetischen Ausgangslauf mit engerer Policy analysieren');
    child.parentRunId = parent.id; child.request.parentRunId = parent.id; child.request.workspaceMode = 'workspace_write';
    child.createdAt = '2026-08-13T18:05:00.000Z'; child.updatedAt = child.createdAt; child.completedAt = child.createdAt;
    child.usage = { inputTokens: 160, outputTokens: 55, toolCalls: 2, durationMs: 4_000, cost: 0, currency: 'EUR' };
    child.output = 'Vorschlag für Testperson Beispiel, testperson@example.invalid, X:\\Synthetic\\Fixture\\result.txt, token=fixture-secret';
    child.contextSummary = { scope: 'fixture-case', sourceCount: 3, redactedHash: 'child-witness' };
    this.seed(parent, [event(1, 'run_started', 'Ausgangslauf gestartet.'), event(2, 'run_completed', 'Ausgangslauf beendet.')]);
    this.seed(child, [event(1, 'run_started', 'Kindlauf gestartet.'), event(2, 'run_completed', 'Kindlauf beendet.')]);
    return { parent: clone(parent), child: clone(child) };
  }

  appendLiveEvent(runId: string, message: string, type = 'agent_message_completed', level: AgentRunEvent['level'] = 'info'): AgentRunEvent {
    const run = this.requireRun(runId);
    const item = event((run.lastEventSequence ?? 0) + 1, type, message, level);
    this.append(runId, item);
    run.updatedAt = FIXED_TIME;
    return clone(item);
  }

  private seed(run: AgentRun, events: AgentRunEvent[]): void {
    run.lastEventSequence = Math.max(0, ...events.map((item) => item.sequence));
    this.runs.set(run.id, clone(run));
    this.events.set(run.id, clone(events));
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (method === 'GET' && path === '/api/config') return this.json(route, this.config);
    if (method === 'PUT' && path === '/api/config') {
      const body = request.postDataJSON() as AppConfig;
      this.configSaveRequests.push(clone(body));
      this.config = clone(body);
      return this.json(route, this.config);
    }
    if (method === 'PUT' && path === '/api/config/mcp/portal-access') {
      const body = request.postDataJSON() as { enabled: boolean; confirmed: boolean };
      this.portalAccessRequests.push(clone(body));
      return this.json(route, this.config);
    }
    if (method === 'GET' && path === '/api/sources') return this.json(route, []);
    if (method === 'GET' && path === '/api/sources/runtime') {
      return this.json(route, this.runtimeStatus, this.runtimeStatus.state === 'invalid' ? 503 : 200);
    }
    if (method === 'GET' && path === '/api/capabilities') return this.json(route, { contract: 'fixture', contractVersion: '1.0.0', compatible: true, tools: [], errorCategories: [], sources: [] });
    if (method === 'GET' && path === '/api/job-decisions') return this.json(route, []);
    if (method === 'GET' && path === '/api/assistant/status') return this.json(route, { available: true, note: 'Synthetisches Offline-Fixture.' });
    if (method === 'GET' && path === '/api/agents/providers') return this.json(route, PROVIDERS);
    if (method === 'GET' && path === '/api/application-cases') return this.json(route, []);
    if (method === 'GET' && path === '/api/agents/workflows') return this.json(route, WORKFLOWS);
    if (method === 'GET' && path === '/api/agents/queue') return this.json(route, this.queueSnapshot);
    if (method === 'GET' && path === '/api/agents/recovery') return this.json(route, { runs: [...this.recoveries.values()] });
    if (method === 'GET' && path === '/api/agent-runs') return this.json(route, [...this.runs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)));

    if (method === 'POST' && path === '/api/agent-runs/preflight') {
      const body = request.postDataJSON() as AgentRunRequest;
      this.preflightRequests.push(clone(body));
      return this.json(route, this.buildPreflight(body));
    }

    if (method === 'POST' && path === '/api/agent-runs') {
      const body = request.postDataJSON() as AgentRunRequest;
      this.createRequests.push(clone(body));
      const id = `fixture-created-${++this.createdRuns}`;
      const run = runFixture(id, 'running', body.prompt);
      run.request = clone(body);
      const runEvents = [
        event(1, 'run_queued', 'Run wurde in die lokale Fixture-Warteschlange aufgenommen.'),
        event(2, 'run_started', 'Run wird ohne Netzwerk ausgeführt.'),
        event(3, 'assistant_message', 'Live-Ausgabe aus dem synthetischen Eventstream.')
      ];
      this.seed(run, runEvents);
      return this.json(route, this.runs.get(id), 201);
    }

    const streamMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/stream$/);
    if (method === 'GET' && streamMatch) {
      const runId = decodeURIComponent(streamMatch[1]);
      const after = Number(url.searchParams.get('after') ?? '0');
      const body = (this.events.get(runId) ?? []).filter((item) => item.sequence > after)
        .map((item) => `id: ${item.sequence}\nevent: agent-event\ndata: ${JSON.stringify(item)}\n\n`).join('');
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: `retry: 60000\n\n${body}` });
      return;
    }

    const eventsMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/events$/);
    if (method === 'GET' && eventsMatch) {
      const runId = decodeURIComponent(eventsMatch[1]);
      const after = Number(url.searchParams.get('after') ?? '0');
      const events = (this.events.get(runId) ?? []).filter((item) => item.sequence > after);
      return this.json(route, { events, nextAfter: Math.max(after, ...events.map((item) => item.sequence), 0) });
    }

    const recoveryLeaseMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/recovery\/lease$/);
    if (method === 'POST' && recoveryLeaseMatch) {
      const runId = decodeURIComponent(recoveryLeaseMatch[1]);
      const body = request.postDataJSON() as Record<string, unknown>;
      this.recoveryLeaseRequests.push({ runId, body: clone(body) });
      const run = this.requireRun(runId);
      const recovery = this.recoveries.get(runId);
      if (body['confirmed'] !== true || body['expectedRevision'] !== run.lastEventSequence || run.status !== 'orphaned' || !recovery || recovery.lease) {
        return this.json(route, { error: 'Fixture-Recovery-Zustand wurde verändert.' }, 409);
      }
      const lease: AgentRecoveryLease = {
        runId, leaseId: '11111111-1111-4111-8111-111111111111', operatorId: 'local-user',
        acquiredAt: '2026-08-14T08:00:00.000Z', expiresAt: '2099-08-14T08:05:00.000Z'
      };
      this.recoveryLeases.set(runId, lease);
      recovery.lease = { runId, operatorId: lease.operatorId, acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt };
      return this.json(route, lease);
    }

    const recoveryResolveMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/recovery\/resolve$/);
    if (method === 'POST' && recoveryResolveMatch) {
      const runId = decodeURIComponent(recoveryResolveMatch[1]);
      const body = request.postDataJSON() as Record<string, unknown>;
      this.recoveryResolveRequests.push({ runId, body: clone(body) });
      const run = this.requireRun(runId);
      const lease = this.recoveryLeases.get(runId);
      const decision = body['decision'];
      if (body['confirmed'] !== true || body['expectedRevision'] !== run.lastEventSequence
        || body['leaseId'] !== lease?.leaseId || (decision !== 'cleanup' && decision !== 'resume')) {
        return this.json(route, { error: 'Fixture-Lease oder Revision ist nicht mehr gültig.' }, 409);
      }
      run.status = 'cancelled'; run.completedAt = FIXED_TIME; run.updatedAt = FIXED_TIME;
      this.append(runId, event((run.lastEventSequence ?? 0) + 1, 'run_completed', `Recovery-Entscheidung ${String(decision)} wurde protokolliert.`));
      let replacement: AgentRun | undefined;
      if (decision === 'resume') {
        replacement = runFixture(`${runId}-replacement`, 'queued', typeof body['input'] === 'string' ? body['input'] : run.request.prompt);
        replacement.request = { ...clone(run.request), prompt: replacement.request.prompt };
        replacement.createdAt = '2026-08-14T08:01:00.000Z'; replacement.updatedAt = replacement.createdAt;
        this.seed(replacement, []);
      }
      this.recoveries.delete(runId); this.recoveryLeases.delete(runId);
      return this.json(route, { resolved: run, ...(replacement ? { replacement } : {}) });
    }

    const inputMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/input$/);
    if (method === 'POST' && inputMatch) {
      const runId = decodeURIComponent(inputMatch[1]);
      const body = request.postDataJSON() as Record<string, unknown>;
      this.inputRequests.push({ runId, body: clone(body) });
      const run = this.requireRun(runId);
      const approval: AgentApproval = {
        id: 'fixture-approval', kind: 'workspace_write', title: 'Synthetische Änderung freigeben',
        description: 'Es werden keine echten Dateien oder externen Systeme berührt.', risk: 'medium',
        target: 'fixture/workspace/result.txt', diff: '+ geprüfte Fixture-Ausgabe', expectedRevision: 4,
        requestedAt: FIXED_TIME, expiresAt: '2099-08-13T19:00:00.000Z', status: 'pending'
      };
      run.status = 'waiting_for_approval'; run.pendingApprovals = [approval]; run.updatedAt = FIXED_TIME;
      this.append(runId, event(3, 'input_received', 'Synthetische Rückfrage wurde beantwortet.'));
      this.append(runId, event(4, 'approval_requested', 'Ausdrückliche Freigabe ist erforderlich.', 'warning'));
      return this.json(route, run);
    }

    const approvalMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/approvals\/([^/]+)$/);
    if (method === 'POST' && approvalMatch) {
      const runId = decodeURIComponent(approvalMatch[1]);
      const approvalId = decodeURIComponent(approvalMatch[2]);
      const body = request.postDataJSON() as Record<string, unknown>;
      this.approvalRequests.push({ runId, approvalId, body: clone(body) });
      const run = this.requireRun(runId);
      run.pendingApprovals = [];
      run.status = body['decision'] === 'approve' ? 'succeeded' : 'cancelled';
      run.output = body['decision'] === 'approve' ? 'Synthetische Freigabe wurde nachvollziehbar verarbeitet.' : undefined;
      run.completedAt = FIXED_TIME; run.updatedAt = FIXED_TIME;
      this.append(runId, event(5, 'approval_decision', `Fixture-Entscheidung: ${String(body['decision'])}.`));
      this.append(runId, event(6, run.status === 'succeeded' ? 'run_completed' : 'run_cancelled', 'Interaktiver Fixture-Run wurde beendet.'));
      return this.json(route, run);
    }

    const cancelMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancelMatch) {
      const runId = decodeURIComponent(cancelMatch[1]);
      const body = request.postDataJSON() as Record<string, unknown>;
      this.cancelRequests.push({ runId, body: clone(body) });
      const run = this.requireRun(runId);
      run.status = 'cancelled'; run.completedAt = FIXED_TIME; run.updatedAt = FIXED_TIME;
      this.append(runId, event((run.lastEventSequence ?? 0) + 1, 'run_cancelled', 'Run wurde auf ausdrücklichen Wunsch abgebrochen.', 'warning'));
      return this.json(route, run);
    }

    const exportMatch = path.match(/^\/api\/agent-runs\/([^/]+)\/export$/);
    if (method === 'GET' && exportMatch) {
      const runId = decodeURIComponent(exportMatch[1]);
      return this.json(route, { run: this.requireRun(runId), events: this.events.get(runId) ?? [], redacted: true });
    }

    const runMatch = path.match(/^\/api\/agent-runs\/([^/]+)$/);
    if (method === 'GET' && runMatch) {
      const run = this.runs.get(decodeURIComponent(runMatch[1]));
      return run ? this.json(route, run) : this.json(route, { error: 'Fixture-Run nicht gefunden.' }, 404);
    }

    this.unknownRequests.push(`${method} ${path}`);
    return this.json(route, { error: `Nicht erlaubter Fixture-Endpunkt: ${method} ${path}` }, 404);
  }

  private buildPreflight(request: AgentRunRequest): AgentRunPreflight {
    const provider = PROVIDERS.find((candidate) => candidate.id === request.providerId);
    const installation = provider?.installations?.find((candidate) => candidate.runtimeTarget === request.runtimeTarget
      && (!request.wslDistribution || candidate.distribution === request.wslDistribution));
    const workflow = request.workflowId ? WORKFLOWS.find((candidate) => candidate.id === request.workflowId) : undefined;
    const capabilities = provider?.capabilities && !Array.isArray(provider.capabilities) ? provider.capabilities : undefined;
    const workspaceSupported = Boolean(capabilities?.workspaceModes?.includes(request.workspaceMode));
    const blockers: AgentRunPreflight['blockers'] = [];
    const warnings: AgentRunPreflight['warnings'] = [];

    if (!provider) blockers.push({ code: 'provider_unknown', field: 'providerId', message: 'Der Provider ist nicht allowlisted.' });
    else if (!provider.available) blockers.push({ code: 'provider_unavailable', field: 'providerId', message: provider.note ?? 'Der Provider ist nicht verfügbar.' });
    if (request.runtimeTarget === 'wsl' && !request.wslDistribution) {
      blockers.push({ code: 'wsl_distribution_required', field: 'wslDistribution', message: 'Für WSL muss eine erkannte Distribution ausgewählt werden.' });
    }
    if (!installation) blockers.push({ code: 'installation_unavailable', field: 'runtimeTarget', message: 'Die ausgewählte Installation ist nicht verfügbar.' });
    else if (installation.support !== 'supported') {
      blockers.push({ code: 'installation_not_supported', field: 'runtimeTarget', message: installation.note ?? 'Diese Installation besitzt keine freigegebene Contract-Fixture.' });
    } else if (installation.authStatus === 'unauthenticated') {
      blockers.push({ code: 'provider_not_authenticated', field: 'providerId', message: installation.note ?? 'Der Provider ist nicht authentifiziert.' });
    }
    if (!workspaceSupported) blockers.push({ code: 'workspace_mode_not_supported', field: 'workspaceMode', message: 'Der Provider erzwingt den angeforderten Workspace-Modus nicht.' });
    if (request.network) blockers.push({ code: 'network_not_enforceable', field: 'network', message: 'Kein freigegebener Provider kann den angeforderten Netzwerkzugriff nachweisbar begrenzen.' });
    if (request.workflowId && !workflow) blockers.push({ code: 'workflow_unknown', field: 'workflowId', message: 'Der Workflow ist nicht versioniert registriert.' });
    if (workflow && workflow.requiredScope !== 'search_profile' && !request.applicationCaseId) {
      blockers.push({ code: 'application_case_required', field: 'applicationCaseId', message: 'Der Workflow benötigt einen expliziten Bewerbungsfall.' });
    } else if (request.applicationCaseId) {
      blockers.push({ code: 'application_case_not_found', field: 'applicationCaseId', message: 'Der Bewerbungsfall wurde nicht gefunden.' });
    }

    const categories: AgentRunPreflight['data']['categories'] = [
      { kind: 'search_preference', availability: 'included', trust: 'local', maxItems: 1 }
    ];
    if (workflow?.id === 'guided-job-analysis') {
      categories.push({ kind: 'job', availability: 'unknown_until_start', trust: 'untrusted', maxItems: 20 });
      warnings.push({
        code: 'trusted_host_search_at_start',
        message: 'Die Jobsuche läuft erst beim Start direkt als Trusted-Host-MCP; der Agent erhält ausschließlich normalisierte Ergebnisse.'
      });
    }

    const outputBytes = request.budget.maxOutputMiB * 1024 * 1024;
    return {
      contract: 'agent-run-preflight',
      contractVersion: '1.0',
      capturedAt: FIXED_TIME,
      ready: blockers.length === 0,
      blockers,
      warnings,
      provider: {
        id: request.providerId,
        name: provider?.name ?? request.providerId,
        available: provider?.available === true,
        ...(installation ? {
          installation: {
            runtimeTarget: installation.runtimeTarget,
            ...(installation.distribution ? { distribution: installation.distribution } : {}),
            ...(installation.version ? { version: installation.version } : {}),
            support: installation.support,
            ...(installation.authStatus ? { authStatus: installation.authStatus } : {})
          }
        } : {}),
        source: 'server_discovery'
      },
      runtime: {
        runtimeTarget: request.runtimeTarget,
        ...(request.wslDistribution ? { distribution: request.wslDistribution } : {}),
        supported: installation?.support === 'supported'
      },
      workspace: { ownership: 'server', mode: request.workspaceMode, supported: workspaceSupported, pathDisclosed: false },
      ...(workflow ? {
        workflow: {
          id: workflow.id,
          version: workflow.version,
          title: workflow.title,
          requiredScope: workflow.requiredScope,
          producesSuggestionsOnly: workflow.producesSuggestionsOnly,
          prohibitedActions: [...workflow.prohibitedActions]
        }
      } : {}),
      data: {
        declaredScope: workflow?.requiredScope ?? 'workspace',
        selectedApplicationCaseCount: 0,
        categories,
        exactSourceCount: null,
        maxContextCharacters: 60_000,
        actualManifestAvailableAfterStart: true
      },
      tools: {
        policy: 'deny_by_default',
        allowedRootMcpTools: [],
        allowlistComplete: true,
        providerTooling: 'sandbox_managed',
        providerToolNamesExposed: false,
        prohibitedActions: workflow ? [...workflow.prohibitedActions] : []
      },
      network: {
        requested: request.network,
        effective: 'disabled',
        enforced: true,
        trustedHostServices: workflow?.id === 'guided-job-analysis'
          ? [{ id: 'job-search-mcp', executionIsolation: 'trusted-host', agentAccessible: false, invocation: 'root_before_agent' }]
          : []
      },
      limits: {
        requested: clone(request.budget),
        effective: {
          wallTimeMs: request.budget.wallTimeMinutes * 60_000,
          idleTimeMs: Math.min(request.budget.wallTimeMinutes * 60_000, 5 * 60_000),
          totalOutputBytes: outputBytes,
          stdoutBytes: Math.floor(outputBytes * 0.8),
          stderrBytes: Math.floor(outputBytes * 0.2),
          maxInputBytes: 256 * 1024
        }
      },
      scheduling: { queueDepth: this.queueSnapshot.depth, active: this.queueSnapshot.active, limits: clone(this.queueSnapshot.limits) }
    };
  }

  private requireRun(runId: string): AgentRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unbekannter Fixture-Run ${runId}`);
    return run;
  }

  private append(runId: string, item: AgentRunEvent): void {
    const events = this.events.get(runId) ?? [];
    events.push(item);
    this.events.set(runId, events);
    const run = this.requireRun(runId);
    run.lastEventSequence = Math.max(run.lastEventSequence ?? 0, item.sequence);
  }

  private async json(route: Route, value: unknown, status = 200): Promise<void> {
    await route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(clone(value)) });
  }
}

export const test = base.extend<{ agentApi: AgentApiStub }>({
  agentApi: async ({ page }, use) => {
    const agentApi = new AgentApiStub();
    await agentApi.install(page);
    await use(agentApi);
    expect(agentApi.unknownRequests, 'Die UI darf nur explizit gestubbte API-Endpunkte verwenden.').toEqual([]);
    expect(agentApi.externalRequests, 'Die Offline-Suite blockiert und meldet jeden externen Request.').toEqual([]);
  }
});

export { expect };
