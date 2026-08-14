import type { ApplicationCase, ApplicationCaseState } from '../domain/models.js';

const transitions: Record<ApplicationCaseState, ApplicationCaseState[]> = {
  selected: ['analysis', 'closed'], analysis: ['questions', 'draft', 'closed'], questions: ['analysis', 'draft', 'closed'],
  draft: ['review', 'closed'], review: ['draft', 'approved', 'closed'], approved: ['review', 'exported', 'closed'],
  exported: ['approved', 'dry_run', 'closed'], dry_run: ['exported', 'submitted', 'closed'], submitted: ['closed'], closed: []
};

export function transitionApplicationCase(application: ApplicationCase, target: ApplicationCaseState, now: string): ApplicationCase {
  if (application.state === target) return structuredClone(application);
  if (!transitions[application.state].includes(target)) {
    throw Object.assign(new Error(`Übergang ${application.state} -> ${target} ist nicht erlaubt.`), { statusCode: 409 });
  }
  if (application.identityMode === 'incognito' && ['approved', 'exported', 'dry_run', 'submitted'].includes(target)) {
    throw Object.assign(new Error('Inkognito-Bewerbungsfälle dürfen Vorschau und Review nicht verlassen.'), { statusCode: 409 });
  }
  return { ...structuredClone(application), state: target, updatedAt: now, revision: application.revision + 1 };
}
