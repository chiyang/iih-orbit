import { Component, inject, output } from '@angular/core';
import { GmailService } from './gmail-service';

@Component({selector: 'app-gmail-settings', templateUrl: './gmail-settings.html', styleUrl: './gmail-settings.css'})
export class GmailSettings {
  readonly gmail = inject(GmailService);
  readonly configure = output<void>();
}
