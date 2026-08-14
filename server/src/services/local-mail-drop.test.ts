import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importLocalMailDrop } from './local-mail-drop.js';
import { EncryptedMailVault } from './mail-vault.js';

describe('local SMTP mail drop', () => {
  it('imports a drop file once even if it has no Message-ID', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'mail-drop-')); const drop = resolve(root, 'drop');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(drop));
    await writeFile(resolve(drop, 'answer.eml'), 'From: jobs@acme.test\r\nTo: me@example.org\r\nSubject: Application received\r\n\r\nThank you.');
    const vault = new EncryptedMailVault(resolve(root, 'vault.json'), resolve(root, 'vault.key'));
    expect(await importLocalMailDrop(vault, [], drop)).toEqual({ inspected: 1, added: 1 });
    expect(await importLocalMailDrop(vault, [], drop)).toEqual({ inspected: 1, added: 0 });
  });
});
