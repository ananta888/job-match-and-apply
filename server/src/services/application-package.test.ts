import { describe, expect, it } from 'vitest';
import type { ApplicationCase } from '../domain/models.js';
import { createApplicationPackage, createSubmissionDryRun } from './application-package.js';

const application = (mode: 'real' | 'incognito', state: ApplicationCase['state']): ApplicationCase => ({
  id: 'case', job: { id: 'job', sourceId: 'stepstone', title: 'Engineer', company: 'Example', location: '', workModel: 'unknown', employmentType: 'unknown', description: '', skills: [], url: 'https://example.test/job' },
  identityId: 'identity', identityMode: mode, documentType: 'cover_letter', state,
  createdAt: 'now', updatedAt: 'now', artifactNames: [], warnings: [], revision: 4
});

describe('application package', () => {
  it('hashes approved files and creates a side-effect-free dry run', () => {
    const manifest = createApplicationPackage(application('real', 'approved'), [{ name: 'letter.txt', content: 'Final' }], [], 'now');
    const dryRun = createSubmissionDryRun({ ...application('real', 'exported'), revision: 5 }, manifest);
    expect(manifest.files[0]?.sha256).toHaveLength(64);
    expect(dryRun.externalSideEffects).toBe(false);
    expect(dryRun.idempotencyKey).toHaveLength(64);
  });
  it('blocks incognito and internal evidence annotations', () => {
    expect(() => createApplicationPackage(application('incognito', 'approved'), [{ name: 'x', content: 'Final' }], [], 'now')).toThrow('reale Identität');
    expect(() => createApplicationPackage(application('real', 'approved'), [{ name: 'x', content: 'Fact <!-- evidence: claim -->' }], [], 'now')).toThrow('Evidence');
  });
});
