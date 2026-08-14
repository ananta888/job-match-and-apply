import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import type { AppConfig } from '../domain/models.js';
import { buildMinimalLocalChildEnvironment } from './process-environment.js';

const execute = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOCUMENT_TYPES = ['cv', 'cover_letter', 'email', 'linkedin'] as const;

export interface EditableStyleProfile {
  language: string;
  locale: string;
  tone: string;
  formality: string;
  directness: string;
  sentenceLength: string;
  technicalDepth: string;
  enthusiasm: string;
  selfPromotion: string;
  humor: string;
  vocabulary: { prefer: string[]; avoid: string[] };
  preferredPatterns: string[];
  avoidPatterns: string[];
  documentStyles: Record<(typeof DOCUMENT_TYPES)[number], {
    perspective: string;
    technicalDensity: string;
    maxSentenceWords: number;
  }>;
  personalizationDefault: 'conservative' | 'professional' | 'personal';
  approvedExamples: Array<{ id: string; documentType: string; text: string; sourceRef?: string; notes?: string }>;
  rejectedExamples: Array<{ id: string; documentType: string; text: string; reason: string }>;
  qualityThresholds: { maxRepeatedSentenceStarts: number; maxAvoidPatternMatches: number };
  reviewWorkflow: { defaultMode: 'compact' | 'standard' | 'rigorous'; maxRevisionCycles: number; preferIndependentAgents: boolean };
}

export interface ApplicationStyleProfileView {
  contract: 'application-style-profile';
  contractVersion: '1.0';
  revision: number;
  sha256: string;
  initialized: true;
  profile: EditableStyleProfile;
  languageBackend: { backend: 'nspell'; localOnly: true; remoteServiceAllowed: false };
}

interface StyleMetadata { schemaVersion: 1; revision: number; sha256: string }

function policyError(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 409 });
}

function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw policyError(`style_profile_${label}_invalid`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, maximum = 2_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw policyError(`style_profile_${label}_invalid`);
  }
  return value.trim();
}
function list(value: unknown, label: string, maximum = 100): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw policyError(`style_profile_${label}_invalid`);
  const output = value.map((entry, index) => text(entry, `${label}_${index}`));
  if (new Set(output.map((entry) => entry.toLocaleLowerCase('de-DE'))).size !== output.length) {
    throw policyError(`style_profile_${label}_duplicate`);
  }
  return output;
}
function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw policyError(`style_profile_${label}_invalid`);
  }
  return value as number;
}
function within(root: string, candidate: string): boolean {
  const nested = relative(root, candidate);
  return nested === '' || (!nested.startsWith('..') && !isAbsolute(nested));
}

function editable(document: Record<string, unknown>): EditableStyleProfile {
  const profile = object(document.style_profile, 'mapping');
  const vocabulary = object(profile.vocabulary, 'vocabulary');
  const styles = object(document.document_styles, 'document_styles');
  const documentStyles = Object.fromEntries(DOCUMENT_TYPES.map((kind) => {
    const settings = object(styles[kind], `document_styles_${kind}`);
    return [kind, {
      perspective: text(settings.perspective, `${kind}_perspective`, 80),
      technicalDensity: text(settings.technical_density, `${kind}_technical_density`, 80),
      maxSentenceWords: integer(settings.max_sentence_words, `${kind}_max_sentence_words`, 10, 100),
    }];
  })) as EditableStyleProfile['documentStyles'];
  const personalization = object(document.personalization_levels, 'personalization');
  const defaultMode = text(personalization.default, 'personalization_default', 40);
  if (!['conservative', 'professional', 'personal'].includes(defaultMode)) throw policyError('style_profile_personalization_default_invalid');
  const quality = object(document.quality_thresholds, 'quality_thresholds');
  const workflow = object(document.review_workflow, 'review_workflow');
  const reviewMode = text(workflow.default_mode, 'review_mode', 40);
  if (!['compact', 'standard', 'rigorous'].includes(reviewMode)) throw policyError('style_profile_review_mode_invalid');
  if (typeof workflow.prefer_independent_agents !== 'boolean') throw policyError('style_profile_independent_agents_invalid');
  const example = (value: unknown, kind: 'approved' | 'rejected') => {
    if (!Array.isArray(value) || value.length > 50) throw policyError(`style_profile_${kind}_examples_invalid`);
    const ids = new Set<string>();
    return value.map((entry, index) => {
      const item = object(entry, `${kind}_example_${index}`);
      const id = text(item.id, `${kind}_example_id`, 120);
      if (!SAFE_ID.test(id) || ids.has(id)) throw policyError(`style_profile_${kind}_example_id_invalid`);
      ids.add(id);
      const documentType = text(item.document_type, `${kind}_example_document_type`, 40);
      if (![...DOCUMENT_TYPES, 'interview'].includes(documentType as never)) throw policyError(`style_profile_${kind}_example_document_type_invalid`);
      return kind === 'approved'
        ? { id, documentType, text: text(item.text, `${kind}_example_text`, 20_000),
            ...(item.source_ref === undefined ? {} : { sourceRef: text(item.source_ref, `${kind}_source_ref`, 500) }),
            ...(item.notes === undefined || item.notes === '' ? {} : { notes: text(item.notes, `${kind}_notes`, 2_000) }) }
        : { id, documentType, text: text(item.text, `${kind}_example_text`, 20_000), reason: text(item.reason, `${kind}_reason`, 2_000) };
    });
  };
  return {
    language: text(profile.language, 'language', 40), locale: text(profile.locale, 'locale', 40),
    tone: text(profile.tone, 'tone', 80), formality: text(profile.formality, 'formality', 80),
    directness: text(profile.directness, 'directness', 80), sentenceLength: text(profile.sentence_length, 'sentence_length', 80),
    technicalDepth: text(profile.technical_depth, 'technical_depth', 80), enthusiasm: text(profile.enthusiasm, 'enthusiasm', 80),
    selfPromotion: text(profile.self_promotion, 'self_promotion', 80), humor: text(profile.humor, 'humor', 80),
    vocabulary: { prefer: list(vocabulary.prefer, 'vocabulary_prefer'), avoid: list(vocabulary.avoid, 'vocabulary_avoid') },
    preferredPatterns: list(profile.preferred_patterns, 'preferred_patterns'), avoidPatterns: list(profile.avoid_patterns, 'avoid_patterns'),
    documentStyles,
    personalizationDefault: defaultMode as EditableStyleProfile['personalizationDefault'],
    approvedExamples: example(document.approved_examples, 'approved') as EditableStyleProfile['approvedExamples'],
    rejectedExamples: example(document.rejected_examples, 'rejected') as EditableStyleProfile['rejectedExamples'],
    qualityThresholds: {
      maxRepeatedSentenceStarts: integer(quality.max_repeated_sentence_starts, 'max_repeated_sentence_starts', 0, 100),
      maxAvoidPatternMatches: integer(quality.max_avoid_pattern_matches, 'max_avoid_pattern_matches', 0, 100),
    },
    reviewWorkflow: {
      defaultMode: reviewMode as EditableStyleProfile['reviewWorkflow']['defaultMode'],
      maxRevisionCycles: integer(workflow.max_revision_cycles, 'max_revision_cycles', 1, 5),
      preferIndependentAgents: workflow.prefer_independent_agents === true,
    },
  };
}

function applyEditable(document: Record<string, unknown>, input: EditableStyleProfile): Record<string, unknown> {
  // Round-trip through the same parser to enforce every length, enum, duplicate
  // and integer bound before touching the file system.
  const current = editable(document);
  const normalized = editable({
    ...structuredClone(document),
    style_profile: {
      ...object(document.style_profile, 'mapping'),
      language: input.language, locale: input.locale, tone: input.tone, formality: input.formality,
      directness: input.directness, sentence_length: input.sentenceLength, technical_depth: input.technicalDepth,
      enthusiasm: input.enthusiasm, self_promotion: input.selfPromotion, humor: input.humor,
      vocabulary: { prefer: input.vocabulary.prefer, avoid: input.vocabulary.avoid },
      preferred_patterns: input.preferredPatterns, avoid_patterns: input.avoidPatterns,
    },
    document_styles: Object.fromEntries(DOCUMENT_TYPES.map((kind) => [kind, {
      ...object(object(document.document_styles, 'document_styles')[kind], `document_styles_${kind}`),
      perspective: input.documentStyles[kind].perspective,
      technical_density: input.documentStyles[kind].technicalDensity,
      max_sentence_words: input.documentStyles[kind].maxSentenceWords,
    }])),
    personalization_levels: { ...object(document.personalization_levels, 'personalization'), default: input.personalizationDefault },
    approved_examples: input.approvedExamples.map((item) => ({
      id: item.id, document_type: item.documentType, text: item.text,
      ...(item.sourceRef ? { source_ref: item.sourceRef } : {}), ...(item.notes ? { notes: item.notes } : {}),
    })),
    rejected_examples: input.rejectedExamples.map((item) => ({
      id: item.id, document_type: item.documentType, text: item.text, reason: item.reason,
    })),
    quality_thresholds: {
      max_repeated_sentence_starts: input.qualityThresholds.maxRepeatedSentenceStarts,
      max_avoid_pattern_matches: input.qualityThresholds.maxAvoidPatternMatches,
    },
    review_workflow: {
      default_mode: input.reviewWorkflow.defaultMode,
      max_revision_cycles: input.reviewWorkflow.maxRevisionCycles,
      prefer_independent_agents: input.reviewWorkflow.preferIndependentAgents,
    },
  });
  void current;
  // Ensure normalization did not silently discard or coerce browser input.
  if (JSON.stringify(normalized) !== JSON.stringify(input)) throw policyError('style_profile_input_normalization_mismatch');
  const output = structuredClone(document);
  const profile = object(output.style_profile, 'mapping');
  Object.assign(profile, {
    language: input.language, locale: input.locale, tone: input.tone, formality: input.formality,
    directness: input.directness, sentence_length: input.sentenceLength, technical_depth: input.technicalDepth,
    enthusiasm: input.enthusiasm, self_promotion: input.selfPromotion, humor: input.humor,
    vocabulary: { prefer: input.vocabulary.prefer, avoid: input.vocabulary.avoid },
    preferred_patterns: input.preferredPatterns, avoid_patterns: input.avoidPatterns,
  });
  const documentStyles = object(output.document_styles, 'document_styles');
  for (const kind of DOCUMENT_TYPES) Object.assign(object(documentStyles[kind], `document_styles_${kind}`), {
    perspective: input.documentStyles[kind].perspective,
    technical_density: input.documentStyles[kind].technicalDensity,
    max_sentence_words: input.documentStyles[kind].maxSentenceWords,
  });
  object(output.personalization_levels, 'personalization').default = input.personalizationDefault;
  output.approved_examples = input.approvedExamples.map((item) => ({
    id: item.id, document_type: item.documentType, text: item.text,
    ...(item.sourceRef ? { source_ref: item.sourceRef } : {}), ...(item.notes ? { notes: item.notes } : {}),
  }));
  output.rejected_examples = input.rejectedExamples.map((item) => ({ id: item.id, document_type: item.documentType, text: item.text, reason: item.reason }));
  output.quality_thresholds = {
    max_repeated_sentence_starts: input.qualityThresholds.maxRepeatedSentenceStarts,
    max_avoid_pattern_matches: input.qualityThresholds.maxAvoidPatternMatches,
  };
  output.review_workflow = {
    default_mode: input.reviewWorkflow.defaultMode,
    max_revision_cycles: input.reviewWorkflow.maxRevisionCycles,
    prefer_independent_agents: input.reviewWorkflow.preferIndependentAgents,
  };
  return output;
}

export class ApplicationStyleProfileStore {
  private operation = Promise.resolve();
  private readonly repositoryRoot: string;
  private readonly stylePath: string;
  private readonly candidatePath: string;
  private readonly skillPath: string;
  private readonly metadataPath: string;

  constructor(
    private readonly settings: AppConfig['assistant'],
    repositoryRoot = resolve(process.cwd(), '..'),
    private readonly validationOverride?: (candidateStylePath: string) => Promise<void>,
  ) {
    this.repositoryRoot = resolve(repositoryRoot);
    const local = (value: string) => isAbsolute(value) ? resolve(value) : resolve(this.repositoryRoot, value);
    this.stylePath = local(settings.styleProfilePath);
    this.candidatePath = local(settings.candidateProfilePath);
    this.skillPath = local(settings.skillPath);
    this.metadataPath = resolve(dirname(this.stylePath), 'style-profile.meta.json');
    const privateRoot = resolve(this.repositoryRoot, '.local-data', 'profiles');
    if (!within(privateRoot, this.stylePath) || !within(privateRoot, this.candidatePath)
      || basename(this.stylePath) !== 'style-profile.yaml' || basename(this.candidatePath) !== 'candidate-profile.yaml') {
      throw policyError('style_profile_path_not_canonical');
    }
  }

  async get(): Promise<ApplicationStyleProfileView> {
    const loaded = await this.load();
    return this.view(loaded.document, loaded.revision, loaded.sha256);
  }

  update(input: { expectedRevision: number; expectedSha256: string; confirmed: true; profile: EditableStyleProfile }): Promise<ApplicationStyleProfileView> {
    const executeUpdate = async () => {
      if (input.confirmed !== true || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !SHA256.test(input.expectedSha256)) {
        throw policyError('style_profile_update_contract_invalid');
      }
      const current = await this.load();
      if (current.revision !== input.expectedRevision || current.sha256 !== input.expectedSha256) {
        throw policyError('style_profile_revision_conflict');
      }
      const updated = applyEditable(current.document, structuredClone(input.profile));
      const serialized = YAML.stringify(updated, { lineWidth: 120 });
      const nextSha = hash(serialized);
      const directory = dirname(this.stylePath);
      const temporary = resolve(directory, `.style-profile-${randomUUID()}.tmp`);
      const metadataTemporary = resolve(directory, `.style-profile-meta-${randomUUID()}.tmp`);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await this.validateWithSkill(temporary);
        const beforePublish = await this.load();
        if (beforePublish.revision !== current.revision || beforePublish.sha256 !== current.sha256) {
          throw policyError('style_profile_revision_conflict');
        }
        const metadata: StyleMetadata = { schemaVersion: 1, revision: current.revision + 1, sha256: nextSha };
        await writeFile(metadataTemporary, `${JSON.stringify(metadata)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temporary, this.stylePath);
        await chmod(this.stylePath, 0o600);
        await rename(metadataTemporary, this.metadataPath);
        await chmod(this.metadataPath, 0o600);
        return this.view(updated, metadata.revision, nextSha);
      } finally {
        await Promise.allSettled([rm(temporary, { force: true }), rm(metadataTemporary, { force: true })]);
      }
    };
    const result = this.operation.then(executeUpdate, executeUpdate);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async load(): Promise<{ document: Record<string, unknown>; revision: number; sha256: string }> {
    const stats = await lstat(this.stylePath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Object.assign(new Error('style_profile_not_initialized'), { statusCode: 404 });
      throw error;
    });
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 2 * 1024 * 1024) throw policyError('style_profile_file_unsafe');
    const bytes = await readFile(this.stylePath);
    let document: Record<string, unknown>;
    try { document = object(YAML.parse(bytes.toString('utf8')), 'document'); }
    catch { throw policyError('style_profile_yaml_invalid'); }
    editable(document);
    const sha256 = hash(bytes);
    let metadata: StyleMetadata | undefined;
    try {
      const parsed = JSON.parse(await readFile(this.metadataPath, 'utf8')) as Partial<StyleMetadata>;
      if (parsed.schemaVersion === 1 && Number.isSafeInteger(parsed.revision) && (parsed.revision as number) >= 0 && typeof parsed.sha256 === 'string' && SHA256.test(parsed.sha256)) {
        metadata = parsed as StyleMetadata;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw policyError('style_profile_metadata_invalid'); }
    const revision = metadata ? metadata.revision + (metadata.sha256 === sha256 ? 0 : 1) : 0;
    return { document, revision, sha256 };
  }

  private view(document: Record<string, unknown>, revision: number, sha256: string): ApplicationStyleProfileView {
    return {
      contract: 'application-style-profile', contractVersion: '1.0', revision, sha256, initialized: true,
      profile: editable(document),
      languageBackend: { backend: 'nspell', localOnly: true, remoteServiceAllowed: false },
    };
  }

  private async validateWithSkill(candidateStylePath: string): Promise<void> {
    if (this.validationOverride) { await this.validationOverride(candidateStylePath); return; }
    const python = process.env.PYTHON_EXECUTABLE || 'python';
    try {
      await execute(python, [resolve(this.skillPath, 'scripts', 'validate_profiles.py'), '--candidate', this.candidatePath, '--style', candidateStylePath], {
        cwd: this.skillPath, windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024,
        env: buildMinimalLocalChildEnvironment(),
      });
    } catch { throw policyError('style_profile_skill_validation_failed'); }
  }
}
