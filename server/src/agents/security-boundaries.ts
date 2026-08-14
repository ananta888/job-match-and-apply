import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, parse, posix, relative, resolve, sep, win32 } from 'node:path';
import type { SandboxProfile } from './security-policy.js';

export type WorkspaceAccessMode = 'read_only' | 'read_write';
export type RuntimeTarget = 'windows' | 'wsl' | 'container';
export type PathFlavor = 'native' | 'win32' | 'posix';

export interface WorkspaceRegistration {
  id: string;
  root: string;
  accessMode: WorkspaceAccessMode;
}

export interface RegisteredWorkspace extends WorkspaceRegistration {
  canonicalRoot: string;
}

function pathApi(flavor: PathFlavor): typeof posix | typeof win32 {
  if (flavor === 'win32') return win32;
  if (flavor === 'posix') return posix;
  return process.platform === 'win32' ? win32 : posix;
}

function normalizeForComparison(value: string, flavor: PathFlavor): string {
  const api = pathApi(flavor);
  const normalized = api.normalize(value).replace(/[\\/]+$/, '');
  return flavor === 'win32' || (flavor === 'native' && process.platform === 'win32')
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

function fullyQualifiedWindowsPath(value: string): boolean {
  if (!win32.isAbsolute(value)) return false;
  const root = win32.parse(value).root;
  if (/^[A-Za-z]:[\\/]$/.test(root)) return true;
  if (!root.startsWith('\\\\') || root.startsWith('\\\\?\\') || root.startsWith('\\\\.\\')) return false;
  return root.split(/[\\/]+/).filter(Boolean).length === 2;
}

/** Lexical cross-platform containment check used in addition to realpath. */
export function isPathWithin(root: string, candidate: string, flavor: PathFlavor = 'native'): boolean {
  const api = pathApi(flavor);
  const windowsContract = flavor === 'win32' || (flavor === 'native' && process.platform === 'win32');
  if (windowsContract) {
    if (!fullyQualifiedWindowsPath(root) || !fullyQualifiedWindowsPath(candidate)) return false;
  } else if (!api.isAbsolute(root) || !api.isAbsolute(candidate)) return false;
  const normalizedRoot = normalizeForComparison(root, flavor);
  const normalizedCandidate = normalizeForComparison(candidate, flavor);
  const rel = api.relative(normalizedRoot, normalizedCandidate);
  return rel === '' || (!rel.startsWith(`..${api.sep}`) && rel !== '..' && !api.isAbsolute(rel));
}

function looksAbsoluteOnAnyPlatform(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value);
}

async function canonicalizePotentialPath(candidate: string): Promise<string> {
  let cursor = resolve(candidate);
  const missingSegments: string[] = [];
  while (true) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missingSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error('path_has_no_existing_ancestor');
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

export class WorkspaceRegistry {
  private readonly entries = new Map<string, RegisteredWorkspace>();

  async register(input: WorkspaceRegistration): Promise<RegisteredWorkspace> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.id)) throw new Error('workspace_id_invalid');
    if (!isAbsolute(input.root)) throw new Error('workspace_root_must_be_absolute');
    const canonicalRoot = await realpath(input.root);
    const info = await stat(canonicalRoot);
    if (!info.isDirectory()) throw new Error('workspace_root_not_directory');
    if (resolve(canonicalRoot) === parse(resolve(canonicalRoot)).root) throw new Error('workspace_root_too_broad');
    const entry: RegisteredWorkspace = { ...input, root: input.root, canonicalRoot };
    this.entries.set(input.id, Object.freeze(entry));
    return structuredClone(entry);
  }

  get(workspaceId: string): RegisteredWorkspace | undefined {
    const entry = this.entries.get(workspaceId);
    return entry ? structuredClone(entry) : undefined;
  }

  async resolvePath(
    workspaceId: string,
    relativePath: string,
    requiredMode: WorkspaceAccessMode = 'read_only',
    mustExist = true,
  ): Promise<string> {
    const workspace = this.entries.get(workspaceId);
    if (!workspace) throw new Error('workspace_not_registered');
    if (requiredMode === 'read_write' && workspace.accessMode !== 'read_write') throw new Error('workspace_write_not_allowed');
    if (!relativePath || looksAbsoluteOnAnyPlatform(relativePath) || relativePath.includes('\0')) {
      throw new Error('workspace_path_must_be_relative');
    }
    const candidate = resolve(workspace.canonicalRoot, relativePath);
    const canonicalCandidate = mustExist ? await realpath(candidate) : await canonicalizePotentialPath(candidate);
    if (!isPathWithin(workspace.canonicalRoot, canonicalCandidate)) throw new Error('workspace_path_escape');
    if (mustExist) await access(canonicalCandidate, requiredMode === 'read_write' ? constants.W_OK : constants.R_OK);
    return canonicalCandidate;
  }
}

export type ArgumentTemplatePart =
  | { type: 'literal'; value: string }
  | { type: 'slot'; name: string; kind: 'identifier' | 'integer' | 'enum' | 'workspace_path'; values?: readonly string[] };

export interface ExecutablePolicyEntry {
  providerId: string;
  runtimeTarget: RuntimeTarget;
  executablePath: string;
  argumentTemplate: readonly ArgumentTemplatePart[];
  workspaceIds: readonly string[];
  sandboxProfiles: readonly SandboxProfile[];
}

export interface ResolveLaunchRequest {
  providerId: string;
  runtimeTarget: RuntimeTarget;
  workspaceId: string;
  sandboxProfile: SandboxProfile;
  slots: Readonly<Record<string, string>>;
}

export interface SafeLaunchSpec {
  executable: string;
  argv: string[];
  cwd: string;
  shell: false;
  runtimeTarget: RuntimeTarget;
  workspaceId: string;
  sandboxProfile: SandboxProfile;
}

interface CanonicalExecutablePolicy extends ExecutablePolicyEntry {
  canonicalExecutablePath: string;
}

function validateLiteral(value: string): void {
  if (!value || value.includes('\0') || /[\r\n]/.test(value)) throw new Error('executable_literal_invalid');
}

function validateSlotValue(part: Extract<ArgumentTemplatePart, { type: 'slot' }>, value: string): string {
  if (!value || value.includes('\0') || /[\r\n]/.test(value)) throw new Error(`argument_slot_invalid:${part.name}`);
  if (part.kind !== 'workspace_path' && value.startsWith('-')) throw new Error(`argument_slot_option_injection:${part.name}`);
  if (part.kind === 'identifier' && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`argument_slot_invalid:${part.name}`);
  }
  if (part.kind === 'integer' && (!/^\d{1,9}$/.test(value) || !Number.isSafeInteger(Number(value)))) {
    throw new Error(`argument_slot_invalid:${part.name}`);
  }
  if (part.kind === 'enum' && !(part.values ?? []).includes(value)) throw new Error(`argument_slot_invalid:${part.name}`);
  return value;
}

/**
 * Converts only administrator-owned templates to argv arrays. Browser values
 * fill typed single-argument slots and can never select an executable or shell.
 */
export class ExecutableAllowlist {
  private readonly entries = new Map<string, CanonicalExecutablePolicy>();

  constructor(private readonly workspaces: WorkspaceRegistry) {}

  async register(entry: ExecutablePolicyEntry): Promise<void> {
    if (!entry.providerId.trim()) throw new Error('provider_id_required');
    if (!isAbsolute(entry.executablePath)) throw new Error('executable_path_must_be_absolute');
    const canonicalExecutablePath = await realpath(entry.executablePath);
    const info = await stat(canonicalExecutablePath);
    if (!info.isFile()) throw new Error('executable_not_file');
    await access(canonicalExecutablePath, constants.R_OK);
    for (const part of entry.argumentTemplate) {
      if (part.type === 'literal') validateLiteral(part.value);
      else if (!/^[a-z][a-z0-9_]{0,31}$/.test(part.name)) throw new Error('argument_slot_name_invalid');
    }
    const key = `${entry.runtimeTarget}:${entry.providerId}`;
    if (this.entries.has(key)) throw new Error('executable_policy_duplicate');
    this.entries.set(key, Object.freeze({ ...entry, canonicalExecutablePath }));
  }

  async resolveLaunch(request: ResolveLaunchRequest): Promise<SafeLaunchSpec> {
    const entry = this.entries.get(`${request.runtimeTarget}:${request.providerId}`);
    if (!entry) throw new Error('executable_not_allowlisted');
    if (!entry.workspaceIds.includes(request.workspaceId)) throw new Error('executable_workspace_not_allowed');
    if (!entry.sandboxProfiles.includes(request.sandboxProfile)) throw new Error('executable_sandbox_not_allowed');
    const workspace = this.workspaces.get(request.workspaceId);
    if (!workspace) throw new Error('workspace_not_registered');

    const declaredSlots = new Set(entry.argumentTemplate.filter((part) => part.type === 'slot').map((part) => part.name));
    if (Object.keys(request.slots).some((key) => !declaredSlots.has(key))) throw new Error('undeclared_argument_slot');

    const argv: string[] = [];
    for (const part of entry.argumentTemplate) {
      if (part.type === 'literal') {
        argv.push(part.value);
        continue;
      }
      const value = request.slots[part.name];
      if (value === undefined) throw new Error(`argument_slot_missing:${part.name}`);
      if (part.kind === 'workspace_path') {
        validateSlotValue(part, value);
        argv.push(await this.workspaces.resolvePath(request.workspaceId, value, 'read_only', true));
      } else {
        argv.push(validateSlotValue(part, value));
      }
    }
    return {
      executable: entry.canonicalExecutablePath,
      argv,
      cwd: workspace.canonicalRoot,
      shell: false,
      runtimeTarget: entry.runtimeTarget,
      workspaceId: request.workspaceId,
      sandboxProfile: request.sandboxProfile,
    };
  }
}
