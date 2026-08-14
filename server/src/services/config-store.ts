import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AppConfig } from '../domain/models.js';
import { defaultConfig } from '../config/defaults.js';
import { parseJobSearchMcpLaunch } from './job-search-mcp-launch.mjs';

export interface ConfigStore {
  load(): Promise<AppConfig>;
  save(config: AppConfig): Promise<AppConfig>;
}

interface ConfigEnvelopeV1 { schemaVersion: 1; config: AppConfig; }
interface ConfigEnvelopeV2 {
  schemaVersion: 2;
  config: Omit<AppConfig, 'identities'>;
  encryptedIdentities: { algorithm: 'aes-256-gcm'; iv: string; tag: string; ciphertext: string };
}

export class JsonConfigStore implements ConfigStore {
  private readonly keyPath: string;
  constructor(
    private readonly filePath = resolve(process.cwd(), '..', '.local-data', 'config.json'),
    keyPath?: string
  ) { this.keyPath = keyPath ?? `${filePath}.key`; }

  async load(): Promise<AppConfig> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as AppConfig | ConfigEnvelopeV1 | ConfigEnvelopeV2;
      if (!('schemaVersion' in parsed)) return this.withLocalMcpLaunchSpec(parsed);
      if (parsed.schemaVersion === 1) return this.withLocalMcpLaunchSpec(parsed.config);
      if (parsed.schemaVersion !== 2 || !parsed.config || !parsed.encryptedIdentities) {
        throw new Error(`Nicht unterstützte Konfigurationsversion: ${String(parsed.schemaVersion)}`);
      }
      const key = await this.loadKey(false);
      const iv = Buffer.from(parsed.encryptedIdentities.iv, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(Buffer.from(parsed.encryptedIdentities.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(parsed.encryptedIdentities.ciphertext, 'base64')), decipher.final()
      ]).toString('utf8');
      return this.withLocalMcpLaunchSpec({ ...parsed.config, identities: JSON.parse(plaintext) as AppConfig['identities'] });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return this.withLocalMcpLaunchSpec(structuredClone(defaultConfig));
    }
  }

  async save(config: AppConfig): Promise<AppConfig> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    const key = await this.loadKey(true);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(config.identities), 'utf8'), cipher.final()]);
    const { identities: _identities, ...publicConfig } = config;
    const envelope: ConfigEnvelopeV2 = {
      schemaVersion: 2,
      config: publicConfig,
      encryptedIdentities: {
        algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64')
      }
    };
    await writeFile(temporaryPath, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.filePath);
    return config;
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
        ...normalized.mcp, executionIsolation: 'trusted-host', runtimeTarget: launch.runtimeTarget,
        ...(launch.distribution ? { distribution: launch.distribution } : {}), command: launch.command,
        args: launch.args, env: launch.env
      } };
    } catch { return normalized; }
  }
}

export class MemoryConfigStore implements ConfigStore {
  constructor(private config: AppConfig = structuredClone(defaultConfig)) {}
  async load(): Promise<AppConfig> { return structuredClone(this.config); }
  async save(config: AppConfig): Promise<AppConfig> {
    this.config = structuredClone(config);
    return structuredClone(this.config);
  }
}
