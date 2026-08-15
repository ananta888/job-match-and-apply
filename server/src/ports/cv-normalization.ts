export const CV_FACT_CATEGORIES = [
  'profile', 'contact', 'employment', 'project', 'education', 'skill',
  'certification', 'language', 'additional',
] as const;

export type CvFactCategory = typeof CV_FACT_CATEGORIES[number];
export type CvFactDecision = 'pending' | 'confirmed' | 'rejected';

export interface CvFact {
  id: string;
  claimId?: string;
  category: CvFactCategory;
  /** Groups atomic facts which belong to one role, project or education record. */
  recordId: string;
  field: string;
  value: string;
  decision: CvFactDecision;
  provenance: {
    sourceSha256: string;
    anchor: string;
    origin: 'imported' | 'user_supplied';
    /** Optional recognition witness. It never upgrades the fact's decision or evidence status. */
    recognition?: {
      method: 'deterministic' | 'ai_assisted';
      runId?: string;
      proposalSha256?: string;
      suggestionId?: string;
      selectedAlternativeId?: string;
      confidence?: number;
      questions?: string[];
      sourceSpan?: { lineStart: number; lineEnd: number; charStart: number; charEnd: number };
    };
  };
}

export interface CvNormalizationEnvelope {
  contract: 'cv-normalization-input';
  contractVersion: '1.0';
  source: { fileName: string; mimeType: string; sha256: string; byteSize: number };
  extractedText: string;
  warnings: Array<{ code: string; detail: string }>;
}

export interface CvAdoptionResult {
  contract: 'cv-profile-adoption';
  contractVersion: '1.0';
  adoptedClaimIds: string[];
  adoptedRecordIds: string[];
  candidateProfileSha256: string;
  candidateProfileRevision: string;
}

export interface CvNormalizationConflict {
  /** Stable, content-derived identifier. Conflicts remain unresolved until a future explicit-resolution contract exists. */
  id: string;
  code: string;
  detail: string;
}

/** Presentation sections available to the ATS ordering and the derived layout clone. Mirrors CvFactCategory minus `contact`. */
export const CV_LAYOUT_SECTIONS = [
  'profile', 'employment', 'project', 'education', 'skill', 'certification', 'language', 'additional',
] as const;
export type CvLayoutSection = typeof CV_LAYOUT_SECTIONS[number];

/**
 * A style-only fingerprint captured from the originally imported document. It never carries
 * personal fact content: only sanitized section labels, an ATS-section mapping, a colour palette
 * (sanitized `#rgb`/`#rrggbb` hex) and a coarse column layout. Captured once at import time,
 * because the original bytes are deleted after extraction.
 */
export interface CvLayoutFingerprint {
  contract: 'cv-layout-fingerprint';
  contractVersion: '1.0';
  sourceFormat: 'html' | 'pdf' | 'docx' | 'odt';
  columns: 1 | 2;
  palette: CvLayoutPalette;
  fontFamily: 'sans' | 'serif';
  sections: Array<{ section: CvLayoutSection; label: string; column: 'main' | 'side' }>;
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
}

export interface CvLayoutPalette {
  text: string;
  heading: string;
  accent: string;
  background: string;
  sidebar?: string;
  sidebarText?: string;
}

/** Faithful layout clone derived from a {@link CvLayoutFingerprint}; only used when `CvTheme.mode === 'original'`. */
export interface CvThemeOriginalLayout {
  columns: 1 | 2;
  palette: CvLayoutPalette;
  fontFamily: 'sans' | 'serif';
  main: CvLayoutSection[];
  side: CvLayoutSection[];
}

export interface CvTheme {
  /** `ats` keeps the closed, single-column ATS template (default). `original` renders the derived layout clone. */
  mode?: 'ats' | 'original';
  template: 'classic' | 'compact' | 'modern';
  font: 'Arial' | 'Calibri' | 'Georgia' | 'Helvetica';
  accentColor: '#1f2937' | '#1d4ed8' | '#047857' | '#7c3aed';
  spacing: 'compact' | 'comfortable' | 'spacious';
  sectionOrder: CvLayoutSection[];
  /** Required when `mode === 'original'`; ignored otherwise. */
  original?: CvThemeOriginalLayout;
}

export interface CvNormalizationPort {
  normalize(envelope: CvNormalizationEnvelope): Promise<{
    facts: CvFact[];
    warnings: string[];
    conflicts: CvNormalizationConflict[];
    artifact: unknown;
  }>;
  /** Validate user-supplied facts against the submodule's versioned capabilities before persisting them. */
  validateUserFacts(facts: CvFact[]): Promise<void>;
  adopt(input: {
    importId: string;
    sourceSha256: string;
    facts: CvFact[];
    artifact: unknown;
  }): Promise<CvAdoptionResult>;
}
