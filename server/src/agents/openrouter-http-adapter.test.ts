import { describe, expect, it } from 'vitest';
import {
  OpenRouterHttpAgentAdapter,
  openrouterEvidenceProblem,
  openrouterOutputProblem,
  reasoningParameter,
} from './openrouter-http-adapter.js';
import type { AgentEventDraft, ProviderRunContext } from '../ports/agent-runner.js';

const FINAL_HTML = '<!doctype html><html lang="de"><head><title>Bewerbung</title></head><body data-result="final-agent-html"><h1>Bewerbung</h1></body></html>';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface FakeFetchCall {
  url: string;
  body: Record<string, unknown>;
}

function harness(responses: Array<Response | Error | 'hang'>, key = 'sk-test-not-real') {
  const calls: FakeFetchCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = calls.length;
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const next = responses[Math.min(call, responses.length - 1)] ?? responses[responses.length - 1]!;
    if (next instanceof Error) throw next;
    if (next === 'hang') {
      const signal = init?.signal as AbortSignal | undefined;
      return {
        ok: true, status: 200,
        arrayBuffer: () => new Promise<never>((_, reject) => {
          const abort = (): void => reject(
            signal?.reason instanceof Error ? signal.reason : new Error('openrouter_run_cancelled'),
          );
          if (signal?.aborted) { abort(); return; }
          signal?.addEventListener('abort', abort, { once: true });
        }),
      } as unknown as Response;
    }
    return next.clone();
  }) as typeof fetch;
  const events: AgentEventDraft[] = [];
  const adapter = new OpenRouterHttpAgentAdapter({
    fetchImpl,
    credentialEnv: () => (key ? { OPENROUTER_API_KEY: key } : {}),
    defaultModel: 'deepseek/deepseek-v4.1-flash',
  });
  const context = (overrides: Partial<ProviderRunContext['request']> = {}): ProviderRunContext => ({
    runId: 'run-http-1',
    installation: {
      provider: 'openrouter', runtimeTarget: 'linux', executable: 'https://openrouter.ai/api/v1/chat/completions',
      version: 'openrouter-http 1.0.0', support: 'supported', authStatus: 'authenticated',
    },
    request: {
      provider: 'openrouter', task: 'Erstelle das Dokument.', workspaceRoot: '/work',
      runtimeTarget: 'linux', sandbox: 'read-only', network: 'disabled', approvalMode: 'deny',
      limits: { wallTimeMs: 30_000 },
      ...overrides,
    },
    emit: async (event) => { events.push(event); },
  });
  return { adapter, events, calls, context };
}

describe('OpenRouterHttpAgentAdapter', () => {
  it('delivers the final HTML and reports provider-reported usage and costs cumulatively', async () => {
    const { adapter, events, calls, context } = harness([
      jsonResponse({ choices: [{ message: { content: FINAL_HTML } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.001 } }),
    ]);
    const handle = await adapter.start(context({ model: 'deepseek/deepseek-v4.1-flash', metadata: { outputRefs: ['final_html'], reasoning: 'low' } }));
    const result = await handle.completion;
    expect(result).toEqual({ state: 'succeeded' });
    expect(calls[0]?.body.model).toBe('deepseek/deepseek-v4.1-flash');
    expect(calls[0]?.body.reasoning).toEqual({ effort: 'low' });
    expect(calls[0]?.body.temperature).toBe(0.2);
    expect(calls[0]?.body.provider).toEqual({ sort: 'throughput' });
    expect(events.at(-1)).toMatchObject({ kind: 'agent_message_completed', data: { text: FINAL_HTML } });
    const usage = events.filter((event) => event.kind === 'usage_updated').at(-1);
    expect(usage?.data).toMatchObject({ inputTokens: 100, outputTokens: 50, totalTokens: 150, costMicros: 1_000, costEstimated: true });
    // The raw key must never appear in any emitted event.
    expect(JSON.stringify(events)).not.toContain('sk-test-not-real');
  });

  it('accumulates usage over correction calls and never invents missing costs', async () => {
    const { adapter, events, context } = harness([
      jsonResponse({ choices: [{ message: { content: 'kein HTML' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
      jsonResponse({ choices: [{ message: { content: FINAL_HTML } }], usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 } }),
    ]);
    const handle = await adapter.start(context({ metadata: { outputRefs: ['final_html'] } }));
    const result = await handle.completion;
    expect(result).toEqual({ state: 'succeeded' });
    const usageEvents = events.filter((event) => event.kind === 'usage_updated');
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents.at(-1)?.data).toMatchObject({ inputTokens: 30, outputTokens: 12, totalTokens: 42, costUnknown: true });
    expect(usageEvents.at(-1)?.data).not.toHaveProperty('costMicros');
    expect(events.some((event) => event.kind === 'warning'
      && (event.data as Record<string, unknown>).code === 'openrouter_usage_without_cost')).toBe(true);
  });

  it('fails with a contract violation after bounded correction rounds', async () => {
    const { adapter, context } = harness([
      jsonResponse({ choices: [{ message: { content: 'immer noch kein HTML' } }], usage: {} }),
      jsonResponse({ choices: [{ message: { content: 'immer noch kein HTML' } }], usage: {} }),
    ]);
    const handle = await adapter.start(context({ metadata: { outputRefs: ['final_html'] } }));
    const result = await handle.completion;
    expect(result.state).toBe('failed');
    expect(result.failure).toMatchObject({ code: 'validation_contract_violation', retryable: false });
  });

  it('maps provider errors to honest failure categories', async () => {
    for (const [status, code, retryable] of [
      [429, 'rate_limit', true], [500, 'provider_unavailable', true], [401, 'provider_auth_failed', false],
    ] as const) {
      const { adapter, context } = harness([jsonResponse({ error: 'x' }, status)]);
      const handle = await adapter.start(context({ metadata: { outputRefs: ['final_html'] } }));
      const result = await handle.completion;
      expect(result.state).toBe('failed');
      expect(result.failure).toMatchObject({ code, retryable });
    }
  });

  it('cancels an in-flight call and distinguishes timeout from cancellation', async () => {
    const { adapter, context } = harness(['hang']);
    const handle = await adapter.start(context({ limits: { wallTimeMs: 30_000 }, metadata: { outputRefs: ['final_html'] } }));
    await adapter.cancel('run-http-1');
    const result = await handle.completion;
    expect(result.state).toBe('cancelled');

    const timeoutHarness = harness(['hang']);
    const timeoutHandle = await timeoutHarness.adapter.start(timeoutHarness.context({ limits: { wallTimeMs: 1_000 }, metadata: { outputRefs: ['final_html'] } }));
    const timeoutResult = await timeoutHandle.completion;
    expect(timeoutResult.state).toBe('timed_out');
    expect(timeoutResult.failure).toMatchObject({ code: 'timed_out' });
  });

  it('falls back from disabled reasoning and reports the effective level', async () => {
    const { adapter, calls, events, context } = harness([
      jsonResponse({ error: 'reasoning cannot be disabled' }, 400),
      jsonResponse({ choices: [{ message: { content: FINAL_HTML } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    ]);
    const handle = await adapter.start(context({ metadata: { outputRefs: ['final_html'], reasoning: 'off' } }));
    const result = await handle.completion;
    expect(result).toEqual({ state: 'succeeded' });
    expect(calls[0]?.body.reasoning).toEqual({ enabled: false });
    expect(calls[1]?.body.reasoning).toEqual({ effort: 'low' });
    expect(events.filter((event) => event.kind === 'usage_updated').at(-1)?.data).toMatchObject({ reasoning: 'low' });
  });

  it('treats escaped evidence annotations inside JSON answers as data (lab bug A regression)', async () => {
    const review = JSON.stringify({
      findings: [{ description: 'text with <!-- evidence:invented-claim --> escaped inside a JSON string' }],
    });
    const { adapter, context } = harness([
      jsonResponse({ choices: [{ message: { content: review } }], usage: {} }),
    ]);
    const handle = await adapter.start(context({ metadata: { outputRefs: ['ats_review'] } }));
    expect(await handle.completion).toEqual({ state: 'succeeded' });
  });

  it('rejects plain-text evidence annotations referencing unknown claims', async () => {
    const draft = 'Station eins. <!-- evidence:claim-missing -->';
    const { adapter, context } = harness([
      jsonResponse({ choices: [{ message: { content: draft } }], usage: {} }),
      jsonResponse({ choices: [{ message: { content: draft } }], usage: {} }),
    ]);
    const handle = await adapter.start(context({
      metadata: { outputRefs: ['annotated_draft'], allowedEvidenceIds: ['claim-1'] },
    }));
    const result = await handle.completion;
    expect(result.state).toBe('failed');
    expect(result.failure?.message).toContain('claim-missing');
  });

  it('fails closed without a vault key and reports discovery honestly', async () => {
    const { adapter, context } = harness([], '');
    const handle = await adapter.start(context());
    const result = await handle.completion;
    expect(result.state).toBe('failed');
    expect(result.failure).toMatchObject({ code: 'provider_auth_failed', retryable: false });

    const withoutKey = harness([], '');
    expect((await withoutKey.adapter.discover())[0]).toMatchObject({ support: 'unavailable', authStatus: 'unauthenticated' });
    const withKey = harness([]);
    expect((await withKey.adapter.discover())[0]).toMatchObject({ support: 'supported', authStatus: 'authenticated' });
  });

  it('checks model existence and reasoning support against the provider contract', async () => {
    const fetchImpl = (async () => jsonResponse({
      data: [{ id: 'deepseek/deepseek-v4.1-flash', supported_parameters: ['reasoning', 'tools'] }, { id: 'other/model' }],
    })) as typeof fetch;
    const adapter = new OpenRouterHttpAgentAdapter({ fetchImpl, credentialEnv: () => ({ OPENROUTER_API_KEY: 'sk-test' }) });
    await expect(adapter.checkModel('deepseek/deepseek-v4.1-flash')).resolves.toMatchObject({ exists: true, reasoningSupported: true });
    await expect(adapter.checkModel('other/model')).resolves.toMatchObject({ exists: true, reasoningSupported: null });
    await expect(adapter.checkModel('unknown/model')).resolves.toMatchObject({ exists: false, reasoningSupported: null });
    const broken = new OpenRouterHttpAgentAdapter({
      fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch,
      credentialEnv: () => ({ OPENROUTER_API_KEY: 'sk-test' }),
    });
    await expect(broken.checkModel('deepseek/deepseek-v4.1-flash')).resolves.toMatchObject({ exists: false, reasoningSupported: null });
  });

  it('keeps the output and evidence contracts strict where they matter', () => {
    expect(openrouterOutputProblem('plain text', [])).toBeNull();
    expect(openrouterOutputProblem('plain text', ['final_html'])).toContain('HTML5');
    expect(openrouterOutputProblem(FINAL_HTML.replace('data-result="final-agent-html"', ''), ['final_html'])).toContain('data-result');
    expect(openrouterOutputProblem(FINAL_HTML.replace('</body>', '<!-- evidence:x --></body>'), ['final_html'])).toContain('Evidence-Annotationen');
    expect(openrouterEvidenceProblem('x <!-- evidence:claim-1 -->', ['claim-1'])).toBeNull();
    expect(openrouterEvidenceProblem('x <!-- evidence:claim-2 -->', ['claim-1'])).toContain('claim-2');
    expect(reasoningParameter('default')).toEqual({});
    expect(reasoningParameter('off')).toEqual({ reasoning: { enabled: false } });
    expect(reasoningParameter('high')).toEqual({ reasoning: { effort: 'high' } });
  });
});

it('bounds generated tokens across correction calls and does not retry truncated answers', async () => {
  const h = harness([jsonResponse({choices: [{finish_reason: 'length', message: {content: 'partial'}}], usage: {prompt_tokens: 40, completion_tokens: 80}})]);
  const handle = await h.adapter.start(h.context({metadata: {outputRefs: ['final_html'], maxOutputTokens: 80}}));
  expect((await handle.completion).state).toBe('failed');
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]?.body.max_tokens).toBe(80);
  expect(h.events.some(e => e.data.code === 'openrouter_output_truncated')).toBe(true);
});

it('accepts editorial annotations without admitting unknown factual claims', () => {
  expect(openrouterEvidenceProblem('Überschrift <!-- evidence:editorial -->', ['claim-known'])).toBeNull();
  expect(openrouterEvidenceProblem('Behauptung <!-- evidence:claim-unknown -->', ['claim-known'])).toBeTruthy();
});

it('cannot spend a second answer allowance when the provider omits completion usage', async () => {
  const h = harness([jsonResponse({choices: [{message: {content: 'invalid html'}}]})]);
  const run = await h.adapter.start(h.context({metadata: {outputRefs: ['final_html'], maxOutputTokens: 100}}));
  expect((await run.completion).state).toBe('failed');
  expect(h.calls).toHaveLength(1);
});
it('subtracts known generated tokens before the correction request', async () => {
  const h = harness([
    jsonResponse({choices: [{message: {content: 'invalid html'}}], usage: {prompt_tokens: 10, completion_tokens: 30}}),
    jsonResponse({choices: [{message: {content: FINAL_HTML}}], usage: {prompt_tokens: 20, completion_tokens: 40}})
  ]);
  const run = await h.adapter.start(h.context({metadata: {outputRefs: ['final_html'], maxOutputTokens: 100}}));
  expect((await run.completion).state).toBe('succeeded');
  expect(h.calls.map(call => call.body.max_tokens)).toEqual([100, 70]);
});
