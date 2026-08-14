import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ApplicationCase } from '../domain/models.js';
import { parseAndCorrelateMail, rawMailHash } from './mail-correlation.js';
import type { EncryptedMailVault } from './mail-vault.js';

export async function importLocalMailDrop(
  vault: EncryptedMailVault, applications: ApplicationCase[],
  dropRoot = resolve(process.cwd(), '..', '.local-data', 'mail-drop'), limit = 100
): Promise<{ inspected: number; added: number }> {
  let names: string[];
  try { names = (await readdir(dropRoot)).filter((name) => name.toLowerCase().endsWith('.eml')).sort().slice(0, limit); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { inspected: 0, added: 0 }; throw error; }
  const messages = [];
  for (const name of names) {
    const raw = await readFile(resolve(dropRoot, name));
    const message = await parseAndCorrelateMail(raw, 'local-smtp', 'local_smtp', applications);
    message.messageId ||= `<${rawMailHash(raw)}@local-smtp>`;
    messages.push(message);
  }
  return { inspected: names.length, added: await vault.saveMessages(messages) };
}
