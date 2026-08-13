import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type { AppConfig, ApplicationDraft, IdentityProfile, JobMatch, SearchProfile, SourceStatus } from './models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  config(): Observable<AppConfig> { return this.http.get<AppConfig>('/api/config'); }
  saveConfig(config: AppConfig): Observable<AppConfig> { return this.http.put<AppConfig>('/api/config', config); }
  sources(): Observable<SourceStatus[]> { return this.http.get<SourceStatus[]>('/api/sources'); }
  createIncognito(location: string): Observable<IdentityProfile> {
    return this.http.post<IdentityProfile>('/api/identities/incognito', { location });
  }
  search(profile: SearchProfile): Observable<{ matches: JobMatch[] }> {
    return this.http.post<{ matches: JobMatch[] }>('/api/jobs/search', profile);
  }
  login(sourceId: string): Observable<{ status: string; note?: string }> {
    return this.http.post<{ status: string; note?: string }>(`/api/sources/${sourceId}/login`, {});
  }
  assistantStatus(): Observable<{ available: boolean; note: string }> {
    return this.http.get<{ available: boolean; note: string }>('/api/assistant/status');
  }
  draft(match: JobMatch, identityId: string, documentType: 'cover_letter' | 'email'): Observable<ApplicationDraft> {
    return this.http.post<ApplicationDraft>('/api/applications/draft', { match, identityId, documentType });
  }

  finalize(
    match: JobMatch,
    identityId: string,
    documentType: 'cover_letter' | 'email',
    annotatedContent: string,
    iterationManifest: string
  ): Observable<ApplicationDraft> {
    return this.http.post<ApplicationDraft>('/api/applications/finalize', {
      match, identityId, documentType, annotatedContent, iterationManifest
    });
  }
}
