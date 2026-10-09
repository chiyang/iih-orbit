import { computed, Directive, inject, input } from '@angular/core';
import { categoryPalette } from './appearance-data';
import { UiPreferences } from './ui-preferences';

@Directive({
  selector: '[orbitColor]',
  host: {
    '[style.--category-color]': 'palette().color', '[style.--category-bg]': 'palette().background', '[style.--category-text]': 'palette().text', '[style.--on-category]': 'palette().onColor',
    '[style.--event-line]': 'palette().color', '[style.--event-bg]': 'palette().background', '[style.--event-text]': 'palette().text'
  }
})
export class ThemeColor {
  readonly orbitColor = input.required<string>();
  private readonly preferences = inject(UiPreferences);
  readonly palette = computed(() => categoryPalette(this.orbitColor(), this.preferences.dark()));
}
