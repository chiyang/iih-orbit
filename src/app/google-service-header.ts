import { Component, input, output } from '@angular/core';
import type { GoogleAuth } from './google-auth';

@Component({selector: 'app-google-service-header', templateUrl: './google-service-header.html', styleUrl: './google-service-header.css'})
export class GoogleServiceHeader {
  readonly title = input.required<string>();
  readonly description = input.required<string>();
  readonly serviceName = input.required<string>();
  readonly auth = input.required<GoogleAuth>();
  readonly clientId = input('');
  readonly email = input('');
  readonly busy = input(false);
  readonly offline = input(false);
  readonly canDisconnect = input(false);
  readonly connect = output<void>();
  readonly disconnect = output<void>();
  readonly prepare = output<void>();
  readonly configure = output<void>();
}
