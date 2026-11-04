import { describe, expect, it } from 'vitest';
import { summarizeCvExtraction, validateCvExtraction } from './cv-extraction.js';

const sample = () => ({
  contract: 'cv-extraction', contractVersion: '1.0',
  source: { kind: 'text-layer', sha256: 'a'.repeat(64), engine: 'pdftotext', languages: ['deu'], ocrTriggered: 'none', textLayerChars: 40 },
  pages: [{ page: 1, width: 600, height: 800, columns: [{ id: 'p1c1', x: 0, width: 200, role: 'side' }, { id: 'p1c2', x: 200, width: 400, role: 'main' }],
    blocks: [
      { id: 'p1c1b01', column: 'p1c1', order: 0, kind: 'heading', bbox: [10, 10, 100, 12], confidence: 1, lines: ['Kenntnisse'] },
      { id: 'p1c2b01', column: 'p1c2', order: 1, kind: 'date-line', bbox: [210, 10, 300, 12], confidence: 0.9, lines: ['03/2024 - 03/2025 Beispiel GmbH'] },
    ] }],
  headings: [{ block: 'p1c1b01', text: 'Kenntnisse', section: 'skill' }], warnings: [],
});

describe('cv-extraction contract', () => {
  it('accepts a well-formed document and summarises it without text', () => {
    const document = validateCvExtraction(sample());
    expect(summarizeCvExtraction(document)).toEqual({ kind: 'text-layer', ocrTriggered: 'none', engine: 'pdftotext', pages: 1, blocks: 2, columns: 2, textLayerChars: 40, meanConfidence: 0.95, warnings: [] });
  });
  it.each<[string, (value: ReturnType<typeof sample>) => void]>([
    ['duplicate block', (v) => { v.pages[0]!.blocks[1]!.id = 'p1c1b01'; }],
    ['wrong column', (v) => { v.pages[0]!.blocks[1]!.column = 'p1c1'; }],
    ['order', (v) => { v.pages[0]!.blocks[1]!.order = 0; }],
    ['bbox outside', (v) => { v.pages[0]!.blocks[0]!.bbox = [590, 10, 100, 12]; }],
    ['heading reference', (v) => { v.headings[0]!.block = 'p1c2b09'; }],
    ['control char', (v) => { v.pages[0]!.blocks[0]!.lines = ['Kenn\u0007tnisse']; }],
    ['kind', (v) => { (v.source as { kind: string }).kind = 'scan'; }],
    ['extra field', (v) => { (v as Record<string, unknown>).extra = 1; }],
  ])('rejects %s', (_, mutate) => {
    const value = sample(); mutate(value);
    expect(() => validateCvExtraction(value)).toThrow(/cv-extraction ungültig/);
  });
});
