import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import {
  assignPdfHeadingColumns, classifyLayoutSection, defaultLayoutFingerprint, extractLayoutFingerprint,
  sanitizeHexColor, validateLayoutFingerprint,
} from './cv-layout-fingerprint.js';

const html = (body: string, head = '') =>
  Buffer.from(`<!doctype html><html lang="de"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`);

async function docx(documentXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="w">${documentXml}</w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}
async function odt(contentBody: string, stylesXml = ''): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('content.xml', `<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:text="t" xmlns:style="s" xmlns:fo="f">${contentBody}</office:document-content>`);
  zip.file('styles.xml', `<?xml version="1.0"?><office:document-styles xmlns:office="o" xmlns:style="s" xmlns:text="t" xmlns:fo="f">${stylesXml}</office:document-styles>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('sanitizeHexColor', () => {
  it('normalises safe colour tokens and rejects unsafe ones', () => {
    expect(sanitizeHexColor('#ABC')).toBe('#aabbcc');
    expect(sanitizeHexColor('#1D4ED8')).toBe('#1d4ed8');
    expect(sanitizeHexColor('rgb(29, 78, 216)')).toBe('#1d4ed8');
    expect(sanitizeHexColor('rgba(0,0,0,0.5)')).toBe('#000000');
    expect(sanitizeHexColor('navy')).toBe('#000080');
    expect(sanitizeHexColor('url(https://evil/x)')).toBeUndefined();
    expect(sanitizeHexColor('expression(alert(1))')).toBeUndefined();
    expect(sanitizeHexColor('#12g')).toBeUndefined();
    expect(sanitizeHexColor('')).toBeUndefined();
  });
});

describe('classifyLayoutSection', () => {
  it('maps German and English CV headings to ATS sections', () => {
    expect(classifyLayoutSection('Berufserfahrung')).toBe('employment');
    expect(classifyLayoutSection('Work Experience')).toBe('employment');
    expect(classifyLayoutSection('Ausbildung')).toBe('education');
    expect(classifyLayoutSection('Kenntnisse & Skills')).toBe('skill');
    expect(classifyLayoutSection('Sprachen')).toBe('language');
    expect(classifyLayoutSection('Zertifikate')).toBe('certification');
    expect(classifyLayoutSection('Kurzprofil')).toBe('profile');
    expect(classifyLayoutSection('Lieblingsfarbe')).toBeUndefined();
  });
});

describe('extractLayoutFingerprint — HTML', () => {
  it('reads the synthetic two-column fixture as a side/main layout', async () => {
    const buffer = readFileSync(resolve(process.cwd(), '../contracts/fixtures/v1/synthetic-two-column-cv.html'));
    const fingerprint = await extractLayoutFingerprint('text/html', buffer);
    expect(fingerprint.columns).toBe(2);
    const bySection = Object.fromEntries(fingerprint.sections.map((entry) => [entry.section, entry.column]));
    expect(bySection.profile).toBe('side');
    expect(bySection.employment).toBe('main');
  });

  it('captures section order, colours and a two-column split from a styled CV', async () => {
    const buffer = html(
      `<div class="cv">
         <aside class="sidebar">
           <h2>Profil</h2><p>Text</p>
           <h2>Kenntnisse</h2><ul><li>TypeScript</li></ul>
           <h2>Sprachen</h2><p>Deutsch</p>
         </aside>
         <main>
           <h2>Berufserfahrung</h2><p>Rolle</p>
           <h2>Ausbildung</h2><p>Studium</p>
         </main>
       </div>`,
      `<style>body{color:#222222;background:#ffffff}h2{color:#7c3aed}.sidebar{background:#0f172a;width:30%}</style>`,
    );
    const fingerprint = await extractLayoutFingerprint('text/html', buffer);
    expect(fingerprint.sourceFormat).toBe('html');
    expect(fingerprint.columns).toBe(2);
    expect(fingerprint.palette.accent).toBe('#7c3aed');
    expect(fingerprint.palette.background).toBe('#ffffff');
    expect(fingerprint.palette.sidebar).toBe('#0f172a');
    const bySection = Object.fromEntries(fingerprint.sections.map((entry) => [entry.section, entry.column]));
    expect(bySection.profile).toBe('side');
    expect(bySection.skill).toBe('side');
    expect(bySection.employment).toBe('main');
    expect(bySection.education).toBe('main');
    // order preserved: profile before employment
    expect(fingerprint.sections.map((entry) => entry.section)).toEqual(['profile', 'skill', 'language', 'employment', 'education']);
  });

  it('falls back to a single-column default when no headings are recognised', async () => {
    const fingerprint = await extractLayoutFingerprint('text/html', html('<p>Nur Fließtext ohne Überschriften</p>'));
    expect(fingerprint.columns).toBe(1);
    expect(fingerprint.warnings).toContain('structure_not_detected');
    expect(fingerprint.confidence).toBe('low');
    expect(fingerprint.sections.length).toBeGreaterThan(0);
  });

  it('never emits an unsafe colour even when the source declares one', async () => {
    const fingerprint = await extractLayoutFingerprint('text/html',
      html('<h2>Berufserfahrung</h2><p>x</p>', '<style>h2{color:url("https://evil/x")}body{color:#333333}</style>'));
    for (const value of Object.values(fingerprint.palette)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('extractLayoutFingerprint — DOCX/ODT', () => {
  it('reads heading order and an accent colour from a DOCX body', async () => {
    const buffer = await docx(
      `<w:body>
         <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:color w:val="047857"/></w:rPr><w:t>Berufserfahrung</w:t></w:r></w:p>
         <w:p><w:r><w:t>Softwareentwickler</w:t></w:r></w:p>
         <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:color w:val="047857"/></w:rPr><w:t>Ausbildung</w:t></w:r></w:p>
       </w:body>`,
    );
    const fingerprint = await extractLayoutFingerprint('application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer);
    expect(fingerprint.sourceFormat).toBe('docx');
    expect(fingerprint.sections.map((entry) => entry.section)).toEqual(['employment', 'education']);
    expect(fingerprint.palette.accent).toBe('#047857');
  });

  it('reads heading order from an ODT body', async () => {
    const buffer = await odt(
      `<office:body><text:h text:style-name="H1">Kenntnisse</text:h><text:h text:style-name="H1">Sprachen</text:h></office:body>`,
      `<style:style style:name="H1"><style:text-properties fo:color="#1d4ed8"/></style:style>`,
    );
    const fingerprint = await extractLayoutFingerprint('application/vnd.oasis.opendocument.text', buffer);
    expect(fingerprint.sourceFormat).toBe('odt');
    expect(fingerprint.sections.map((entry) => entry.section)).toEqual(['skill', 'language']);
    expect(fingerprint.palette.accent).toBe('#1d4ed8');
  });
});

describe('assignPdfHeadingColumns', () => {
  it('infers a two-column split when sidebar and main section groups both appear', () => {
    const warnings: string[] = [];
    const headings = assignPdfHeadingColumns([
      { label: 'Profil', section: 'profile', column: 'main' },
      { label: 'Kenntnisse', section: 'skill', column: 'main' },
      { label: 'Berufserfahrung', section: 'employment', column: 'main' },
      { label: 'Ausbildung', section: 'education', column: 'main' },
    ], warnings);
    expect(warnings).toContain('pdf_columns_inferred_from_section_mix');
    expect(headings.find((hit) => hit.section === 'profile')?.column).toBe('side');
    expect(headings.find((hit) => hit.section === 'skill')?.column).toBe('side');
    expect(headings.find((hit) => hit.section === 'employment')?.column).toBe('main');
    expect(headings.find((hit) => hit.section === 'education')?.column).toBe('main');
  });

  it('keeps a single column when only one typical group is present', () => {
    const warnings: string[] = [];
    const headings = assignPdfHeadingColumns([
      { label: 'Berufserfahrung', section: 'employment', column: 'main' },
      { label: 'Ausbildung', section: 'education', column: 'main' },
    ], warnings);
    expect(warnings).not.toContain('pdf_columns_inferred_from_section_mix');
    expect(headings.every((hit) => hit.column === 'main')).toBe(true);
  });
});

async function syntheticTwoColumnPdf(): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 36 });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = once(doc, 'end');
  doc.fontSize(16).text('Profil');
  doc.fontSize(11).text('Synthetic Candidate');
  doc.moveDown();
  doc.fontSize(16).text('Kenntnisse');
  doc.fontSize(11).text('TypeScript');
  doc.moveDown();
  doc.fontSize(16).text('Berufserfahrung');
  doc.fontSize(11).text('Software Engineer');
  doc.moveDown();
  doc.fontSize(16).text('Ausbildung');
  doc.fontSize(11).text('Synthetic University');
  doc.end();
  await finished;
  return Buffer.concat(chunks);
}

describe('extractLayoutFingerprint — PDF', () => {
  it('infers two columns from a synthetic PDF that mixes sidebar and main headings', async () => {
    const fingerprint = await extractLayoutFingerprint('application/pdf', await syntheticTwoColumnPdf());
    expect(fingerprint.sourceFormat).toBe('pdf');
    expect(fingerprint.columns).toBe(2);
    expect(fingerprint.warnings).toContain('pdf_columns_inferred_from_section_mix');
    const bySection = Object.fromEntries(fingerprint.sections.map((entry) => [entry.section, entry.column]));
    expect(bySection.profile).toBe('side');
    expect(bySection.employment).toBe('main');
  });
});

describe('extractLayoutFingerprint — resilience', () => {
  it('fails open to a default fingerprint on unreadable PDF bytes', async () => {
    const fingerprint = await extractLayoutFingerprint('application/pdf', Buffer.from('%PDF-1.4 not really a pdf'));
    expect(fingerprint.sourceFormat).toBe('pdf');
    expect(fingerprint.confidence).toBe('low');
    expect(fingerprint.sections.length).toBeGreaterThan(0);
  });

  it('returns a default fingerprint for unsupported mime types', async () => {
    const fingerprint = await extractLayoutFingerprint('application/zip', Buffer.from('PK'));
    expect(fingerprint.warnings).toContain('unsupported_layout_source');
  });
});

describe('validateLayoutFingerprint', () => {
  it('accepts a well-formed fingerprint and rejects malformed ones', () => {
    const valid = defaultLayoutFingerprint('html');
    expect(validateLayoutFingerprint(valid)).toMatchObject({ contract: 'cv-layout-fingerprint' });
    expect(validateLayoutFingerprint({ ...valid, palette: { ...valid.palette, accent: 'red' } })).toBeUndefined();
    expect(validateLayoutFingerprint({ ...valid, columns: 3 })).toBeUndefined();
    expect(validateLayoutFingerprint({ ...valid, contract: 'other' })).toBeUndefined();
    expect(validateLayoutFingerprint({ ...valid, sections: [{ section: 'nope', label: 'x', column: 'main' }] })).toBeUndefined();
    expect(validateLayoutFingerprint(null)).toBeUndefined();
  });

  it('requires a sidebar colour for two-column palettes', () => {
    const fingerprint = defaultLayoutFingerprint('html');
    expect(validateLayoutFingerprint({ ...fingerprint, columns: 2, palette: { text: '#111111', heading: '#111111', accent: '#1d4ed8', background: '#ffffff' } })).toBeUndefined();
  });
});
