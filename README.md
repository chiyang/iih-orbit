# Orbit 專案進度工作台

使用 Angular v22、Signals 與 Angular CDK 開發的繁體中文專案看板。

## 開始使用

需要 Node.js 22.22.3 以上的相容版本；開發環境使用 Node.js 24.19.0。

```sh
npm install
npm start
```

在瀏覽器開啟 http://127.0.0.1:4200。

```sh
npm run check
npm run build
```

`check` 檢查 TypeScript 與 Angular 樣板；`build` 輸出正式版本至 `dist/orbit-project-manager/browser`。

正式建置使用 `.build.env` 指定 Angular 支援的 SQLite 快取，以便在限制較多的本機環境中執行。

## 功能

- 四欄看板：待辦事項、進行中、待審核、已完成。
- 以滑鼠拖曳卡片跨欄移動，同欄內也可排序；觸控拖曳支援長按。
- 建立、編輯、刪除任務，設定描述、分類、狀態、優先順序、負責人與截止日。
- 自訂分類名稱與六種顏色；刪除分類時保留任務，改為「未分類」。
- 子任務完成勾選與進度顯示。
- 搜尋、分類與優先順序篩選，以及「我的任務」「已完成任務」檢視。
- 清單視圖，可透過選單變更狀態，也方便鍵盤操作。
- 專案名稱修改、完成比例計算、逾期日期提示。
- 手機側邊欄與可水平捲動的看板。
- 對話框焦點管理、Escape 關閉與減少動態效果支援。

## 資料保存

任務、分類、專案名稱與任務順序儲存在同一瀏覽器、同一網站位址的 `localStorage`，儲存鍵為 `orbit-board-v1`。重新整理頁面會保留資料；清除瀏覽器網站資料會移除看板。

這是個人使用的前端版本，尚未串接後端、登入或多人同步。Mia、Alex、Jamie 與「我」是範例負責人。第一次開啟會載入可修改的範例任務。

## 主要檔案

- `src/app/app.ts`：互動、篩選、表單與拖曳事件。
- `src/app/app.html`、`src/app/app.css`：看板、清單與對話框介面。
- `src/app/board-store.ts`：資料狀態、排序與儲存驗證。
- `src/app/models.ts`、`src/app/seed.ts`：資料型別與範例看板。
- `QA.md`：實際驗證項目與建置環境限制。

拖曳功能依照 [Angular 官方 CDK 指引](https://angular.dev/guide/drag-drop)實作。
