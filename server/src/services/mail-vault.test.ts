import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EncryptedMailVault } from './mail-vault.js';

describe('encrypted mail vault', () => {
  it('round-trips accounts without exposing or storing plaintext secrets', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'mail-vault-')); const file = resolve(root, 'vault.json');
    const vault = new EncryptedMailVault(file, resolve(root, 'vault.key'));
    const account = await vault.saveAccount({ label: 'Bewerbung', email: 'me@example.org', host: 'imap.example.org', port: 993, secure: true, username: 'me@example.org', secret: 'very-private-secret', authType: 'password', enabled: false, mailbox: 'INBOX' });
    expect(account).not.toHaveProperty('secret');
    expect(JSON.stringify(await vault.listAccounts())).not.toContain('very-private-secret');
    expect(await readFile(file, 'utf8')).not.toContain('very-private-secret');
    expect((await vault.getAccountSecret(account.id))?.secret).toBe('very-private-secret');
    expect((await vault.setAccountEnabled(account.id, true)).enabled).toBe(true);
  });
});
