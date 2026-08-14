import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { ApplicationStyleProfileStore } from './style-profile.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const settings = {
  skillPath: 'integrations/assistant',
  candidateProfilePath: '.local-data/profiles/candidate-profile.yaml',
  styleProfilePath: '.local-data/profiles/style-profile.yaml',
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'application-style-profile-'));
  roots.push(root);
  const profileRoot = join(root, '.local-data', 'profiles');
  await mkdir(join(root, 'integrations', 'assistant'), { recursive: true });
  await mkdir(profileRoot, { recursive: true });
  await writeFile(join(profileRoot, 'candidate-profile.yaml'), 'schema_version: 2\nclaims: []\n', 'utf8');
  const document = {
    schema_version: 2,
    style_profile: {
      language: 'de', locale: 'de-DE', tone: 'direct', formality: 'professional_relaxed', directness: 'high',
      sentence_length: 'short_to_medium', technical_depth: 'high', enthusiasm: 'restrained', self_promotion: 'moderate', humor: 'minimal',
      vocabulary: { prefer: ['konkret'], avoid: ['generisch'] }, preferred_patterns: ['Belege nennen'], avoid_patterns: ['große Begeisterung'],
    },
    document_styles: {
      cv: { perspective: 'implied_first_person', technical_density: 'high', max_sentence_words: 28, sentence_fragments: 'allowed' },
      cover_letter: { perspective: 'first_person', technical_density: 'medium', max_sentence_words: 32, paragraph_variation: 'natural' },
      email: { perspective: 'first_person', technical_density: 'low_to_medium', max_sentence_words: 28, length: 'very_short' },
      linkedin: { perspective: 'first_person', technical_density: 'medium', max_sentence_words: 30, personal_context: 'allowed' },
    },
    personalization_levels: {
      default: 'professional', conservative: { description: 'Formell' }, professional: { description: 'Klar' }, personal: { description: 'Persönlich' },
    },
    approved_examples: [], rejected_examples: [],
    quality_thresholds: { max_repeated_sentence_starts: 2, max_avoid_pattern_matches: 0 },
    review_workflow: { default_mode: 'rigorous', max_revision_cycles: 2, prefer_independent_agents: true },
    language_quality: { primary_backend: 'languagetool', language: 'de-DE', local_server: 'http://localhost:8010/v2/check', allow_remote_service: false, allowlist: [] },
  };
  await writeFile(join(profileRoot, 'style-profile.yaml'), YAML.stringify(document), 'utf8');
  return { root, path: join(profileRoot, 'style-profile.yaml') };
}

describe('ApplicationStyleProfileStore', () => {
  it('round-trips only the closed editable view and publishes an atomic revision after authoritative validation', async () => {
    const { root, path } = await fixture();
    const validator = vi.fn(async (candidate: string) => { expect(candidate).toContain('.style-profile-'); });
    const store = new ApplicationStyleProfileStore(settings, root, validator);
    const initial = await store.get();
    expect(initial).toMatchObject({
      contract: 'application-style-profile', contractVersion: '1.0', revision: 0, initialized: true,
      languageBackend: { backend: 'nspell', localOnly: true, remoteServiceAllowed: false },
    });
    expect(JSON.stringify(initial)).not.toContain('local_server');
    const profile = structuredClone(initial.profile);
    profile.tone = 'präzise';
    profile.reviewWorkflow.maxRevisionCycles = 3;
    profile.approvedExamples = [{ id: 'example-one', documentType: 'cover_letter', text: 'Synthetisches Stilbeispiel.' }];
    const updated = await store.update({
      expectedRevision: initial.revision, expectedSha256: initial.sha256, confirmed: true, profile,
    });
    expect(updated).toMatchObject({ revision: 1, profile: { tone: 'präzise', reviewWorkflow: { maxRevisionCycles: 3 } } });
    expect(updated.sha256).not.toBe(initial.sha256);
    expect(validator).toHaveBeenCalledTimes(1);
    const persisted = YAML.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect((persisted.language_quality as Record<string, unknown>).local_server).toBe('http://localhost:8010/v2/check');
    expect((persisted.approved_examples as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'example-one', document_type: 'cover_letter' });
  });

  it('rejects stale CAS writes, invalid duplicate lists and non-canonical profile paths', async () => {
    const { root } = await fixture();
    const store = new ApplicationStyleProfileStore(settings, root, async () => undefined);
    const initial = await store.get();
    const profile = structuredClone(initial.profile);
    profile.vocabulary.prefer = ['klar', 'KLAR'];
    await expect(store.update({ expectedRevision: 0, expectedSha256: initial.sha256, confirmed: true, profile }))
      .rejects.toThrow('duplicate');
    const valid = structuredClone(initial.profile); valid.tone = 'ruhig';
    await store.update({ expectedRevision: 0, expectedSha256: initial.sha256, confirmed: true, profile: valid });
    await expect(store.update({ expectedRevision: 0, expectedSha256: initial.sha256, confirmed: true, profile: valid }))
      .rejects.toThrow('revision_conflict');
    expect(() => new ApplicationStyleProfileStore({ ...settings, styleProfilePath: 'style-profile.yaml' }, root))
      .toThrow('path_not_canonical');
  });
});
