import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AppConfig } from '../domain/models.js';
import { defaultConfig } from '../config/defaults.js';
import { parseJobSearchMcpLaunch } from './job-search-mcp-launch.mjs';

export interface ConfigStore {
  load(): Promise<AppConfig>;
  loadSnapshot(): Promise<ConfigSnapshot>;
  update(update: (current: AppConfig) => AppConfig | Promise<AppConfig>): Promise<ConfigSnapshot>;
  compareAndSave(
    expectedRevision: number,
    update: (current: AppConfig) => AppConfig | Promise<AppConfig>
  ): Promise<ConfigSnapshot>;
}

export interface ConfigSnapshot { config: AppConfig; revision: number; }

interface ConfigEnvelopeV1 { schemaVersion: 1; config: AppConfig; }
interface ConfigEnvelopeV2 {
  schemaVersion: 2;
  config: Omit<AppConfig, 'identities'>;
  encryptedIdentities: { algorithm: 'aes-256-gcm'; iv: string; tag: string; ciphertext: string };
}
interface ConfigEnvelopeV3 {
  schemaVersion: 3;
  revision: number;
  config: Omit<AppConfig, 'identities'>;
  encryptedIdentities: { algorithm: 'aes-256-gcm'; iv: string; tag: string; ciphertext: string };
}

export class JsonConfigStore implements ConfigStore {
  private readonly keyPath: string;
  private mutationTail: Promise<void> = Promise.resolve();
  constructor(
    private readonly filePath = resolve(process.cwd(), '..', '.local-data', 'config.json'),
    keyPath?: string
  ) { this.keyPath = keyPath ?? `${filePath}.key`; }

  async load(): Promise<AppConfig> { return (await this.loadSnapshot()).config; }

  async loadSnapshot(): Promise<ConfigSnapshot> { return this.loadSnapshotUnlocked(); }

  async update(update: (current: AppConfig) => AppConfig | Promise<AppConfig>): Promise<ConfigSnapshot> {
    return this.withMutation(async () => {
      const current = await this.loadSnapshotUnlocked();
      const config = await update(structuredClone(current.config));
      const snapshot = { config: structuredClone(config), revision: current.revision + 1 };
      await this.persistUnlocked(snapshot.config, snapshot.revision);
      return snapshot;
    });
  }

  async compareAndSave(
    expectedRevision: number,
    update: (current: AppConfig) => AppConfig | Promise<AppConfig>
  ): Promise<ConfigSnapshot> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw Object.assign(new Error('config_revision_invalid'), { statusCode: 400 });
    }
    return this.withMutation(async () => {
      const current = await this.loadSnapshotUnlocked();
      if (current.revision !== expectedRevision) {
        throw Object.assign(new Error('config_revision_conflict'), {
          statusCode: 409, currentRevision: current.revision
        });
      }
      const config = await update(structuredClone(current.config));
      const snapshot = { config: structuredClone(config), revision: current.revision + 1 };
      await this.persistUnlocked(snapshot.config, snapshot.revision);
      return snapshot;
    });
  }

  private async loadSnapshotUnlocked(): Promise<ConfigSnapshot> {
    let serialized: string;
    try {
      serialized = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { config: await this.withLocalMcpLaunchSpec(structuredClone(defaultConfig)), revision: 0 };
    }
    const parsed = JSON.parse(serialized) as AppConfig | ConfigEnvelopeV1 | ConfigEnvelopeV2 | ConfigEnvelopeV3;
    if (!('schemaVersion' in parsed)) {
      return { config: await this.withLocalMcpLaunchSpec(parsed), revision: 0 };
    }
    if (parsed.schemaVersion === 1) {
      return { config: await this.withLocalMcpLaunchSpec(parsed.config), revision: 0 };
    }
    if ((parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3) || !parsed.config || !parsed.encryptedIdentities) {
      throw new Error(`Nicht unterstützte Konfigurationsversion: ${String(parsed.schemaVersion)}`);
    }
    const revision = parsed.schemaVersion === 3 ? parsed.revision : 0;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Ungültige Konfigurationsrevision.');
    const key = await this.loadKey(false);
    const iv = Buffer.from(parsed.encryptedIdentities.iv, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(Buffer.from(parsed.encryptedIdentities.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(parsed.encryptedIdentities.ciphertext, 'base64')), decipher.final()
    ]).toString('utf8');
    const config = { ...parsed.config, identities: JSON.parse(plaintext) as AppConfig['identities'] };
    return { config: await this.withLocalMcpLaunchSpec(config), revision };
  }

  private async persistUnlocked(config: AppConfig, revision: number): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    const key = await this.loadKey(true);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(config.identities), 'utf8'), cipher.final()]);
    const { identities: _identities, ...publicConfig } = config;
    const envelope: ConfigEnvelopeV3 = {
      schemaVersion: 3,
      revision,
      config: publicConfig,
      encryptedIdentities: {
        algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64')
      }
    };
    await writeFile(temporaryPath, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async loadKey(create: boolean): Promise<Buffer> {
    try {
      const key = await readFile(this.keyPath);
      if (key.length !== 32) throw new Error('Ungültiger lokaler Identitätsschlüssel.');
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
      await mkdir(dirname(this.keyPath), { recursive: true });
      const key = randomBytes(32);
      await writeFile(this.keyPath, key, { mode: 0o600 });
      return key;
    }
  }

  private async withLocalMcpLaunchSpec(config: AppConfig): Promise<AppConfig> {
    const normalized: AppConfig = {
      ...config,
      mcp: { ...config.mcp, executionIsolation: 'trusted-host' }
    };
    if (normalized.mcp.mode !== 'demo' || normalized.mcp.command !== defaultConfig.mcp.command) return normalized;
    try {
      const value = JSON.parse(await readFile(resolve(dirname(this.filePath), 'job-search-mcp-launch.json'), 'utf8')) as Record<string, unknown>;
      const launch = parseJobSearchMcpLaunch(value);
      return { ...normalized, mcp: {
        ...normalized.mcp, mode: 'stdio', executionIsolation: 'trusted-host', runtimeTarget: launch.runtimeTarget,
        ...(launch.distribution ? { distribution: launch.distribution } : {}), command: launch.command,
        args: launch.args, env: launch.env
      } };
    } catch { return normalized; }
  }
}

export class MemoryConfigStore implements ConfigStore {
  private revision = 0;
  private mutationTail: Promise<void> = Promise.resolve();
  constructor(private config: AppConfig = structuredClone(defaultConfig)) {}
  async load(): Promise<AppConfig> { return structuredClone(this.config); }
  async loadSnapshot(): Promise<ConfigSnapshot> {
    return { config: structuredClone(this.config), revision: this.revision };
  }
  async update(update: (current: AppConfig) => AppConfig | Promise<AppConfig>): Promise<ConfigSnapshot> {
    return this.withMutation(async () => {
      this.config = structuredClone(await update(structuredClone(this.config)));
      this.revision += 1;
      return { config: structuredClone(this.config), revision: this.revision };
    });
  }
  async compareAndSave(
    expectedRevision: number,
    update: (current: AppConfig) => AppConfig | Promise<AppConfig>
  ): Promise<ConfigSnapshot> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw Object.assign(new Error('config_revision_invalid'), { statusCode: 400 });
    }
    return this.withMutation(async () => {
      if (this.revision !== expectedRevision) {
        throw Object.assign(new Error('config_revision_conflict'), {
          statusCode: 409, currentRevision: this.revision
        });
      }
      this.config = structuredClone(await update(structuredClone(this.config)));
      this.revision += 1;
      return { config: structuredClone(this.config), revision: this.revision };
    });
  }
  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
