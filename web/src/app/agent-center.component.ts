import { Component, ElementRef, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AgentCenterStore } from './agent-center.store';
import { APP_HOST } from './app-host';

/**
 * Oberfläche des Agent Centers. Zustand und Logik liegen im {@link AgentCenterStore}, damit
 * Eingaben und laufende Runs erhalten bleiben, wenn der Bereich gewechselt wird.
 */
@Component({
  selector: 'app-agent-center',
  imports: [CommonModule, FormsModule],
  templateUrl: './agent-center.component.html',
  // Gemeinsame Basis aus app.scss plus die nur hier genutzten Regeln.
  styleUrls: ['./app.scss', './agent-center.component.scss'],
  styles: [':host { min-height: 0; }']
})
export class AgentCenterComponent {
  readonly agents = inject(AgentCenterStore);
  readonly app = inject(APP_HOST);

  @ViewChild('agentTimelineList') set agentTimelineList(value: ElementRef<HTMLOListElement> | undefined) {
    this.agents.agentTimelineList = value;
  }
  @ViewChild('agentRecoveryDialogElement') set agentRecoveryDialogElement(value: ElementRef<HTMLDialogElement> | undefined) {
    this.agents.agentRecoveryDialogElement = value;
  }
  @ViewChild('agentRecoveryConfirm') set agentRecoveryConfirm(value: ElementRef<HTMLInputElement> | undefined) {
    this.agents.agentRecoveryConfirm = value;
  }
}
