import { describe, expect, it } from 'vitest';
import { applicationDocumentCriteria, type DocumentCriteriaSection } from './application-document-criteria.js';

function sections(overrides: Record<string, unknown> = {}): DocumentCriteriaSection[] {
  return [
    { reference: 'job', content: JSON.stringify({ id: 'job-1', title: 'Senior IAM Engineer' }) },
    { reference: 'candidate_evidence', content: JSON.stringify({ claims: [] }) },
    { reference: 'application_case', content: JSON.stringify({ id: 'case-1', documentType: 'cv', identityMode: 'real', ...overrides }) },
  ];
}

describe('application document criteria', () => {
  it('returns undefined for non-document roles', () => {
    expect(applicationDocumentCriteria('mail_classifier', sections())).toBeUndefined();
    expect(applicationDocumentCriteria('job_analyst', [])).toBeUndefined();
  });

  it('gives the author letter criteria for cover letters, not CV criteria', () => {
    const criteria = applicationDocumentCriteria('author', sections({ documentType: 'cover_letter' }))!;
    expect(criteria.some((line) => line.includes('cover_letter'))).toBe(true);
    expect(criteria.some((line) => line.includes('one-page professional letter'))).toBe(true);
    expect(criteria.some((line) => line.includes('1,200 words'))).toBe(false);
    expect(criteria.some((line) => line.includes('must not be represented as approved or submitted'))).toBe(true);
  });

  it('keeps the bound-CV instruction bound to a present sourceCv binding only', () => {
    const unbound = applicationDocumentCriteria('author', sections({ documentType: 'cover_letter' }))!;
    expect(unbound.some((line) => line.includes('Bound CV'))).toBe(false);
    const bound = applicationDocumentCriteria('author', sections({ documentType: 'cover_letter', sourceCv: { revisionId: 'rev-1', sha256: 'a'.repeat(64), artifactId: 'art-1' } }))!;
    expect(bound.some((line) => line.includes('Bound CV: application_case.sourceCv'))).toBe(true);
  });

  it('gives the evidence reviewer a compact requirement matrix for cover letters', () => {
    const criteria = applicationDocumentCriteria('evidence_reviewer', sections({ documentType: 'cover_letter' }))!;
    expect(criteria.some((line) => line.includes('compact matrix with one row per relevant vacancy requirement'))).toBe(true);
    expect(criteria.some((line) => line.includes('Do not draft the letter'))).toBe(true);
    expect(criteria.some((line) => line.includes('never invent a candidate fact'))).toBe(true);
  });

  it('keeps the ats reviewer from demanding CV structure for cover letters', () => {
    const criteria = applicationDocumentCriteria('ats_reviewer', sections({ documentType: 'cover_letter' }))!;
    expect(criteria.some((line) => line.includes('Do not require CV sections'))).toBe(true);
    expect(criteria.some((line) => line.includes('Do not call searchPreferenceScore an ATS score'))).toBe(true);
  });

  it('describes a concise application email for documentType email', () => {
    for (const role of ['author', 'finalizer', 'ats_reviewer', 'evidence_reviewer', 'recruiter_style_reviewer']) {
      const criteria = applicationDocumentCriteria(role, sections({ documentType: 'email' }))!;
      expect(criteria.some((line) => line.includes('Document: application email'))).toBe(true);
    }
    const author = applicationDocumentCriteria('author', sections({ documentType: 'email' }))!;
    expect(author.some((line) => line.includes('Do not repeat CV content'))).toBe(true);
  });

  it('writes a complete CV with reverse chronology for the default document', () => {
    const criteria = applicationDocumentCriteria('author', sections({ documentType: 'cv' }))!;
    expect(criteria.some((line) => line.includes('Document: CV'))).toBe(true);
    expect(criteria.some((line) => line.includes('vacancy-specific CV'))).toBe(true);
    expect(criteria.some((line) => line.includes('1,200 words'))).toBe(true);
  });

  it('treats a profile CV as vacancy-free', () => {
    const viaCase = applicationDocumentCriteria('ats_reviewer', sections({ documentPurpose: 'profile_cv' }))!;
    expect(viaCase.some((line) => line.includes('Skip vacancy keyword checks entirely'))).toBe(true);
    const viaJob = applicationDocumentCriteria('ats_reviewer', [
      { reference: 'job', content: JSON.stringify({ documentPurpose: 'profile_cv' }) },
      { reference: 'application_case', content: JSON.stringify({ documentType: 'cv' }) },
    ])!;
    expect(viaJob.some((line) => line.includes('general profile CV'))).toBe(true);
  });

  it('falls back to CV defaults when the application case is missing or invalid', () => {
    const missing = applicationDocumentCriteria('author', [{ reference: 'job', content: '{}' }])!;
    expect(missing.some((line) => line.includes('Document: CV'))).toBe(true);
    const invalid = applicationDocumentCriteria('author', [{ reference: 'application_case', content: 'not json' }])!;
    expect(invalid.some((line) => line.includes('Document: CV'))).toBe(true);
  });

  it('separates reviews unless a merged review is requested', () => {
    const separated = applicationDocumentCriteria('recruiter_style_reviewer', sections({ documentType: 'cv' }))!;
    expect(separated.some((line) => line.includes('Keep the facts/structure review and the readability review separate'))).toBe(true);
    const merged = applicationDocumentCriteria('ats_reviewer', sections({ documentType: 'cv' }), { mergedReview: true })!;
    expect(merged.some((line) => line.includes('single combined review'))).toBe(true);
  });
});
