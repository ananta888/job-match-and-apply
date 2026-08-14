import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { CorrelatedMailMessage, MailAccount } from '../domain/models.js';

interface StoredAccount extends MailAccount { secret: string; authType: 'password' | 'access_token' }
interface MailVaultData { schemaVersion: 1; accounts: StoredAccount[]; messages: CorrelatedMailMessage[] }
interface MailVaultEnvelope { schemaVersion: 1; algorithm: 'aes-256-gcm'; iv: string; tag: string; ciphertext: string }
const empty = (): MailVaultData => ({ schemaVersion: 1, accounts: [], messages: [] });

export interface MailAccountInput {
  label: string; email: string; host: string; port: number; secure: boolean; username: string;
  secret: string; authType: 'password' | 'access_token'; enabled: boolean; mailbox: string;
}

export class EncryptedMailVault {
  constructor(
    private readonly filePath = resolve(process.cwd(), '..', '.local-data', 'mail-vault.json'),
    private readonly keyPath = resolve(process.cwd(), '..', '.local-data', 'mail-vault.key')
  ) {}

  async listAccounts(): Promise<MailAccount[]> { return (await this.load()).accounts.map(({ secret: _secret, authType: _authType, ...account }) => account); }
  async getAccountSecret(id: string): Promise<StoredAccount | undefined> { return structuredClone((await this.load()).accounts.find((item) => item.id === id)); }
  async saveAccount(input: MailAccountInput): Promise<MailAccount> {
    const data = await this.load(); const now = new Date().toISOString();
    const account: StoredAccount = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    data.accounts.push(account); await this.save(data);
    const { secret: _secret, authType: _authType, ...publicAccount } = account; return publicAccount;
  }
  async updateCursor(id: string, lastUid: number): Promise<void> {
    const data = await this.load(); const account = data.accounts.find((item) => item.id === id);
    if (!account) throw Object.assign(new Error('Mailkonto nicht gefunden.'), { statusCode: 404 });
    account.lastUid = Math.max(account.lastUid ?? 0, lastUid); account.updatedAt = new Date().toISOString(); await this.save(data);
  }
  async setAccountEnabled(id: string, enabled: boolean): Promise<MailAccount> {
    const data = await this.load(); const account = data.accounts.find((item) => item.id === id);
    if (!account) throw Object.assign(new Error('Mailkonto nicht gefunden.'), { statusCode: 404 });
    account.enabled = enabled; account.updatedAt = new Date().toISOString(); await this.save(data);
    const { secret: _secret, authType: _authType, ...publicAccount } = account; return structuredClone(publicAccount);
  }
  async deleteAccount(id: string): Promise<boolean> {
    const data = await this.load(); const before = data.accounts.length;
    data.accounts = data.accounts.filter((item) => item.id !== id); data.messages = data.messages.filter((item) => item.accountId !== id);
    if (before === data.accounts.length) return false; await this.save(data); return true;
  }
  async saveMessages(messages: CorrelatedMailMessage[]): Promise<number> {
    const data = await this.load(); let added = 0;
    for (const message of messages) {
      const duplicate = data.messages.some((item) => item.accountId === message.accountId && (item.messageId ? item.messageId === message.messageId : item.id === message.id));
      if (!duplicate) { data.messages.push(structuredClone(message)); added += 1; }
    }
    await this.save(data); return added;
  }
  async listMessages(): Promise<CorrelatedMailMessage[]> { return structuredClone((await this.load()).messages).sort((a, b) => b.sentAt.localeCompare(a.sentAt)); }
  async confirmCorrelation(messageId: string, applicationCaseId: string, companyKey: string): Promise<CorrelatedMailMessage> {
    const data = await this.load(); const message = data.messages.find((item) => item.id === messageId);
    if (!message) throw Object.assign(new Error('Mail nicht gefunden.'), { statusCode: 404 });
    message.correlation = { ...message.correlation, applicationCaseId, companyKey, confidence: 1, confirmed: true, reasons: [...message.correlation.reasons, 'Nutzerbestätigte Zuordnung.'] };
    await this.save(data); return structuredClone(message);
  }

  private async key(create: boolean): Promise<Buffer> {
    try { const key = await readFile(this.keyPath); if (key.length !== 32) throw new Error('Ungültiger Mail-Vault-Schlüssel.'); return key; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
      await mkdir(dirname(this.keyPath), { recursive: true }); const key = randomBytes(32); await writeFile(this.keyPath, key, { mode: 0o600 }); return key;
    }
  }
  private async load(): Promise<MailVaultData> {
    try {
      const envelope = JSON.parse(await readFile(this.filePath, 'utf8')) as MailVaultEnvelope;
      if (envelope.schemaVersion !== 1 || envelope.algorithm !== 'aes-256-gcm') throw new Error('Nicht unterstützte Mail-Vault-Version.');
      const decipher = createDecipheriv('aes-256-gcm', await this.key(false), Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8')) as MailVaultData;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw error; }
  }
  private async save(data: MailVaultData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true }); const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', await this.key(true), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    const envelope: MailVaultEnvelope = { schemaVersion: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
    const temporary = `${this.filePath}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }); await rename(temporary, this.filePath);
  }
}
