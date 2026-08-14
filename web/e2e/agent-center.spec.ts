import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './support/agent-api.fixture';

async function openAgentCenter(page: Page): Promise<void> {
  await page.goto('/');
  const navigation = page.locator('nav[aria-label="Hauptnavigation"] button').filter({ hasText: 'Agent Center' });
  await expect(navigation).toBeVisible();
  await navigation.click();
  await expect(page.getByRole('heading', { name: 'Eine sichere Oberfläche für alle Agenten', exact: true })).toBeVisible();
  await expect(page.locator('.agent-provider').getByRole('heading', { name: 'Synthetischer Offline-Agent', exact: true })).toBeVisible();
}

async function openSources(page: Page): Promise<void> {
  await page.goto('/');
  const navigation = page.locator('nav[aria-label="Hauptnavigation"] button').filter({ hasText: 'Quellen & MCP' });
  await expect(navigation).toBeVisible();
  await navigation.click();
  await expect(page.getByRole('heading', { name: 'Quellen & MCP verwalten', exact: true })).toBeVisible();
}

test.describe('Agent Center – offline browser contract', () => {
  test('keeps redacted MCP settings read-only and changes portal access only through the confirmed gate', async ({ page, agentApi }) => {
    agentApi.seedReadyMcpRuntime();
    await openSources(page);

    await expect(page.locator('.top-actions .mode-pill')).toHaveText(/Startpfad bereit/);
    const panel = page.getByTestId('mcp-runtime-panel');
    await expect(panel).toContainText('Windows');
    await expect(panel).toContainText('Bestätigt');
    await expect(panel).toContainText('Nicht verbunden');
    await expect(panel).toContainText('ALLOW_EXTERNAL_PORTALS');
    await expect(panel).toContainText('JOB_MCP_STATE_DIR');
    await expect(panel.locator('input, select, textarea')).toHaveCount(0);
    await expect(panel).toHaveScreenshot('mcp-runtime-security.png');

    const panelA11y = await new AxeBuilder({ page }).include('[data-testid="mcp-runtime-panel"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(panelA11y.violations, panelA11y.violations.map((item) => `${item.id}: ${item.help}`).join('\n')).toEqual([]);

    await page.locator('.top-actions').getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect.poll(() => agentApi.configSaveRequests.length).toBe(1);
    expect(agentApi.configSaveRequests[0].mcp.env).toEqual({ ALLOW_EXTERNAL_PORTALS: '', JOB_MCP_STATE_DIR: '' });
    expect(agentApi.configSaveRequests[0].mcp.configuredEnvironmentKeys).toEqual(['ALLOW_EXTERNAL_PORTALS', 'JOB_MCP_STATE_DIR']);

    await panel.getByRole('button', { name: 'Portalzugriff freigeben', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const confirmation = dialog.locator('input[type="checkbox"]');
    await expect(confirmation).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Portalzugriff verbindlich freigeben', exact: true })).toBeDisabled();
    expect(agentApi.portalAccessRequests).toHaveLength(0);
    const dialogA11y = await new AxeBuilder({ page }).include('.portal-permission-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(dialogA11y.violations, dialogA11y.violations.map((item) => `${item.id}: ${item.help}`).join('\n')).toEqual([]);
    await confirmation.check();
    await dialog.getByRole('button', { name: 'Portalzugriff verbindlich freigeben', exact: true }).click();
    await expect.poll(() => agentApi.portalAccessRequests.length).toBe(1);
    expect(agentApi.portalAccessRequests[0]).toEqual({ enabled: true, confirmed: true });
    expect(agentApi.configSaveRequests).toHaveLength(1);
    await expect(page.getByRole('status').filter({ hasText: 'ALLOW_EXTERNAL_PORTALS=1' })).toBeVisible();
  });

  test('uses the runtime endpoint fail-closed when a stdio start path is invalid', async ({ page, agentApi }) => {
    agentApi.seedInvalidMcpRuntime();
    await openSources(page);
    await expect(page.locator('.top-actions .mode-pill')).toHaveText(/Runtime ungültig/);
    const panel = page.getByTestId('mcp-runtime-panel');
    await expect(panel).toContainText('Der synthetische Startpfad ist absichtlich ungültig.');
    await expect(panel.getByRole('button', { name: 'Portalzugriff freigeben', exact: true })).toBeDisabled();
    await expect(panel).toContainText('Fail-closed:');
    expect(agentApi.portalAccessRequests).toHaveLength(0);
  });

  test('starts a WSL run with safe defaults and renders live events', async ({ page, agentApi }) => {
    await openAgentCenter(page);

    await page.locator('select[name="agentRuntime"]').selectOption('wsl:E2E-Ubuntu');
    await page.locator('textarea[name="agentPrompt"]').fill('Synthetischen Agentenlauf kontrolliert starten');
    const start = page.getByRole('button', { name: 'Run kontrolliert starten', exact: true });
    await expect(start).toBeEnabled();
    await expect.poll(() => agentApi.preflightRequests.length).toBe(1);
    await start.click();

    await expect.poll(() => agentApi.createRequests.length).toBe(1);
    expect(agentApi.createRequests[0]).toEqual({
      providerId: 'fake-interactive', prompt: 'Synthetischen Agentenlauf kontrolliert starten',
      runtimeTarget: 'wsl', wslDistribution: 'E2E-Ubuntu', workspaceMode: 'read_only', network: false,
      budget: { wallTimeMinutes: 30, maxOutputMiB: 10 }
    });
    await expect(page.getByRole('status').filter({ hasText: 'wurde sicher eingereiht' })).toBeVisible();
    await expect(page.locator('.run-status')).toHaveText('Läuft');
    await expect(page.getByText('Live-Ausgabe aus dem synthetischen Eventstream.', { exact: true })).toBeVisible();
    await expect(page.locator('.agent-context').getByText('WSL · E2E-Ubuntu', { exact: true })).toBeVisible();
  });

  test('shows the complete server-owned guided preflight without starting tools or network access', async ({ page, agentApi }) => {
    await openAgentCenter(page);
    await page.locator('select[name="agentRuntime"]').selectOption('wsl:E2E-Ubuntu');
    await page.locator('select[name="agentWorkflow"]').selectOption('guided-job-analysis');
    const prompt = 'Synthetische Stellen vor dem Start sicher analysieren';
    await page.locator('textarea[name="agentPrompt"]').fill(prompt);

    const preflight = page.getByTestId('agent-preflight');
    await expect(preflight.locator('[data-preflight-field]')).toHaveCount(9);
    await expect(preflight.locator('[data-preflight-field="provider"]')).toContainText('Synthetischer Offline-Agent');
    await expect(preflight.locator('[data-preflight-field="provider"]')).toContainText('v1.0.0 · kein Login nötig · unterstützt');
    await expect(preflight.locator('[data-preflight-field="runtime"]')).toContainText('WSL · E2E-Ubuntu');
    await expect(preflight.locator('[data-preflight-field="runtime"]')).toContainText('Unterstützte erkannte Installation');
    await expect(preflight.locator('[data-preflight-field="workspace"]')).toContainText('Serverseitiger Projektbereich · Nur lesen');
    await expect(preflight.locator('[data-preflight-field="workspace"]')).toContainText('Pfad offengelegt: nein');
    await expect(preflight.locator('[data-preflight-field="data"]')).toContainText('Suchprofil · 0 ausgewählter Fall');
    await expect(preflight.locator('[data-preflight-field="data"]')).toContainText('Suchpräferenz · enthalten · max. 1');
    await expect(preflight.locator('[data-preflight-field="data"]')).toContainText('Stelle · Anzahl erst beim Start · max. 20 · untrusted');
    await expect(preflight.locator('[data-preflight-field="data"]')).toContainText('Exakte Quellenzahl: erst nach Start · Kontextlimit 60000 Zeichen');
    await expect(preflight.locator('[data-preflight-field="tools"]')).toContainText('Keine Root-MCP-Tools freigegeben');
    await expect(preflight.locator('[data-preflight-field="tools"]')).toContainText('Deny-by-default · Allowlist vollständig');
    await expect(preflight.locator('[data-preflight-field="tools"]')).toContainText('submit_application, send_message');
    await expect(preflight.locator('[data-preflight-field="network"]')).toContainText('Agent offline');
    await expect(preflight.locator('[data-preflight-field="network"]')).toContainText('serverseitig erzwungen');
    await expect(preflight.locator('[data-preflight-field="network"]')).toContainText('job-search-mcp vor Agentenstart; Agentzugriff nein');
    await expect(preflight.locator('[data-preflight-field="workflow"]')).toContainText('Geführte Stellenanalyse');
    await expect(preflight.locator('[data-preflight-field="workflow"]')).toContainText('v1.0.0 · Scope search_profile · nur Vorschläge');
    await expect(preflight.locator('[data-preflight-field="limits"]')).toContainText('30 Min · 10 MiB angefordert');
    await expect(preflight.locator('[data-preflight-field="limits"]')).toContainText('Laufzeit 30 Min · Idle 5 Min · Ausgabe 10 MiB');
    await expect(preflight.locator('[data-preflight-field="limits"]')).toContainText('Eingabe 256 KiB');
    await expect(preflight.locator('[data-preflight-field="scheduling"]')).toContainText('Queue 1 · aktiv 2/3 · Provider 1 · Workspace 1 · Owner 2');
    await expect(preflight).toContainText('Jobsuche läuft im separaten Trusted-Host-MCP');
    await expect(preflight).toContainText('Agent bleibt offline/sandboxed');
    await expect(preflight).toContainText('Portalzugriff gemäß explizitem Server-Gate');
    await expect(preflight).toContainText('Die Jobsuche läuft erst beim Start direkt als Trusted-Host-MCP');

    await expect.poll(() => agentApi.preflightRequests.length).toBe(1);
    expect(agentApi.preflightRequests[0]).toEqual({
      providerId: 'fake-interactive', prompt,
      runtimeTarget: 'wsl', wslDistribution: 'E2E-Ubuntu', workspaceMode: 'read_only', network: false,
      workflowId: 'guided-job-analysis', budget: { wallTimeMinutes: 30, maxOutputMiB: 10 }
    });
    expect(agentApi.createRequests).toHaveLength(0);
    await expect(page.locator('input[name="network"]')).toBeDisabled();
    await expect(page.locator('input[name="network"]')).not.toBeChecked();
    const preflightText = await preflight.innerText();
    expect(preflightText).not.toContain(prompt);
    expect(preflightText).not.toContain('X:\\Synthetic');
    expect(preflightText).not.toContain('fixture-secret');
    expect(preflightText).not.toContain('testperson@example.invalid');

    const preflightA11y = await new AxeBuilder({ page }).include('[data-testid="agent-preflight"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(preflightA11y.violations, preflightA11y.violations.map((item) => `${item.id}: ${item.help}`).join('\n')).toEqual([]);
    await expect(preflight).toHaveScreenshot('agent-preflight-guided.png');
  });

  test('handles an explicit user answer and revision-bound approval', async ({ page, agentApi }) => {
    agentApi.seedWaitingForInputRun();
    await openAgentCenter(page);

    await expect(page.getByText('Der Agent wartet auf deine Antwort', { exact: true })).toBeVisible();
    await page.locator('#agent-user-input').fill('Nur die synthetische Tiefenprüfung verwenden.');
    await page.getByRole('button', { name: 'Antwort senden', exact: true }).click();

    await expect.poll(() => agentApi.inputRequests.length).toBe(1);
    expect(agentApi.inputRequests[0]).toEqual({
      runId: 'fixture-interactive',
      body: { input: 'Nur die synthetische Tiefenprüfung verwenden.', confirmed: true, expectedRevision: 2 }
    });
    await expect(page.getByRole('heading', { name: 'Offene Entscheidungen aller Runs', exact: true })).toBeVisible();
    await expect(page.getByText('fixture/workspace/result.txt', { exact: true })).toBeVisible();
    await expect(page.getByText('+ geprüfte Fixture-Ausgabe', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Ausdrücklich freigeben', exact: true }).click();
    await expect.poll(() => agentApi.approvalRequests.length).toBe(1);
    expect(agentApi.approvalRequests[0]).toEqual({
      runId: 'fixture-interactive', approvalId: 'fixture-approval',
      body: { decision: 'approve', confirmed: true, expectedRevision: 4 }
    });
    await expect(page.locator('.run-status')).toHaveText('Erfolgreich');
    await expect(page.getByText('Synthetische Freigabe wurde nachvollziehbar verarbeitet.', { exact: true })).toBeVisible();
  });

  test('cancels an active run only through the explicit control', async ({ page, agentApi }) => {
    agentApi.seedRunningRun();
    await openAgentCenter(page);

    await page.getByRole('button', { name: 'Run abbrechen', exact: true }).click();
    await expect.poll(() => agentApi.cancelRequests.length).toBe(1);
    expect(agentApi.cancelRequests[0]).toEqual({ runId: 'fixture-running', body: { confirmed: true, expectedRevision: 3 } });
    await expect(page.getByRole('status').filter({ hasText: 'Abbruch wurde angefordert' })).toBeVisible();
    await expect(page.locator('.run-status')).toHaveText('Abgebrochen');
  });

  test('restores a persisted active run and its event timeline after reload', async ({ page, agentApi }) => {
    agentApi.seedRunningRun('fixture-restored');
    await openAgentCenter(page);
    await expect(page.getByText('Offline-Run wurde gestartet.', { exact: true })).toBeVisible();

    await page.reload();
    await page.locator('nav[aria-label="Hauptnavigation"] button').filter({ hasText: 'Agent Center' }).click();
    await expect(page.locator('.agent-detail-head code')).toHaveText('fixture-restored');
    await expect(page.getByText('Offline-Run wurde gestartet.', { exact: true })).toHaveCount(1);
    await expect(page.locator('.agent-timeline li')).toHaveCount(3);
  });

  test('keeps 450 events canonical while filtering, loading older entries and pausing only presentation', async ({ page, agentApi, context }) => {
    agentApi.seedLargeTimelineRun();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:43117' });
    await openAgentCenter(page);

    const renderedEvents = page.locator('.agent-timeline li[data-event-sequence]');
    await expect(renderedEvents).toHaveCount(100);
    await expect(page.getByRole('button', { name: '100 ältere Einträge nachladen · 350 verborgen', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '100 ältere Einträge nachladen · 350 verborgen', exact: true }).click();
    await expect(renderedEvents).toHaveCount(200);

    await page.locator('.timeline-controls input[type="search"]').fill('needle-event-025');
    await expect(renderedEvents).toHaveCount(1);
    await expect(page.locator('[data-event-sequence="25"]')).toContainText('needle-event-025');
    await page.getByRole('button', { name: 'Event 25 redigiert kopieren', exact: true }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).not.toContain('testperson@example.invalid');
    expect(copied).not.toContain('fixture-secret');
    expect(copied).toContain('REDIGIERT');

    await page.locator('.timeline-controls input[type="search"]').fill('');
    await page.locator('.timeline-controls label').filter({ hasText: 'Typ' }).locator('select').selectOption('tool_output');
    await expect(renderedEvents).toHaveCount(150);
    expect(await renderedEvents.evaluateAll((items) => items.every((item) => item.getAttribute('data-category') === 'tool'))).toBe(true);
    await page.locator('.timeline-controls label').filter({ hasText: 'Typ' }).locator('select').selectOption('all');

    await page.getByRole('button', { name: 'Darstellung pausieren', exact: true }).click();
    agentApi.appendLiveEvent('fixture-large', 'Event während pausierter Darstellung');
    await page.getByRole('button', { name: '↻ Runs aktualisieren', exact: true }).click();
    await expect(page.locator('.live-indicator')).toContainText('1 gepuffert');
    await expect(page.getByText('Event während pausierter Darstellung', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Darstellung fortsetzen', exact: true }).click();
    await expect(page.getByText('Event während pausierter Darstellung', { exact: true })).toBeVisible();

    const timeline = page.locator('.agent-timeline ol');
    await page.locator('.timeline-autoscroll input').check();
    await timeline.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
    await expect(page.getByRole('button', { name: 'Zu den neuesten Events', exact: true })).toBeVisible();
    agentApi.appendLiveEvent('fixture-large', 'Neues Event bei bewusster Nutzerposition');
    await page.getByRole('button', { name: '↻ Runs aktualisieren', exact: true }).click();
    await expect(page.getByText('Neues Event bei bewusster Nutzerposition', { exact: true })).toBeVisible();
    expect(await timeline.evaluate((element) => element.scrollTop)).toBe(0);
  });

  test('prioritizes global approvals and blocks expired or stale decisions', async ({ page, agentApi }) => {
    agentApi.seedApprovalInboxRuns();
    await openAgentCenter(page);
    const inbox = page.locator('.global-approval-inbox');
    await expect(inbox).toContainText('1 ausführbar · 3 angezeigt');

    const expired = inbox.locator('.global-approval-card').filter({ hasText: 'Abgelaufene Fixture-Aktion' });
    await expect(expired.getByText('Gesperrt:', { exact: false })).toContainText('abgelaufen');
    await expect(expired.getByRole('button', { name: 'Ausdrücklich freigeben', exact: true })).toBeDisabled();

    const stale = inbox.locator('.global-approval-card').filter({ hasText: 'Veraltete Fixture-Aktion' });
    await expect(stale.getByText('Gesperrt:', { exact: false })).toContainText('fortgeschritten');
    await expect(stale.getByRole('button', { name: 'Ausdrücklich freigeben', exact: true })).toBeDisabled();

    const actionable = inbox.locator('.global-approval-card').filter({ hasText: 'Externe Fixture-Aktion' });
    await expect(actionable.getByText('Exaktes Ziel:', { exact: false })).toBeVisible();
    await expect(actionable.getByRole('button', { name: 'Bearbeiten & freigeben', exact: true })).toBeDisabled();
    await expect(actionable).toContainText('aktuelle API-Vertrag akzeptiert nur unveränderte');
    await actionable.getByRole('button', { name: 'Ausdrücklich freigeben', exact: true }).click();
    await expect.poll(() => agentApi.approvalRequests.length).toBe(1);
    expect(agentApi.approvalRequests[0]).toEqual({
      runId: 'fixture-approval-actionable', approvalId: 'approval-actionable',
      body: { decision: 'approve', confirmed: true, expectedRevision: 2 }
    });
  });

  test('masks sensitive answers and keeps the transport warning visible', async ({ page, agentApi }) => {
    agentApi.seedWaitingForInputRun('fixture-sensitive-input');
    await openAgentCenter(page);
    await page.getByText('Sensible Eingabe maskieren', { exact: true }).click();
    const sensitiveInput = page.locator('#agent-user-input');
    await expect(sensitiveInput).toHaveAttribute('type', 'password');
    await expect(page.getByText('Nur die Anzeige ist maskiert', { exact: true })).toBeVisible();
    await expect(page.getByText('Der Inhalt wird im Klartext an den lokalen Agentenprozess übergeben.', { exact: false })).toBeVisible();
    await sensitiveInput.fill('synthetische-vertrauliche-antwort');
    await page.getByRole('button', { name: 'Antwort senden', exact: true }).click();
    await expect.poll(() => agentApi.inputRequests.length).toBe(1);
    expect(agentApi.inputRequests[0]).toEqual({ runId: 'fixture-sensitive-input', body: { input: 'synthetische-vertrauliche-antwort', confirmed: true, expectedRevision: 2 } });
  });

  test('compares lineage and keeps agent output proposal-only with redacted copy', async ({ page, agentApi, context }) => {
    agentApi.seedComparisonRuns();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:43117' });
    await openAgentCenter(page);
    const comparison = page.locator('.agent-comparison');
    for (const heading of ['Abstammung', 'Versionen', 'Policy', 'Kontext', 'Usage', 'Ergebnis']) await expect(comparison.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(comparison).toContainText('Geändert');
    await expect(page.getByText('PROPOSAL-ONLY', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'In validierte Dokumentrevision übernehmen', exact: true })).toBeDisabled();

    await page.getByRole('button', { name: 'Ergebnis redigiert kopieren', exact: true }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).not.toContain('Testperson Beispiel');
    expect(copied).not.toContain('testperson@example.invalid');
    expect(copied).not.toContain('X:\\Synthetic\\Fixture');
    expect(copied).not.toContain('fixture-secret');

    await page.getByRole('button', { name: 'Als Replay-Vorlage (kein Start)', exact: true }).click();
    await expect(page.getByText('Replay-Vorlage aus fixture-child', { exact: true })).toBeVisible();
    expect(agentApi.createRequests).toHaveLength(0);
    const start = page.getByRole('button', { name: 'Run kontrolliert starten', exact: true });
    await expect(start).toBeEnabled();
    await expect.poll(() => agentApi.preflightRequests.length).toBe(1);
    await start.click();
    await expect.poll(() => agentApi.createRequests.length).toBe(1);
    expect(agentApi.createRequests[0].parentRunId).toBe('fixture-child');
  });

  test('shows scoped queue limits and resolves cleanup or resume only with a local lease, dialog and revision', async ({ page, agentApi }) => {
    agentApi.seedRecoveryRun('fixture-orphan-cleanup');
    await openAgentCenter(page);

    const queue = page.getByTestId('agent-queue-diagnostics');
    await expect(queue).toContainText('2/3');
    await expect(queue).toContainText('X:\\Synthetic\\Fixture\\Workspace');
    await expect(queue).toContainText('+35');
    await expect(queue).toContainText('Provider-Limit');
    await expect(queue).toContainText('Workspace-Limit');

    let recoveryCard = page.locator('.recovery-card').filter({ hasText: 'fixture-orphan-cleanup' });
    await expect(recoveryCard).toContainText('Keine Prozess-Adoption');
    await expect(recoveryCard).toContainText('Aktuelle Serverrevision: #3');
    await recoveryCard.getByRole('button', { name: 'Operator-Lease übernehmen', exact: true }).click();
    await expect.poll(() => agentApi.recoveryLeaseRequests.length).toBe(1);
    expect(agentApi.recoveryLeaseRequests[0]).toEqual({ runId: 'fixture-orphan-cleanup', body: { confirmed: true, expectedRevision: 3 } });
    await expect(recoveryCard).toContainText('Dieser Browser hält die Lease-ID');
    await expect(recoveryCard).toContainText('Operator local-user');

    await recoveryCard.getByRole('button', { name: 'Bereinigung prüfen', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('erwarteter Revision #3');
    await expect(dialog.getByRole('button', { name: 'Bereinigung verbindlich bestätigen', exact: true })).toBeDisabled();
    expect(agentApi.recoveryResolveRequests).toHaveLength(0);
    const cleanupConfirmation = dialog.locator('input[type="checkbox"]');
    await expect(cleanupConfirmation).toBeFocused();
    await cleanupConfirmation.check();
    await dialog.getByRole('button', { name: 'Bereinigung verbindlich bestätigen', exact: true }).click();
    await expect.poll(() => agentApi.recoveryResolveRequests.length).toBe(1);
    expect(agentApi.recoveryResolveRequests[0]).toEqual({
      runId: 'fixture-orphan-cleanup',
      body: { confirmed: true, expectedRevision: 3, leaseId: '11111111-1111-4111-8111-111111111111', decision: 'cleanup' }
    });
    await expect(page.getByRole('status').filter({ hasText: 'expliziter Operatorentscheidung bereinigt' })).toBeVisible();

    agentApi.seedRecoveryRun('fixture-orphan-resume');
    await page.getByRole('button', { name: '↻ Runs aktualisieren', exact: true }).click();
    recoveryCard = page.locator('.recovery-card').filter({ hasText: 'fixture-orphan-resume' });
    await recoveryCard.getByRole('button', { name: 'Operator-Lease übernehmen', exact: true }).click();
    await expect.poll(() => agentApi.recoveryLeaseRequests.length).toBe(2);
    await recoveryCard.getByRole('button', { name: 'Als neuen Run starten', exact: true }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Kein Prozess-Resume');
    await expect(dialog).toContainText('neuen Prozess');
    await expect(dialog).toContainText('eigenständigen Ersatz-Run');
    await dialog.getByLabel('Optionaler Auftrag für den neuen Run', { exact: true }).fill('Eigenständigen synthetischen Ersatz-Run ausführen');
    await dialog.locator('input[type="checkbox"]').check();
    const dialogA11y = await new AxeBuilder({ page }).include('.recovery-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(dialogA11y.violations, dialogA11y.violations.map((item) => `${item.id}: ${item.help}`).join('\n')).toEqual([]);
    await dialog.getByRole('button', { name: 'Neuen Run verbindlich starten', exact: true }).click();
    await expect.poll(() => agentApi.recoveryResolveRequests.length).toBe(2);
    expect(agentApi.recoveryResolveRequests[1]).toEqual({
      runId: 'fixture-orphan-resume',
      body: {
        confirmed: true, expectedRevision: 3, leaseId: '11111111-1111-4111-8111-111111111111', decision: 'resume',
        input: 'Eigenständigen synthetischen Ersatz-Run ausführen'
      }
    });
    await expect(page.getByRole('status').filter({ hasText: 'Ein neuer Prozess und neuer Run fixture-orphan-resume-replacement' })).toBeVisible();
  });

  test('supports keyboard focus and has no axe WCAG A/AA violations', async ({ page, agentApi }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    await page.goto('/');
    expect(await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    await page.keyboard.press('Tab');
    await expect(page.locator('.skip-link')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();

    const navigation = page.locator('nav[aria-label="Hauptnavigation"] button').filter({ hasText: 'Agent Center' });
    await navigation.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Eine sichere Oberfläche für alle Agenten', exact: true })).toBeVisible();

    const prompt = page.locator('textarea[name="agentPrompt"]');
    await prompt.focus();
    await prompt.fill('Tastaturbedienung mit synthetischem Inhalt prüfen');
    const start = page.getByRole('button', { name: 'Run kontrolliert starten', exact: true });
    await expect(start).toBeEnabled();
    await expect.poll(() => agentApi.preflightRequests.length).toBe(1);
    await start.focus();
    await expect(start).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => agentApi.createRequests.length).toBe(1);
    await expect(page.getByText('Reduzierte Bewegung ist aktiv', { exact: false })).toBeVisible();
    await expect(page.locator('.motion-note')).toHaveAttribute('data-reduced-motion', 'true');
    await expect(page.locator('.timeline-autoscroll input')).not.toBeChecked();

    const result = await new AxeBuilder({ page }).include('main').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(result.violations, result.violations.map((item) => `${item.impact ?? 'unknown'} ${item.id}: ${item.help}`).join('\n')).toEqual([]);
  });

  test('matches reviewed desktop, tablet and mobile baselines', async ({ page, agentApi }) => {
    agentApi.seedVisualRun();
    const viewports = [
      { name: 'desktop', width: 1440, height: 1000 },
      { name: 'tablet', width: 900, height: 1100 },
      { name: 'mobile', width: 390, height: 844 }
    ];

    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openAgentCenter(page);
      await expect(page.getByRole('heading', { name: 'Offene Entscheidungen aller Runs', exact: true })).toBeVisible();
      await expect(page.getByText('Eine ausdrückliche Fixture-Freigabe ist erforderlich.', { exact: true })).toBeVisible();
      await expect(page).toHaveScreenshot(`agent-center-${viewport.name}.png`, { fullPage: true });
    }
  });
});
