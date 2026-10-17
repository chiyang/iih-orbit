import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
import { OfflineStatus } from './app/offline-status';

bootstrapApplication(App).then(app => {app.injector.get(OfflineStatus);}).catch(error => console.error(error));
