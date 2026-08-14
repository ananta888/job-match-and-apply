import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  createAgentBackupBundle, restoreAgentBackupBundle, validateAgentBackup, validateAgentBackupBundle,
  type AgentBackupClassification, type AgentBackupFaultInjector, type AgentBackupManifest
} from './backup.js';

const ROOT_CLASSIFICATION = {
  'agent-runs': 'personal',
  'agent-artifacts': 'personal',
  'agent-idempotency': 'internal',
  'agent-config': 'internal',
  'agent-retention': 'personal',
  'agent-observability': 'internal',
  keys: 'secret'
} as const satisfies Record<string, AgentBackupClassification>;

export interface PortableAgentBackupInventory {
  files: Array<{ path: string; classification: AgentBackupClassification }>;
  totalBytes: number;
  roots: string[];
}

function contained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('portable_backup_path_escape');
}

/** Enumerates only documented agent-control roots; arbitrary .local-data content is never swept in. */
export async function buildPortableAgentBackupInventory(
  localDataRoot: string,
  limits: { maxFiles?: number; maxTotalBytes?: number } = {},
): Promise<PortableAgentBackupInventory> {
  const configuredRoot = resolve(localDataRoot);
  const rootInfo = await lstat(configuredRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('portable_backup_root_unsafe');
  const root = await realpath(configuredRoot);
  const maxFiles = limits.maxFiles ?? 100_000;
  const maxTotalBytes = limits.maxTotalBytes ?? 4 * 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) throw new Error('portable_backup_limits_invalid');
  const files: PortableAgentBackupInventory['files'] = [];
  let totalBytes = 0;
  const presentRoots: string[] = [];
  for (const [directoryName, classification] of Object.entries(ROOT_CLASSIFICATION)) {
    const directory = resolve(root, directoryName); contained(root, directory);
    try {
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory() || await realpath(directory) !== directory) throw new Error('portable_backup_root_unsafe');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    presentRoots.push(directoryName);
    const pending = [directory];
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const name of (await readdir(current)).sort().reverse()) {
        const absolute = resolve(current, name); contained(directory, absolute);
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) throw new Error('portable_backup_symlink_forbidden');
        if (info.isDirectory()) { pending.push(absolute); continue; }
        if (!info.isFile() || await realpath(absolute) !== absolute) throw new Error('portable_backup_entry_unsafe');
        const path = relative(root, absolute).replaceAll('\\', '/');
        totalBytes += info.size;
        if (files.length + 1 > maxFiles) throw new Error('portable_backup_file_limit');
        if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalBytes) throw new Error('portable_backup_byte_limit');
        files.push({ path, classification });
      }
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, totalBytes, roots: presentRoots.sort() };
}

export interface PortableAgentBackupDrillResult {
  manifest: AgentBackupManifest;
  inventory: PortableAgentBackupInventory;
  restoredFiles: number;
  restoredBytes: number;
}

/** Creates, validates, restores, and revalidates a synthetic/approved local recovery target. */
export async function runPortableAgentBackupDrill(input: {
  localDataRoot: string;
  bundleRoot: string;
  restoreTarget: string;
  now?: Date;
  faultInjector?: AgentBackupFaultInjector;
  verifyRestored?: (restoredLocalDataRoot: string) => Promise<void>;
}): Promise<PortableAgentBackupDrillResult> {
  const inventory = await buildPortableAgentBackupInventory(input.localDataRoot);
  if (inventory.files.length === 0) throw new Error('portable_backup_inventory_empty');
  const created = await createAgentBackupBundle(input.localDataRoot, input.bundleRoot, inventory.files, input.now ?? new Date(), input.faultInjector);
  const bundleValidation = await validateAgentBackupBundle(input.bundleRoot);
  if (!bundleValidation.valid) throw new Error(`portable_backup_bundle_invalid:${bundleValidation.errors[0]?.reason ?? 'unknown'}`);
  const restored = await restoreAgentBackupBundle(input.bundleRoot, input.restoreTarget, {
    approvedTargetRoot: input.restoreTarget, faultInjector: input.faultInjector
  });
  const restoredValidation = await validateAgentBackup(input.restoreTarget, created.manifest);
  if (!restoredValidation.valid) throw new Error(`portable_backup_restore_invalid:${restoredValidation.errors[0]?.reason ?? 'unknown'}`);
  await input.verifyRestored?.(input.restoreTarget);
  return { manifest: created.manifest, inventory, restoredFiles: restored.files, restoredBytes: restored.bytes };
}
