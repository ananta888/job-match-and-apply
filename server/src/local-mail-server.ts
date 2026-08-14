import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SMTPServer } from 'smtp-server';

const host = process.env.LOCAL_MAIL_HOST || '127.0.0.1';
const port = Number(process.env.LOCAL_MAIL_PORT || 2525);
const username = process.env.LOCAL_MAIL_USERNAME || 'job-agent';
const secret = process.env.LOCAL_MAIL_SECRET;
if (!secret || secret.length < 16) throw new Error('LOCAL_MAIL_SECRET mit mindestens 16 Zeichen ist erforderlich.');
const mailSecret = secret;
if (!['127.0.0.1', '::1', 'localhost'].includes(host) && process.env.ALLOW_NETWORK_MAIL_SERVER !== '1') throw new Error('Netzwerkbindung erfordert ALLOW_NETWORK_MAIL_SERVER=1.');
const inbox = resolve(process.cwd(), '..', '.local-data', 'mail-drop');
const equals = (left: string, right: string) => { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); };

const server = new SMTPServer({
  secure: false, disabledCommands: ['STARTTLS'], size: 20 * 1024 * 1024,
  onAuth(auth, _session, callback) {
    callback(equals(auth.username ?? '', username) && equals(auth.password ?? '', mailSecret) ? null : new Error('Authentifizierung fehlgeschlagen.'), { user: username });
  },
  onData(stream, _session, callback) {
    const chunks: Buffer[] = []; let size = 0; let rejected = false;
    stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= 20 * 1024 * 1024) chunks.push(chunk); else rejected = true; });
    stream.on('end', async () => {
      if (rejected) { callback(new Error('Nachricht ist größer als 20 MiB.')); return; }
      try { await mkdir(inbox, { recursive: true }); await writeFile(resolve(inbox, `${Date.now()}-${randomUUID()}.eml`), Buffer.concat(chunks), { mode: 0o600 }); callback(); }
      catch (error) { callback(error as Error); }
    });
  }
});
server.listen(port, host, () => process.stdout.write(`Lokaler Nur-Empfang-SMTP-Dienst auf ${host}:${port}\n`));
const stop = () => server.close(() => process.exit(0)); process.on('SIGINT', stop); process.on('SIGTERM', stop);
