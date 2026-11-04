import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { CvFact, CvFactCategory, CvFactOperation } from './models';
import {
  CV_FACT_VIEW_SECTIONS, CV_RECORD_BLOCK_LABELS, cvFactGroupIsRaw, cvFactIsSensitive, cvFactViewLabel,
  groupCvFactRecords, isCvDetailField, type CvFactRecordView,
} from './cv-facts-view';

type CvFactDraftLike = { category: CvFactCategory; recordId: string; field: string; value: string };

interface GuidedAddField { key: string; label: string }

const GUIDED_ADD_FIELDS: Record<string, GuidedAddField[]> = {
  employment: [
    { key: 'role', label: 'Position' }, { key: 'company', label: 'Arbeitgeber' },
    { key: 'start_date', label: 'Beginn' }, { key: 'end_date', label: 'Ende' },
    { key: 'location', label: 'Ort' }, { key: 'employment_type', label: 'Beschäftigungsart' },
  ],
  project: [
    { key: 'name', label: 'Bezeichnung' }, { key: 'context', label: 'Kontext / Beitrag' },
    { key: 'role', label: 'Rolle' }, { key: 'start_date', label: 'Beginn' }, { key: 'end_date', label: 'Ende' },
    { key: 'link', label: 'Link' },
  ],
  education: [
    { key: 'institution', label: 'Einrichtung' }, { key: 'degree', label: 'Abschluss' },
    { key: 'start_date', label: 'Beginn' }, { key: 'end_date', label: 'Ende' }, { key: 'location', label: 'Ort' },
  ],
  certification: [
    { key: 'name', label: 'Bezeichnung' }, { key: 'issuer', label: 'Aussteller' },
    { key: 'issue_date', label: 'Ausgestellt am' }, { key: 'expiry_date', label: 'Gültig bis' }, { key: 'credential_url', label: 'Nachweis' },
  ],
  skill: [
    { key: 'name', label: 'Fähigkeit' }, { key: 'category', label: 'Gruppe' }, { key: 'level', label: 'Niveau' },
    { key: 'last_used', label: 'Zuletzt verwendet' },
  ],
  language: [
    { key: 'language', label: 'Sprache' }, { key: 'level', label: 'Niveau' },
  ],
  profile: [
    { key: 'name', label: 'Name' }, { key: 'headline', label: 'Kurzprofil' }, { key: 'summary', label: 'Kurzprofil (ausführlich)' },
  ],
  contact: [
    { key: 'email', label: 'E-Mail' }, { key: 'phone', label: 'Telefon' }, { key: 'address', label: 'Anschrift' }, { key: 'url', label: 'Webseite / Profil' },
  ],
  additional: [
    { key: 'text', label: 'Angabe' }, { key: 'heading', label: 'Überschrift' },
  ],
};

const SECTION_INPUT_KINDS = ['card', 'chips'] as const;

@Component({
  selector: 'app-cv-facts-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './cv-facts-editor.component.html',
})
export class CvFactsEditorComponent {
  @Input({ required: true }) facts: CvFact[] = [];
  @Input() busy = false;
  /** Sensible Profil-/Kontaktwerte bleiben maskiert, bis sie ausdrücklich angezeigt werden. */
  @Input() revealSensitive = false;
  /** Shared drafts owned by the host app; saving one field never drops the others. */
  @Input() drafts: Record<string, CvFactDraftLike> = {};
  @Output() readonly draftChange = new EventEmitter<{ fact: CvFact; field: keyof CvFactDraftLike; value: string }>();
  @Output() readonly saveFact = new EventEmitter<CvFact>();
  @Output() readonly decideFact = new EventEmitter<{ fact: CvFact; decision: 'confirm' | 'reject' }>();
  @Output() readonly addFacts = new EventEmitter<CvFactOperation[]>();
  @Output() readonly resetDraft = new EventEmitter<CvFact>();

  editingFactIds: Record<string, true> = {};
  addOpen: string | null = null;
  addValues: Record<string, string> = {};
  addCustomField = '';

  get sections(): Array<{ id: CvFactCategory; label: string; kind: 'card' | 'chips' | 'fields'; records: CvFactRecordView[] }> {
    const records = groupCvFactRecords(this.facts);
    return CV_FACT_VIEW_SECTIONS
      .map((section) => ({ ...section, records: records.filter((record) => record.category === section.id) }));
  }

  structuredRecords(): CvFactRecordView[] {
    return groupCvFactRecords(this.facts).filter((record) => !cvFactGroupIsRaw(record));
  }

  rawRecords(): CvFactRecordView[] {
    return groupCvFactRecords(this.facts).filter((record) => cvFactGroupIsRaw(record));
  }

  label(fact: CvFact): string {
    return cvFactViewLabel(fact.field, fact.category);
  }

  isDetail(fact: CvFact): boolean {
    return isCvDetailField(fact.field);
  }

  sensitive(fact: CvFact): boolean {
    return cvFactIsSensitive(fact);
  }

  masked(fact: CvFact): boolean {
    return this.sensitive(fact) && !this.revealSensitive;
  }

  draftOf(fact: CvFact): CvFactDraftLike {
    return this.drafts[fact.id] ?? { category: fact.category, recordId: fact.recordId, field: fact.field, value: fact.value };
  }

  dirty(fact: CvFact): boolean {
    const draft = this.draftOf(fact);
    return draft.category !== fact.category || draft.recordId !== fact.recordId
      || draft.field !== fact.field || draft.value !== fact.value;
  }

  /** Multiple fields stay open for editing at once; drafts are never dropped by saving one. */
  editing(fact: CvFact): boolean {
    return this.editingFactIds[fact.id] === true;
  }

  startEdit(fact: CvFact): void {
    if (this.masked(fact)) return;
    this.editingFactIds = { ...this.editingFactIds, [fact.id]: true };
    if (!this.drafts[fact.id]) this.draftChange.emit({ fact, field: 'value', value: fact.value });
  }

  cancelEdit(fact: CvFact): void {
    const { [fact.id]: _removed, ...rest } = this.editingFactIds;
    this.editingFactIds = rest;
    this.resetDraft.emit(fact);
  }

  save(fact: CvFact): void {
    const { [fact.id]: _removed, ...rest } = this.editingFactIds;
    this.editingFactIds = rest;
    if (!this.dirty(fact)) return;
    this.saveFact.emit(fact);
  }

  decide(fact: CvFact, decision: 'confirm' | 'reject'): void {
    this.decideFact.emit({ fact, decision });
  }

  confirmRecord(record: CvFactRecordView): void {
    for (const fact of record.facts) {
      if (fact.decision === 'pending' && !this.dirty(fact)) this.decideFact.emit({ fact, decision: 'confirm' });
    }
  }

  chipGroups(category: CvFactCategory): Array<{ group: string; records: CvFactRecordView[] }> {
    const groups = new Map<string, CvFactRecordView[]>();
    for (const record of groupCvFactRecords(this.facts).filter((item) => item.category === category)) {
      const group = record.facts.find((fact) => fact.field === 'category')?.value || '';
      groups.set(group, [...(groups.get(group) ?? []), record]);
    }
    return [...groups.entries()].map(([group, records]) => ({ group, records }));
  }

  chipName(record: CvFactRecordView): CvFact | undefined {
    return record.facts.find((fact) => fact.field === 'name' || fact.field === 'language') ?? record.facts[0];
  }

  chipLevel(record: CvFactRecordView): CvFact | undefined {
    return record.facts.find((fact) => fact.field === 'level');
  }

  recordFields(record: CvFactRecordView): { main: CvFact[]; details: CvFact[] } {
    return {
      main: record.facts.filter((fact) => !this.isDetail(fact)),
      details: record.facts.filter((fact) => this.isDetail(fact)),
    };
  }

  addFields(category: CvFactCategory): GuidedAddField[] {
    return GUIDED_ADD_FIELDS[category] ?? GUIDED_ADD_FIELDS['additional']!;
  }

  openAdd(category: CvFactCategory): void {
    this.addOpen = category;
    this.addValues = {};
    this.addCustomField = '';
  }

  closeAdd(): void {
    this.addOpen = null;
    this.addValues = {};
    this.addCustomField = '';
  }

  submitAdd(category: CvFactCategory, record?: CvFactRecordView): void {
    const key = `neu-${Date.now().toString(36)}`;
    const operations: CvFactOperation[] = [];
    for (const field of this.addFields(category)) {
      const value = (this.addValues[field.key] ?? '').trim();
      if (value) {
        operations.push({
          action: 'add', category, field: field.key, value,
          ...(record ? { recordId: record.recordId } : { newRecordKey: key }),
        });
      }
    }
    const custom = this.addCustomField.trim();
    if (custom && custom !== 'text' && /^[a-z][a-z0-9_.]*(?:\[[0-9]{1,4}\])?$/.test(custom)) {
      const value = (this.addValues[custom] ?? '').trim();
      if (value) {
        operations.push({
          action: 'add', category, field: custom, value,
          ...(record ? { recordId: record.recordId } : { newRecordKey: key }),
        });
      }
    }
    if (!operations.length) return;
    this.addFacts.emit(operations);
    this.closeAdd();
  }

  trackFact(_index: number, fact: CvFact): string {
    return fact.id;
  }

  trackRecord(_index: number, record: CvFactRecordView): string {
    return `${record.category}:${record.recordId}`;
  }

  protected readonly blockLabels = CV_RECORD_BLOCK_LABELS;
  protected readonly sectionInputKinds = SECTION_INPUT_KINDS;
}
