import { DOCUMENT } from '@angular/common';
import { computed, effect, inject, Injectable, OnDestroy, signal } from '@angular/core';
import { BoardStore } from './board-store';
import { AppearancePreferences, TextSize, ThemeMode, themeTokens } from './appearance-data';
import { CALENDAR_DISPLAY_KEY, loadCalendarWidth, loadWeekRange, readWeekRange, validWeekRange, type CalendarWidth, type WeekTimeRange } from './calendar-display';

export const TEXT_SIZES: {id: TextSize; label: string; scale: number}[] = [
  {id: 'extra-small', label: '特小 70%', scale: .7},
  {id: 'compact', label: '小 80%', scale: .8},
  // Keep the saved identifier so existing local 90% preferences retain their size.
  {id: 'small', label: '中 90%', scale: .9},
  {id: 'standard', label: '標準 100%', scale: 1},
  {id: 'large', label: '大 115%', scale: 1.15},
  {id: 'extra-large', label: '特大 130%', scale: 1.3}
];

@Injectable({providedIn: 'root'})
export class UiPreferences implements OnDestroy {
  private readonly document = inject(DOCUMENT);
  private readonly store = inject(BoardStore);
  readonly options = TEXT_SIZES;
  readonly textSize = computed(() => this.store.appearance().textSize);
  readonly theme = computed(() => this.store.appearance().theme);
  readonly themeLabel = computed(() => ({light: '淺色', dark: '深色', system: '跟隨系統'})[this.theme()]);
  readonly themeIcon = computed(() => ({light: 'sun', dark: 'moon', system: 'monitor'})[this.theme()]);
  readonly accent = computed(() => this.store.appearance().accent);
  readonly scale = computed(() => this.options.find(option => option.id === this.textSize())?.scale ?? 1);
  readonly storageWarning = this.store.storageWarning;
  readonly weekRange = signal(loadWeekRange());
  readonly weekRangeWarning = signal('');
  readonly calendarWidth = signal(loadCalendarWidth());
  readonly calendarWidthWarning = signal('');
  private unsavedCalendarDisplay = false;
  private readonly reloadCalendarDisplay = () => {if (!this.unsavedCalendarDisplay) {this.weekRange.set(loadWeekRange()); this.calendarWidth.set(loadCalendarWidth());}};
  private readonly calendarStorageChanged = (event: StorageEvent) => {if (!event.key || event.key === CALENDAR_DISPLAY_KEY) this.reloadCalendarDisplay();};
  private readonly media = this.document.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
  private readonly systemDark = signal(this.media?.matches ?? false);
  readonly dark = computed(() => this.theme() === 'dark' || (this.theme() === 'system' && this.systemDark()));
  private readonly mediaListener = (event: MediaQueryListEvent) => this.systemDark.set(event.matches);

  constructor() {
    effect(() => {
      const root = this.document.documentElement;
      root.style.setProperty('--font-scale', String(this.scale()));
      root.dataset['theme'] = this.dark() ? 'dark' : 'light';
      root.style.colorScheme = this.dark() ? 'dark' : 'light';
      for (const [key, value] of Object.entries(themeTokens(this.accent(), this.dark()))) root.style.setProperty(key, value);
    });
    this.media?.addEventListener('change', this.mediaListener);
    this.document.defaultView?.addEventListener?.('storage', this.calendarStorageChanged);
    this.document.defaultView?.addEventListener?.('focus', this.reloadCalendarDisplay);
  }

  ngOnDestroy(): void {
    this.media?.removeEventListener('change', this.mediaListener);
    this.document.defaultView?.removeEventListener?.('storage', this.calendarStorageChanged);
    this.document.defaultView?.removeEventListener?.('focus', this.reloadCalendarDisplay);
  }

  setWeekRange(range: WeekTimeRange): boolean {
    if (!validWeekRange(range)) {this.weekRangeWarning.set('結束時間需晚於開始時間，且至少相隔 1 小時。'); return false;}
    const saved = readWeekRange(range);
    this.weekRange.set(saved); this.weekRangeWarning.set('');
    try {localStorage.setItem(CALENDAR_DISPLAY_KEY, JSON.stringify({version: 1, range: saved, width: this.calendarWidth()})); this.unsavedCalendarDisplay = false; this.calendarWidthWarning.set('');}
    catch {this.unsavedCalendarDisplay = true; this.weekRangeWarning.set('目前分頁已套用，但瀏覽器無法保存時間範圍。');}
    return true;
  }

  setCalendarWidth(width: CalendarWidth): void {
    if (width !== 'standard' && width !== 'wide') return;
    this.calendarWidth.set(width); this.calendarWidthWarning.set('');
    try {localStorage.setItem(CALENDAR_DISPLAY_KEY, JSON.stringify({version: 1, range: this.weekRange(), width})); this.unsavedCalendarDisplay = false;}
    catch {this.unsavedCalendarDisplay = true; this.calendarWidthWarning.set('已套用寬度，但瀏覽器無法保存選擇。');}
  }

  async setTextSize(value: unknown): Promise<void> {
    const option = this.options.find(item => item.id === value);
    if (!option) return;
    await this.store.updateAppearance({textSize: option.id});
  }

  async setTheme(theme: ThemeMode): Promise<void> { await this.store.updateAppearance({theme}); }
  async cycleTheme(): Promise<void> {
    const modes: ThemeMode[] = ['light', 'dark', 'system'];
    await this.setTheme(modes[(modes.indexOf(this.theme()) + 1) % modes.length]);
  }
  async setAccent(accent: string): Promise<void> { await this.store.updateAppearance({accent}); }
  snapshot(): AppearancePreferences { return {...this.store.appearance()}; }
}
