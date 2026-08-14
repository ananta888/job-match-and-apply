import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

export interface ClaimProposal {
  id: string; statement: string; status: 'unverified'; decision: 'pending';
  conflict: { kind: 'duplicate' | 'possible_conflict'; existingClaimId: string; existingStatement: string } | null;
  source: { kind: string; fileName: string; anchor: string; sha256: string };
}

const MAX_BYTES = 10 * 1024 * 1024;

async function extractText(buffer: Buffer, mimeType: string): Promise<{ text: string; warnings: string[] }> {
  if (mimeType === 'text/plain' || mimeType === 'text/markdown' || mimeType === 'application/json') {
    return { text: buffer.toString('utf8'), warnings: [] };
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    if (buffer.subarray(0, 2).toString() !== 'PK') throw Object.assign(new Error('Ungültige DOCX-Datei.'), { statusCode: 400 });
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value, warnings: result.messages.map((item) => item.message) };
  }
  if (mimeType === 'application/pdf') {
    if (buffer.subarray(0, 4).toString() !== '%PDF') throw Object.assign(new Error('Ungültige PDF-Datei.'), { statusCode: 400 });
    const parser = new PDFParse({ data: buffer, isEvalSupported: false, stopAtErrors: true });
    try { return { text: (await parser.getText({ first: 50 })).text, warnings: [] }; }
    finally { await parser.destroy(); }
  }
  throw Object.assign(new Error(`Nicht unterstützter Importtyp: ${mimeType}`), { statusCode: 400 });
}

export async function importProfileDocument(
  fileName: string, mimeType: string, buffer: Buffer, sourceKind: string,
  existingClaims: Array<{ id: string; statement: string }> = []
) {
  if (buffer.length === 0 || buffer.length > MAX_BYTES) throw Object.assign(new Error('Importdatei muss zwischen 1 Byte und 10 MiB groß sein.'), { statusCode: 400 });
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const extracted = await extractText(buffer, mimeType);
  let lines: string[];
  if (mimeType === 'application/json') {
    const parsed = JSON.parse(extracted.text) as unknown;
    lines = flattenJson(parsed);
  } else {
    lines = extracted.text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length >= 8);
  }
  const normalize = (value: string) => value.toLocaleLowerCase('de-DE').replace(/[^a-z0-9äöüß]+/gi, ' ').trim();
  const proposals: ClaimProposal[] = lines.slice(0, 200).map((statement, index) => {
    const normalized = normalize(statement);
    const existing = existingClaims.find((claim) => normalize(claim.statement) === normalized)
      ?? existingClaims.find((claim) => normalize(claim.statement).includes(normalized) || normalized.includes(normalize(claim.statement)));
    const duplicate = existing && normalize(existing.statement) === normalized;
    return {
      id: `proposal-${index + 1}`, statement, status: 'unverified', decision: 'pending',
      conflict: existing ? { kind: duplicate ? 'duplicate' : 'possible_conflict', existingClaimId: existing.id, existingStatement: existing.statement } : null,
      source: { kind: sourceKind, fileName, anchor: `line:${index + 1}`, sha256 }
    };
  });
  return {
    contract: 'profile-import', contractVersion: '1.0', sourceKind, fileName, sha256,
    proposals, warnings: extracted.warnings, requiresUserConfirmation: true, persisted: false
  };
}

function flattenJson(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => flattenJson(item, `${path}[${index}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => flattenJson(item, `${path}.${key}`));
  if (typeof value === 'string' && value.trim().length >= 3) return [`${path}: ${value.trim()}`];
  return [];
}
