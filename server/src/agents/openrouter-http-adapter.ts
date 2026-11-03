import {
  AGENT_CONTRACT_VERSION,
  type AgentCapabilities,
  type AgentEventDraft,
  type AgentProviderInstallation,
  type AgentRunFailure,
  type AgentRunHandle,
  type AgentRunnerPort,
  type ProviderRunContext,
} from '../ports/agent-runner.js';
import { providerCredentialEnv } from './provider-credentials.js';

/**
 * Tool-less direct model access behind the AgentRunnerPort. The application
 * drives one OpenRouter-compatible HTTPS chat completion per role; the API key
 * stays server-side and never reaches argv, logs or responses. All five roles
 * including the finalizer run without any coding CLI. Output stays final_html
 * and the same evidence, identity and approval gates apply.
 */
export const OPENROUTER_PROVIDER_ID = 'openrouter';
export const OPENROUTER_ADAPTER_VERSION = '1.0.0';
export const OPENROUTER_DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash';
const OPENROUTER_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models';
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const MAX_CORRECTION_ROUNDS = 2;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_WALL_TIME_MS = 15 * 60_000;
export const OPENROUTER_REASONING_LEVELS = ['default', 'off', 'low', 'medium', 'high'] as const;
export type OpenRouterReasoning = (typeof OPENROUTER_REASONING_LEVELS)[number];

export const OPENROUTER_RESULT_INSTRUCTION = [
  'RESULT DELIVERY: you have no tools and no file access. Answer with the complete requested result and nothing else.',
  'Do not describe what you would write; write it. No preamble, no closing remarks, no code fences unless the requested format itself is code.',
  'All required content, formats, evidence and review rules still apply.',
].join('\n');

/** Reasoning mapping per the provider contract; off disables thinking, levels map to effort. */
export function reasoningParameter(reasoning: OpenRouterReasoning): Record<string, unknown> {
  if (!reasoning || reasoning === 'default') return {};
  return reasoning === 'off' ? { reasoning: { enabled: false } } : { reasoning: { effort: reasoning } };
}

function normalizeReasoning(value: unknown): OpenRouterReasoning {
  return typeof value === 'string' && (OPENROUTER_REASONING_LEVELS as readonly string[]).includes(value)
    ? value as OpenRouterReasoning : 'default';
}

const FORBIDDEN_FINAL_HTML = /<(?:script|iframe|object|embed|form|input|button|textarea|select|svg|math)(?:\s|>)/i;
const EVIDENCE_COMMENT = /<!--\s*evidence:([A-Za-z0-9_.:-]+)\s*-->/gi;

/**
 * Output contract check per output ref. Known lab bug fixed by construction:
 * structured JSON answers are decoded first and never scanned for HTML
 * evidence comments, so escaped annotations inside JSON strings are data.
 */
export function openrouterOutputProblem(text: string, outputRefs: readonly string[]): string | null {
  const trimmed = text.trim();
  if (!trimmed) return 'Die Ausgabe ist leer.';
  if (outputRefs.includes('final_html')) {
    if (!/^<!doctype html>/i.test(trimmed)) return 'Die Ausgabe ist kein vollständiges HTML5-Dokument.';
    for (const tag of ['<html', '<head', '<title', '<body']) {
      if (!trimmed.toLowerCase().includes(tag)) return `Die Ausgabe enthält kein ${tag}>-Element.`;
    }
    if (FORBIDDEN_FINAL_HTML.test(trimmed)) return 'Die Ausgabe enthält verbotene aktive HTML-Elemente.';
    if (!trimmed.includes('data-result="final-agent-html"')) {
      return 'Die Ausgabe trägt nicht den Auslieferungsmarker data-result="final-agent-html".';
    }
    if (/<!--\s*evidence:/i.test(trimmed)) {
      return 'Interne Evidence-Annotationen dürfen im finalen HTML nicht sichtbar sein.';
    }
    return null;
  }
  // Structured review/matrix outputs are trusted as data once decoded.
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) return null;
  } catch { /* plain text below */ }
  return null;
}

/** Evidence annotation check for plain-text outputs; JSON outputs are never scanned. */
export function openrouterEvidenceProblem(
  text: string,
  allowedEvidenceIds?: readonly string[],
): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (value && typeof value === 'object') return null;
  } catch { /* plain text */ }
  EVIDENCE_COMMENT.lastIndex = 0;
  for (const match of trimmed.matchAll(EVIDENCE_COMMENT)) {
    const id = match[1]!;
    if (allowedEvidenceIds && !allowedEvidenceIds.includes(id)) {
      return `Die Evidence-Annotation ${id} verweist auf keinen freigegebenen Claim.`;
    }
  }
  return null;
}

export interface OpenRouterHttpAdapterOptions {
  fetchImpl?: typeof fetch;
  endpoint?: string;
  defaultModel?: string;
  credentialEnv?: (providerId: string) => NodeJS.ProcessEnv;
}

interface ChatCompletionResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  costMicros?: number;
  effectiveReasoning: OpenRouterReasoning;
}

export class OpenRouterHttpAgentAdapter implements AgentRunnerPort {
  readonly provider = OPENROUTER_PROVIDER_ID;
  private readonly endpoint: string;
  private readonly contexts = new Map<string, { controller: AbortController; cancelled: boolean }>();

  constructor(private readonly options: OpenRouterHttpAdapterOptions = {}) {
    this.endpoint = options.endpoint ?? OPENROUTER_DEFAULT_ENDPOINT;
    if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9./_-]*$/.test(this.endpoint)) {
      throw new Error('openrouter_endpoint_invalid');
    }
  }

  private key(): string | undefined {
    const env = (this.options.credentialEnv ?? providerCredentialEnv)(this.provider);
    const value = env.OPENROUTER_API_KEY;
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  async discover(): Promise<AgentProviderInstallation[]> {
    const key = this.key();
    const runtimeTarget: AgentProviderInstallation['runtimeTarget'] = process.platform === 'win32'
      ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
    return [{
      provider: this.provider,
      runtimeTarget,
      executable: this.endpoint,
      version: `openrouter-http ${OPENROUTER_ADAPTER_VERSION}`,
      support: key ? 'supported' : 'unavailable',
      authStatus: key ? 'authenticated' : 'unauthenticated',
      ...(key ? {} : { reason: 'Der Provider-Zugangsschluessel fehlt im verschluesselten Serverspeicher.' }),
    }];
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      schemaVersion: AGENT_CONTRACT_VERSION,
      provider: this.provider,
      providerVersion: `openrouter-http ${OPENROUTER_ADAPTER_VERSION}`,
      adapterVersion: OPENROUTER_ADAPTER_VERSION,
      protocolVersion: 'openrouter-chat-completions-v1',
      streaming: false, resume: false, interactiveInput: false, approvals: false,
      tools: false, images: false, structuredOutput: true,
      sandboxPolicies: ['read-only', 'workspace-write'],
      usage: true,
      supportedRuntimeTargets: ['windows', 'linux', 'darwin'],
      extensions: {
        networkEnforcement: 'server-side-control-plane',
        networkMechanism: 'direct-https-no-agent-tools',
        networkAccessClaim: 'provider-control-plane-only',
        reasoningParameterMapping: 'default-off-low-medium-high',
        correctionRounds: MAX_CORRECTION_ROUNDS,
      },
    };
  }

  async start(context: ProviderRunContext): Promise<AgentRunHandle> {
    const controller = new AbortController();
    this.contexts.set(context.runId, { controller, cancelled: false });
    const completion = this.execute(context, controller).finally(() => this.contexts.delete(context.runId));
    return { runId: context.runId, completion };
  }

  async sendInput(): Promise<void> {
    throw new Error('openrouter_http_interactive_input_unsupported');
  }

  async resolveApproval(): Promise<void> {
    throw new Error('openrouter_http_approvals_unsupported');
  }

  async cancel(runId: string): Promise<void> {
    const context = this.contexts.get(runId);
    if (context) { context.cancelled = true; context.controller.abort(); }
  }

  async resume(): Promise<AgentRunHandle> {
    throw new Error('openrouter_http_resume_unsupported');
  }

  async dispose(): Promise<void> {
    for (const context of this.contexts.values()) { context.cancelled = true; context.controller.abort(); }
    this.contexts.clear();
  }

  /** Model existence and reasoning support per the live provider contract; unknown stays unknown. */
  async checkModel(modelId: string): Promise<{ exists: boolean; reasoningSupported: boolean | null; note: string }> {
    if (!MODEL_PATTERN.test(modelId)) return { exists: false, reasoningSupported: null, note: 'Ungültige Modellkennung.' };
    try {
      const fetchImpl = this.options.fetchImpl ?? fetch;
      const response = await fetchImpl(OPENROUTER_MODELS_ENDPOINT, { method: 'GET' });
      if (!response.ok) return { exists: false, reasoningSupported: null, note: `Modellkatalog nicht erreichbar (HTTP ${response.status}).` };
      const payload = await response.json() as { data?: Array<{ id: string; supported_parameters?: string[] }> };
      const entry = (payload.data ?? []).find((item) => item.id === modelId);
      if (!entry) return { exists: false, reasoningSupported: null, note: 'Modell ist im Anbieterkatalog nicht gelistet.' };
      return {
        exists: true,
        reasoningSupported: Array.isArray(entry.supported_parameters)
          ? entry.supported_parameters.includes('reasoning') : null,
        note: Array.isArray(entry.supported_parameters)
          ? `Parameter: ${entry.supported_parameters.join(', ')}` : 'Parameterliste nicht veröffentlicht.',
      };
    } catch (error) {
      return { exists: false, reasoningSupported: null, note: `Prüfung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async execute(
    context: ProviderRunContext,
    controller: AbortController,
  ): Promise<{ state: 'succeeded' | 'failed' | 'timed_out' | 'cancelled'; failure?: AgentRunFailure }> {
    const { request, emit } = context;
    const outputRefs = Array.isArray(request.metadata?.outputRefs)
      ? (request.metadata!.outputRefs as unknown[]).filter((item): item is string => typeof item === 'string') : [];
    const allowedEvidenceIds = Array.isArray((request.metadata as Record<string, unknown> | undefined)?.allowedEvidenceIds)
      ? ((request.metadata as Record<string, unknown>).allowedEvidenceIds as unknown[]).filter((item): item is string => typeof item === 'string')
      : undefined;
    const key = this.key();
    if (!key) {
      const failure: AgentRunFailure = {
        code: 'provider_auth_failed',
        message: 'Der Provider-Zugangsschluessel fehlt im verschluesselten Serverspeicher.',
        retryable: false,
      };
      await emit({ kind: 'error', data: { code: failure.code, message: failure.message } }).catch(() => undefined);
      return { state: 'failed', failure };
    }
    const model = request.model ?? this.options.defaultModel ?? OPENROUTER_DEFAULT_MODEL;
    if (!MODEL_PATTERN.test(model)) {
      return {
        state: 'failed',
        failure: { code: 'validation_contract_violation', message: 'Die Modellkennung ist ungültig.', retryable: false },
      };
    }
    let effectiveReasoning = normalizeReasoning((request.metadata as Record<string, unknown> | undefined)?.reasoning);
    const wallTimeMs = Math.max(1_000, Math.min(request.limits?.wallTimeMs ?? DEFAULT_WALL_TIME_MS, DEFAULT_WALL_TIME_MS));
    const totals = { inputTokens: 0, outputTokens: 0, costMicros: undefined as number | undefined };
    let messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: `${request.task}\n\n${OPENROUTER_RESULT_INSTRUCTION}` },
    ];
    await emit({ kind: 'process_started', data: { transport: 'openrouter-chat-completions-v1', model, reasoning: effectiveReasoning } }).catch(() => undefined);
    try {
      for (let round = 1; round <= MAX_CORRECTION_ROUNDS; round += 1) {
        const result = await this.complete(messages, key, model, effectiveReasoning, controller, wallTimeMs);
        effectiveReasoning = result.effectiveReasoning;
        totals.inputTokens += result.inputTokens ?? 0;
        totals.outputTokens += result.outputTokens ?? 0;
        if (result.costMicros !== undefined) totals.costMicros = (totals.costMicros ?? 0) + result.costMicros;
        // Cumulative semantics: the last usage event is the grand total over
        // all correction calls. Missing costs are reported as unknown, never 0.
        await emit({
          kind: 'usage_updated',
          data: {
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            totalTokens: totals.inputTokens + totals.outputTokens,
            ...(totals.costMicros !== undefined
              ? { costMicros: totals.costMicros, costEstimated: true }
              : { costUnknown: true }),
            reasoning: effectiveReasoning, call: round,
          },
        }).catch(() => undefined);
        if (totals.costMicros === undefined) {
          await emit({
            kind: 'warning',
            data: { code: 'openrouter_usage_without_cost', message: 'Der Anbieter hat keine Kosten gemeldet; es werden keine Kosten erfunden.' },
          }).catch(() => undefined);
        }
        const problem = openrouterOutputProblem(result.text, outputRefs)
          ?? openrouterEvidenceProblem(result.text, allowedEvidenceIds);
        if (!problem) {
          await emit({ kind: 'agent_message_completed', data: { text: result.text } }).catch(() => undefined);
          return { state: 'succeeded' };
        }
        if (round >= MAX_CORRECTION_ROUNDS) {
          await emit({ kind: 'error', data: { code: 'validation_contract_violation', message: problem } }).catch(() => undefined);
          return {
            state: 'failed',
            failure: { code: 'validation_contract_violation', message: problem, retryable: false },
          };
        }
        messages = [
          ...messages,
          { role: 'assistant', content: result.text },
          {
            role: 'user',
            content: `Korrektur erforderlich: ${problem}\nLiefere die vollständig korrigierte Ausgabe erneut, ohne Erklärung.`,
          },
        ];
      }
      return {
        state: 'failed',
        failure: { code: 'validation_contract_violation', message: 'Der Ausgabevertrag wurde nicht erfüllt.', retryable: false },
      };
    } catch (error) {
      const cancelled = this.contexts.get(context.runId)?.cancelled ?? controller.signal.aborted;
      const failure = this.classifyThrown(error);
      if (cancelled && failure.code !== 'timed_out') {
        await emit({ kind: 'warning', data: { code: 'openrouter_run_cancelled', message: 'Der Lauf wurde abgebrochen.' } }).catch(() => undefined);
        return { state: 'cancelled', failure: { code: 'openrouter_run_cancelled', message: 'Der Lauf wurde abgebrochen.', retryable: false } };
      }
      if (failure.code === 'timed_out') {
        await emit({ kind: 'error', data: { code: 'timed_out', message: failure.message } }).catch(() => undefined);
        return { state: 'timed_out', failure };
      }
      await emit({ kind: 'error', data: { code: failure.code, message: failure.message } }).catch(() => undefined);
      return { state: 'failed', failure };
    }
  }

  private classifyThrown(error: unknown): AgentRunFailure {
    const message = error instanceof Error ? error.message : String(error);
    const attached = (error as { code?: unknown; retryable?: unknown } | null)?.code;
    if (typeof attached === 'string' && ['rate_limit', 'provider_auth_failed', 'provider_unavailable', 'validation_contract_violation', 'timed_out'].includes(attached)) {
      return {
        code: attached,
        message,
        retryable: (error as { retryable?: unknown }).retryable === true,
      };
    }
    if (/zeitlimit|timed?_?out/i.test(message)) {
      return { code: 'timed_out', message: 'Die Modellanfrage hat das Zeitlimit überschritten.', retryable: true };
    }
    if (/abort/i.test(message)) {
      return { code: 'openrouter_run_cancelled', message: 'Die Modellanfrage wurde abgebrochen.', retryable: false };
    }
    return { code: 'provider_unavailable', message: `OpenRouter ist nicht erreichbar: ${message}`, retryable: true };
  }

  private async complete(
    messages: ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    key: string,
    model: string,
    reasoning: OpenRouterReasoning,
    runController: AbortController,
    wallTimeMs: number,
  ): Promise<ChatCompletionResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('openrouter_call_timed_out')), wallTimeMs);
    const onAbort = (): void => controller.abort(new Error('openrouter_run_cancelled'));
    runController.signal.addEventListener('abort', onAbort, { once: true });
    if (runController.signal.aborted) onAbort();
    const send = async (effective: OpenRouterReasoning): Promise<Response> => {
      try {
        return await fetchImpl(this.endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages,
            ...reasoningParameter(effective),
            usage: { include: true },
          }),
        });
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason ?? error;
        throw new Error(`openrouter_unreachable: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    try {
      let effective = reasoning;
      let response = await send(effective);
      // Some endpoints reject disabling reasoning (HTTP 400); fall back to the
      // smallest level and report the EFFECTIVE reasoning honestly afterwards.
      if (response.status === 400 && effective === 'off') {
        effective = 'low';
        response = await send(effective);
      }
      if (response.status === 429) {
        throw Object.assign(new Error('OpenRouter begrenzt gerade die Anfragen (HTTP 429).'), { code: 'rate_limit', retryable: true });
      }
      if (response.status === 401 || response.status === 403) {
        throw Object.assign(new Error(`OpenRouter hat die Anmeldung abgelehnt (HTTP ${response.status}).`), { code: 'provider_auth_failed', retryable: false });
      }
      if (!response.ok) {
        throw Object.assign(new Error(`OpenRouter antwortet mit HTTP ${response.status}.`), { code: 'provider_unavailable', retryable: response.status >= 500 });
      }
      const raw = Buffer.from(await response.arrayBuffer());
      if (raw.byteLength > MAX_RESPONSE_BYTES) {
        throw Object.assign(new Error('Die Modellantwort ist zu groß.'), { code: 'validation_contract_violation', retryable: false });
      }
      let payload: { choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown; cost?: unknown } };
      try { payload = JSON.parse(raw.toString('utf8')); }
      catch { throw Object.assign(new Error('Die Modellantwort ist ungültig.'), { code: 'validation_contract_violation', retryable: false }); }
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw Object.assign(new Error('Die Modellantwort enthält keine Ausgabe.'), { code: 'validation_contract_violation', retryable: false });
      }
      const usage = payload.usage ?? {};
      const promptTokens = typeof usage.prompt_tokens === 'number' && Number.isFinite(usage.prompt_tokens) ? Math.floor(usage.prompt_tokens) : undefined;
      const completionTokens = typeof usage.completion_tokens === 'number' && Number.isFinite(usage.completion_tokens) ? Math.floor(usage.completion_tokens) : undefined;
      // Costs are never invented: only a provider-reported number becomes costMicros.
      const costMicros = typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0
        ? Math.floor(usage.cost * 1_000_000) : undefined;
      return {
        text: content,
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        costMicros,
        effectiveReasoning: effective,
      };
    } finally {
      clearTimeout(timer);
      runController.signal.removeEventListener('abort', onAbort);
    }
  }
}
