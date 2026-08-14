import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AgentEvent, AgentRun, AgentRunStore } from '../ports/agent-runner.js';

const ENCRYPTED_PREFIX = 'agent-vault:v1:';
const SENSITIVE_KEY = /(?:prompt|task|text|message|input|output|stdin|stdout|stderr|content|raw|mail|identity|failure|secret|password|token|credential|authorization|cookie|workspace|executable)/i;
const EXPORT_REDACTION_KEY = /(?:secret|password|token|credential|authorization|cookie|prompt|task|text|message|input|output|stdin|stdout|stderr|content|raw|workspace|executable)/i;
const TOKEN_COUNTER_KEY = /(?:^|_)(?:input|output|cached_input|reasoning|total)_tokens?(?:$|_)/;

function normalizedField(field: string): string {
  return field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function classified(field: string, pattern: RegExp): boolean {
  const normalized = normalizedField(field);
  return !TOKEN_COUNTER_KEY.test(normalized) && pattern.test(normalized);
}

export interface AgentVaultKeyProvider { key(): Promise<Buffer>; }

export class LocalAgentVaultKeyProvider implements AgentVaultKeyProvider {
  private cached?: Promise<Buffer>;
  constructor(private readonly path = resolve(process.cwd(), '..', '.local-data', 'keys', 'agent-run-vault.key')) {}

  key(): Promise<Buffer> { return this.cached ??= this.loadOrCreate(); }

  private async loadOrCreate(): Promise<Buffer> {
    try {
      const encoded = (await readFile(this.path, 'utf8')).trim();
      const key = Buffer.from(encoded, 'base64url');
      if (key.byteLength !== 32) throw new Error('agent_vault_key_invalid');
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const key = randomBytes(32);
    await mkdir(dirname(this.path), { recursive: true });
    try { await writeFile(this.path, `${key.toString('base64url')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return this.loadOrCreate();
    }
    return key;
  }
}

function seal(value: unknown, key: Buffer, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `${ENCRYPTED_PREFIX}${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function openSealed(value: string, key: Buffer, context: string): unknown {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value;
  const parts = value.slice(ENCRYPTED_PREFIX.length).split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error('agent_vault_ciphertext_malformed');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'base64url'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8')) as unknown;
  } catch {
    throw new Error('agent_vault_authentication_failed');
  }
}

function protect(value: unknown, key: Buffer, context: string, field = ''): unknown {
  if (field && classified(field, SENSITIVE_KEY)) return seal(value, key, context);
  if (Array.isArray(value)) return value.map((entry, index) => protect(entry, key, `${context}/${index}`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, entry]) => [name, protect(entry, key, `${context}/${name}`, name)]));
  }
  return value;
}

function protectRun(run: AgentRun, key: Buffer): AgentRun {
  return protect(run, key, `run/${run.id}`) as AgentRun;
}

function protectEvent(event: AgentEvent, key: Buffer): AgentEvent {
  return protect(event, key, `event/${event.runId}/${event.sequence}`) as AgentEvent;
}

function reveal(value: unknown, key: Buffer, context: string): unknown {
  if (typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX)) return openSealed(value, key, context);
  if (Array.isArray(value)) return value.map((entry, index) => reveal(entry, key, `${context}/${index}`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, entry]) => [name, reveal(entry, key, `${context}/${name}`)]));
  }
  return value;
}

function redact(value: unknown, field = ''): unknown {
  if (field && classified(field, EXPORT_REDACTION_KEY)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, entry]) => [name, redact(entry, name)]));
  return value;
}

/** Encrypts classified run fields before they reach the append-only disk store. */
export class EncryptedAgentRunStore implements AgentRunStore {
  private appendQueue: Promise<void> = Promise.resolve();
  constructor(private readonly inner: AgentRunStore, private readonly keys: AgentVaultKeyProvider = new LocalAgentVaultKeyProvider()) {}

  async create(run: AgentRun): Promise<AgentRun> { const key = await this.keys.key(); await this.inner.create(protectRun(run, key)); return structuredClone(run); }
  async get(runId: string): Promise<AgentRun | undefined> { const value = await this.inner.get(runId); return value ? reveal(value, await this.keys.key(), `run/${runId}`) as AgentRun : undefined; }
  async list(): Promise<AgentRun[]> { const key = await this.keys.key(); return (await this.inner.list()).map((run) => reveal(run, key, `run/${run.id}`) as AgentRun); }
  async update(run: AgentRun): Promise<AgentRun> { const key = await this.keys.key(); await this.inner.update(protectRun(run, key)); return structuredClone(run); }
  append(event: AgentEvent): Promise<'appended' | 'duplicate'> {
    const operation = this.appendQueue.then(async () => {
      const existing = (await this.events(event.runId, Math.max(0, event.sequence - 1))).find((candidate) => candidate.sequence === event.sequence);
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(event)) return 'duplicate' as const;
        throw new Error(`Widersprüchliches Event für Sequenz ${event.sequence}.`);
      }
      const key = await this.keys.key();
      const result = await this.inner.append(protectEvent(event, key));
      const failure = event.kind === 'run_completed' && event.data && typeof event.data === 'object'
        ? (event.data as Record<string, unknown>).failure : undefined;
      if (failure && typeof failure === 'object') {
        const snapshot = await this.inner.get(event.runId);
        if (!snapshot) throw new Error(`Run ${event.runId} wurde nicht gefunden.`);
        const clearSnapshot = reveal(snapshot, key, `run/${event.runId}`) as AgentRun;
        clearSnapshot.failure = structuredClone(failure) as AgentRun['failure'];
        await this.inner.update(protectRun(clearSnapshot, key));
      }
      return result;
    });
    this.appendQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
  async events(runId: string, afterSequence = 0): Promise<AgentEvent[]> {
    const key = await this.keys.key();
    return (await this.inner.events(runId, afterSequence)).map((event) => reveal(event, key, `event/${runId}/${event.sequence}`) as AgentEvent);
  }
  async recover(): ReturnType<AgentRunStore['recover']> {
    const result = await this.inner.recover();
    for (const encryptedRun of await this.inner.list()) {
      try {
        const events = await this.events(encryptedRun.id);
        const terminal = [...events].reverse().find((event) => event.kind === 'run_completed');
        const failure = terminal?.data && typeof terminal.data === 'object' ? (terminal.data as Record<string, unknown>).failure : undefined;
        const key = await this.keys.key();
        let run: AgentRun;
        try {
          run = reveal(encryptedRun, key, `run/${encryptedRun.id}`) as AgentRun;
        } catch (error) {
          // v1 pre-release stores could copy event-AAD ciphertext into the run
          // failure snapshot. Repair only when the authoritative event log
          // contains the matching clear terminal failure.
          if (!failure || typeof failure !== 'object' || encryptedRun.failure === undefined) throw error;
          const withoutFailure = structuredClone(encryptedRun);
          delete withoutFailure.failure;
          run = reveal(withoutFailure, key, `run/${encryptedRun.id}`) as AgentRun;
        }
        // Rewriting every readable snapshot also migrates fields that older
        // classifiers left in clear text (for example camelCase userPrompt).
        if (failure && typeof failure === 'object') run.failure = structuredClone(failure) as AgentRun['failure'];
        await this.update(run);
      } catch (error) {
        result.errors.push({ runId: encryptedRun.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }
  prune(options: { before: string; dryRun?: boolean }): ReturnType<AgentRunStore['prune']> { return this.inner.prune(options); }
  async export(runId: string, options: { includeSensitive?: boolean } = {}): Promise<{ run: AgentRun; events: AgentEvent[] }> {
    const encrypted = await this.inner.export(runId, { includeSensitive: true });
    const key = await this.keys.key();
    const clear = {
      run: reveal(encrypted.run, key, `run/${runId}`) as AgentRun,
      events: encrypted.events.map((event) => reveal(event, key, `event/${runId}/${event.sequence}`) as AgentEvent)
    };
    return options.includeSensitive ? clear : redact(clear) as typeof clear;
  }
}

export class StaticAgentVaultKeyProvider implements AgentVaultKeyProvider {
  constructor(private readonly value: Buffer) { if (value.byteLength !== 32) throw new Error('agent_vault_key_invalid'); }
  async key(): Promise<Buffer> { return Buffer.from(this.value); }
}
