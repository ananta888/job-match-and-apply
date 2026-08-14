import { createHash, randomUUID } from 'node:crypto';
import {
  lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

export type AgentBackupClassification = 'internal' | 'personal' | 'secret';

export interface AgentBackupEntry {
  path: string;
  sha256: string;
  bytes: number;
  classification: AgentBackupClassification;
}

/** 1.0 fields remain optional so existing manifests can be read and migrated. */
export interface AgentBackupManifest {
  contract: 'agent-control-backup';
  contractVersion: '1.0' | '1.1';
  createdAt: string;
  entries: AgentBackupEntry[];
  requiresKeyMaterial: boolean;
  backupId?: string;
  keyMaterialPaths?: string[];
  manifestSha256?: string;
}

export interface AgentBackupValidation {
  valid: boolean;
  checked: number;
  errors: Array<{ path: string; reason: string }>;
}

export interface AgentBackupMigration {
  fromVersion: '1.0' | '1.1';
  toVersion: '1.1';
  changed: boolean;
  changes: string[];
  manifest: AgentBackupManifest;
}

export interface AgentBackupBundleResult {
  bundleRoot: string;
  manifest: AgentBackupManifest;
}

export interface AgentRestoreOptions {
  /** Must resolve exactly to targetRoot. This is the caller's explicit restore approval. */
  approvedTargetRoot: string;
  dryRun?: boolean;
  /** Existing targets are never replaced unless this is explicitly true. */
  allowOverwrite?: boolean;
  /** Synthetic fault boundary for deterministic disk-full/rollback drills. */
  faultInjector?: AgentBackupFaultInjector;
}

export interface AgentBackupFaultInjector {
  afterFileWrite?(phase: 'backup' | 'restore', relativePath: string, index: number): void | Promise<void>;
  beforePublish?(phase: 'backup' | 'restore'): void | Promise<void>;
}

export interface AgentRestoreResult {
  status: 'planned' | 'restored';
  targetRoot: string;
  files: number;
  bytes: number;
  manifestVersion: '1.1';
  migrated: boolean;
  overwrite: boolean;
}

const CONTRACT = 'agent-control-backup' as const;
const CURRENT_VERSION = '1.1' as const;
const MANIFEST_FILE = 'manifest.json';
const FILES_DIRECTORY = 'files';
const SHA256 = /^[a-f0-9]{64}$/;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function manifestHash(manifest: AgentBackupManifest): string {
  const { manifestSha256: _ignored, ...signed } = manifest;
  return hash(stableJson(signed));
}

function safeRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || isAbsolute(value)
    || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))) {
    throw new Error('backup_path_is_not_safe');
  }
  return normalized;
}

function contained(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('backup_path_escape');
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function requirePlainFile(root: string, path: string): Promise<string> {
  const safePath = safeRelativePath(path);
  const absolute = resolve(root, safePath);
  contained(root, absolute);
  let cursor = root;
  for (const part of safePath.split('/')) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('backup_entry_symlink_forbidden');
  }
  const linkInfo = await lstat(absolute);
  if (!linkInfo.isFile()) throw new Error('backup_entry_is_not_a_file');
  const canonical = await realpath(absolute);
  contained(await realpath(root), canonical);
  return canonical;
}

async function readConsistentFile(root: string, path: string): Promise<Buffer> {
  const absolute = await requirePlainFile(root, path);
  const handle = await open(absolute, 'r');
  try {
    const before = await handle.stat();
    const value = await handle.readFile();
    const after = await handle.stat();
    if (!before.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || value.byteLength !== after.size) {
      throw new Error('backup_source_changed_during_read');
    }
    return value;
  } finally { await handle.close(); }
}

function inferredKeyPaths(entries: AgentBackupEntry[]): string[] {
  return entries.filter((entry) => entry.classification === 'secret'
    || /(?:^|\/)keys?(?:\/|$)/i.test(entry.path)
    || /\.(?:key|pem)$/i.test(entry.path)).map((entry) => entry.path).sort();
}

function checkedEntries(manifest: AgentBackupManifest): AgentBackupEntry[] {
  if (!Array.isArray(manifest.entries)) throw new Error('invalid_backup_manifest');
  const seen = new Set<string>();
  return manifest.entries.map((entry) => {
    if (!entry || !['internal', 'personal', 'secret'].includes(entry.classification)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !SHA256.test(entry.sha256)) {
      throw new Error('invalid_backup_entry');
    }
    const path = safeRelativePath(entry.path);
    const identity = process.platform === 'win32' ? path.toLowerCase() : path;
    if (seen.has(identity)) throw new Error('duplicate_backup_entry');
    seen.add(identity);
    return { ...entry, path };
  });
}

function validateManifestMetadata(manifest: AgentBackupManifest): void {
  if (!manifest || manifest.contract !== CONTRACT || !['1.0', '1.1'].includes(manifest.contractVersion)) {
    throw new Error('unsupported_backup_contract');
  }
  if (!Number.isFinite(Date.parse(manifest.createdAt)) || typeof manifest.requiresKeyMaterial !== 'boolean') throw new Error('invalid_backup_manifest');
  checkedEntries(manifest);
  if (manifest.contractVersion === '1.1') {
    if (!manifest.backupId || !/^[A-Za-z0-9-]{8,128}$/.test(manifest.backupId)
      || !Array.isArray(manifest.keyMaterialPaths) || !manifest.manifestSha256 || !SHA256.test(manifest.manifestSha256)) {
      throw new Error('invalid_backup_manifest');
    }
    const entryPaths = new Set(checkedEntries(manifest).map((entry) => process.platform === 'win32' ? entry.path.toLowerCase() : entry.path));
    const keyPaths = new Set<string>();
    for (const value of manifest.keyMaterialPaths) {
      const path = safeRelativePath(value);
      const identity = process.platform === 'win32' ? path.toLowerCase() : path;
      if (keyPaths.has(identity) || !entryPaths.has(identity)) throw new Error('invalid_key_material_declaration');
      keyPaths.add(identity);
    }
    if (manifest.requiresKeyMaterial !== (keyPaths.size > 0)) throw new Error('invalid_key_material_declaration');
    if (manifest.manifestSha256 !== manifestHash(manifest)) throw new Error('manifest_hash_mismatch');
  }
}

function finalizeManifest(unsigned: Omit<AgentBackupManifest, 'manifestSha256'>): AgentBackupManifest {
  const manifest: AgentBackupManifest = { ...unsigned };
  manifest.manifestSha256 = manifestHash(manifest);
  validateManifestMetadata(manifest);
  return manifest;
}

export async function createAgentBackupManifest(
  root: string,
  files: Array<{ path: string; classification: AgentBackupClassification }>,
  now = new Date()
): Promise<AgentBackupManifest> {
  const canonicalRoot = await realpath(resolve(root));
  const entries: AgentBackupEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of files) {
    const path = safeRelativePath(candidate.path);
    const identity = process.platform === 'win32' ? path.toLowerCase() : path;
    if (seen.has(identity)) throw new Error('duplicate_backup_entry');
    seen.add(identity);
    const value = await readConsistentFile(canonicalRoot, path);
    entries.push({ path, classification: candidate.classification, bytes: value.byteLength, sha256: hash(value) });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const keyMaterialPaths = inferredKeyPaths(entries);
  return finalizeManifest({
    contract: CONTRACT, contractVersion: CURRENT_VERSION, backupId: randomUUID(), createdAt: now.toISOString(), entries,
    requiresKeyMaterial: keyMaterialPaths.length > 0, keyMaterialPaths
  });
}

export async function validateAgentBackup(root: string, manifest: AgentBackupManifest): Promise<AgentBackupValidation> {
  try { validateManifestMetadata(manifest); } catch (error) {
    return { valid: false, checked: 0, errors: [{ path: '', reason: error instanceof Error ? error.message : String(error) }] };
  }
  const canonicalRoot = resolve(root);
  const errors: AgentBackupValidation['errors'] = [];
  const entries = checkedEntries(manifest);
  const keyPaths = new Set(manifest.keyMaterialPaths ?? inferredKeyPaths(entries));
  for (const entry of entries) {
    try {
      const value = await readConsistentFile(canonicalRoot, entry.path);
      if (value.byteLength !== entry.bytes) throw new Error('size_mismatch');
      if (hash(value) !== entry.sha256) throw new Error('hash_mismatch');
    } catch (error) {
      const reason = keyPaths.has(entry.path) && (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'key_material_missing' : error instanceof Error ? error.message : String(error);
      errors.push({ path: entry.path, reason });
    }
  }
  if (manifest.requiresKeyMaterial && keyPaths.size === 0) errors.push({ path: '', reason: 'key_material_not_declared' });
  return { valid: errors.length === 0, checked: entries.length, errors };
}

export function migrateAgentBackupManifest(manifest: AgentBackupManifest): AgentBackupMigration {
  if (!manifest || manifest.contract !== CONTRACT || !['1.0', '1.1'].includes(manifest.contractVersion)) throw new Error('unsupported_backup_contract');
  if (manifest.contractVersion === '1.1') {
    validateManifestMetadata(manifest);
    return { fromVersion: '1.1', toVersion: CURRENT_VERSION, changed: false, changes: [], manifest: structuredClone(manifest) };
  }
  if (!Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('invalid_backup_manifest');
  const entries = checkedEntries(manifest).sort((left, right) => left.path.localeCompare(right.path));
  const keyMaterialPaths = inferredKeyPaths(entries);
  const migrated = finalizeManifest({
    contract: CONTRACT, contractVersion: CURRENT_VERSION,
    backupId: `migrated-${hash(stableJson(manifest)).slice(0, 24)}`,
    createdAt: manifest.createdAt, entries,
    requiresKeyMaterial: manifest.requiresKeyMaterial || keyMaterialPaths.length > 0,
    keyMaterialPaths
  });
  return {
    fromVersion: '1.0', toVersion: CURRENT_VERSION, changed: true,
    changes: ['backupId_added', 'keyMaterialPaths_added', 'manifest_hash_added'], manifest: migrated
  };
}

export async function createAgentBackupBundle(
  sourceRoot: string,
  bundleRoot: string,
  files: Array<{ path: string; classification: AgentBackupClassification }>,
  now = new Date(),
  faultInjector?: AgentBackupFaultInjector,
): Promise<AgentBackupBundleResult> {
  const source = await realpath(resolve(sourceRoot));
  const target = resolve(bundleRoot);
  if (target === parse(target).root) throw new Error('backup_target_is_not_safe');
  if (await exists(target)) throw new Error('backup_target_exists');
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const canonicalParent = await realpath(parent);
  const canonicalTarget = resolve(canonicalParent, basename(target));
  contained(canonicalParent, canonicalTarget);
  const stage = await mkdtemp(join(canonicalParent, `.${basename(target)}.staging-`));
  try {
    const entries: AgentBackupEntry[] = [];
    const seen = new Set<string>();
    for (const candidate of files) {
      const path = safeRelativePath(candidate.path);
      const identity = process.platform === 'win32' ? path.toLowerCase() : path;
      if (seen.has(identity)) throw new Error('duplicate_backup_entry');
      seen.add(identity);
      const value = await readConsistentFile(source, path);
      const destination = resolve(stage, FILES_DIRECTORY, path);
      contained(stage, destination);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, value, { flag: 'wx', mode: candidate.classification === 'secret' ? 0o600 : 0o640 });
      await faultInjector?.afterFileWrite?.('backup', path, entries.length + 1);
      entries.push({ path, classification: candidate.classification, bytes: value.byteLength, sha256: hash(value) });
    }
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const keyMaterialPaths = inferredKeyPaths(entries);
    const manifest = finalizeManifest({
      contract: CONTRACT, contractVersion: CURRENT_VERSION, backupId: randomUUID(), createdAt: now.toISOString(), entries,
      requiresKeyMaterial: keyMaterialPaths.length > 0, keyMaterialPaths
    });
    await writeFile(join(stage, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const validation = await validateAgentBackup(join(stage, FILES_DIRECTORY), manifest);
    if (!validation.valid) throw new Error(`backup_bundle_validation_failed:${validation.errors[0]?.reason ?? 'unknown'}`);
    await faultInjector?.beforePublish?.('backup');
    await rename(stage, canonicalTarget);
    return { bundleRoot: canonicalTarget, manifest };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export async function readAgentBackupManifest(bundleRoot: string): Promise<AgentBackupManifest> {
  const bundle = resolve(bundleRoot);
  const manifestPath = await requirePlainFile(bundle, MANIFEST_FILE);
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { throw new Error('invalid_backup_manifest_json'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('invalid_backup_manifest');
  return parsed as AgentBackupManifest;
}

export async function validateAgentBackupBundle(bundleRoot: string): Promise<AgentBackupValidation> {
  try {
    const manifest = await readAgentBackupManifest(bundleRoot);
    return validateAgentBackup(resolve(bundleRoot, FILES_DIRECTORY), manifest);
  } catch (error) {
    return { valid: false, checked: 0, errors: [{ path: '', reason: error instanceof Error ? error.message : String(error) }] };
  }
}

function approvedRestoreTarget(targetRoot: string, approvedTargetRoot: string): string {
  const target = resolve(targetRoot);
  const approved = resolve(approvedTargetRoot);
  if (target !== approved) throw new Error('restore_target_not_explicitly_approved');
  if (target === parse(target).root || basename(target) === '.' || basename(target) === '..') throw new Error('restore_target_is_not_safe');
  return target;
}

export async function restoreAgentBackupBundle(
  bundleRoot: string,
  targetRoot: string,
  options: AgentRestoreOptions
): Promise<AgentRestoreResult> {
  const bundle = await realpath(resolve(bundleRoot));
  const target = approvedRestoreTarget(targetRoot, options.approvedTargetRoot);
  const targetParent = dirname(target);
  let canonicalParent: string;
  try { canonicalParent = await realpath(targetParent); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('restore_target_parent_missing');
    throw error;
  }
  const canonicalTarget = resolve(canonicalParent, basename(target));
  contained(canonicalParent, canonicalTarget);
  const targetRelativeToBundle = relative(bundle, canonicalTarget);
  const bundleRelativeToTarget = relative(canonicalTarget, bundle);
  if ((!targetRelativeToBundle.startsWith('..') && !isAbsolute(targetRelativeToBundle))
    || (!bundleRelativeToTarget.startsWith('..') && !isAbsolute(bundleRelativeToTarget))) {
    throw new Error('restore_target_overlaps_backup');
  }
  const existing = await exists(canonicalTarget);
  if (existing) {
    const info = await lstat(canonicalTarget);
    if (info.isSymbolicLink()) throw new Error('restore_target_symlink_forbidden');
    if (!info.isDirectory()) throw new Error('restore_target_is_not_directory');
    if (!options.allowOverwrite) throw new Error('restore_target_exists');
  }
  const originalManifest = await readAgentBackupManifest(bundle);
  const migration = migrateAgentBackupManifest(originalManifest);
  const validation = await validateAgentBackup(join(bundle, FILES_DIRECTORY), originalManifest);
  if (!validation.valid) throw new Error(`backup_not_recoverable:${validation.errors[0]?.reason ?? 'unknown'}`);
  const entries = checkedEntries(migration.manifest);
  const result: AgentRestoreResult = {
    status: options.dryRun ? 'planned' : 'restored', targetRoot: canonicalTarget, files: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), manifestVersion: CURRENT_VERSION,
    migrated: migration.changed, overwrite: existing
  };
  if (options.dryRun) return result;

  const stage = await mkdtemp(join(canonicalParent, `.${basename(target)}.restore-`));
  const rollback = join(canonicalParent, `.${basename(target)}.rollback-${randomUUID()}`);
  let movedExisting = false;
  try {
    for (const entry of entries) {
      const source = await requirePlainFile(join(bundle, FILES_DIRECTORY), entry.path);
      const value = await readFile(source);
      if (value.byteLength !== entry.bytes || hash(value) !== entry.sha256) throw new Error(`backup_changed_after_preflight:${entry.path}`);
      const destination = resolve(stage, entry.path);
      contained(stage, destination);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, value, { flag: 'wx', mode: entry.classification === 'secret' ? 0o600 : 0o640 });
      await options.faultInjector?.afterFileWrite?.('restore', entry.path, entries.indexOf(entry) + 1);
    }
    const stagedValidation = await validateAgentBackup(stage, migration.manifest);
    if (!stagedValidation.valid) throw new Error(`restore_stage_validation_failed:${stagedValidation.errors[0]?.reason ?? 'unknown'}`);
    await writeFile(join(stage, MANIFEST_FILE), `${JSON.stringify(migration.manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (existing) { await rename(canonicalTarget, rollback); movedExisting = true; }
    await options.faultInjector?.beforePublish?.('restore');
    try { await rename(stage, canonicalTarget); }
    catch (error) {
      if (movedExisting) await rename(rollback, canonicalTarget);
      throw error;
    }
    if (movedExisting) await rm(rollback, { recursive: true, force: true });
    return result;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (movedExisting && await exists(rollback) && !(await exists(canonicalTarget))) await rename(rollback, canonicalTarget);
    throw error;
  }
}
