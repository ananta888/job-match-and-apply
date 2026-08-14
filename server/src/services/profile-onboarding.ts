import { constants } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type { AppConfig } from '../domain/models.js';

export interface ApplicationProfileSetupStatus {
  contract: 'application-profile-setup';
  contractVersion: '1.0';
  candidateProfile: 'present' | 'missing';
  styleProfile: 'present' | 'missing';
  initialized: boolean;
  containsCandidateFacts: boolean;
  note: string;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw Object.assign(new Error('profile_path_symlink_forbidden'), { statusCode: 409 });
    return stats.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Creates only empty, repository-provided templates; it never invents candidate facts or overwrites profiles. */
export class ApplicationProfileOnboardingService {
  constructor(
    private readonly settings: AppConfig['assistant'],
    private readonly repositoryRoot = resolve(process.cwd(), '..')
  ) {}

  async status(containsCandidateFacts = false): Promise<ApplicationProfileSetupStatus> {
    const { candidate, style } = this.paths();
    const [candidatePresent, stylePresent] = await Promise.all([
      regularFileExists(candidate),
      regularFileExists(style)
    ]);
    const initialized = candidatePresent && stylePresent;
    return {
      contract: 'application-profile-setup',
      contractVersion: '1.0',
      candidateProfile: candidatePresent ? 'present' : 'missing',
      styleProfile: stylePresent ? 'present' : 'missing',
      initialized,
      containsCandidateFacts: initialized && containsCandidateFacts,
      note: !initialized
        ? 'Leere lokale Profilvorlagen k\u00f6nnen ohne \u00dcberschreiben angelegt werden.'
        : containsCandidateFacts
          ? 'Profile und mindestens ein freigegebener Kandidaten-Claim sind lokal vorhanden.'
          : 'Profile sind angelegt; Kandidatenfakten m\u00fcssen noch vom Nutzer belegt und best\u00e4tigt werden.'
    };
  }

  async initialize(confirmed: true): Promise<ApplicationProfileSetupStatus & { created: Array<'candidate-profile' | 'style-profile'> }> {
    if (confirmed !== true) throw Object.assign(new Error('profile_setup_confirmation_required'), { statusCode: 409 });
    const { skill, candidate, style } = this.paths();
    const sources = {
      'candidate-profile': resolve(skill, 'candidate-profile.example.yaml'),
      'style-profile': resolve(skill, 'style-profile.example.yaml')
    } as const;
    await Promise.all(Object.values(sources).map((path) => access(path, constants.R_OK)));
    await mkdir(dirname(candidate), { recursive: true, mode: 0o700 });

    const created: Array<'candidate-profile' | 'style-profile'> = [];
    for (const [kind, destination] of [
      ['candidate-profile', candidate],
      ['style-profile', style]
    ] as const) {
      if (await regularFileExists(destination)) continue;
      try {
        await copyFile(sources[kind], destination, constants.COPYFILE_EXCL);
        await chmod(destination, 0o600);
        created.push(kind);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    return { ...(await this.status(false)), created };
  }

  private paths(): { skill: string; candidate: string; style: string } {
    const path = (value: string): string => isAbsolute(value) ? resolve(value) : resolve(this.repositoryRoot, value);
    const skill = path(this.settings.skillPath);
    const candidate = path(this.settings.candidateProfilePath);
    const style = path(this.settings.styleProfilePath);
    const privateRoot = resolve(this.repositoryRoot, '.local-data', 'profiles');
    if (!isWithin(privateRoot, candidate) || !isWithin(privateRoot, style)) {
      throw Object.assign(new Error('profile_setup_target_outside_private_root'), { statusCode: 409 });
    }
    if (basename(candidate) !== 'candidate-profile.yaml' || basename(style) !== 'style-profile.yaml' || dirname(candidate) !== dirname(style)) {
      throw Object.assign(new Error('profile_setup_paths_not_canonical'), { statusCode: 409 });
    }
    return { skill, candidate, style };
  }
}
