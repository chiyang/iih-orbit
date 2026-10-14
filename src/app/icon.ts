import { Component, computed, input } from '@angular/core';

const PATHS: Record<string, string> = {
  external: 'M7 17 19 5M9 5h10v10M5 8H3v13h13v-2',
  plus: 'M12 5v14M5 12h14',
  help: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4M12 17h.01',
  warning: 'M12 3 2 21h20L12 3zM12 9v5M12 17h.01',
  mail: 'M3 5h18v14H3zM3 5l9 7 9-7',
  folder: 'M3 7V4h6l2 3h10v13H3V7z',
  file: 'M5 3h9l5 5v13H5zM14 3v6h5M8 13h8M8 17h6',
  filePdf: 'M5 3h9l5 5v13H5zM14 3v6h5M8 17l3-6 3 6M9 15h7',
  fileImage: 'M3 3h18v18H3zM3 17l6-6 4 4 3-3 5 5M17 7h.01',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
  copy: 'M9 9h12v12H9zM15 9V3H3v12h6',
  search: 'M21 21l-4.5-4.5M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0',
  board: 'M3 4h18v16H3zM9 4v16M15 4v16M5.5 8h1M11.5 8h1M17.5 8h1M5.5 11h1M11.5 11h1',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  list: 'M9 6h12M9 12h12M9 18h12M3 6h.01M3 12h.01M3 18h.01',
  check: 'M5 12l4 4L19 6',
  circleCheck: 'M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14l-3-3',
  user: 'M20 21v-2a7 7 0 0 0-14 0v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  logout: 'M9 4H4v16h5M10 12h11m-4-4 4 4-4 4',
  chevron: 'm9 5 7 7-7 7',
  down: 'm6 9 6 6 6-6',
  up: 'm6 15 6-6 6 6',
  undo: 'M3 8h10a7 7 0 0 1 0 14M3 8l5-5M3 8l5 5',
  redo: 'M21 8H11a7 7 0 0 0 0 14M21 8l-5-5M21 8l-5 5',
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
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  panel: 'M3 4h18v16H3zM9 4v16',
  panelRight: 'M3 4h18v16H3zM15 4v16',
  pin: 'M8 3h8v2h-1v5l4 4v3h-6v5h-2v-5H5v-3l4-4V5H8z',
  pinFilled: 'M8 3h8v2h-1v5l4 4v3h-6v5h-2v-5H5v-3l4-4V5H8z',
  save: 'M7 12l3 3 7-7M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  menu: 'M4 6h16M4 12h16M4 18h16',
  export: 'M12 3v12m-4-4 4 4 4-4M5 15v6h14v-6',
  grip: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01',
  sort: 'M8 3v18m-4-4 4 4 4-4M16 21V3m-4 4 4-4 4 4',
  week: 'M3 5h18v16H3zM16 3v4M8 3v4M3 11h18M7 14v3M12 14v3M17 14v3',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',
  sync: 'M20 11a8 8 0 0 0-14-5L3 9m0-6v6h6M4 13a8 8 0 0 0 14 5l3-3m0 6v-6h-6',
  conflict: 'M4 3v5a4 4 0 0 0 4 4h8a4 4 0 0 1 4 4v5M20 3v5a4 4 0 0 1-4 4H8a4 4 0 0 0-4 4v5M1 18l3 3 3-3M17 6l3-3 3 3',
  sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10',
  monitor: 'M3 3h18v14H3zM12 17v4M8 21h8',
  archive: 'M3 3h18v5H3zM5 8v13h14V8M9 12h6'
};

@Component({
  selector: 'app-icon',
  template: '<svg viewBox="0 0 24 24" [attr.fill]="name() === \'pinFilled\' ? \'currentColor\' : \'none\'" [attr.stroke]="name() === \'pinFilled\' ? \'none\' : \'currentColor\'" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path [attr.d]="path()" /></svg>',
  styles: ':host {display: inline-flex; width: 20px; height: 20px; flex-shrink: 0; vertical-align: middle} svg {display: block; width: 100%; height: 100%}'
})
export class Icon {
  readonly name = input.required<string>();
  readonly path = computed(() => PATHS[this.name()] ?? PATHS['circleCheck']);
}
