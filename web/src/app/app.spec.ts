import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { App } from './app';
import { ApiService } from './api.service';
import type { AppConfig } from './models';

const config: AppConfig = {
  searchProfile: {
    name: 'Testprofil', query: 'Angular', regions: ['Berlin'], radiusKm: 50,
    workModels: ['hybrid'], employmentTypes: ['full_time'], mustHave: ['TypeScript'],
    niceToHave: ['Angular'], exclude: [], sourceIds: ['stepstone']
  },
  identities: [{
    id: 'demo', label: 'Inkognito', mode: 'incognito', fullName: 'Alex Beispiel',
    email: 'alex@example.invalid', phone: '', location: 'Berlin', linkedin: '', placeholders: {}
  }],
  activeIdentityId: 'demo',
  mcp: { mode: 'demo', command: '', args: [], env: {} },
  assistant: { skillPath: '', candidateProfilePath: '', styleProfilePath: '' }
};

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [{
        provide: ApiService,
        useValue: {
          config: () => of(structuredClone(config)),
          sources: () => of([]),
          assistantStatus: () => of({ available: false, note: 'Test' })
        }
      }]
    }).compileComponents();
  });

  it('creates the workspace and renders the overview', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance).toBeTruthy();
    expect(compiled.querySelector('h1')?.textContent).toContain('Guten Tag');
    expect(compiled.textContent).toContain('Testprofil');
  });
});
