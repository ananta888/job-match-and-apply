import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp, createDefaultAgentApiDependencies } from './app.js';
import { MemoryAuditLogger } from './services/audit-logger.js';
import { MemoryConfigStore } from './services/config-store.js';
import { MemoryWorkspaceStore } from './services/workspace-store.js';

async function waitForTerminal(app: ReturnType<typeof createApp>, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await request(app).get(`/api/agent-runs/${runId}`);
    if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(result.body.status as string)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('synthetic run did not terminate');
}

describe('agent usage API', () => {
  it('exposes normalized units, explicit unknowns, budgets and aggregate dimensions without payload content', async () => {
    const dependencies = createDefaultAgentApiDependencies(true);
    const app = createApp(
      new MemoryConfigStore(), new MemoryAuditLogger(), new MemoryWorkspaceStore(), undefined, dependencies,
    );
    const prompt = 'USAGE-PAYLOAD-MUST-NOT-ECHO';
    const created = await request(app).post('/api/agent-runs').send({
      providerId: 'fake', prompt, workspaceMode: 'read_only', network: false,
    }).expect(201);
    await waitForTerminal(app, created.body.id as string);
    const usage = await request(app).get(`/api/agent-runs/${created.body.id}/usage`).expect(200);
    expect(usage.headers['cache-control']).toBe('no-store');
    expect(usage.body).toMatchObject({
      contract: 'agent-run-usage', contractVersion: '1.0', runId: created.body.id,
      measurement: { provider: 'fake', source: 'unknown' },
      points: expect.arrayContaining([
        expect.objectContaining({ name: 'total_tokens', unit: 'tokens', value: null, source: 'unknown' }),
        expect.objectContaining({ name: 'tool_calls', unit: 'calls', value: 0 }),
        expect.objectContaining({ name: 'run_duration', unit: 'milliseconds' }),
      ]),
    });
    expect(JSON.stringify(usage.body)).not.toContain(prompt);
    const trend = await request(app).get('/api/agents/usage/trends?groupBy=provider').expect(200);
    expect(trend.body).toMatchObject({
      contract: 'agent-usage-trend', contractVersion: '1.0', groupBy: 'provider',
      groups: expect.arrayContaining([expect.objectContaining({ key: 'fake', runs: 1 })]),
    });
  });
});
