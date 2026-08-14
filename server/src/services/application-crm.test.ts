import { describe, expect, it } from 'vitest';
import type { ApplicationCase } from '../domain/models.js';
import { buildCompanyCrm } from './application-crm.js';

const makeCase = (id: string, title: string): ApplicationCase => ({ id, job: { id: `job-${id}`, sourceId: 'test', title, company: 'Acme GmbH', location: 'Köln', workModel: 'hybrid', employmentType: 'full_time', description: '', skills: [] }, identityId: 'real', identityMode: 'real', documentType: 'cover_letter', state: 'draft', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', artifactNames: [], warnings: [], revision: 1 });

describe('company CRM', () => {
  it('groups a company while retaining separate job histories', () => {
    const result = buildCompanyCrm([makeCase('case-a', 'Backend'), makeCase('case-b', 'Frontend')], [{ id: 'event', applicationCaseId: 'case-b', status: 'interview', occurredAt: '2026-08-13T00:00:00Z', source: 'user' }], [], []);
    expect(result).toHaveLength(1);
    expect(result[0]!.applications).toHaveLength(2);
    expect((result[0]!.applications[0] as { tracking: unknown[] }).tracking).toHaveLength(0);
    expect((result[0]!.applications[1] as { tracking: unknown[] }).tracking).toHaveLength(1);
  });
});
