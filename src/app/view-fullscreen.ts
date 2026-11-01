import {DOCUMENT} from '@angular/common';
import {afterNextRender, DestroyRef, Directive, ElementRef, HostListener, inject, Injector, input, signal} from '@angular/core';

@Directive({
  selector: '[appViewFullscreen]',
  exportAs: 'viewFullscreen',
  host: {
    '[class.chart-fullscreen]': 'active()',
    '[attr.role]': 'active() ? "dialog" : null',
    '[attr.tabindex]': 'active() ? -1 : null',
    '[attr.aria-modal]': 'active() && !suspended() ? "true" : null'
  }
})
export class ViewFullscreen {
  readonly active = signal(false);
  readonly suspended = input(false, {alias: 'fullscreenSuspended'});
  readonly interacting = input(false, {alias: 'fullscreenInteracting'});
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);
  private revision = 0;
  private restore?: () => void;

  constructor() {inject(DestroyRef).onDestroy(() => {this.revision++;});}

  toggle(event?: Event): void {
    if (this.suspended()) return;
    const revision = ++this.revision;
    if (!this.active()) {
      const view = this.document.defaultView, left = view?.scrollX ?? 0, top = view?.scrollY ?? 0;
      const trigger = (event?.currentTarget ?? this.document.activeElement) as HTMLElement | null;
      const ancestors: {element: HTMLElement; left: number; top: number}[] = [];
      for (let element = this.host.parentElement; element; element = element.parentElement) ancestors.push({element, left: element.scrollLeft, top: element.scrollTop});
      this.restore = () => {
        for (const entry of ancestors) {entry.element.scrollLeft = entry.left; entry.element.scrollTop = entry.top;}
        view?.scrollTo({left, top, behavior: 'instant'});
        if (trigger?.isConnected) trigger.focus({preventScroll: true});
      };
      this.active.set(true);
      afterNextRender(() => {
        if (revision === this.revision && this.active() && !this.suspended() && !this.host.contains(this.document.activeElement)) this.host.focus({preventScroll: true});
      }, {injector: this.injector});
    } else {
      this.active.set(false);
      const restore = this.restore; this.restore = undefined;
      afterNextRender(() => {if (revision === this.revision && !this.active()) restore?.();}, {injector: this.injector});
    }
  }

  @HostListener('keydown.escape', ['$event'])
  escape(event: Event): void {
    if (!this.active() || this.suspended() || this.interacting() || event.defaultPrevented) return;
    event.preventDefault(); event.stopPropagation(); this.toggle();
  }
}
