import { describe, expect, it } from 'vitest';
import type { ApplicationCase } from '../domain/models.js';
import { transitionApplicationCase } from './application-case.js';

const example = (mode: 'real' | 'incognito' = 'real'): ApplicationCase => ({
  id: 'case-1', job: { id: 'job', sourceId: 'demo', title: 'Engineer', company: 'Example', location: '', workModel: 'unknown', employmentType: 'unknown', description: '', skills: [] },
  identityId: mode, identityMode: mode, documentType: 'cover_letter', state: 'review', createdAt: '2026-08-13T00:00:00Z',
  updatedAt: '2026-08-13T00:00:00Z', artifactNames: [], warnings: [], revision: 1
});

describe('application case transitions', () => {
  it('allows a reviewed real case to be approved', () => {
    expect(transitionApplicationCase(example(), 'approved', 'later')).toMatchObject({ state: 'approved', revision: 2 });
  });
  it('blocks approval for incognito', () => {
    expect(() => transitionApplicationCase(example('incognito'), 'approved', 'later')).toThrow('Inkognito');
  });
  it('blocks skipped stages', () => {
    expect(() => transitionApplicationCase(example(), 'submitted', 'later')).toThrow('nicht erlaubt');
  });
});
