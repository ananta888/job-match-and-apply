import type { ApplicationArtifactRevision, ApplicationCase, ApplicationTrackingEvent, CorrelatedMailMessage } from '../domain/models.js';
import { companyKey } from './mail-correlation.js';

export function buildCompanyCrm(
  applications: ApplicationCase[], tracking: ApplicationTrackingEvent[],
  messages: CorrelatedMailMessage[], artifacts: ApplicationArtifactRevision[]
) {
  const groups = new Map<string, { key: string; name: string; applications: unknown[]; unassignedMessages: CorrelatedMailMessage[] }>();
  for (const application of applications) {
    const key = companyKey(application.job.company); const group = groups.get(key) ?? { key, name: application.job.company, applications: [], unassignedMessages: [] };
    group.applications.push({
      ...application,
      tracking: tracking.filter((item) => item.applicationCaseId === application.id),
      messages: messages.filter((item) => item.correlation.applicationCaseId === application.id),
      artifacts: artifacts.filter((item) => item.applicationCaseId === application.id)
    });
    groups.set(key, group);
  }
  for (const message of messages.filter((item) => !item.correlation.applicationCaseId && item.correlation.companyKey)) {
    groups.get(message.correlation.companyKey!)?.unassignedMessages.push(message);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
}
