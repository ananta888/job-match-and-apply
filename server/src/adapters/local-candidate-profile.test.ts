import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalCandidateProfileAdapter } from './local-candidate-profile.js';

let directory = '';
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = ''; });

describe('LocalCandidateProfileAdapter', () => {
  it('reads and safely patches a private candidate profile', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'candidate-profile-'));
    const root = resolve(process.cwd(), '..');
    const source = resolve(root, 'integrations', 'bewerbungs-schreib-assistent', 'tests', 'fixtures', 'valid-candidate.yaml');
    const candidate = resolve(directory, 'candidate.yaml');
    await copyFile(source, candidate);
    const adapter = new LocalCandidateProfileAdapter({
      skillPath: resolve(root, 'integrations', 'bewerbungs-schreib-assistent'), candidateProfilePath: candidate,
      styleProfilePath: resolve(root, 'integrations', 'bewerbungs-schreib-assistent', 'tests', 'fixtures', 'valid-style.yaml')
    });
    expect((await adapter.summary()).valid).toBe(true);
    const result = await adapter.patch([{ claimId: 'claim-role', field: 'statement', value: 'Senior Engineer bei Example GmbH' }], true);
    expect(result.updatedClaimIds).toEqual(['claim-role']);
    expect((await adapter.summary()).claims.find((claim) => claim.id === 'claim-role')?.statement).toContain('Senior Engineer');
    const imported = await adapter.addImportProposals([{
      id: 'claim-adapter-import', statement: 'Synthetic adapter import.', sha256: 'a'.repeat(64)
    }], true);
    expect(imported.addedClaimIds).toEqual(['claim-adapter-import']);
    expect((await adapter.summary()).claims.find((claim) => claim.id === 'claim-adapter-import')?.status).toBe('unverified');
  });
});
