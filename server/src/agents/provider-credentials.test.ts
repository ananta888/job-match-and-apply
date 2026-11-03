import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MemoryProviderCredentialStore, ProviderCredentialStore, ProviderCredentialValidationError,
  installProviderCredentialEnv, providerCredentialEnv, validateCredentialEnv,
} from './provider-credentials.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  installProviderCredentialEnv(undefined);
});

const SECRET = 'sk-live-do-not-print-this-value';

describe('provider credentials', () => {
  it('accepts API-key style variables and rejects process-control names', () => {
    expect(validateCredentialEnv({ OPENAI_API_KEY: SECRET })).toEqual({ OPENAI_API_KEY: SECRET });
    expect(() => validateCredentialEnv({ PATH: '/evil' })).toThrow(ProviderCredentialValidationError);
    expect(() => validateCredentialEnv({ LD_PRELOAD: 'evil.so' })).toThrow(ProviderCredentialValidationError);
    expect(() => validateCredentialEnv({ NODE_OPTIONS: '--require evil.js' })).toThrow(ProviderCredentialValidationError);
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
