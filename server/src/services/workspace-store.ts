import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { ApplicationArtifactRevision, ApplicationCase, ApplicationStatusEvent, ApplicationTrackingEvent, ComparisonNote, FollowUpReminder, JobDecision, SearchRun, SearchSchedule } from '../domain/models.js';

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
}

const emptyWorkspace = (): WorkspaceEnvelope => ({ schemaVersion: 1, searchRuns: [], applicationCases: [], applicationEvents: [], searchSchedules: [], reminders: [], jobDecisions: [], comparisonNotes: [], trackingEvents: [], artifactRevisions: [] });
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
  clear(scope: 'search_runs' | 'application_cases' | 'search_schedules' | 'reminders' | 'job_decisions' | 'comparison_notes'): Promise<number>;
  saveSearchSchedule(schedule: SearchSchedule): Promise<void>;
  listSearchSchedules(): Promise<SearchSchedule[]>;
  saveReminder(reminder: FollowUpReminder): Promise<void>;
  listReminders(): Promise<FollowUpReminder[]>;
  saveJobDecision(decision: JobDecision): Promise<void>;
  listJobDecisions(): Promise<JobDecision[]>;
  saveComparisonNote(note: ComparisonNote): Promise<void>;
  listComparisonNotes(): Promise<ComparisonNote[]>;
  deleteComparisonNote(id: string): Promise<boolean>;
  appendTrackingEvent(event: ApplicationTrackingEvent): Promise<void>;
  listTrackingEvents(caseId: string): Promise<ApplicationTrackingEvent[]>;
  saveArtifactRevision(revision: ApplicationArtifactRevision): Promise<void>;
  listArtifactRevisions(caseId?: string): Promise<ApplicationArtifactRevision[]>;
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
    await this.mutate((data) => { data.applicationEvents.push(structuredClone(event)); });
  }
  async listApplicationEvents(caseId: string): Promise<ApplicationStatusEvent[]> {
    return structuredClone((await this.load()).applicationEvents.filter((event) => event.applicationCaseId === caseId));
  }
  async exportSnapshot() { return structuredClone(await this.load()); }
  async clear(scope: 'search_runs' | 'application_cases' | 'search_schedules' | 'reminders' | 'job_decisions' | 'comparison_notes'): Promise<number> {
    let removed = 0;
    await this.mutate((data) => {
      if (scope === 'search_runs') { removed = data.searchRuns.length; data.searchRuns = []; }
      else if (scope === 'search_schedules') { removed = data.searchSchedules.length; data.searchSchedules = []; }
      else if (scope === 'reminders') { removed = data.reminders.length; data.reminders = []; }
      else if (scope === 'job_decisions') { removed = data.jobDecisions.length; data.jobDecisions = []; }
      else if (scope === 'comparison_notes') { removed = data.comparisonNotes.length; data.comparisonNotes = []; }
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
  async appendTrackingEvent(event: ApplicationTrackingEvent): Promise<void> { await this.mutate((data) => { data.trackingEvents.push(structuredClone(event)); }); }
  async listTrackingEvents(caseId: string): Promise<ApplicationTrackingEvent[]> { return structuredClone((await this.load()).trackingEvents.filter((item) => item.applicationCaseId === caseId)); }
  async saveArtifactRevision(revision: ApplicationArtifactRevision): Promise<void> {
    await this.mutate((data) => {
      const existing = data.artifactRevisions.find((item) => item.id === revision.id);
      if (existing?.lifecycle === 'used' && JSON.stringify(existing) !== JSON.stringify(revision)) throw Object.assign(new Error('Verwendete Dokumentrevisionen sind unveränderlich.'), { statusCode: 409 });
      data.artifactRevisions = [structuredClone(revision), ...data.artifactRevisions.filter((item) => item.id !== revision.id)];
    });
  }
  async listArtifactRevisions(caseId?: string): Promise<ApplicationArtifactRevision[]> { const items = (await this.load()).artifactRevisions; return structuredClone(caseId ? items.filter((item) => item.applicationCaseId === caseId) : items); }
  async purgeBefore(cutoffIso: string): Promise<RetentionCounts> {
    const removed: RetentionCounts = { searchRuns: 0, closedApplications: 0, reminders: 0, comparisonNotes: 0, neutralDecisions: 0 };
    await this.mutate((data) => {
      const keepRuns = data.searchRuns.filter((item) => item.createdAt >= cutoffIso); removed.searchRuns = data.searchRuns.length - keepRuns.length; data.searchRuns = keepRuns;
      const removedCaseIds = new Set(data.applicationCases.filter((item) => item.state === 'closed' && item.updatedAt < cutoffIso).map((item) => item.id));
      removed.closedApplications = removedCaseIds.size; data.applicationCases = data.applicationCases.filter((item) => !removedCaseIds.has(item.id));
      data.applicationEvents = data.applicationEvents.filter((item) => !removedCaseIds.has(item.applicationCaseId));
      data.trackingEvents = data.trackingEvents.filter((item) => !removedCaseIds.has(item.applicationCaseId));
      data.artifactRevisions = data.artifactRevisions.filter((item) => !removedCaseIds.has(item.applicationCaseId));
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
  async appendApplicationEvent(event: ApplicationStatusEvent): Promise<void> { this.events.push(structuredClone(event)); }
  async listApplicationEvents(caseId: string): Promise<ApplicationStatusEvent[]> { return structuredClone(this.events.filter((event) => event.applicationCaseId === caseId)); }
  async exportSnapshot() { return { schemaVersion: 1 as const, searchRuns: structuredClone(this.runs), applicationCases: structuredClone(this.cases), applicationEvents: structuredClone(this.events), searchSchedules: structuredClone(this.schedules), reminders: structuredClone(this.reminders), jobDecisions: structuredClone(this.decisions), comparisonNotes: structuredClone(this.comparisonNotes), trackingEvents: structuredClone(this.trackingEvents), artifactRevisions: structuredClone(this.artifacts) }; }
  async clear(scope: 'search_runs' | 'application_cases' | 'search_schedules' | 'reminders' | 'job_decisions' | 'comparison_notes'): Promise<number> {
    if (scope === 'search_runs') { const count = this.runs.length; this.runs.splice(0); return count; }
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
  async appendTrackingEvent(event: ApplicationTrackingEvent): Promise<void> { this.trackingEvents.push(structuredClone(event)); }
  async listTrackingEvents(caseId: string): Promise<ApplicationTrackingEvent[]> { return structuredClone(this.trackingEvents.filter((item) => item.applicationCaseId === caseId)); }
  async saveArtifactRevision(revision: ApplicationArtifactRevision): Promise<void> {
    const index = this.artifacts.findIndex((item) => item.id === revision.id);
    if (index >= 0 && this.artifacts[index]!.lifecycle === 'used' && JSON.stringify(this.artifacts[index]) !== JSON.stringify(revision)) throw Object.assign(new Error('Verwendete Dokumentrevisionen sind unveränderlich.'), { statusCode: 409 });
    if (index >= 0) this.artifacts.splice(index, 1); this.artifacts.unshift(structuredClone(revision));
  }
  async listArtifactRevisions(caseId?: string): Promise<ApplicationArtifactRevision[]> { return structuredClone(caseId ? this.artifacts.filter((item) => item.applicationCaseId === caseId) : this.artifacts); }
  async purgeBefore(cutoffIso: string): Promise<RetentionCounts> {
    const removed: RetentionCounts = { searchRuns: 0, closedApplications: 0, reminders: 0, comparisonNotes: 0, neutralDecisions: 0 };
    const oldRuns = this.runs.filter((item) => item.createdAt < cutoffIso); removed.searchRuns = oldRuns.length;
    for (const item of oldRuns) this.runs.splice(this.runs.indexOf(item), 1);
    const oldCaseIds = new Set(this.cases.filter((item) => item.state === 'closed' && item.updatedAt < cutoffIso).map((item) => item.id)); removed.closedApplications = oldCaseIds.size;
    for (let index = this.cases.length - 1; index >= 0; index--) if (oldCaseIds.has(this.cases[index]!.id)) this.cases.splice(index, 1);
    for (let index = this.events.length - 1; index >= 0; index--) if (oldCaseIds.has(this.events[index]!.applicationCaseId)) this.events.splice(index, 1);
    for (let index = this.trackingEvents.length - 1; index >= 0; index--) if (oldCaseIds.has(this.trackingEvents[index]!.applicationCaseId)) this.trackingEvents.splice(index, 1);
    for (let index = this.artifacts.length - 1; index >= 0; index--) if (oldCaseIds.has(this.artifacts[index]!.applicationCaseId)) this.artifacts.splice(index, 1);
    for (let index = this.reminders.length - 1; index >= 0; index--) if (this.reminders[index]!.completed && this.reminders[index]!.createdAt < cutoffIso) { this.reminders.splice(index, 1); removed.reminders++; }
    for (let index = this.comparisonNotes.length - 1; index >= 0; index--) if (this.comparisonNotes[index]!.updatedAt < cutoffIso) { this.comparisonNotes.splice(index, 1); removed.comparisonNotes++; }
    for (let index = this.decisions.length - 1; index >= 0; index--) if (this.decisions[index]!.state === 'neutral' && this.decisions[index]!.updatedAt < cutoffIso) { this.decisions.splice(index, 1); removed.neutralDecisions++; }
    return removed;
  }
}
