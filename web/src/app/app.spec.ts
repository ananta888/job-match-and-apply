import { TestBed } from '@angular/core/testing';
import { EMPTY, of } from 'rxjs';
import { App } from './app';
import { ApiService } from './api.service';
import type { AgentRecoveryRun, AgentRun, AgentRunPreflight, AgentRunRequest, AppConfig } from './models';

const config: AppConfig = {
  searchProfile: {
    name: 'Testprofil', query: 'Angular', regions: ['Berlin'], radiusKm: 50,
    workModels: ['hybrid'], employmentTypes: ['full_time'], mustHave: ['TypeScript'],
    niceToHave: ['Angular'], exclude: [], sourceIds: ['stepstone']
  },
  identities: [{
    id: 'demo', label: 'Inkognito', mode: 'incognito', fullName: 'Alex Beispiel',
    email: 'alex@example.invalid', phone: '', location: 'Berlin', linkedin: '', placeholders: {}
  }],
  activeIdentityId: 'demo',
  mcp: {
    mode: 'stdio', executionIsolation: 'trusted-host', runtimeTarget: 'windows', command: 'C:\\synthetic\\job-search-mcp.exe', args: [],
    env: { ALLOW_EXTERNAL_PORTALS: '', JOB_MCP_STATE_DIR: '' }, configuredEnvironmentKeys: ['ALLOW_EXTERNAL_PORTALS', 'JOB_MCP_STATE_DIR']
  },
  assistant: { skillPath: '', candidateProfilePath: '', styleProfilePath: '' }
};

function preflightFixture(request: AgentRunRequest): AgentRunPreflight {
  const guided = request.workflowId === 'guided-job-analysis';
  const outputBytes = request.budget.maxOutputMiB * 1024 * 1024;
  return {
    contract: 'agent-run-preflight', contractVersion: '1.0', capturedAt: '2026-08-14T08:00:00Z',
    ready: true, blockers: [], warnings: guided ? [{ code: 'trusted_host_search_at_start', message: 'Die Jobsuche läuft erst beim Start als Trusted-Host-MCP.' }] : [],
    provider: {
      id: request.providerId, name: 'Codex CLI', available: true, source: 'server_discovery',
      installation: {
        runtimeTarget: request.runtimeTarget, ...(request.wslDistribution ? { distribution: request.wslDistribution } : {}),
        version: request.runtimeTarget === 'wsl' ? '1.1' : '1.0', adapterVersion: 'agent-runner-v1', support: 'supported', authStatus: 'authenticated'
      }
    },
    runtime: { runtimeTarget: request.runtimeTarget, ...(request.wslDistribution ? { distribution: request.wslDistribution } : {}), supported: true },
    workspace: { ownership: 'server', mode: request.workspaceMode, supported: true, pathDisclosed: false },
    ...(guided ? { workflow: {
      id: 'guided-job-analysis' as const, version: '1.0.0', title: 'Geführte Stellenanalyse', requiredScope: 'search_profile' as const,
      producesSuggestionsOnly: true as const, prohibitedActions: ['submit_application']
    } } : {}),
    data: {
      declaredScope: guided ? 'search_profile' : 'workspace', selectedApplicationCaseCount: 0,
      categories: guided
        ? [
            { kind: 'search_preference', availability: 'included', trust: 'local', maxItems: 1 },
            { kind: 'job', availability: 'unknown_until_start', trust: 'untrusted', maxItems: 20 }
          ]
        : [{ kind: 'search_preference', availability: 'included', trust: 'local', maxItems: 1 }],
      exactSourceCount: null, maxContextCharacters: 60_000, actualManifestAvailableAfterStart: true
    },
    tools: {
      policy: 'deny_by_default', allowedRootMcpTools: [], allowlistComplete: true,
      providerTooling: 'sandbox_managed', providerToolNamesExposed: false,
      prohibitedActions: guided ? ['submit_application'] : []
    },
    network: {
      requested: request.network, effective: 'disabled', enforced: true,
      trustedHostServices: guided ? [{ id: 'job-search-mcp', executionIsolation: 'trusted-host', agentAccessible: false, invocation: 'root_before_agent' }] : []
    },
    limits: {
      requested: { ...request.budget },
      effective: {
        wallTimeMs: request.budget.wallTimeMinutes * 60_000,
        idleTimeMs: Math.min(request.budget.wallTimeMinutes, 5) * 60_000,
        totalOutputBytes: outputBytes, stdoutBytes: Math.floor(outputBytes * 0.8), stderrBytes: Math.floor(outputBytes * 0.2), maxInputBytes: 256 * 1024
      }
    },
    scheduling: {
      queueDepth: 0, active: 0,
      limits: { global: 2, perProvider: 1, perWorkspace: 1, perOwner: 1, queuedGlobal: 20, queuedPerWorkspace: 5, queuedPerOwner: 5 }
    }
  };
}

describe('App', () => {
  let apiMock: Record<string, ReturnType<typeof vi.fn>>;
  const agentRun: AgentRun = {
    id: 'run-1', providerId: 'codex', status: 'waiting_for_approval',
    request: { providerId: 'codex', prompt: 'Prüfe den Bewerbungsfall', runtimeTarget: 'windows', workspaceMode: 'read_only', network: false, budget: { wallTimeMinutes: 30, maxOutputMiB: 10 } },
    createdAt: '2026-08-13T18:00:00Z', updatedAt: '2026-08-13T18:01:00Z',
    pendingApprovals: [{ id: 'approval-1', kind: 'workspace_write', title: 'Datei ändern', risk: 'medium', expectedRevision: 3, status: 'pending' }],
    usage: { inputTokens: 120, outputTokens: 30, toolCalls: 1, durationMs: 2500 }, lastEventSequence: 3
  };

  beforeEach(async () => {
    apiMock = {
      config: vi.fn().mockReturnValue(of(structuredClone(config))),
      sources: vi.fn().mockReturnValue(of([])),
      sourceRuntime: vi.fn().mockReturnValue(of({
        contract: 'job-search-mcp-runtime-status', contractVersion: '1.0', mode: 'stdio', state: 'ready_to_connect',
        runtimeTarget: 'windows', launchValidated: true, connected: false, note: 'Synthetischer Startpfad ist validiert.'
      })),
      capabilities: vi.fn().mockReturnValue(of({ contract: 'job-search-mcp', contractVersion: '1.0', compatible: true, tools: [], errorCategories: [], sources: [] })),
      candidateProfile: vi.fn().mockReturnValue(of({ contractVersion: '1.0', valid: true, errors: [], profile: {}, claims: [] })),
      applicationCases: vi.fn().mockReturnValue(of([])),
      jobDecisions: vi.fn().mockReturnValue(of([])),
      dataInventory: vi.fn().mockReturnValue(of({ generatedAt: '2026-01-01T00:00:00Z', stores: [] })),
      schedules: vi.fn().mockReturnValue(of([])),
      saveConfig: vi.fn().mockImplementation((value) => of(structuredClone(value))),
      setMcpPortalAccess: vi.fn().mockImplementation(() => of(structuredClone(config))),
      assistantStatus: vi.fn().mockReturnValue(of({ available: false, note: 'Test' })),
      agentProviders: vi.fn().mockReturnValue(of([{
        id: 'codex', name: 'Codex CLI', available: true, version: '1.0', authStatus: 'authenticated',
        installations: [
          { runtimeTarget: 'windows', version: '1.0', support: 'supported', authStatus: 'authenticated', note: 'Windows-Anmeldung aktiv', executable: 'C:\\tools\\codex.exe' },
          { runtimeTarget: 'wsl', distribution: 'Ubuntu-24.04', version: '1.1', support: 'supported', authStatus: 'authenticated', note: 'WSL-Anmeldung aktiv', executable: '/usr/local/bin/codex' }
        ]
      }])),
      agentWorkflows: vi.fn().mockReturnValue(of([])),
      agentQueue: vi.fn().mockReturnValue(of({
        capturedAt: '2026-08-14T08:00:00Z', depth: 0, active: 0,
        limits: { global: 2, perProvider: 1, perWorkspace: 1, perOwner: 1, queuedGlobal: 20, queuedPerWorkspace: 5, queuedPerOwner: 5 },
        activeByProvider: {}, activeByWorkspace: {}, activeByOwner: {}, queue: []
      })),
      agentRecovery: vi.fn().mockReturnValue(of({ runs: [] })),
      agentRuns: vi.fn().mockReturnValue(of([])),
      agentRun: vi.fn().mockReturnValue(of(agentRun)),
      agentRunEvents: vi.fn().mockReturnValue(of({ events: [], nextAfter: 0 })),
      agentRunEventStream: vi.fn().mockReturnValue(EMPTY),
      agentRunPreflight: vi.fn().mockImplementation((request: AgentRunRequest) => of(preflightFixture(request))),
      createAgentRun: vi.fn().mockReturnValue(of({ ...agentRun, status: 'queued', pendingApprovals: [] })),
      decideAgentApproval: vi.fn().mockReturnValue(of({ ...agentRun, status: 'running', pendingApprovals: [] })),
      cancelAgentRun: vi.fn().mockReturnValue(of({ ...agentRun, status: 'cancelling' })),
      sendAgentInput: vi.fn().mockReturnValue(of({ ...agentRun, status: 'running' })),
      exportAgentRun: vi.fn().mockReturnValue(of({ run: agentRun, redacted: true })),
      acquireAgentRecoveryLease: vi.fn().mockReturnValue(of({
        runId: 'run-orphan', leaseId: '11111111-1111-4111-8111-111111111111', operatorId: 'local-user',
        acquiredAt: '2026-08-14T08:00:00Z', expiresAt: '2099-08-14T08:05:00Z'
      })),
      resolveAgentRecovery: vi.fn().mockReturnValue(of({ resolved: { ...agentRun, id: 'run-orphan', status: 'cancelled', pendingApprovals: [] } }))
    };
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: ApiService, useValue: apiMock }]
    }).compileComponents();
  });

  it('creates the workspace and renders the overview', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance).toBeTruthy();
    expect(compiled.querySelector('h1')?.textContent).toContain('Guten Tag');
    expect(compiled.textContent).toContain('Testprofil');
  });

  it('provides a keyboard skip target, live regions and labelled controls in every workspace section', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('a.skip-link')?.getAttribute('href')).toBe('#main-content');
    expect(element.querySelector('main')?.getAttribute('tabindex')).toBe('-1');
    for (const section of ['search', 'identity', 'sources', 'applications', 'agents', 'operations'] as const) {
      fixture.componentInstance.select(section); fixture.detectChanges(); await fixture.whenStable();
      for (const control of element.querySelectorAll('input, select, textarea')) {
        expect(Boolean(control.closest('label') || control.getAttribute('aria-label') || control.getAttribute('aria-labelledby')), `${section}: ${control.outerHTML}`).toBe(true);
      }
      for (const button of element.querySelectorAll('button')) {
        expect(Boolean(button.textContent?.trim() || button.getAttribute('aria-label'))).toBe(true);
      }
    }
  });

  it('uses runtime diagnostics instead of mode and exposes no free MCP launch or environment inputs', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.select('sources'); fixture.detectChanges(); await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const panel = element.querySelector('[data-testid="mcp-runtime-panel"]') as HTMLElement;
    expect(panel.textContent).toContain('Startpfad bereit');
    expect(panel.textContent).toContain('Windows');
    expect(panel.textContent).toContain('Startvalidierung');
    expect(panel.textContent).toContain('Nicht verbunden');
    expect(panel.textContent).toContain('ALLOW_EXTERNAL_PORTALS');
    expect(panel.textContent).toContain('JOB_MCP_STATE_DIR');
    expect(panel.querySelectorAll('input, select')).toHaveLength(0);
    expect(element.textContent).toContain('Vertrauenswürdiger Hostprozess');
    fixture.destroy();
  });

  it('preserves redacted server environment keys on normal config saves', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentInstance.config!.mcp.env['ALLOW_EXTERNAL_PORTALS'] = 'synthetic-value-that-must-not-leave-the-ui';
    fixture.componentInstance.saveConfig('Synthetisch gespeichert.');
    expect(apiMock['saveConfig']).toHaveBeenCalledTimes(1);
    const submitted = apiMock['saveConfig'].mock.calls[0][0] as AppConfig;
    expect(submitted.mcp.env).toEqual({ ALLOW_EXTERNAL_PORTALS: '', JOB_MCP_STATE_DIR: '' });
    expect(submitted.mcp.configuredEnvironmentKeys).toEqual(['ALLOW_EXTERNAL_PORTALS', 'JOB_MCP_STATE_DIR']);
    expect(submitted.mcp.command).toBe('C:\\synthetic\\job-search-mcp.exe');
    expect(fixture.componentInstance.notice).toBe('Synthetisch gespeichert.');
    fixture.destroy();
  });

  it('renders the complete server-owned guided preflight without leaking draft or runtime details', async () => {
    apiMock['agentWorkflows'].mockReturnValue(of([{
      id: 'guided-job-analysis', version: '1.0.0', title: 'Geführte Stellenanalyse',
      description: 'Synthetische Stellenanalyse.', requiredScope: 'search_profile',
      producesSuggestionsOnly: true, prohibitedActions: ['submit_application']
    }]));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentInstance.select('agents'); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.setAgentWorkflow('guided-job-analysis');
    component.setAgentPrompt('Synthetische Stellen serverseitig vorprüfen');
    component.refreshAgentPreflight();
    fixture.detectChanges();
    const preflight = (fixture.nativeElement as HTMLElement).querySelector('.agent-preflight') as HTMLElement;
    expect(preflight.querySelectorAll('[data-preflight-field]')).toHaveLength(9);
    expect(preflight.querySelector('[data-preflight-field="provider"]')?.textContent).toContain('Codex CLI');
    expect(preflight.querySelector('[data-preflight-field="provider"]')?.textContent).toContain('angemeldet');
    expect(preflight.querySelector('[data-preflight-field="runtime"]')?.textContent).toContain('Windows');
    expect(preflight.querySelector('[data-preflight-field="workspace"]')?.textContent).toContain('Serverseitiger Projektbereich');
    expect(preflight.querySelector('[data-preflight-field="workspace"]')?.textContent).toContain('Pfad offengelegt: nein');
    expect(preflight.querySelector('[data-preflight-field="data"]')?.textContent).toContain('Suchprofil');
    expect(preflight.querySelector('[data-preflight-field="data"]')?.textContent).toContain('Stelle · Anzahl erst beim Start · max. 20 · untrusted');
    expect(preflight.querySelector('[data-preflight-field="tools"]')?.textContent).toContain('Keine Root-MCP-Tools freigegeben');
    expect(preflight.querySelector('[data-preflight-field="tools"]')?.textContent).toContain('Allowlist vollständig');
    expect(preflight.querySelector('[data-preflight-field="network"]')?.textContent).toContain('Agent offline');
    expect(preflight.querySelector('[data-preflight-field="limits"]')?.textContent).toContain('30 Min · 10 MiB angefordert');
    expect(preflight.querySelector('[data-preflight-field="limits"]')?.textContent).toContain('Eingabe 256 KiB');
    expect(preflight.querySelector('[data-preflight-field="scheduling"]')?.textContent).toContain('aktiv 0/2');
    expect(preflight.textContent).toContain('Jobsuche läuft im separaten Trusted-Host-MCP');
    expect(preflight.textContent).toContain('Agent bleibt offline/sandboxed');
    expect(preflight.textContent).toContain('Portalzugriff gemäß explizitem Server-Gate');
    expect(preflight.textContent).not.toContain('Synthetische Stellen serverseitig vorprüfen');
    expect(preflight.textContent).not.toContain('C:\\tools\\codex.exe');
    expect(apiMock['agentRunPreflight']).toHaveBeenLastCalledWith({
      providerId: 'codex', prompt: 'Synthetische Stellen serverseitig vorprüfen', runtimeTarget: 'windows',
      workspaceMode: 'read_only', network: false, workflowId: 'guided-job-analysis',
      budget: { wallTimeMinutes: 30, maxOutputMiB: 10 }
    });
    expect(apiMock['createAgentRun']).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('changes portal access only through the dedicated confirmed endpoint', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.openPortalPermissionDialog('enable');
    expect(component.portalPermissionIntent).toBe('enable');
    component.confirmPortalPermission();
    expect(apiMock['setMcpPortalAccess']).not.toHaveBeenCalled();
    component.portalPermissionConfirmed = true;
    component.confirmPortalPermission();
    expect(apiMock['setMcpPortalAccess']).toHaveBeenCalledWith(true);
    expect(apiMock['saveConfig']).not.toHaveBeenCalled();
    expect(component.notice).toContain('ALLOW_EXTERNAL_PORTALS=1');
    expect(component.config?.mcp.env).toEqual({ ALLOW_EXTERNAL_PORTALS: '', JOB_MCP_STATE_DIR: '' });
    fixture.destroy();
  });

  it('blocks portal enable when runtime diagnostics are invalid even if config mode is stdio', async () => {
    apiMock['sourceRuntime'].mockReturnValue(of({
      contract: 'job-search-mcp-runtime-status', contractVersion: '1.0', mode: 'stdio', state: 'invalid',
      launchValidated: false, connected: false, note: 'synthetic_runtime_invalid'
    }));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.openPortalPermissionDialog('enable');
    expect(component.portalPermissionIntent).toBeUndefined();
    expect(component.error).toContain('validierten oder verbundenen');
    expect(apiMock['setMcpPortalAccess']).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('starts provider-controlled runs with safe defaults and no executable input', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentInstance.select('agents'); fixture.detectChanges(); await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Eine sichere Oberfläche für alle Agenten');
    expect(element.querySelector('[name="executable"], [name="arguments"]')).toBeNull();
    expect(fixture.componentInstance.agentRunForm.workspaceMode).toBe('read_only');
    expect(fixture.componentInstance.agentRunForm.network).toBe(false);
    fixture.componentInstance.setAgentPrompt('Analysiere den lokalen Teststand');
    fixture.componentInstance.refreshAgentPreflight();
    fixture.componentInstance.createAgentRun();
    expect(apiMock['createAgentRun']).toHaveBeenCalledWith({
      providerId: 'codex', prompt: 'Analysiere den lokalen Teststand', runtimeTarget: 'windows', workspaceMode: 'read_only', network: false,
      budget: { wallTimeMinutes: 30, maxOutputMiB: 10 }
    });
    fixture.destroy();
  });

  it('selects an explicit WSL installation and summarizes the start configuration', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentInstance.select('agents'); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Installation und Laufzeit');
    expect(element.textContent).toContain('Konfiguration vor dem Start');
    expect(element.textContent).toContain('Windows-Anmeldung aktiv');
    component.selectAgentInstallation('wsl:Ubuntu-24.04');
    component.setAgentPrompt('Analysiere den lokalen Teststand');
    component.refreshAgentPreflight();
    fixture.detectChanges();
    expect(element.querySelector('.agent-preflight')?.textContent).toContain('WSL · Ubuntu-24.04');
    expect(element.querySelector('.agent-preflight')?.textContent).toContain('Serverseitiger Projektbereich · Nur lesen');
    expect(element.querySelector('.agent-preflight')?.textContent).toContain('30 Min · 10 MiB angefordert');
    component.createAgentRun();
    expect(apiMock['createAgentRun']).toHaveBeenLastCalledWith({
      providerId: 'codex', prompt: 'Analysiere den lokalen Teststand', runtimeTarget: 'wsl', wslDistribution: 'Ubuntu-24.04',
      workspaceMode: 'read_only', network: false, budget: { wallTimeMinutes: 30, maxOutputMiB: 10 }
    });
    fixture.destroy();
  });

  it('blocks start on the current server preflight and invalidates it when the draft changes', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentInstance.select('agents'); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.setAgentPrompt('Prüfung mit bewusstem Serverblocker');
    apiMock['agentRunPreflight'].mockImplementation((request: AgentRunRequest) => of({
      ...preflightFixture(request), ready: false,
      blockers: [{ code: 'emergency_stop', message: 'Der Emergency Stop blockiert neue Agentenläufe.' }]
    }));
    component.refreshAgentPreflight(); fixture.detectChanges();
    const start = (fixture.nativeElement as HTMLElement).querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect((fixture.nativeElement as HTMLElement).querySelector('[aria-label="Blocker der Startprüfung"]')?.textContent).toContain('Emergency Stop');
    component.createAgentRun();
    expect(apiMock['createAgentRun']).not.toHaveBeenCalled();
    expect(component.error).toContain('Emergency Stop');

    component.setAgentOutputLimit(9);
    fixture.detectChanges();
    expect(component.agentPreflight).toBeUndefined();
    expect(start.disabled).toBe(true);
    fixture.destroy();
  });

  it('renders approvals as explicit approve and deny decisions', async () => {
    apiMock['agentRuns'].mockReturnValue(of([agentRun]));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentInstance.select('agents'); fixture.detectChanges(); await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Offene Entscheidungen aller Runs');
    expect(element.textContent).toContain('Ausdrücklich freigeben');
    expect(element.textContent).toContain('Ablehnen');
    fixture.componentInstance.decideAgentApproval(agentRun.pendingApprovals![0], 'deny');
    expect(apiMock['decideAgentApproval']).toHaveBeenCalledWith('run-1', 'approval-1', 'deny', 3);
    fixture.destroy();
  });

  it('keeps a large canonical timeline while rendering and loading fixed-size windows', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    const events = Array.from({ length: 450 }, (_, index) => ({
      sequence: index + 1, type: index % 2 ? 'tool_output' : 'agent_message_completed',
      timestamp: '2026-08-13T18:00:00Z', level: index % 25 === 0 ? 'warning' as const : 'info' as const,
      message: index === 24 ? 'gesuchtes Ereignis' : `Fixture-Ereignis ${index + 1}`
    }));
    component.section = 'agents'; component.selectedAgentRun = { ...agentRun, status: 'running', pendingApprovals: [], lastEventSequence: 450 };
    apiMock['agentRunEvents'].mockReturnValue(of({ events, nextAfter: 450 }));
    component.refreshAgentEvents();
    expect(component.agentEvents).toHaveLength(450);
    expect(component.renderedAgentTimelineEntries()).toHaveLength(100);
    expect(component.hiddenAgentTimelineEntriesCount()).toBe(350);
    component.loadOlderAgentEvents();
    expect(component.renderedAgentTimelineEntries()).toHaveLength(200);
    component.agentEventSearch = 'gesuchtes Ereignis';
    expect(component.renderedAgentTimelineEntries().map((item) => item.sequence)).toEqual([25]);
    component.agentEventSearch = ''; component.agentEventTypeFilter = 'tool_output';
    expect(component.agentTimelineEntries().every((item) => item.type === 'tool_output')).toBe(true);

    component.agentEventTypeFilter = 'all'; component.toggleAgentTimelinePause();
    apiMock['agentRunEvents'].mockReturnValue(of({ events: [{ sequence: 451, type: 'warning', timestamp: '2026-08-13T18:02:00Z', level: 'warning', message: 'Während Pause gepuffert' }], nextAfter: 451 }));
    component.refreshAgentEvents();
    expect(component.agentEvents).toHaveLength(451);
    expect(component.bufferedAgentEventsCount()).toBe(1);
    expect(component.agentTimelineEntries().some((item) => item.sequence === 451)).toBe(false);
    component.toggleAgentTimelinePause();
    expect(component.agentTimelineEntries().some((item) => item.sequence === 451)).toBe(true);
    apiMock['agentRunEvents'].mockReturnValue(of({ events: [
      { sequence: 452, type: 'agent_message_delta', timestamp: '2026-08-13T18:03:00Z', level: 'info', correlationId: 'delta-group', message: 'Teil A' },
      { sequence: 453, type: 'agent_message_delta', timestamp: '2026-08-13T18:03:01Z', level: 'info', correlationId: 'delta-group', message: ' + Teil B' }
    ], nextAfter: 453 }));
    component.refreshAgentEvents();
    expect(component.agentEvents).toHaveLength(453);
    expect(component.agentTimelineEntries().at(-1)).toMatchObject({ sequence: 452, sequenceEnd: 453, groupedCount: 2, text: 'Teil A + Teil B' });
    fixture.destroy();
  });

  it('blocks expired, stale and targetless high-risk approvals across all runs', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    const expired: AgentRun = { ...structuredClone(agentRun), id: 'run-expired', lastEventSequence: 3, pendingApprovals: [{ ...agentRun.pendingApprovals![0], id: 'expired', expiresAt: '2000-01-01T00:00:00Z' }] };
    const stale: AgentRun = { ...structuredClone(agentRun), id: 'run-stale', lastEventSequence: 4, pendingApprovals: [{ ...agentRun.pendingApprovals![0], id: 'stale', expectedRevision: 3 }] };
    const targetless: AgentRun = { ...structuredClone(agentRun), id: 'run-targetless', lastEventSequence: 3, pendingApprovals: [{ ...agentRun.pendingApprovals![0], id: 'targetless', risk: 'destructive', expectedRevision: 3 }] };
    component.agentRuns = [expired, stale, targetless];
    expect(component.globalAgentApprovals()).toHaveLength(3);
    expect(component.globalAgentApprovals().every((item) => !item.actionable)).toBe(true);
    component.decideAgentApproval(stale.pendingApprovals![0], 'approve', stale);
    expect(apiMock['decideAgentApproval']).not.toHaveBeenCalled();
    expect(component.error).toContain('fortgeschritten');
    fixture.destroy();
  });

  it('masks sensitive answers and states the plaintext transport boundary', async () => {
    const waitingRun: AgentRun = { ...structuredClone(agentRun), status: 'waiting_for_input', pendingApprovals: [] };
    apiMock['agentRuns'].mockReturnValue(of([waitingRun]));
    apiMock['agentRun'].mockReturnValue(of(waitingRun));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentInstance.select('agents'); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentInstance.agentInputSensitive = true; fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector<HTMLInputElement>('#agent-user-input')?.type).toBe('password');
    expect(element.textContent).toContain('Nur die Anzeige ist maskiert');
    expect(element.textContent).toContain('im Klartext an den lokalen Agentenprozess');
    fixture.destroy();
  });

  it('redacts configured identity, paths, email, phone and secrets before copy', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const redacted = fixture.componentInstance.redactAgentText('Alex Beispiel alex@example.invalid C:\\tools\\codex.exe token=very-secret +49 170 1234567');
    expect(redacted).not.toContain('Alex Beispiel');
    expect(redacted).not.toContain('alex@example.invalid');
    expect(redacted).not.toContain('C:\\tools\\codex.exe');
    expect(redacted).not.toContain('very-secret');
    expect(redacted).not.toContain('1234567');
    expect(redacted).toContain('REDIGIERT');
    fixture.destroy();
  });

  it('prepares a lineage-preserving replay and compares version, policy, context, usage and result', async () => {
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    const parent: AgentRun = { ...structuredClone(agentRun), id: 'run-parent', status: 'succeeded', pendingApprovals: [], output: 'Ergebnis A', providerVersion: '1.0', workflowVersion: '1.0', policyVersion: '1.0', contextSummary: { scope: 'case-a', sourceCount: 2, redactedHash: 'abcdef0123456789' } };
    const child: AgentRun = { ...structuredClone(parent), id: 'run-child', parentRunId: parent.id, status: 'failed', output: 'Ergebnis B', request: { ...parent.request, workspaceMode: 'workspace_write' }, usage: { inputTokens: 140, outputTokens: 20, toolCalls: 2, durationMs: 4000 } };
    component.agentRuns = [child, parent]; component.selectedAgentRun = child;
    const sections = component.agentRunComparison(child);
    expect(sections.map((section) => section.id)).toEqual(['lineage', 'versions', 'policy', 'context', 'usage', 'result']);
    expect(sections.find((section) => section.id === 'policy')?.rows.some((row) => row.changed)).toBe(true);
    expect(sections.find((section) => section.id === 'result')?.rows.some((row) => row.changed)).toBe(true);
    component.loadAgentReplayTemplate();
    expect(component.agentRunForm.parentRunId).toBe('run-child');
    expect(apiMock['createAgentRun']).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('renders queue limits, scoped activity, priority aging and block reasons from the diagnostic endpoint', async () => {
    const orphan: AgentRun = { ...structuredClone(agentRun), id: 'run-orphan', status: 'orphaned', pendingApprovals: [], lastEventSequence: 7 };
    const recovery: AgentRecoveryRun = {
      runId: orphan.id, state: 'orphaned', provider: 'codex', providerSessionPresent: true,
      processAdoptionAllowed: false, allowedDecisions: ['cleanup', 'resume']
    };
    apiMock['agentRuns'].mockReturnValue(of([orphan]));
    apiMock['agentRun'].mockReturnValue(of(orphan));
    apiMock['agentQueue'].mockReturnValue(of({
      capturedAt: '2026-08-14T08:00:00Z', depth: 1, active: 2,
      limits: { global: 3, perProvider: 1, perWorkspace: 1, perOwner: 2, queuedGlobal: 12, queuedPerWorkspace: 4, queuedPerOwner: 3 },
      activeByProvider: { codex: 1 }, activeByWorkspace: { 'X:\\Synthetic\\Workspace': 1 }, activeByOwner: { 'fixture-owner': 1 },
      queue: [{
        runId: 'queued-fixture', provider: 'codex', workspaceRoot: 'X:\\Synthetic\\Workspace', ownerId: 'fixture-owner',
        position: 1, basePriority: 20, effectivePriority: 35, waitMs: 65_000, blockedBy: ['provider_limit', 'workspace_limit']
      }]
    }));
    apiMock['agentRecovery'].mockReturnValue(of({ runs: [recovery] }));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentInstance.select('agents'); fixture.detectChanges(); await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[data-testid="agent-queue-diagnostics"]')?.textContent).toContain('2/3');
    expect(element.textContent).toContain('X:\\Synthetic\\Workspace');
    expect(element.textContent).toContain('Effektiv');
    expect(element.textContent).toContain('+35');
    expect(element.textContent).toContain('Provider-Limit');
    expect(element.textContent).toContain('Keine Prozess-Adoption');
    expect(element.textContent).toContain('Operator-Lease übernehmen');
    fixture.destroy();
  });

  it('binds recovery decisions to the local lease, explicit dialog confirmation and expected revision', async () => {
    const orphan: AgentRun = { ...structuredClone(agentRun), id: 'run-orphan', status: 'orphaned', pendingApprovals: [], lastEventSequence: 7 };
    const recovery: AgentRecoveryRun = {
      runId: orphan.id, state: 'orphaned', provider: 'codex', providerSessionPresent: false,
      processAdoptionAllowed: false, allowedDecisions: ['cleanup', 'resume']
    };
    const lease = {
      runId: orphan.id, leaseId: '11111111-1111-4111-8111-111111111111', operatorId: 'local-user',
      acquiredAt: '2026-08-14T08:00:00Z', expiresAt: '2099-08-14T08:05:00Z'
    };
    const recoveryWithLease: AgentRecoveryRun = { ...recovery, lease: {
      runId: orphan.id, operatorId: lease.operatorId, acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt
    } };
    apiMock['acquireAgentRecoveryLease'].mockReturnValue(of(lease));
    apiMock['agentRecovery'].mockReturnValue(of({ runs: [recoveryWithLease] }));
    apiMock['agentRuns'].mockReturnValue(of([orphan]));
    apiMock['resolveAgentRecovery'].mockReturnValue(of({ resolved: { ...orphan, status: 'cancelled' } }));
    const fixture = TestBed.createComponent(App); fixture.detectChanges(); await fixture.whenStable();
    const component = fixture.componentInstance;
    component.agentRuns = [orphan];
    const foreignRecovery: AgentRecoveryRun = { ...recovery, lease: {
      runId: orphan.id, operatorId: 'other-operator', acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt
    } };
    component.agentRecoveryRuns = [foreignRecovery];
    component.openAgentRecoveryDialog(foreignRecovery, 'cleanup');
    expect(component.agentRecoveryDialog).toBeUndefined();
    expect(component.error).toContain('keine Lease-ID');
    expect(apiMock['resolveAgentRecovery']).not.toHaveBeenCalled();

    component.error = ''; component.agentRecoveryRuns = [recovery];
    component.acquireAgentRecoveryLease(recovery);
    expect(apiMock['acquireAgentRecoveryLease']).toHaveBeenCalledWith('run-orphan', 7);
    expect(component.agentRecoveryLeaseFor('run-orphan')).toEqual(lease);

    component.agentRecoveryRuns = [recoveryWithLease];
    component.openAgentRecoveryDialog(recoveryWithLease, 'cleanup');
    expect(component.agentRecoveryDialog).toMatchObject({ runId: 'run-orphan', decision: 'cleanup', expectedRevision: 7, leaseId: lease.leaseId });
    component.confirmAgentRecovery();
    expect(apiMock['resolveAgentRecovery']).not.toHaveBeenCalled();
    component.agentRecoveryConfirmed = true;
    component.confirmAgentRecovery();
    expect(apiMock['resolveAgentRecovery']).toHaveBeenCalledWith('run-orphan', {
      expectedRevision: 7, leaseId: lease.leaseId, decision: 'cleanup'
    });
    expect(component.notice).toContain('expliziter Operatorentscheidung');
    fixture.destroy();
  });
});
