import { describe, expect, it } from 'vitest';
import type { SearchSchedule } from '../domain/models.js';
import { defaultConfig } from '../config/defaults.js';
import { completeScheduleRun, scheduleDecision } from './search-scheduler.js';

const schedule: SearchSchedule = {
  id: 'schedule', name: 'Daily', enabled: true, profile: defaultConfig.searchProfile, intervalMinutes: 60,
  quietHours: { start: 22, end: 7, timeZone: 'Europe/Berlin' }, nextRunAt: '2026-08-13T08:00:00Z', lastSeenJobIds: ['old'], updatedAt: 'now'
};

describe('search scheduler', () => {
  it('respects due time and quiet hours with an injected clock', () => {
    expect(scheduleDecision(schedule, new Date('2026-08-13T10:00:00Z'))).toEqual({ due: true, reason: 'due' });
    expect(scheduleDecision(schedule, new Date('2026-08-13T21:00:00Z')).reason).toBe('quiet_hours');
  });
  it('notifies only for unseen jobs and advances once without retries', () => {
    const result = completeScheduleRun(schedule, new Date('2026-08-13T10:00:00Z'), ['old', 'new']);
    expect(result.notification?.jobIds).toEqual(['new']);
    expect(result.schedule.nextRunAt).toBe('2026-08-13T11:00:00.000Z');
  });
});
