import type { ApplicationCase, CorrelatedMailMessage } from '../domain/models.js';

export interface EmployerResponseSourceCapabilities {
  id: string; name: string; kind: 'mailbox' | 'file' | 'portal' | 'calendar';
  explicitSync: boolean; supportsCursor: boolean; canSend: false;
}

/** Extension boundary for portal inboxes, calendars or permitted provider APIs. */
export interface EmployerResponseSourcePort {
  capabilities(): EmployerResponseSourceCapabilities;
  sync(applications: ApplicationCase[], limit: number): Promise<{ messages: CorrelatedMailMessage[]; cursor?: string }>;
}
