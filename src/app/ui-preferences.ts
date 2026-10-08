import { DOCUMENT } from '@angular/common';
import { computed, effect, inject, Injectable, signal } from '@angular/core';

type TextSize = 'small' | 'standard' | 'large' | 'extra-large';
const STORAGE_KEY = 'orbit-text-size-v1';

export const TEXT_SIZES: {id: TextSize; label: string; scale: number}[] = [
  {id: 'small', label: '小 90%', scale: .9},
  {id: 'standard', label: '標準 100%', scale: 1},
  {id: 'large', label: '大 115%', scale: 1.15},
  {id: 'extra-large', label: '特大 130%', scale: 1.3}
];

@Injectable({providedIn: 'root'})
export class UiPreferences {
  private readonly document = inject(DOCUMENT);
  readonly options = TEXT_SIZES;
  readonly textSize = signal<TextSize>(this.load());
  readonly scale = computed(() => this.options.find(option => option.id === this.textSize())?.scale ?? 1);
  readonly storageWarning = signal('');

  constructor() {
    effect(() => this.document.documentElement.style.setProperty('--font-scale', String(this.scale())));
  }

  setTextSize(value: unknown): void {
    const option = this.options.find(item => item.id === value);
    if (!option) return;
    this.textSize.set(option.id);
    try {
      localStorage.setItem(STORAGE_KEY, option.id);
      this.storageWarning.set('');
    } catch {
      this.storageWarning.set('字體大小已套用，但瀏覽器目前無法記住設定。');
    }
  }

  private load(): TextSize {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return this.options.find(option => option.id === saved)?.id ?? 'standard';
    } catch {
      return 'standard';
    }
  }
}
