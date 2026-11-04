/**
 * Contract cv-extraction 1.0 (contracts/v1/cv-extraction.schema.json): the
 * deterministic layout result of a CV import (text layer and/or OCR) with
 * pages, columns and blocks in reading order. Validated structurally here,
 * mirrored by the Lab's shared/contracts validator.
 */
export const CV_EXTRACTION_SOURCE_KINDS = ['text-layer', 'ocr', 'text-layer+ocr', 'docx', 'html', 'txt'] as const;
export const CV_EXTRACTION_BLOCK_KINDS = ['heading', 'paragraph', 'list-item', 'date-line', 'contact', 'unknown'] as const;
export const CV_EXTRACTION_TRIGGERS = ['missing-text-layer', 'thin-text-layer', 'image', 'always', 'none'] as const;
const SECTIONS = ['profile', 'contact', 'employment', 'project', 'education', 'skill', 'certification', 'language', 'additional', 'unknown'];
const COLUMN_ID = /^p[0-9]{1,2}c[0-9]$/;
const BLOCK_ID = /^p[0-9]{1,2}c[0-9]b[0-9]{2,3}$/;

export interface CvExtractionBlock {
  id: string; column: string; order: number; kind: typeof CV_EXTRACTION_BLOCK_KINDS[number];
  bbox: [number, number, number, number]; confidence: number; lines: string[];
}
export interface CvExtractionPage {
  page: number; width: number; height: number;
  columns: Array<{ id: string; x: number; width: number; role: 'main' | 'side' }>;
  blocks: CvExtractionBlock[];
}
export interface CvExtractionDocument {
  contract: 'cv-extraction'; contractVersion: '1.0';
  source: {
    kind: typeof CV_EXTRACTION_SOURCE_KINDS[number]; sha256: string; fileName?: string; engine?: string;
    languages?: string[]; ocrTriggered?: typeof CV_EXTRACTION_TRIGGERS[number]; textLayerChars?: number;
  };
  pages: CvExtractionPage[];
  headings: Array<{ block: string; text: string; section?: string }>;
  layoutFingerprint?: unknown;
  warnings: string[];
}

/** Public summary without any text: what the UI needs to explain the recognition path. */
export interface CvExtractionSummary {
  kind: CvExtractionDocument['source']['kind']; ocrTriggered: string; engine: string; pages: number; blocks: number;
  columns: number; textLayerChars: number; meanConfidence: number; warnings: string[];
}

class CvExtractionError extends Error { statusCode = 502; code = 'cv_extraction_invalid'; }
const fail = (message: string): never => { throw new CvExtractionError(`cv-extraction ungültig: ${message}`); };
const int = (value: unknown, min: number, max: number) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const str = (value: unknown, max: number) => typeof value === 'string' && value.length <= max;

export function validateCvExtraction(value: unknown): CvExtractionDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Dokument fehlt.');
  const doc = value as Record<string, unknown>;
  if (doc.contract !== 'cv-extraction' || doc.contractVersion !== '1.0') fail('Vertrag oder Version stimmt nicht.');
  for (const key of Object.keys(doc)) if (!['contract', 'contractVersion', 'source', 'pages', 'headings', 'layoutFingerprint', 'warnings'].includes(key)) fail(`unbekanntes Feld ${key}.`);
  const source = doc.source as Record<string, unknown>;
  if (!source || typeof source !== 'object' || !(CV_EXTRACTION_SOURCE_KINDS as readonly string[]).includes(String(source.kind)) || !/^[a-f0-9]{64}$/.test(String(source.sha256))) fail('Quelle ungültig.');
  if (source.fileName !== undefined && !str(source.fileName, 200)) fail('Dateiname ungültig.');
  if (source.engine !== undefined && !str(source.engine, 120)) fail('Engine ungültig.');
  if (source.languages !== undefined && !(Array.isArray(source.languages) && source.languages.length <= 4 && source.languages.every((item) => /^[a-z]{3}$/.test(String(item))))) fail('Sprachen ungültig.');
  if (source.ocrTriggered !== undefined && !(CV_EXTRACTION_TRIGGERS as readonly string[]).includes(String(source.ocrTriggered))) fail('OCR-Auslöser ungültig.');
  if (source.textLayerChars !== undefined && !int(source.textLayerChars, 0, 2_000_000)) fail('Textschichtzähler ungültig.');
  const pages = doc.pages as unknown[];
  if (!Array.isArray(pages) || pages.length > 30) fail('Seiten ungültig.');
  if (!Array.isArray(doc.warnings) || doc.warnings.length > 100 || !doc.warnings.every((item) => str(item, 500))) fail('Warnungen ungültig.');
  const blockIds = new Set<string>();
  for (const raw of pages) {
    const page = raw as Record<string, unknown>;
    if (!page || typeof page !== 'object' || !int(page.page, 1, 30) || !int(page.width, 1, 20_000) || !int(page.height, 1, 20_000)) fail('Seite ungültig.');
    const pageColumns = page.columns as unknown[];
    if (!Array.isArray(pageColumns) || pageColumns.length < 1 || pageColumns.length > 4) fail(`Spalten von Seite ${page.page} ungültig.`);
    const columns = new Set<string>();
    for (const rawColumn of pageColumns) {
      const column = rawColumn as Record<string, unknown>;
      if (!COLUMN_ID.test(String(column.id)) || !String(column.id).startsWith(`p${page.page}c`) || !int(column.x, 0, 20_000) || !int(column.width, 1, 20_000)
        || !['main', 'side'].includes(String(column.role)) || (column.x as number) + (column.width as number) > (page.width as number) || columns.has(String(column.id))) fail(`Spalte auf Seite ${page.page} ungültig.`);
      columns.add(String(column.id));
    }
    const pageBlocks = page.blocks as unknown[];
    if (!Array.isArray(pageBlocks) || pageBlocks.length > 400) fail(`Blöcke von Seite ${page.page} ungültig.`);
    let previous = -1;
    for (const rawBlock of pageBlocks) {
      const block = rawBlock as Record<string, unknown>;
      if (!block || typeof block !== 'object' || !BLOCK_ID.test(String(block.id)) || blockIds.has(String(block.id))) fail('Blockkennung ungültig oder doppelt.');
      if (!columns.has(String(block.column)) || !String(block.id).startsWith(`${block.column}b`)) fail(`Block ${block.id} passt nicht zu seiner Spalte.`);
      if (!int(block.order, 0, 999) || (block.order as number) <= previous) fail(`Blockreihenfolge auf Seite ${page.page} ungültig.`);
      previous = block.order as number;
      if (!(CV_EXTRACTION_BLOCK_KINDS as readonly string[]).includes(String(block.kind))) fail(`Blockart von ${block.id} ungültig.`);
      const bbox = block.bbox as unknown[];
      if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((item) => int(item, 0, 20_000))
        || (bbox[0] as number) + (bbox[2] as number) > (page.width as number) || (bbox[1] as number) + (bbox[3] as number) > (page.height as number)) fail(`Box von ${block.id} ungültig.`);
      if (typeof block.confidence !== 'number' || !(block.confidence >= 0 && block.confidence <= 1)) fail(`Konfidenz von ${block.id} ungültig.`);
      if (!Array.isArray(block.lines) || block.lines.length < 1 || block.lines.length > 200 || !block.lines.every((line) => str(line, 2000) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(line as string))) fail(`Zeilen von ${block.id} ungültig.`);
      blockIds.add(String(block.id));
    }
  }
  const headings = doc.headings as unknown[];
  if (!Array.isArray(headings) || headings.length > 200) fail('Überschriften ungültig.');
  for (const rawHeading of headings) {
    const heading = rawHeading as Record<string, unknown>;
    if (!heading || !blockIds.has(String(heading.block)) || !str(heading.text, 200) || !(heading.text as string).length) fail('Überschrift ungültig.');
    if (heading.section !== undefined && !SECTIONS.includes(String(heading.section))) fail('Abschnitt einer Überschrift ungültig.');
  }
  return structuredClone(value) as CvExtractionDocument;
}

export function summarizeCvExtraction(document: CvExtractionDocument): CvExtractionSummary {
  const blocks = document.pages.flatMap((page) => page.blocks);
  return {
    kind: document.source.kind, ocrTriggered: document.source.ocrTriggered ?? 'none', engine: document.source.engine ?? '',
    pages: document.pages.length, blocks: blocks.length, columns: Math.max(0, ...document.pages.map((page) => page.columns.length)),
    textLayerChars: document.source.textLayerChars ?? 0,
    meanConfidence: blocks.length ? Math.round(blocks.reduce((sum, block) => sum + block.confidence, 0) / blocks.length * 1000) / 1000 : 0,
    warnings: [...document.warnings],
  };
}
