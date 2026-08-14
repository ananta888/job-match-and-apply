import { describe, expect, it } from 'vitest';
import { MemoryWorkspaceStore } from './workspace-store.js';
import { applyRetention } from './retention.js';

describe('retention', () => {
  it('is opt-in and uses the injected clock deterministically', async () => {
    const store = new MemoryWorkspaceStore();
    await store.saveSearchRun({ id: 'old', createdAt: '2025-01-01T00:00:00.000Z', profile: {} as never, sourceIds: [], matches: [] });
    await expect(applyRetention(store, { enabled: false, days: 30 }, new Date('2026-01-01T00:00:00Z'))).resolves.toMatchObject({ applied: false });
    expect(await store.listSearchRuns()).toHaveLength(1);
    const result = await applyRetention(store, { enabled: true, days: 30 }, new Date('2026-01-01T00:00:00Z'));
    expect(result).toMatchObject({ applied: true, removed: { searchRuns: 1 } });
    expect(await store.listSearchRuns()).toHaveLength(0);
  });
});
