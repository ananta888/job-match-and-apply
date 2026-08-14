import { createHash, randomUUID } from 'node:crypto';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import type { ApplicationCase, CorrelatedMailMessage, EmployerResponseKind } from '../domain/models.js';

export const companyKey = (company: string): string => company
  .normalize('NFKD')
  .toLocaleLowerCase('de-DE')
  .replace(/ß/g, 'ss')
  .replace(/\p{M}+/gu, '')
  .replace(/\b(gmbh|ag|ug|se|inc|ltd|llc)\b/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '') || 'unknown-company';

function addresses(value?: AddressObject | AddressObject[]): string[] {
  return (Array.isArray(value) ? value : value ? [value] : []).flatMap((item) => item.value.map((entry) => entry.address?.toLocaleLowerCase() ?? '')).filter(Boolean);
}
function responseKind(subject: string, text: string): EmployerResponseKind {
  const value = `${subject}\n${text}`.toLocaleLowerCase('de-DE');
  if (/absage|leider nicht|nicht berücksichtigen|rejection|not moving forward/.test(value)) return 'rejection';
  if (/vorstellungsgespräch|interview|termin|calendar invitation|einladung/.test(value)) return 'interview';
  if (/angebot|vertragsangebot|offer/.test(value)) return 'offer';
  if (/eingang.*bewerbung|application received|danke.*bewerbung/.test(value)) return 'acknowledgement';
  if (/rückfrage|frage zu|additional information|unterlagen nachreichen/.test(value)) return 'question';
  return 'other';
}
function calendarEvents(parsed: ParsedMail) {
  return parsed.attachments.filter((item) => /text\/calendar|application\/ics/.test(item.contentType) || item.filename?.toLowerCase().endsWith('.ics')).map((item) => {
    const ics = item.content.toString('utf8'); const field = (name: string) => ics.match(new RegExp(`^${name}:(.*)$`, 'mi'))?.[1]?.trim();
    return { uid: field('UID'), title: field('SUMMARY') ?? 'Kalendertermin', start: field('DTSTART'), end: field('DTEND'), location: field('LOCATION') };
  });
}

export async function parseAndCorrelateMail(raw: Buffer, accountId: string, source: CorrelatedMailMessage['source'], applications: ApplicationCase[]): Promise<CorrelatedMailMessage> {
  if (raw.length === 0 || raw.length > 20 * 1024 * 1024) throw Object.assign(new Error('E-Mail muss zwischen 1 Byte und 20 MiB groß sein.'), { statusCode: 400 });
  const parsed = await simpleParser(raw, { skipHtmlToText: false, skipTextToHtml: true, maxHtmlLengthToParse: 2_000_000 });
  const from = addresses(parsed.from); const to = addresses(parsed.to); const subject = parsed.subject?.slice(0, 1000) ?? ''; const text = (parsed.text ?? '').slice(0, 500_000);
  const haystack = `${subject}\n${text}\n${from.join(' ')}`.toLocaleLowerCase('de-DE');
  const candidates = applications.map((application) => {
    const reasons: string[] = []; let score = 0;
    if (application.job.id && haystack.includes(application.job.id.toLocaleLowerCase())) { score += 0.65; reasons.push('Stellen-ID im Betreff oder Text.'); }
    if (application.job.title && haystack.includes(application.job.title.toLocaleLowerCase('de-DE'))) { score += 0.25; reasons.push('Stellentitel erkannt.'); }
    const key = companyKey(application.job.company); const companyWords = application.job.company.toLocaleLowerCase('de-DE').split(/\W+/).filter((word) => word.length >= 4);
    if (companyWords.some((word) => haystack.includes(word)) || from.some((mail) => mail.includes(key.replace(/-/g, '')))) { score += 0.2; reasons.push('Firmenname oder Absenderdomain erkannt.'); }
    return { application, score: Math.min(score, 1), reasons };
  }).sort((a, b) => b.score - a.score);
  const best = candidates[0]; const unambiguous = Boolean(best && best.score >= 0.6 && (!candidates[1] || best.score - candidates[1].score >= 0.2));
  return {
    id: randomUUID(), accountId, messageId: parsed.messageId, from, to, subject,
    sentAt: (parsed.date ?? new Date()).toISOString(), text, inReplyTo: parsed.inReplyTo,
    references: Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [], source,
    responseKind: responseKind(subject, text), calendarEvents: calendarEvents(parsed),
    correlation: {
      applicationCaseId: unambiguous ? best?.application.id : undefined,
      companyKey: unambiguous && best ? companyKey(best.application.job.company) : undefined,
      confidence: best?.score ?? 0, reasons: best?.reasons ?? ['Keine passende Bewerbung erkannt.'], confirmed: false
    },
    importedAt: new Date().toISOString()
  };
}

export function rawMailHash(raw: Buffer): string { return createHash('sha256').update(raw).digest('hex'); }
