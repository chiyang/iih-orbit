import { Component, effect, inject, output, untracked } from '@angular/core';
import { GmailService } from './gmail-service';
import { GoogleServiceHeader } from './google-service-header';

@Component({selector: 'app-gmail-settings', imports: [GoogleServiceHeader], templateUrl: './gmail-settings.html', styleUrl: './gmail-settings.css'})
export class GmailSettings {
  readonly gmail = inject(GmailService);
  readonly configure = output<void>();
  constructor() {
    effect(() => { const clientId = this.gmail.clientId(); untracked(() => { if (clientId) void this.gmail.prepare(); }); });
  }
}
