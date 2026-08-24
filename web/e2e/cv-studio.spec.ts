import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './support/agent-api.fixture';

async function openCvStudio(page: Page): Promise<void> {
  await page.goto('/');
  const navigation = page.locator('nav[aria-label="Hauptnavigation"] button').filter({ hasText: 'Lebenslauf' });
  await expect(navigation).toBeVisible();
  await navigation.click();
  await expect(page.getByTestId('cv-import-step')).toBeVisible();
}

async function expectAxeClean(page: Page, selector: string): Promise<void> {
  const result = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(result.violations, result.violations.map((item) => `${item.impact ?? 'unknown'} ${item.id}: ${item.help}`).join('\n')).toEqual([]);
}

test.describe('Lebenslauf-Studio – vollständiger Offline-Vertrag', () => {
  test('imports, adopts and displays the fifth agent result directly as HTML', async ({ page, agentApi }) => {
    test.setTimeout(60_000);
    const application = agentApi.seedCvPipelineCase();
    await openCvStudio(page);

    const steps = page.locator('nav[aria-label="Lebenslauf-Schritte"]');
    await expect(steps.locator('ol > li')).toHaveCount(6);
    await expect(steps.getByRole('button', { name: /1 Import/ })).toHaveAttribute('aria-current', 'step');
    const fileInput = page.getByTestId('cv-file-input');
    await expect(fileInput).toHaveAttribute('accept', '.pdf,.docx,.odt,.html,.htm');
    await fileInput.setInputFiles({
      name: 'synthetischer-cv.html', mimeType: 'text/html',
      buffer: Buffer.from('<!doctype html><html><body><p>Rein synthetische CV-Fixture</p></body></html>', 'utf8')
    });
    await expect(page.getByTestId('cv-facts-step')).toBeVisible();
    await expect(page.getByTestId('cv-facts-step')).toContainText('Synthetische Zeitangabe');
    await expect(steps.getByRole('button', { name: /2 Fakten/ })).toHaveAttribute('aria-current', 'step');
    await expect.poll(() => agentApi.cvImportRequests.length).toBe(1);
    expect(agentApi.cvImportRequests[0]).toMatchObject({
      fileName: 'synthetischer-cv.html', mimeType: 'text/html', confirmed: true
    });
    expect(String(agentApi.cvImportRequests[0]?.['base64'])).toMatch(/^[A-Za-z0-9+/]+=*$/);

    const facts = page.getByTestId('cv-facts-step');
    await facts.locator('.cv-fact').filter({ hasText: 'company' }).getByRole('button', { name: 'Diesen Fakt bestätigen' }).click();
    await facts.locator('.cv-fact').filter({ hasText: 'period' }).getByRole('button', { name: 'Verwerfen' }).click();
    await expect.poll(() => agentApi.cvFactReviewRequests.length).toBe(2);
    expect(agentApi.cvFactReviewRequests[0]).toMatchObject({
      expectedRevision: 1, expectedSha256: '7'.repeat(64), confirmed: true,
      operations: [{ factId: 'fact-employer', action: 'confirm' }]
    });
    expect(agentApi.cvFactReviewRequests[1]?.['operations']).toEqual([{ factId: 'fact-period', action: 'reject' }]);
    await expect(facts).toContainText('Bestätigt');
    await expect(facts).toContainText('Verworfen');
    await facts.getByTestId('cv-adopt-confirmation').check();
    await facts.getByTestId('cv-adopt').click();
    await expect.poll(() => agentApi.cvAdoptionRequests.length).toBe(1);
    await expect(page.getByTestId('cv-writing-style-step')).toContainText('Versioniertes Schreibstilprofil');
    await expect(page.getByTestId('cv-writing-style-step')).toContainText('klar und respektvoll');

    await page.getByRole('button', { name: 'Formatvorlage wählen →', exact: true }).click();
    const theme = page.getByTestId('cv-theme-step');
    await theme.getByTestId('cv-theme-template').selectOption('compact');
    await theme.getByTestId('cv-theme-accent').selectOption('#1d4ed8');
    await theme.getByTestId('cv-theme-confirmation').check();
    await theme.getByTestId('cv-theme-save').click();
    await expect.poll(() => agentApi.cvThemeRequests.length).toBe(1);
    expect(agentApi.cvThemeRequests[0]).toMatchObject({
      expectedRevision: 4, confirmed: true, theme: { template: 'compact', accentColor: '#1d4ed8' }
    });
    expect(JSON.stringify(agentApi.cvThemeRequests[0])).not.toMatch(/css|rawHtml|script/i);
    await theme.getByRole('button', { name: 'Zielstelle wählen →', exact: true }).click();

    const target = page.getByTestId('cv-target-step');
    await target.getByTestId('cv-case-select').selectOption(application.id);
    await expect(target).toContainText('Angular Engineer');
    await target.getByRole('button', { name: 'Agentenkette öffnen →', exact: true }).click();
    const pipeline = page.getByTestId('cv-pipeline-step');
    await expect(pipeline).toContainText('kein manuelles Fortsetzen nötig');

    await pipeline.getByTestId('cv-agent-start').click();
    await expect.poll(() => agentApi.orchestrationCreateRequests.length).toBe(1);
    expect(agentApi.orchestrationCreateRequests[0]).toMatchObject({
      workflowId: 'evidence-application-package', providerId: 'codex-exec', runtimeTarget: 'windows',
      applicationCaseId: application.id
    });
    expect(agentApi.orchestrationCreateRequests[0]?.prompt).toContain('ausschließlich bestätigte CandidateProfile-Claims');
    await expect(pipeline.locator('.cv-agent-progress')).toContainText('evidence_reviewer');
    await expect(pipeline.locator('.cv-agent-progress')).toContainText('finalizer');
    const preview = pipeline.getByTestId('cv-agent-html-result');
    await expect(preview).toHaveAttribute('sandbox', '');
    await expect(preview).not.toHaveAttribute('allow');
    await expect(page.frameLocator('[data-testid="cv-agent-html-result"]')
      .getByRole('heading', { name: 'Synthetische finale Agenten-HTML-Version' })).toBeVisible();
    expect(agentApi.orchestrationContinueRequests).toHaveLength(0);
    expect(agentApi.cvHtmlRenderRequests).toHaveLength(0);
    await expectAxeClean(page, '[data-testid="cv-pipeline-step"]');
  });

  test('lists, atomically adds and CAS-deletes a local CV import only after exact confirmation', async ({ page, agentApi }) => {
    await openCvStudio(page);
    await expect.poll(() => agentApi.cvImportListRequests.length).toBeGreaterThan(0);
    expect(agentApi.cvImportListRequests[0]).toContain('/api/cv-imports?limit=20');
    await page.getByTestId('cv-file-input').setInputFiles({
      name: 'synthetischer-cv.html', mimeType: 'text/html', buffer: Buffer.from('<html><body>Fixture</body></html>')
    });
    const facts = page.getByTestId('cv-facts-step');
    await facts.getByTestId('cv-new-fact-value').fill('Synthetischer Zusatzfakt');
    await facts.getByTestId('cv-new-fact-confirmation').check();
    await facts.getByTestId('cv-new-fact-add').click();
    await expect.poll(() => agentApi.cvFactReviewRequests.length).toBe(1);
    expect(agentApi.cvFactReviewRequests[0]).toMatchObject({
      expectedRevision: 1, expectedSha256: '7'.repeat(64), confirmed: true,
      operations: [{
        action: 'add', category: 'additional', newRecordKey: 'additional-fact', field: 'detail',
        value: 'Synthetischer Zusatzfakt', explicitlyConfirmed: true
      }]
    });
    const rawFacts = facts.getByTestId('cv-raw-facts');
    await expect(rawFacts).not.toHaveAttribute('open', '');
    await rawFacts.locator('summary').click();
    const addedFact = facts.locator('.cv-fact', { has: page.getByText(/detail · Bestätigt/) });
    await expect(addedFact.locator('textarea')).toHaveValue('Synthetischer Zusatzfakt');
    await expect(addedFact).toContainText('user_supplied');
    await expect(facts).not.toContainText('Revisionsgebunden übernommen');
    await expectAxeClean(page, '[data-testid="cv-facts-step"]');

    await page.locator('nav[aria-label="Lebenslauf-Schritte"]').getByRole('button', { name: /1 Import/ }).click();
    await expect(page.getByTestId('cv-source-state')).toContainText('cv-import · 1.0');
    const deletion = page.locator('.cv-delete-import');
    await deletion.locator('summary').click();
    await deletion.getByTestId('cv-delete-confirmation').fill('DELETE cv-import wrong');
    await expect(deletion.getByTestId('cv-delete-import')).toBeDisabled();
    await deletion.getByTestId('cv-delete-confirmation').fill('DELETE cv-import 66666666-6666-4666-8666-666666666666');
    await deletion.getByTestId('cv-delete-import').click();
    await expect.poll(() => agentApi.cvImportDeleteRequests.length).toBe(1);
    expect(agentApi.cvImportDeleteRequests[0]).toEqual({
      confirmation: 'DELETE cv-import 66666666-6666-4666-8666-666666666666', expectedRevision: 2,
      expectedSha256: '2'.repeat(64)
    });
    await expect(page.getByTestId('cv-source-state')).toHaveCount(0);
    await expectAxeClean(page, '[data-testid="cv-import-step"]');
  });

  test('creates one active AI recognition version and switches both versions with import CAS', async ({ page, agentApi }) => {
    test.setTimeout(30_000);
    await openCvStudio(page);
    await page.getByTestId('cv-file-input').setInputFiles({
      name: 'synthetischer-cv.html', mimeType: 'text/html',
      buffer: Buffer.from('<!doctype html><html><body><h2>Berufserfahrung</h2><p>Beispiel GmbH · Entwickler · 01/2022–heute · Testregion</p></body></html>')
    });
    const ai = page.getByTestId('cv-ai-assist');
    const versions = page.getByTestId('cv-recognition-versions');
    await expect(ai).toBeVisible();
    await expect(versions).toContainText('1 Erkennungsstand');
    await expect(versions).toContainText('Deterministisch · Fallback');
    await expect(versions.getByTestId('cv-recognition-active')).toContainText('Deterministische Erkennung');
    await expect(ai).toContainText('Einfach prüfbar, nicht automatisch freigegeben');
    await expect(ai).toContainText('keine Root-MCP-Werkzeuge');
    await expect.poll(() => agentApi.cvRecognitionVersionListRequests.length).toBeGreaterThan(0);
    await expect.poll(() => agentApi.cvAiOptionsRequests.length).toBeGreaterThan(0);
    await expect.poll(() => agentApi.cvAiRunListRequests.length).toBeGreaterThan(0);
    await expect(ai.getByTestId('cv-ai-start')).toBeDisabled();
    await expect(ai.getByTestId('cv-ai-disclosure')).not.toBeChecked();

    await ai.getByTestId('cv-ai-disclosure').check();
    await expect(ai.getByTestId('cv-ai-start')).toBeEnabled();
    await ai.getByTestId('cv-ai-start').click();
    await expect.poll(() => agentApi.cvAiStartRequests.length).toBe(1);
    expect(agentApi.cvAiStartRequests[0]).toEqual({
      expectedRevision: 1, expectedSha256: '7'.repeat(64),
      provider: { providerId: 'fake-interactive', runtimeTarget: 'windows', expectedVersion: '1.0.0' },
      mode: 'replace_with_ai_version',
      disclosure: {
        version: '1.0', confirmed: true, sendExtractedCvTextToProvider: true,
        acknowledgeProviderControlPlaneNetwork: true
      }
    });
    await expect(ai.getByTestId('cv-ai-disclosure')).not.toBeChecked();
    await expect(ai.getByTestId('cv-ai-status')).toContainText('Wartet');
    await expect(ai.getByTestId('cv-ai-result')).toContainText('Neuer KI-Erkennungsstand aktiv', { timeout: 12_000 });
    await expect(versions).toContainText('2 Erkennungsstände');
    await expect(versions.getByTestId('cv-recognition-active')).toContainText('KI-Strukturierung');
    await expect(versions.getByTestId('cv-recognition-version-select')).toHaveValue('recognition-2222222222222222');
    await expect(page.locator('fieldset.cv-fact').filter({ hasText: 'role · Ungeprüft' })).toContainText('AI-erkannt, nicht AI-bestätigt');
    await expect(ai.getByTestId('cv-ai-apply')).toHaveCount(0);

    await versions.getByTestId('cv-recognition-version-select').selectOption('recognition-1111111111111111');
    await expect.poll(() => agentApi.cvRecognitionVersionActivationRequests.length).toBe(1);
    expect(agentApi.cvRecognitionVersionActivationRequests[0]).toEqual({
      versionId: 'recognition-1111111111111111',
      body: { expectedRevision: 2, expectedSha256: '2'.repeat(64), confirmed: true }
    });
    await expect(versions.getByTestId('cv-recognition-active')).toContainText('Deterministische Erkennung');
    await expect(page.locator('fieldset.cv-fact').filter({ hasText: 'period · Ungeprüft' })).toBeVisible();

    await versions.getByTestId('cv-recognition-version-select').selectOption('recognition-2222222222222222');
    await expect.poll(() => agentApi.cvRecognitionVersionActivationRequests.length).toBe(2);
    expect(agentApi.cvRecognitionVersionActivationRequests[1]).toEqual({
      versionId: 'recognition-2222222222222222',
      body: { expectedRevision: 3, expectedSha256: '3'.repeat(64), confirmed: true }
    });
    await expect(versions.getByTestId('cv-recognition-active')).toContainText('KI-Strukturierung');

    agentApi.seedStaleCvRecognitionActivation();
    await versions.getByTestId('cv-recognition-version-select').selectOption('recognition-1111111111111111');
    await expect.poll(() => agentApi.cvRecognitionVersionActivationRequests.length).toBe(3);
    expect(agentApi.cvRecognitionVersionActivationRequests[2]).toEqual({
      versionId: 'recognition-1111111111111111',
      body: { expectedRevision: 4, expectedSha256: '4'.repeat(64), confirmed: true }
    });
    await expect(versions.getByRole('alert')).toContainText('neueren Lebenslaufrevision');
    await expect(versions.getByTestId('cv-recognition-version-select')).toHaveValue('recognition-2222222222222222');
    await expect(versions.getByTestId('cv-recognition-active')).toContainText('KI-Strukturierung');

    await versions.getByTestId('cv-recognition-confirmation').check();
    await versions.getByTestId('cv-recognition-confirm').click();
    await expect.poll(() => agentApi.cvRecognitionVersionConfirmationRequests.length).toBe(1);
    expect(agentApi.cvRecognitionVersionConfirmationRequests[0]).toEqual({
      versionId: 'recognition-2222222222222222',
      body: { expectedRevision: 4, expectedSha256: '4'.repeat(64), confirmed: true }
    });
    await expect(versions).toContainText('keine ungeprüften Fakten mehr');
    await expect(page.locator('.cv-fact[data-decision="confirmed"]')).toHaveCount(5);
    expect(agentApi.cvAdoptionRequests).toHaveLength(0);
    await expectAxeClean(page, '[data-testid="cv-facts-step"]');
  });

  test('keeps the deterministic version active when AI structuring fails', async ({ page, agentApi }) => {
    test.setTimeout(20_000);
    await openCvStudio(page);
    await page.getByTestId('cv-file-input').setInputFiles({
      name: 'synthetischer-cv.html', mimeType: 'text/html', buffer: Buffer.from('<html><body>Fixture</body></html>')
    });
    const versions = page.getByTestId('cv-recognition-versions');
    const ai = page.getByTestId('cv-ai-assist');
    await expect(versions).toContainText('1 Erkennungsstand');
    agentApi.seedFailedCvAiStructuring();
    await ai.getByTestId('cv-ai-disclosure').check();
    await ai.getByTestId('cv-ai-start').click();
    await expect(ai.getByTestId('cv-ai-status')).toContainText('Fehlgeschlagen', { timeout: 8_000 });
    await expect(ai.getByTestId('cv-ai-status')).toContainText('fixture_ai_failed');
    await expect(versions).toContainText('1 Erkennungsstand');
    await expect(versions.getByTestId('cv-recognition-active')).toContainText('Deterministische Erkennung');
    expect(agentApi.cvRecognitionVersionActivationRequests).toHaveLength(0);
  });

  test('keeps the recognition controls keyboard-ready without page overflow at 320px', async ({ page, agentApi }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await openCvStudio(page);
    await page.getByTestId('cv-file-input').setInputFiles({
      name: 'synthetischer-cv.html', mimeType: 'text/html', buffer: Buffer.from('<html><body>Fixture</body></html>')
    });
    const versions = page.getByTestId('cv-recognition-versions');
    await expect.poll(() => agentApi.cvRecognitionVersionListRequests.length).toBeGreaterThan(0);
    await expect(versions.getByLabel('Aktiver Erkennungsstand')).toBeVisible();
    await expect(versions.getByTestId('cv-recognition-confirmation')).toBeVisible();
    const pageOverflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(pageOverflows).toBe(false);
    await expectAxeClean(page, '[data-testid="cv-facts-step"]');
  });

  test('cancels an AI run by run-CAS and retries only after a fresh disclosure', async ({ page, agentApi }) => {
    test.setTimeout(20_000);
    await openCvStudio(page);
    await page.getByTestId('cv-file-input').setInputFiles({
      name: 'synthetischer-cv.html', mimeType: 'text/html',
      buffer: Buffer.from('<!doctype html><html><body><p>Synthetische CV-Fixture</p></body></html>')
    });
    const ai = page.getByTestId('cv-ai-assist');
    await ai.getByTestId('cv-ai-disclosure').check();
    await ai.getByTestId('cv-ai-start').click();
    await ai.getByTestId('cv-ai-cancel').click();
    await expect.poll(() => agentApi.cvAiCancelRequests.length).toBe(1);
    expect(agentApi.cvAiCancelRequests[0]).toEqual({
      expectedRunRevision: 1, expectedRunSha256: 'a'.repeat(64), confirmed: true
    });
    await expect(ai.getByTestId('cv-ai-status')).toContainText('Abgebrochen', { timeout: 5_000 });
    await expect(ai.getByTestId('cv-ai-retry')).toBeDisabled();
    await ai.getByTestId('cv-ai-disclosure').check();
    await expect(ai.getByTestId('cv-ai-retry')).toBeEnabled();
    await ai.getByTestId('cv-ai-retry').click();
    await expect.poll(() => agentApi.cvAiRetryRequests.length).toBe(1);
    expect(agentApi.cvAiRetryRequests[0]).toEqual({
      expectedRunRevision: 3, expectedRunSha256: '4'.repeat(64),
      expectedCvImportRevision: 1, expectedCvImportSha256: '7'.repeat(64),
      provider: { providerId: 'fake-interactive', runtimeTarget: 'windows', expectedVersion: '1.0.0' },
      mode: 'replace_with_ai_version',
      disclosure: {
        version: '1.0', confirmed: true, sendExtractedCvTextToProvider: true,
        acknowledgeProviderControlPlaneNetwork: true
      }
    });
    await expect(ai.getByTestId('cv-ai-status')).toContainText(/Versuch\s*2/);
    await expect(ai.getByTestId('cv-ai-disclosure')).not.toBeChecked();
  });

  test('keeps future steps disabled and reports an unsupported upload without a request', async ({ page, agentApi }) => {
    agentApi.seedCvPipelineCase();
    await openCvStudio(page);
    const steps = page.locator('nav[aria-label="Lebenslauf-Schritte"]');
    await expect(steps.getByRole('button', { name: /2 Fakten/ })).toBeDisabled();
    await expect(steps.getByRole('button', { name: /6 Agentenlauf/ })).toBeDisabled();
    await page.getByTestId('cv-file-input').setInputFiles({ name: 'nicht-erlaubt.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture') });
    await expect(page.getByRole('alert')).toContainText('ausschließlich PDF, DOCX, ODT, HTML und HTM');
    expect(agentApi.cvImportRequests).toHaveLength(0);
    await expectAxeClean(page, '[data-testid="cv-import-step"]');
  });
});
