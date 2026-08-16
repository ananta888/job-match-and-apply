import { createHash } from 'node:crypto';
import { access, lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import YAML from 'yaml';
import type {
  CvAdoptionLedgerEntry, CvAdoptionResult, CvAdoptionRevocationResult, CvFact, CvFactCategory,
  CvNormalizationEnvelope, CvNormalizationPort, CvNormalizationConflict, CvProfileSnapshot,
  CvProfileSnapshotRestoreResult,
} from '../ports/cv-normalization.js';
import type {
  CvAiStructuringSelection, CvAiStructuringValidationPort,
} from '../services/cv-ai-structuring.js';
import type {
  CvAiSourceAnchor, CvAiStructuringAlternative, CvAiStructuringSuggestion,
} from '../services/cv-ai-structuring-store.js';
import { buildMinimalLocalChildEnvironment } from '../services/process-environment.js';
import { SafeHttpError, type SafeErrorStage } from '../services/safe-http-error.js';

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const CONTRACT_FACT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Commands that read or mutate the private candidate profile and therefore need the full path proof. */
const CV_PROFILE_COMMANDS = new Set([
  'adopt-confirmed', 'revoke-claims', 'list-adoptions',
  'capture-profile-snapshot', 'list-profile-snapshots', 'restore-profile-snapshot',
]);
const CV_PROFILE_SNAPSHOT_ID = /^profile-snapshot-[a-f0-9]{16}$/;
const CV_PROFILE_TRANSACTION_ID = /^[a-f0-9]{32}$/;
const CONTRACT_FACT_FIELD = /^(?=.{1,64}$)[a-z][a-z0-9_.]*(?:\[[0-9]{1,4}\])?$/;

export interface CvAiRecognitionMaterializationInput {
  baseProposalArtifact: unknown;
  expectedBaseProposalSha256: string;
  /** Adapter-owned bundle returned by validateProposal; raw provider output never crosses this boundary alone. */
  aiProposalArtifact: unknown;
  expectedAiProposalSha256: string;
}

export interface CvAiRecognitionMaterializationResult {
  materializedArtifact: unknown;
  materializedProposalSha256: string;
  /** Complete fact state of the materialized recognition version, including preserved deterministic carve-outs. */
  facts: CvFact[];
  warnings: string[];
  unresolvedConflicts: CvNormalizationConflict[];
  appliedSuggestionIds: string[];
}

/** Narrow adapter to the independently versioned, offline CV import CLI. */
export class SubmoduleCvNormalizationAdapter implements CvNormalizationPort {
  private readonly root: string;
  private readonly candidate: string;
  private readonly style: string;
  private readonly privateProfilesRoot: string;
  private adoptionQueue: Promise<void> = Promise.resolve();
  private capabilitiesPromise?: Promise<Map<string, Set<string>>>;
  private aiContractPromise?: ReturnType<SubmoduleCvNormalizationAdapter['loadAiContract']>;

  constructor(skillRoot: string, candidateProfilePath: string, styleProfilePath: string) {
    this.root = resolve(skillRoot);
    this.candidate = resolve(candidateProfilePath);
    this.style = resolve(styleProfilePath);
    this.privateProfilesRoot = resolve(this.root, '..', '..', '.local-data', 'profiles');
  }

  async normalize(envelope: CvNormalizationEnvelope) {
    const contractEnvelope = {
        contract: 'extracted-cv-text', contract_version: '1.0',
        source: { sha256: envelope.source.sha256, byte_size: envelope.source.byteSize, media_type: envelope.source.mimeType },
        extraction: {
          engine: 'job-match-and-apply-local-passive-extractor/1.0', text: envelope.extractedText,
          text_sha256: sha256(envelope.extractedText), warnings: envelope.warnings,
        },
      };
    const artifact = await this.run(
      ['normalize-extracted', '--extracted-envelope', '-', '--output', '-'], JSON.stringify(contractEnvelope),
    );
    return {
      facts: factsFromArtifact(artifact), warnings: warningsFromArtifact(artifact),
      conflicts: conflictsFromArtifact(artifact), artifact,
    };
  }

  async validateUserFacts(facts: CvFact[]): Promise<void> {
    if (facts.some((fact) => fact.provenance.origin !== 'user_supplied')) {
      invalidUserFact('Nur explizit hinzugefuegte Nutzerfakten duerfen gegen diesen Vertrag geprueft werden.');
    }
    const capabilities = await this.userFactCapabilities();
    for (const fact of facts) {
      const addition = cvFactAdditionForContract(fact);
      if (!capabilities.get(addition.collection)?.has(addition.field)) {
        invalidUserFact(`Feld ${fact.category}.${fact.field} wird vom versionierten CV-Skillvertrag nicht unterstuetzt.`);
      }
    }
  }

  contract(): ReturnType<CvAiStructuringValidationPort['contract']> {
    this.aiContractPromise ??= this.loadAiContract().catch((error) => {
      this.aiContractPromise = undefined;
      throw error;
    });
    return this.aiContractPromise;
  }

  async validateProposal(
    input: Parameters<CvAiStructuringValidationPort['validateProposal']>[0],
  ): ReturnType<CvAiStructuringValidationPort['validateProposal']> {
    if (!isRecord(input.baseProposalArtifact) || !isRecord(input.aiProposal)
      || !/^[a-f0-9]{64}$/.test(input.expectedBaseProposalSha256)) {
      dependencyError('AI-CV-Validierung erhielt keine gebundene Basis oder kein strukturiertes Providerobjekt.');
    }
    const request = {
      contract: 'ai-cv-structure-validation-request', contract_version: '1.0',
      base_proposal: input.baseProposalArtifact,
      expected_proposal_sha256: input.expectedBaseProposalSha256,
      ai_proposal: input.aiProposal,
    };
    const validated = await this.run(['validate-ai-structure', '--request', '-'], JSON.stringify(request));
    const result = validatedAiProposal(validated);
    const proposalSha256 = sha256(canonicalJson(input.aiProposal));
    return {
      ...result,
      proposalSha256,
      privateArtifact: {
        contract: 'cv-ai-private-proposal', contractVersion: '1.0', proposalSha256,
        aiProposal: structuredClone(input.aiProposal),
      },
    };
  }

  async applySelections(
    input: Parameters<CvAiStructuringValidationPort['applySelections']>[0],
  ): ReturnType<CvAiStructuringValidationPort['applySelections']> {
    if (!isRecord(input.baseProposalArtifact) || !isRecord(input.aiProposalArtifact)
      || input.aiProposalArtifact.contract !== 'cv-ai-private-proposal'
      || input.aiProposalArtifact.contractVersion !== '1.0'
      || !isRecord(input.aiProposalArtifact.aiProposal)
      || input.aiProposalArtifact.proposalSha256 !== input.expectedAiProposalSha256
      || sha256(canonicalJson(input.aiProposalArtifact.aiProposal)) !== input.expectedAiProposalSha256
      || !/^[a-f0-9]{64}$/.test(input.expectedBaseProposalSha256)) {
      dependencyError('Gespeicherter AI-CV-Vorschlag ist nicht mehr exakt an Basis und Providerantwort gebunden.');
    }
    const selections = input.selections.map((selection: CvAiStructuringSelection) => ({
      suggestion_id: selection.suggestionId, alternative_id: selection.alternativeId,
    }));
    const request = {
      contract: 'ai-cv-structure-apply-request', contract_version: '1.0',
      base_proposal: input.baseProposalArtifact,
      expected_proposal_sha256: input.expectedBaseProposalSha256,
      ai_proposal: input.aiProposalArtifact.aiProposal,
      selections,
    };
    const mergedArtifact = await this.run(
      ['apply-ai-structure', '--request', '-', '--output', '-'], JSON.stringify(request),
    );
    const baseFactIds = new Set(factsFromArtifact(input.baseProposalArtifact).map((fact) => fact.id));
    const facts = factsFromArtifact(mergedArtifact).filter((fact) => !baseFactIds.has(fact.id));
    if (facts.length !== input.selections.length) {
      dependencyError('AI-CV-Merge lieferte nicht exakt einen neuen atomaren Fakt pro Auswahl.');
    }
    return {
      mergedArtifact,
      mergedProposalSha256: sha256(canonicalJson(mergedArtifact)),
      facts,
      appliedSuggestionIds: input.selections.map((selection) => selection.suggestionId),
    };
  }

  async materializeRecognitionVersion(
    input: CvAiRecognitionMaterializationInput,
  ): Promise<CvAiRecognitionMaterializationResult> {
    // A direct caller must not bypass the versioned capability and schema checks normally run at AI-start time.
    await this.contract();
    const aiProposal = privateAiProposal(
      input.aiProposalArtifact, input.expectedAiProposalSha256,
    );
    if (!isRecord(input.baseProposalArtifact)
      || !/^[a-f0-9]{64}$/.test(input.expectedBaseProposalSha256)) {
      dependencyError('AI-CV-Materialisierung erhielt keine gebundene Basis.');
    }
    const request = {
      contract: 'ai-cv-structure-materialization-request', contract_version: '1.0',
      base_proposal: input.baseProposalArtifact,
      expected_proposal_sha256: input.expectedBaseProposalSha256,
      ai_proposal: aiProposal,
    };
    const materializedArtifact = await this.run(
      ['materialize-ai-structure', '--request', '-', '--output', '-'], JSON.stringify(request),
    );
    const appliedSuggestionIds = materializationSuggestionIds(
      materializedArtifact, input.expectedBaseProposalSha256, aiProposal,
    );
    const facts = factsFromArtifact(materializedArtifact);
    const aiSuggestionIds = facts
      .filter((fact) => fact.provenance.recognition?.method === 'ai_assisted')
      .map((fact) => fact.provenance.recognition!.suggestionId);
    if (aiSuggestionIds.length < 1 || aiSuggestionIds.some((id) => id === undefined)
      || new Set(aiSuggestionIds).size !== aiSuggestionIds.length
      || aiSuggestionIds.length !== appliedSuggestionIds.length
      || aiSuggestionIds.some((id) => !appliedSuggestionIds.includes(id!))) {
      dependencyError('AI-CV-Materialisierung lieferte keinen vollstaendig gebundenen Erkennungsstand.');
    }
    return {
      materializedArtifact,
      materializedProposalSha256: sha256(canonicalJson(materializedArtifact)),
      facts,
      warnings: warningsFromArtifact(materializedArtifact),
      unresolvedConflicts: conflictsFromArtifact(materializedArtifact),
      appliedSuggestionIds,
    };
  }

  adopt(input: Parameters<CvNormalizationPort['adopt']>[0]): Promise<CvAdoptionResult> {
    const operation = this.adoptionQueue.then(() => this.adoptOnce(input));
    this.adoptionQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async adoptOnce(input: Parameters<CvNormalizationPort['adopt']>[0]): Promise<CvAdoptionResult> {
    if (!input.artifact || typeof input.artifact !== 'object') dependencyError('CV-Importvorschlag fehlt.');
    const profiles = await Promise.all([
      readValidatedPrivateProfile(this.candidate, this.privateProfilesRoot, 2 * 1024 * 1024),
      readValidatedPrivateProfile(this.style, this.privateProfilesRoot, 2 * 1024 * 1024),
    ]);
    const candidateProfile = profiles[0]!;
    const temporary = await mkdtemp(join(tmpdir(), 'job-match-cv-adopt-'));
    try {
      const proposal = join(temporary, 'proposal.yaml'); const decisions = join(temporary, 'decisions.json');
      const additions = input.facts.filter((fact) => fact.provenance.origin === 'user_supplied');
      let artifact = input.artifact as Record<string, unknown>;
      if (additions.length > 0) {
        const additionsPath = join(temporary, 'additions.json'); const extendedPath = join(temporary, 'extended.yaml');
        await writeFile(proposal, YAML.stringify(artifact), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await writeFile(additionsPath, JSON.stringify(additions.map(cvFactAdditionForContract)), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await this.run([
          'extend-user-facts', '--proposal', proposal, '--additions', additionsPath,
          '--expected-proposal-sha256', sha256(canonicalJson(artifact)), '--output', extendedPath,
        ]);
        artifact = YAML.parse(await readFile(extendedPath, 'utf8')) as Record<string, unknown>;
      }
      const unresolved = unresolvedConflictsForDecisions(artifact, input.facts);
      if (unresolved.length > 0) {
        unresolvedConflict(`CV-Import enthält ${unresolved.length} ungelöste Faktenkonflikte. Bitte die CV-Quelle korrigieren und neu importieren.`);
      }
      await rm(proposal, { force: true });
      const expectedCandidateSha256 = sha256(candidateProfile.bytes);
      await writeFile(proposal, YAML.stringify(artifact), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await writeFile(decisions, JSON.stringify(mapCvAdoptionDecisions(input.facts, artifact)), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      let raw: Record<string, unknown>;
      try {
        raw = await this.run([
          'adopt-confirmed', '--proposal', proposal, '--candidate', candidateProfile.canonicalPath,
          '--decisions', decisions, '--expected-candidate-sha256', expectedCandidateSha256,
        ]);
      } catch (error) {
        // Idempotent re-adoption: the contract refuses when a confirmed claim is
        // already present, which permanently blocks an import whose claims were
        // adopted earlier. Only when *every* selected claim is already in the
        // profile is this a repeat of the same adoption — report it as already
        // adopted instead of failing. Any partial overlap stays a hard conflict,
        // so the duplicate protection is unchanged.
        const alreadyAdopted = error instanceof SafeHttpError && error.errorCode === 'claim_collision'
          ? selectedClaimIdsAlreadyAdopted(artifact, input.facts, candidateProfile.bytes)
          : undefined;
        if (!alreadyAdopted) throw error;
        return {
          contract: 'cv-profile-adoption', contractVersion: '1.0',
          adoptedClaimIds: alreadyAdopted, adoptedRecordIds: [],
          candidateProfileSha256: expectedCandidateSha256,
          candidateProfileRevision: `sha256:${expectedCandidateSha256}`,
          alreadyAdopted: true,
        };
      }
      const adoptedClaimIds = stringArray(raw.adopted_claim_ids);
      const candidateProfileSha256 = String(raw.candidate_sha256 ?? '');
      if (!/^[a-f0-9]{64}$/.test(candidateProfileSha256)) dependencyError('CV-Adopt lieferte keinen CandidateProfile-Hash.');
      return {
        contract: 'cv-profile-adoption', contractVersion: '1.0', adoptedClaimIds,
        adoptedRecordIds: stringArray(raw.adopted_record_ids), candidateProfileSha256,
        candidateProfileRevision: `sha256:${candidateProfileSha256}`,
        ...(typeof raw.transaction_id === 'string' && CV_PROFILE_TRANSACTION_ID.test(raw.transaction_id)
          ? { transactionId: raw.transaction_id } : {}),
        ...(typeof raw.replaced_snapshot_id === 'string' && CV_PROFILE_SNAPSHOT_ID.test(raw.replaced_snapshot_id)
          ? { replacedSnapshotId: raw.replaced_snapshot_id } : {}),
      };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  async adoptionLedger(): Promise<{ candidateProfileSha256: string; adoptions: CvAdoptionLedgerEntry[] }> {
    const candidateProfile = await readValidatedPrivateProfile(this.candidate, this.privateProfilesRoot, 2 * 1024 * 1024);
    const raw = await this.run(['list-adoptions', '--candidate', candidateProfile.canonicalPath]);
    const candidateProfileSha256 = String(raw.candidate_sha256 ?? '');
    if (!/^[a-f0-9]{64}$/.test(candidateProfileSha256)) {
      dependencyError('CV-Uebernahmeliste lieferte keinen CandidateProfile-Hash.');
    }
    const items = Array.isArray(raw.adoptions) ? raw.adoptions : [];
    return { candidateProfileSha256, adoptions: items.map((item) => adoptionLedgerEntry(item)) };
  }

  revokeAdoption(input: { transactionId: string }): Promise<CvAdoptionRevocationResult> {
    const operation = this.adoptionQueue.then(() => this.revokeAdoptionOnce(input));
    this.adoptionQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async revokeAdoptionOnce(input: { transactionId: string }): Promise<CvAdoptionRevocationResult> {
    if (!CV_PROFILE_TRANSACTION_ID.test(input.transactionId)) {
      invalidProfileRequest('Die Übernahme-Transaktion ist kein gültiger Vertragsbezeichner.');
    }
    const candidateProfile = await readValidatedPrivateProfile(this.candidate, this.privateProfilesRoot, 2 * 1024 * 1024);
    const raw = await this.run([
      'revoke-claims', '--candidate', candidateProfile.canonicalPath,
      '--transaction-id', input.transactionId,
      '--expected-candidate-sha256', sha256(candidateProfile.bytes),
    ]);
    const candidateProfileSha256 = String(raw.candidate_sha256 ?? '');
    if (!/^[a-f0-9]{64}$/.test(candidateProfileSha256)) {
      dependencyError('CV-Revoke lieferte keinen CandidateProfile-Hash.');
    }
    return {
      contract: 'cv-profile-adoption-revocation', contractVersion: '1.0',
      revokedTransactionId: input.transactionId,
      revokedClaimIds: stringArray(raw.revoked_claim_ids),
      revokedRecordIds: stringArray(raw.revoked_record_ids),
      candidateProfileSha256, candidateProfileRevision: `sha256:${candidateProfileSha256}`,
      ...(typeof raw.replaced_snapshot_id === 'string' ? { replacedSnapshotId: raw.replaced_snapshot_id } : {}),
      ...(typeof raw.rollback_snapshot_id === 'string' ? { rollbackSnapshotId: raw.rollback_snapshot_id } : {}),
      ...(raw.status === 'no_revocable_claims' ? { alreadyRevoked: true as const } : {}),
    };
  }

  async profileSnapshots(): Promise<{ candidateProfileSha256: string; snapshots: CvProfileSnapshot[] }> {
    const candidateProfile = await readValidatedPrivateProfile(this.candidate, this.privateProfilesRoot, 2 * 1024 * 1024);
    const raw = await this.run(['list-profile-snapshots', '--candidate', candidateProfile.canonicalPath]);
    const candidateProfileSha256 = String(raw.candidate_sha256 ?? '');
    if (!/^[a-f0-9]{64}$/.test(candidateProfileSha256)) {
      dependencyError('CV-Snapshotliste lieferte keinen CandidateProfile-Hash.');
    }
    const items = Array.isArray(raw.snapshots) ? raw.snapshots : [];
    return { candidateProfileSha256, snapshots: items.map((item) => profileSnapshot(item)) };
  }

  restoreProfileSnapshot(input: { snapshotId: string }): Promise<CvProfileSnapshotRestoreResult> {
    const operation = this.adoptionQueue.then(() => this.restoreProfileSnapshotOnce(input));
    this.adoptionQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async restoreProfileSnapshotOnce(input: { snapshotId: string }): Promise<CvProfileSnapshotRestoreResult> {
    if (!CV_PROFILE_SNAPSHOT_ID.test(input.snapshotId)) {
      invalidProfileRequest('Der Profilstand ist kein gültiger Vertragsbezeichner.');
    }
    const candidateProfile = await readValidatedPrivateProfile(this.candidate, this.privateProfilesRoot, 2 * 1024 * 1024);
    const raw = await this.run([
      'restore-profile-snapshot', '--candidate', candidateProfile.canonicalPath,
      '--snapshot-id', input.snapshotId,
      '--expected-candidate-sha256', sha256(candidateProfile.bytes),
    ]);
    const candidateProfileSha256 = String(raw.candidate_sha256 ?? '');
    if (!/^[a-f0-9]{64}$/.test(candidateProfileSha256)) {
      dependencyError('CV-Snapshotwiederherstellung lieferte keinen CandidateProfile-Hash.');
    }
    return {
      contract: 'cv-profile-snapshot-restore', contractVersion: '1.0',
      snapshotId: input.snapshotId,
      candidateProfileSha256, candidateProfileRevision: `sha256:${candidateProfileSha256}`,
      ...(typeof raw.replaced_snapshot_id === 'string' ? { replacedSnapshotId: raw.replaced_snapshot_id } : {}),
      ...(raw.status === 'profile_already_at_snapshot' ? { alreadyRestored: true as const } : {}),
    };
  }

  private userFactCapabilities(): Promise<Map<string, Set<string>>> {
    this.capabilitiesPromise ??= this.loadUserFactCapabilities().catch((error) => {
      this.capabilitiesPromise = undefined;
      throw error;
    });
    return this.capabilitiesPromise;
  }

  private async loadAiContract() {
    const capabilities = await this.run(['capabilities']);
    const ai = isRecord(capabilities.ai_structuring) ? capabilities.ai_structuring : undefined;
    if (capabilities.contract !== 'cv-import-proposal' || capabilities.contract_version !== '1.0'
      || !Array.isArray(capabilities.commands) || !capabilities.commands.includes('materialize-ai-structure')
      || ai?.contract !== 'ai-cv-structure-proposal' || ai.contract_version !== '1.0'
      || ai.validation_request_contract !== 'ai-cv-structure-validation-request'
      || ai.apply_request_contract !== 'ai-cv-structure-apply-request'
      || ai.materialization_request_contract !== 'ai-cv-structure-materialization-request'
      || ai.materialization_request_schema !== 'contracts/v1/ai-cv-structure-materialization-request.schema.json'
      || ai.materialization_output_contract !== 'cv-import-proposal'
      || ai.materialization_output_contract_version !== '1.0'
      || ai.materialization_mode !== 'replace_recognition_version'
      || ai.materialization_selection_policy !== 'all_mergeable_non_null_primary'
      || ai.max_materialized_facts !== 2_000
      || !Array.isArray(ai.preserved_deterministic_scopes)
      || ai.preserved_deterministic_scopes.length !== 2
      || ai.preserved_deterministic_scopes[0] !== 'profile'
      || ai.preserved_deterministic_scopes[1] !== 'certifications'
      || ai.validated_contract !== 'validated-ai-cv-structure-proposal'
      || ai.line_manifest_private !== true || ai.network_access !== false
      || !Array.isArray(ai.statuses) || ai.statuses.length !== 1 || ai.statuses[0] !== 'unverified'
      || ai.schema !== 'contracts/v1/ai-cv-structure-proposal.schema.json') {
      dependencyError('Der lokale CV-Skill stellt keinen kompatiblen AI-Strukturvertrag bereit.');
    }
    const schemaPath = resolve(this.root, String(ai.schema));
    if (!within(this.root, schemaPath)) dependencyError('AI-CV-Schema verlaesst den Submodulpfad.');
    await assertRegularFile(schemaPath, 512 * 1024);
    const canonicalRoot = await realpath(this.root); const canonicalSchema = await realpath(schemaPath);
    if (!within(canonicalRoot, canonicalSchema)) dependencyError('AI-CV-Schema verlaesst den kanonischen Submodulpfad.');
    let schema: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await readFile(canonicalSchema, 'utf8'));
      if (!isRecord(parsed)) throw new Error('not_object');
      schema = parsed;
    } catch { dependencyError('AI-CV-Schema ist kein gueltiges JSON-Objekt.'); }
    const properties = isRecord(schema.properties) ? schema.properties : undefined;
    const contractProperty = properties && isRecord(properties.contract) ? properties.contract : undefined;
    if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema'
      || schema.type !== 'object' || schema.additionalProperties !== false
      || contractProperty?.const !== 'ai-cv-structure-proposal') {
      dependencyError('AI-CV-Schema entspricht nicht dem erwarteten geschlossenen Vertrag.');
    }
    const materializationSchemaPath = resolve(this.root, String(ai.materialization_request_schema));
    if (!within(this.root, materializationSchemaPath)) {
      dependencyError('AI-CV-Materialisierungsschema verlaesst den Submodulpfad.');
    }
    await assertRegularFile(materializationSchemaPath, 512 * 1024);
    const canonicalMaterializationSchema = await realpath(materializationSchemaPath);
    if (!within(canonicalRoot, canonicalMaterializationSchema)) {
      dependencyError('AI-CV-Materialisierungsschema verlaesst den kanonischen Submodulpfad.');
    }
    let materializationSchema: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await readFile(canonicalMaterializationSchema, 'utf8'));
      if (!isRecord(parsed)) throw new Error('not_object');
      materializationSchema = parsed;
    } catch { dependencyError('AI-CV-Materialisierungsschema ist kein gueltiges JSON-Objekt.'); }
    const materializationProperties = isRecord(materializationSchema.properties)
      ? materializationSchema.properties : undefined;
    const materializationContract = materializationProperties && isRecord(materializationProperties.contract)
      ? materializationProperties.contract : undefined;
    const materializationVersion = materializationProperties && isRecord(materializationProperties.contract_version)
      ? materializationProperties.contract_version : undefined;
    const materializationBase = materializationProperties && isRecord(materializationProperties.base_proposal)
      ? materializationProperties.base_proposal : undefined;
    const materializationDigest = materializationProperties && isRecord(materializationProperties.expected_proposal_sha256)
      ? materializationProperties.expected_proposal_sha256 : undefined;
    const materializationAiProposal = materializationProperties && isRecord(materializationProperties.ai_proposal)
      ? materializationProperties.ai_proposal : undefined;
    const materializationKeys = [
      'contract', 'contract_version', 'base_proposal', 'expected_proposal_sha256', 'ai_proposal',
    ];
    const materializationRequired = Array.isArray(materializationSchema.required)
      ? materializationSchema.required : undefined;
    if (materializationSchema.$schema !== 'https://json-schema.org/draft/2020-12/schema'
      || materializationSchema.type !== 'object' || materializationSchema.additionalProperties !== false
      || !materializationProperties || !exactKeys(materializationProperties, materializationKeys)
      || !materializationRequired || materializationRequired.length !== materializationKeys.length
      || materializationKeys.some((key) => !materializationRequired.includes(key))
      || materializationContract?.const !== 'ai-cv-structure-materialization-request'
      || materializationVersion?.const !== '1.0' || materializationBase?.type !== 'object'
      || materializationDigest?.type !== 'string' || materializationDigest.pattern !== '^[a-f0-9]{64}$'
      || materializationAiProposal?.$ref !== 'ai-cv-structure-proposal.schema.json') {
      dependencyError('AI-CV-Materialisierungsschema entspricht nicht dem erwarteten geschlossenen Vertrag.');
    }
    const outputSchemaJson = canonicalJson(schema);
    return {
      outputContract: 'ai-cv-structure-proposal' as const,
      outputContractVersion: '1.0' as const,
      outputSchemaJson,
      outputSchemaSha256: sha256(outputSchemaJson),
    };
  }

  private async loadUserFactCapabilities() {
    const raw = await this.run(['capabilities']);
    const value = raw.user_fact_fields;
    if (raw.contract !== 'cv-import-proposal' || raw.contract_version !== '1.0'
      || !value || typeof value !== 'object' || Array.isArray(value)) {
      dependencyError('Der CV-Skill lieferte keine gueltigen versionierten Nutzerfakt-Capabilities.');
    }
    const result = new Map<string, Set<string>>();
    for (const [collection, fields] of Object.entries(value as Record<string, unknown>)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(collection) || !Array.isArray(fields) || fields.length > 100
        || fields.some((field) => typeof field !== 'string' || !/^[a-z][a-z0-9_.]{0,63}$/.test(field))) {
        dependencyError('Der CV-Skill lieferte ungueltige Nutzerfakt-Capabilities.');
      }
      result.set(collection, new Set(fields as string[]));
    }
    for (const required of ['profile', 'experience', 'projects', 'education', 'certifications', 'skills', 'languages', 'additional_facts']) {
      if (!result.has(required)) dependencyError('Der CV-Skillvertrag ist fuer Nutzerfakten unvollstaendig.');
    }
    return result;
  }

  private async run(args: string[], stdin?: string): Promise<Record<string, unknown>> {
    const script = resolve(this.root, 'scripts', 'cv_import_contract.py');
    if (!within(this.root, script) || !within(this.privateProfilesRoot, this.candidate)
      || !within(this.privateProfilesRoot, this.style) || basename(this.candidate) !== 'candidate-profile.yaml'
      || basename(this.style) !== 'style-profile.yaml') {
      dependencyError('CV-Skillpfade liegen außerhalb des konfigurierten privaten Profils oder Submoduls.');
    }
    try { await access(script, constants.R_OK); }
    catch { dependencyError('Der Bewerbungsassistent stellt den CV-Importvertrag noch nicht bereit.'); }
    await assertRegularFile(script, 2 * 1024 * 1024);
    const canonicalRoot = await realpath(this.root); const canonicalScript = await realpath(script);
    if (!within(canonicalRoot, canonicalScript)) dependencyError('CV-Skillskript verlässt den kanonischen Submodulpfad.');
    if (CV_PROFILE_COMMANDS.has(String(args[0] ?? ''))) {
      await Promise.all([assertRegularFile(this.candidate, 2 * 1024 * 1024), assertRegularFile(this.style, 2 * 1024 * 1024)]);
      const canonicalProfiles = await realpath(this.privateProfilesRoot);
      if (!within(canonicalProfiles, await realpath(this.candidate)) || !within(canonicalProfiles, await realpath(this.style))) {
        dependencyError('Private Profile verlassen den kanonischen Profilpfad.');
      }
    }
    try {
      const result = await new Promise<{ stdout: string; exitCode: number | null }>((resolveOutput, rejectOutput) => {
        const child = spawn(process.env.PYTHON_EXECUTABLE || 'python', [script, ...args], {
          cwd: this.root, env: cvContractChildEnvironment(), windowsHide: true, shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const out: Buffer[] = []; let outBytes = 0;
        const timer = setTimeout(() => {
          child.kill();
          rejectOutput(cvDependencyFailure(
            'cv_skill_timeout', 'Der lokale CV-Skillprozess hat das Zeitlimit überschritten.',
          ));
        }, 120_000);
        child.stdout.on('data', (chunk: Buffer) => {
          outBytes += chunk.length;
          if (outBytes > 4 * 1024 * 1024) {
            child.kill();
            rejectOutput(cvDependencyFailure(
              'cv_skill_output_limit', 'Der lokale CV-Skillprozess hat die sichere Ausgabegrenze überschritten.',
            ));
            return;
          }
          out.push(Buffer.from(chunk));
        });
        // Drain stderr to avoid blocking the child, but never retain or reflect it.
        child.stderr.resume();
        child.on('error', () => {
          clearTimeout(timer);
          rejectOutput(cvDependencyFailure(
            'cv_skill_process_unavailable',
            'Der lokale CV-Skillprozess konnte nicht gestartet werden. Prüfe die lokale Python- und Submodule-Installation.',
          ));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolveOutput({ stdout: Buffer.concat(out).toString('utf8'), exitCode: code });
        });
        child.stdin.end(stdin ?? '');
      });
      let parsed: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(result.stdout);
        if (!isRecord(value)) throw new Error('cv_skill_response_not_object');
        parsed = value;
      } catch {
        throw cvDependencyFailure(
          'cv_skill_protocol_error', 'Der lokale CV-Skillvertrag lieferte keine gültige strukturierte Antwort.',
        );
      }
      if (parsed.status === 'rejected') throw classifyCvContractRejection(String(args[0] ?? ''), parsed);
      if (result.exitCode !== 0) {
        throw cvDependencyFailure('cv_skill_process_failed', 'Der lokale CV-Skillprozess wurde unerwartet beendet.');
      }
      return parsed;
    } catch (error) {
      if (error instanceof SafeHttpError) throw error;
      throw cvDependencyFailure('cv_skill_process_failed', 'Der lokale CV-Skillprozess ist fehlgeschlagen.');
    }
  }
}

/** The JSON stdin/stdout contract is UTF-8 regardless of the host locale or inherited Python flags. */
export function cvContractChildEnvironment(host: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...buildMinimalLocalChildEnvironment(host),
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
}

const CV_CONTRACT_REJECTION_CODES = new Set([
  'active_content', 'archive_limit', 'candidate_unreadable', 'candidate_validation_failed',
  'ai_binding_mismatch', 'ai_materialization_no_usable_facts', 'ai_materialization_too_large',
  'cas_mismatch', 'claim_collision', 'confirmation_required',
  'conflicting_ai_structure', 'digest_mismatch',
  'external_relationship', 'extracted_text_too_large', 'extraction_failed',
  'extractor_unavailable', 'input_empty', 'input_too_large', 'input_unreadable',
  'invalid_additions', 'invalid_ai_merge', 'invalid_ai_status', 'invalid_ai_structure',
  'invalid_archive', 'invalid_decisions', 'invalid_encoding', 'invalid_envelope',
  'invalid_proposal', 'invalid_request', 'invalid_selection', 'invalid_xml',
  'line_manifest_required', 'no_text', 'out_of_source_value',
  'normalization_failed', 'recovery_required', 'type_mismatch', 'unsafe_archive_path',
  'unsupported_source_span', 'unsupported_type',
  'already_revoked', 'invalid_snapshot', 'invalid_transaction', 'snapshot_corrupted',
  'snapshot_invalid', 'snapshot_too_large', 'snapshot_unreadable', 'snapshot_write_failed',
  'unknown_snapshot', 'unknown_transaction',
]);

const CV_CONTRACT_BAD_REQUEST_CODES = new Set([
  'digest_mismatch', 'invalid_additions', 'invalid_decisions', 'invalid_envelope', 'invalid_proposal',
  'invalid_snapshot', 'invalid_transaction',
]);


const CV_CONTRACT_CONFLICT_CODES = new Set([
  'cas_mismatch', 'claim_collision', 'confirmation_required', 'already_revoked',
  'unknown_snapshot', 'unknown_transaction',
]);

const CV_CONTRACT_DEPENDENCY_CODES = new Set([
  'candidate_unreadable', 'extractor_unavailable', 'recovery_required',
  'snapshot_corrupted', 'snapshot_unreadable', 'snapshot_write_failed',
]);

/** Convert only closed, versioned contract codes to a public failure. Upstream detail is ignored. */
export function classifyCvContractRejection(command: string, payload: Record<string, unknown>): SafeHttpError {
  const rejected = isRecord(payload.error) ? payload.error : undefined;
  const code = typeof rejected?.code === 'string' ? rejected.code : '';
  if (!CV_CONTRACT_REJECTION_CODES.has(code)) {
    return cvDependencyFailure(
      'cv_skill_protocol_error', 'Der lokale CV-Skillvertrag lieferte eine unbekannte Ablehnung.',
    );
  }
  const stage = cvContractStage(command);
  if (command === 'normalize-extracted' && code === 'digest_mismatch') {
    return new SafeHttpError({
      statusCode: 503, errorCode: code, stage, retryable: true,
      publicDetail: 'Der lokale CV-Importvertrag konnte die serverseitige Textbindung nicht bestätigen.',
    });
  }
  if (CV_CONTRACT_DEPENDENCY_CODES.has(code)) {
    return new SafeHttpError({
      statusCode: 503, errorCode: code, stage, retryable: true,
      publicDetail: 'Eine benötigte lokale CV-Abhängigkeit ist nicht verfügbar oder nicht sicher lesbar.',
    });
  }
  const statusCode = CV_CONTRACT_BAD_REQUEST_CODES.has(code)
    ? 400
    : CV_CONTRACT_CONFLICT_CODES.has(code)
      ? 409
      : 422;
  return new SafeHttpError({
    statusCode, errorCode: code, stage, retryable: false, publicDetail: cvContractPublicDetail(code),
  });
}

function cvContractStage(command: string): SafeErrorStage {
  if (command === 'normalize-extracted') return 'cv_import_normalization';
  if (command === 'extend-user-facts' || command === 'capabilities') return 'cv_fact_validation';
  if (command === 'adopt-confirmed' || command === 'revoke-claims'
    || command === 'capture-profile-snapshot' || command === 'list-profile-snapshots'
    || command === 'restore-profile-snapshot') {
    return 'cv_profile_adoption';
  }
  return 'cv_skill_contract';
}

function cvContractPublicDetail(code: string): string {
  if (code === 'normalization_failed') {
    return 'Der Lebenslauf konnte nicht eindeutig in atomare Fakten überführt werden. Prüfe doppelte oder widersprüchliche Angaben.';
  }
  if (code === 'input_empty' || code === 'no_text') {
    return 'In der Datei wurde kein lesbarer Lebenslauftext gefunden.';
  }
  if (code === 'input_too_large' || code === 'extracted_text_too_large' || code === 'archive_limit') {
    return 'Der Lebenslauf überschreitet eine sichere Verarbeitungsgrenze.';
  }
  if (code === 'active_content' || code === 'external_relationship' || code === 'unsafe_archive_path') {
    return 'Die Datei enthält nicht zulässige aktive, externe oder unsichere Inhalte.';
  }
  if (['invalid_archive', 'invalid_encoding', 'invalid_xml', 'type_mismatch', 'unsupported_type'].includes(code)) {
    return 'Die Datei entspricht nicht dem ausgewählten unterstützten Lebenslaufformat.';
  }
  if (code === 'extraction_failed') {
    return 'Aus der Datei konnte kein verlässlich prüfbarer Lebenslauftext extrahiert werden.';
  }
  if (code === 'candidate_validation_failed') {
    return 'Die bestätigten Lebenslauffakten verletzen den aktiven Kandidatenprofilvertrag.';
  }
  if (['ai_binding_mismatch', 'conflicting_ai_structure', 'invalid_ai_merge', 'invalid_ai_status',
    'invalid_ai_structure', 'invalid_request', 'invalid_selection', 'line_manifest_required',
    'out_of_source_value', 'unsupported_source_span', 'ai_materialization_no_usable_facts',
    'ai_materialization_too_large'].includes(code)) {
    return 'Der KI-Strukturvorschlag ist nicht exakt an die importierte CV-Quelle und den versionierten Vertrag gebunden.';
  }
  if (code === 'claim_collision') {
    return 'Diese bestätigten Fakten sind bereits als Claims im Kandidatenprofil vorhanden; eine erneute Übernahme würde Dubletten erzeugen. Entferne die betroffenen Claims im Kandidatenprofil, wenn du sie aus diesem Import neu übernehmen willst.';
  }
  if (CV_CONTRACT_CONFLICT_CODES.has(code)) {
    return 'Der CV-Zustand hat sich geändert oder steht mit bereits bestätigten Fakten in Konflikt. Lade den aktuellen Stand neu.';
  }
  if (CV_CONTRACT_BAD_REQUEST_CODES.has(code)) {
    return 'Die CV-Fakten oder ihre Prüfbindung entsprechen nicht dem erwarteten Vertrag.';
  }
  return 'Der Lebenslauf wurde durch eine sichere Inhaltsprüfung abgelehnt.';
}

function cvDependencyFailure(errorCode: string, publicDetail: string): SafeHttpError {
  return new SafeHttpError({
    statusCode: 503, errorCode, stage: 'cv_skill_contract', publicDetail, retryable: true,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function aiAnchor(value: unknown): CvAiSourceAnchor {
  if (!isRecord(value) || !exactKeys(value, ['line_start', 'line_end', 'char_start', 'char_end', 'quote'])
    || !Number.isSafeInteger(value.line_start) || (value.line_start as number) < 1
    || !Number.isSafeInteger(value.line_end) || (value.line_end as number) < (value.line_start as number)
    || !Number.isSafeInteger(value.char_start) || (value.char_start as number) < 0
    || !Number.isSafeInteger(value.char_end) || (value.char_end as number) < 1
    || typeof value.quote !== 'string' || value.quote.length < 1 || value.quote.length > 8_000) {
    dependencyError('Validierter AI-CV-Vorschlag enthaelt einen ungueltigen Quellenanker.');
  }
  return {
    lineStart: value.line_start as number, lineEnd: value.line_end as number,
    charStart: value.char_start as number, charEnd: value.char_end as number, quote: value.quote as string,
  };
}

function aiAlternative(value: unknown): CvAiStructuringAlternative {
  if (!isRecord(value) || !exactKeys(value, ['id', 'value', 'source_anchor', 'confidence'])
    || typeof value.id !== 'string' || !/^alternative-[a-f0-9]{16}$/.test(value.id)
    || typeof value.value !== 'string' || value.value.length < 1 || value.value.length > 20_000
    || typeof value.confidence !== 'number' || !Number.isFinite(value.confidence)
    || value.confidence < 0 || value.confidence > 1) {
    dependencyError('Validierter AI-CV-Vorschlag enthaelt eine ungueltige Alternative.');
  }
  return { id: value.id, value: value.value, sourceAnchor: aiAnchor(value.source_anchor), confidence: value.confidence };
}

function aiSuggestion(value: unknown): CvAiStructuringSuggestion {
  const baseKeys = [
    'id', 'path', 'collection', 'record_id', 'field', 'category', 'mergeable', 'value',
    'source_anchor', 'confidence', 'alternatives', 'questions', 'status',
  ];
  if (!isRecord(value) || (!exactKeys(value, baseKeys) && !exactKeys(value, [...baseKeys, 'section_kind']))
    || typeof value.id !== 'string' || !/^suggestion-[a-f0-9]{16}$/.test(value.id)
    || typeof value.path !== 'string' || typeof value.collection !== 'string'
    || (value.record_id !== null && typeof value.record_id !== 'string')
    || typeof value.field !== 'string' || typeof value.category !== 'string'
    || typeof value.mergeable !== 'boolean' || (value.value !== null && typeof value.value !== 'string')
    || typeof value.confidence !== 'number' || !Number.isFinite(value.confidence)
    || value.confidence < 0 || value.confidence > 1 || !Array.isArray(value.alternatives)
    || value.alternatives.length > 10 || !Array.isArray(value.questions) || value.questions.length > 10
    || value.questions.some((question) => typeof question !== 'string' || question.length < 1 || question.length > 1_000)
    || value.status !== 'unverified'
    || (value.section_kind !== undefined && typeof value.section_kind !== 'string')) {
    dependencyError('Validierter AI-CV-Vorschlag enthaelt keine gueltige Suggestion-Projektion.');
  }
  return {
    id: value.id, path: value.path, collection: value.collection,
    recordId: value.record_id, field: value.field, category: value.category,
    mergeable: value.mergeable,
    ...(typeof value.section_kind === 'string' ? { sectionKind: value.section_kind } : {}),
    value: value.value,
    sourceAnchor: value.source_anchor === null ? null : aiAnchor(value.source_anchor),
    confidence: value.confidence,
    alternatives: value.alternatives.map(aiAlternative), questions: value.questions as string[], status: 'unverified',
  };
}

function validatedAiProposal(value: Record<string, unknown>) {
  if (!exactKeys(value, ['contract', 'contract_version', 'status', 'binding', 'suggestions', 'conflicts'])
    || value.contract !== 'validated-ai-cv-structure-proposal' || value.contract_version !== '1.0'
    || value.status !== 'unverified' || !isRecord(value.binding) || !Array.isArray(value.suggestions)
    || value.suggestions.length > 2_000 || !Array.isArray(value.conflicts) || value.conflicts.length !== 0) {
    dependencyError('Der lokale CV-Skill lieferte keinen gueltigen validierten AI-Vorschlag.');
  }
  const binding = value.binding;
  if (!exactKeys(binding, ['source_id', 'source_sha256', 'text_sha256', 'base_proposal_sha256'])
    || typeof binding.source_id !== 'string' || !/^source-cv-[a-f0-9]{16}$/.test(binding.source_id)
    || [binding.source_sha256, binding.text_sha256, binding.base_proposal_sha256]
      .some((digest) => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))) {
    dependencyError('Der validierte AI-CV-Vorschlag ist nicht sicher an die Importquelle gebunden.');
  }
  return {
    contract: 'validated-ai-cv-structure-proposal' as const,
    contractVersion: '1.0' as const,
    status: 'unverified' as const,
    binding: {
      sourceId: binding.source_id as string,
      sourceSha256: binding.source_sha256 as string,
      extractedTextSha256: binding.text_sha256 as string,
      baseProposalSha256: binding.base_proposal_sha256 as string,
    },
    suggestions: value.suggestions.map(aiSuggestion),
  };
}

function privateAiProposal(value: unknown, expectedProposalSha256: string): Record<string, unknown> {
  if (!isRecord(value) || !exactKeys(value, ['contract', 'contractVersion', 'proposalSha256', 'aiProposal'])
    || value.contract !== 'cv-ai-private-proposal' || value.contractVersion !== '1.0'
    || typeof value.proposalSha256 !== 'string' || value.proposalSha256 !== expectedProposalSha256
    || !/^[a-f0-9]{64}$/.test(expectedProposalSha256) || !isRecord(value.aiProposal)
    || sha256(canonicalJson(value.aiProposal)) !== expectedProposalSha256) {
    dependencyError('Gespeicherter AI-CV-Vorschlag ist nicht mehr exakt an die Providerantwort gebunden.');
  }
  return value.aiProposal;
}

function materializationSuggestionIds(
  artifact: Record<string, unknown>, expectedBaseProposalSha256: string,
  aiProposal: Record<string, unknown>,
): string[] {
  const rootKeys = [
    'contract', 'contract_version', 'schema_version', 'state', 'publishable', 'source', 'sources',
    'extraction', 'confirmation', 'proposal',
  ];
  if (!exactKeys(artifact, rootKeys) || artifact.contract !== 'cv-import-proposal'
    || artifact.contract_version !== '1.0' || artifact.schema_version !== 1
    || artifact.state !== 'needs_user_confirmation' || artifact.publishable !== false
    || !isRecord(artifact.source) || !isRecord(artifact.extraction) || !isRecord(artifact.proposal)
    || !Array.isArray(artifact.sources) || !isRecord(artifact.confirmation)) {
    dependencyError('AI-CV-Materialisierung lieferte kein vollstaendiges unbestaetigtes Importartefakt.');
  }
  if (!exactKeys(artifact.confirmation, ['required', 'rule']) || artifact.confirmation.required !== true
    || typeof artifact.confirmation.rule !== 'string' || !artifact.confirmation.rule.trim()) {
    dependencyError('AI-CV-Materialisierung lieferte keine gueltige Bestaetigungssperre.');
  }
  const proposal = artifact.proposal;
  if (!exactKeys(proposal, [
    'profile', 'facts', 'claims', 'experience', 'projects', 'education', 'certifications',
    'skills', 'languages', 'additional_facts',
  ]) || !Array.isArray(proposal.facts) || !Array.isArray(proposal.claims)
    || !Array.isArray(proposal.experience) || !Array.isArray(proposal.projects)
    || !Array.isArray(proposal.education) || !Array.isArray(proposal.certifications)
    || !Array.isArray(proposal.skills) || !Array.isArray(proposal.languages)
    || !Array.isArray(proposal.additional_facts) || proposal.additional_facts.length !== 0) {
    dependencyError('AI-CV-Materialisierung lieferte keinen vollstaendigen Erkennungsstand.');
  }
  if (!exactKeys(artifact.extraction, [
    'engine', 'text_sha256', 'line_count', 'line_manifest', 'warnings', 'conflicts', 'ai_structuring',
  ]) || !Array.isArray(artifact.extraction.ai_structuring)
    || artifact.extraction.ai_structuring.length !== 1) {
    dependencyError('AI-CV-Materialisierung lieferte keinen eindeutigen Pruefnachweis.');
  }
  const audit = artifact.extraction.ai_structuring[0];
  if (!isRecord(audit) || !exactKeys(audit, [
    'contract', 'contract_version', 'status', 'binding', 'applied_suggestion_ids', 'mode',
  ]) || audit.contract !== 'validated-ai-cv-structure-proposal' || audit.contract_version !== '1.0'
    || audit.status !== 'unverified' || audit.mode !== 'replace_recognition_version'
    || !isRecord(audit.binding) || !Array.isArray(audit.applied_suggestion_ids)
    || audit.applied_suggestion_ids.length < 1 || audit.applied_suggestion_ids.length > 2_000) {
    dependencyError('AI-CV-Materialisierung lieferte keinen gueltigen Pruefnachweis.');
  }
  const providerBinding = isRecord(aiProposal.binding) ? aiProposal.binding : undefined;
  if (!providerBinding || !exactKeys(audit.binding, [
    'source_id', 'source_sha256', 'text_sha256', 'base_proposal_sha256',
  ]) || !exactKeys(providerBinding, [
    'source_id', 'source_sha256', 'text_sha256', 'base_proposal_sha256',
  ]) || typeof providerBinding.source_id !== 'string'
    || !/^source-cv-[a-f0-9]{16}$/.test(providerBinding.source_id)
    || [providerBinding.source_sha256, providerBinding.text_sha256, providerBinding.base_proposal_sha256]
      .some((value) => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    || audit.binding.source_id !== providerBinding.source_id
    || audit.binding.source_sha256 !== providerBinding.source_sha256
    || audit.binding.text_sha256 !== providerBinding.text_sha256
    || audit.binding.base_proposal_sha256 !== expectedBaseProposalSha256
    || providerBinding.base_proposal_sha256 !== expectedBaseProposalSha256
    || artifact.source.id !== providerBinding.source_id
    || artifact.source.sha256 !== providerBinding.source_sha256
    || artifact.extraction.text_sha256 !== providerBinding.text_sha256) {
    dependencyError('AI-CV-Materialisierung ist nicht exakt an die Importquelle gebunden.');
  }
  const appliedSuggestionIds = audit.applied_suggestion_ids;
  if (appliedSuggestionIds.some((id) => typeof id !== 'string' || !/^suggestion-[a-f0-9]{16}$/.test(id))
    || new Set(appliedSuggestionIds).size !== appliedSuggestionIds.length
    || appliedSuggestionIds.some((id, index) => id !== [...appliedSuggestionIds].sort()[index])) {
    dependencyError('AI-CV-Materialisierung lieferte ungueltige Vorschlagsbindungen.');
  }
  for (const fact of proposal.facts) {
    if (!isRecord(fact) || !isRecord(fact.source_anchor)) continue;
    const anchor = fact.source_anchor;
    if (anchor.origin === 'ai_structuring'
      && (anchor.recognition_method !== 'ai_assisted' || anchor.alternative_id !== null)) {
      dependencyError('AI-CV-Materialisierung enthielt keine reine Primaererkennung.');
    }
  }
  return appliedSuggestionIds as string[];
}

function factsFromArtifact(artifact: Record<string, unknown>): CvFact[] {
  const proposal = artifact.proposal;
  if (!isRecord(proposal) || !Array.isArray(proposal.facts) || proposal.facts.length > 2_000) {
    dependencyError('CV-Skilloutput enthaelt keine gueltige Faktenliste.');
  }
  return proposal.facts.map((rawFact) => {
    if (!isRecord(rawFact)) dependencyError('CV-Skilloutput enthaelt einen typwidrigen Fakt.');
    const id = contractFactString(rawFact.id, CONTRACT_FACT_ID);
    const claimId = contractFactString(rawFact.claim_id, CONTRACT_FACT_ID);
    const rawCategory = contractFactString(rawFact.category);
    const recordId = contractFactString(rawFact.record_id, CONTRACT_FACT_ID);
    const field = contractFactString(rawFact.field, CONTRACT_FACT_FIELD);
    const value = contractFactString(rawFact.value, undefined, 5_000);
    if (rawFact.status !== 'unverified') dependencyError('CV-Skilloutput enthaelt einen nicht freigegebenen Faktenstatus.');
    return {
      id, claimId, category: category(rawCategory), recordId, field, value, decision: 'pending' as const,
      provenance: provenance(rawFact.source_anchor, rawFact.proposal_metadata),
    };
  });
}

function contractFactString(value: unknown, pattern?: RegExp, maximum = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || (pattern && !pattern.test(value))) {
    dependencyError('CV-Skilloutput enthaelt ein typwidriges oder ungueltiges Pflichtfeld.');
  }
  return value;
}

function provenance(value: unknown, metadataValue?: unknown): CvFact['provenance'] {
  if (!isRecord(value)) {
    dependencyError('CV-Skilloutput enthaelt keine gueltige Quellenbindung.');
  }
  const anchor = value;
  const sourceSha256 = anchor.source_sha256;
  if (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha256)) {
    dependencyError('CV-Skilloutput enthaelt keine gueltige Quellenbindung.');
  }
  if (anchor.origin !== undefined
    && (typeof anchor.origin !== 'string' || !['user_supplied', 'ai_structuring'].includes(anchor.origin))) {
    dependencyError('CV-Skilloutput enthaelt eine ungueltige Faktenherkunft.');
  }
  const origin = anchor.origin === 'user_supplied' ? 'user_supplied' as const : 'imported' as const;
  const aiAssisted = anchor.origin === 'ai_structuring' && anchor.recognition_method === 'ai_assisted';
  if (anchor.origin === 'ai_structuring' && !aiAssisted) {
    dependencyError('CV-Skilloutput enthaelt ungueltige KI-Erkennungsprovenienz.');
  }
  if (metadataValue !== undefined && !isRecord(metadataValue)) {
    dependencyError('CV-Skilloutput enthaelt typwidrige Vorschlagsmetadaten.');
  }
  const metadata = metadataValue ?? {};
  const suggestionId = typeof anchor.suggestion_id === 'string' && /^suggestion-[a-f0-9]{16}$/.test(anchor.suggestion_id)
    ? anchor.suggestion_id : undefined;
  const alternativeId = typeof anchor.alternative_id === 'string' && /^alternative-[a-f0-9]{16}$/.test(anchor.alternative_id)
    ? anchor.alternative_id : undefined;
  const confidence = typeof metadata.confidence === 'number' && Number.isFinite(metadata.confidence)
    && metadata.confidence >= 0 && metadata.confidence <= 1 ? metadata.confidence : undefined;
  const questions = Array.isArray(metadata.questions)
    ? metadata.questions.filter((question): question is string => typeof question === 'string' && question.length > 0 && question.length <= 1_000).slice(0, 10)
    : [];
  const lineStart = Number(anchor.line_start); const lineEnd = Number(anchor.line_end);
  const charStart = Number(anchor.char_start); const charEnd = Number(anchor.char_end);
  const additionId = origin === 'user_supplied'
    ? contractFactString(anchor.addition_id, CONTRACT_FACT_ID)
    : undefined;
  if (origin === 'imported' && !aiAssisted
    && (!Number.isSafeInteger(anchor.line_start) || (anchor.line_start as number) < 1)) {
    dependencyError('CV-Skilloutput enthaelt keinen gueltigen lokalen Zeilenanker.');
  }
  if (aiAssisted && (!suggestionId
    || !Number.isSafeInteger(anchor.line_start) || (anchor.line_start as number) < 1
    || !Number.isSafeInteger(anchor.line_end) || (anchor.line_end as number) < (anchor.line_start as number)
    || !Number.isSafeInteger(anchor.char_start) || (anchor.char_start as number) < 0
    || !Number.isSafeInteger(anchor.char_end) || (anchor.char_end as number) < 1)) {
    dependencyError('CV-Skilloutput enthaelt ungueltige KI-Quellenkoordinaten.');
  }
  return {
    sourceSha256, origin,
    anchor: origin === 'user_supplied'
      ? `addition:${additionId}`
      : aiAssisted && suggestionId ? `ai:${suggestionId}` : `line:${anchor.line_start as number}`,
    ...(aiAssisted && suggestionId ? {
      recognition: {
        method: 'ai_assisted' as const, suggestionId,
        ...(alternativeId ? { selectedAlternativeId: alternativeId } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
        ...(questions.length ? { questions } : {}),
        ...(Number.isSafeInteger(lineStart) && lineStart >= 1 && Number.isSafeInteger(lineEnd) && lineEnd >= lineStart
          && Number.isSafeInteger(charStart) && charStart >= 0 && Number.isSafeInteger(charEnd) && charEnd >= 1
          ? { sourceSpan: { lineStart, lineEnd, charStart, charEnd } } : {}),
      },
    } : {}),
  };
}

/**
 * Returns the confirmed claim ids when *every* one of them is already present in
 * the candidate profile — i.e. this is a repeat of an adoption that already
 * happened. Returns undefined for any partial overlap, which stays a collision.
 */
export function selectedClaimIdsAlreadyAdopted(
  artifact: Record<string, unknown>,
  rootFacts: CvFact[],
  candidateBytes: Buffer | string,
): string[] | undefined {
  const confirmed = new Set(mapCvAdoptionDecisions(rootFacts, artifact)
    .filter((decision) => decision.decision === 'confirm').map((decision) => decision.fact_id));
  if (confirmed.size === 0) return undefined;
  // Facts live under the proposal envelope, not at the artifact root — the same
  // shape `factsFromArtifact` and the contract's `adopt-confirmed` read.
  const selected = new Set(factsFromArtifact(artifact)
    .flatMap((fact) => (confirmed.has(fact.id) && fact.claimId ? [fact.claimId] : [])));
  if (selected.size === 0) return undefined;
  let candidate: unknown;
  try { candidate = YAML.parse(typeof candidateBytes === 'string' ? candidateBytes : candidateBytes.toString('utf8')); }
  catch { return undefined; }
  const claims = candidate && typeof candidate === 'object' && Array.isArray((candidate as { claims?: unknown }).claims)
    ? (candidate as { claims: unknown[] }).claims : [];
  const existing = new Set(claims.flatMap((claim) => claim && typeof claim === 'object' && typeof (claim as { id?: unknown }).id === 'string'
    ? [(claim as { id: string }).id] : []));
  return [...selected].every((claimId) => existing.has(claimId)) ? [...selected].sort() : undefined;
}

export function mapCvAdoptionDecisions(rootFacts: CvFact[], artifact: Record<string, unknown>) {
  const decisionByFact = new Map(rootFacts.map((fact) => [fact.id, fact.decision]));
  return factsFromArtifact(artifact).map((fact) => {
    const additionId = fact.provenance.anchor.startsWith('addition:') ? fact.provenance.anchor.slice('addition:'.length) : undefined;
    const decision = decisionByFact.get(fact.id) ?? (additionId ? decisionByFact.get(additionId) : undefined) ?? 'pending';
    return {
      fact_id: fact.id, decision: decision === 'confirmed' ? 'confirm' : decision === 'rejected' ? 'reject' : 'pending',
      ...(decision === 'confirmed' ? { explicitly_confirmed: true as const, confirmation_origin: 'explicit_local_user_action' as const } : {}),
    };
  });
}

export function conflictsFromArtifact(artifact: Record<string, unknown>): CvNormalizationConflict[] {
  return contractConflictRecords(artifact).map((item) => ({
    id: `conflict-${sha256(canonicalJson(item)).slice(0, 16)}`,
    code: item.code as string,
    detail: item.detail as string,
  }));
}

function contractConflictRecords(artifact: Record<string, unknown>): Array<Record<string, unknown>> {
  const extraction = artifact.extraction as Record<string, unknown> | undefined;
  if (extraction?.conflicts !== undefined && !Array.isArray(extraction.conflicts)) {
    dependencyError('CV-Skilloutput enthaelt eine typwidrige Konfliktliste.');
  }
  const conflicts = Array.isArray(extraction?.conflicts) ? extraction.conflicts : [];
  return conflicts.map((item) => {
    if (!isRecord(item)) dependencyError('CV-Skilloutput enthaelt einen typwidrigen Konflikt.');
    const code = contractDiagnosticString(item.code, 120);
    const detail = contractDiagnosticString(item.detail, 500);
    if (code === 'user_supplied_field_conflict') {
      contractFactString(item.left_fact_id, CONTRACT_FACT_ID);
      contractFactString(item.right_fact_id, CONTRACT_FACT_ID);
    }
    return { ...item, code, detail };
  });
}

export function unresolvedConflictsForDecisions(artifact: Record<string, unknown>, rootFacts: CvFact[]) {
  const raw = contractConflictRecords(artifact);
  const decisionByContractFact = new Map(mapCvAdoptionDecisions(rootFacts, artifact).map((item) => [item.fact_id, item.decision]));
  return conflictsFromArtifact({ extraction: { conflicts: raw.filter((item) => {
    if (item.code !== 'user_supplied_field_conflict') return true;
    const left = decisionByContractFact.get(item.left_fact_id as string);
    const right = decisionByContractFact.get(item.right_fact_id as string);
    return !((left === 'confirm' && right === 'reject') || (left === 'reject' && right === 'confirm'));
  }) } });
}

function warningsFromArtifact(artifact: Record<string, unknown>) {
  const extraction = artifact.extraction as Record<string, unknown> | undefined;
  if (extraction?.warnings !== undefined && !Array.isArray(extraction.warnings)) {
    dependencyError('CV-Skilloutput enthaelt eine typwidrige Warnungsliste.');
  }
  const warnings = Array.isArray(extraction?.warnings) ? extraction.warnings : [];
  const conflicts = conflictsFromArtifact(artifact);
  const projectedWarnings = warnings.map((item) => {
    if (!isRecord(item)) dependencyError('CV-Skilloutput enthaelt eine typwidrige Warnung.');
    return { code: contractDiagnosticString(item.code, 120), detail: contractDiagnosticString(item.detail, 500) };
  });
  return [...projectedWarnings, ...conflicts].map((item) => `${item.code}: ${item.detail}`);
}

function contractDiagnosticString(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    dependencyError('CV-Skilloutput enthaelt ein typwidriges Diagnosefeld.');
  }
  return value;
}

function category(value: string): CvFactCategory {
  if (['experience_detail', 'achievement', 'technology', 'metric'].includes(value)) return 'employment';
  if (value === 'other' || value === 'additional') return 'additional';
  if (value === 'project' || value === 'education' || value === 'skill' || value === 'certification' || value === 'language' || value === 'employment' || value === 'profile' || value === 'contact') return value;
  dependencyError('CV-Skilloutput enthaelt eine unbekannte Faktenkategorie.');
}
function stringArray(value: unknown) { return Array.isArray(value) ? value.map(String) : []; }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function cvFactAdditionForContract(fact: CvFact) {
  let collection: string; let field = fact.field; let category = fact.category === 'additional' ? 'other' : fact.category;
  if (fact.category === 'profile' || fact.category === 'contact') {
    collection = 'profile';
    if (fact.category === 'contact' && !field.startsWith('contact.')) field = `contact.${field}`;
    category = 'profile';
  } else if (fact.category === 'employment') {
    collection = 'experience';
    if (/^details\[[0-9]{1,4}\]$/.test(field)) { category = 'achievement'; field = 'detail'; }
    if (['achievement', 'technology', 'metric'].includes(field)) { category = field; field = 'detail'; }
  } else if (fact.category === 'project') collection = 'projects';
  else if (fact.category === 'certification') collection = 'certifications';
  else if (fact.category === 'skill') collection = 'skills';
  else if (fact.category === 'language') collection = 'languages';
  else if (fact.category === 'education') collection = 'education';
  else {
    collection = 'additional_facts';
    if (field === 'detail') field = 'text';
    category = 'other';
  }
  return {
    id: fact.id, collection, field, value: fact.value, category,
    ...(fact.recordId.startsWith('record-user-') ? { record_key: fact.recordId } : { record_id: fact.recordId }),
  };
}
function within(root: string, candidate: string) { const nested = relative(root, candidate); return nested === '' || (!nested.startsWith('..') && !isAbsolute(nested)); }
async function assertRegularFile(path: string, maximum: number) {
  const stats = await lstat(path).catch(() => dependencyError('Lokale CV-Skilldatei ist nicht sicher lesbar.'));
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > maximum) dependencyError('Lokale CV-Skilldatei ist keine sichere reguläre Datei.');
}
export async function readValidatedPrivateProfile(path: string, profilesRoot: string, maximum: number) {
  const rootStats = await lstat(profilesRoot).catch(() => dependencyError('Privater Profilpfad ist nicht sicher lesbar.'));
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) dependencyError('Privater Profilpfad ist kein sicheres Verzeichnis.');
  const configuredStats = await lstat(path).catch(() => dependencyError('Private Profildatei ist nicht sicher lesbar.'));
  if (!configuredStats.isFile() || configuredStats.isSymbolicLink() || configuredStats.size < 1 || configuredStats.size > maximum) {
    dependencyError('Private Profildatei ist keine sichere regulaere Datei.');
  }
  const canonicalRoot = await realpath(profilesRoot); const canonicalPath = await realpath(path);
  if (!within(canonicalRoot, canonicalPath)) dependencyError('Private Profildatei verlaesst den kanonischen Profilpfad.');
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(canonicalPath, constants.O_RDONLY | noFollow).catch(() => dependencyError('Private Profildatei konnte nicht sicher geoeffnet werden.'));
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size < 1 || stats.size > maximum) dependencyError('Private Profildatei ist keine sichere regulaere Datei.');
    const bytes = await handle.readFile();
    if (bytes.length !== stats.size) dependencyError('Private Profildatei wurde waehrend des Lesens veraendert.');
    return { canonicalPath, bytes };
  } finally { await handle.close(); }
}
function dependencyError(_diagnostic: string): never {
  throw cvDependencyFailure(
    'cv_local_dependency_unavailable',
    'Der lokale CV-Skillvertrag ist nicht verfügbar oder unvollständig eingerichtet.',
  );
}
/** Projects one adoption ledger entry; only closed, validated fields reach the client. */
function adoptionLedgerEntry(value: unknown): CvAdoptionLedgerEntry {
  if (!isRecord(value)) dependencyError('CV-Uebernahmeliste enthaelt einen typwidrigen Eintrag.');
  const transactionId = typeof value.transaction_id === 'string' ? value.transaction_id : '';
  if (!CV_PROFILE_TRANSACTION_ID.test(transactionId)) {
    dependencyError('CV-Uebernahmeliste enthaelt eine ungueltige Transaktionskennung.');
  }
  const occurredAt = typeof value.occurred_at === 'string' ? value.occurred_at : '';
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) {
    dependencyError('CV-Uebernahmeliste enthaelt keinen gueltigen Zeitstempel.');
  }
  const digest = (candidate: unknown) => typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate)
    ? candidate : undefined;
  const count = (candidate: unknown) => Number.isSafeInteger(candidate) && (candidate as number) >= 0
    ? candidate as number : 0;
  const sourceSha256 = digest(value.source_sha256);
  const beforeSha256 = digest(value.before_sha256);
  const replacedSnapshotId = typeof value.replaced_snapshot_id === 'string'
    && CV_PROFILE_SNAPSHOT_ID.test(value.replaced_snapshot_id) ? value.replaced_snapshot_id : undefined;
  return {
    transactionId, occurredAt,
    claimCount: count(value.claim_count), presentClaimCount: count(value.present_claim_count),
    ...(sourceSha256 ? { sourceSha256 } : {}),
    ...(beforeSha256 ? { beforeSha256 } : {}),
    ...(replacedSnapshotId ? { replacedSnapshotId } : {}),
  };
}

/** Projects one snapshot index entry; unknown or typewidrige fields never reach the client. */
function profileSnapshot(value: unknown): CvProfileSnapshot {
  if (!isRecord(value)) dependencyError('CV-Snapshotliste enthaelt einen typwidrigen Eintrag.');
  const id = typeof value.snapshot_id === 'string' ? value.snapshot_id : '';
  if (!CV_PROFILE_SNAPSHOT_ID.test(id)) dependencyError('CV-Snapshotliste enthaelt eine ungueltige Kennung.');
  const candidateProfileSha256 = typeof value.candidate_sha256 === 'string' ? value.candidate_sha256 : '';
  if (!/^[a-f0-9]{64}$/.test(candidateProfileSha256)) {
    dependencyError('CV-Snapshotliste enthaelt keinen gueltigen Profilhash.');
  }
  const createdAt = typeof value.created_at === 'string' ? value.created_at : '';
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) {
    dependencyError('CV-Snapshotliste enthaelt keinen gueltigen Zeitstempel.');
  }
  const label = typeof value.label === 'string' && value.label.trim() && value.label.length <= 120
    ? value.label : undefined;
  return {
    id, createdAt, candidateProfileSha256,
    byteSize: Number.isSafeInteger(value.byte_size) && (value.byte_size as number) >= 0 ? value.byte_size as number : 0,
    reason: typeof value.reason === 'string' && value.reason.length <= 64 ? value.reason : 'unknown',
    claimCount: Number.isSafeInteger(value.claim_count) && (value.claim_count as number) >= 0 ? value.claim_count as number : 0,
    ...(label ? { label } : {}),
    current: value.current === true,
  };
}
function invalidProfileRequest(_diagnostic: string): never {
  throw new SafeHttpError({
    statusCode: 400, errorCode: 'cv_profile_request_invalid', stage: 'cv_profile_adoption',
    publicDetail: 'Die Anfrage zur Profilverwaltung enthält keinen gültigen Bezeichner.', retryable: false,
  });
}
function invalidUserFact(_diagnostic: string): never {
  throw new SafeHttpError({
    statusCode: 400, errorCode: 'cv_user_fact_invalid', stage: 'cv_fact_validation',
    publicDetail: 'Der hinzugefügte Lebenslauffakt ist im aktiven CV-Vertrag nicht zulässig.', retryable: false,
  });
}
function unresolvedConflict(_diagnostic: string): never {
  throw new SafeHttpError({
    statusCode: 409, errorCode: 'cv_fact_conflict', stage: 'cv_profile_adoption',
    publicDetail: 'Der CV-Import enthält ungelöste Faktenkonflikte. Prüfe die Entscheidungen vor der Übernahme.', retryable: false,
  });
}
