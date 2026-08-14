import { describe, expect, it } from 'vitest';
import { exportDocument, validateExport } from './document-export.js';

describe('document export', () => {
  it('creates real DOCX and PDF buffers from final text', async () => {
    const docx = await exportDocument('Guten Tag\n\nFinaler Text', 'docx');
    const pdf = await exportDocument('Guten Tag\n\nFinaler Text', 'pdf');
    expect(docx.data.subarray(0, 2).toString()).toBe('PK');
    expect(pdf.data.subarray(0, 4).toString()).toBe('%PDF');
    await expect(validateExport(docx.data, 'docx')).resolves.toMatchObject({ valid: true });
    await expect(validateExport(pdf.data, 'pdf')).resolves.toMatchObject({ valid: true, pages: 1 });
  });
  it('reports invalid and blank export payloads', async () => {
    await expect(validateExport(Buffer.from('invalid'), 'pdf')).resolves.toMatchObject({ valid: false, pages: 0 });
  });
  it('blocks internal evidence annotations', async () => {
    await expect(exportDocument('Fakt <!-- evidence: claim -->', 'pdf')).rejects.toThrow('Evidence');
  });
});
