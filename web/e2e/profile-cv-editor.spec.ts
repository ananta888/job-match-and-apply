import type { Page } from '@playwright/test';
import { expect, test } from './support/agent-api.fixture';

async function openProfile(page: Page): Promise<void> {
  await page.goto('/');
  const navigation = page.locator('nav[aria-label="Hauptnavigation"] button').filter({ hasText: 'Profil' });
  await expect(navigation).toBeVisible();
  await navigation.click();
  await expect(page.getByTestId('profile-recognized-cv')).toBeVisible();
}

test.describe('Profil & Identität – Mein erkannter Lebenslauf', () => {
  test('shows the recognized CV automatically and edits facts individually without losing drafts', async ({ page, agentApi }) => {
    test.setTimeout(60_000);
    agentApi.seedCvPipelineCase();
    agentApi.seedCvImport([
      { id: 'fact-language', category: 'language', recordId: 'language-de', field: 'language', value: 'Deutsch', decision: 'pending', provenance: { sourceSha256: '6'.repeat(64), anchor: 'Zeile 5', origin: 'imported' } },
      { id: 'fact-language-level', category: 'language', recordId: 'language-de', field: 'level', value: 'Muttersprache', decision: 'pending', provenance: { sourceSha256: '6'.repeat(64), anchor: 'Zeile 5', origin: 'imported' } },
    ]);
    await openProfile(page);
    const panel = page.getByTestId('profile-recognized-cv');
    await expect(panel).toContainText('Mein erkannter Lebenslauf');
    await expect(panel).toContainText('Beispiel GmbH');
    await expect(page.getByTestId('profile-cv-recognition')).toContainText('Deterministische Erkennung');

    // Start a period draft first — saving the employer must not drop it.
    const periodRow = panel.locator('.cv-fact').filter({ hasText: 'Zeitraum' });
    await periodRow.getByRole('button', { name: 'Korrigieren' }).click();
    await periodRow.locator('input').fill('2022–2027 Entwurf');

    const employerRow = panel.locator('.cv-fact').filter({ hasText: 'Arbeitgeber' });
    await employerRow.getByRole('button', { name: 'Korrigieren' }).click();
    await employerRow.locator('input').fill('Beispiel AG');
    await employerRow.getByRole('button', { name: 'Änderung speichern' }).click();
    await expect.poll(() => agentApi.cvFactReviewRequests.length).toBe(1);
    expect(agentApi.cvFactReviewRequests[0]).toMatchObject({
      expectedRevision: 1, expectedSha256: '7'.repeat(64), confirmed: true,
      operations: [expect.objectContaining({ action: 'edit', factId: 'fact-employer', value: 'Beispiel AG' })],
    });
    await expect(panel.locator('.cv-fact').filter({ hasText: 'Beispiel AG' })).toContainText('(Korrektur)');
    await expect(periodRow.locator('input')).toHaveValue('2022–2027 Entwurf');

    // Language level is individually correctable (not read-only).
    const levelRow = panel.locator('.cv-fact').filter({ hasText: 'Niveau' });
    await levelRow.getByRole('button', { name: 'Niveau korrigieren' }).click();
    await levelRow.locator('input').fill('C2');
    await levelRow.getByRole('button', { name: 'Speichern' }).click();
    await expect.poll(() => agentApi.cvFactReviewRequests.length).toBe(2);
    expect(agentApi.cvFactReviewRequests[1].operations[0]).toMatchObject({ action: 'edit', factId: 'fact-language-level', value: 'C2' });

    // Corrections stay unverified until an explicit decision; rejection is possible.
    const correctedRow = panel.locator('.cv-fact').filter({ hasText: 'Beispiel AG' });
    await expect(correctedRow).toHaveAttribute('data-decision', 'pending');
    await correctedRow.getByRole('button', { name: 'Bestätigen' }).click();
    await expect.poll(() => agentApi.cvFactReviewRequests.length).toBe(3);
    expect(agentApi.cvFactReviewRequests[2].operations[0]).toMatchObject({ action: 'confirm' });
    // The correction was accepted as a NEW unverified fact; only its explicit
    // confirmation targets the new id, never the superseded import fact.
    expect(agentApi.cvFactReviewRequests[2].operations[0].factId).not.toBe('fact-employer');
    const languageRow = panel.locator('.cv-fact').filter({ hasText: 'Deutsch' });
    await languageRow.getByRole('button', { name: 'Sprache nicht verwenden' }).click();
    await expect.poll(() => agentApi.cvFactReviewRequests.length).toBe(4);
    expect(agentApi.cvFactReviewRequests[3].operations[0]).toMatchObject({ action: 'reject', factId: 'fact-language' });
  });

  test('masks recognized contact values in the secure demo state until explicitly revealed', async ({ page, agentApi }) => {
    test.setTimeout(30_000);
    agentApi.seedCvPipelineCase();
    agentApi.seedCvImport([
      { id: 'fact-contact-email', category: 'contact', recordId: 'person-fixture', field: 'email', value: 'person@example.org', decision: 'pending', provenance: { sourceSha256: '6'.repeat(64), anchor: 'Zeile 1', origin: 'imported' } },
    ]);
    await openProfile(page);
    const panel = page.getByTestId('profile-recognized-cv');
    await expect(panel.locator('[data-testid="cv-fact-masked"]').first()).toBeVisible();
    await expect(panel).not.toContainText('person@example.org');
    await panel.getByRole('button', { name: 'Sensible Werte bewusst anzeigen' }).click();
    await expect(panel).toContainText('person@example.org');
    await expect(panel.locator('[data-testid="cv-fact-masked"]')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Sensible Werte verbergen' }).click();
    await expect(panel).not.toContainText('person@example.org');
  });

  test('keeps technical details secondary and offers a studio upload entry without an import', async ({ page, agentApi }) => {
    test.setTimeout(30_000);
    agentApi.seedCvPipelineCase();
    agentApi.seedCvImport();
    await openProfile(page);
    const panel = page.getByTestId('profile-recognized-cv');
    const technical = panel.locator('details.cv-fact-technical').first();
    await expect(technical.locator('summary')).toHaveText('Technische Details');
    await expect(technical).not.toHaveAttribute('open', '');
    await technical.locator('summary').click();
    await expect(technical).toContainText('fact-employer');

    // Without an import the panel explains the upload entry instead of empty tech.
    await page.reload();
    const api = agentApi;
    api.useCvImport(undefined);
    await openProfile(page);
    await expect(panel).toContainText('Noch kein Lebenslauf erkannt');
    await panel.getByRole('button', { name: 'Zum Upload im Lebenslauf-Studio' }).click();
    await expect(page.getByTestId('cv-import-step')).toBeVisible();
  });
});
