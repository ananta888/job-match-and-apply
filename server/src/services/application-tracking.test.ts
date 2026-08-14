import { describe, expect, it } from 'vitest';
import type { ApplicationCase, FollowUpReminder } from '../domain/models.js';
import { dueReminders, trackingCsv } from './application-tracking.js';

const application: ApplicationCase = {
  id: 'case', job: { id: 'job', sourceId: 'demo', title: '=Danger', company: 'Example', location: '', workModel: 'unknown', employmentType: 'unknown', description: '', skills: [] },
  identityId: 'real', identityMode: 'real', documentType: 'email', state: 'submitted', createdAt: 'now', updatedAt: 'now', artifactNames: [], warnings: [], revision: 1
};

describe('application tracking', () => {
  it('exports CSV without spreadsheet formula injection', () => { expect(trackingCsv([application], [])).toContain("'=Danger"); });
  it('uses an injected clock for due reminders', () => {
    const reminder: FollowUpReminder = { id: 'r', applicationCaseId: 'case', dueAt: '2026-08-13T10:00:00Z', timeZone: 'Europe/Berlin', note: 'Follow up', completed: false, createdAt: 'now' };
    expect(dueReminders([reminder], new Date('2026-08-13T09:00:00Z'))).toEqual([]);
    expect(dueReminders([reminder], new Date('2026-08-13T11:00:00Z'))).toEqual([reminder]);
  });
});
