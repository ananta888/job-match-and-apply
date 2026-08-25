import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { PDFParse } from 'pdf-parse';
import JSZip from 'jszip';
import { Parser as HtmlParser } from 'htmlparser2';
import { SaxesParser } from 'saxes';
import {
  CV_FACT_CATEGORIES, CV_LAYOUT_SECTIONS, type CvFact, type CvFactCategory, type CvNormalizationEnvelope,
  type CvNormalizationConflict, type CvNormalizationPort, type CvTheme, type CvLayoutFingerprint,
  type CvLayoutSection, type CvLayoutPalette, type CvThemeOriginalLayout,
  type CvAdoptionLedgerEntry, type CvProfileSnapshot,
} from '../ports/cv-normalization.js';
import { extractLayoutFingerprint, validateLayoutFingerprint } from './cv-layout-fingerprint.js';
import { checkAtsHtml, type AtsCheckReport } from './ats-check.js';
import type { CvAiStructuringImportPort } from './cv-ai-structuring.js';

const LAYOUT_HEX = /^#[0-9a-f]{6}$/;

export const CV_MIME_TYPES = {
  'text/html': ['.html', '.htm'],
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.oasis.opendocument.text': ['.odt'],
} as const;

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 2_000_000;
const MAX_ZIP_ENTRIES = 512;
const MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
const MAX_RECOGNITION_VERSIONS = 20;
const FACT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELD_ID = /^(?=.{1,64}$)[a-z][a-z0-9_.]*(?:\[[0-9]{1,4}\])?$/;
const RECOGNITION_VERSION_ID = /^recognition-[a-f0-9]{16}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_COMPONENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type CvImportStatus = 'facts_pending' | 'facts_reviewed' | 'adopted' | 'proposal_ready';

export type CvRecognitionVersionKind = 'deterministic' | 'ai';

export interface CvRecognitionProviderWitness {
  id: string;
  runtimeTarget: 'windows' | 'wsl';
  version: string;
  adapterVersion: string;
  witnessSha256?: string;
}

export interface CvRecognitionVersion {
  id: string;
  ordinal: number;
  kind: CvRecognitionVersionKind;
  label: string;
  createdAt: string;
  updatedAt: string;
  facts: CvFact[];
  warnings: string[];
  unresolvedConflicts?: CvNormalizationConflict[];
  normalizationArtifact?: unknown;
  provider?: CvRecognitionProviderWitness;
  /** Private source/run binding. Public DTOs never expose it. */
  binding?: {
    deterministicRecognitionVersionId: string;
    sourceSha256: string;
    baseProposalSha256: string;
    runSha256: string;
    proposalSha256: string;
    artifactSha256: string;
  };
}

export interface CreateAiRecognitionVersionInput {
  id: string;
  expectedRevision: number;
  expectedSha256: string;
  label?: string;
  /** Complete fact projection of the materialized AI artifact; this is never merged with the deterministic version. */
  facts: CvFact[];
  warnings?: string[];
  unresolvedConflicts: CvNormalizationConflict[];
  normalizationArtifact: unknown;
  source: {
    deterministicRecognitionVersionId: string;
    sourceSha256: string;
    baseProposalSha256: string;
  };
  provenance: {
    runId: string;
    runSha256?: string;
    proposalSha256: string;
    artifactSha256: string;
    selections?: Array<{ suggestionId: string; alternativeId: string | null }>;
  };
  provider?: CvRecognitionProviderWitness;
}

export interface CvRecognitionVersionCreationResult {
  revision: number;
  sha256: string;
  recognitionVersionId: string;
  recognitionVersionCount: number;
  factIds: string[];
}

export interface CvImportRecord {
  contract: 'cv-import';
  contractVersion: '1.0';
  id: string;
  revision: number;
  sha256: string;
  status: CvImportStatus;
  createdAt: string;
  updatedAt: string;
  source: {
    fileName: string; mimeType: keyof typeof CV_MIME_TYPES; bytes: number; sha256: string;
    retention: 'upload_deleted_after_local_extraction';
  };
  facts: CvFact[];
  warnings: string[];
  /** Internal fail-closed conflict state. Details are encrypted at rest and omitted from public REST records. */
  unresolvedConflicts?: CvNormalizationConflict[];
  /** Opaque submodule proposal, encrypted with the rest of this record and never returned by REST. */
  normalizationArtifact?: unknown;
  /**
   * Additive recognition history. Legacy encrypted records omit both fields and are materialized
   * as one deterministic version on read without rewriting their original CAS hash.
   */
  recognitionVersions?: CvRecognitionVersion[];
  activeRecognitionVersionId?: string;
  /** Style-only layout pattern captured from the original document at import time. Never carries fact content. */
  layoutFingerprint?: CvLayoutFingerprint;
  theme?: CvTheme;
  adoption?: {
    adoptedAt: string; adoptedClaimIds: string[]; adoptedRecordIds: string[];
    candidateProfileSha256: string; candidateProfileRevision: string;
    recognitionVersionId?: string; recognitionVersionSha256?: string;
    /** Candidate-history transaction this adoption committed under; the handle a revoke is scoped to. */
    transactionId?: string;
    /** Pre-adoption profile snapshot, for a full rollback including overwritten profile scalars. */
    replacedSnapshotId?: string;
    /** True when the claims were already present, so the profile was not written. */
    alreadyAdopted?: boolean;
  };
  proposal?: {
    applicationCaseId: string; jobId: string; createdAt: string; html: string;
    htmlSha256: string; documentRevisionId: string; documentSha256: string;
    lifecycle: 'approved_revision_preview'; format: 'html'; downloadAllowed: boolean;
    inputSnapshot: {
      cvImportRevision: number; cvImportSha256: string; candidateProfileSha256: string;
      candidateProfileRevision: string; styleProfileRevision: number; styleProfileSha256: string;
      themeSha256?: string; agentWorkflowId: 'evidence-application-package';
      sourceAgentArtifactId: string; pipelineContractVersion: string; completedStages: string[];
      agentOrchestrationRequired: false;
      recognitionVersionId?: string; recognitionVersionSha256?: string;
    };
  };
}

export function publicCvImportRecord(record: CvImportRecord) {
  const view = materializeRecognitionRecord(record) as CvImportRecord & Record<string, unknown>;
  delete view.normalizationArtifact;
  delete view.unresolvedConflicts;
  delete view.recognitionVersions;
  if (view.proposal) delete (view.proposal as unknown as Record<string, unknown>).html;
  return view;
}

export function publicCvImportSummary(record: CvImportRecord) {
  const current = materializeRecognitionRecord(record);
  const count = (decision: CvFact['decision']) => current.facts.filter((fact) => fact.decision === decision).length;
  return {
    contract: 'cv-import-summary' as const, contractVersion: '1.0' as const,
    id: current.id, revision: current.revision, sha256: current.sha256, status: current.status,
    createdAt: current.createdAt, updatedAt: current.updatedAt, source: structuredClone(current.source),
    factCounts: { total: current.facts.length, pending: count('pending'), confirmed: count('confirmed'), rejected: count('rejected') },
    warningCount: current.warnings.length, unresolvedConflictCount: current.unresolvedConflicts?.length ?? 0,
    hasTheme: Boolean(current.theme), hasLayoutFingerprint: Boolean(current.layoutFingerprint),
    hasAdoption: Boolean(current.adoption), hasProposal: Boolean(current.proposal),
  };
}

export function publicCvRecognitionVersionList(record: CvImportRecord) {
  const current = materializeRecognitionRecord(record);
  return {
    contract: 'cv-recognition-version-list' as const,
    contractVersion: '1.0' as const,
    importId: current.id,
    activeVersionId: current.activeRecognitionVersionId!,
    versions: current.recognitionVersions!.map((version) => {
      const count = (decision: CvFact['decision']) => version.facts.filter((fact) => fact.decision === decision).length;
      return {
        id: version.id, ordinal: version.ordinal, kind: version.kind, label: version.label,
        createdAt: version.createdAt, updatedAt: version.updatedAt,
        active: version.id === current.activeRecognitionVersionId,
        factCounts: {
          total: version.facts.length, pending: count('pending'),
          confirmed: count('confirmed'), rejected: count('rejected'),
        },
        warningCount: version.warnings.length,
        ...(version.provider ? { provider: { id: version.provider.id, version: version.provider.version } } : {}),
      };
    }),
  };
}

export interface CvImportRepository {
  create(record: CvImportRecord): Promise<void>;
  get(id: string): Promise<CvImportRecord | undefined>;
  list(limit?: number): Promise<CvImportRecord[]>;
  compareAndDelete(id: string, expectedRevision: number, expectedSha256: string): Promise<boolean>;
  compareAndSave(id: string, expectedRevision: number, expectedSha256: string, next: CvImportRecord): Promise<void>;
}

export class MemoryCvImportRepository implements CvImportRepository {
  private readonly records = new Map<string, CvImportRecord>();
  async create(record: CvImportRecord): Promise<void> { this.records.set(record.id, structuredClone(record)); }
  async get(id: string) { const value = this.records.get(id); return value ? materializeRecognitionRecord(value) : undefined; }
  async list(limit = 100) { return [...this.records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map(materializeRecognitionRecord); }
  async compareAndDelete(id: string, expectedRevision: number, expectedSha256: string) {
    const current = this.records.get(id); if (!current) return false; assertCas(current, expectedRevision, expectedSha256); return this.records.delete(id);
  }
  async compareAndSave(id: string, expectedRevision: number, expectedSha256: string, next: CvImportRecord) {
    const current = this.records.get(id);
    assertCas(current, expectedRevision, expectedSha256);
    this.records.set(id, structuredClone(next));
  }
}

export class JsonCvImportRepository implements CvImportRepository {
  private readonly locks = new Map<string, Promise<void>>();
  private keyPromise?: Promise<Buffer>;
  constructor(
    private readonly root = resolve(process.cwd(), '..', '.local-data', 'cv-imports'),
    private readonly keyPath = resolve(process.cwd(), '..', '.local-data', 'cv-imports.key'),
  ) {}

  async create(record: CvImportRecord) {
    const directory = this.directory(record.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.writeRecord(record);
  }

  async get(id: string) {
    assertUuid(id);
    try {
      const envelope = JSON.parse(await readFile(join(this.directory(id), 'record.enc.json'), 'utf8')) as {
        version: 1; algorithm: 'aes-256-gcm'; iv: string; tag: string; ciphertext: string;
      };
      if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') throw new Error('Nicht unterstützter CV-Vault-Vertrag.');
      const decipher = createDecipheriv('aes-256-gcm', await this.key(false), Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from(`cv-import/${id}`, 'utf8'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return materializeRecognitionRecord(JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final(),
      ]).toString('utf8')) as CvImportRecord);
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }

  async list(limit = 100) {
    const bounded = Math.min(100, Math.max(1, limit));
    let names: string[];
    try { names = (await readdir(this.root)).filter((name) => /^[0-9a-f-]{36}$/i.test(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (names.length > 5_000) throw new Error('cv_import_inventory_limit');
    const records = (await Promise.all(names.map((name) => this.get(name)))).filter((item): item is CvImportRecord => Boolean(item));
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, bounded);
  }

  async compareAndDelete(id: string, expectedRevision: number, expectedSha256: string) {
    assertUuid(id); const previous = this.locks.get(id) ?? Promise.resolve(); let release!: () => void;
    const currentLock = new Promise<void>((resolveLock) => { release = resolveLock; }); const queued = previous.then(() => currentLock);
    this.locks.set(id, queued); await previous;
    try {
      const existing = await this.get(id); if (!existing) return false; assertCas(existing, expectedRevision, expectedSha256);
      await rm(this.directory(id), { recursive: true, force: false }); return true;
    } finally { release(); if (this.locks.get(id) === queued) this.locks.delete(id); }
  }

  async compareAndSave(id: string, expectedRevision: number, expectedSha256: string, next: CvImportRecord) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const currentLock = new Promise<void>((resolveLock) => { release = resolveLock; });
    const queued = previous.then(() => currentLock);
    this.locks.set(id, queued);
    await previous;
    try {
      assertCas(await this.get(id), expectedRevision, expectedSha256);
      await this.writeRecord(next);
    } finally {
      release();
      if (this.locks.get(id) === queued) this.locks.delete(id);
    }
  }

  private directory(id: string) { assertUuid(id); return join(this.root, id); }
  private key(create: boolean) {
    this.keyPromise ??= this.loadKey(create).catch((error) => { this.keyPromise = undefined; throw error; });
    return this.keyPromise;
  }
  private async loadKey(create: boolean) {
    try { const key = await readFile(this.keyPath); if (key.length !== 32) throw new Error('Ungültiger CV-Vault-Schlüssel.'); return key; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
      await mkdir(dirname(this.keyPath), { recursive: true, mode: 0o700 });
      const key = randomBytes(32); await writeFile(this.keyPath, key, { mode: 0o600, flag: 'wx' }); return key;
    }
  }
  private async writeRecord(record: CvImportRecord) {
    const directory = this.directory(record.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', await this.key(true), iv);
    cipher.setAAD(Buffer.from(`cv-import/${record.id}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
    const envelope = {
      version: 1 as const, algorithm: 'aes-256-gcm' as const, iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'),
    };
    const temporary = join(directory, `record.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, join(directory, 'record.enc.json'));
  }
}

export type CvFactOperation =
  | { factId: string; action: 'confirm' | 'reject' }
  | { factId: string; action: 'edit'; category: CvFactCategory; recordId: string; field: string; value: string }
  | { action: 'add'; category: CvFactCategory; recordId?: string; newRecordKey?: string; field: string; value: string; explicitlyConfirmed?: true };

export class CvImportService implements CvAiStructuringImportPort {
  constructor(private readonly repository: CvImportRepository, private readonly normalization: CvNormalizationPort) {}

  async import(input: { fileName: string; mimeType: keyof typeof CV_MIME_TYPES; data: Buffer }): Promise<CvImportRecord> {
    const source = validateSource(input);
    let extracted: { text: string; warnings: Array<{ code: string; detail: string }> };
    try { extracted = await extractCvText(source.mimeType, input.data); }
    catch (error) {
      if (typeof error === 'object' && error && 'statusCode' in error) throw error;
      badRequest('Lebenslaufdatei konnte nicht sicher lokal extrahiert werden.');
    }
    const envelope: CvNormalizationEnvelope = {
      contract: 'cv-normalization-input', contractVersion: '1.0',
      source: { fileName: source.fileName, mimeType: source.mimeType, sha256: source.sha256, byteSize: source.bytes },
      extractedText: extracted.text, warnings: extracted.warnings,
    };
    const normalized = await this.normalization.normalize(envelope);
    const facts = validateNormalizedFacts(normalized.facts, source.sha256);
    // Capture a style-only layout fingerprint before the upload bytes are dropped. Best-effort and fail-open.
    const layoutFingerprint = validateLayoutFingerprint(await extractLayoutFingerprint(source.mimeType, input.data));
    const now = new Date().toISOString();
    const id = randomUUID();
    const recognitionVersion: CvRecognitionVersion = {
      id: recognitionVersionId(id, source.sha256), ordinal: 1, kind: 'deterministic',
      label: 'Deterministische Erkennung', createdAt: now, updatedAt: now,
      facts: structuredClone(facts),
      warnings: normalized.warnings.map((warning) => cleanText(warning, 500)).slice(0, 100),
      unresolvedConflicts: validateConflicts(normalized.conflicts),
      normalizationArtifact: structuredClone(normalized.artifact),
    };
    const draft = {
      contract: 'cv-import' as const, contractVersion: '1.0' as const,
      id, revision: 1, status: 'facts_pending' as const, createdAt: now, updatedAt: now,
      source: { ...source, retention: 'upload_deleted_after_local_extraction' as const }, facts,
      warnings: structuredClone(recognitionVersion.warnings),
      unresolvedConflicts: structuredClone(recognitionVersion.unresolvedConflicts),
      normalizationArtifact: structuredClone(recognitionVersion.normalizationArtifact),
      recognitionVersions: [recognitionVersion], activeRecognitionVersionId: recognitionVersion.id,
      ...(layoutFingerprint ? { layoutFingerprint } : {}),
    };
    const record: CvImportRecord = { ...draft, sha256: recordHash(draft) };
    await this.repository.create(record);
    return record;
  }

  async get(id: string) { return this.repository.get(id); }
  async list(limit = 100) { return this.repository.list(limit); }
  async delete(id: string, expectedRevision: number, expectedSha256: string) { return this.repository.compareAndDelete(id, expectedRevision, expectedSha256); }

  async recognitionVersions(id: string) {
    return publicCvRecognitionVersionList(await this.require(id));
  }

  async activateRecognitionVersion(
    id: string,
    expectedRevision: number,
    expectedSha256: string,
    versionId: string,
    confirmed: true,
  ) {
    if (confirmed !== true) badRequest('Der Wechsel des Erkennungsstands muss ausdruecklich bestaetigt werden.');
    if (!RECOGNITION_VERSION_ID.test(versionId)) badRequest('Ungueltige Erkennungsstand-ID.');
    const current = await this.require(id);
    assertCas(current, expectedRevision, expectedSha256);
    assertRecognitionMutable(current);
    const synchronized = syncActiveRecognitionVersion(current, new Date().toISOString());
    const target = synchronized.recognitionVersions!.find((version) => version.id === versionId);
    if (!target) notFound('Erkennungsstand nicht gefunden.');
    const projected = projectRecognitionVersion(synchronized, target);
    return this.save(current, {
      ...projected,
      status: recognitionStatus(target),
      adoption: undefined,
      proposal: undefined,
    });
  }

  async confirmActiveRecognitionVersion(
    id: string,
    expectedRevision: number,
    expectedSha256: string,
    versionId: string,
    confirmed: true,
  ) {
    if (confirmed !== true) badRequest('Die Gesamtbestaetigung des Erkennungsstands muss ausdruecklich bestaetigt werden.');
    if (!RECOGNITION_VERSION_ID.test(versionId)) badRequest('Ungueltige Erkennungsstand-ID.');
    const current = await this.require(id);
    assertCas(current, expectedRevision, expectedSha256);
    assertRecognitionMutable(current);
    if (!current.recognitionVersions!.some((version) => version.id === versionId)) {
      notFound('Erkennungsstand nicht gefunden.');
    }
    if (current.activeRecognitionVersionId !== versionId) {
      conflict('Nur der aktive Erkennungsstand kann gesammelt bestaetigt werden.');
    }
    if ((current.unresolvedConflicts?.length ?? 0) > 0) {
      conflict('Ein Erkennungsstand mit ungeloesten Konflikten kann nicht gesammelt bestaetigt werden.');
    }
    const facts = current.facts.map((fact) => fact.decision === 'pending'
      ? { ...structuredClone(fact), decision: 'confirmed' as const }
      : structuredClone(fact));
    const next = syncActiveRecognitionVersion({
      ...current, facts, status: 'facts_reviewed', adoption: undefined, proposal: undefined,
    }, new Date().toISOString());
    return this.save(current, next);
  }

  async createAiRecognitionVersion(input: CreateAiRecognitionVersionInput): Promise<CvRecognitionVersionCreationResult> {
    assertUuid(input.id);
    const current = await this.require(input.id);

    const deterministic = deterministicRecognitionVersion(current);
    if (!input.source || input.source.deterministicRecognitionVersionId !== deterministic.id
      || input.source.sourceSha256 !== current.source.sha256
      || input.source.baseProposalSha256 !== recognitionArtifactSha256(deterministic)) {
      conflict('Der KI-Erkennungsstand ist nicht an den urspruenglichen deterministischen Basisstand gebunden.');
    }
    if (!input.provenance || !SHA256.test(input.provenance.proposalSha256)
      || !SHA256.test(input.provenance.artifactSha256)) {
      dependencyFailure('Der KI-Erkennungsstand besitzt keine gueltige Vorschlags- und Artefaktbindung.');
    }
    assertUuid(input.provenance.runId);
    const runSha256 = createHash('sha256').update(input.provenance.runId, 'utf8').digest('hex');
    if (input.provenance.runSha256 !== undefined && input.provenance.runSha256 !== runSha256) {
      dependencyFailure('Der KI-Erkennungsstand besitzt keine gueltige Laufbindung.');
    }
    if (!isRecord(input.normalizationArtifact)) dependencyFailure('Der KI-Erkennungsstand besitzt kein gueltiges privates Strukturartefakt.');
    const artifactSha256 = createHash('sha256').update(canonicalJson(input.normalizationArtifact), 'utf8').digest('hex');
    if (artifactSha256 !== input.provenance.artifactSha256) {
      dependencyFailure('Der KI-Erkennungsstand stimmt nicht mit seinem Artefakt-Hash ueberein.');
    }
    if (!isRecord(deterministic.normalizationArtifact)) dependencyFailure('Private deterministische CV-Strukturgrundlage fehlt.');

    const aiInputFacts = input.facts.filter((fact) => fact.provenance.recognition?.method === 'ai_assisted');
    if (aiInputFacts.length < 1) {
      dependencyFailure('Ein KI-Erkennungsstand muss mindestens einen KI-assistierten Fakt enthalten.');
    }
    const rawSelections = input.provenance.selections ?? aiInputFacts.map((fact) => ({
      suggestionId: fact.provenance.recognition?.suggestionId ?? '',
      alternativeId: fact.provenance.recognition?.selectedAlternativeId ?? null,
    }));
    const selections = validateAiSelections(rawSelections);
    if (aiInputFacts.length !== selections.size) {
      dependencyFailure('Jede KI-Auswahl muss genau einen KI-assistierten Fakt im neuen Erkennungsstand erzeugen.');
    }
    const validated = validateNormalizedFacts(input.facts, current.source.sha256).map((fact) => {
      const recognition = fact.provenance.recognition;
      if (recognition?.method !== 'ai_assisted') {
        if (!['profile', 'certification'].includes(fact.category)
          || (recognition !== undefined && recognition.method !== 'deterministic')) {
          dependencyFailure('Nicht-KI-Fakten duerfen im ersetzenden KI-Stand nur explizit bewahrte Profil- oder Zertifikatsfakten sein.');
        }
        const preserved = deterministic.facts.find((candidate) => candidate.id === fact.id);
        if (!preserved || canonicalJson({ ...preserved, decision: 'pending' }) !== canonicalJson(fact)) {
          dependencyFailure('Bewahrte Profil- oder Zertifikatsfakten muessen dem deterministischen Ursprung exakt entsprechen.');
        }
        return fact;
      }
      const selection = recognition?.suggestionId ? selections.get(recognition.suggestionId) : undefined;
      if (!selection
        || (recognition.runId !== undefined && recognition.runId !== input.provenance.runId)
        || (recognition.proposalSha256 !== undefined && recognition.proposalSha256 !== input.provenance.proposalSha256)
        || (selection.alternativeId === null
          ? recognition.selectedAlternativeId !== undefined
          : recognition.selectedAlternativeId !== selection.alternativeId)) {
        dependencyFailure('KI-Strukturfakten besitzen keine gueltige Lauf-, Vorschlags- oder Auswahlprovenienz.');
      }
      selections.delete(selection.suggestionId);
      return {
        ...fact,
        provenance: {
          ...fact.provenance,
          recognition: {
            ...recognition,
            runId: input.provenance.runId,
            proposalSha256: input.provenance.proposalSha256,
          },
        },
      };
    });
    if (selections.size !== 0) dependencyFailure('Nicht jede KI-Auswahl wurde als Fakt projiziert.');
    const warnings = validateWarnings(input.warnings ?? deterministic.warnings);
    const unresolvedConflicts = validateConflicts(input.unresolvedConflicts);
    assertAiReplacementArtifact(deterministic.normalizationArtifact, input.normalizationArtifact, validated, {
      expectedBaseProposalSha256: input.source.baseProposalSha256,
      selections: rawSelections,
      unresolvedConflicts,
    });

    const binding: NonNullable<CvRecognitionVersion['binding']> = {
      deterministicRecognitionVersionId: deterministic.id,
      sourceSha256: current.source.sha256,
      baseProposalSha256: input.source.baseProposalSha256,
      runSha256,
      proposalSha256: input.provenance.proposalSha256,
      artifactSha256,
    };
    const provider = input.provider ? validateProviderWitness(input.provider) : undefined;
    const existing = current.recognitionVersions!.find((version) => version.binding
      && recognitionBindingKey(version.binding) === recognitionBindingKey(binding));
    if (existing) {
      if (existing.binding!.artifactSha256 !== binding.artifactSha256
        || recognitionArtifactSha256(existing) !== binding.artifactSha256
        || JSON.stringify(existing.warnings) !== JSON.stringify(warnings)
        || JSON.stringify(existing.unresolvedConflicts ?? []) !== JSON.stringify(unresolvedConflicts)
        || JSON.stringify(existing.provider ?? null) !== JSON.stringify(provider ?? null)
        || (input.label !== undefined && existing.label !== cleanText(input.label, 120))) {
        dependencyFailure('Derselbe KI-Lauf und Vorschlag ist bereits mit einem abweichenden Payload gebunden.');
      }
      return {
        revision: current.revision,
        sha256: current.sha256,
        recognitionVersionId: existing.id,
        recognitionVersionCount: current.recognitionVersions!.length,
        factIds: existing.facts.map((fact) => fact.id),
      };
    }
    assertCas(current, input.expectedRevision, input.expectedSha256);
    assertRecognitionMutable(current);
    if (current.recognitionVersions!.length >= MAX_RECOGNITION_VERSIONS) {
      conflict(`Ein CV-Import darf hoechstens ${MAX_RECOGNITION_VERSIONS} Erkennungsstaende enthalten.`);
    }
    const ordinal = Math.max(...current.recognitionVersions!.map((version) => version.ordinal)) + 1;
    const now = new Date().toISOString();
    const version: CvRecognitionVersion = {
      id: newRecognitionVersionId(), ordinal, kind: 'ai',
      label: input.label === undefined ? `KI-Erkennung ${ordinal}` : cleanText(input.label, 120),
      createdAt: now, updatedAt: now,
      facts: validated,
      warnings,
      unresolvedConflicts,
      normalizationArtifact: structuredClone(input.normalizationArtifact),
      ...(provider ? { provider } : {}),
      binding,
    };
    const withVersion: CvImportRecord = {
      ...current,
      recognitionVersions: [...current.recognitionVersions!.map((item) => structuredClone(item)), version],
      activeRecognitionVersionId: version.id,
    };
    const projected = projectRecognitionVersion(withVersion, version);
    const saved = await this.save(current, {
      ...projected,
      status: recognitionStatus(version),
      adoption: undefined,
      proposal: undefined,
    });
    return {
      revision: saved.revision,
      sha256: saved.sha256,
      recognitionVersionId: version.id,
      recognitionVersionCount: saved.recognitionVersions!.length,
      factIds: version.facts.map((fact) => fact.id),
    };
  }

  async loadAiSource(id: string) {
    const current = await this.repository.get(id);
    if (!current) return undefined;
    if (current.adoption || current.status === 'adopted' || current.status === 'proposal_ready') {
      conflict('KI-Strukturierung ist nur vor der Uebernahme in das Kandidatenprofil moeglich. Korrekturen erfordern einen neuen Import.');
    }
    // Every AI run is rooted in the original deterministic import. An active AI version must
    // never recursively become the proposal/line-manifest base for another provider run.
    const deterministic = deterministicRecognitionVersion(current);
    const artifact = deterministic.normalizationArtifact;
    if (!isRecord(artifact) || !isRecord(artifact.source) || !isRecord(artifact.extraction)) {
      conflict('Dieser Import besitzt keine private, pruefbare CV-Strukturgrundlage. Bitte den Lebenslauf neu importieren.');
    }
    const manifest = artifact.extraction.line_manifest;
    if (!Array.isArray(manifest) || manifest.length < 1 || manifest.length > 20_000
      || manifest.some((entry, index) => !isRecord(entry) || entry.line !== index + 1
        || typeof entry.text !== 'string' || entry.text.length < 1 || entry.text.length > 20_000
        || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
        || createHash('sha256').update(entry.text, 'utf8').digest('hex') !== entry.sha256)) {
      conflict('Dieser Import besitzt noch keinen gebundenen Zeilenindex fuer die KI-Strukturierung. Bitte den Lebenslauf neu importieren.');
    }
    const sourceId = artifact.source.id;
    const sourceSha256 = artifact.source.sha256;
    const extractedTextSha256 = artifact.extraction.text_sha256;
    if (typeof sourceId !== 'string' || !/^source-cv-[a-f0-9]{16}$/.test(sourceId)
      || sourceSha256 !== current.source.sha256
      || typeof extractedTextSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(extractedTextSha256)) {
      conflict('Die private CV-Strukturgrundlage stimmt nicht mit der aktuellen Importquelle ueberein. Bitte neu importieren.');
    }
    const lineManifestJson = canonicalJson({
      contract: 'cv-line-manifest', contract_version: '1.0', lines: manifest,
    });
    return {
      id: current.id, revision: current.revision, sha256: current.sha256,
      deterministicRecognitionVersionId: deterministic.id,
      sourceId, sourceSha256, extractedTextSha256,
      baseProposalSha256: createHash('sha256').update(canonicalJson(artifact), 'utf8').digest('hex'),
      baseProposalArtifact: structuredClone(artifact), lineManifestJson,
      lineManifestSha256: createHash('sha256').update(lineManifestJson, 'utf8').digest('hex'),
    };
  }

  async findAiStage(input: Parameters<CvAiStructuringImportPort['findAiStage']>[0]) {
    assertUuid(input.id); assertUuid(input.runId);
    if (!/^[a-f0-9]{64}$/.test(input.aiProposalSha256)) {
      dependencyFailure('Die KI-Staging-Suche besitzt keine gueltige Vorschlagsbindung.');
    }
    const current = await this.repository.get(input.id);
    if (!current) return undefined;
    const facts = current.recognitionVersions!.flatMap((version) => version.facts.filter((fact) =>
      fact.provenance.recognition?.method === 'ai_assisted'
      && fact.provenance.recognition.runId === input.runId
      && fact.provenance.recognition.proposalSha256 === input.aiProposalSha256));
    if (facts.length === 0) return undefined;
    return {
      revision: current.revision,
      sha256: current.sha256,
      facts: facts.map((fact) => structuredClone(fact)),
    };
  }

  async stageAiStructure(input: Parameters<CvAiStructuringImportPort['stageAiStructure']>[0]) {
    assertUuid(input.id); assertUuid(input.runId);
    if (!/^[a-f0-9]{64}$/.test(input.aiProposalSha256)
      || !/^[a-f0-9]{64}$/.test(input.expectedBaseProposalSha256)
      || !/^[a-f0-9]{64}$/.test(input.mergedProposalSha256)
      || !isRecord(input.mergedArtifact)
      || createHash('sha256').update(canonicalJson(input.mergedArtifact), 'utf8').digest('hex') !== input.mergedProposalSha256) {
      dependencyFailure('Der validierte KI-Strukturmerge besitzt keine gueltige Hashbindung.');
    }
    const current = await this.require(input.id);
    assertCas(current, input.expectedRevision, input.expectedSha256);
    if (current.adoption || current.status === 'adopted' || current.status === 'proposal_ready') {
      conflict('Bereits uebernommene Lebenslauffakten koennen nicht durch einen KI-Vorschlag veraendert werden.');
    }
    if (!isRecord(current.normalizationArtifact)) dependencyFailure('Private CV-Strukturgrundlage fehlt.');
    if (createHash('sha256').update(canonicalJson(current.normalizationArtifact), 'utf8').digest('hex')
      !== input.expectedBaseProposalSha256) {
      conflict('Die gebundene CV-Strukturbasis wurde zwischenzeitlich verändert.');
    }
    assertArtifactMerge(current.normalizationArtifact, input.mergedArtifact, input.facts, {
      expectedBaseProposalSha256: input.expectedBaseProposalSha256,
      selections: input.selections,
    });
    const selections = validateAiSelections(input.selections);
    if (input.facts.length !== selections.size) {
      dependencyFailure('Jede bestaetigte KI-Auswahl muss genau einen pending Fakt erzeugen.');
    }
    const validated = validateNormalizedFacts(input.facts, current.source.sha256).map((fact) => {
      const recognition = fact.provenance.recognition;
      const selection = recognition?.suggestionId ? selections.get(recognition.suggestionId) : undefined;
      if (fact.provenance.recognition?.method !== 'ai_assisted'
        || !/^suggestion-[a-f0-9]{16}$/.test(recognition?.suggestionId ?? '')
        || !selection
        || (selection.alternativeId === null
          ? recognition?.selectedAlternativeId !== undefined
          : recognition?.selectedAlternativeId !== selection.alternativeId)) {
        dependencyFailure('KI-Strukturfakten besitzen keine gueltige Vorschlagsprovenienz.');
      }
      selections.delete(selection.suggestionId);
      return {
        ...fact,
        provenance: {
          ...fact.provenance,
          recognition: {
            ...fact.provenance.recognition,
            runId: input.runId,
            proposalSha256: input.aiProposalSha256,
          },
        },
      };
    });
    if (selections.size !== 0) dependencyFailure('Nicht jede bestaetigte KI-Auswahl wurde als Fakt projiziert.');
    const existingIds = new Set(current.facts.map((fact) => fact.id));
    if (validated.some((fact) => existingIds.has(fact.id)) || current.facts.length + validated.length > 2_000) {
      conflict('KI-Strukturfakten kollidieren mit der aktuellen Importrevision oder ueberschreiten das Faktenlimit.');
    }
    const deterministic = deterministicRecognitionVersion(current);
    const binding: NonNullable<CvRecognitionVersion['binding']> = {
      deterministicRecognitionVersionId: deterministic.id,
      sourceSha256: current.source.sha256,
      baseProposalSha256: input.expectedBaseProposalSha256,
      runSha256: createHash('sha256').update(input.runId, 'utf8').digest('hex'),
      proposalSha256: input.aiProposalSha256,
      artifactSha256: input.mergedProposalSha256,
    };
    if (current.recognitionVersions!.length >= MAX_RECOGNITION_VERSIONS) {
      conflict(`Ein CV-Import darf hoechstens ${MAX_RECOGNITION_VERSIONS} Erkennungsstaende enthalten.`);
    }
    if (current.recognitionVersions!.some((version) => version.binding
      && recognitionBindingKey(version.binding) === recognitionBindingKey(binding))) {
      conflict('Dieser KI-Lauf und Vorschlag wurden bereits als Erkennungsstand gespeichert.');
    }
    const ordinal = Math.max(...current.recognitionVersions!.map((version) => version.ordinal)) + 1;
    const now = new Date().toISOString();
    const version: CvRecognitionVersion = {
      id: newRecognitionVersionId(), ordinal, kind: 'ai', label: `KI-Erkennung ${ordinal}`,
      createdAt: now, updatedAt: now,
      facts: [...current.facts.map((fact) => structuredClone(fact)), ...validated],
      warnings: structuredClone(current.warnings),
      unresolvedConflicts: structuredClone(current.unresolvedConflicts),
      normalizationArtifact: structuredClone(input.mergedArtifact), binding,
    };
    const projected = projectRecognitionVersion({
      ...current,
      recognitionVersions: [...current.recognitionVersions!.map((item) => structuredClone(item)), version],
      activeRecognitionVersionId: version.id,
    }, version);
    const saved = await this.save(current, {
      ...projected, status: 'facts_pending', adoption: undefined, proposal: undefined,
    });
    return { revision: saved.revision, sha256: saved.sha256, stagedFactIds: validated.map((fact) => fact.id) };
  }

  async review(id: string, expectedRevision: number, expectedSha256: string, operations: CvFactOperation[]) {
    const current = await this.require(id);
    assertCas(current, expectedRevision, expectedSha256);
    if (current.adoption || current.status === 'adopted' || current.status === 'proposal_ready') {
      conflict('Bereits uebernommene Lebenslauffakten sind unveraenderlich. Korrekturen erfordern einen neuen Import.');
    }
    const facts = current.facts.map((fact) => structuredClone(fact));
    const newRecordIds = new Map<string, string>();
    for (const operation of operations) {
      if (operation.action === 'add') {
        if (operation.recordId && operation.newRecordKey) conflict('Neue Fakten dürfen recordId und newRecordKey nicht kombinieren.');
        let recordId: string;
        if (operation.recordId) {
          const owner = facts.find((fact) => fact.recordId === operation.recordId);
          if (!owner || owner.category !== operation.category) conflict('Zusatzfakt referenziert keine passende vorhandene Station.');
          recordId = owner.recordId;
        } else {
          const key = operation.newRecordKey;
          if (!key || !/^[a-z][a-z0-9-]{0,63}$/.test(key)) conflict('Neue strukturierte Records benötigen einen gültigen temporären newRecordKey.');
          recordId = newRecordIds.get(key) ?? `record-user-${randomUUID()}`;
          newRecordIds.set(key, recordId);
        }
        const addition = {
          id: `fact-user-${randomUUID()}`, category: operation.category, recordId,
          field: operation.field, value: operation.value,
          decision: operation.explicitlyConfirmed === true ? 'confirmed' : 'pending',
        } as const;
        facts.push(validateFact({
          ...addition,
          provenance: { sourceSha256: userFactSourceSha256(addition), anchor: `user:${new Date().toISOString()}`, origin: 'user_supplied' },
        }, current.source.sha256));
        continue;
      }
      const index = facts.findIndex((fact) => fact.id === operation.factId);
      if (index < 0) conflict(`Unbekannter Fakt: ${operation.factId}`);
      const original = facts[index]!;
      if (operation.action === 'edit') {
        if (operation.recordId !== original.recordId) conflict('Edit darf einen Fakt nicht in einen fremden Record verschieben.');
        facts[index] = { ...original, decision: 'rejected' };
        const replacement = {
          id: `fact-user-${randomUUID()}`, category: operation.category, recordId: operation.recordId,
          field: operation.field, value: operation.value, decision: 'pending',
        } as const;
        facts.push(validateFact({
          ...replacement,
          provenance: { sourceSha256: userFactSourceSha256(replacement), anchor: `user:${new Date().toISOString()}`, origin: 'user_supplied' },
        }, current.source.sha256));
      } else facts[index] = { ...original, decision: operation.action === 'confirm' ? 'confirmed' : 'rejected' };
    }
    if (facts.length > 2_000) conflict('Ein Lebenslaufimport darf hoechstens 2000 atomare Fakten enthalten.');
    await this.normalization.validateUserFacts(facts.filter((fact) => fact.provenance.origin === 'user_supplied'));
    const next = syncActiveRecognitionVersion({
      ...current, facts, status: facts.some((fact) => fact.decision === 'pending') ? 'facts_pending' : 'facts_reviewed',
      adoption: undefined, proposal: undefined,
    }, new Date().toISOString());
    return this.save(current, next);
  }

  async setTheme(id: string, expectedRevision: number, expectedSha256: string, theme?: CvTheme) {
    const current = await this.require(id);
    assertCas(current, expectedRevision, expectedSha256);
    const normalized = theme ? normalizeTheme(theme) : undefined;
    return this.save(current, { ...current, theme: normalized, proposal: undefined });
  }

  /** Render a skeleton preview of the given theme so the user can compare ATS vs. original layout in step 4. */
  /**
   * Renders an incognito application for viewing and download.
   *
   * The normal document path runs through artifact adoption and case release,
   * both of which are closed for incognito, so an incognito case could never
   * see its own result. This path deliberately bypasses neither: it renders
   * from the agent artifact directly, persists nothing, and writes no
   * `proposal` record, so nothing here can be mistaken for — or promoted to —
   * an approved document revision. Adoption, case release, `used` and export
   * stay blocked exactly as before.
   *
   * The banner is injected into the document itself rather than the surrounding
   * UI, because the file is downloadable and the marking has to survive that.
   */
  async renderIncognitoPreview(id: string, input: {
    artifactId: string;
    artifactLifecycle: 'proposed' | 'approved';
    documentContent: string;
  }) {
    const current = await this.require(id);
    if (!current.adoption) {
      conflict('Der Lebenslauf muss vor der Vorschau in das CandidateProfile übernommen werden.');
    }
    const rendered = renderHtml(sectionsFromDocument(input.documentContent), current.theme);
    const html = withIncognitoBanner(rendered, input.artifactLifecycle);
    return {
      contract: 'cv-incognito-preview' as const,
      contractVersion: '1.0' as const,
      importId: current.id,
      artifactId: input.artifactId,
      artifactLifecycle: input.artifactLifecycle,
      html,
      htmlSha256: createHash('sha256').update(html).digest('hex'),
      /** Never a document revision; deliberately not persisted on the record. */
      usableAsDocumentRevision: false as const,
    };
  }

  async previewTheme(id: string, theme: CvTheme) {
    const current = await this.require(id);
    const normalized = normalizeTheme(theme);
    const html = renderThemePreview(normalized, current.layoutFingerprint);
    return { html, htmlSha256: createHash('sha256').update(html).digest('hex') };
  }

  /** Run the local deterministic ATS check against the theme preview or the released proposal HTML. */
  async atsCheck(
    id: string, source: 'theme-preview' | 'proposal', keywords: { mustHave?: string[]; niceToHave?: string[] } = {},
  ): Promise<AtsCheckReport> {
    const current = await this.require(id);
    let html: string;
    if (source === 'proposal') {
      if (!current.proposal) conflict('Es liegt noch kein freigegebenes HTML vor. Bitte zuerst die Agentenkette und Freigabe abschließen.');
      html = current.proposal.html;
    } else {
      const theme = current.theme ? normalizeTheme(current.theme) : DEFAULT_ATS_THEME;
      html = renderThemePreview(theme, current.layoutFingerprint);
    }
    return checkAtsHtml(html, keywords);
  }

  async adopt(id: string, expectedRevision: number, expectedSha256: string) {
    const current = await this.require(id);
    assertCas(current, expectedRevision, expectedSha256);
    if (current.adoption || current.status === 'adopted' || current.status === 'proposal_ready') {
      conflict('Dieser Lebenslaufimport wurde bereits in das CandidateProfile uebernommen.');
    }
    if ((current.unresolvedConflicts?.length ?? 0) > 0) {
      conflict(`Der Lebenslaufimport enthält ${current.unresolvedConflicts!.length} ungelöste Faktenkonflikte. Bitte die CV-Quelle korrigieren und neu importieren.`);
    }
    if (current.facts.some((fact) => fact.decision === 'pending')) conflict('Alle importierten Fakten müssen zuerst bestätigt oder verworfen werden.');
    const confirmed = current.facts.filter((fact) => fact.decision === 'confirmed');
    if (confirmed.length === 0) conflict('Mindestens ein Fakt muss ausdrücklich bestätigt werden.');
    const adopted = await this.normalization.adopt({
      importId: current.id, sourceSha256: current.source.sha256, facts: current.facts,
      artifact: current.normalizationArtifact,
    });
    if (adopted.contract !== 'cv-profile-adoption' || adopted.contractVersion !== '1.0'
      || adopted.adoptedClaimIds.length === 0 || !/^[a-f0-9]{64}$/.test(adopted.candidateProfileSha256)) {
      dependencyFailure('Der CV-Adopt-Vertrag lieferte keinen prüfbaren CandidateProfile-Nachweis.');
    }
    const activeRecognition = activeRecognitionVersion(current);
    return this.save(current, {
      ...current, status: 'adopted',
      adoption: {
        adoptedClaimIds: adopted.adoptedClaimIds, adoptedRecordIds: adopted.adoptedRecordIds,
        candidateProfileSha256: adopted.candidateProfileSha256,
        candidateProfileRevision: adopted.candidateProfileRevision,
        adoptedAt: new Date().toISOString(),
        recognitionVersionId: activeRecognition.id,
        recognitionVersionSha256: recognitionVersionSha256(activeRecognition),
        ...(adopted.transactionId ? { transactionId: adopted.transactionId } : {}),
        ...(adopted.replacedSnapshotId ? { replacedSnapshotId: adopted.replacedSnapshotId } : {}),
        ...(adopted.alreadyAdopted ? { alreadyAdopted: true as const } : {}),
      },
      proposal: undefined,
    });
  }

  /**
   * Adoptions of *this* import's source that are still revocable. The server record can lose its
   * adoption link (a re-review clears it) while the claims stay in the profile, so the profile
   * history — not the record — decides what can still be revoked.
   */
  async revocableAdoptions(id: string): Promise<{
    contract: 'cv-adoption-revocation-candidates'; contractVersion: '1.0';
    importId: string; candidateProfileSha256: string; adoptions: CvAdoptionLedgerEntry[];
  }> {
    const current = await this.require(id);
    const ledger = await this.normalization.adoptionLedger();
    return {
      contract: 'cv-adoption-revocation-candidates', contractVersion: '1.0',
      importId: current.id, candidateProfileSha256: ledger.candidateProfileSha256,
      adoptions: ledger.adoptions.filter((entry) => entry.sourceSha256 === current.source.sha256),
    };
  }

  /**
   * Discards a committed adoption of this import's source. The transaction must belong to this
   * import's source, so one import can never revoke another one's claims.
   */
  async revokeAdoption(id: string, expectedRevision: number, expectedSha256: string, transactionId: string) {
    const current = await this.require(id);
    assertCas(current, expectedRevision, expectedSha256);
    const ledger = await this.normalization.adoptionLedger();
    const entry = ledger.adoptions.find((item) => item.transactionId === transactionId);
    if (!entry) {
      conflict('Diese Übernahme ist im CandidateProfile nicht mehr als widerrufbar verzeichnet.');
    }
    if (entry.sourceSha256 !== current.source.sha256) {
      conflict('Die angegebene Übernahme gehört nicht zu diesem Lebenslaufimport.');
    }
    const revoked = await this.normalization.revokeAdoption({ transactionId });
    if (revoked.contract !== 'cv-profile-adoption-revocation' || revoked.contractVersion !== '1.0'
      || !/^[a-f0-9]{64}$/.test(revoked.candidateProfileSha256)) {
      dependencyFailure('Der CV-Revoke-Vertrag lieferte keinen prüfbaren CandidateProfile-Nachweis.');
    }
    return this.save(current, {
      ...current,
      // Back to a reviewed state so the confirmed facts can be adopted again.
      status: current.status === 'facts_pending' ? 'facts_pending' : 'facts_reviewed',
      adoption: undefined, proposal: undefined,
    });
  }

  async profileSnapshots(id: string): Promise<{
    contract: 'cv-profile-snapshot-list'; contractVersion: '1.0';
    importId: string; candidateProfileSha256: string; snapshots: CvProfileSnapshot[];
  }> {
    const current = await this.require(id);
    const listed = await this.normalization.profileSnapshots();
    return {
      contract: 'cv-profile-snapshot-list', contractVersion: '1.0',
      importId: current.id, candidateProfileSha256: listed.candidateProfileSha256,
      snapshots: listed.snapshots,
    };
  }

  /** Rolls the whole candidate profile back to a stored snapshot, including overwritten scalars. */
  async restoreProfileSnapshot(id: string, expectedRevision: number, expectedSha256: string, snapshotId: string) {
    const current = await this.require(id);
    assertCas(current, expectedRevision, expectedSha256);
    const restored = await this.normalization.restoreProfileSnapshot({ snapshotId });
    if (restored.contract !== 'cv-profile-snapshot-restore' || restored.contractVersion !== '1.0'
      || !/^[a-f0-9]{64}$/.test(restored.candidateProfileSha256)) {
      dependencyFailure('Der CV-Snapshot-Vertrag lieferte keinen prüfbaren CandidateProfile-Nachweis.');
    }
    // A rollback invalidates any adoption proof this record still carries.
    return this.save(current, {
      ...current,
      status: current.status === 'facts_pending' ? 'facts_pending' : 'facts_reviewed',
      adoption: undefined, proposal: undefined,
    });
  }

  async renderApproved(id: string, expectedRevision: number, expectedSha256: string, input: {
    applicationCaseId: string; jobId: string; identityMode: 'real' | 'incognito';
    documentRevisionId: string; documentSha256: string; documentContent: string;
    pipeline: {
      candidateProfileSha256: string; styleProfileSha256: string; artifactSha256: string;
      pipelineContractVersion: string; completedStages: string[];
    };
    styleProfile: { revision: number; sha256: string };
    sourceAgentArtifactId: string;
  }) {
    const current = await this.require(id);
    assertCas(current, expectedRevision, expectedSha256);
    if (!current.adoption || current.status === 'facts_pending' || current.status === 'facts_reviewed') {
      conflict('Der Lebenslauf muss vor dem Rendern in das CandidateProfile übernommen werden.');
    }
    const activeRecognition = activeRecognitionVersion(current);
    if ((current.adoption.recognitionVersionId && current.adoption.recognitionVersionId !== activeRecognition.id)
      || (current.adoption.recognitionVersionSha256
        && current.adoption.recognitionVersionSha256 !== recognitionVersionSha256(activeRecognition))) {
      conflict('Der aktive Erkennungsstand stimmt nicht mit der uebernommenen CandidateProfile-Grundlage ueberein.');
    }
    if (input.pipeline.candidateProfileSha256 !== current.adoption.candidateProfileSha256) {
      conflict('Agentenlauf und importierte CandidateProfile-Revision stimmen nicht überein.');
    }
    if (input.pipeline.styleProfileSha256 !== input.styleProfile.sha256
      || input.pipeline.artifactSha256 !== input.documentSha256
      || createHash('sha256').update(input.documentContent).digest('hex') !== input.documentSha256) {
      conflict('Dokument, Stilprofil oder Pipeline-Nachweis stimmen nicht mit der freigegebenen Revision überein.');
    }
    const html = renderHtml(sectionsFromDocument(input.documentContent), current.theme);
    return this.save(current, {
      ...current, status: 'proposal_ready', proposal: {
        applicationCaseId: input.applicationCaseId, jobId: input.jobId, createdAt: new Date().toISOString(), html,
        htmlSha256: createHash('sha256').update(html).digest('hex'),
        documentRevisionId: input.documentRevisionId, documentSha256: input.documentSha256,
        lifecycle: 'approved_revision_preview', format: 'html', downloadAllowed: input.identityMode === 'real',
        inputSnapshot: {
          cvImportRevision: current.revision, cvImportSha256: current.sha256,
          candidateProfileSha256: input.pipeline.candidateProfileSha256,
          candidateProfileRevision: current.adoption.candidateProfileRevision,
          styleProfileRevision: input.styleProfile.revision, styleProfileSha256: input.styleProfile.sha256,
          ...(current.theme ? { themeSha256: recordHash(current.theme) } : {}),
          agentWorkflowId: 'evidence-application-package',
          sourceAgentArtifactId: input.sourceAgentArtifactId,
          pipelineContractVersion: input.pipeline.pipelineContractVersion,
          completedStages: [...input.pipeline.completedStages], agentOrchestrationRequired: false,
          recognitionVersionId: activeRecognition.id,
          recognitionVersionSha256: recognitionVersionSha256(activeRecognition),
        },
      },
    });
  }

  private async require(id: string) { assertUuid(id); const record = await this.repository.get(id); if (!record) notFound(); return record; }
  private async save(previous: CvImportRecord, next: Omit<CvImportRecord, 'revision' | 'sha256' | 'updatedAt'> & Partial<Pick<CvImportRecord, 'revision' | 'sha256' | 'updatedAt'>>) {
    const draft = { ...next, revision: previous.revision + 1, updatedAt: new Date().toISOString() };
    const saved = materializeRecognitionRecord({ ...draft, sha256: recordHash(draft) } as CvImportRecord);
    await this.repository.compareAndSave(previous.id, previous.revision, previous.sha256, saved);
    return saved;
  }
}

function recognitionVersionId(importId: string, sourceSha256: string) {
  return `recognition-${createHash('sha256')
    .update(`cv-recognition-version/legacy/${importId}/${sourceSha256}`, 'utf8').digest('hex').slice(0, 16)}`;
}

function newRecognitionVersionId() { return `recognition-${randomBytes(8).toString('hex')}`; }

function materializeRecognitionRecord(record: CvImportRecord): CvImportRecord {
  const current = structuredClone(record);
  if (current.layoutFingerprint !== undefined) {
    const fingerprint = validateLayoutFingerprint(current.layoutFingerprint);
    if (fingerprint) current.layoutFingerprint = fingerprint; else delete current.layoutFingerprint;
  }
  if (current.recognitionVersions === undefined && current.activeRecognitionVersionId === undefined) {
    const version: CvRecognitionVersion = {
      id: recognitionVersionId(current.id, current.source.sha256), ordinal: 1, kind: 'deterministic',
      label: 'Deterministische Erkennung', createdAt: current.createdAt, updatedAt: current.updatedAt,
      facts: structuredClone(current.facts), warnings: structuredClone(current.warnings),
      unresolvedConflicts: structuredClone(current.unresolvedConflicts),
      normalizationArtifact: structuredClone(current.normalizationArtifact),
    };
    current.recognitionVersions = [version];
    current.activeRecognitionVersionId = version.id;
    return current;
  }
  if (!Array.isArray(current.recognitionVersions)
    || current.recognitionVersions.length < 1
    || current.recognitionVersions.length > MAX_RECOGNITION_VERSIONS
    || typeof current.activeRecognitionVersionId !== 'string') {
    dependencyFailure('Der gespeicherte CV-Import besitzt keinen gueltigen Erkennungsstand-Vertrag.');
  }
  const ids = new Set<string>(); const ordinals = new Set<number>();
  current.recognitionVersions = current.recognitionVersions.map((raw) => {
    const version = validateStoredRecognitionVersion(raw, current.source.sha256);
    if (ids.has(version.id) || ordinals.has(version.ordinal)) {
      dependencyFailure('Der gespeicherte CV-Import besitzt doppelte Erkennungsstaende oder Ordinalzahlen.');
    }
    ids.add(version.id); ordinals.add(version.ordinal); return version;
  }).sort((left, right) => left.ordinal - right.ordinal);
  if (current.recognitionVersions.some((version, index) => version.ordinal !== index + 1)
    || current.recognitionVersions.filter((version) => version.kind === 'deterministic').length !== 1
    || current.recognitionVersions[0]!.kind !== 'deterministic'
    || current.recognitionVersions.some((version) => version.kind === 'ai'
      && version.binding?.deterministicRecognitionVersionId !== current.recognitionVersions![0]!.id)) {
    dependencyFailure('Der gespeicherte CV-Import besitzt keine eindeutige deterministische Erkennungsbasis.');
  }
  const bindingKeys = current.recognitionVersions.filter((version) => version.binding)
    .map((version) => recognitionBindingKey(version.binding!));
  if (new Set(bindingKeys).size !== bindingKeys.length) {
    dependencyFailure('Der gespeicherte CV-Import besitzt doppelte KI-Lauf- oder Vorschlagsbindungen.');
  }
  const active = current.recognitionVersions.find((version) => version.id === current.activeRecognitionVersionId);
  if (!active || !recognitionProjectionMatches(current, active)) {
    dependencyFailure('Die aktive CV-Projektion stimmt nicht mit ihrem Erkennungsstand ueberein.');
  }
  return current;
}

function validateStoredRecognitionVersion(version: CvRecognitionVersion, sourceSha256: string): CvRecognitionVersion {
  if (!version || !RECOGNITION_VERSION_ID.test(version.id)
    || !Number.isSafeInteger(version.ordinal) || version.ordinal < 1 || version.ordinal > MAX_RECOGNITION_VERSIONS
    || !['deterministic', 'ai'].includes(version.kind)
    || typeof version.label !== 'string'
    || !Number.isFinite(Date.parse(version.createdAt)) || !Number.isFinite(Date.parse(version.updatedAt))
    || Date.parse(version.updatedAt) < Date.parse(version.createdAt)
    || !Array.isArray(version.facts) || version.facts.length < 1 || version.facts.length > 2_000) {
    dependencyFailure('Der gespeicherte CV-Import enthaelt einen ungueltigen Erkennungsstand.');
  }
  const ids = new Set<string>();
  const facts = version.facts.map((fact) => {
    if (!['pending', 'confirmed', 'rejected'].includes(fact.decision)) {
      dependencyFailure('Ein gespeicherter Erkennungsstand besitzt eine ungueltige Fact-Entscheidung.');
    }
    const checked = validateFact(fact, sourceSha256);
    if (ids.has(checked.id)) dependencyFailure('Ein gespeicherter Erkennungsstand besitzt doppelte Fact-IDs.');
    ids.add(checked.id); return checked;
  });
  if (version.normalizationArtifact !== undefined) canonicalJson(version.normalizationArtifact);
  const binding = version.binding === undefined ? undefined : validateRecognitionBinding(version.binding);
  if ((version.kind === 'deterministic' && binding !== undefined)
    || (version.kind === 'ai' && binding === undefined)) {
    dependencyFailure('Ein gespeicherter Erkennungsstand besitzt eine ungueltige KI-Bindung.');
  }
  return {
    ...structuredClone(version),
    label: cleanText(version.label, 120), facts,
    warnings: validateWarnings(version.warnings),
    unresolvedConflicts: validateConflicts(version.unresolvedConflicts ?? []),
    ...(version.provider ? { provider: validateProviderWitness(version.provider) } : {}),
    ...(binding ? { binding } : {}),
  };
}

function validateRecognitionBinding(binding: NonNullable<CvRecognitionVersion['binding']>) {
  if (!binding || !RECOGNITION_VERSION_ID.test(binding.deterministicRecognitionVersionId)
    || !SHA256.test(binding.sourceSha256) || !SHA256.test(binding.baseProposalSha256)
    || !SHA256.test(binding.runSha256) || !SHA256.test(binding.proposalSha256)
    || !SHA256.test(binding.artifactSha256)) {
    dependencyFailure('Ein gespeicherter KI-Erkennungsstand besitzt eine ungueltige Hashbindung.');
  }
  return structuredClone(binding);
}

function validateProviderWitness(provider: CvRecognitionProviderWitness): CvRecognitionProviderWitness {
  if (!provider || !SAFE_COMPONENT_ID.test(provider.id)
    || !['windows', 'wsl'].includes(provider.runtimeTarget)
    || typeof provider.version !== 'string' || typeof provider.adapterVersion !== 'string'
    || (provider.witnessSha256 !== undefined && !SHA256.test(provider.witnessSha256))) {
    dependencyFailure('Der KI-Erkennungsstand besitzt keinen gueltigen Provider-Nachweis.');
  }
  return {
    id: provider.id, runtimeTarget: provider.runtimeTarget,
    version: cleanText(provider.version, 120), adapterVersion: cleanText(provider.adapterVersion, 120),
    ...(provider.witnessSha256 ? { witnessSha256: provider.witnessSha256 } : {}),
  };
}

function validateWarnings(warnings: string[]) {
  if (!Array.isArray(warnings) || warnings.length > 100) dependencyFailure('Der Erkennungsstand besitzt ungueltige Warnungen.');
  return warnings.map((warning) => cleanText(warning, 500));
}

function recognitionProjectionMatches(record: CvImportRecord, version: CvRecognitionVersion) {
  const recordProjection = {
    facts: record.facts, warnings: record.warnings,
    unresolvedConflicts: record.unresolvedConflicts ?? [],
    normalizationArtifact: record.normalizationArtifact ?? null,
  };
  const versionProjection = {
    facts: version.facts, warnings: version.warnings,
    unresolvedConflicts: version.unresolvedConflicts ?? [],
    normalizationArtifact: version.normalizationArtifact ?? null,
  };
  return canonicalJson(JSON.parse(JSON.stringify(recordProjection)))
    === canonicalJson(JSON.parse(JSON.stringify(versionProjection)));
}

function activeRecognitionVersion(record: CvImportRecord) {
  const version = record.recognitionVersions?.find((candidate) => candidate.id === record.activeRecognitionVersionId);
  if (!version) dependencyFailure('Der aktive Erkennungsstand fehlt.');
  return version;
}

function deterministicRecognitionVersion(record: CvImportRecord) {
  const version = record.recognitionVersions?.find((candidate) => candidate.kind === 'deterministic');
  if (!version) dependencyFailure('Der deterministische Basisstand fehlt.');
  return version;
}

function projectRecognitionVersion(record: CvImportRecord, version: CvRecognitionVersion): CvImportRecord {
  return {
    ...record,
    activeRecognitionVersionId: version.id,
    facts: version.facts.map((fact) => structuredClone(fact)),
    warnings: structuredClone(version.warnings),
    unresolvedConflicts: structuredClone(version.unresolvedConflicts),
    normalizationArtifact: structuredClone(version.normalizationArtifact),
  };
}

function syncActiveRecognitionVersion(record: CvImportRecord, updatedAt: string): CvImportRecord {
  const active = activeRecognitionVersion(record);
  const versions = record.recognitionVersions!.map((version) => version.id === active.id ? {
    ...version, updatedAt,
    facts: record.facts.map((fact) => structuredClone(fact)),
    warnings: structuredClone(record.warnings),
    unresolvedConflicts: structuredClone(record.unresolvedConflicts),
    normalizationArtifact: structuredClone(record.normalizationArtifact),
  } : structuredClone(version));
  return { ...record, recognitionVersions: versions };
}

function recognitionStatus(version: CvRecognitionVersion): Extract<CvImportStatus, 'facts_pending' | 'facts_reviewed'> {
  return version.facts.some((fact) => fact.decision === 'pending') ? 'facts_pending' : 'facts_reviewed';
}

function recognitionArtifactSha256(version: CvRecognitionVersion) {
  if (!isRecord(version.normalizationArtifact)) dependencyFailure('Der deterministische Basisstand besitzt kein privates Strukturartefakt.');
  return createHash('sha256').update(canonicalJson(version.normalizationArtifact), 'utf8').digest('hex');
}

function recognitionVersionSha256(version: CvRecognitionVersion) {
  return createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(version))), 'utf8').digest('hex');
}

function recognitionBindingKey(binding: NonNullable<CvRecognitionVersion['binding']>) {
  return canonicalJson({
    deterministicRecognitionVersionId: binding.deterministicRecognitionVersionId,
    sourceSha256: binding.sourceSha256,
    baseProposalSha256: binding.baseProposalSha256,
    runSha256: binding.runSha256,
    proposalSha256: binding.proposalSha256,
  });
}

function assertRecognitionMutable(record: CvImportRecord) {
  if (record.adoption || record.status === 'adopted' || record.status === 'proposal_ready') {
    conflict('Erkennungsstaende koennen nach Adoption oder Dokumentfreigabe nicht mehr gewechselt oder erzeugt werden.');
  }
}

function validateSource(input: { fileName: string; mimeType: keyof typeof CV_MIME_TYPES; data: Buffer }) {
  if (input.data.length < 1 || input.data.length > MAX_SOURCE_BYTES) badRequest('Lebenslaufdatei muss zwischen 1 Byte und 10 MiB groß sein.');
  const fileName = basename(input.fileName);
  if (fileName !== input.fileName || fileName.length > 240 || /[\u0000-\u001f\u007f]/.test(fileName)) badRequest('Ungültiger Dateiname.');
  const extensions = CV_MIME_TYPES[input.mimeType];
  if (!extensions || !(extensions as readonly string[]).includes(extname(fileName).toLowerCase())) badRequest('Dateiendung und Medientyp passen nicht zusammen.');
  if (input.mimeType === 'application/pdf' && input.data.subarray(0, 5).toString() !== '%PDF-') badRequest('Ungültige PDF-Signatur.');
  if ((input.mimeType.endsWith('document') || input.mimeType.endsWith('text')) && input.mimeType !== 'text/html'
    && input.data.subarray(0, 2).toString() !== 'PK') badRequest('Ungültige ZIP-Dokumentsignatur.');
  return { fileName, mimeType: input.mimeType, bytes: input.data.length, sha256: createHash('sha256').update(input.data).digest('hex') };
}

async function extractCvText(mimeType: keyof typeof CV_MIME_TYPES, buffer: Buffer): Promise<{ text: string; warnings: Array<{ code: string; detail: string }> }> {
  let text: string; const warnings: Array<{ code: string; detail: string }> = [];
  if (mimeType === 'text/html') {
    let html: string;
    try { html = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { badRequest('HTML-Lebenslauf muss gültiges UTF-8 sein.'); }
    const parts: string[] = []; let ignoredDepth = 0; let ignoredActive = 0; let externalReferences = 0;
    const ignored = new Set(['script', 'style', 'template', 'noscript', 'svg', 'canvas', 'iframe', 'object', 'embed']);
    const blocks = new Set(['address', 'article', 'blockquote', 'br', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr']);
    const parser = new HtmlParser({
      onopentag(name, attributes) {
        if (ignored.has(name)) { ignoredDepth += 1; ignoredActive += 1; }
        if (blocks.has(name)) parts.push('\n');
        externalReferences += Object.entries(attributes).filter(([key, value]) => ['src', 'href', 'action'].includes(key.toLowerCase()) && /^(?:https?:)?\/\//i.test(value)).length;
      },
      ontext(value) { if (ignoredDepth === 0) parts.push(value); },
      onclosetag(name) { if (ignored.has(name) && ignoredDepth > 0) ignoredDepth -= 1; if (blocks.has(name)) parts.push('\n'); },
    }, { decodeEntities: true, lowerCaseTags: true, recognizeSelfClosing: true });
    parser.write(html); parser.end(); text = parts.join('');
    if (ignoredActive > 0) warnings.push({ code: 'active_html_ignored', detail: `${ignoredActive} aktive oder nicht-textuelle HTML-Elemente wurden ignoriert.` });
    if (externalReferences > 0) warnings.push({ code: 'external_html_references_ignored', detail: `${externalReferences} externe HTML-Referenzen wurden nicht geladen.` });
  } else if (mimeType === 'application/pdf') {
    const rawPdf = buffer.toString('latin1');
    if (/\/(?:JavaScript|JS|OpenAction|AA|Launch|RichMedia|EmbeddedFile|SubmitForm|ImportData|GoToR)\b/i.test(rawPdf)
      || /\/Encrypt\b/i.test(rawPdf)) badRequest('PDF mit direkt erkennbaren aktiven oder verschlüsselten Inhalten wird nicht akzeptiert.');
    const parser = new PDFParse({ data: buffer, isEvalSupported: false, stopAtErrors: true });
    try {
      const result = await parser.getText({ first: 100, pageJoiner: '' });
      text = result.text; warnings.push(...pdfExtractionWarnings(result.total, text));
    } finally { await parser.destroy(); }
  } else {
    preflightZip(buffer);
    const zip = await JSZip.loadAsync(buffer, { checkCRC32: false });
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const names = Object.keys(zip.files);
      const contentTypes = await zip.file('[Content_Types].xml')?.async('string');
      if (!contentTypes || /macroEnabled|vbaProject|oleObject|activeX/i.test(contentTypes)
        || names.some((name) => /(^|\/)(?:vbaProject\.bin|activeX\/|embeddings\/|customUI\/)|\.(?:bin|vbs|js)$/i.test(name))) badRequest('DOCX mit Makros, OLE-Objekten oder ungültiger Struktur wird nicht akzeptiert.');
      validateDocxContentTypes(contentTypes);
      const packageRelationships = await zip.file('_rels/.rels')?.async('string');
      if (!packageRelationships) badRequest('DOCX besitzt keine Paketbeziehung zum Word-Hauptteil.');
      validateDocxRelationships(packageRelationships, true);
      for (const name of names.filter((candidate) => candidate.toLowerCase().endsWith('.rels'))) {
        if (name !== '_rels/.rels') validateDocxRelationships(await zip.file(name)!.async('string'), false);
      }
      const documentXml = await zip.file('word/document.xml')?.async('string');
      if (!documentXml) badRequest('DOCX enthält keinen deklarierten Word-Hauptteil.');
      text = xmlParagraphText(documentXml, new Set(['p']));
    } else {
      if (Object.keys(zip.files).some((name) => /(^|\/)(?:Scripts?|Basic)\//i.test(name) || /\.(?:js|vbs|bin)$/i.test(name))) badRequest('ODT mit aktiven Inhalten wird nicht akzeptiert.');
      const manifest = await zip.file('META-INF/manifest.xml')?.async('string');
      if (!manifest || /encryption-data|<[^>]*(?:script|event-listeners?)[^>]*>/i.test(manifest)) badRequest('Aktive, verschlüsselte oder ungültige ODT-Datei wird nicht akzeptiert.');
      const xml = await zip.file('content.xml')?.async('string');
      if (!xml) badRequest('ODT enthält kein content.xml.');
      if (/<[^>]*(?:script|event-listeners?)[^>]*>|xlink:href\s*=\s*["'](?:https?:)?\/\//i.test(xml!)) badRequest('ODT mit Skripten oder externen Beziehungen wird nicht akzeptiert.');
      text = xmlParagraphText(xml!, new Set(['p', 'h']));
    }
  }
  text = text.replace(/\r/g, '').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!text || text.length > MAX_EXTRACTED_CHARACTERS) badRequest('Der extrahierte Lebenslauf ist leer oder größer als 2 Millionen Zeichen.');
  return { text, warnings };
}

function preflightZip(buffer: Buffer) {
  let eocd = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65_557); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0 || buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) badRequest('Dokumentarchiv besitzt kein sicheres zentrales Verzeichnis.');
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8); const entries = buffer.readUInt16LE(eocd + 10);
  const directoryBytes = buffer.readUInt32LE(eocd + 12); const directoryOffset = buffer.readUInt32LE(eocd + 16);
  const archiveCommentLength = buffer.readUInt16LE(eocd + 20);
  if (eocd + 22 + archiveCommentLength !== buffer.length || entriesOnDisk !== entries
    || entries < 1 || entries > MAX_ZIP_ENTRIES || directoryOffset + directoryBytes !== eocd) {
    badRequest('Dokumentarchiv überschreitet oder verschleiert Strukturgrenzen.');
  }
  let cursor = directoryOffset; let total = 0; const names = new Set<string>();
  const localRanges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50) badRequest('Dokumentarchiv besitzt einen ungültigen Central-Directory-Eintrag.');
    const flags = buffer.readUInt16LE(cursor + 8); const method = buffer.readUInt16LE(cursor + 10);
    const crc32 = buffer.readUInt32LE(cursor + 16);
    const compressed = buffer.readUInt32LE(cursor + 20); const expanded = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28); const extraLength = buffer.readUInt16LE(cursor + 30); const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42); const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || (flags & 1) !== 0 || ![0, 8].includes(method) || localOffset >= directoryOffset
      || compressed === 0xffff_ffff || expanded === 0xffff_ffff || localOffset === 0xffff_ffff
      || expanded > MAX_UNCOMPRESSED_BYTES || (compressed === 0 && expanded > 0)
      || (compressed > 0 && expanded / compressed > 100)) badRequest('Dokumentarchiv enthält unsichere oder übermäßig komprimierte Einträge.');
    const name = decodeZipName(buffer, cursor + 46, nameLength, flags); const key = name.toLocaleLowerCase('en-US');
    if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some((part) => part === '..') || names.has(key)) badRequest('Dokumentarchiv enthält doppelte oder unsichere Pfade.');

    if (localOffset + 30 > directoryOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) badRequest('Dokumentarchiv besitzt keinen gültigen lokalen Dateikopf.');
    const localFlags = buffer.readUInt16LE(localOffset + 6); const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localCrc32 = buffer.readUInt32LE(localOffset + 14); const localCompressed = buffer.readUInt32LE(localOffset + 18); const localExpanded = buffer.readUInt32LE(localOffset + 22);
    const localNameLength = buffer.readUInt16LE(localOffset + 26); const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength; const dataEnd = dataOffset + compressed;
    if (localFlags !== flags || localMethod !== method || dataOffset > directoryOffset || dataEnd > directoryOffset
      || decodeZipName(buffer, localOffset + 30, localNameLength, localFlags) !== name
      || ((flags & 0x8) === 0 && (localCrc32 !== crc32 || localCompressed !== compressed || localExpanded !== expanded))
      || ((flags & 0x8) !== 0 && ((localCompressed !== 0 && localCompressed !== compressed) || (localExpanded !== 0 && localExpanded !== expanded)))) {
      badRequest('Dokumentarchiv enthält widersprüchliche lokale und zentrale Dateiköpfe.');
    }
    localRanges.push({ start: localOffset, end: dataEnd });
    names.add(key); total += expanded;
    if (total > MAX_UNCOMPRESSED_BYTES) badRequest('Dokumentarchiv ist entpackt größer als 20 MiB.');
    cursor = end;
  }
  if (cursor !== directoryOffset + directoryBytes) badRequest('Dokumentarchiv enthält inkonsistente Verzeichnisgrenzen.');
  localRanges.sort((left, right) => left.start - right.start);
  if (localRanges.some((range, index) => index > 0 && range.start < localRanges[index - 1]!.end)) {
    badRequest('Dokumentarchiv enthält überlappende lokale Dateibereiche.');
  }
}

function decodeZipName(buffer: Buffer, offset: number, length: number, flags: number) {
  if (length < 1 || offset < 0 || offset + length > buffer.length) badRequest('Dokumentarchiv enthält ungültige Dateinamen.');
  try {
    return new TextDecoder((flags & 0x800) !== 0 ? 'utf-8' : 'windows-1252', { fatal: true })
      .decode(buffer.subarray(offset, offset + length)).replaceAll('\\', '/');
  } catch { badRequest('Dokumentarchiv enthält ungültige Dateinamen.'); }
}

export function pdfExtractionWarnings(totalPages: number, text: string) {
  const warnings = [{
    code: 'pdf_passive_best_effort',
    detail: 'PDF-Text wurde ausschließlich passiv extrahiert. Die Markerprüfung erkennt direkte aktive Inhalte, ist aber keine vollständige PDF-Sicherheitsanalyse.',
  }];
  if (totalPages > 100) warnings.push({
    code: 'pdf_page_limit', detail: `Das PDF hat ${totalPages} Seiten; für diesen Import wurden nur die ersten 100 Seiten ausgewertet.`,
  });
  if (text.trim().length < 100) warnings.push({
    code: 'low_pdf_text', detail: 'Das PDF enthält wenig extrahierbaren Text; Scan/OCR oder Teilausgabe bitte prüfen.',
  });
  return warnings;
}

function validateDocxContentTypes(xml: string) {
  let rootSeen = false; let mainParts = 0;
  forEachSafeXmlElement(xml, (name, attributes) => {
    if (!rootSeen) {
      if (name !== 'types' || xmlAttribute(attributes, 'xmlns') !== 'http://schemas.openxmlformats.org/package/2006/content-types') {
        badRequest('DOCX besitzt keine gültige Content-Types-Wurzel.');
      }
      rootSeen = true;
    }
    if (name !== 'override') return;
    const partName = xmlAttribute(attributes, 'partname'); const contentType = xmlAttribute(attributes, 'contenttype');
    if (partName === '/word/document.xml') {
      if (contentType !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml') {
        badRequest('DOCX deklariert keinen sicheren Word-Hauptteil.');
      }
      mainParts += 1;
    }
  });
  if (!rootSeen || mainParts !== 1) badRequest('DOCX besitzt keine eindeutige sichere Word-Hauptteildeklaration.');
}

function validateDocxRelationships(xml: string, requireOfficeDocument: boolean) {
  let rootSeen = false; let relationshipCount = 0; let officeDocumentCount = 0;
  forEachSafeXmlElement(xml, (name, attributes) => {
    if (!rootSeen) {
      if (name !== 'relationships' || xmlAttribute(attributes, 'xmlns') !== 'http://schemas.openxmlformats.org/package/2006/relationships') {
        badRequest('DOCX besitzt keine gültige Relationships-Wurzel.');
      }
      rootSeen = true;
    }
    if (name !== 'relationship') return;
    relationshipCount += 1;
    if (relationshipCount > 2_048) badRequest('DOCX enthält zu viele Beziehungen.');
    const targetMode = xmlAttribute(attributes, 'targetmode').toLowerCase();
    const target = xmlAttribute(attributes, 'target');
    if ((targetMode && targetMode !== 'internal') || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\\\\)/i.test(target)) {
      badRequest('DOCX mit externen Beziehungen wird nicht akzeptiert.');
    }
    const type = xmlAttribute(attributes, 'type');
    if (/(?:\/|^)officeDocument$/i.test(type) && target.replace(/^\//, '') === 'word/document.xml') officeDocumentCount += 1;
  });
  if (!rootSeen || (requireOfficeDocument && officeDocumentCount !== 1)) badRequest('DOCX besitzt keine eindeutige interne Beziehung zum Word-Hauptteil.');
}

function forEachSafeXmlElement(xml: string, visit: (name: string, attributes: Record<string, unknown>) => void) {
  if (xml.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) badRequest('Office-XML mit DTD, Entities oder Übergröße wird nicht akzeptiert.');
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', (tag) => visit(tag.name.split(':').at(-1)!.toLowerCase(), tag.attributes as Record<string, unknown>));
  parser.on('error', () => badRequest('Office-XML ist nicht wohlgeformt.'));
  try { parser.write(xml).close(); }
  catch (error) {
    if (typeof error === 'object' && error && 'statusCode' in error) throw error;
    badRequest('Office-XML ist nicht wohlgeformt.');
  }
}

function xmlAttribute(attributes: Record<string, unknown>, expected: string) {
  for (const [rawName, rawValue] of Object.entries(attributes)) {
    if (rawName.split(':').at(-1)!.toLowerCase() !== expected) continue;
    if (typeof rawValue === 'string') return rawValue;
    if (rawValue && typeof rawValue === 'object' && 'value' in rawValue) return String((rawValue as { value: unknown }).value);
  }
  return '';
}

function xmlParagraphText(xml: string, allowed: Set<string>) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) badRequest('Office-XML mit DTD oder Entities wird nicht akzeptiert.');
  const lines: string[] = []; let depth = 0; let current = '';
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', (tag) => { const local = tag.name.split(':').at(-1)!.toLowerCase(); if (allowed.has(local)) { if (depth === 0) current = ''; depth += 1; } });
  parser.on('text', (value) => { if (depth > 0) current += value; });
  parser.on('closetag', (tag) => { const local = tag.name.split(':').at(-1)!.toLowerCase(); if (allowed.has(local) && depth > 0) { depth -= 1; if (depth === 0 && current.trim()) lines.push(current.trim()); } });
  parser.on('error', () => badRequest('Office-XML ist nicht wohlgeformt.'));
  try { parser.write(xml).close(); } catch { badRequest('Office-XML ist nicht wohlgeformt.'); }
  return lines.join('\n');
}

function validateNormalizedFacts(facts: CvFact[], sourceSha256: string) {
  if (!Array.isArray(facts) || facts.length < 1 || facts.length > 2_000) dependencyFailure('Der Normalisierungsvertrag lieferte keine gültigen Fakten.');
  const ids = new Set<string>();
  return facts.map((fact) => {
    if (fact.provenance?.origin !== 'imported') dependencyFailure('Normalisierte Lebenslauffakten müssen aus der importierten Quelle stammen.');
    const checked = validateFact({ ...fact, decision: 'pending' }, sourceSha256);
    if (ids.has(checked.id)) dependencyFailure(`Doppelte Fact-ID: ${checked.id}`);
    ids.add(checked.id); return checked;
  });
}

function validateFact(fact: CvFact, sourceSha256: string): CvFact {
  const provenanceSha256 = fact.provenance?.sourceSha256;
  const validProvenance = fact.provenance?.origin === 'imported'
    ? provenanceSha256 === sourceSha256
    : fact.provenance?.origin === 'user_supplied' && /^[a-f0-9]{64}$/.test(provenanceSha256 ?? '');
  if (!FACT_ID.test(fact.id) || !FACT_ID.test(fact.recordId) || !FIELD_ID.test(fact.field)
    || !(CV_FACT_CATEGORIES as readonly string[]).includes(fact.category)
    || !validProvenance || !fact.provenance.anchor
    || !['imported', 'user_supplied'].includes(fact.provenance.origin)
    || (fact.provenance.origin === 'imported' && (!fact.claimId || !FACT_ID.test(fact.claimId)))
    || typeof fact.value !== 'string') dependencyFailure('Der Normalisierungsvertrag enthält einen ungültigen atomaren Fakt.');
  return {
    ...fact, value: cleanText(fact.value, 5_000), decision: fact.decision,
    provenance: {
      sourceSha256: provenanceSha256!, anchor: cleanText(fact.provenance.anchor, 300), origin: fact.provenance.origin,
      ...(fact.provenance.recognition ? { recognition: validateRecognition(fact.provenance.recognition, fact.provenance.origin) } : {}),
    },
  };
}

function validateRecognition(
  value: NonNullable<CvFact['provenance']['recognition']>,
  origin: CvFact['provenance']['origin'],
): NonNullable<CvFact['provenance']['recognition']> {
  if (origin !== 'imported' || !['deterministic', 'ai_assisted'].includes(value.method)
    || (value.runId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.runId))
    || (value.proposalSha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.proposalSha256))
    || (value.suggestionId !== undefined && !/^suggestion-[a-f0-9]{16}$/.test(value.suggestionId))
    || (value.selectedAlternativeId !== undefined && !/^alternative-[a-f0-9]{16}$/.test(value.selectedAlternativeId))
    || (value.confidence !== undefined && (!Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1))
    || (value.questions !== undefined && (!Array.isArray(value.questions) || value.questions.length > 10))
    || (value.sourceSpan !== undefined && (!Number.isSafeInteger(value.sourceSpan.lineStart) || value.sourceSpan.lineStart < 1
      || !Number.isSafeInteger(value.sourceSpan.lineEnd) || value.sourceSpan.lineEnd < value.sourceSpan.lineStart
      || !Number.isSafeInteger(value.sourceSpan.charStart) || value.sourceSpan.charStart < 0
      || !Number.isSafeInteger(value.sourceSpan.charEnd) || value.sourceSpan.charEnd < 1))) {
    dependencyFailure('Der Normalisierungsvertrag enthaelt ungueltige Erkennungsprovenienz.');
  }
  if (value.method === 'ai_assisted' && (!value.suggestionId || !value.sourceSpan)) {
    dependencyFailure('KI-erkannte Fakten benoetigen eine Vorschlags-ID und einen exakten Quellenbereich.');
  }
  return {
    method: value.method,
    ...(value.runId ? { runId: value.runId } : {}),
    ...(value.proposalSha256 ? { proposalSha256: value.proposalSha256 } : {}),
    ...(value.suggestionId ? { suggestionId: value.suggestionId } : {}),
    ...(value.selectedAlternativeId ? { selectedAlternativeId: value.selectedAlternativeId } : {}),
    ...(value.confidence !== undefined ? { confidence: value.confidence } : {}),
    ...(value.questions?.length ? { questions: value.questions.map((question) => cleanText(question, 1_000)) } : {}),
    ...(value.sourceSpan ? { sourceSpan: structuredClone(value.sourceSpan) } : {}),
  };
}

function validateAiSelections(
  selections: Parameters<CvAiStructuringImportPort['stageAiStructure']>[0]['selections'],
): Map<string, { suggestionId: string; alternativeId: string | null }> {
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > 2_000) {
    dependencyFailure('KI-Strukturmerge besitzt keine gueltige Auswahlliste.');
  }
  const result = new Map<string, { suggestionId: string; alternativeId: string | null }>();
  for (const selection of selections) {
    if (!selection || !/^suggestion-[a-f0-9]{16}$/.test(selection.suggestionId)
      || result.has(selection.suggestionId)
      || (selection.alternativeId !== null && !/^alternative-[a-f0-9]{16}$/.test(selection.alternativeId))) {
      dependencyFailure('KI-Strukturmerge besitzt eine ungueltige oder doppelte Auswahl.');
    }
    result.set(selection.suggestionId, structuredClone(selection));
  }
  return result;
}

function validateConflicts(conflicts: CvNormalizationConflict[]) {
  if (!Array.isArray(conflicts) || conflicts.length > 100) dependencyFailure('Der Normalisierungsvertrag lieferte ungültige Konfliktdaten.');
  const ids = new Set<string>();
  return conflicts.map((item) => {
    if (!/^conflict-[a-f0-9]{16}$/.test(item.id) || ids.has(item.id) || typeof item.code !== 'string' || typeof item.detail !== 'string') {
      dependencyFailure('Der Normalisierungsvertrag lieferte ungültige Konfliktdaten.');
    }
    ids.add(item.id);
    return { id: item.id, code: cleanText(item.code, 120), detail: cleanText(item.detail, 500) };
  });
}

function userFactSourceSha256(fact: Pick<CvFact, 'category' | 'recordId' | 'field' | 'value'>) {
  return createHash('sha256').update(JSON.stringify({
    origin: 'explicit_local_user_action', category: fact.category, recordId: fact.recordId,
    field: fact.field, value: fact.value.trim(),
  })).digest('hex');
}

type RenderSection = { id: string; heading: string; items: Array<{ text: string }> };
type RenderDocument = { title?: string; sections: RenderSection[] };

function sectionsFromDocument(content: string): RenderDocument {
  const sections: RenderSection[] = [{ id: 'profile', heading: 'Profil', items: [] }];
  let current = sections[0]!; let title: string | undefined;
  for (const raw of content.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line || /^<!--\s*evidence:/i.test(line)) continue;
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const headingText = heading[2]!.trim();
      if (heading[1] === '#' && title === undefined) { title = headingText; continue; }
      current = { id: sectionId(headingText), heading: headingText, items: [] }; sections.push(current);
    } else current.items.push({ text: line.replace(/^[-*+]\s+/, '') });
  }
  const populated = sections.filter((section) => section.items.length > 0);
  if (populated.length === 0) dependencyFailure('Die freigegebene Dokumentrevision enthält keinen renderbaren Inhalt.');
  return { ...(title ? { title } : {}), sections: populated };
}

function sectionId(heading: string) {
  const value = heading.toLocaleLowerCase('de-DE');
  if (/beruf|erfahrung|employment|experience/.test(value)) return 'employment';
  if (/projekt/.test(value)) return 'project';
  if (/ausbildung|studium|education/.test(value)) return 'education';
  if (/skill|kennt|technolog/.test(value)) return 'skill';
  if (/zert/.test(value)) return 'certification';
  if (/sprach|language/.test(value)) return 'language';
  return 'additional';
}

const DEFAULT_ATS_THEME: CvTheme = {
  mode: 'ats', template: 'classic', font: 'Arial', accentColor: '#1f2937', spacing: 'comfortable', sectionOrder: [],
};
const CV_THEME_TEMPLATES = ['classic', 'compact', 'modern'] as const;
const CV_THEME_FONTS = ['Arial', 'Calibri', 'Georgia', 'Helvetica'] as const;
const CV_THEME_ACCENTS = ['#1f2937', '#1d4ed8', '#047857', '#7c3aed'] as const;
const CV_THEME_SPACINGS = ['compact', 'comfortable', 'spacious'] as const;
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`;

function spacingGap(spacing: CvTheme['spacing']) {
  return spacing === 'compact' ? '0.45rem' : spacing === 'spacious' ? '1.15rem' : '0.75rem';
}
function fontStack(family: 'sans' | 'serif') {
  return family === 'serif' ? 'Georgia,"Times New Roman",serif' : 'Arial,Helvetica,sans-serif';
}
function sectionHtml(section: RenderSection) {
  return `<section data-section="${escapeHtml(section.id)}"><h2>${escapeHtml(section.heading)}</h2><ul>${section.items.map((item) => `<li>${escapeHtml(item.text)}</li>`).join('')}</ul></section>`;
}

/**
 * Stamps an incognito render so the marking survives a download. It is placed
 * inside `<body>` rather than added as a wrapper, so it cannot be stripped by
 * merely unwrapping the document, and it names the artifact state the render
 * came from — `proposed` output carries no human confirmation at all.
 */
function withIncognitoBanner(html: string, lifecycle: 'proposed' | 'approved'): string {
  const state = lifecycle === 'approved'
    ? 'ausdrücklich bestätigtes Agentenartefakt'
    : 'ungeprüftes Agentenergebnis, von niemandem bestätigt';
  const banner = '<div role="note" style="margin:0 0 16px;padding:12px 14px;border:2px solid #b45309;'
    + 'border-radius:8px;background:#fffbeb;color:#7c2d12;font:700 13px/1.5 Arial,sans-serif">'
    + 'INKOGNITO-VORSCHAU – KEINE VERWENDBARE BEWERBUNG'
    + `<div style="margin-top:4px;font-weight:400;font-size:11px">Scheinidentität mit Platzhalter-Kontaktdaten · ${escapeHtml(state)}. `
    + 'Dieses Dokument ist keine freigegebene Dokumentrevision und darf nicht als Bewerbung versendet werden.</div></div>';
  const openingBody = html.match(/<body[^>]*>/i);
  return openingBody
    ? html.replace(openingBody[0], `${openingBody[0]}${banner}`)
    : `${banner}${html}`;
}

function renderHtml(document: RenderDocument, theme?: CvTheme) {
  const selected = theme ?? DEFAULT_ATS_THEME;
  return selected.mode === 'original' && selected.original
    ? renderOriginalHtml(document, selected, selected.original)
    : renderAtsHtml(document, selected);
}

function renderAtsHtml(document: RenderDocument, selected: CvTheme) {
  const gap = spacingGap(selected.spacing);
  const priority = new Map(selected.sectionOrder.map((section, index) => [section, index]));
  const ordered = document.sections.map((section, index) => ({ section, index })).sort((left, right) => {
    const a = priority.get(left.section.id as CvTheme['sectionOrder'][number]);
    const b = priority.get(right.section.id as CvTheme['sectionOrder'][number]);
    return (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER) || left.index - right.index;
  }).map(({ section }) => section);
  const documentTitle = document.title ?? 'Lebenslauf';
  const title = `<h1>${escapeHtml(documentTitle)}</h1>`;
  const body = ordered.map(sectionHtml).join('');
  const templateRule = selected.template === 'compact' ? 'h2{font-size:1.05rem;border-bottom:1px solid currentColor}'
    : selected.template === 'modern' ? 'h2{border-left:.3rem solid currentColor;padding-left:.55rem}' : 'h2{border-bottom:2px solid currentColor}';
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">${CSP_META}<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(documentTitle)}</title><style>body{font-family:${selected.font},sans-serif;color:#111827;max-width:52rem;margin:2rem auto;padding:0 1.5rem}h1,h2{color:${selected.accentColor}}${templateRule}section{margin-block:${gap}}li{margin-block:.25rem}</style></head><body data-template="${selected.template}" data-mode="ats"><main>${title}${body}</main></body></html>`;
}

function columnSections(sections: RenderSection[], order: CvLayoutSection[]): RenderSection[] {
  const priority = new Map(order.map((section, index) => [section, index]));
  return sections.map((section, index) => ({ section, index }))
    .sort((left, right) => (priority.get(left.section.id as CvLayoutSection) ?? Number.MAX_SAFE_INTEGER)
      - (priority.get(right.section.id as CvLayoutSection) ?? Number.MAX_SAFE_INTEGER) || left.index - right.index)
    .map(({ section }) => section);
}

function renderOriginalHtml(document: RenderDocument, selected: CvTheme, layout: CvThemeOriginalLayout) {
  const gap = spacingGap(selected.spacing);
  const palette = layout.palette;
  const documentTitle = document.title ?? 'Lebenslauf';
  const title = `<h1>${escapeHtml(documentTitle)}</h1>`;
  const twoColumn = layout.columns === 2;
  const sideIds = new Set<CvLayoutSection>(twoColumn ? layout.side : []);
  const sideSections = twoColumn ? columnSections(document.sections.filter((section) => sideIds.has(section.id as CvLayoutSection)), layout.side) : [];
  const mainSections = columnSections(document.sections.filter((section) => !sideIds.has(section.id as CvLayoutSection)), layout.main);
  const mainHtml = `<div class="col-main">${title}${mainSections.map(sectionHtml).join('')}</div>`;
  const sideHtml = twoColumn ? `<aside class="col-side">${sideSections.map(sectionHtml).join('')}</aside>` : '';
  const layoutCss = twoColumn
    ? 'main{display:grid;grid-template-columns:minmax(0,32%) minmax(0,1fr);gap:1.5rem;align-items:start}'
      + `.col-side{background:${palette.sidebar};color:${palette.sidebarText};padding:1.25rem;border-radius:.4rem}`
      + `.col-side h2{color:${palette.sidebarText}}`
    : '';
  const css = `body{font-family:${fontStack(layout.fontFamily)};color:${palette.text};background:${palette.background};max-width:${twoColumn ? '58rem' : '52rem'};margin:2rem auto;padding:0 1.5rem}`
    + `h1{color:${palette.heading}}h2{color:${palette.accent};border-bottom:2px solid ${palette.accent};font-size:1.05rem}`
    + `${layoutCss}section{margin-block:${gap}}li{margin-block:.25rem}`;
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">${CSP_META}<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(documentTitle)}</title><style>${css}</style></head><body data-template="original" data-mode="original" data-columns="${layout.columns}"><main>${twoColumn ? `${sideHtml}${mainHtml}` : mainHtml}</main></body></html>`;
}

function layoutSectionLabel(section: CvLayoutSection): string {
  return {
    profile: 'Profil', employment: 'Berufserfahrung', project: 'Projekte', education: 'Ausbildung',
    skill: 'Kenntnisse', certification: 'Zertifikate', language: 'Sprachen', additional: 'Weiteres',
  }[section];
}

/** Build a skeleton document (placeholder content, no personal facts) that showcases layout and colours. */
function renderThemePreview(theme: CvTheme, fingerprint?: CvLayoutFingerprint) {
  const labels = new Map<CvLayoutSection, string>();
  if (fingerprint) for (const entry of fingerprint.sections) labels.set(entry.section, entry.label);
  const order = theme.mode === 'original' && theme.original
    ? [...theme.original.main, ...(theme.original.columns === 2 ? theme.original.side : [])]
    : theme.sectionOrder.length ? theme.sectionOrder : [...CV_LAYOUT_SECTIONS];
  const placeholder = (lines: string[]) => lines.map((text) => ({ text }));
  const sections: RenderSection[] = [...new Set(order)].map((section) => ({
    id: section, heading: labels.get(section) ?? layoutSectionLabel(section),
    items: section === 'skill' || section === 'language'
      ? placeholder(['Platzhalter · Platzhalter · Platzhalter', 'Nur Struktur und Farben — kein Inhalt'])
      : placeholder(['Platzhalterzeile — nur Layout- und Farbvorschau', 'Weitere Platzhalterzeile ohne echten Inhalt']),
  }));
  if (sections.length === 0) sections.push({ id: 'profile', heading: 'Profil', items: placeholder(['Layout- und Farbvorschau']) });
  return renderHtml({ title: 'Layout-Vorschau', sections }, theme);
}

function assertLayoutHex(value: unknown, field: string): string {
  if (typeof value !== 'string' || !LAYOUT_HEX.test(value)) badRequest(`Die Formatvorlage enthält eine ungültige Farbe (${field}).`);
  return value;
}
function assertLayoutSectionList(value: unknown, field: string): CvLayoutSection[] {
  if (!Array.isArray(value) || value.length > CV_LAYOUT_SECTIONS.length) badRequest(`Die Formatvorlage besitzt eine ungültige ${field}-Abschnittsliste.`);
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !(CV_LAYOUT_SECTIONS as readonly string[]).includes(item) || seen.has(item)) {
      badRequest(`Die Formatvorlage besitzt eine ungültige ${field}-Abschnittsliste.`);
    }
    seen.add(item);
  }
  return [...value] as CvLayoutSection[];
}
function normalizeOriginalLayout(value: unknown): CvThemeOriginalLayout {
  if (!isRecord(value)) badRequest('Die Original-Formatvorlage ist ungültig.');
  const columns: 1 | 2 = value.columns === 2 ? 2 : value.columns === 1 ? 1 : (badRequest('Die Original-Formatvorlage besitzt eine ungültige Spaltenzahl.') as never);
  const rawPalette = isRecord(value.palette) ? value.palette : badRequest('Die Original-Formatvorlage besitzt keine gültige Farbpalette.');
  const palette: CvLayoutPalette = {
    text: assertLayoutHex(rawPalette.text, 'text'), heading: assertLayoutHex(rawPalette.heading, 'heading'),
    accent: assertLayoutHex(rawPalette.accent, 'accent'), background: assertLayoutHex(rawPalette.background, 'background'),
  };
  if (columns === 2) {
    palette.sidebar = assertLayoutHex(rawPalette.sidebar, 'sidebar');
    palette.sidebarText = rawPalette.sidebarText === undefined
      ? (luminanceHex(palette.sidebar) < 0.5 ? '#f9fafb' : '#111827')
      : assertLayoutHex(rawPalette.sidebarText, 'sidebarText');
  }
  const fontFamily: 'sans' | 'serif' = value.fontFamily === 'serif' ? 'serif' : value.fontFamily === 'sans' ? 'sans'
    : (badRequest('Die Original-Formatvorlage besitzt eine ungültige Schriftfamilie.') as never);
  const main = assertLayoutSectionList(value.main, 'main');
  const side = columns === 2 ? assertLayoutSectionList(value.side, 'side') : [];
  if (main.some((section) => side.includes(section))) badRequest('Ein Abschnitt darf nicht gleichzeitig in Haupt- und Seitenspalte liegen.');
  if (main.length + side.length < 1) badRequest('Die Original-Formatvorlage muss mindestens einen Abschnitt platzieren.');
  return { columns, palette, fontFamily, main, side };
}
function luminanceHex(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16); const g = parseInt(hex.slice(3, 5), 16); const b = parseInt(hex.slice(5, 7), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Validate and canonicalize an incoming theme (closed ATS values plus the optional original layout clone). */
function normalizeTheme(theme: CvTheme): CvTheme {
  if (!isRecord(theme)) badRequest('Die Formatvorlage ist ungültig.');
  const mode = theme.mode === 'original' ? 'original' : 'ats';
  if (!(CV_THEME_TEMPLATES as readonly string[]).includes(theme.template)
    || !(CV_THEME_FONTS as readonly string[]).includes(theme.font)
    || !(CV_THEME_ACCENTS as readonly string[]).includes(theme.accentColor)
    || !(CV_THEME_SPACINGS as readonly string[]).includes(theme.spacing)) {
    badRequest('Die Formatvorlage enthält unzulässige geschlossene ATS-Werte.');
  }
  const sectionOrder = assertLayoutSectionList(theme.sectionOrder, 'sectionOrder');
  const normalized: CvTheme = {
    mode, template: theme.template, font: theme.font, accentColor: theme.accentColor,
    spacing: theme.spacing, sectionOrder,
  };
  if (mode === 'original') normalized.original = normalizeOriginalLayout(theme.original);
  return normalized;
}

function escapeHtml(value: string) { return cleanText(value, 20_000).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!); }
function decodeEntities(value: string) { return value.replace(/&(amp|lt|gt|quot|#39|nbsp);/gi, (match, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[name.toLowerCase()] ?? match); }
function cleanText(value: string, max: number) { const cleaned = value.trim(); if (!cleaned || cleaned.length > max || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(cleaned)) dependencyFailure('CV-Vertrag enthält ungültigen Text.'); return cleaned; }
function recordHash(record: object) { return createHash('sha256').update(JSON.stringify(record)).digest('hex'); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) dependencyFailure('CV-Artefakt enthält keinen endlichen JSON-Wert.'); return JSON.stringify(value); }
  if (!value || typeof value !== 'object' || seen.has(value)) dependencyFailure('CV-Artefakt ist nicht kanonisch als JSON darstellbar.');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`;
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item, seen)}`).join(',')}}`;
  } finally { seen.delete(value); }
}
function artifactProposal(value: Record<string, unknown>): Record<string, unknown> {
  const proposal = isRecord(value.proposal) ? value.proposal : undefined;
  if (!proposal) dependencyFailure('CV-Artefakt enthält keinen gültigen Proposal-Bereich.');
  return proposal;
}
function artifactEntityList(
  proposal: Record<string, unknown>,
  field: string,
  maximum = 2_000,
): Array<Record<string, unknown>> {
  const items = proposal[field];
  if (!Array.isArray(items) || items.length > maximum
    || items.some((item) => !isRecord(item) || typeof item.id !== 'string')) {
    dependencyFailure(`CV-Artefakt enthält keine gültige ${field}-Liste.`);
  }
  return items as Array<Record<string, unknown>>;
}
function assertExistingEntitiesPreserved(
  before: Array<Record<string, unknown>>,
  after: Array<Record<string, unknown>>,
  label: string,
): { beforeById: Map<string, Record<string, unknown>>; afterById: Map<string, Record<string, unknown>> } {
  const beforeById = new Map(before.map((item) => [String(item.id), item]));
  const afterById = new Map(after.map((item) => [String(item.id), item]));
  if (beforeById.size !== before.length || afterById.size !== after.length
    || [...beforeById].some(([id, item]) => {
      const replacement = afterById.get(id);
      return !replacement || canonicalJson(replacement) !== canonicalJson(item);
    })) {
    dependencyFailure(`KI-CV-Merge hat bestehende ${label} verändert, entfernt oder dupliziert.`);
  }
  return { beforeById, afterById };
}

function assertAiReplacementArtifact(
  base: Record<string, unknown>,
  materialized: Record<string, unknown>,
  facts: CvFact[],
  expected: {
    expectedBaseProposalSha256: string;
    selections: Array<{ suggestionId: string; alternativeId: string | null }>;
    unresolvedConflicts: CvNormalizationConflict[];
  },
): void {
  if (!isRecord(base.source) || !isRecord(materialized.source)
    || canonicalJson(base.source) !== canonicalJson(materialized.source)
    || !isRecord(base.extraction) || !isRecord(materialized.extraction)
    || canonicalJson(base.extraction.line_manifest) !== canonicalJson(materialized.extraction.line_manifest)
    || base.extraction.text_sha256 !== materialized.extraction.text_sha256) {
    dependencyFailure('KI-CV-Materialisierung hat Importquelle, Quellenliste oder privaten Zeilenindex veraendert.');
  }
  assertOrderedSourceSubset(base.sources, materialized.sources, base.source);
  const {
    proposal: _baseProposal, extraction: _baseExtraction, sources: _baseSources, ...baseTopLevel
  } = base;
  const {
    proposal: _materializedProposal, extraction: _materializedExtraction,
    sources: _materializedSources, ...materializedTopLevel
  } = materialized;
  if (canonicalJson(baseTopLevel) !== canonicalJson(materializedTopLevel)) {
    dependencyFailure('KI-CV-Materialisierung hat geschuetzte Top-Level-Vertragsdaten veraendert.');
  }
  const baseExtraction = base.extraction as Record<string, unknown>;
  const materializedExtraction = materialized.extraction as Record<string, unknown>;
  const {
    ai_structuring: rawBaseAi, conflicts: _rawBaseConflicts, ...baseExtractionStable
  } = baseExtraction;
  const {
    ai_structuring: rawMaterializedAi, conflicts: rawMaterializedConflicts, ...materializedExtractionStable
  } = materializedExtraction;
  if (canonicalJson(baseExtractionStable) !== canonicalJson(materializedExtractionStable)) {
    dependencyFailure('KI-CV-Materialisierung hat bestehende Extraktionsdaten veraendert.');
  }
  if (!Array.isArray(rawMaterializedConflicts) || rawMaterializedConflicts.length > 100) {
    dependencyFailure('KI-CV-Materialisierung besitzt keine gueltige Konfliktprojektion.');
  }
  const materializedConflicts = validateConflicts(rawMaterializedConflicts.map((item) => {
    if (!isRecord(item) || typeof item.code !== 'string' || typeof item.detail !== 'string') {
      dependencyFailure('KI-CV-Materialisierung besitzt keine gueltige Konfliktprojektion.');
    }
    return {
      id: `conflict-${createHash('sha256').update(canonicalJson(item)).digest('hex').slice(0, 16)}`,
      code: item.code,
      detail: item.detail,
    };
  }));
  if (canonicalJson(materializedConflicts) !== canonicalJson(expected.unresolvedConflicts)) {
    dependencyFailure('KI-CV-Materialisierung und Konfliktprojektion stimmen nicht ueberein.');
  }
  if ((rawBaseAi !== undefined && (!Array.isArray(rawBaseAi) || rawBaseAi.length > 100))
    || !Array.isArray(rawMaterializedAi) || rawMaterializedAi.length !== 1) {
    dependencyFailure('KI-CV-Materialisierung besitzt kein eindeutiges ersetzendes Struktur-Audit.');
  }
  const source = base.source as Record<string, unknown>;
  const expectedAudit = {
    contract: 'validated-ai-cv-structure-proposal', contract_version: '1.0', status: 'unverified',
    binding: {
      source_id: source.id, source_sha256: source.sha256,
      text_sha256: baseExtraction.text_sha256,
      base_proposal_sha256: expected.expectedBaseProposalSha256,
    },
    applied_suggestion_ids: [...new Set(expected.selections.map((selection) => selection.suggestionId))].sort(),
    mode: 'replace_recognition_version',
  };
  if (canonicalJson(rawMaterializedAi.at(-1)) !== canonicalJson(expectedAudit)) {
    dependencyFailure('KI-CV-Materialisierung besitzt keine exakte Auswahl- und Basisbindung im Struktur-Audit.');
  }

  const baseProposal = artifactProposal(base); const proposal = artifactProposal(materialized);
  const baseKeys = Object.keys(baseProposal).sort(); const proposalKeys = Object.keys(proposal).sort();
  if (canonicalJson(baseKeys) !== canonicalJson(proposalKeys)) {
    dependencyFailure('KI-CV-Materialisierung hat Proposal-Vertragsfelder hinzugefuegt oder entfernt.');
  }
  const replaceableCollections = new Set([
    'facts', 'claims', 'experience', 'education', 'projects',
    'skills', 'languages', 'additional_facts',
  ]);
  for (const key of baseKeys) {
    if (!replaceableCollections.has(key) && canonicalJson(baseProposal[key]) !== canonicalJson(proposal[key])) {
      dependencyFailure(`KI-CV-Materialisierung hat den geschuetzten Proposal-Bereich ${key} veraendert.`);
    }
  }

  const artifactFacts = artifactEntityList(proposal, 'facts');
  const artifactFactsById = new Map(artifactFacts.map((fact) => [String(fact.id), fact]));
  if (artifactFactsById.size !== artifactFacts.length || artifactFacts.length !== facts.length) {
    dependencyFailure('KI-CV-Materialisierung und vollstaendige Fact-Projektion besitzen unterschiedliche Fact-Mengen.');
  }
  for (const fact of facts) {
    const raw = artifactFactsById.get(fact.id);
    if (!raw || raw.claim_id !== fact.claimId || artifactFactCategory(raw.category) !== fact.category
      || raw.record_id !== fact.recordId || raw.field !== fact.field || raw.value !== fact.value
      || raw.status !== 'unverified') {
      dependencyFailure('KI-CV-Materialisierung stimmt nicht exakt mit der vollstaendigen Fact-Projektion ueberein.');
    }
    const recognition = fact.provenance.recognition;
    if (recognition?.method === 'ai_assisted') {
      const anchor = isRecord(raw.source_anchor) ? raw.source_anchor : undefined;
      const metadata = isRecord(raw.proposal_metadata) ? raw.proposal_metadata : undefined;
      if (!anchor || anchor.recognition_method !== 'ai_assisted'
        || anchor.source_sha256 !== fact.provenance.sourceSha256
        || anchor.suggestion_id !== recognition.suggestionId
        || anchor.line_start !== recognition.sourceSpan?.lineStart
        || anchor.line_end !== recognition.sourceSpan?.lineEnd
        || anchor.char_start !== recognition.sourceSpan?.charStart
        || anchor.char_end !== recognition.sourceSpan?.charEnd
        || (recognition.selectedAlternativeId === undefined
          ? anchor.alternative_id !== null && anchor.alternative_id !== undefined
          : anchor.alternative_id !== recognition.selectedAlternativeId)
        || !metadata || metadata.suggestion_id !== recognition.suggestionId
        || metadata.selected_alternative_id !== (recognition.selectedAlternativeId ?? null)
        || metadata.confidence !== recognition.confidence
        || canonicalJson(metadata.questions ?? []) !== canonicalJson(recognition.questions ?? [])) {
        dependencyFailure('KI-CV-Materialisierung besitzt keine exakte Quellen- und Vorschlagsprovenienz.');
      }
    }
  }

  const claims = artifactEntityList(proposal, 'claims');
  const claimsById = new Map(claims.map((claim) => [String(claim.id), claim]));
  if (claimsById.size !== claims.length || claims.length !== facts.length
    || facts.some((fact) => !fact.claimId || claimsById.get(fact.claimId)?.fact_id !== fact.id
      || claimsById.get(fact.claimId)?.status !== 'unverified')) {
    dependencyFailure('KI-CV-Materialisierung besitzt keine exakte unverified Claim-Projektion.');
  }

  const collectionByCategory: Partial<Record<CvFactCategory, string>> = {
    employment: 'experience', education: 'education', project: 'projects', certification: 'certifications',
    skill: 'skills', language: 'languages', additional: 'additional_facts',
  };
  for (const [category, collection] of Object.entries(collectionByCategory) as Array<[CvFactCategory, string]>) {
    const expectedRecordIds = new Set(facts.filter((fact) => fact.category === category).map((fact) => fact.recordId));
    const records = artifactEntityList(proposal, collection);
    const actualRecordIds = new Set(records.map((record) => String(record.id)));
    if (actualRecordIds.size !== records.length || actualRecordIds.size !== expectedRecordIds.size
      || [...expectedRecordIds].some((id) => !actualRecordIds.has(id))) {
      dependencyFailure(`KI-CV-Materialisierung besitzt keine exakte ${collection}-Record-Projektion.`);
    }
  }
}

function assertOrderedSourceSubset(
  baseValue: unknown,
  materializedValue: unknown,
  primarySource: Record<string, unknown>,
): void {
  if (baseValue === undefined && materializedValue === undefined) return;
  if (!Array.isArray(baseValue) || !Array.isArray(materializedValue)
    || baseValue.length < 1 || materializedValue.length < 1
    || baseValue.some((item) => !isRecord(item) || typeof item.id !== 'string')
    || materializedValue.some((item) => !isRecord(item) || typeof item.id !== 'string')) {
    dependencyFailure('KI-CV-Materialisierung besitzt keine gueltige geordnete Quellen-Teilmenge.');
  }
  const baseSources = baseValue as Array<Record<string, unknown>>;
  const materializedSources = materializedValue as Array<Record<string, unknown>>;
  const baseIds = baseSources.map((item) => String(item.id));
  const materializedIds = materializedSources.map((item) => String(item.id));
  if (new Set(baseIds).size !== baseIds.length || new Set(materializedIds).size !== materializedIds.length) {
    dependencyFailure('KI-CV-Materialisierung hat Quellen dupliziert.');
  }
  let baseIndex = 0;
  for (const source of materializedSources) {
    while (baseIndex < baseSources.length && baseSources[baseIndex]!.id !== source.id) baseIndex += 1;
    if (baseIndex >= baseSources.length
      || canonicalJson(baseSources[baseIndex]) !== canonicalJson(source)) {
      dependencyFailure('KI-CV-Materialisierung hat Quellen hinzugefuegt, veraendert oder umsortiert.');
    }
    baseIndex += 1;
  }
  const primary = materializedSources.find((source) => source.id === primarySource.id);
  if (!primary || canonicalJson(primary) !== canonicalJson(primarySource)) {
    dependencyFailure('KI-CV-Materialisierung hat die primaere Importquelle aus der Quellenliste entfernt oder veraendert.');
  }
}

function artifactFactCategory(value: unknown): CvFactCategory | undefined {
  if (['experience_detail', 'achievement', 'technology', 'metric'].includes(String(value))) return 'employment';
  if (value === 'other' || value === 'additional') return 'additional';
  return (CV_FACT_CATEGORIES as readonly unknown[]).includes(value) ? value as CvFactCategory : undefined;
}

function assertArtifactMerge(
  base: Record<string, unknown>,
  merged: Record<string, unknown>,
  addedFacts: CvFact[],
  expected: {
    expectedBaseProposalSha256: string;
    selections: Parameters<CvAiStructuringImportPort['stageAiStructure']>[0]['selections'];
  },
): void {
  if (!isRecord(base.source) || !isRecord(merged.source) || canonicalJson(base.source) !== canonicalJson(merged.source)
    || !isRecord(base.extraction) || !isRecord(merged.extraction)
    || canonicalJson(base.extraction.line_manifest) !== canonicalJson(merged.extraction.line_manifest)
    || base.extraction.text_sha256 !== merged.extraction.text_sha256) {
    dependencyFailure('KI-CV-Merge hat die gebundene Importquelle oder den privaten Zeilenindex verändert.');
  }
  const { proposal: _baseProposal, extraction: _baseExtraction, ...baseTopLevel } = base;
  const { proposal: _mergedProposal, extraction: _mergedExtraction, ...mergedTopLevel } = merged;
  if (canonicalJson(baseTopLevel) !== canonicalJson(mergedTopLevel)) {
    dependencyFailure('KI-CV-Merge hat bestehende Top-Level-Vertragsdaten verändert.');
  }
  const baseExtraction = base.extraction as Record<string, unknown>;
  const mergedExtraction = merged.extraction as Record<string, unknown>;
  const { ai_structuring: rawBaseAi, ...baseExtractionStable } = baseExtraction;
  const { ai_structuring: rawMergedAi, ...mergedExtractionStable } = mergedExtraction;
  if (canonicalJson(baseExtractionStable) !== canonicalJson(mergedExtractionStable)) {
    dependencyFailure('KI-CV-Merge hat bestehende Extraktionsdaten verändert.');
  }
  const baseAi = rawBaseAi === undefined ? [] : rawBaseAi;
  const mergedAi = rawMergedAi;
  if (!Array.isArray(baseAi) || baseAi.length > 100 || !Array.isArray(mergedAi)
    || mergedAi.length !== baseAi.length + 1
    || canonicalJson(mergedAi.slice(0, baseAi.length)) !== canonicalJson(baseAi)) {
    dependencyFailure('KI-CV-Merge besitzt kein exakt angehängtes Struktur-Audit.');
  }
  const audit = mergedAi.at(-1);
  const source = base.source as Record<string, unknown>;
  const selectedIds = [...new Set(expected.selections.map((selection) => selection.suggestionId))].sort();
  const expectedAudit = {
    contract: 'validated-ai-cv-structure-proposal', contract_version: '1.0', status: 'unverified',
    binding: {
      source_id: source.id, source_sha256: source.sha256,
      text_sha256: baseExtraction.text_sha256,
      base_proposal_sha256: expected.expectedBaseProposalSha256,
    },
    applied_suggestion_ids: selectedIds,
  };
  if (canonicalJson(audit) !== canonicalJson(expectedAudit)) {
    dependencyFailure('KI-CV-Merge besitzt keine exakte Auswahl- und Basisbindung im Struktur-Audit.');
  }
  const beforeProposal = artifactProposal(base); const afterProposal = artifactProposal(merged);
  const beforeKeys = Object.keys(beforeProposal).sort(); const afterKeys = Object.keys(afterProposal).sort();
  if (canonicalJson(beforeKeys) !== canonicalJson(afterKeys)) {
    dependencyFailure('KI-CV-Merge hat Proposal-Vertragsfelder hinzugefügt oder entfernt.');
  }
  const mutableCollections = new Set(['facts', 'claims', 'experience', 'education', 'projects', 'skills', 'languages']);
  for (const key of beforeKeys) {
    if (!mutableCollections.has(key) && canonicalJson(beforeProposal[key]) !== canonicalJson(afterProposal[key])) {
      dependencyFailure(`KI-CV-Merge hat den geschützten Proposal-Bereich ${key} verändert.`);
    }
  }

  const before = artifactEntityList(beforeProposal, 'facts'); const after = artifactEntityList(afterProposal, 'facts');
  const { beforeById, afterById } = assertExistingEntitiesPreserved(before, after, 'atomare Fakten');
  if (after.length !== before.length + addedFacts.length) {
    dependencyFailure('KI-CV-Merge hat bestehende atomare Fakten verändert oder entfernt.');
  }
  const addedClaimIds = new Set<string>();
  for (const fact of addedFacts) {
    const raw = afterById.get(fact.id);
    if (!raw || beforeById.has(fact.id) || raw.claim_id !== fact.claimId || raw.record_id !== fact.recordId
      || raw.field !== fact.field || raw.value !== fact.value) {
      dependencyFailure('KI-CV-Merge stimmt nicht mit den neu projizierten Fakten überein.');
    }
    if (!fact.claimId || addedClaimIds.has(fact.claimId)) dependencyFailure('KI-CV-Merge enthält ungültige neue Claim-Bindungen.');
    addedClaimIds.add(fact.claimId);
  }

  const beforeClaims = artifactEntityList(beforeProposal, 'claims'); const afterClaims = artifactEntityList(afterProposal, 'claims');
  const claims = assertExistingEntitiesPreserved(beforeClaims, afterClaims, 'Claims');
  if (afterClaims.length !== beforeClaims.length + addedClaimIds.size) {
    dependencyFailure('KI-CV-Merge hat Claims ohne ausgewählten Fakt hinzugefügt oder entfernt.');
  }
  for (const claimId of addedClaimIds) {
    const raw = claims.afterById.get(claimId);
    const fact = addedFacts.find((item) => item.claimId === claimId);
    if (!raw || claims.beforeById.has(claimId) || raw.fact_id !== fact?.id || raw.status !== 'unverified') {
      dependencyFailure('KI-CV-Merge stimmt nicht mit den neu projizierten Claims überein.');
    }
  }

  const expectedNewRecordIds = new Set(addedFacts.map((fact) => fact.recordId));
  const foundNewRecordIds = new Set<string>();
  for (const collection of ['experience', 'education', 'projects', 'skills', 'languages'] as const) {
    const beforeRecords = artifactEntityList(beforeProposal, collection);
    const afterRecords = artifactEntityList(afterProposal, collection);
    const records = assertExistingEntitiesPreserved(beforeRecords, afterRecords, `${collection}-Records`);
    for (const [id] of records.afterById) {
      if (records.beforeById.has(id)) continue;
      if (!expectedNewRecordIds.has(id) || foundNewRecordIds.has(id)) {
        dependencyFailure('KI-CV-Merge hat einen nicht faktengebundenen oder doppelten Record hinzugefügt.');
      }
      foundNewRecordIds.add(id);
    }
  }
  if (foundNewRecordIds.size !== expectedNewRecordIds.size
    || [...expectedNewRecordIds].some((id) => !foundNewRecordIds.has(id))) {
    dependencyFailure('KI-CV-Merge hat bestehende Records verändert oder neue Fakten keinem Record zugeordnet.');
  }
}
function assertCas(record: CvImportRecord | undefined, revision: number, sha256: string) { if (!record) notFound(); if (record.revision !== revision || record.sha256 !== sha256) conflict('CV-Import wurde zwischenzeitlich geändert. Bitte neu laden.'); }
function assertUuid(id: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) badRequest('Ungültige CV-Import-ID.'); }
function badRequest(message: string): never { throw Object.assign(new Error(message), { statusCode: 400 }); }
function conflict(message: string): never { throw Object.assign(new Error(message), { statusCode: 409 }); }
function notFound(message = 'CV-Import nicht gefunden.'): never { throw Object.assign(new Error(message), { statusCode: 404 }); }
function dependencyFailure(message: string): never { throw Object.assign(new Error(message), { statusCode: 503 }); }
