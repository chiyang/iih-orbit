# 開發與部署

[文件索引](README.md) · [專案首頁](../README.md)

## 技術與執行環境

使用 Angular v22、Signals、Angular CDK 與 TypeScript，Markdown 由 [Marked](https://marked.js.org/) 解析並以 [DOMPurify](https://github.com/cure53/DOMPurify) 清理輸出。依賴版本見 [package.json](../package.json)，安裝使用鎖定的 [package-lock.json](../package-lock.json)。

專案為純前端，由瀏覽器渲染；[angular.json](../angular.json) 明確關閉 SSR 及預先渲染，正式部署只有靜態檔案，無須 Node.js 執行伺服器或自建後端。

CI 使用 Node.js **24.19.0**；本機建議沿用此版本。現有 Angular CLI 支援 Node.js `^22.22.3 || ^24.15.0 || >=26.0.0`，切換環境時需符合已安裝 CLI 的要求。

## 本機啟動與檢查

```sh
npm ci
npm start
```

開啟 [http://127.0.0.1:4200](http://127.0.0.1:4200)。

| 指令 | 用途 |
| --- | --- |
| `npm run check` | TypeScript 與 Angular 樣板檢查 |
| `npm test` | 資料、日期、排序、快取、授權及同步控制器的本機測試 |
| `npm run test:storage-browser` | 啟動獨立來源的原生 IndexedDB 測試，開啟輸出網址後自動驗證並結束 |
| `npm run build` | 一般正式建置 |
| `npm run build:pages` | 正式建置，網站基底路徑為 `/iih-orbit/` |

建置輸出至 `dist/orbit-project-manager/browser`。`build` 透過 [.build.env](../.build.env) 設定 Angular 支援的 SQLite 快取，便於在限制較多的本機環境建置；不啟用 SSR。

## 本機 Google 授權

正式站台的設定見 [Google 連線設定](google-setup.md)。本機測試時，依 [Google Client ID 指引](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid) 加入 `http://localhost` 與 `http://localhost:4200`，並確認測試使用者及需要的 API 已啟用。

若 `127.0.0.1` 無法授權，先下載全部 Orbit 備份，再以 [http://localhost:4200](http://localhost:4200) 開啟並匯入。兩個來源儲存獨立，切換網址不會搬移資料；正式站台也是另一個來源。Client ID 在使用者設定頁填入，不寫入程式預設值或 workflow；無須 API Key 或 Client Secret。

## GitHub Pages

儲存庫：[chiyang/iih-orbit](https://github.com/chiyang/iih-orbit)。部署目標：[IIH Orbit](https://chiyang.github.io/iih-orbit/)。

在儲存庫 **Settings → Pages → Build and deployment → Source** 選擇 **GitHub Actions**。[pages.yml](../.github/workflows/pages.yml) 的行為如下：

| 觸發 | 行為 |
| --- | --- |
| 推送至 `main` | 安裝依賴、檢查、測試、正式建置及部署 |
| 對 `main` 的 Pull Request | 相同檢查與建置，不部署 |
| 在 `main` 手動執行 | 檢查、建置及部署 |

workflow 使用 Node.js 24.19.0，先 `npm ci`，再執行 `check`、`test` 與 `build:pages`。測試失敗時保留完整紀錄及失敗摘要。部署工作只上傳 `dist/orbit-project-manager/browser` 的靜態內容。

本機重現 Pages 建置：

```sh
npm run build:pages
```

正式 Google 授權來源為 `https://chiyang.github.io`，不含 `/iih-orbit/`。使用者將本機資料搬至正式站台時，先下載備份，再於正式站台匯入並重新連線 Google。參考 [GitHub Pages 自訂 workflow](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。

### 手機安裝資產

[manifest.webmanifest](../public/manifest.webmanifest) 設定 `display: standalone`，並提供 192、512 像素 PNG 圖示及獨立的 512 像素 maskable 圖示。[index.html](../src/index.html) 連結 manifest 與 180 像素 Apple Touch 圖示，保留既有 SVG favicon。圖示的可編輯 SVG 原稿放在 [public/icons](../public/icons/)；maskable 版本保留裁切安全範圍。

Manifest 的 `start_url`、`scope` 與圖示路徑皆相對於 manifest 所在位置，HTML 連結則沿用建置的 base href，因此本機根目錄與 Pages 的 `/iih-orbit/` 都能使用。省略 `id`，讓識別碼沿用 `start_url`；[相對的 id 會依來源根目錄解析](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/id)，不適合直接設為 `./`。`public` 資產由 Angular 原樣複製，無須加入 `@angular/pwa`、Service Worker 或離線快取。部署後的手機操作見 [使用指南](user-guide.md#安裝到手機主畫面)。

## 主要程式入口

下表列出各功能入口；相鄰的 HTML／CSS 負責介面與樣式。

| 功能 | 檔案 |
| --- | --- |
| 主介面、表單、篩選及拖曳 | [app.ts](../src/app/app.ts)、[app.html](../src/app/app.html) |
| 資料型別與首次空白狀態 | [models.ts](../src/app/models.ts)、[seed.ts](../src/app/seed.ts) |
| 工作空間與樣板 | [workspace-data.ts](../src/app/workspace-data.ts)、[workspace-templates.ts](../src/app/workspace-templates.ts)、[startup-guide.ts](../src/app/startup-guide.ts) |
| 核心資料、驗證與按紀錄保存 | [board-store.ts](../src/app/board-store.ts)、[board-data.ts](../src/app/board-data.ts)、[stored-data.ts](../src/app/stored-data.ts)、[workspace-records.ts](../src/app/workspace-records.ts) |
| 備份、雲端分塊與寫入協調 | [backup-data.ts](../src/app/backup-data.ts)、[backup-blocks.ts](../src/app/backup-blocks.ts)、[backup-panel.ts](../src/app/backup-panel.ts)、[storage-coordinator.ts](../src/app/storage-coordinator.ts) |
| 專案歸屬與進度 | [project-data.ts](../src/app/project-data.ts) |
| 日期、時間、月／週排列及改期 | [task-schedule.ts](../src/app/task-schedule.ts)、[schedule-controls.ts](../src/app/schedule-controls.ts)、[calendar.ts](../src/app/calendar.ts)、[week-layout.ts](../src/app/week-layout.ts)、[calendar-move.ts](../src/app/calendar-move.ts) |
| 描述編輯與內容清理 | [markdown-editor.ts](../src/app/markdown-editor.ts)、[rich-content.ts](../src/app/rich-content.ts)、[rich-content-data.ts](../src/app/rich-content-data.ts) |
| 任務編輯本機草稿 | [task-edit-drafts.ts](../src/app/task-edit-drafts.ts)；開啟、取消、還原與垃圾桶操作由 [app.ts](../src/app/app.ts) 協調 |
| 文件身份、關聯、用途與排序 | [document-data.ts](../src/app/document-data.ts)、[document-tasks.ts](../src/app/document-tasks.ts)、[document-links-editor.ts](../src/app/document-links-editor.ts) |
| 檔案來源、授權、目錄與選檔 | [drive-browser-connection.ts](../src/app/drive-browser-connection.ts)、[drive-browser-auth.ts](../src/app/drive-browser-auth.ts)、[drive-browser.ts](../src/app/drive-browser.ts)、[document-panel.ts](../src/app/document-panel.ts) |
| 檔案資訊查驗與共用快取 | [document-metadata-service.ts](../src/app/document-metadata-service.ts)、[document-metadata-manager.ts](../src/app/document-metadata-manager.ts)、[document-metadata-visible.ts](../src/app/document-metadata-visible.ts) |
| 文件建立、結果接續與安全整理 | [document-create-dialog.ts](../src/app/document-create-dialog.ts)、[document-create-auth.ts](../src/app/document-create-auth.ts)、[document-create-service.ts](../src/app/document-create-service.ts)、[document-create-recovery.ts](../src/app/document-create-recovery.ts)、[document-source-cleanup.ts](../src/app/document-source-cleanup.ts) |
| 空間總覽與統計圖表 | [workspace-overview.ts](../src/app/workspace-overview.ts)、[workspace-overview-data.ts](../src/app/workspace-overview-data.ts)、[overview-charts.ts](../src/app/overview-charts.ts) |
| 甘特時間軸與日期範圍 | [gantt.ts](../src/app/gantt.ts)、[gantt-data.ts](../src/app/gantt-data.ts) |
| 設定、外觀與瀏覽狀態 | [settings.ts](../src/app/settings.ts)、[appearance-data.ts](../src/app/appearance-data.ts)、[ui-preferences.ts](../src/app/ui-preferences.ts)、[browse-state.ts](../src/app/browse-state.ts) |
| 共用 Google 連線與合併授權 | [google-connection.ts](../src/app/google-connection.ts)、[google-combined-auth.ts](../src/app/google-combined-auth.ts)、[google-service-header.ts](../src/app/google-service-header.ts) |
| Calendar 授權、讀取、快取與同步 | [google-auth.ts](../src/app/google-auth.ts)、[google-session.ts](../src/app/google-session.ts)、[google-api.ts](../src/app/google-api.ts)、[google-calendar.ts](../src/app/google-calendar.ts)、[calendar-cache.ts](../src/app/calendar-cache.ts)、[calendar-sync.ts](../src/app/calendar-sync.ts) |
| 外部活動及任務移轉 | [calendar-sources.ts](../src/app/calendar-sources.ts)、[external-event-details.ts](../src/app/external-event-details.ts)、[calendar-transfer.ts](../src/app/calendar-transfer.ts)、[calendar-transfer-data.ts](../src/app/calendar-transfer-data.ts) |
| Gmail 讀取、快取與請求調節 | [gmail-auth.ts](../src/app/gmail-auth.ts)、[gmail-api.ts](../src/app/gmail-api.ts)、[gmail-service.ts](../src/app/gmail-service.ts)、[gmail-cache.ts](../src/app/gmail-cache.ts)、[gmail-requests.ts](../src/app/gmail-requests.ts) |
| 郵件側欄、預覽與建立任務 | [gmail-panel.ts](../src/app/gmail-panel.ts)、[mail-preview.ts](../src/app/mail-preview.ts)、[gmail-content.ts](../src/app/gmail-content.ts)、[mail-tasks.ts](../src/app/mail-tasks.ts) |
| Drive 備份、同步、歷史保留與刪除 | [drive-service.ts](../src/app/drive-service.ts)、[drive-engine.ts](../src/app/drive-engine.ts)、[drive-api.ts](../src/app/drive-api.ts)、[drive-repository.ts](../src/app/drive-repository.ts)、[drive-retention.ts](../src/app/drive-retention.ts) |
| 訊息提醒與前景提示 | [reminder-data.ts](../src/app/reminder-data.ts)、[reminder-items.ts](../src/app/reminder-items.ts)、[reminders.ts](../src/app/reminders.ts)、[reminder-delivery.ts](../src/app/reminder-delivery.ts)、[reminder-center.ts](../src/app/reminder-center.ts) |
| 品牌與配色 | [brand-mark.ts](../src/app/brand-mark.ts)、[theme-color.ts](../src/app/theme-color.ts)、[theme.css](../src/theme.css)、[styles.css](../src/styles.css) |

拖曳使用 [Angular CDK](https://angular.dev/guide/drag-drop)，表單及狀態採 [Angular Forms](https://angular.dev/guide/forms/template-driven-forms) 與 [Signals](https://angular.dev/guide/signals)。週排版參考 [FullCalendar TimeGrid](https://fullcalendar.io/docs/timegrid-view)，由現有 Angular 元件實作。

## 測試與驗收範圍

[tests](../tests/) 包含日期／週排列、工作空間／專案、任務草稿與垃圾桶刪除、文件關聯／用途／排序、多來源、查驗／建立／安全整理、總覽／甘特、備份相容、儲存失敗及跨分頁競態，另有 Calendar、Drive、Gmail 與合併授權的模擬測試。各次實際結果與建置限制記錄於 [QA.md](../QA.md)。

程式測試不代替瀏覽器版面或真實 Google 帳號驗收。真實 OAuth、API 回覆、郵件／活動內容、限流改善與跨裝置操作由使用者手動驗收；系統通知、背景推播、WebMCP 與 AI 日期判讀尚未加入。
