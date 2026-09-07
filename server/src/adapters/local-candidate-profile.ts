import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AppConfig } from '../domain/models.js';
import {
  candidateEvidenceCollections,
  type CandidateEvidenceSnapshot,
  type CandidateProfilePort,
  type CandidateProfileSummary,
  type ClaimPatchOperation,
} from '../ports/candidate-profile.js';
import { buildMinimalLocalChildEnvironment } from '../services/process-environment.js';

const execute = promisify(execFile);

export class LocalCandidateProfileAdapter implements CandidateProfilePort {
  constructor(private readonly settings: AppConfig['assistant']) {}

  async summary(): Promise<CandidateProfileSummary> {
    const raw = await this.run(['show', '--candidate', this.path(this.settings.candidateProfilePath)]);
    return this.mapSummary(raw);
  }

  async evidence(outputType: CandidateEvidenceSnapshot['outputType']): Promise<CandidateEvidenceSnapshot> {
    const raw = await this.run([
      'evidence', '--candidate', this.path(this.settings.candidateProfilePath), '--output-type', outputType,
    ]);
    const records = raw.records && typeof raw.records === 'object' && !Array.isArray(raw.records)
      ? raw.records as Record<string, unknown> : {};
    const mappedRecords = Object.fromEntries(candidateEvidenceCollections.map((collection) => {
      const values = Array.isArray(records[collection]) ? records[collection] : [];
      if (!values.every((value) => value !== null && typeof value === 'object' && !Array.isArray(value))) {
        throw Object.assign(new Error('Kandidaten-Evidence enthält ungültige Strukturdaten.'), { statusCode: 409 });
      }
      return [collection, structuredClone(values as Array<Record<string, unknown>>)] as const;
    })) as CandidateEvidenceSnapshot['records'];
    const claims = this.mapClaims(raw.claims);
    const contractVersion = String(raw.contract_version ?? '');
    const valid = raw.contract === 'candidate-evidence-snapshot' && raw.output_type === outputType
      && Boolean(raw.valid) && Boolean(contractVersion);
    return {
      contractVersion, outputType, valid,
      errors: Array.isArray(raw.errors) ? raw.errors.map(String) : [],
      claims, records: mappedRecords,
    };
  }

  async patch(operations: ClaimPatchOperation[], confirmed: boolean): Promise<{ status: string; updatedClaimIds: string[] }> {
    const candidate = this.path(this.settings.candidateProfilePath);
    const expectedCandidateSha256 = await this.candidateSha256(candidate);
    const temporary = resolve(dirname(candidate), `.claim-patch-${process.pid}-${Date.now()}.json`);
    await mkdir(dirname(candidate), { recursive: true });
    await writeFile(temporary, JSON.stringify(operations.map((operation) => ({
      claim_id: operation.claimId, field: operation.field, value: operation.value
    }))), { encoding: 'utf8', mode: 0o600 });
    try {
      const args = ['patch', '--candidate', candidate, '--operations', temporary, '--expected-candidate-sha256', expectedCandidateSha256];
      if (confirmed) args.push('--confirmed');
      const raw = await this.run(args);
      return { status: String(raw.status), updatedClaimIds: Array.isArray(raw.updated_claim_ids) ? raw.updated_claim_ids.map(String) : [] };
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async addImportProposals(proposals: Array<{ id: string; statement: string; sha256: string }>, confirmed: boolean): Promise<{ status: string; addedClaimIds: string[] }> {
    const candidate = this.path(this.settings.candidateProfilePath);
    const expectedCandidateSha256 = await this.candidateSha256(candidate);
    const temporary = resolve(dirname(candidate), `.import-proposals-${process.pid}-${Date.now()}.json`);
    await writeFile(temporary, JSON.stringify(proposals), { encoding: 'utf8', mode: 0o600 });
    try {
      const args = ['add-import', '--candidate', candidate, '--proposals', temporary, '--expected-candidate-sha256', expectedCandidateSha256]; if (confirmed) args.push('--confirmed');
      const raw = await this.run(args);
      return { status: String(raw.status), addedClaimIds: Array.isArray(raw.added_claim_ids) ? raw.added_claim_ids.map(String) : [] };
    } finally { await rm(temporary, { force: true }); }
  }

  private async run(args: string[]): Promise<Record<string, unknown>> {
    const skillRoot = this.path(this.settings.skillPath);
    try {
      const { stdout } = await execute(process.env.PYTHON_EXECUTABLE || 'python', [resolve(skillRoot, 'scripts', 'profile_contract.py'), ...args], {
        cwd: skillRoot, windowsHide: true, env: buildMinimalLocalChildEnvironment()
      });
      return JSON.parse(stdout) as Record<string, unknown>;
    } catch (error) {
      const stderr = typeof error === 'object' && error && 'stderr' in error ? String(error.stderr).trim() : '';
      throw Object.assign(new Error(stderr || 'Kandidatenprofil konnte nicht verarbeitet werden.'), { statusCode: 409 });
    }
  }

  private mapSummary(raw: Record<string, unknown>): CandidateProfileSummary {
    return {
      contractVersion: String(raw.contract_version), valid: Boolean(raw.valid),
      errors: Array.isArray(raw.errors) ? raw.errors.map(String) : [],
      profile: raw.profile && typeof raw.profile === 'object' ? raw.profile as Record<string, unknown> : {},
      claims: this.mapClaims(raw.claims),
    };
  }

  private mapClaims(value: unknown): CandidateProfileSummary['claims'] {
    const claims = Array.isArray(value) ? value as Record<string, unknown>[] : [];
    return claims.map((claim) => ({
      id: String(claim.id),
      ...(typeof claim.category === 'string' ? { category: claim.category } : {}),
      statement: String(claim.statement),
      status: String(claim.status) as CandidateProfileSummary['claims'][number]['status'],
      evidenceRefs: Array.isArray(claim.evidence_refs) ? claim.evidence_refs.map(String) : [],
      allowedOutputs: Array.isArray(claim.allowed_outputs) ? claim.allowed_outputs.map(String) : [],
      validFrom: typeof claim.valid_from === 'string' ? claim.valid_from : undefined,
      validTo: typeof claim.valid_to === 'string' ? claim.valid_to : undefined,
    }));
  }

  private async candidateSha256(candidate: string): Promise<string> {
    const snapshot = await readFile(candidate);
    return createHash('sha256').update(snapshot).digest('hex');
  }

  private path(value: string): string { return isAbsolute(value) ? value : resolve(process.cwd(), '..', value); }
}
