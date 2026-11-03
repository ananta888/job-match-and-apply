import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const PROVIDER_ID = /^[a-z][a-z0-9._-]{0,127}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const ENV_VALUE = /^[^\0]{1,4096}$/;
const MAX_ENV_KEYS_PER_PROVIDER = 8;

/**
 * Environment names that would rewrite process execution itself. Users may store
 * API keys, never process-control variables.
 */
const ENV_NAME_BLOCKLIST = new Set([
  'PATH', 'HOME', 'SHELL', 'IFS', 'CDPATH', 'TMPDIR', 'TMP', 'TEMP', 'WINDIR', 'SYSTEMROOT',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS', 'NODE_REPL_EXTERNAL_MODULE',
  'PYTHONSTARTUP', 'PYTHONPATH', 'PYTHONHOME', 'BASH_ENV', 'ENV', 'BASHOPTS', 'SHELLOPTS',
  'PERL5OPT', 'RUBYOPT', 'GIT_SSH_COMMAND',
]);

export interface ProviderCredentialSummary {
  providerId: string;
  hasSecret: boolean;
  envKeys: string[];
  updatedAt?: string;
}

export interface ProviderCredentialStorePort {
  list(): Promise<ProviderCredentialSummary[]>;
  summary(providerId: string): Promise<ProviderCredentialSummary>;
  put(providerId: string, env: Record<string, string>): Promise<ProviderCredentialSummary>;
  remove(providerId: string): Promise<ProviderCredentialSummary>;
  envForSync(providerId: string): NodeJS.ProcessEnv;
}

export class ProviderCredentialValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ProviderCredentialValidationError';
  }
}

export function validateCredentialEnv(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProviderCredentialValidationError('provider_credentials_invalid_env', 'Umweltobjekt erwartet.');
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (!entries.length) {
    throw new ProviderCredentialValidationError('provider_credentials_empty_env', 'Mindestens eine Umgebungsvariable erforderlich.');
  }
  if (entries.length > MAX_ENV_KEYS_PER_PROVIDER) {
    throw new ProviderCredentialValidationError('provider_credentials_too_many_keys', `Höchstens ${MAX_ENV_KEYS_PER_PROVIDER} Umgebungsvariablen pro Provider.`);
  }
  const validated: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!ENV_NAME.test(name)) {
      throw new ProviderCredentialValidationError('provider_credentials_invalid_name', `Ungültiger Variablenname: ${name}`);
    }
    if (ENV_NAME_BLOCKLIST.has(name)) {
      throw new ProviderCredentialValidationError('provider_credentials_forbidden_name', `Diese Variable darf hier nicht gesetzt werden: ${name}`);
    }
    if (typeof value !== 'string' || !ENV_VALUE.test(value) || !value.trim() || /[\r\n]/.test(value)) {
      throw new ProviderCredentialValidationError('provider_credentials_invalid_value', `Ungültiger Wert für ${name}.`);
    }
    validated[name] = value;
  }
  return validated;
}

function assertProviderId(providerId: string): void {
  if (!PROVIDER_ID.test(providerId)) throw new ProviderCredentialValidationError('provider_credentials_invalid_provider', 'Unbekannter Provider.');
}

interface CredentialRecord {
  env: Record<string, string>;
  updatedAt: string;
}

interface CredentialPlaintext {
  schemaVersion: 1;
  records: Record<string, CredentialRecord>;
}

interface CredentialEnvelope {
  schemaVersion: 1;
  encrypted: { algorithm: 'aes-256-gcm'; iv: string; tag: string; ciphertext: string };
}

function summarize(providerId: string, record: CredentialRecord | undefined): ProviderCredentialSummary {
  const summary: ProviderCredentialSummary = {
    providerId,
    hasSecret: Boolean(record && Object.keys(record.env).length),
    envKeys: record ? Object.keys(record.env).sort() : [],
  };
  if (record) summary.updatedAt = record.updatedAt;
  return summary;
}

/**
 * API keys live encrypted at rest next to the local config key material. Values are
 * never returned by any API path; provider processes receive them only as child env.
 */
export class ProviderCredentialStore implements ProviderCredentialStorePort {
  private readonly keyPath: string;
  private cache: Map<string, CredentialRecord> | undefined;

  constructor(private readonly filePath: string, keyPath?: string) {
    this.keyPath = keyPath ?? `${filePath}.key`;
  }

  async list(): Promise<ProviderCredentialSummary[]> {
    const records = await this.records();
    return [...records.keys()].sort().map((providerId) => summarize(providerId, records.get(providerId)));
  }

  async summary(providerId: string): Promise<ProviderCredentialSummary> {
    assertProviderId(providerId);
    const records = await this.records();
    return summarize(providerId, records.get(providerId));
  }

  async put(providerId: string, env: Record<string, string>): Promise<ProviderCredentialSummary> {
    assertProviderId(providerId);
    const validated = validateCredentialEnv(env);
    const records = await this.records();
    records.set(providerId, { env: validated, updatedAt: new Date().toISOString() });
    await this.persist(records);
    return summarize(providerId, records.get(providerId));
  }

  async remove(providerId: string): Promise<ProviderCredentialSummary> {
    assertProviderId(providerId);
    const records = await this.records();
    records.delete(providerId);
    await this.persist(records);
    return summarize(providerId, undefined);
  }

  envForSync(providerId: string): NodeJS.ProcessEnv {
    if (!PROVIDER_ID.test(providerId)) return {};
    if (!this.cache) this.cache = this.loadSync();
    const record = this.cache.get(providerId);
    return record ? { ...record.env } : {};
  }

  private async records(): Promise<Map<string, CredentialRecord>> {
    if (this.cache) return this.cache;
    try {
      const envelope = JSON.parse(await readFile(this.filePath, 'utf8')) as CredentialEnvelope;
      this.cache = this.decrypt(envelope);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.cache = new Map();
      else if (error instanceof SyntaxError) throw new Error('provider_credentials_store_invalid');
      else throw error;
    }
    return this.cache;
  }

  private loadSync(): Map<string, CredentialRecord> {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      return this.decrypt(JSON.parse(raw) as CredentialEnvelope);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      if (error instanceof SyntaxError) throw new Error('provider_credentials_store_invalid');
      throw error;
    }
  }

  private async ensureKey(): Promise<Buffer> {
    try {
      return await readFile(this.keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const key = randomBytes(32);
      await mkdir(dirname(this.keyPath), { recursive: true });
      await writeFile(this.keyPath, key, { mode: 0o600 });
      await chmod(this.keyPath, 0o600);
      return key;
    }
  }

  private async persist(records: Map<string, CredentialRecord>): Promise<void> {
    const key = await this.ensureKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const plaintext = Buffer.from(JSON.stringify({ schemaVersion: 1, records: Object.fromEntries(records) } satisfies CredentialPlaintext), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: CredentialEnvelope = {
      schemaVersion: 1,
      encrypted: {
        algorithm: 'aes-256-gcm',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      },
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.filePath);
    this.cache = records;
  }

  private decrypt(envelope: CredentialEnvelope): Map<string, CredentialRecord> {
    if (envelope.schemaVersion !== 1 || !envelope.encrypted || envelope.encrypted.algorithm !== 'aes-256-gcm') {
      throw new Error('provider_credentials_store_invalid');
    }
    const key = readFileSync(this.keyPath);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.encrypted.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.encrypted.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.encrypted.ciphertext, 'base64')),
      decipher.final(),
    ]);
    const parsed = JSON.parse(plaintext.toString('utf8')) as CredentialPlaintext;
    if (parsed.schemaVersion !== 1 || !parsed.records || typeof parsed.records !== 'object') {
      throw new Error('provider_credentials_store_invalid');
    }
    const records = new Map<string, CredentialRecord>();
    for (const [providerId, record] of Object.entries(parsed.records)) {
      records.set(providerId, { env: validateCredentialEnv(record.env), updatedAt: record.updatedAt });
    }
    return records;
  }
}

export class MemoryProviderCredentialStore implements ProviderCredentialStorePort {
  private readonly records = new Map<string, CredentialRecord>();

  async list(): Promise<ProviderCredentialSummary[]> {
    return [...this.records.keys()].sort().map((providerId) => summarize(providerId, this.records.get(providerId)));
  }

  async summary(providerId: string): Promise<ProviderCredentialSummary> {
    assertProviderId(providerId);
    return summarize(providerId, this.records.get(providerId));
  }

  async put(providerId: string, env: Record<string, string>): Promise<ProviderCredentialSummary> {
    assertProviderId(providerId);
    const validated = validateCredentialEnv(env);
    this.records.set(providerId, { env: validated, updatedAt: new Date().toISOString() });
    return summarize(providerId, this.records.get(providerId));
  }

  async remove(providerId: string): Promise<ProviderCredentialSummary> {
    assertProviderId(providerId);
    this.records.delete(providerId);
    return summarize(providerId, undefined);
  }

  envForSync(providerId: string): NodeJS.ProcessEnv {
    const record = this.records.get(providerId);
    return record ? { ...record.env } : {};
  }
}

type CredentialEnvResolver = (providerId: string) => NodeJS.ProcessEnv;

let credentialEnvResolver: CredentialEnvResolver | undefined;

/** Composition-root hook: provider spawns merge exactly these keys into their child environment. */
export function installProviderCredentialEnv(resolver: CredentialEnvResolver | undefined): void {
  credentialEnvResolver = resolver;
}

export function providerCredentialEnv(providerId: string): NodeJS.ProcessEnv {
  try {
    return credentialEnvResolver?.(providerId) ?? {};
  } catch {
    return {};
  }
}
