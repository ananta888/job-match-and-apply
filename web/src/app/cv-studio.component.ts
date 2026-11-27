import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CvFactsEditorComponent } from './cv-facts-editor.component.js';
import { CvStudioStore } from './cv-studio.store';
import { APP_HOST } from './app-host';

/**
 * Oberfläche des Lebenslauf-Studios. Zustand und Logik liegen im {@link CvStudioStore}, damit
 * Entwürfe und laufende Prüfungen erhalten bleiben, wenn der Bereich gewechselt wird.
 */
@Component({
  selector: 'app-cv-studio',
  imports: [CommonModule, FormsModule, CvFactsEditorComponent],
  templateUrl: './cv-studio.component.html',
  // Gemeinsame Basis aus app.scss; die Studio-Regeln liegen global in cv-studio.scss.
  styleUrl: './app.scss',
  styles: [':host { min-height: 0; }']
})
export class CvStudioComponent {
  readonly cv = inject(CvStudioStore);
  readonly app = inject(APP_HOST);
}
