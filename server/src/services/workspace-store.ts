import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { ApplicationArtifactRevision, ApplicationCase, ApplicationStatusEvent, ApplicationTrackingEvent, ComparisonNote, FollowUpReminder, JobDecision, JobInventoryCategory, JobInventoryEntry, SearchRun, SearchSchedule } from '../domain/models.js';
import { foldInventory, setInventoryApplied, setInventoryCategory, type DiscoverySettingsInput, type JobInventoryFoldItem } from './job-inventory.js';

export interface WorkspaceEnvelope {
  schemaVersion: 1;
  searchRuns: SearchRun[];
  applicationCases: ApplicationCase[];
  applicationEvents: ApplicationStatusEvent[];
  searchSchedules: SearchSchedule[];
  reminders: FollowUpReminder[];
  jobDecisions: JobDecision[];
  comparisonNotes: ComparisonNote[];
  trackingEvents: ApplicationTrackingEvent[];
  artifactRevisions: ApplicationArtifactRevision[];
  jobInventory: JobInventoryEntry[];
}

const emptyWorkspace = (): WorkspaceEnvelope => ({ schemaVersion: 1, searchRuns: [], applicationCases: [], applicationEvents: [], searchSchedules: [], reminders: [], jobDecisions: [], comparisonNotes: [], trackingEvents: [], artifactRevisions: [], jobInventory: [] });
const writeQueues = new Map<string, Promise<void>>();
interface RetentionCounts { searchRuns: number; closedApplications: number; reminders: number; comparisonNotes: number; neutralDecisions: number }

export interface WorkspaceStore {
  saveSearchRun(run: SearchRun): Promise<void>;
  listSearchRuns(): Promise<SearchRun[]>;
  getSearchRun(id: string): Promise<SearchRun | undefined>;
  saveApplicationCase(application: ApplicationCase): Promise<void>;
  listApplicationCases(): Promise<ApplicationCase[]>;
  getApplicationCase(id: string): Promise<ApplicationCase | undefined>;
  appendApplicationEvent(event: ApplicationStatusEvent): Promise<void>;
  listApplicationEvents(caseId: string): Promise<ApplicationStatusEvent[]>;
  exportSnapshot(): Promise<WorkspaceEnvelope>;
  clear(scope: 'search_runs' | 'application_cases' | 'search_schedules' | 'reminders' | 'job_decisions' | 'comparison_notes' | 'job_inventory'): Promise<number>;
  saveSearchSchedule(schedule: SearchSchedule): Promise<void>;
  listSearchSchedules(): Promise<SearchSchedule[]>;
  saveReminder(reminder: FollowUpReminder): Promise<void>;
  listReminders(): Promise<FollowUpReminder[]>;
  saveJobDecision(decision: JobDecision): Promise<void>;
  listJobDecisions(): Promise<JobDecision[]>;
  saveComparisonNote(note: ComparisonNote): Promise<void>;
  listComparisonNotes(): Promise<ComparisonNote[]>;
  deleteComparisonNote(id: string): Promise<boolean>;
  deleteSearchSchedule(id: string): Promise<boolean>;
  deleteJobInventoryEntry(key: string): Promise<boolean>;
  /** Deletes a case and cascades its events, tracking and artifact revisions. */
  deleteApplicationCase(id: string): Promise<{ removed: boolean; events: number; trackingEvents: number; artifacts: number }>;
  appendTrackingEvent(event: ApplicationTrackingEvent): Promise<void>;
  listTrackingEvents(caseId: string): Promise<ApplicationTrackingEvent[]>;
  saveArtifactRevision(revision: ApplicationArtifactRevision): Promise<void>;
  listArtifactRevisions(caseId?: string): Promise<ApplicationArtifactRevision[]>;
  listJobInventory(): Promise<JobInventoryEntry[]>;
  /** Atomically fold a run's jobs into the central inventory; returns the keys added for the first time. */
  foldJobsIntoInventory(items: JobInventoryFoldItem[], runId: string, now: string, discoverySettings?: DiscoverySettingsInput): Promise<{ newKeys: string[] }>;
  setJobInventoryCategory(key: string, category: JobInventoryCategory, now: string): Promise<JobInventoryEntry | undefined>;
  setJobInventoryApplied(key: string, applied: boolean, note: string | undefined, now: string): Promise<JobInventoryEntry | undefined>;
  purgeBefore(cutoffIso: string): Promise<RetentionCounts>;
}

export class JsonWorkspaceStore implements WorkspaceStore {
  constructor(private readonly filePath = resolve(process.cwd(), '..', '.local-data', 'workspace.json')) {}

  async saveSearchRun(run: SearchRun): Promise<void> {
    const queued = (writeQueues.get(this.filePath) ?? Promise.resolve()).then(async () => {
      const data = await this.load();
      data.searchRuns = [structuredClone(run), ...data.searchRuns.filter((item) => item.id !== run.id)].slice(0, 100);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.filePath);
    });
    writeQueues.set(this.filePath, queued);
    try { await queued; } finally { if (writeQueues.get(this.filePath) === queued) writeQueues.delete(this.filePath); }
  }

  async listSearchRuns(): Promise<SearchRun[]> { return structuredClone((await this.load()).searchRuns); }
  async getSearchRun(id: string): Promise<SearchRun | undefined> {
    return structuredClone((await this.load()).searchRuns.find((run) => run.id === id));
  }
  async saveApplicationCase(application: ApplicationCase): Promise<void> {
    await this.mutate((data) => {
      data.applicationCases = [structuredClone(application), ...data.applicationCases.filter((item) => item.id !== application.id)].slice(0, 500);
    });
  }
  async listApplicationCases(): Promise<ApplicationCase[]> { return structuredClone((await this.load()).applicationCases); }
  async getApplicationCase(id: string): Promise<ApplicationCase | undefined> {
    return structuredClone((await this.load()).applicationCases.find((item) => item.id === id));
  }
  async appendApplicationEvent(event: ApplicationStatusEvent): Promise<void> {
    await this.mutate((data) => {
      const existing = data.applicationEvents.find((item) => item.id === event.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(event)) throw Object.assign(new Error('Application-Event-ID wurde widerspruechlich wiederverwendet.'), { statusCode: 409 });
      if (!existing) data.applicationEvents.push(structuredClone(event));
    });
  }
  async listApplicationEvents(caseId: string): Promise<ApplicationStatusEvent[]> {
    return structuredClone((await this.load()).applicationEvents.filter((event) => event.applicationCaseId === caseId));
  }
  async exportSnapshot() { return structuredClone(await this.load()); }
  async clear(scope: 'search_runs' | 'application_cases' | 'search_schedules' | 'reminders' | 'job_decisions' | 'comparison_notes' | 'job_inventory'): Promise<number> {
    let removed = 0;
    await this.mutate((data) => {
      if (scope === 'search_runs') { removed = data.searchRuns.length; data.searchRuns = []; }
      else if (scope === 'search_schedules') { removed = data.searchSchedules.length; data.searchSchedules = []; }
      else if (scope === 'reminders') { removed = data.reminders.length; data.reminders = []; }
      else if (scope === 'job_decisions') { removed = data.jobDecisions.length; data.jobDecisions = []; }
      else if (scope === 'comparison_notes') { removed = data.comparisonNotes.length; data.comparisonNotes = []; }
      else if (scope === 'job_inventory') { removed = data.jobInventory.length; data.jobInventory = []; }
      else {
        removed = data.applicationCases.length + data.applicationEvents.length + data.trackingEvents.length + data.artifactRevisions.length + data.reminders.length;
        data.applicationCases = [];
        data.applicationEvents = [];
        data.trackingEvents = [];
        data.artifactRevisions = [];
        data.reminders = [];
      }
    });
    return removed;
  }
  async saveSearchSchedule(schedule: SearchSchedule): Promise<void> {
    await this.mutate((data) => { data.searchSchedules = [structuredClone(schedule), ...data.searchSchedules.filter((item) => item.id !== schedule.id)]; });
  }
  async listSearchSchedules(): Promise<SearchSchedule[]> { return structuredClone((await this.load()).searchSchedules); }
  async saveReminder(reminder: FollowUpReminder): Promise<void> {
    await this.mutate((data) => { data.reminders = [structuredClone(reminder), ...data.reminders.filter((item) => item.id !== reminder.id)]; });
  }
  async listReminders(): Promise<FollowUpReminder[]> { return structuredClone((await this.load()).reminders); }
  async saveJobDecision(decision: JobDecision): Promise<void> {
    await this.mutate((data) => { data.jobDecisions = [structuredClone(decision), ...data.jobDecisions.filter((item) => item.jobId !== decision.jobId)]; });
  }
  async listJobDecisions(): Promise<JobDecision[]> { return structuredClone((await this.load()).jobDecisions); }
  async saveComparisonNote(note: ComparisonNote): Promise<void> {
    await this.mutate((data) => { data.comparisonNotes = [structuredClone(note), ...data.comparisonNotes.filter((item) => item.id !== note.id)]; });
  }
  async listComparisonNotes(): Promise<ComparisonNote[]> { return structuredClone((await this.load()).comparisonNotes); }
  async deleteComparisonNote(id: string): Promise<boolean> {
    let deleted = false;
    await this.mutate((data) => { const before = data.comparisonNotes.length; data.comparisonNotes = data.comparisonNotes.filter((item) => item.id !== id); deleted = before !== data.comparisonNotes.length; });
    return deleted;
  }
  async deleteSearchSchedule(id: string): Promise<boolean> {
    let deleted = false;
    await this.mutate((data) => { const before = data.searchSchedules.length; data.searchSchedules = data.searchSchedules.filter((item) => item.id !== id); deleted = before !== data.searchSchedules.length; });
    return deleted;
  }
  async deleteJobInventoryEntry(key: string): Promise<boolean> {
    let deleted = false;
    await this.mutate((data) => { const before = data.jobInventory.length; data.jobInventory = data.jobInventory.filter((item) => item.key !== key); deleted = before !== data.jobInventory.length; });
    return deleted;
  }
  async deleteApplicationCase(id: string): Promise<{ removed: boolean; events: number; trackingEvents: number; artifacts: number }> {
    const result = { removed: false, events: 0, trackingEvents: 0, artifacts: 0 };
    await this.mutate((data) => {
      const before = data.applicationCases.length;
      data.applicationCases = data.applicationCases.filter((item) => item.id !== id);
      result.removed = before !== data.applicationCases.length;
      if (!result.removed) return;
      const e = data.applicationEvents.length; data.applicationEvents = data.applicationEvents.filter((item) => item.applicationCaseId !== id); result.events = e - data.applicationEvents.length;
      const t = data.trackingEvents.length; data.trackingEvents = data.trackingEvents.filter((item) => item.applicationCaseId !== id); result.trackingEvents = t - data.trackingEvents.length;
      const a = data.artifactRevisions.length; data.artifactRevisions = data.artifactRevisions.filter((item) => item.applicationCaseId !== id); result.artifacts = a - data.artifactRevisions.length;
    });
    return result;
  }
  async appendTrackingEvent(event: ApplicationTrackingEvent): Promise<void> {
    await this.mutate((data) => {
      const existing = data.trackingEvents.find((item) => item.id === event.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(event)) throw Object.assign(new Error('Tracking-Event-ID wurde widerspruechlich wiederverwendet.'), { statusCode: 409 });
      if (!existing) data.trackingEvents.push(structuredClone(event));
    });
  }
  async listTrackingEvents(caseId: string): Promise<ApplicationTrackingEvent[]> { return structuredClone((await this.load()).trackingEvents.filter((item) => item.applicationCaseId === caseId)); }
  async saveArtifactRevision(revision: ApplicationArtifactRevision): Promise<void> {
    await this.mutate((data) => {
      const existing = data.artifactRevisions.find((item) => item.id === revision.id);
      if (existing?.lifecycle === 'used' && JSON.stringify(existing) !== JSON.stringify(revision)) throw Object.assign(new Error('Verwendete Dokumentrevisionen sind unveränderlich.'), { statusCode: 409 });
      data.artifactRevisions = [structuredClone(revision), ...data.artifactRevisions.filter((item) => item.id !== revision.id)];
    });
  }
  async listArtifactRevisions(caseId?: string): Promise<ApplicationArtifactRevision[]> { const items = (await this.load()).artifactRevisions; return structuredClone(caseId ? items.filter((item) => item.applicationCaseId === caseId) : items); }
  async listJobInventory(): Promise<JobInventoryEntry[]> { return structuredClone((await this.load()).jobInventory); }
  async foldJobsIntoInventory(items: JobInventoryFoldItem[], runId: string, now: string, discoverySettings?: DiscoverySettingsInput): Promise<{ newKeys: string[] }> {
    let newKeys: string[] = [];
    await this.mutate((data) => { const folded = foldInventory(data.jobInventory, items, runId, now, discoverySettings); data.jobInventory = folded.entries; newKeys = folded.newKeys; });
    return { newKeys };
  }
  async setJobInventoryCategory(key: string, category: JobInventoryCategory, now: string): Promise<JobInventoryEntry | undefined> {
    let entry: JobInventoryEntry | undefined;
    await this.mutate((data) => { const result = setInventoryCategory(data.jobInventory, key, category, now); data.jobInventory = result.entries; entry = result.entry; });
    return entry ? structuredClone(entry) : undefined;
  }
  async setJobInventoryApplied(key: string, applied: boolean, note: string | undefined, now: string): Promise<JobInventoryEntry | undefined> {
    let entry: JobInventoryEntry | undefined;
    await this.mutate((data) => { const result = setInventoryApplied(data.jobInventory, key, applied, note, now); data.jobInventory = result.entries; entry = result.entry; });
    return entry ? structuredClone(entry) : undefined;
  }
  async purgeBefore(cutoffIso: string): Promise<RetentionCounts> {
    const removed: RetentionCounts = { searchRuns: 0, closedApplications: 0, reminders: 0, comparisonNotes: 0, neutralDecisions: 0 };
    await this.mutate((data) => {
      const keepRuns = data.searchRuns.filter((item) => item.createdAt >= cutoffIso); removed.searchRuns = data.searchRuns.length - keepRuns.length; data.searchRuns = keepRuns;
      const removedCaseIds = new Set(data.applicationCases.filter((item) => item.state === 'closed' && item.updatedAt < cutoffIso).map((item) => item.id));
      removed.closedApplications = removedCaseIds.size; data.applicationCases = data.applicationCases.filter((item) => !removedCaseIds.has(item.id));
      data.applicationEvents = data.applicationEvents.filter((item) => !removedCaseIds.has(item.applicationCaseId));
      data.trackingEvents = data.trackingEvents.filter((item) => !removedCaseIds.has(item.applicationCaseId));
      data.artifactRevisions = data.artifactRevisions.filter((item) => item.lifecycle === 'used' || !removedCaseIds.has(item.applicationCaseId));
      const keepReminders = data.reminders.filter((item) => !item.completed || item.createdAt >= cutoffIso); removed.reminders = data.reminders.length - keepReminders.length; data.reminders = keepReminders;
      const keepNotes = data.comparisonNotes.filter((item) => item.updatedAt >= cutoffIso); removed.comparisonNotes = data.comparisonNotes.length - keepNotes.length; data.comparisonNotes = keepNotes;
      const keepDecisions = data.jobDecisions.filter((item) => item.state !== 'neutral' || item.updatedAt >= cutoffIso); removed.neutralDecisions = data.jobDecisions.length - keepDecisions.length; data.jobDecisions = keepDecisions;
    });
    return removed;
  }

  private async mutate(change: (data: WorkspaceEnvelope) => void): Promise<void> {
    const queued = (writeQueues.get(this.filePath) ?? Promise.resolve()).then(async () => {
      const data = await this.load(); change(data);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.filePath);
    });
    writeQueues.set(this.filePath, queued);
    try { await queued; } finally { if (writeQueues.get(this.filePath) === queued) writeQueues.delete(this.filePath); }
  }

  private async load(): Promise<WorkspaceEnvelope> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as WorkspaceEnvelope;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.searchRuns)) throw new Error('Nicht unterstütztes Workspace-Format.');
      parsed.applicationCases ??= [];
      parsed.applicationEvents ??= [];
      parsed.searchSchedules ??= [];
      parsed.reminders ??= [];
      parsed.jobDecisions ??= [];
      parsed.comparisonNotes ??= [];
      parsed.trackingEvents ??= [];
      parsed.artifactRevisions ??= [];
      parsed.jobInventory ??= [];
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyWorkspace();
      throw error;
    }
  }
}

export class MemoryWorkspaceStore implements WorkspaceStore {
  private readonly runs: SearchRun[] = [];
  private readonly cases: ApplicationCase[] = [];
  private readonly events: ApplicationStatusEvent[] = [];
  private readonly schedules: SearchSchedule[] = [];
  private readonly reminders: FollowUpReminder[] = [];
  private readonly decisions: JobDecision[] = [];
  private readonly comparisonNotes: ComparisonNote[] = [];
  private readonly trackingEvents: ApplicationTrackingEvent[] = [];
  private readonly artifacts: ApplicationArtifactRevision[] = [];
  private jobInventoryEntries: JobInventoryEntry[] = [];
  async saveSearchRun(run: SearchRun): Promise<void> { this.runs.unshift(structuredClone(run)); }
  async listSearchRuns(): Promise<SearchRun[]> { return structuredClone(this.runs); }
  async getSearchRun(id: string): Promise<SearchRun | undefined> { return structuredClone(this.runs.find((run) => run.id === id)); }
  async saveApplicationCase(application: ApplicationCase): Promise<void> {
    const index = this.cases.findIndex((item) => item.id === application.id);
    if (index >= 0) this.cases.splice(index, 1);
    this.cases.unshift(structuredClone(application));
  }
  async listApplicationCases(): Promise<ApplicationCase[]> { return structuredClone(this.cases); }
  async getApplicationCase(id: string): Promise<ApplicationCase | undefined> { return structuredClone(this.cases.find((item) => item.id === id)); }
  async appendApplicationEvent(event: ApplicationStatusEvent): Promise<void> {
    const existing = this.events.find((item) => item.id === event.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(event)) throw Object.assign(new Error('Application-Event-ID wurde widerspruechlich wiederverwendet.'), { statusCode: 409 });
    if (!existing) this.events.push(structuredClone(event));
  }
  async listApplicationEvents(caseId: string): Promise<ApplicationStatusEvent[]> { return structuredClone(this.events.filter((event) => event.applicationCaseId === caseId)); }
  async exportSnapshot() { return { schemaVersion: 1 as const, searchRuns: structuredClone(this.runs), applicationCases: structuredClone(this.cases), applicationEvents: structuredClone(this.events), searchSchedules: structuredClone(this.schedules), reminders: structuredClone(this.reminders), jobDecisions: structuredClone(this.decisions), comparisonNotes: structuredClone(this.comparisonNotes), trackingEvents: structuredClone(this.trackingEvents), artifactRevisions: structuredClone(this.artifacts), jobInventory: structuredClone(this.jobInventoryEntries) }; }
  async clear(scope: 'search_runs' | 'application_cases' | 'search_schedules' | 'reminders' | 'job_decisions' | 'comparison_notes' | 'job_inventory'): Promise<number> {
    if (scope === 'search_runs') { const count = this.runs.length; this.runs.splice(0); return count; }
    if (scope === 'job_inventory') { const count = this.jobInventoryEntries.length; this.jobInventoryEntries = []; return count; }
    if (scope === 'search_schedules') { const count = this.schedules.length; this.schedules.splice(0); return count; }
    if (scope === 'reminders') { const count = this.reminders.length; this.reminders.splice(0); return count; }
    if (scope === 'job_decisions') { const count = this.decisions.length; this.decisions.splice(0); return count; }
    if (scope === 'comparison_notes') { const count = this.comparisonNotes.length; this.comparisonNotes.splice(0); return count; }
    const count = this.cases.length + this.events.length + this.trackingEvents.length + this.artifacts.length + this.reminders.length;
    this.cases.splice(0); this.events.splice(0); this.trackingEvents.splice(0); this.artifacts.splice(0); this.reminders.splice(0); return count;
  }
  async saveSearchSchedule(schedule: SearchSchedule): Promise<void> {
    const index = this.schedules.findIndex((item) => item.id === schedule.id); if (index >= 0) this.schedules.splice(index, 1); this.schedules.unshift(structuredClone(schedule));
  }
  async listSearchSchedules(): Promise<SearchSchedule[]> { return structuredClone(this.schedules); }
  async saveReminder(reminder: FollowUpReminder): Promise<void> {
    const index = this.reminders.findIndex((item) => item.id === reminder.id); if (index >= 0) this.reminders.splice(index, 1); this.reminders.unshift(structuredClone(reminder));
  }
  async listReminders(): Promise<FollowUpReminder[]> { return structuredClone(this.reminders); }
  async saveJobDecision(decision: JobDecision): Promise<void> {
    const index = this.decisions.findIndex((item) => item.jobId === decision.jobId); if (index >= 0) this.decisions.splice(index, 1); this.decisions.unshift(structuredClone(decision));
  }
  async listJobDecisions(): Promise<JobDecision[]> { return structuredClone(this.decisions); }
  async saveComparisonNote(note: ComparisonNote): Promise<void> {
    const index = this.comparisonNotes.findIndex((item) => item.id === note.id); if (index >= 0) this.comparisonNotes.splice(index, 1); this.comparisonNotes.unshift(structuredClone(note));
  }
  async listComparisonNotes(): Promise<ComparisonNote[]> { return structuredClone(this.comparisonNotes); }
  async deleteComparisonNote(id: string): Promise<boolean> {
    const index = this.comparisonNotes.findIndex((item) => item.id === id); if (index < 0) return false; this.comparisonNotes.splice(index, 1); return true;
  }
  async deleteSearchSchedule(id: string): Promise<boolean> {
    const index = this.schedules.findIndex((item) => item.id === id); if (index < 0) return false; this.schedules.splice(index, 1); return true;
  }
  async deleteJobInventoryEntry(key: string): Promise<boolean> {
    const before = this.jobInventoryEntries.length; this.jobInventoryEntries = this.jobInventoryEntries.filter((item) => item.key !== key); return before !== this.jobInventoryEntries.length;
  }
  async deleteApplicationCase(id: string): Promise<{ removed: boolean; events: number; trackingEvents: number; artifacts: number }> {
    const index = this.cases.findIndex((item) => item.id === id);
    if (index < 0) return { removed: false, events: 0, trackingEvents: 0, artifacts: 0 };
    this.cases.splice(index, 1);
    let events = 0; let trackingEvents = 0; let artifacts = 0;
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i]!.applicationCaseId === id) { this.events.splice(i, 1); events++; }
    for (let i = this.trackingEvents.length - 1; i >= 0; i--) if (this.trackingEvents[i]!.applicationCaseId === id) { this.trackingEvents.splice(i, 1); trackingEvents++; }
    for (let i = this.artifacts.length - 1; i >= 0; i--) if (this.artifacts[i]!.applicationCaseId === id) { this.artifacts.splice(i, 1); artifacts++; }
    return { removed: true, events, trackingEvents, artifacts };
  }
  async appendTrackingEvent(event: ApplicationTrackingEvent): Promise<void> {
    const existing = this.trackingEvents.find((item) => item.id === event.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(event)) throw Object.assign(new Error('Tracking-Event-ID wurde widerspruechlich wiederverwendet.'), { statusCode: 409 });
    if (!existing) this.trackingEvents.push(structuredClone(event));
  }
  async listTrackingEvents(caseId: string): Promise<ApplicationTrackingEvent[]> { return structuredClone(this.trackingEvents.filter((item) => item.applicationCaseId === caseId)); }
  async saveArtifactRevision(revision: ApplicationArtifactRevision): Promise<void> {
    const index = this.artifacts.findIndex((item) => item.id === revision.id);
    if (index >= 0 && this.artifacts[index]!.lifecycle === 'used' && JSON.stringify(this.artifacts[index]) !== JSON.stringify(revision)) throw Object.assign(new Error('Verwendete Dokumentrevisionen sind unveränderlich.'), { statusCode: 409 });
    if (index >= 0) this.artifacts.splice(index, 1); this.artifacts.unshift(structuredClone(revision));
  }
  async listArtifactRevisions(caseId?: string): Promise<ApplicationArtifactRevision[]> { return structuredClone(caseId ? this.artifacts.filter((item) => item.applicationCaseId === caseId) : this.artifacts); }
  async listJobInventory(): Promise<JobInventoryEntry[]> { return structuredClone(this.jobInventoryEntries); }
  async foldJobsIntoInventory(items: JobInventoryFoldItem[], runId: string, now: string, discoverySettings?: DiscoverySettingsInput): Promise<{ newKeys: string[] }> {
    const folded = foldInventory(this.jobInventoryEntries, items, runId, now, discoverySettings); this.jobInventoryEntries = folded.entries; return { newKeys: folded.newKeys };
  }
  async setJobInventoryCategory(key: string, category: JobInventoryCategory, now: string): Promise<JobInventoryEntry | undefined> {
    const result = setInventoryCategory(this.jobInventoryEntries, key, category, now); this.jobInventoryEntries = result.entries; return result.entry ? structuredClone(result.entry) : undefined;
  }
  async setJobInventoryApplied(key: string, applied: boolean, note: string | undefined, now: string): Promise<JobInventoryEntry | undefined> {
    const result = setInventoryApplied(this.jobInventoryEntries, key, applied, note, now); this.jobInventoryEntries = result.entries; return result.entry ? structuredClone(result.entry) : undefined;
  }
  async purgeBefore(cutoffIso: string): Promise<RetentionCounts> {
    const removed: RetentionCounts = { searchRuns: 0, closedApplications: 0, reminders: 0, comparisonNotes: 0, neutralDecisions: 0 };
    const oldRuns = this.runs.filter((item) => item.createdAt < cutoffIso); removed.searchRuns = oldRuns.length;
    for (const item of oldRuns) this.runs.splice(this.runs.indexOf(item), 1);
    const oldCaseIds = new Set(this.cases.filter((item) => item.state === 'closed' && item.updatedAt < cutoffIso).map((item) => item.id)); removed.closedApplications = oldCaseIds.size;
    for (let index = this.cases.length - 1; index >= 0; index--) if (oldCaseIds.has(this.cases[index]!.id)) this.cases.splice(index, 1);
    for (let index = this.events.length - 1; index >= 0; index--) if (oldCaseIds.has(this.events[index]!.applicationCaseId)) this.events.splice(index, 1);
    for (let index = this.trackingEvents.length - 1; index >= 0; index--) if (oldCaseIds.has(this.trackingEvents[index]!.applicationCaseId)) this.trackingEvents.splice(index, 1);
    for (let index = this.artifacts.length - 1; index >= 0; index--) {
      const artifact = this.artifacts[index]!;
      if (artifact.lifecycle !== 'used' && oldCaseIds.has(artifact.applicationCaseId)) this.artifacts.splice(index, 1);
    }
    for (let index = this.reminders.length - 1; index >= 0; index--) if (this.reminders[index]!.completed && this.reminders[index]!.createdAt < cutoffIso) { this.reminders.splice(index, 1); removed.reminders++; }
    for (let index = this.comparisonNotes.length - 1; index >= 0; index--) if (this.comparisonNotes[index]!.updatedAt < cutoffIso) { this.comparisonNotes.splice(index, 1); removed.comparisonNotes++; }
    for (let index = this.decisions.length - 1; index >= 0; index--) if (this.decisions[index]!.state === 'neutral' && this.decisions[index]!.updatedAt < cutoffIso) { this.decisions.splice(index, 1); removed.neutralDecisions++; }
    return removed;
  }
}
