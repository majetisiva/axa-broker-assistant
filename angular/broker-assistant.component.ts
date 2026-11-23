// Angular integration for the <axa-broker-assistant> web component.
// Works with standalone components (Angular 15+). For NgModule apps, add
// CUSTOM_ELEMENTS_SCHEMA to the module's `schemas` instead.
//
// 1) Load the widget once, e.g. in angular.json → "scripts": ["src/assets/axa-broker-assistant.js"]
//    or from the assistant host: <script src="https://<assistant-host>/widget/axa-broker-assistant.js" defer></script> in index.html
// 2) Use <app-broker-assistant [actionHint]="'motor_suspension'"></app-broker-assistant> on any webform page,
//    or once in the portal shell (app.component.html) to make it available everywhere.

import {
  Component, CUSTOM_ELEMENTS_SCHEMA, ElementRef, EventEmitter, Input, Output,
  AfterViewInit, OnDestroy, ViewChild, inject
} from '@angular/core';
import { Router } from '@angular/router';
import { BrokerSessionService } from './broker-session.service';

export interface BrokerRequestJson {
  requestId: string;
  action: { id: string; version: string; title: string };
  fields: Record<string, unknown>;
  status: 'draft' | 'ready' | 'submitted' | 'stp_completed' | 'routed_to_handler';
  submission?: { task?: { system: string; id: string; status: string }; mail?: { to: string; reference: string } };
}

// Maps Angular routes of the existing webforms to catalogue action ids,
// so the assistant knows which form the broker is looking at.
const ROUTE_TO_ACTION: Record<string, string> = {
  '/bss/brokermandate': 'change_intermediary',
  '/bss/suspension': 'motor_suspension'
};

@Component({
  selector: 'app-broker-assistant',
  standalone: true,
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <axa-broker-assistant #bot
      [attr.api-base]="apiBase"
      [attr.producer-number]="session.producerNumber"
      [attr.broker-name]="session.brokerName"
      [attr.language]="session.language"
      [attr.action-hint]="actionHint || routeHint()"
      [attr.variant]="variant">
    </axa-broker-assistant>`
})
export class BrokerAssistantComponent implements AfterViewInit, OnDestroy {
  @Input() apiBase = '/assistant';           // proxied to the assistant service (see proxy.conf.json)
  @Input() actionHint?: string;
  @Input() variant: 'floating' | 'inline' = 'floating';
  @Output() submitted = new EventEmitter<BrokerRequestJson>();
  @ViewChild('bot', { static: true }) bot!: ElementRef<HTMLElement>;

  session = inject(BrokerSessionService);
  private router = inject(Router);
  private onSubmitted = (e: Event) => this.submitted.emit((e as CustomEvent<BrokerRequestJson>).detail);

  routeHint(): string | null {
    const path = this.router.url.split('?')[0];
    return ROUTE_TO_ACTION[path] ?? null;
  }

  ngAfterViewInit(): void {
    this.bot.nativeElement.addEventListener('request-submitted', this.onSubmitted);
  }

  ngOnDestroy(): void {
    this.bot.nativeElement.removeEventListener('request-submitted', this.onSubmitted);
  }

  /** Programmatic control, e.g. from a "Do this by chat" button on a webform. */
  open(): void { (this.bot.nativeElement as any).openPanel(); }
  ask(text: string): void { this.open(); (this.bot.nativeElement as any).send(text); }
}
