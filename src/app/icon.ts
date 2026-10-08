import { Component, computed, input } from '@angular/core';

const PATHS: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  search: 'M21 21l-4.5-4.5M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0',
  board: 'M3 4h18v16H3zM9 4v16M15 4v16M5.5 8h1M11.5 8h1M17.5 8h1M5.5 11h1M11.5 11h1',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  list: 'M9 6h12M9 12h12M9 18h12M3 6h.01M3 12h.01M3 18h.01',
  check: 'M5 12l4 4L19 6',
  circleCheck: 'M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14l-3-3',
  user: 'M20 21v-2a7 7 0 0 0-14 0v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  chevron: 'm9 5 7 7-7 7',
  down: 'm6 9 6 6 6-6',
  calendar: 'M3 5h18v16H3zM16 3v4M8 3v4M3 11h18',
  close: 'M6 6l12 12M18 6 6 18',
  flag: 'M4 22V3M4 3c4-3 8 3 12 0v10c-4 3-8-3-12 0',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  edit: 'm16 3 5 5M3 21l5-1L21 7a2.1 2.1 0 0 0-4-4L4 16z',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  tag: 'M3 3h7l11 11-7 7L3 10zM7 7h.01',
  filter: 'M4 7h16M7 12h10M10 17h4',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  leaf: 'M20 3C9 1 2 7 4 16c9 4 17-3 16-13ZM4 20 16 8',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',
  clock: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M12 6v6l4 2',
  panel: 'M3 4h18v16H3zM9 4v16',
  save: 'M7 12l3 3 7-7M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  menu: 'M4 6h16M4 12h16M4 18h16',
  export: 'M12 3v12m-4-4 4 4 4-4M5 15v6h14v-6',
  grip: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01',
  sort: 'M8 3v18m-4-4 4 4 4-4M16 21V3m-4 4 4-4 4 4',
  week: 'M3 5h18v16H3zM16 3v4M8 3v4M3 11h18M7 14v3M12 14v3M17 14v3',
  archive: 'M3 3h18v5H3zM5 8v13h14V8M9 12h6'
};

@Component({
  selector: 'app-icon',
  template: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path [attr.d]="path()" /></svg>',
  styles: ':host {display: inline-flex; width: 20px; height: 20px; flex-shrink: 0; vertical-align: middle} svg {width: 100%; height: 100%}'
})
export class Icon {
  readonly name = input.required<string>();
  readonly path = computed(() => PATHS[this.name()] ?? PATHS['circleCheck']);
}
