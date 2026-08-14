import type { WorkspaceStore } from './workspace-store.js';

export async function applyRetention(
  workspace: WorkspaceStore,
  policy: { enabled: boolean; days: number },
  now: Date
) {
  if (!policy.enabled) return { applied: false, cutoff: null, removed: {} };
  if (!Number.isInteger(policy.days) || policy.days < 1 || policy.days > 3650) throw Object.assign(new Error('Aufbewahrung muss zwischen 1 und 3650 Tagen liegen.'), { statusCode: 400 });
  const cutoff = new Date(now.getTime() - policy.days * 86_400_000).toISOString();
  return { applied: true, cutoff, removed: await workspace.purgeBefore(cutoff) };
}
