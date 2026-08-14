import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface AuditEvent {
  correlationId: string;
  operation: string;
  status: number;
  category?: string;
  occurredAt: string;
}

export interface AuditLogger {
  write(event: AuditEvent): Promise<void>;
}

export class JsonLinesAuditLogger implements AuditLogger {
  constructor(private readonly filePath = resolve(process.cwd(), '..', '.local-data', 'audit.jsonl')) {}

  async write(event: AuditEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

export class MemoryAuditLogger implements AuditLogger {
  readonly events: AuditEvent[] = [];
  async write(event: AuditEvent): Promise<void> { this.events.push(structuredClone(event)); }
}
