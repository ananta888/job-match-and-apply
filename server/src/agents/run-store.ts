import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import {
  AGENT_CONTRACT_VERSION,
  assertCompatibleAgentContract,
  type AgentEvent,
  type AgentRun,
  type AgentRunRequest,
  type AgentRunState,
  type AgentRunStore
} from '../ports/agent-runner.js';
import { TERMINAL_AGENT_STATES, canTransition, stateAfterEvent, transitionRun } from './state-machine.js';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SENSITIVE_KEY = /(?:^|_)(?:secret|password|token|credential|authorization|cookie|prompt|task|stdin|stdout|stderr|raw|content|message|text|input|output|workspace_root|runtime_executable|executable|metadata)(?:$|_)/i;

function clone<T>(value: T): T { return structuredClone(value); }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Ungültige Run-ID: ${runId}`);
}

function validateEvent(run: AgentRun, event: AgentEvent): void {
  assertCompatibleAgentContract(event.schemaVersion);
  if (event.runId !== run.id) throw new Error(`Event gehört nicht zu Run ${run.id}.`);
  if (event.provider !== run.provider) throw new Error(`Providerwechsel in Run ${run.id} ist nicht erlaubt.`);
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new Error('Event-Sequenz muss eine positive Ganzzahl sein.');
  if (!event.correlationId || !event.timestamp || !event.kind) throw new Error('Event-Metadaten sind unvollständig.');
}

function applyEventToSnapshot(run: AgentRun, event: AgentEvent): AgentRun {
  const desired = stateAfterEvent(run.state, event);
  let updated = clone(run);
  if (desired !== run.state) {
    if (!canTransition(run.state, desired)) throw new Error(`Event ${event.kind} erzeugt ungültigen Status ${run.state} -> ${desired}.`);
    updated = transitionRun(run, desired, `event:${event.kind}`, new Date(event.timestamp));
  }
  updated.currentSequence = event.sequence;
  updated.updatedAt = event.timestamp;
  const data = event.data as Record<string, unknown>;
  if (event.kind === 'warning' && data.code === 'provider_session_started' && typeof data.sessionId === 'string') {
    updated.providerSessionId = data.sessionId;
  }
  if (event.kind === 'run_completed' && data.failure && typeof data.failure === 'object') {
    const failure = data.failure as Record<string, unknown>;
    if (typeof failure.code === 'string' && typeof failure.message === 'string') {
      updated.failure = { code: failure.code, message: failure.message, retryable: failure.retryable === true };
    }
  }
  return updated;
}

/**
 * Rebuilds the materialized run view from its append-only event stream only.
 * Provider state changes may skip snapshot-only intermediary states (for
 * example queued -> process_started), so replay applies canonical event meaning
 * directly while retaining strict sequence/provider/run validation.
 */
export function replayAgentRunFromEvents(events: readonly AgentEvent[]): AgentRun {
  const first = events[0];
  if (!first || first.sequence !== 1 || first.kind !== 'run_created') throw new Error('run_replay_creation_event_required');
  const creation = first.data as Record<string, unknown>;
  if (!creation.request || typeof creation.request !== 'object' || typeof creation.requestedAt !== 'string') {
    throw new Error('run_replay_creation_payload_invalid');
  }
  const request = structuredClone(creation.request) as AgentRunRequest;
  if (request.provider !== first.provider) throw new Error('run_replay_provider_mismatch');
  let run: AgentRun = {
    schemaVersion: AGENT_CONTRACT_VERSION,
    id: first.runId,
    provider: first.provider,
    state: 'queued',
    request,
    requestedAt: creation.requestedAt,
    updatedAt: first.timestamp,
    currentSequence: 0,
  };
  for (const event of events) {
    validateEvent(run, event);
    if (event.sequence !== run.currentSequence + 1) throw new Error(`run_replay_sequence_gap:${run.currentSequence + 1}:${event.sequence}`);
    const data = event.data as Record<string, unknown>;
    if (event.kind === 'capabilities_negotiated' && data.capabilities && typeof data.capabilities === 'object') {
      run.capabilities = structuredClone(data.capabilities) as AgentRun['capabilities'];
    }
    if (event.kind === 'warning' && data.code === 'provider_session_started' && typeof data.sessionId === 'string') run.providerSessionId = data.sessionId;
    if (event.kind === 'process_started') {
      run.state = 'running'; run.startedAt ??= event.timestamp;
      if (typeof data.pid === 'number' && Number.isSafeInteger(data.pid) && data.pid >= 0) run.pid = data.pid;
    } else if (event.kind === 'approval_requested') run.state = 'waiting_for_approval';
    else if (event.kind === 'approval_resolved' && run.state === 'waiting_for_approval') run.state = 'running';
    else if (event.kind === 'user_input_requested') run.state = 'waiting_for_input';
    else if (event.kind === 'user_input_received' && run.state === 'waiting_for_input') run.state = 'running';
    else if (event.kind === 'run_completed') {
      const terminal = data.state;
      if (!['cancelled', 'succeeded', 'failed', 'timed_out'].includes(String(terminal))) throw new Error('run_replay_terminal_state_invalid');
      run.state = terminal as Extract<AgentRunState, 'cancelled' | 'succeeded' | 'failed' | 'timed_out'>;
      run.finishedAt = event.timestamp;
      if (data.failure && typeof data.failure === 'object') {
        const failure = data.failure as Record<string, unknown>;
        if (typeof failure.code === 'string' && typeof failure.message === 'string') {
          run.failure = { code: failure.code, message: failure.message, retryable: failure.retryable === true };
        }
      }
    }
    run.currentSequence = event.sequence;
    run.updatedAt = event.timestamp;
  }
  return run;
}

function redact(value: unknown, key = ''): unknown {
  const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  if (!/(?:^|_)(?:input|output|cached_input|reasoning|total)_tokens?(?:$|_)/.test(normalizedKey) && SENSITIVE_KEY.test(normalizedKey)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return value;
}

export class MemoryAgentRunStore implements AgentRunStore {
  private readonly runs = new Map<string, AgentRun>();
  private readonly eventLog = new Map<string, AgentEvent[]>();

  async create(run: AgentRun): Promise<AgentRun> {
    assertRunId(run.id);
    assertCompatibleAgentContract(run.schemaVersion);
    if (this.runs.has(run.id)) throw new Error(`Run ${run.id} existiert bereits.`);
    if (run.currentSequence !== 0) throw new Error('Ein neuer Run muss bei Sequenz 0 beginnen.');
    this.runs.set(run.id, clone(run));
    this.eventLog.set(run.id, []);
    return clone(run);
  }

  async get(runId: string): Promise<AgentRun | undefined> { return clone(this.runs.get(runId)); }
  async list(): Promise<AgentRun[]> {
    return [...this.runs.values()].map(clone).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  async update(run: AgentRun): Promise<AgentRun> {
    const existing = this.runs.get(run.id);
    if (!existing) throw new Error(`Run ${run.id} wurde nicht gefunden.`);
    if (run.currentSequence !== existing.currentSequence) throw new Error('Run-Snapshot darf die Event-Sequenz nicht verändern.');
    if (!canTransition(existing.state, run.state)) throw new Error(`Ungültiger Status ${existing.state} -> ${run.state}.`);
    this.runs.set(run.id, clone(run));
    return clone(run);
  }

  async append(event: AgentEvent): Promise<'appended' | 'duplicate'> {
    const run = this.runs.get(event.runId);
    if (!run) throw new Error(`Run ${event.runId} wurde nicht gefunden.`);
    validateEvent(run, event);
    const events = this.eventLog.get(event.runId) ?? [];
    const previous = events.find((candidate) => candidate.sequence === event.sequence);
    if (previous) {
      if (same(previous, event)) return 'duplicate';
      throw new Error(`Widersprüchliches Event für Sequenz ${event.sequence}.`);
    }
    if (event.sequence !== run.currentSequence + 1) throw new Error(`Event-Lücke: erwartet ${run.currentSequence + 1}, erhalten ${event.sequence}.`);
    events.push(clone(event));
    this.eventLog.set(event.runId, events);
    this.runs.set(run.id, applyEventToSnapshot(run, event));
    return 'appended';
  }

  async events(runId: string, afterSequence = 0): Promise<AgentEvent[]> {
    if (!this.runs.has(runId)) throw new Error(`Run ${runId} wurde nicht gefunden.`);
    return (this.eventLog.get(runId) ?? []).filter((event) => event.sequence > afterSequence).map(clone);
  }

  async recover(): Promise<{ recovered: string[]; truncatedTails: string[]; errors: Array<{ runId: string; message: string }> }> {
    const recovered: string[] = [];
    for (const [id, run] of this.runs) {
      if (!TERMINAL_AGENT_STATES.has(run.state) && run.state !== 'orphaned') {
        this.runs.set(id, run.state === 'queued'
          ? { ...clone(run), state: 'orphaned', updatedAt: new Date().toISOString() }
          : transitionRun(run, 'orphaned', 'process ownership lost during recovery'));
        recovered.push(id);
      }
    }
    return { recovered, truncatedTails: [], errors: [] };
  }

  async prune(options: { before: string; dryRun?: boolean }): Promise<{ matched: string[]; removed: string[] }> {
    const cutoff = new Date(options.before).getTime();
    if (!Number.isFinite(cutoff)) throw new Error('Ungültiger Retention-Zeitpunkt.');
    const matched = [...this.runs.values()]
      .filter((run) => TERMINAL_AGENT_STATES.has(run.state) && new Date(run.finishedAt ?? run.updatedAt).getTime() < cutoff)
      .map((run) => run.id).sort();
    if (!options.dryRun) for (const id of matched) { this.runs.delete(id); this.eventLog.delete(id); }
    return { matched, removed: options.dryRun ? [] : matched };
  }

  async export(runId: string, options: { includeSensitive?: boolean } = {}): Promise<{ run: AgentRun; events: AgentEvent[] }> {
    const run = await this.get(runId);
    if (!run) throw new Error(`Run ${runId} wurde nicht gefunden.`);
    const bundle = { run, events: await this.events(runId) };
    return options.includeSensitive ? bundle : redact(bundle) as typeof bundle;
  }
}

export class JsonAgentRunStore implements AgentRunStore {
  private serialQueue: Promise<void> = Promise.resolve();

  constructor(private readonly rootDirectory: string) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serialQueue.then(operation, operation);
    this.serialQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private paths(runId: string): { directory: string; run: string; events: string } {
    assertRunId(runId);
    const root = resolve(this.rootDirectory);
    const directory = resolve(root, runId);
    if (directory !== root && !directory.startsWith(`${root}${sep}`)) throw new Error('Run-Pfad verlässt den Store.');
    return { directory, run: resolve(directory, 'run.json'), events: resolve(directory, 'events.jsonl') };
  }

  private async atomicWrite(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  }

  private async readRun(runId: string): Promise<AgentRun | undefined> {
    try {
      const run = JSON.parse(await readFile(this.paths(runId).run, 'utf8')) as AgentRun;
      assertCompatibleAgentContract(run.schemaVersion);
      return run;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async readEvents(runId: string): Promise<{ events: AgentEvent[]; truncated: boolean }> {
    let text: string;
    try { text = await readFile(this.paths(runId).events, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], truncated: false };
      throw error;
    }
    const hasPartialTail = text.length > 0 && !text.endsWith('\n');
    const pieces = text.split('\n');
    if (pieces.at(-1) === '') pieces.pop();
    const events: AgentEvent[] = [];
    for (let index = 0; index < pieces.length; index += 1) {
      const line = pieces[index];
      if (!line) continue;
      try { events.push(JSON.parse(line) as AgentEvent); }
      catch (error) {
        if (hasPartialTail && index === pieces.length - 1) return { events, truncated: true };
        throw new Error(`Beschädigtes Event-Log ${runId}, Zeile ${index + 1}: ${(error as Error).message}`);
      }
    }
    return { events, truncated: false };
  }

  async create(run: AgentRun): Promise<AgentRun> {
    return this.serialize(async () => {
      assertRunId(run.id);
      assertCompatibleAgentContract(run.schemaVersion);
      if (run.currentSequence !== 0) throw new Error('Ein neuer Run muss bei Sequenz 0 beginnen.');
      if (await this.readRun(run.id)) throw new Error(`Run ${run.id} existiert bereits.`);
      const paths = this.paths(run.id);
      await mkdir(paths.directory, { recursive: true });
      await writeFile(paths.events, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await this.atomicWrite(paths.run, run);
      return clone(run);
    });
  }

  async get(runId: string): Promise<AgentRun | undefined> {
    await this.serialQueue;
    const run = await this.readRun(runId);
    return run ? clone(run) : undefined;
  }

  async list(): Promise<AgentRun[]> {
    await this.serialQueue;
    let entries: string[];
    try {
      const { readdir } = await import('node:fs/promises');
      entries = await readdir(this.rootDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const runs = (await Promise.all(entries.filter((name) => RUN_ID_PATTERN.test(name)).map((name) => this.readRun(name))))
      .filter((run): run is AgentRun => Boolean(run));
    return runs.map(clone).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  async update(run: AgentRun): Promise<AgentRun> {
    return this.serialize(async () => {
      const existing = await this.readRun(run.id);
      if (!existing) throw new Error(`Run ${run.id} wurde nicht gefunden.`);
      if (run.currentSequence !== existing.currentSequence) throw new Error('Run-Snapshot darf die Event-Sequenz nicht verändern.');
      if (!canTransition(existing.state, run.state)) throw new Error(`Ungültiger Status ${existing.state} -> ${run.state}.`);
      await this.atomicWrite(this.paths(run.id).run, run);
      return clone(run);
    });
  }

  async append(event: AgentEvent): Promise<'appended' | 'duplicate'> {
    return this.serialize(async () => {
      const run = await this.readRun(event.runId);
      if (!run) throw new Error(`Run ${event.runId} wurde nicht gefunden.`);
      validateEvent(run, event);
      const { events } = await this.readEvents(event.runId);
      const previous = events.find((candidate) => candidate.sequence === event.sequence);
      if (previous) {
        if (same(previous, event)) {
          if (event.sequence === run.currentSequence + 1) {
            await this.atomicWrite(this.paths(run.id).run, applyEventToSnapshot(run, event));
          }
          return 'duplicate';
        }
        throw new Error(`Widersprüchliches Event für Sequenz ${event.sequence}.`);
      }
      if (event.sequence !== run.currentSequence + 1) throw new Error(`Event-Lücke: erwartet ${run.currentSequence + 1}, erhalten ${event.sequence}.`);
      const file = await open(this.paths(event.runId).events, 'a', 0o600);
      try { await file.appendFile(`${JSON.stringify(event)}\n`, 'utf8'); await file.sync(); }
      finally { await file.close(); }
      await this.atomicWrite(this.paths(run.id).run, applyEventToSnapshot(run, event));
      return 'appended';
    });
  }

  async events(runId: string, afterSequence = 0): Promise<AgentEvent[]> {
    await this.serialQueue;
    if (!(await this.readRun(runId))) throw new Error(`Run ${runId} wurde nicht gefunden.`);
    const { events } = await this.readEvents(runId);
    return events.filter((event) => event.sequence > afterSequence).map(clone);
  }

  async recover(): Promise<{ recovered: string[]; truncatedTails: string[]; errors: Array<{ runId: string; message: string }> }> {
    return this.serialize(async () => {
      const recovered: string[] = [];
      const truncatedTails: string[] = [];
      const errors: Array<{ runId: string; message: string }> = [];
      let entries: string[] = [];
      try { const { readdir } = await import('node:fs/promises'); entries = await readdir(this.rootDirectory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { recovered, truncatedTails, errors }; throw error; }
      for (const runId of entries.filter((name) => RUN_ID_PATTERN.test(name))) {
        try {
          const run = await this.readRun(runId);
          if (!run) continue;
          const read = await this.readEvents(runId);
          if (read.truncated) {
            await writeFile(this.paths(runId).events, read.events.map((event) => `${JSON.stringify(event)}\n`).join(''), { encoding: 'utf8', mode: 0o600 });
            truncatedTails.push(runId);
          }
          let expectedSequence = 1;
          let derivedState: AgentRunState = 'queued';
          let derivedStartedAt: string | undefined;
          let derivedFinishedAt: string | undefined;
          let derivedSessionId = run.providerSessionId;
          let derivedFailure = run.failure;
          for (const event of read.events) {
            validateEvent(run, event);
            if (event.sequence !== expectedSequence) throw new Error(`Event-Lücke: erwartet ${expectedSequence}, erhalten ${event.sequence}.`);
            expectedSequence += 1;
            if (event.kind === 'process_started') { derivedState = 'running'; derivedStartedAt ??= event.timestamp; }
            else if (event.kind === 'approval_requested' && derivedState === 'running') derivedState = 'waiting_for_approval';
            else if (event.kind === 'approval_resolved' && derivedState === 'waiting_for_approval') derivedState = 'running';
            else if (event.kind === 'user_input_requested' && derivedState === 'running') derivedState = 'waiting_for_input';
            else if (event.kind === 'user_input_received' && derivedState === 'waiting_for_input') derivedState = 'running';
            else if (event.kind === 'run_completed') {
              const eventData = event.data as Record<string, unknown>;
              const eventState = eventData.state;
              if (eventState === 'cancelled' || eventState === 'succeeded' || eventState === 'failed' || eventState === 'timed_out') {
                derivedState = eventState; derivedFinishedAt = event.timestamp;
              }
              if (eventData.failure && typeof eventData.failure === 'object') {
                const failure = eventData.failure as Record<string, unknown>;
                if (typeof failure.code === 'string' && typeof failure.message === 'string') {
                  derivedFailure = { code: failure.code, message: failure.message, retryable: failure.retryable === true };
                }
              }
            } else if (event.kind === 'warning') {
              const eventData = event.data as Record<string, unknown>;
              if (eventData.code === 'provider_session_started' && typeof eventData.sessionId === 'string') derivedSessionId = eventData.sessionId;
            }
          }
          const lastSequence = read.events.at(-1)?.sequence ?? 0;
          if (run.currentSequence > lastSequence) throw new Error(`Snapshot-Sequenz ${run.currentSequence} liegt vor dem Event-Log ${lastSequence}.`);
          let snapshot: AgentRun = {
            ...clone(run), state: derivedState, currentSequence: lastSequence,
            startedAt: derivedStartedAt ?? run.startedAt,
            finishedAt: derivedFinishedAt, providerSessionId: derivedSessionId, failure: derivedFailure
          };
          if (!TERMINAL_AGENT_STATES.has(snapshot.state) && snapshot.state !== 'queued' && snapshot.state !== 'orphaned') {
            snapshot = transitionRun(snapshot, 'orphaned', 'process ownership lost during startup recovery');
            recovered.push(runId);
          } else if (snapshot.state === 'queued') {
            // Never execute persisted work merely because the API restarted.
            // A queued request has lost its scheduler ownership and requires an
            // explicit user retry just like a formerly running process.
            snapshot = { ...snapshot, state: 'orphaned', updatedAt: new Date().toISOString() };
            recovered.push(runId);
          }
          await this.atomicWrite(this.paths(runId).run, snapshot);
        } catch (error) { errors.push({ runId, message: (error as Error).message }); }
      }
      return { recovered, truncatedTails, errors };
    });
  }

  async prune(options: { before: string; dryRun?: boolean }): Promise<{ matched: string[]; removed: string[] }> {
    return this.serialize(async () => {
      const cutoff = new Date(options.before).getTime();
      if (!Number.isFinite(cutoff)) throw new Error('Ungültiger Retention-Zeitpunkt.');
      let entries: string[] = [];
      try { const { readdir } = await import('node:fs/promises'); entries = await readdir(this.rootDirectory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { matched: [], removed: [] }; throw error; }
      const matched: string[] = [];
      for (const id of entries.filter((name) => RUN_ID_PATTERN.test(name))) {
        const run = await this.readRun(id);
        if (run && TERMINAL_AGENT_STATES.has(run.state) && new Date(run.finishedAt ?? run.updatedAt).getTime() < cutoff) matched.push(id);
      }
      matched.sort();
      if (!options.dryRun) {
        const root = resolve(this.rootDirectory);
        for (const id of matched) {
          const directory = this.paths(id).directory;
          if (!directory.startsWith(`${root}${sep}`)) throw new Error('Retention-Ziel verlässt den Store.');
          await rm(directory, { recursive: true, force: false });
        }
      }
      return { matched, removed: options.dryRun ? [] : matched };
    });
  }

  async export(runId: string, options: { includeSensitive?: boolean } = {}): Promise<{ run: AgentRun; events: AgentEvent[] }> {
    await this.serialQueue;
    const run = await this.readRun(runId);
    if (!run) throw new Error(`Run ${runId} wurde nicht gefunden.`);
    const bundle = { run, events: (await this.readEvents(runId)).events };
    return options.includeSensitive ? clone(bundle) : redact(bundle) as typeof bundle;
  }
}
