import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { Icon } from './icon';

@Component({
  selector: 'app-startup-guide', imports: [Icon], templateUrl: './startup-guide.html',
  styleUrl: './startup-guide.css', changeDetection: ChangeDetectionStrategy.OnPush
})
export class StartupGuide {
  readonly firstUse = input(false);
  readonly busy = input(false);
  readonly error = input('');
  readonly finish = output<void>();
  readonly step = signal(0);
  readonly steps = [
    {icon: 'board', title: '用工作空間分開不同計畫',
      text: '工作、生活或不同計畫可以各有一個工作空間。左側上方可切換或管理空間，各自保留專案、任務、分類與瀏覽狀態。',
      actions: ['管理工作空間', '選擇空白或樣板'], hint: '建立新空間時，可選擇樣板；示範任務則依需要加入。'},
    {icon: 'tag', title: '用專案與分類整理任務',
      text: '專案把同一目標的任務放在一起，例如「網站改版」；分類標示任務的性質，例如「設計」或「行政」。按「新增專案」設定目標，再由左側「管理分類」整理任務類型。',
      actions: ['新增專案', '管理分類', '在任務中指定'], hint: '展開各專案進度或點選左側分類，即可篩選目前視圖的任務。'},
    {icon: 'check', title: '把下一步寫成任務，逐步推進',
      text: '按「新增任務」填入名稱，描述可用 Markdown 或「專注編輯」，也能加入子任務。任務狀態記錄進度，在看板拖曳卡片即可從待辦推進到完成。',
      actions: ['新增任務', '拆成子任務', '調整狀態'], hint: '狀態名稱、顏色與顯示欄位都能調整；已完成與封存任務可從左側查看。'},
    {icon: 'calendar', title: '選擇適合當下的視圖',
      text: '看板掌握進度，清單方便查看及編輯欄位。月曆看整月安排，點日期空白處可進入該週；週視圖則能把任務拖到時段，安排開始與結束時間。',
      actions: ['看板・清單', '月曆・週視圖'], hint: '週視圖「今天」旁的「月曆」按鈕可返回該月份；重新整理會保留原本的瀏覽狀態。'},
    {icon: 'week', title: '與 Google Calendar 一起安排時間',
      text: '到「設定 → Google 連線」啟用 Calendar，再選擇要顯示的月曆。Google 活動會出現在月曆與週視圖；Orbit 任務也可移至有寫入權限的月曆。',
      actions: ['連線 Calendar', '選擇月曆', '查看或移轉活動'], hint: '移轉成功會移除本機任務卡片。Google 活動可另複製為 Orbit 任務，原活動保留，兩份內容可各自編輯。'},
    {icon: 'mail', title: '把 Gmail 郵件變成下一步',
      text: '在「Google 連線」啟用 Gmail 後，按右上角「Gmail」開啟側欄。可搜尋、用標籤篩選、預覽郵件或展開討論串，再拖曳想處理的郵件建立 Orbit 任務。',
      actions: ['開啟 Gmail 側欄', '預覽或搜尋', '拖曳建立任務'], hint: '拖到日期是全天任務，拖到週時段是一小時。任務保留原信連結，也可再移至 Calendar；原信不變。'},
    {icon: 'sync', title: '本機保存，也能備份與同步',
      text: '操作會自動保存在目前瀏覽器，點右上角「本機自動儲存」可匯出或匯入備份。也能啟用 Google Drive，將資料自動備份至雲端，或同步其他裝置的修改。',
      actions: ['本機自動儲存', '匯出備份', '依需要啟用 Drive'], hint: '「設定 → Google 連線」共用一個 Client ID，在同一頁分別連線 Calendar、Gmail 與 Drive；只啟用需要的服務即可。'}
  ];
  readonly current = computed(() => this.steps[this.step()]);
  readonly hint = computed(() => {
    if (this.firstUse() && this.step() === 0) return '目前只有一個空白空間，還沒有任務、分類或專案。';
    if (this.firstUse() && this.step() === this.steps.length - 1) return '接下來選擇空白空間或樣板，建立你自己的第一個工作空間。Google 服務可稍後再連線。';
    return this.current().hint;
  });
  next(): void {
    if (this.busy()) return;
    if (this.step() < this.steps.length - 1) this.step.update(step => step + 1);
    else this.finish.emit();
  }
  previous(): void { if (!this.busy() && this.step() > 0) this.step.update(step => step - 1); }
}
