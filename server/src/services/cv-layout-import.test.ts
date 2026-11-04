import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SubmoduleCvNormalizationAdapter } from '../adapters/submodule-cv-normalization.js';
import { CvImportService, JsonCvImportRepository, publicCvImportRecord, type CvImportRecord } from './cv-imports.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const available = (tool: string) => { try { execFileSync('which', [tool], { stdio: 'ignore' }); return true; } catch { return false; } };

interface PdfText { text: string; x: number; y: number; size?: number }

/** Hand-built synthetic PDF (Helvetica, absolute text positions). No personal data. */
function buildPdf(pages: PdfText[][]): Buffer {
  const escape = (value: string) => value.replace(/[\\()]/g, '\\$&');
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objects.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  for (const [index, texts] of pages.entries()) {
    const content = texts.map((item) => `BT /F1 ${item.size ?? 10} Tf ${item.x} ${item.y} Td (${escape(item.text)}) Tj ET`).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[index]! + 1} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** Synthetic two-column CV: sidebar with skills/languages, main column with dated stations. */
function twoColumnPdf(): Buffer {
  return buildPdf([
    [
      { text: 'Kenntnisse', x: 40, y: 780, size: 14 },
      { text: 'Java, Spring, PostgreSQL, TypeScript, Angular', x: 40, y: 755 },
      { text: 'Sprachen', x: 40, y: 660, size: 14 },
      { text: 'Deutsch', x: 40, y: 635 },
      { text: 'Englisch', x: 40, y: 620 },
      { text: 'BERUFSERFAHRUNG', x: 260, y: 780, size: 18 },
      { text: '03/2024 - 03/2025 Beispiel GmbH - Softwareentwicklung', x: 260, y: 750 },
      { text: '• Backend mit Java und PostgreSQL.', x: 270, y: 735 },
      { text: '• Tests und Wartung bestehender Anwendungen.', x: 270, y: 720 },
      { text: 'AUSBILDUNG', x: 260, y: 630, size: 18 },
      { text: '09/2018 - 06/2021 Ausbildung zur Fachinformatikerin bei der', x: 260, y: 600 },
      { text: 'Firma Muster in Beispielstadt', x: 260, y: 585 },
    ],
  ]);
}

function thinTextPdf(): Buffer {
  return buildPdf([[{ text: 'Kurz', x: 40, y: 780 }]]);
}

function multiPagePdf(count: number): Buffer {
  return buildPdf(Array.from({ length: count }, () => [{ text: 'Seite', x: 40, y: 780 }]));
}

async function serviceWith(root: string, overrides?: Record<string, unknown>, ocrMode: 'auto' | 'always' | 'off' = 'off'): Promise<CvImportService> {
  // The adapter pins private profiles to the repository's .local-data/profiles;
  // fixtures live there temporarily and are removed with the test roots.
  const { mkdir } = await import('node:fs/promises');
  const profilesRoot = resolve('../.local-data', 'profiles');
  await mkdir(profilesRoot, { recursive: true });
  const profileDir = await mkdtemp(join(profilesRoot, 'test-'));
  roots.push(profileDir);
  const adapter = new SubmoduleCvNormalizationAdapter(
    resolve('../integrations/bewerbungs-schreib-assistent'),
    join(profileDir, 'candidate-profile.yaml'), join(profileDir, 'style-profile.yaml'),
  );
  const normalization = overrides ? Object.assign(Object.create(Object.getPrototypeOf(adapter)), adapter, overrides) : adapter;
  return new CvImportService(new JsonCvImportRepository(join(root, 'imports'), join(root, 'key')), normalization, { mode: ocrMode, minCharsPerPage: 200, languages: 'deu+eng' });
}

async function assertNoTransientRenderLeftovers(): Promise<void> {
  const entries = await readdir(tmpdir());
  expect(entries.filter((name) => name.startsWith('cv-layout-') || name.startsWith('cv-render-'))).toEqual([]);
}

describe('structured CV import through the layout extraction', () => {
  it.skipIf(!available('pdftotext'))('extracts columns, stations and skills from the text layer and keeps the block map private', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cvimp-import-')); roots.push(root);
    const service = await serviceWith(root);
    const record = await service.import({ fileName: 'zweispalter.pdf', mimeType: 'application/pdf', data: twoColumnPdf() });
    expect(record.extractionSummary).toMatchObject({ kind: 'text-layer', ocrTriggered: 'none', pages: 1, columns: 2 });
    expect(record.layoutExtraction?.pages[0]?.columns.map((column) => column.role)).toEqual(['side', 'main']);
    const byCategory = (category: string) => record.facts.filter((fact) => fact.category === category);
    expect(byCategory('skill').map((fact) => fact.value)).toEqual(['Java', 'Spring', 'PostgreSQL', 'TypeScript', 'Angular']);
    expect(byCategory('language').map((fact) => fact.value)).toEqual(['Deutsch', 'Englisch']);
    const employment = byCategory('employment');
    expect(employment.find((fact) => fact.field === 'company')?.value).toBe('Beispiel GmbH');
    expect(employment.find((fact) => fact.field === 'role')?.value).toBe('Softwareentwicklung');
    expect(educationOrDetails(byCategory('education'))).toBe(true);
    // Layout blocks reach the AI source line manifest; anchors stay verifiable.
    const aiSource = await service.loadAiSource(record.id);
    expect(JSON.parse(aiSource!.lineManifestJson).lines.some((line: { text: string }) => line.text === 'Kenntnisse')).toBe(true);
    // REST view carries the summary but never the block texts.
    const view = publicCvImportRecord(record) as Record<string, unknown>;
    expect(view.extractionSummary).toBeDefined();
    expect(view.layoutExtraction).toBeUndefined();
    await assertNoTransientRenderLeftovers();
  });

  it.skipIf(!available('pdftoppm') || !available('tesseract') || !available('pdftotext'))('reads an image scan through local OCR deu+eng and fails closed without OCR', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cvimp-ocr-')); roots.push(root);
    const renderDir = await mkdtemp(join(tmpdir(), 'cv-test-render-')); roots.push(renderDir);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'x.pdf'), twoColumnPdf());
    execFileSync('pdftoppm', ['-png', '-scale-to', '1600', '-f', '1', '-l', '1', join(root, 'x.pdf'), join(renderDir, 'page')], { timeout: 30_000 });
    const { readFile } = await import('node:fs/promises');
    const names = (await readdir(renderDir)).filter((name) => name.endsWith('.png')).sort();
    const scan = await readFile(join(renderDir, names[0]!));
    const service = await serviceWith(root);
    const record = await service.import({ fileName: 'scan.png', mimeType: 'image/png', data: scan });
    expect(record.extractionSummary).toMatchObject({ kind: 'ocr', ocrTriggered: 'always', pages: 1 });
    expect(record.extractionSummary!.textLayerChars).toBe(0);
    expect(record.facts.some((fact) => fact.value.includes('Beispiel'))).toBe(true);
    await assertNoTransientRenderLeftovers();

    // Without the OCR pipeline an image scan must not silently import empty facts.
    const broken = await serviceWith(join(root, 'broken'), { extractLayout: undefined, normalizeExtraction: undefined });
    await expect(broken.import({ fileName: 'scan.png', mimeType: 'image/png', data: scan }))
      .rejects.toThrow(/Bildscan kann nur mit lokaler OCR/);
    await assertNoTransientRenderLeftovers();
  });

  it.skipIf(!available('pdftoppm') || !available('tesseract') || !available('pdftotext'))('combines a thin text layer with OCR deterministically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cvimp-thin-')); roots.push(root);
    const service = await serviceWith(root, undefined, 'auto');
    const record = await service.import({ fileName: 'duenn.pdf', mimeType: 'application/pdf', data: thinTextPdf() });
    expect(record.extractionSummary!.ocrTriggered).toBe('thin-text-layer');
    expect(record.extractionSummary!.kind).toBe('text-layer+ocr');
    expect(record.extractionSummary!.textLayerChars).toBeGreaterThan(0);
    await assertNoTransientRenderLeftovers();
  });

  it('falls back to the flat text with a warning when the layout tools are unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cvimp-fallback-')); roots.push(root);
    const service = await serviceWith(root, { extractLayout: async () => { throw new Error('extractor_unavailable'); } });
    const record = await service.import({ fileName: 'zweispalter.pdf', mimeType: 'application/pdf', data: twoColumnPdf() });
    expect(record.extractionSummary).toBeUndefined();
    expect(record.warnings.some((warning) => /Layout-\/OCR-Erfassung nicht verfügbar/.test(warning))).toBe(true);
    expect(record.facts.length).toBeGreaterThan(0);
  });

  it.skipIf(!available('pdftotext'))('caps rendered pages and cleans temporary files after success and real failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cvimp-pages-')); roots.push(root);
    const service = await serviceWith(root);
    const record = await service.import({ fileName: 'vielseitig.pdf', mimeType: 'application/pdf', data: multiPagePdf(31) });
    expect(record.extractionSummary!.pages).toBeLessThanOrEqual(30);
    await assertNoTransientRenderLeftovers();
    // A real parser failure inside the extraction must still clean its temp dirs.
    const { SubmoduleCvNormalizationAdapter: Adapter } = await import('../adapters/submodule-cv-normalization.js');
    const failingAdapter = new Adapter(resolve('../integrations/bewerbungs-schreib-assistent'), join(root, 'candidate-profile.yaml'), join(root, 'style-profile.yaml'));
    await expect(failingAdapter.extractLayout!({
      pdf: twoColumnPdf(), images: [Buffer.from('this is not a png')],
      sha256: 'a'.repeat(64), fileName: 'x.pdf', ocrMode: 'always', minCharsPerPage: 200, languages: 'deu+eng',
    })).rejects.toThrow();
    await assertNoTransientRenderLeftovers();
  });

  it('keeps non-PDF imports on the flat path unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cvimp-html-')); roots.push(root);
    const service = await serviceWith(root);
    const record = await service.import({
      fileName: 'lebenslauf.html', mimeType: 'text/html',
      data: Buffer.from('<html><body><h1>Kenntnisse</h1><p>Java, Spring</p></body></html>', 'utf8'),
    });
    expect(record.extractionSummary).toBeUndefined();
    expect(record.facts.length).toBeGreaterThan(0);
  });
});

function educationOrDetails(education: CvImportRecord['facts']): boolean {
  return education.some((fact) => fact.field === 'institution' && fact.value === 'Firma Muster')
    && education.some((fact) => fact.field === 'location' && fact.value === 'Beispielstadt');
}
