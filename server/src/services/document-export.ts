import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph } from 'docx';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

export type ExportFormat = 'docx' | 'pdf';
export interface ExportQuality { valid: boolean; pages?: number; extractedCharacters: number; warnings: string[] }

function assertFinal(content: string): void {
  if (/<!--\s*evidence:/i.test(content)) throw Object.assign(new Error('Finaler Export enthält interne Evidence-Annotationen.'), { statusCode: 409 });
}

export async function exportDocument(content: string, format: ExportFormat): Promise<{ mimeType: string; extension: string; data: Buffer }> {
  assertFinal(content);
  if (format === 'docx') {
    const document = new Document({
      creator: 'Job Match & Apply', title: 'Bewerbungsdokument', description: 'Lokal erzeugtes Bewerbungsdokument',
      sections: [{ children: content.split(/\r?\n/).map((line) => new Paragraph({ text: line })) }]
    });
    return { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: 'docx', data: await Packer.toBuffer(document) };
  }
  const pdf = new PDFDocument({ autoFirstPage: true, info: { Title: 'Bewerbungsdokument', Author: 'Job Match & Apply', Creator: 'Job Match & Apply' } });
  const chunks: Buffer[] = [];
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
  const completed = new Promise<Buffer>((resolve, reject) => { pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject); });
  pdf.font('Helvetica').fontSize(11).text(content, { lineGap: 4 });
  pdf.end();
  return { mimeType: 'application/pdf', extension: 'pdf', data: await completed };
}

export async function validateExport(data: Buffer, format: ExportFormat): Promise<ExportQuality> {
  if (format === 'docx') {
    if (data.subarray(0, 2).toString() !== 'PK') return { valid: false, extractedCharacters: 0, warnings: ['DOCX-Signatur fehlt.'] };
    const result = await mammoth.extractRawText({ buffer: data });
    const characters = result.value.trim().length;
    const warnings = result.messages.map((item) => item.message);
    if (characters === 0) warnings.push('Export enthält keinen lesbaren Text.');
    return { valid: characters > 0, extractedCharacters: characters, warnings };
  }
  if (data.subarray(0, 4).toString() !== '%PDF') return { valid: false, pages: 0, extractedCharacters: 0, warnings: ['PDF-Signatur fehlt.'] };
  const parser = new PDFParse({ data, isEvalSupported: false, stopAtErrors: true });
  try {
    const extracted = await parser.getText({ pageJoiner: '\n---PAGE---\n' });
    const warnings: string[] = [];
    for (let page = 1; page <= extracted.total; page += 1) {
      if (extracted.getPageText(page).trim().length === 0) warnings.push(`Leere Seite ${page}.`);
    }
    if (extracted.text.trim().length === 0) warnings.push('Export enthält keinen lesbaren Text.');
    return { valid: warnings.length === 0, pages: extracted.total, extractedCharacters: extracted.text.trim().length, warnings };
  } finally { await parser.destroy(); }
}
