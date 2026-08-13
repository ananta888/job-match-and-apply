import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AppConfig } from '../domain/models.js';
import { defaultConfig } from '../config/defaults.js';

export interface ConfigStore {
  load(): Promise<AppConfig>;
  save(config: AppConfig): Promise<AppConfig>;
}

export class JsonConfigStore implements ConfigStore {
  constructor(private readonly filePath = resolve(process.cwd(), '..', '.local-data', 'config.json')) {}

  async load(): Promise<AppConfig> {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as AppConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return structuredClone(defaultConfig);
    }
  }

  async save(config: AppConfig): Promise<AppConfig> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.filePath);
    return config;
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
