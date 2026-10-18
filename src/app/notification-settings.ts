import {Component, inject} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {SystemNotifications} from './system-notifications';

@Component({selector: 'app-notification-settings', imports: [FormsModule], styleUrl: './settings.css', styles: ':host {display: block;}', template: `
<h3>系統開始通知 · 此瀏覽器</h3>
<p>程式保持開啟時，可透過系統通知接收各工作空間的開始提醒；分頁在背景也會嘗試送出。關閉程式或裝置休眠時不保證準時通知。</p>
<p class="setting-note">與右下角提示分開開關，只保存在目前瀏覽器，不隨備份或同步啟用其他裝置。系統通知可能顯示任務名稱與工作空間。</p>
<p role="status">{{ notifications.permission() === 'unsupported' ? '此瀏覽環境不支援系統通知' : notifications.permission() === 'denied' ? '瀏覽器已封鎖通知，請在網站設定允許後再啟用' : notifications.preferences().enabled && notifications.permission() === 'granted' ? '系統通知已啟用' : '系統通知尚未啟用' }}</p>
<div class="theme-modes">@if (notifications.preferences().enabled) {<button type="button" [disabled]="notifications.busy()" (click)="notifications.disable()">停用系統通知</button>} @else {<button type="button" [disabled]="notifications.busy() || notifications.permission() === 'unsupported' || notifications.permission() === 'denied'" (click)="notifications.enable()">啟用系統通知</button>}<button type="button" [disabled]="notifications.busy() || !notifications.preferences().enabled || notifications.permission() !== 'granted'" (click)="notifications.test()">發送測試通知</button></div>
@if (notifications.warning()) {<p class="settings-error" role="alert">{{ notifications.warning() }}</p>}@if (notifications.message()) {<p class="settings-message" role="status">{{ notifications.message() }}</p>}
<label class="setting-field">系統通知提前多久提醒<select aria-label="系統通知提前分鐘" [ngModel]="notifications.preferences().leadMinutes" (ngModelChange)="notifications.setOptions({leadMinutes: +$event})"><option [value]="15">15 分鐘</option><option [value]="30">30 分鐘</option><option [value]="60">60 分鐘</option></select></label>
<label class="setting-field">全天安排的系統通知時間<input type="time" aria-label="全天系統通知時間" [ngModel]="notifications.preferences().allDayTime" (change)="notifications.setOptions({allDayTime: $any($event.target).value})"></label>
<label class="reminder-checkbox"><input type="checkbox" [checked]="notifications.preferences().includeGoogle" (change)="notifications.setOptions({includeGoogle: $any($event.target).checked})">系統通知包含 Google 月曆活動</label>
<p class="setting-note">編輯與拖曳時暫緩；恢復執行後只補仍在提醒時限內的安排，不補送過久的開始提醒。手機可能需要先安裝並開啟 PWA；顯示與聲音仍由瀏覽器及作業系統決定。</p>
`})
export class NotificationSettings {readonly notifications = inject(SystemNotifications);}
