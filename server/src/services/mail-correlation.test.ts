import { describe, expect, it } from 'vitest';
import type { ApplicationCase } from '../domain/models.js';
import { parseAndCorrelateMail } from './mail-correlation.js';

const application = (id: string, jobId: string, title: string): ApplicationCase => ({
  id, job: { id: jobId, sourceId: 'test', title, company: 'Beispiel GmbH', location: 'Berlin', workModel: 'hybrid', employmentType: 'full_time', description: '', skills: [] },
  identityId: 'real', identityMode: 'real', documentType: 'cover_letter', state: 'draft', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', artifactNames: [], warnings: [], revision: 1
});

describe('mail correlation', () => {
  it('assigns an exact job reference among multiple jobs at one company', async () => {
    const cases = [application('11111111-1111-4111-8111-111111111111', 'JOB-123', 'Backend Engineer'), application('22222222-2222-4222-8222-222222222222', 'JOB-456', 'Frontend Engineer')];
    const mail = Buffer.from('From: recruiting@beispiel.de\r\nTo: me@example.org\r\nSubject: Interview zu JOB-456\r\nMessage-ID: <one@example.org>\r\n\r\nEinladung zum Interview für Frontend Engineer.');
    const result = await parseAndCorrelateMail(mail, 'account', 'eml', cases);
    expect(result.responseKind).toBe('interview');
    expect(result.correlation.applicationCaseId).toBe(cases[1]!.id);
    expect(result.correlation.confirmed).toBe(false);
  });

  it('keeps an ambiguous company-only rejection in the review inbox', async () => {
    const cases = [application('11111111-1111-4111-8111-111111111111', 'JOB-123', 'Backend Engineer'), application('22222222-2222-4222-8222-222222222222', 'JOB-456', 'Frontend Engineer')];
    const mail = Buffer.from('From: recruiting@beispiel.de\r\nTo: me@example.org\r\nSubject: Absage von Beispiel GmbH\r\n\r\nLeider können wir Ihre Bewerbung nicht berücksichtigen.');
    const result = await parseAndCorrelateMail(mail, 'account', 'eml', cases);
    expect(result.responseKind).toBe('rejection');
    expect(result.correlation.applicationCaseId).toBeUndefined();
  });
});
