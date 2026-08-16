import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyCvContractRejection, conflictsFromArtifact, cvContractChildEnvironment, cvFactAdditionForContract,
  mapCvAdoptionDecisions, readValidatedPrivateProfile, selectedClaimIdsAlreadyAdopted,
  SubmoduleCvNormalizationAdapter, unresolvedConflictsForDecisions,
} from './submodule-cv-normalization.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

async function adapterWithStaticOutput(output: Record<string, unknown>) {
  const sandbox = await mkdtemp(join(tmpdir(), 'cv-contract-output-'));
  const skillRoot = join(sandbox, 'skills', 'assistant');
  const scripts = join(skillRoot, 'scripts');
  const profiles = join(sandbox, '.local-data', 'profiles');
  await mkdir(scripts, { recursive: true });
  await mkdir(profiles, { recursive: true });
  await writeFile(join(scripts, 'cv_import_contract.py'), `print(${JSON.stringify(JSON.stringify(output))})\n`);
  return {
    sandbox,
    adapter: new SubmoduleCvNormalizationAdapter(
      skillRoot, join(profiles, 'candidate-profile.yaml'), join(profiles, 'style-profile.yaml'),
    ),
  };
}

const validStaticArtifact = () => ({
  contract: 'cv-import-proposal', contract_version: '1.0',
  extraction: { warnings: [], conflicts: [] },
  proposal: { facts: [{
    id: 'fact-valid', claim_id: 'claim-valid', category: 'skill', record_id: 'skill-valid',
    field: 'name', value: 'TypeScript', status: 'unverified',
    source_anchor: { source_sha256: 'a'.repeat(64), line_start: 1 },
  }] },
});

describe('submodule CV normalization adapter', () => {
  it('uses the versioned UTF-8 stdin/stdout contract for non-ASCII text without a source temp file', async () => {
    const repository = resolve(process.cwd(), '..');
    const adapter = new SubmoduleCvNormalizationAdapter(
      resolve(repository, 'integrations', 'bewerbungs-schreib-assistent'),
      resolve(repository, '.local-data', 'profiles', 'candidate-profile.yaml'),
      resolve(repository, '.local-data', 'profiles', 'style-profile.yaml'),
    );
    const text = 'Experience\n2021-02 - present: Software Engineer | Example GmbH\nReduced latency – zuverlässig in München';
    const sourceSha256 = createHash('sha256').update('synthetic input').digest('hex');
    const result = await adapter.normalize({
      contract: 'cv-normalization-input', contractVersion: '1.0', extractedText: text,
      warnings: [],
      source: { fileName: 'synthetic.html', mimeType: 'text/html', sha256: sourceSha256, byteSize: 15 },
    });
    expect(result.artifact).toMatchObject({ contract: 'cv-import-proposal', contract_version: '1.0', publishable: false });
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'employment', field: 'role', decision: 'pending' }),
      expect.objectContaining({ category: 'employment', field: 'company', decision: 'pending' }),
    ]));
    expect(result.facts.every((fact) => fact.provenance.sourceSha256 === sourceSha256)).toBe(true);
  });

  it('validates and selectively applies a source-anchored AI structure without confirming facts', async () => {
    const repository = resolve(process.cwd(), '..');
    const adapter = new SubmoduleCvNormalizationAdapter(
      resolve(repository, 'integrations', 'bewerbungs-schreib-assistent'),
      resolve(repository, '.local-data', 'profiles', 'candidate-profile.yaml'),
      resolve(repository, '.local-data', 'profiles', 'style-profile.yaml'),
    );
    const text = 'Berufserfahrung\n01/2021 – heute\nSoftware Engineer\nExample GmbH\nMünchen\nReduzierte die Laufzeit';
    const sourceSha256 = createHash('sha256').update('synthetic ai input').digest('hex');
    const normalized = await adapter.normalize({
      contract: 'cv-normalization-input', contractVersion: '1.0', extractedText: text, warnings: [],
      source: { fileName: 'synthetic-ai.html', mimeType: 'text/html', sha256: sourceSha256, byteSize: 42 },
    });
    const artifact = normalized.artifact as Record<string, unknown>;
    const extraction = artifact.extraction as { text_sha256: string; line_manifest: Array<{ line: number; text: string }> };
    const source = artifact.source as { id: string; sha256: string };
    const baseProposalSha256 = createHash('sha256').update(canonical(artifact)).digest('hex');
    const anchored = (lineNumber: number, value: string) => {
      const line = extraction.line_manifest[lineNumber - 1]!.text; const start = line.indexOf(value);
      expect(start).toBeGreaterThanOrEqual(0);
      return {
        value, source_anchor: { line_start: lineNumber, line_end: lineNumber, char_start: start, char_end: start + value.length, quote: value },
        confidence: 0.9, alternatives: [], questions: [], status: 'unverified',
      };
    };
    const providerProposal = {
      contract: 'ai-cv-structure-proposal', contract_version: '1.0', status: 'unverified',
      binding: {
        source_id: source.id, source_sha256: source.sha256, text_sha256: extraction.text_sha256,
        base_proposal_sha256: baseProposalSha256,
      },
      sections: [{ kind: 'employment', heading: anchored(1, 'Berufserfahrung'), status: 'unverified' }],
      employment: [{
        employer: anchored(4, 'Example GmbH'), role: anchored(3, 'Software Engineer'),
        start_date: anchored(2, '01/2021'), end_date: anchored(2, 'heute'),
        location: anchored(5, 'München'), details: [anchored(6, 'Reduzierte die Laufzeit')], status: 'unverified',
      }],
      education: [], projects: [], skills: [], languages: [],
    };
    const contract = await adapter.contract();
    expect(contract).toMatchObject({ outputContract: 'ai-cv-structure-proposal', outputContractVersion: '1.0' });
    const validated = await adapter.validateProposal({
      baseProposalArtifact: artifact, expectedBaseProposalSha256: baseProposalSha256, aiProposal: providerProposal,
    });
    expect(validated.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'employment[0].employer', value: 'Example GmbH', mergeable: true }),
      expect.objectContaining({ path: 'employment[0].start_date', value: '01/2021', mergeable: true }),
    ]));
    const selected = validated.suggestions.filter((suggestion) => suggestion.mergeable && suggestion.value !== null)
      .map((suggestion) => ({ suggestionId: suggestion.id, alternativeId: null }));
    const merged = await adapter.applySelections({
      baseProposalArtifact: artifact, expectedBaseProposalSha256: baseProposalSha256,
      aiProposalArtifact: validated.privateArtifact, expectedAiProposalSha256: validated.proposalSha256,
      selections: selected,
    });
    expect(merged.facts).toHaveLength(selected.length);
    expect(merged.facts.every((fact) => fact.decision === 'pending'
      && fact.provenance.origin === 'imported'
      && fact.provenance.recognition?.method === 'ai_assisted')).toBe(true);
    expect(merged.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'start_date', value: '2021-01' }),
      expect.objectContaining({ field: 'company', value: 'Example GmbH' }),
    ]));

    const materialized = await adapter.materializeRecognitionVersion({
      baseProposalArtifact: artifact, expectedBaseProposalSha256: baseProposalSha256,
      aiProposalArtifact: validated.privateArtifact, expectedAiProposalSha256: validated.proposalSha256,
    });
    const materializedArtifact = materialized.materializedArtifact as Record<string, unknown>;
    const materializedProposal = materializedArtifact.proposal as { facts: unknown[]; additional_facts: unknown[] };
    expect(materialized.materializedProposalSha256).toBe(
      createHash('sha256').update(canonical(materializedArtifact)).digest('hex'),
    );
    expect(materialized.facts).toHaveLength(materializedProposal.facts.length);
    expect(materialized.appliedSuggestionIds).toEqual(selected.map((item) => item.suggestionId).sort());
    expect(materializedProposal.additional_facts).toEqual([]);
    expect(materialized.facts.filter((fact) => fact.provenance.recognition?.method === 'ai_assisted'))
      .toHaveLength(selected.length);
    expect(materialized.facts.every((fact) => fact.decision === 'pending')).toBe(true);
    expect(materialized.unresolvedConflicts).toEqual([]);

    await expect(adapter.materializeRecognitionVersion({
      baseProposalArtifact: artifact, expectedBaseProposalSha256: baseProposalSha256,
      aiProposalArtifact: { ...(validated.privateArtifact as object), unexpectedPrivateValue: 'CANARY_PRIVATE_CONTENT' },
      expectedAiProposalSha256: validated.proposalSha256,
    })).rejects.toMatchObject({
      statusCode: 503, errorCode: 'cv_local_dependency_unavailable', stage: 'cv_skill_contract', retryable: true,
    });
  });

  it('requires every advertised full-version materialization capability exactly', async () => {
    const capabilities = {
      contract: 'cv-import-proposal', contract_version: '1.0',
      commands: ['materialize-ai-structure'],
      ai_structuring: {
        contract: 'ai-cv-structure-proposal', contract_version: '1.0',
        schema: 'contracts/v1/ai-cv-structure-proposal.schema.json',
        validation_request_contract: 'ai-cv-structure-validation-request',
        apply_request_contract: 'ai-cv-structure-apply-request',
        materialization_request_contract: 'ai-cv-structure-materialization-request',
        materialization_request_schema: 'contracts/v1/ai-cv-structure-materialization-request.schema.json',
        materialization_output_contract: 'cv-import-proposal', materialization_output_contract_version: '1.0',
        materialization_mode: 'replace_recognition_version',
        materialization_selection_policy: 'unsafe_partial_selection',
        max_materialized_facts: 2_000, preserved_deterministic_scopes: ['profile', 'certifications'],
        validated_contract: 'validated-ai-cv-structure-proposal', line_manifest_private: true,
        network_access: false, statuses: ['unverified'],
      },
    };
    const { adapter, sandbox } = await adapterWithStaticOutput(capabilities);
    try {
      await expect(adapter.contract()).rejects.toMatchObject({
        statusCode: 503, errorCode: 'cv_local_dependency_unavailable', stage: 'cv_skill_contract', retryable: true,
      });
    } finally { await rm(sandbox, { recursive: true, force: true }); }
  });

  it('owns the Python UTF-8 flags instead of inheriting arbitrary host values', () => {
    expect(cvContractChildEnvironment({
      PATH: 'synthetic-path', PYTHONUTF8: '0', PYTHONIOENCODING: 'cp1252', PRIVATE_TOKEN: 'must-not-cross',
    })).toEqual({
      PATH: 'synthetic-path', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    });
  });

  it('classifies an allowlisted exit-2 rejection without retaining upstream detail', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'cv-contract-rejection-'));
    try {
      const skillRoot = join(sandbox, 'skills', 'assistant');
      const scripts = join(skillRoot, 'scripts');
      const profiles = join(sandbox, '.local-data', 'profiles');
      await mkdir(scripts, { recursive: true });
      await mkdir(profiles, { recursive: true });
      await writeFile(join(scripts, 'cv_import_contract.py'), [
        'import json',
        'print(json.dumps({"status": "rejected", "error": {"code": "normalization_failed", "safe_detail": "CANARY_PRIVATE_CONTENT C:/private/resume.html token=secret"}}))',
        'raise SystemExit(2)',
      ].join('\n'));
      const adapter = new SubmoduleCvNormalizationAdapter(
        skillRoot, join(profiles, 'candidate-profile.yaml'), join(profiles, 'style-profile.yaml'),
      );
      let failure: unknown;
      try {
        await adapter.normalize({
          contract: 'cv-normalization-input', contractVersion: '1.0', extractedText: 'Skills: TypeScript',
          warnings: [], source: {
            fileName: 'synthetic.html', mimeType: 'text/html', sha256: 'e'.repeat(64), byteSize: 18,
          },
        });
      } catch (error) { failure = error; }
      expect(failure).toMatchObject({
        statusCode: 422, errorCode: 'normalization_failed', stage: 'cv_import_normalization', retryable: false,
      });
      const publicFailure = JSON.stringify({
        message: (failure as Error).message,
        publicDetail: (failure as { publicDetail?: string }).publicDetail,
      });
      expect(publicFailure).not.toContain('CANARY_PRIVATE_CONTENT');
      expect(publicFailure).not.toContain('private/resume');
      expect(publicFailure).not.toContain('token=secret');
    } finally { await rm(sandbox, { recursive: true, force: true }); }
  });

  it('rejects typwidrig local fact fields instead of coercing private values to strings', async () => {
    for (const mutate of [
      (fact: Record<string, unknown>) => { fact.id = null; },
      (fact: Record<string, unknown>) => { fact.category = { private: 'CANARY_PRIVATE_CONTENT' }; },
      (fact: Record<string, unknown>) => { fact.value = { private: 'CANARY_PRIVATE_CONTENT' }; },
      (fact: Record<string, unknown>) => { fact.source_anchor = { source_sha256: 'a'.repeat(64), line_start: '1' }; },
    ]) {
      const output = validStaticArtifact();
      mutate(output.proposal.facts[0] as Record<string, unknown>);
      const { adapter, sandbox } = await adapterWithStaticOutput(output);
      try {
        let failure: unknown;
        try {
          await adapter.normalize({
            contract: 'cv-normalization-input', contractVersion: '1.0', extractedText: 'Synthetic', warnings: [],
            source: { fileName: 'synthetic.html', mimeType: 'text/html', sha256: 'a'.repeat(64), byteSize: 9 },
          });
        } catch (error) { failure = error; }
        expect(failure).toMatchObject({
          statusCode: 503, errorCode: 'cv_local_dependency_unavailable', stage: 'cv_skill_contract', retryable: true,
        });
        expect(`${(failure as Error).message} ${(failure as { publicDetail?: string }).publicDetail}`).not.toContain('CANARY_PRIVATE_CONTENT');
      } finally { await rm(sandbox, { recursive: true, force: true }); }
    }
  });

  it('rejects typwidrig warning and conflict diagnostics without retaining their payloads', async () => {
    for (const mutate of [
      (output: ReturnType<typeof validStaticArtifact>) => { output.extraction.warnings = [{ code: { private: 'CANARY_PRIVATE_CONTENT' }, detail: 'warning' }] as never; },
      (output: ReturnType<typeof validStaticArtifact>) => { output.extraction.conflicts = [{ code: 'conflict', detail: { private: 'CANARY_PRIVATE_CONTENT' } }] as never; },
    ]) {
      const output = validStaticArtifact(); mutate(output);
      const { adapter, sandbox } = await adapterWithStaticOutput(output);
      try {
        let failure: unknown;
        try {
          await adapter.normalize({
            contract: 'cv-normalization-input', contractVersion: '1.0', extractedText: 'Synthetic', warnings: [],
            source: { fileName: 'synthetic.html', mimeType: 'text/html', sha256: 'a'.repeat(64), byteSize: 9 },
          });
        } catch (error) { failure = error; }
        expect(failure).toMatchObject({
          statusCode: 503, errorCode: 'cv_local_dependency_unavailable', stage: 'cv_skill_contract', retryable: true,
        });
        expect(`${(failure as Error).message} ${(failure as { publicDetail?: string }).publicDetail}`).not.toContain('CANARY_PRIVATE_CONTENT');
      } finally { await rm(sandbox, { recursive: true, force: true }); }
    }
  });

  it('fails closed on a non-allowlisted rejection code', () => {
    const failure = classifyCvContractRejection('normalize-extracted', {
      status: 'rejected',
      error: { code: 'private_C:/resume.html', safe_detail: 'CANARY_PRIVATE_CONTENT token=secret' },
    });
    expect(failure).toMatchObject({
      statusCode: 503, errorCode: 'cv_skill_protocol_error', stage: 'cv_skill_contract', retryable: true,
    });
    expect(`${failure.message} ${failure.publicDetail}`).not.toContain('CANARY_PRIVATE_CONTENT');
    expect(`${failure.message} ${failure.publicDetail}`).not.toContain('resume.html');
  });

  it('classifies a bounded materialization rejection without reflecting upstream detail', () => {
    const failure = classifyCvContractRejection('materialize-ai-structure', {
      status: 'rejected',
      error: { code: 'ai_materialization_no_usable_facts', safe_detail: 'CANARY_PRIVATE_CONTENT C:/resume.pdf' },
    });
    expect(failure).toMatchObject({
      statusCode: 422, errorCode: 'ai_materialization_no_usable_facts', stage: 'cv_skill_contract', retryable: false,
    });
    expect(`${failure.message} ${failure.publicDetail}`).not.toContain('CANARY_PRIVATE_CONTENT');
    expect(`${failure.message} ${failure.publicDetail}`).not.toContain('resume.pdf');
  });

  it('treats a server-built normalization digest mismatch as a local dependency failure', () => {
    const failure = classifyCvContractRejection('normalize-extracted', {
      status: 'rejected',
      error: { code: 'digest_mismatch', safe_detail: 'CANARY_PRIVATE_CONTENT C:/private/resume.html' },
    });
    expect(failure).toMatchObject({
      statusCode: 503, errorCode: 'digest_mismatch', stage: 'cv_import_normalization', retryable: true,
    });
    expect(`${failure.message} ${failure.publicDetail}`).not.toContain('CANARY_PRIVATE_CONTENT');
    expect(`${failure.message} ${failure.publicDetail}`).not.toContain('resume.html');
  });

  it('preserves CAS conflict classification outside server-built normalization', () => {
    expect(classifyCvContractRejection('adopt-confirmed', {
      status: 'rejected', error: { code: 'cas_mismatch', safe_detail: 'private detail' },
    })).toMatchObject({
      statusCode: 409, errorCode: 'cas_mismatch', stage: 'cv_profile_adoption', retryable: false,
    });
  });

  it('maps extended contract fact IDs back to server-generated user addition decisions', () => {
    const sourceSha256 = 'a'.repeat(64);
    const artifact = { proposal: { facts: [
      { id: 'fact-contract-new', claim_id: 'claim-contract-new', category: 'achievement', record_id: 'experience-new', field: 'details[0]', value: 'Result', status: 'unverified', source_anchor: { origin: 'user_supplied', addition_id: 'fact-user-local', source_sha256: sourceSha256 } },
      { id: 'fact-imported', claim_id: 'claim-imported', category: 'skill', record_id: 'skill-one', field: 'name', value: 'Old', status: 'unverified', source_anchor: { source_sha256: sourceSha256, line_start: 1 } },
    ] } };
    const facts = [
      { id: 'fact-user-local', category: 'employment', recordId: 'record-user-local', field: 'achievement', value: 'Result', decision: 'confirmed', provenance: { sourceSha256, anchor: 'user:now', origin: 'user_supplied' } },
      { id: 'fact-imported', claimId: 'claim-imported', category: 'skill', recordId: 'skill-one', field: 'name', value: 'Old', decision: 'rejected', provenance: { sourceSha256, anchor: 'line:1', origin: 'imported' } },
    ] as const;
    expect(mapCvAdoptionDecisions(facts as never, artifact)).toEqual([
      { fact_id: 'fact-contract-new', decision: 'confirm', explicitly_confirmed: true, confirmation_origin: 'explicit_local_user_action' },
      { fact_id: 'fact-imported', decision: 'reject' },
    ]);
  });

  describe('repeat adoption detection', () => {
    const sourceSha256 = 'e'.repeat(64);
    const proposalFact = (suffix: string) => ({
      id: `fact-${suffix}`, claim_id: `claim-${suffix}`, category: 'skill', record_id: `skill-${suffix}`,
      field: 'name', value: `Skill ${suffix}`, status: 'unverified',
      source_anchor: { source_sha256: sourceSha256, line_start: 1 },
    });
    const artifact = { proposal: { facts: [proposalFact('one'), proposalFact('two')] } };
    const rootFact = (suffix: string, decision: string) => ({
      id: `fact-${suffix}`, claimId: `claim-${suffix}`, category: 'skill', recordId: `skill-${suffix}`,
      field: 'name', value: `Skill ${suffix}`, decision,
      provenance: { sourceSha256, anchor: 'line:1', origin: 'imported' },
    });
    const profile = (...claimIds: string[]) => `claims:\n${claimIds.map((id) => `  - id: ${id}\n`).join('')}`;

    it('reads the confirmed claim IDs from the proposal envelope, not the artifact root', () => {
      const facts = [rootFact('one', 'confirmed'), rootFact('two', 'confirmed')];
      expect(selectedClaimIdsAlreadyAdopted(
        artifact, facts as never, profile('claim-one', 'claim-two'),
      )).toEqual(['claim-one', 'claim-two']);
    });

    it('keeps a partial overlap a collision so duplicate protection stays intact', () => {
      const facts = [rootFact('one', 'confirmed'), rootFact('two', 'confirmed')];
      expect(selectedClaimIdsAlreadyAdopted(
        artifact, facts as never, profile('claim-one'),
      )).toBeUndefined();
    });

    it('ignores claims of rejected facts and unrelated profile claims', () => {
      const facts = [rootFact('one', 'confirmed'), rootFact('two', 'rejected')];
      expect(selectedClaimIdsAlreadyAdopted(
        artifact, facts as never, profile('claim-one', 'claim-unrelated'),
      )).toEqual(['claim-one']);
    });

    it('reports no repeat adoption without a confirmed fact or a parsable profile', () => {
      const pending = [rootFact('one', 'pending'), rootFact('two', 'pending')];
      expect(selectedClaimIdsAlreadyAdopted(artifact, pending as never, profile('claim-one'))).toBeUndefined();
      const confirmed = [rootFact('one', 'confirmed'), rootFact('two', 'confirmed')];
      expect(selectedClaimIdsAlreadyAdopted(artifact, confirmed as never, ': not yaml :')).toBeUndefined();
    });
  });

  it('normalizes an edited imported employment detail to the bounded user-fact field', () => {
    const sourceSha256 = 'b'.repeat(64);
    const fact = {
      id: 'fact-user-detail', category: 'employment', recordId: 'experience-one',
      field: 'details[12]', value: 'Improved a synthetic process', decision: 'confirmed',
      provenance: { sourceSha256, anchor: 'user:now', origin: 'user_supplied' },
    } as const;
    expect(cvFactAdditionForContract(fact as never)).toMatchObject({
      id: 'fact-user-detail', collection: 'experience', record_id: 'experience-one',
      field: 'detail', category: 'achievement', value: 'Improved a synthetic process',
    });
  });

  it('validates mapped user facts against versioned submodule capabilities', async () => {
    const repository = resolve(process.cwd(), '..');
    const adapter = new SubmoduleCvNormalizationAdapter(
      resolve(repository, 'integrations', 'bewerbungs-schreib-assistent'),
      resolve(repository, '.local-data', 'profiles', 'candidate-profile.yaml'),
      resolve(repository, '.local-data', 'profiles', 'style-profile.yaml'),
    );
    const provenance = { sourceSha256: 'c'.repeat(64), anchor: 'user:now', origin: 'user_supplied' as const };
    await expect(adapter.validateUserFacts([{
      id: 'fact-user-valid', category: 'employment', recordId: 'experience-one', field: 'details[4]',
      value: 'Improved a synthetic process', decision: 'pending', provenance,
    }])).resolves.toBeUndefined();
    await expect(adapter.validateUserFacts([{
      id: 'fact-user-invalid', category: 'project', recordId: 'project-one', field: 'company',
      value: 'Not a project field', decision: 'pending', provenance,
    }])).rejects.toMatchObject({ statusCode: 400 });
  });

  it('derives stable conflict IDs without exposing conflict content in the identifier', () => {
    const artifact = { extraction: { conflicts: [{
      code: 'ambiguous_employment_role', left_record_id: 'experience-one', right_record_id: 'experience-two',
      detail: 'Same period has two roles',
    }] } };
    const first = conflictsFromArtifact(artifact); const second = conflictsFromArtifact(structuredClone(artifact));
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({ id: expect.stringMatching(/^conflict-[a-f0-9]{16}$/), code: 'ambiguous_employment_role' });
    expect(first[0]!.id).not.toContain('experience');
  });

  it('keeps conflicts fail-closed but recognizes an explicit edited-field choice', () => {
    const sourceSha256 = 'd'.repeat(64);
    const artifact = { proposal: { facts: [
      { id: 'fact-imported', claim_id: 'claim-imported', category: 'employment', record_id: 'experience-one', field: 'role', value: 'Engineer', status: 'unverified', source_anchor: { source_sha256: sourceSha256, line_start: 1 } },
      { id: 'fact-contract-user', claim_id: 'claim-contract-user', category: 'employment', record_id: 'experience-one', field: 'role', value: 'Senior Engineer', status: 'unverified', source_anchor: { origin: 'user_supplied', addition_id: 'fact-user-local', source_sha256: sourceSha256 } },
    ] }, extraction: { conflicts: [{
      code: 'user_supplied_field_conflict', left_fact_id: 'fact-imported', right_fact_id: 'fact-contract-user', detail: 'Choose one role',
    }] } };
    const facts = [
      { id: 'fact-imported', claimId: 'claim-imported', category: 'employment', recordId: 'experience-one', field: 'role', value: 'Engineer', decision: 'rejected', provenance: { sourceSha256, anchor: 'line:1', origin: 'imported' } },
      { id: 'fact-user-local', category: 'employment', recordId: 'experience-one', field: 'role', value: 'Senior Engineer', decision: 'confirmed', provenance: { sourceSha256, anchor: 'user:now', origin: 'user_supplied' } },
    ] as const;
    expect(unresolvedConflictsForDecisions(artifact, facts as never)).toEqual([]);
    const bothConfirmed = facts.map((fact) => ({ ...fact, decision: 'confirmed' as const }));
    expect(unresolvedConflictsForDecisions(artifact, bothConfirmed as never)).toHaveLength(1);

    const malformed = structuredClone(artifact);
    (malformed.extraction.conflicts[0] as Record<string, unknown>).left_fact_id = ['fact-imported'];
    let failure: unknown;
    try { unresolvedConflictsForDecisions(malformed, facts as never); } catch (error) { failure = error; }
    expect(failure).toMatchObject({
      statusCode: 503, errorCode: 'cv_local_dependency_unavailable', stage: 'cv_skill_contract', retryable: true,
    });
    expect(`${(failure as Error).message} ${(failure as { publicDetail?: string }).publicDetail}`).not.toContain('fact-imported');
  });

  it('rejects an out-of-root private profile and a junction escape before reading it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cv-profile-path-'));
    try {
      const profiles = join(root, 'profiles'); const outsideDirectory = join(root, 'outside');
      const outside = join(outsideDirectory, 'candidate-profile.yaml'); const junction = join(profiles, 'escape');
      await mkdir(profiles); await mkdir(outsideDirectory); await writeFile(outside, 'secret: synthetic\n');
      await symlink(outsideDirectory, junction, 'junction');
      const linked = join(junction, 'candidate-profile.yaml');
      await expect(readValidatedPrivateProfile(linked, profiles, 1_024)).rejects.toMatchObject({ statusCode: 503 });
      await expect(readValidatedPrivateProfile(outside, profiles, 1_024)).rejects.toMatchObject({ statusCode: 503 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
