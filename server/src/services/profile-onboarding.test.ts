import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApplicationProfileOnboardingService } from './profile-onboarding.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('ApplicationProfileOnboardingService', () => {
  it('creates empty local templates once and never overwrites them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'application-profile-setup-'));
    roots.push(root);
    const skill = join(root, 'integrations', 'assistant');
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, 'candidate-profile.example.yaml'), 'claims: []\n', 'utf8');
    await writeFile(join(skill, 'style-profile.example.yaml'), 'style_profile: {}\n', 'utf8');
    const service = new ApplicationProfileOnboardingService({
      skillPath: 'integrations/assistant',
      candidateProfilePath: '.local-data/profiles/candidate-profile.yaml',
      styleProfilePath: '.local-data/profiles/style-profile.yaml'
    }, root);

    expect((await service.status()).initialized).toBe(false);
    expect((await service.initialize(true)).created).toEqual(['candidate-profile', 'style-profile']);
    await writeFile(join(root, '.local-data', 'profiles', 'candidate-profile.yaml'), 'user-owned: true\n', 'utf8');
    expect((await service.initialize(true)).created).toEqual([]);
    expect(await readFile(join(root, '.local-data', 'profiles', 'candidate-profile.yaml'), 'utf8')).toBe('user-owned: true\n');
  });

  it('rejects configured targets outside the private profile root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'application-profile-setup-'));
    roots.push(root);
    const service = new ApplicationProfileOnboardingService({
      skillPath: 'integrations/assistant',
      candidateProfilePath: 'candidate-profile.yaml',
      styleProfilePath: 'style-profile.yaml'
    }, root);
    await expect(service.status()).rejects.toThrow('outside_private_root');
  });
});
