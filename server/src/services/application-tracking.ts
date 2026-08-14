import type { ApplicationCase, ApplicationStatusEvent, FollowUpReminder } from '../domain/models.js';

const csvCell = (value: unknown): string => {
  let text = String(value ?? '');
  if (/^[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

export function trackingCsv(applications: ApplicationCase[], events: ApplicationStatusEvent[]): string {
  const rows = [['case_id', 'job_title', 'company', 'state', 'updated_at', 'event_count']];
  for (const application of applications) rows.push([
    application.id, application.job.title, application.job.company, application.state, application.updatedAt,
    String(events.filter((event) => event.applicationCaseId === application.id).length)
  ]);
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

export function dueReminders(reminders: FollowUpReminder[], now: Date): FollowUpReminder[] {
  return reminders.filter((reminder) => !reminder.completed && new Date(reminder.dueAt).getTime() <= now.getTime());
}
