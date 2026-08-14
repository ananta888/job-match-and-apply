import type { SearchSchedule } from '../domain/models.js';

function localHour(date: Date, timeZone: string): number {
  const part = new Intl.DateTimeFormat('en', { hour: 'numeric', hourCycle: 'h23', timeZone }).formatToParts(date).find((item) => item.type === 'hour');
  return Number(part?.value ?? date.getUTCHours());
}

export function scheduleDecision(schedule: SearchSchedule, now: Date): { due: boolean; reason: string } {
  if (!schedule.enabled) return { due: false, reason: 'disabled' };
  if (now.getTime() < new Date(schedule.nextRunAt).getTime()) return { due: false, reason: 'not_due' };
  const hour = localHour(now, schedule.quietHours.timeZone);
  const { start, end } = schedule.quietHours;
  const quiet = start === end ? false : start < end ? hour >= start && hour < end : hour >= start || hour < end;
  return quiet ? { due: false, reason: 'quiet_hours' } : { due: true, reason: 'due' };
}

export function completeScheduleRun(schedule: SearchSchedule, now: Date, jobIds: string[]) {
  const previous = new Set(schedule.lastSeenJobIds);
  const newJobIds = jobIds.filter((id) => !previous.has(id));
  return {
    schedule: { ...structuredClone(schedule), lastSeenJobIds: [...new Set(jobIds)], nextRunAt: new Date(now.getTime() + schedule.intervalMinutes * 60_000).toISOString(), updatedAt: now.toISOString() },
    notification: newJobIds.length > 0 ? { kind: 'new_jobs' as const, scheduleId: schedule.id, jobIds: newJobIds } : undefined
  };
}
