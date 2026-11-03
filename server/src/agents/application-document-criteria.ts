export interface DocumentCriteriaSection {
  reference: string;
  content: string;
}

export interface ApplicationDocumentCriteriaOptions {
  mergedReview?: boolean;
}

interface DocumentProfile {
  coverLetter: boolean;
  email: boolean;
  profileCv: boolean;
  boundSourceCv: boolean;
}

const DOCUMENT_ROLES = new Set(['evidence_reviewer', 'author', 'ats_reviewer', 'recruiter_style_reviewer', 'finalizer']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function parseRecord(content: string | undefined): Record<string, unknown> | undefined {
  if (!content) return undefined;
  try { return record(JSON.parse(content)); } catch { return undefined; }
}

function isBoundSourceCv(value: unknown): boolean {
  const sourceCv = record(value);
  return Boolean(sourceCv && typeof sourceCv.revisionId === 'string' && typeof sourceCv.sha256 === 'string');
}

function documentProfile(sections: readonly DocumentCriteriaSection[]): DocumentProfile {
  const applicationCase = parseRecord(sections.find((section) => section.reference === 'application_case')?.content);
  const profile: DocumentProfile = {
    coverLetter: applicationCase?.documentType === 'cover_letter',
    email: applicationCase?.documentType === 'email',
    profileCv: applicationCase?.documentPurpose === 'profile_cv',
    boundSourceCv: isBoundSourceCv(applicationCase?.sourceCv),
  };
  if (!profile.profileCv) {
    const job = parseRecord(sections.find((section) => section.reference === 'job')?.content);
    if (job?.documentPurpose === 'profile_cv') profile.profileCv = true;
  }
  return profile;
}

/** Document-specific writing and review criteria; evidence policy and output contracts stay in the orchestrator. */
export function applicationDocumentCriteria(
  role: string,
  sections: readonly DocumentCriteriaSection[],
  options: ApplicationDocumentCriteriaOptions = {},
): string[] | undefined {
  if (!DOCUMENT_ROLES.has(role)) return undefined;
  const profile = documentProfile(sections);
  const styleReview = role === 'recruiter_style_reviewer' || (role === 'ats_reviewer' && options.mergedReview);
  const reviewDivision = options.mergedReview
    ? 'This is the single combined review: own both factual/structural checks and readability; no separate style reviewer runs.'
    : 'Keep the facts/structure review and the readability review separate. Report obvious contradictions in either review, but do not repeat the other full audit.';
  const common = [
    'The document language follows the candidate records and the vacancy (German unless English). Keep evidence annotations internal to the workflow; the document itself shows no IDs, ratings, analysis or planning notes.',
    'Claim ids: cite only ids that exist verbatim in candidate_evidence.claims and copy exact evidence references. Search preferences, reviewer suggestions and CV prose never establish new candidate facts.',
    'Use the exact bound identity from application_case; never substitute another identity, name or contact channel.',
  ];
  const evidenceRules = [
    'Use only verified or user_confirmed candidate claims with traceable evidence references.',
    'Reject inferred, unverified and do_not_use claims; never invent a candidate fact.',
  ];
  const review = ['ats_reviewer', 'recruiter_style_reviewer'].includes(role) ? [
    reviewDivision,
    'Report only actual problems as findings, at most 20, each with the exact passage, source ids and a description of at most two sentences. Do not list passed checks. Empty findings are allowed after all checks were performed.',
  ] : [];

  if (profile.coverLetter) return [...common,
    'Document: cover_letter. Write a one-page professional letter, usually 250-350 words: subject, salutation, concrete opening, two or three supported examples tied to the vacancy, concise closing and signature. Use paragraphs, not a chronological CV or a list of every career station.',
    profile.boundSourceCv
      ? 'Bound CV: application_case.sourceCv contains the exact approved CV revision and content. Preserve its facts and emphasis; use candidate_evidence for the supporting claim ids. Report contradictions or missing support; never silently substitute another CV version.'
      : 'Use the candidate records of this application case as the factual basis; report contradictions or missing support instead of resolving them silently.',
    'Use only supplied recipient/company facts and the bound identity. Do not invent addresses, dates, contact names, salary, availability, company knowledge or personal motivation. Use a neutral salutation when no contact is provided.',
    ...(role === 'evidence_reviewer' ? [...evidenceRules,
      'Return a compact matrix with one row per relevant vacancy requirement: requirement | exact candidate claim ids | example in the bound CV or records | supported/gap/conflict. Prioritize two or three strong supported matches; omit unrelated career detail. Do not draft the letter.',
    ] : []),
    ...(role === 'author' ? [
      'Plan the argument internally, then return only the annotated letter once. Add relevance beyond repeating CV bullets; a factual example must explain how it serves the role. Avoid generic company praise and invented enthusiasm.',
      'The result is a proposal and must not be represented as approved or submitted.',
    ] : []),
    ...(role === 'ats_reviewer' ? [
      'Check factual support and consistency with the candidate records, correct target role, natural supported keywords and simple parseable letter structure. Missing qualifications are gaps, never instructions to fabricate them. Do not require CV sections, reverse chronology or exhaustive employment history.',
      'Do not call searchPreferenceScore an ATS score.',
    ] : []),
    ...(styleReview ? ['Review communication quality: opening, two or three concrete examples, contribution to the role, natural voice and one-page length. Flag repeated CV bullets, generic praise and unsupported motivation. Every paragraph should contribute useful information.'] : []),
    ...(role === 'finalizer' ? [
      'Resolve the actual reviews and polish the letter while preserving exact record binding. Keep claim annotations in the upstream draft only; omit them from the final HTML. Keep it concise and ready for the shared HTML letter layout.',
      'Return a proposal only. Approval, used-state, export and submission are separate server gates.',
    ] : []),
    ...review,
  ];

  if (profile.email) return [...common,
    'Document: application email. Write a concise email: subject line, salutation, two or three short paragraphs tied to the vacancy, a clear reference to the attached application documents and a signature.',
    'Do not repeat CV content; the email names the role, the strongest supported fit and the next step. Use only supplied recipient/company facts and the bound identity. Do not invent addresses, dates, contact names, salary, availability, company knowledge or personal motivation.',
    ...(role === 'evidence_reviewer' ? [...evidenceRules,
      'Return a compact matrix with one row per relevant vacancy requirement: requirement | exact candidate claim ids | supported/gap/conflict. Prioritize two or three strong supported matches. Do not draft the email.',
    ] : []),
    ...(role === 'author' ? [
      'Plan the argument internally, then return only the annotated email once. Every factual example must explain how it serves the role; no generic company praise.',
      'The result is a proposal and must not be represented as approved or submitted.',
    ] : []),
    ...(role === 'ats_reviewer' ? [
      'Check factual support, correct target role, natural supported keywords and a parseable email structure. Missing qualifications are gaps, never instructions to fabricate them.',
      'Do not call searchPreferenceScore an ATS score.',
    ] : []),
    ...(styleReview ? ['Review communication quality: clear opening, concrete supported examples, appropriate email length and tone. Flag repeated CV content, generic praise and unsupported motivation.'] : []),
    ...(role === 'finalizer' ? [
      'Resolve the actual reviews and polish the email while preserving internal claim annotations. Keep it ready for the shared HTML layout.',
      'Return a proposal only. Approval, used-state, export and submission are separate server gates.',
    ] : []),
    ...review,
  ];

  return [...common,
    'Document: CV. Preserve complete supported employment, education, skills and certifications, with readable sections, reverse chronology and dates exactly as supplied.',
    ...(profile.profileCv
      ? ['Purpose: general profile CV. There is no vacancy or employer to match. Ignore any job or profile context for targeting; never request job keywords, a target position or vacancy-fit scores.']
      : ['Purpose: vacancy-specific CV. Check relevance only against the supplied vacancy and supported claims; do not invent missing qualifications.']),
    ...(role === 'evidence_reviewer' ? [...evidenceRules,
      'Return a Markdown evidence matrix, one row per record: record id | claim ids | supported/gap/conflict | short note. No draft or duplicated statements.',
      'Validate the source records before writing, not the prose of a future draft. Keep the matrix compact and identify contradictions, missing dates and certification validity without inventing repairs.',
    ] : []),
    ...(role === 'author' ? [
      'Plan internally, then write the complete CV once, normally within 1,200 words without dropping confirmed career stations. Keep planning notes outside the returned draft.',
      'Treat search preferences as preferences, never as candidate evidence.',
      'The result is a proposal and must not be represented as approved or submitted.',
    ] : []),
    ...(role === 'ats_reviewer' ? [
      'Own factual and structural correctness of the finished draft: compare exact employers, roles, dates and claim citations with source records; check completeness, heading structure, reverse chronology and parseability.',
      profile.profileCv
        ? 'Skip vacancy keyword checks entirely for this general profile CV. Verify that no career station or supported qualification was dropped or invented.'
        : 'Check natural use of supported job keywords and relevant emphasis. Missing qualifications remain gaps, never invented candidate facts.',
      'Do not call searchPreferenceScore an ATS score.',
    ] : []),
    ...(styleReview ? ['Review the raw annotated draft independently against the complete job, candidate records and style profile. Check whether a recruiter can understand target fit, recent career history and core skills in a fast scan; flag generic language and unsupported persuasion.'
      + (profile.profileCv ? ' For a general profile CV, assess a clear career overview without judging vacancy fit.' : '')] : []),
    ...(role === 'finalizer' ? [
      'Combine the available reviews only after they finish. Resolve factual/structural and language findings in one polished document, preserve supported content and leave evidence annotations in upstream artifacts only; never manufacture an independent review that did not run.',
      'Return a proposal only. Approval, used-state, export and submission are separate server gates.',
    ] : []),
    ...review,
  ];
}
