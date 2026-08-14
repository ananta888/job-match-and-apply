import { ImapFlow } from 'imapflow';
import type { ApplicationCase, CorrelatedMailMessage } from '../domain/models.js';
import type { EncryptedMailVault } from './mail-vault.js';
import { parseAndCorrelateMail } from './mail-correlation.js';

const clientFor = (account: NonNullable<Awaited<ReturnType<EncryptedMailVault['getAccountSecret']>>>) => new ImapFlow({
  host: account.host, port: account.port, secure: account.secure,
  auth: account.authType === 'access_token' ? { user: account.username, accessToken: account.secret } : { user: account.username, pass: account.secret }, logger: false
});

export async function testImapAccount(vault: EncryptedMailVault, accountId: string): Promise<{ status: 'connected'; mailbox: string }> {
  const account = await vault.getAccountSecret(accountId);
  if (!account) throw Object.assign(new Error('Mailkonto nicht gefunden.'), { statusCode: 404 });
  const client = clientFor(account);
  try { await client.connect(); await client.mailboxOpen(account.mailbox, { readOnly: true }); return { status: 'connected', mailbox: account.mailbox }; }
  finally { await client.logout().catch(() => undefined); }
}

export async function syncImapAccount(vault: EncryptedMailVault, accountId: string, applications: ApplicationCase[], limit = 100): Promise<{ fetched: number; added: number; lastUid?: number }> {
  const account = await vault.getAccountSecret(accountId);
  if (!account || !account.enabled) throw Object.assign(new Error('Mailkonto fehlt oder ist deaktiviert.'), { statusCode: 409 });
  const client = clientFor(account);
  const messages: CorrelatedMailMessage[] = []; let lastUid = account.lastUid;
  try {
    await client.connect(); const lock = await client.getMailboxLock(account.mailbox);
    try {
      const start = Math.max(1, (account.lastUid ?? 0) + 1); let count = 0;
      for await (const item of client.fetch(`${start}:*`, { uid: true, source: true })) {
        if (!item.source || count >= limit) break;
        messages.push(await parseAndCorrelateMail(item.source, account.id, 'imap', applications)); lastUid = item.uid; count += 1;
      }
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => undefined); }
  const added = await vault.saveMessages(messages); if (lastUid) await vault.updateCursor(account.id, lastUid);
  return { fetched: messages.length, added, lastUid };
}
