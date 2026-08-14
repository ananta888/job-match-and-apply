import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './support/agent-api.fixture';

async function openSection(page: Page, label: string): Promise<void> {
  await page.goto('/');
  const navigation = page.locator('nav[aria-label="Hauptnavigation"] button').filter({ hasText: label });
  await expect(navigation).toBeVisible();
  await navigation.click();
}

async function openPipelineWorkbench(page: Page): Promise<void> {
  await openSection(page, 'Bewerbung');
  await page.getByRole('button', { name: 'Werkstatt öffnen', exact: true }).click();
  await expect(page.getByTestId('case-pipeline-workbench')).toBeVisible();
}

async function expectAxeClean(page: Page, selector: string): Promise<void> {
  const result = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(result.violations, result.violations.map((item) => `${item.impact ?? 'unknown'} ${item.id}: ${item.help}`).join('\n')).toEqual([]);
}

const VALID_ITERATION_MANIFEST = JSON.stringify({
  schema_version: 1, mode: 'standard', execution: 'independent_agents', cycle: 1,
  passes: [
    { id: 'pass-author-1', role: 'author', independent_context: true, input_revision: 'source', output_revision: 'revision-1', findings: [] },
    { id: 'pass-evidence-ats-1', role: 'evidence_ats_reviewer', independent_context: true, input_revision: 'revision-1', output_revision: 'revision-2', findings: [] },
    { id: 'pass-recruiter-style-1', role: 'recruiter_style_reviewer', independent_context: true, input_revision: 'revision-2', output_revision: 'revision-3', findings: [] },
    { id: 'pass-finalizer-1', role: 'finalizer', independent_context: true, input_revision: 'revision-3', output_revision: 'final', findings: [] }
  ]
});

test.describe('Bewerbungspipeline – offline browser contract', () => {
  test('initializes local candidate and style templates only after explicit confirmation', async ({ page, agentApi }) => {
    agentApi.seedMissingProfileSetup();
    await openSection(page, 'Profil & Identität');
    const setup = page.getByTestId('application-profile-setup');
    await expect(setup).toContainText('Kandidatenprofil');
    await expect(setup).toContainText('Fehlt');
    await expect(setup).toContainText('Nur leere Vorlagen');
    const initialize = setup.getByRole('button', { name: 'Profile ausdrücklich initialisieren', exact: true });
    await expect(initialize).toBeDisabled();
    await setup.locator('input[type="checkbox"]').check();
    await initialize.click();
    await expect.poll(() => agentApi.profileSetupRequests.length).toBe(1);
    expect(agentApi.profileSetupRequests[0]).toEqual({ confirmed: true });
    await expect(setup).toContainText('Vorhanden');
    await expect(page.getByRole('status').filter({ hasText: 'Kandidatenfakten wurden nicht erfunden' })).toBeVisible();
    const style = page.getByTestId('style-profile-editor');
    await expect(style).toContainText('Revision');
    await expect(style).toContainText('nspell · nur lokal');
    await style.getByTestId('style-tone').fill('präzise und ruhig');
    await style.locator('summary').filter({ hasText: 'Wortschatz und Muster' }).click();
    await style.getByTestId('style-vocabulary-prefer').fill('umgesetzt\nbelegt\nnachgewiesen');
    await style.getByTestId('style-avoid-patterns').fill('Übertriebene Superlative\nUnbelegte Behauptung');
    await style.getByTestId('style-save-confirmation').check();
    await style.getByTestId('save-style-profile').click();
    await expect.poll(() => agentApi.styleProfileUpdateRequests.length).toBe(1);
    const styleRequest = agentApi.styleProfileUpdateRequests[0];
    expect(styleRequest).toMatchObject({ expectedRevision: 3, expectedSha256: '8'.repeat(64), confirmed: true });
    expect(styleRequest['profile']).toMatchObject({
      tone: 'präzise und ruhig', vocabulary: { prefer: ['umgesetzt', 'belegt', 'nachgewiesen'], avoid: ['Guru', 'Rockstar'] },
      avoidPatterns: ['Übertriebene Superlative', 'Unbelegte Behauptung']
    });
    expect(JSON.stringify(styleRequest)).not.toMatch(/styleProfilePath|candidateProfilePath|local_server|yaml/i);
    await expect(style).toContainText('Revision 4');
    await expectAxeClean(page, '[data-testid="application-profile-setup"]');
    await expectAxeClean(page, '[data-testid="style-profile-editor"]');
  });

  test('runs local language UX and exports only a hash-reviewed case revision', async ({ page, agentApi }) => {
    const application = agentApi.seedPipelineCase();
    await openPipelineWorkbench(page);
    const workbench = page.getByTestId('case-pipeline-workbench');
    await workbench.getByLabel('Annotierter Dokumenttext').fill('Synthetischer belegter Angularrr Inhalt. <!-- evidence: fixture-claim -->');
    await workbench.getByLabel('Iteration-/Review-Manifest').fill(VALID_ITERATION_MANIFEST);
    await workbench.getByRole('button', { name: 'Text lokal prüfen', exact: true }).click();
    await expect.poll(() => agentApi.languageCheckRequests.length).toBe(1);
    expect(agentApi.languageCheckRequests[0]).toEqual({ content: 'Synthetischer belegter Angularrr Inhalt. <!-- evidence: fixture-claim -->', language: 'de-DE' });
    await expect(workbench).toContainText('nspell-local · 1 Hinweis(e)');
    await expect(workbench).toContainText('Vorschläge: Angular');

    await workbench.getByRole('button', { name: 'Serverseitig finalisieren und Revision vorschlagen', exact: true }).click();
    await expect.poll(() => agentApi.pipelineFinalizeRequests.length).toBe(1);
    expect(agentApi.pipelineFinalizeRequests[0]).toEqual({
      caseId: application.id,
      body: {
        annotatedContent: 'Synthetischer belegter Angularrr Inhalt. <!-- evidence: fixture-claim -->',
        iterationManifest: VALID_ITERATION_MANIFEST
      }
    });
    const revision = workbench.locator('.artifact-revision').filter({ hasText: 'proposed' });
    await expect(revision).toContainText('a'.repeat(64));
    await expect(revision).toContainText('1 Sprachhinweis(e)');
    await expect(revision).toContainText('Vorbereitung gebunden: Stellenanalyse · valide Match-Matrix · Fragenreview');
    await expect(revision).not.toContainText('1'.repeat(64));
    await revision.locator('input[type="checkbox"]').check();
    await revision.getByRole('button', { name: 'Exakte Revision freigeben', exact: true }).click();
    await expect.poll(() => agentApi.artifactReviewRequests.length).toBe(1);
    expect(agentApi.artifactReviewRequests[0]).toEqual({
      caseId: application.id, revisionId: '22222222-2222-4222-8222-222222222222',
      body: { decision: 'approved', expectedSha256: 'a'.repeat(64), acknowledgedLanguageIssueCount: 1, confirmed: true }
    });
    const approved = workbench.locator('.artifact-revision').filter({ hasText: 'approved' });
    await approved.getByRole('button', { name: 'Fall mit dieser geprüften Revision freigeben', exact: true }).click();
    await expect.poll(() => agentApi.applicationTransitionRequests.length).toBe(1);
    expect(agentApi.applicationTransitionRequests[0]).toEqual({
      caseId: application.id,
      body: { state: 'approved', revisionId: '22222222-2222-4222-8222-222222222222', expectedSha256: 'a'.repeat(64), confirmed: true }
    });
    await expect(workbench).toContainText('Exportformat');
    await approved.locator('.artifact-export input[type="checkbox"]').check();
    const download = page.waitForEvent('download');
    await approved.getByRole('button', { name: 'Hashgebundene Revision exportieren', exact: true }).click();
    expect((await download).suggestedFilename()).toBe('synthetische-bewerbung.pdf');
    await expect.poll(() => agentApi.artifactExportRequests.length).toBe(1);
    expect(agentApi.artifactExportRequests[0]).toEqual({
      caseId: application.id,
      body: { revisionId: '22222222-2222-4222-8222-222222222222', format: 'pdf', confirmed: true }
    });
    await expect(workbench).toContainText('Für diesen Bewerbungsfall verwendet');
    await expectAxeClean(page, '[data-testid="case-pipeline-workbench"]');
  });

  test('fails the language UX closed without a local backend and invalidates stale results on edits', async ({ page, agentApi }) => {
    agentApi.seedPipelineCase();
    agentApi.seedUnavailableLanguageBackend();
    await openPipelineWorkbench(page);
    const workbench = page.getByTestId('case-pipeline-workbench');
    const content = workbench.getByLabel('Annotierter Dokumenttext');
    await content.fill('Synthetischer lokaler Text.');
    await workbench.getByRole('button', { name: 'Text lokal prüfen', exact: true }).click();
    await expect(workbench.locator('.language-result')).toContainText('Backend nicht verfügbar');
    await expect(workbench.locator('.language-result')).toContainText('kein Remote-Fallback');
    await content.fill('Synthetischer lokal geänderter Text.');
    await expect(workbench.locator('.language-result')).toHaveCount(0);
    await expectAxeClean(page, '[data-testid="case-pipeline-workbench"]');
  });

  test('keeps the case-bound language controls operable by keyboard with visible focus', async ({ page, agentApi }) => {
    agentApi.seedPipelineCase();
    await openPipelineWorkbench(page);
    const workbench = page.getByTestId('case-pipeline-workbench');
    const content = workbench.getByLabel('Annotierter Dokumenttext');
    const manifest = workbench.getByLabel('Iteration-/Review-Manifest');
    await content.focus();
    await expect(content).toBeFocused();
    await content.fill('Synthetischer belegter Tastaturtext.');
    await page.keyboard.press('Tab');
    await expect(manifest).toBeFocused();
    await manifest.fill(VALID_ITERATION_MANIFEST);
    await page.keyboard.press('Tab');
    const languageButton = workbench.getByRole('button', { name: 'Text lokal prüfen', exact: true });
    await expect(languageButton).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => agentApi.languageCheckRequests.length).toBe(1);
    await expect(workbench.locator('.language-result')).toContainText('Backend verfügbar');
  });

  test('reviews and adopts only the approved case-bound pipeline package', async ({ page, agentApi }) => {
    const { artifact } = agentApi.seedAgentPipelinePackageRun();
    await openSection(page, 'Agent Center');
    const artifacts = page.locator('.agent-artifact-list');
    await expect(artifacts).toContainText('application-pipeline-package');
    await expect(artifacts).toContainText(artifact.sha256);
    const card = artifacts.locator('.agent-artifact').filter({ hasText: artifact.id });
    await card.locator('input[type="checkbox"]').check();
    await card.getByRole('button', { name: 'Revision freigeben', exact: true }).click();
    await expect.poll(() => agentApi.agentArtifactReviewRequests.length).toBe(1);
    expect(agentApi.agentArtifactReviewRequests[0]).toEqual({
      runId: 'fixture-agent-package', artifactId: artifact.id,
      body: { decision: 'approved', expectedRevision: 1, confirmed: true }
    });
    await card.locator('input[type="checkbox"]').check();
    await card.getByRole('button', { name: 'In Pipeline erneut prüfen und als Vorschlag übernehmen', exact: true }).click();
    await expect.poll(() => agentApi.agentArtifactAdoptionRequests.length).toBe(1);
    expect(agentApi.agentArtifactAdoptionRequests[0]).toEqual({
      runId: 'fixture-agent-package', artifactId: artifact.id, body: { expectedRevision: 2, confirmed: true }
    });
    await expect(artifacts).toContainText('Fachliche Revision vorgeschlagen');
    await artifacts.getByRole('button', { name: 'Zur revisionsgebundenen Prüfung', exact: true }).click();
    const workbench = page.getByTestId('case-pipeline-workbench');
    await expect(workbench).toContainText('proposed');
    await expect(workbench).toContainText('a'.repeat(64));
    await expectAxeClean(page, '[data-testid="case-pipeline-workbench"]');
  });

  test('opens case-bound mail triage and company next-actions without starting a run', async ({ page, agentApi }) => {
    const application = agentApi.seedPipelineCase();
    await openSection(page, 'Firmen & Antworten');
    const casePanel = page.locator('.application-crm').filter({ hasText: application.job.title });
    await casePanel.getByRole('button', { name: 'Mailtriage mit Agent', exact: true }).click();
    await expect(page.locator('select[name="agentWorkflow"]')).toHaveValue('employer-response-triage');
    await expect(page.locator('select[name="applicationCase"]')).toHaveValue(application.id);
    await expect(page.locator('textarea[name="agentPrompt"]')).toHaveValue(/Unternehmensantworten/);
    await expect.poll(() => agentApi.preflightRequests.some((item) => item.workflowId === 'employer-response-triage')).toBe(true);
    expect(agentApi.createRequests).toHaveLength(0);

    await openSection(page, 'Firmen & Antworten');
    await page.locator('.application-crm').filter({ hasText: application.job.title }).getByRole('button', { name: 'Nächste Schritte', exact: true }).click();
    await expect(page.locator('select[name="agentWorkflow"]')).toHaveValue('application-next-actions');
    await expect(page.locator('textarea[name="agentPrompt"]')).toHaveValue(/firmenweit/);
    await expect.poll(() => agentApi.preflightRequests.some((item) => item.workflowId === 'application-next-actions')).toBe(true);
    expect(agentApi.createRequests).toHaveLength(0);
  });

  test('passes an explicitly selected unassigned inbox mail to triage by UUID without echoing its content', async ({ page, agentApi }) => {
    const { application, message } = agentApi.seedUnassignedMail();
    await openSection(page, 'Firmen & Antworten');
    const mailCard = page.locator('.mail-card').filter({ hasText: message.subject });
    await mailCard.locator('select').selectOption(application.id);
    await mailCard.getByRole('button', { name: 'Gewählte Mail mit Agent triagieren', exact: true }).click();

    const center = page.getByTestId('agent-orchestration-center');
    await expect(center.locator('select[name="orchestrationWorkflow"]')).toHaveValue('employer-response-triage');
    await expect(center.locator('select[name="orchestrationProvider"]')).toHaveValue('fake-interactive');
    await expect(center.locator('select[name="orchestrationCase"]')).toHaveValue(application.id);
    await expect(center).toContainText(message.id);
    await expect(center).not.toContainText(message.text);
    await center.getByRole('button', { name: 'Multi-Agent-Workflow starten', exact: true }).click();

    await expect.poll(() => agentApi.orchestrationCreateRequests.length).toBe(1);
    expect(agentApi.orchestrationCreateRequests[0]).toMatchObject({
      workflowId: 'employer-response-triage', providerId: 'fake-interactive', runtimeTarget: 'windows',
      applicationCaseId: application.id, mailId: message.id
    });
    const submitted = JSON.stringify(agentApi.orchestrationCreateRequests[0]);
    expect(submitted).not.toContain(message.text);
    expect(submitted).not.toContain(message.from[0]);
    await expect(center).toContainText('response_drafter');
    await expect(center.locator('.orchestration-nodes > li')).toHaveCount(3);
    await expect(center).toContainText('Gate offen');
    await center.locator('.orchestration-gates .explicit-confirmation input[type="checkbox"]').check();
    await center.getByRole('button', { name: 'Nur offene Rollen fortsetzen', exact: true }).click();
    await expect.poll(() => agentApi.orchestrationContinueRequests.length).toBe(1);
    expect(agentApi.orchestrationContinueRequests[0]).toEqual({
      orchestrationId: '33333333-3333-4333-8333-000000000001', body: { expectedRevision: 1, userInput: { confirmed: true } }
    });
    await expect(center).toContainText('response_and_calendar_proposal');
    await expect(center).toContainText('Eine Nutzerentscheidung ist erforderlich');
    await center.getByRole('button', { name: 'Proposal im Node-Run prüfen', exact: true }).click();
    const artifacts = page.locator('.agent-artifact-list');
    await expect(artifacts).toContainText('employer-response-triage-proposal');
    await expect(artifacts).toContainText('PROPOSAL-ONLY');
    await artifacts.getByRole('button', { name: 'Inhalt bewusst anzeigen', exact: true }).click();
    const proposal = page.getByTestId('employer-response-triage-proposal');
    await expect(proposal).toContainText('91 %');
    await expect(proposal).toContainText(`mail:${message.id}`);
    await expect(proposal).toContainText('Fallkandidaten – manuell bestätigen');
    await expect(proposal).toContainText('Follow-up – nicht geplant');
    await expect(proposal).toContainText('Antwortentwurf – nicht gesendet');
    await expect(proposal.getByRole('button')).toHaveCount(0);
    await expectAxeClean(page, '[data-testid="employer-response-triage-proposal"]');
  });

  test('renders typed company next-actions as sourced proposals without an execution control', async ({ page, agentApi }) => {
    const { artifact } = agentApi.seedNextActionsProposal();
    await openSection(page, 'Agent Center');
    const center = page.getByTestId('agent-orchestration-center');
    await expect(center).toContainText('application_coordinator');
    await expect(center).toContainText('quellen- und confidence-gebundene nächste Schritte');
    await center.getByRole('button', { name: 'Proposal im Node-Run prüfen', exact: true }).click();
    const artifacts = page.locator('.agent-artifact-list');
    await expect(artifacts).toContainText(artifact.kind);
    await artifacts.getByRole('button', { name: 'Inhalt bewusst anzeigen', exact: true }).click();
    const proposal = page.getByTestId('application-next-actions-proposal');
    await expect(proposal).toContainText('78 %');
    await expect(proposal).toContainText('tracking:fixture-event');
    await expect(proposal).toContainText('Konflikthinweise – manuell klären');
    await expect(proposal).toContainText('nicht geplant');
    await expect(proposal.getByRole('button')).toHaveCount(0);
    await expectAxeClean(page, '[data-testid="application-next-actions-proposal"]');
  });

  test('renders stable desktop, tablet and mobile pipeline baselines', async ({ page, agentApi }) => {
    agentApi.seedPipelineCaseWithApprovedRevision();
    const viewports = [
      { name: 'desktop', width: 1440, height: 1000 },
      { name: 'tablet', width: 900, height: 1100 },
      { name: 'mobile', width: 390, height: 844 }
    ];
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openSection(page, 'Profil & Identität');
      await expect(page.getByTestId('style-profile-editor')).toContainText('Schreibstil sicher konfigurieren');
      await expect(page).toHaveScreenshot(`application-style-profile-${viewport.name}.png`, { fullPage: true });
      await openPipelineWorkbench(page);
      await expect(page.getByTestId('case-pipeline-workbench')).toContainText('Signierter Pipeline-Nachweis');
      await expect(page).toHaveScreenshot(`application-pipeline-${viewport.name}.png`, { fullPage: true });
    }
  });
});
