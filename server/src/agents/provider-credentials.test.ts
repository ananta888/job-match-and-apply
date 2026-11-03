import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp as mkdtempAsync, readdir } from 'node:fs/promises';
import {
  MemoryProviderCredentialStore, ProviderCredentialStore, ProviderCredentialKeyUnavailableError,
  ProviderCredentialValidationError,
  installProviderCredentialEnv, providerCredentialEnv, validateCredentialEnv,
} from './provider-credentials.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  installProviderCredentialEnv(undefined);
});

const SECRET = 'sk-test-do-not-print-this-value';

describe('provider credentials', () => {
  it('fails explicitly when the vault exists but its key file is missing, and preserves the vault', async () => {
    const root = await mkdtempAsync(join(tmpdir(), 'credentials-keyless-')); roots.push(root);
    const store = new ProviderCredentialStore(join(root, 'secrets.json'));
    await store.put('opencode', { OPENAI_API_KEY: SECRET });
    const vaultBefore = await readFile(join(root, 'secrets.json'), 'utf8');
    await rm(join(root, 'secrets.json.key'));
    // A fresh process (restart) has no in-memory cache and must fail closed.
    const reopened = new ProviderCredentialStore(join(root, 'secrets.json'));
    await expect(reopened.list()).rejects.toBeInstanceOf(ProviderCredentialKeyUnavailableError);
    await expect(reopened.put('opencode', { OPENAI_API_KEY: 'sk-other' })).rejects.toBeInstanceOf(ProviderCredentialKeyUnavailableError);
    await expect(reopened.remove('opencode')).rejects.toBeInstanceOf(ProviderCredentialKeyUnavailableError);
    expect(providerCredentialEnv).toBeTruthy();
    expect(await readFile(join(root, 'secrets.json'), 'utf8')).toBe(vaultBefore);
  });

  it('serializes concurrent writes instead of losing updates or leaving shared temp files', async () => {
    const root = await mkdtempAsync(join(tmpdir(), 'credentials-race-')); roots.push(root);
    const store = new ProviderCredentialStore(join(root, 'secrets.json'));
    await Promise.all([
      store.put('opencode', { OPENAI_API_KEY: SECRET }),
      store.put('claude-cli', { ANTHROPIC_API_KEY: SECRET }),
      store.remove('opencode'),
    ]);
    const summaries = await store.list();
    expect(summaries.map((entry) => entry.providerId)).toEqual(['claude-cli']);
    expect(await readdir(root)).not.toContain('secrets.json.tmp');
  });

  it('accepts API-key style variables and rejects process-control names', () => {
    expect(validateCredentialEnv({ OPENAI_API_KEY: SECRET })).toEqual({ OPENAI_API_KEY: SECRET });
    expect(() => validateCredentialEnv({ PATH: '/evil' })).toThrow(ProviderCredentialValidationError);
    expect(() => validateCredentialEnv({ LD_PRELOAD: 'evil.so' })).toThrow(ProviderCredentialValidationError);
    expect(() => validateCredentialEnv({ NODE_OPTIONS: '--require evil.js' })).toThrow(ProviderCredentialValidationError);
    expect(() => validateCredentialEnv({ OPENCODE_CONFIG_CONTENT: '{}' })).toThrow(ProviderCredentialValidationError);
    expect(() => validateCredentialEnv({ CODEX_HOME: '/tmp/evil-home' })).toThrow(ProviderCredentialValidationError);
    expect(() => validateCredentialEnv({ CLAUDE_CONFIG_DIR: '/tmp/evil' })).toThrow(ProviderCredentialValidationError);
    expect(() => validateCredentialEnv({ HTTPS_PROXY: 'http://127.0.0.1:9' })).toThrow(ProviderCredentialValidationError);
    expect(() => validateCredentialEnv({ openai_api_key: SECRET })).toThrow(ProviderCredentialValidationError);
    expect(() => validateCredentialEnv({ OPENAI_API_KEY: 'a\nb' })).toThrow(ProviderCredentialValidationError);
    expect(() => validateCredentialEnv({})).toThrow(ProviderCredentialValidationError);
  });

  it('stores keys encrypted at rest and never returns values through summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-credentials-'));
    roots.push(root);
    const filePath = join(root, 'secrets.json');
    const store = new ProviderCredentialStore(filePath);

    const saved = await store.put('opencode', { OPENAI_API_KEY: SECRET });
    expect(saved).toEqual({
      providerId: 'opencode', hasSecret: true, envKeys: ['OPENAI_API_KEY'],
      updatedAt: expect.any(String),
    });

    const onDisk = await readFile(filePath, 'utf8');
    expect(onDisk).not.toContain(SECRET);
    expect(onDisk).not.toContain('OPENAI_API_KEY');

    const reopened = new ProviderCredentialStore(filePath);
    expect(await reopened.summary('opencode')).toEqual(saved);
    expect(reopened.envForSync('opencode')).toEqual({ OPENAI_API_KEY: SECRET });
    expect(reopened.envForSync('claude-cli')).toEqual({});

    const listed = await reopened.list();
    expect(listed).toEqual([saved]);

    const removed = await reopened.remove('opencode');
    expect(removed).toEqual({ providerId: 'opencode', hasSecret: false, envKeys: [] });
    expect(reopened.envForSync('opencode')).toEqual({});
  });

  it('exposes only an installed resolver through the spawn hook', () => {
    expect(providerCredentialEnv('opencode')).toEqual({});
    installProviderCredentialEnv((providerId) => (providerId === 'opencode' ? { OPENAI_API_KEY: SECRET } : {}));
    expect(providerCredentialEnv('opencode')).toEqual({ OPENAI_API_KEY: SECRET });
    expect(providerCredentialEnv('claude-cli')).toEqual({});
    installProviderCredentialEnv(undefined);
    expect(providerCredentialEnv('opencode')).toEqual({});
  });

  it('keeps the memory store on the same contract', async () => {
    const store = new MemoryProviderCredentialStore();
    await store.put('claude-cli', { ANTHROPIC_API_KEY: SECRET });
    expect(store.envForSync('claude-cli')).toEqual({ ANTHROPIC_API_KEY: SECRET });
    expect(await store.summary('claude-cli')).toEqual(expect.objectContaining({ hasSecret: true, envKeys: ['ANTHROPIC_API_KEY'] }));
  });
});
