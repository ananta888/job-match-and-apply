export interface JsonlDiagnostic { line: number; code: 'invalid_json' | 'line_too_large' | 'truncated_tail'; message: string; }
export interface JsonlBatch { values: unknown[]; diagnostics: JsonlDiagnostic[]; }

export class IncrementalJsonlParser {
  private pending = '';
  private line = 0;

  constructor(private readonly maxLineBytes = 1024 * 1024) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 128) throw new Error('JSONL-Zeilenlimit ist ungültig.');
  }

  feed(chunk: string | Buffer): JsonlBatch {
    this.pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    const pieces = this.pending.split(/\r?\n/);
    this.pending = pieces.pop() ?? '';
    return this.parseLines(pieces);
  }

  end(): JsonlBatch {
    if (!this.pending) return { values: [], diagnostics: [] };
    const pending = this.pending;
    this.pending = '';
    const batch = this.parseLines([pending]);
    if (batch.diagnostics.some((diagnostic) => diagnostic.code === 'invalid_json')) {
      batch.diagnostics = batch.diagnostics.map((diagnostic) => diagnostic.code === 'invalid_json'
        ? { ...diagnostic, code: 'truncated_tail', message: 'Unvollständige JSONL-Schlusszeile verworfen.' }
        : diagnostic);
    }
    return batch;
  }

  private parseLines(lines: string[]): JsonlBatch {
    const values: unknown[] = [];
    const diagnostics: JsonlDiagnostic[] = [];
    for (const raw of lines) {
      this.line += 1;
      if (!raw.trim()) continue;
      if (Buffer.byteLength(raw) > this.maxLineBytes) {
        diagnostics.push({ line: this.line, code: 'line_too_large', message: `JSONL-Zeile überschreitet ${this.maxLineBytes} Byte.` });
        continue;
      }
      try { values.push(JSON.parse(raw) as unknown); }
      catch (error) { diagnostics.push({ line: this.line, code: 'invalid_json', message: (error as Error).message }); }
    }
    return { values, diagnostics };
  }
}
