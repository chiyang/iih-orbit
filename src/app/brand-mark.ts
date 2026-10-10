import { Component } from '@angular/core';

@Component({
  selector: 'app-brand-mark',
  template: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 48" aria-hidden="true" focusable="false">
      <ellipse cx="32" cy="24" rx="27" ry="16" transform="rotate(-16 32 24)" fill="none" stroke="currentColor" stroke-width="2" />
      <circle cx="48.3" cy="8.2" r="2.8" fill="currentColor" />
      <path d="M18 16h7v2.8h-2v10.4h2V32h-7v-2.8h2V18.8h-2Zm10 0h7v2.8h-2v10.4h2V32h-7v-2.8h2V18.8h-2Zm10 0h3v6.4h6V16h3v16h-3v-6.6h-6V32h-3Z" transform="translate(-2)" fill="currentColor" />
    </svg>
  `,
  styles: ':host {display: block; width: 100%; height: 100%;} svg {display: block; width: 100%; height: 100%;}'
})
export class BrandMark {}
