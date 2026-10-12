import { DOCUMENT } from '@angular/common';
import { Directive, effect, ElementRef, HostListener, inject, input, OnDestroy } from '@angular/core';

@Directive({selector: '[appTooltip]'})
export class Tooltip implements OnDestroy {
  readonly text = input('', {alias: 'appTooltip'});
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private tip?: HTMLElement;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly hideOnMove = () => this.hide();
  constructor() {
    effect(() => {const text = this.text(); if (this.tip) {if (text) {this.tip.textContent = text; this.position();} else this.hide();}});
    this.document.addEventListener('scroll', this.hideOnMove, true);
    this.document.defaultView?.addEventListener('resize', this.hideOnMove);
  }
  @HostListener('mouseenter') enter(): void {clearTimeout(this.timer); this.timer = setTimeout(() => this.show(), 180);}
  @HostListener('mouseleave') leave(): void {this.hide();}
  @HostListener('focusin') focus(): void {this.show();}
  @HostListener('focusout') blur(): void {this.hide();}
  @HostListener('pointerdown') press(): void {this.hide();}
  @HostListener('document:keydown.escape') escape(): void {this.hide();}
  private show(): void {
    clearTimeout(this.timer);
    if (!this.text() || this.tip || !this.host.isConnected) return;
    const tip = this.document.createElement('div');
    tip.id = 'orbit-tooltip-' + crypto.randomUUID(); tip.className = 'orbit-tooltip'; tip.setAttribute('role', 'tooltip'); tip.textContent = this.text();
    this.document.body.appendChild(tip); this.tip = tip;
    const described = this.host.getAttribute('aria-describedby'); this.host.setAttribute('aria-describedby', [described, tip.id].filter(Boolean).join(' '));
    this.position();
  }
  private position(): void {
    if (!this.tip) return;
    const anchor = this.host.getBoundingClientRect(), box = this.tip.getBoundingClientRect(), view = this.document.defaultView;
    const width = view?.innerWidth ?? this.document.documentElement.clientWidth, height = view?.innerHeight ?? this.document.documentElement.clientHeight;
    this.tip.style.left = Math.max(8, Math.min(anchor.left + (anchor.width - box.width) / 2, width - box.width - 8)) + 'px';
    this.tip.style.top = Math.max(8, anchor.bottom + box.height + 8 <= height ? anchor.bottom + 8 : anchor.top - box.height - 8) + 'px';
  }
  private hide(): void {
    clearTimeout(this.timer);
    if (!this.tip) return;
    const described = (this.host.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== this.tip!.id).join(' ');
    if (described) this.host.setAttribute('aria-describedby', described); else this.host.removeAttribute('aria-describedby');
    this.tip.remove(); this.tip = undefined;
  }
  ngOnDestroy(): void {this.hide(); this.document.removeEventListener('scroll', this.hideOnMove, true); this.document.defaultView?.removeEventListener('resize', this.hideOnMove);}
}
