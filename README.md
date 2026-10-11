# TMU IIH Orbit｜專案進度軌道空間

> 讓每一步都慢慢上軌道

以工作空間串起專案、任務與時間安排的繁體中文工具。使用 Angular v22、Signals 與 Angular CDK 開發，純前端運作，資料優先保存在自己的瀏覽器；可按需要連接 Google Calendar、Gmail 與 Google Drive。

## 開始使用

**[開啟 IIH Orbit](https://chiyang.github.io/iih-orbit/)** · [GitHub 專案](https://github.com/chiyang/iih-orbit)

第一次使用從空白工作空間開始，不預先加入任務、分類或專案。可完成或略過七步操作引導，再命名並建立第一個工作空間，選擇空白或六種樣板；示範任務由自己決定是否加入。右上角問號可隨時重看介紹。

不需要 Google 帳號也能管理任務。Google 功能使用自己申請的 OAuth Client ID，在設定填入一次，再分別啟用需要的服務。

支援以瀏覽器安裝到手機主畫面，使用 IIh App 圖示並以無網址列的獨立視窗開啟。操作見 [手機安裝說明](docs/user-guide.md#安裝到手機主畫面)；目前載入網站仍需連線。

## 主要功能

- **工作空間與專案**：分開管理不同領域，查看專案進度，支援樣板與封存。
- **任務管理**：分類、狀態、優先順序、子任務、日期時間，以及 Markdown 描述與專注編輯。
- **四種視圖**：看板、清單、月曆與週視圖，支援拖曳排序、改期與快速建立任務。
- **Google Calendar**：顯示外部活動、移轉任務到可寫入月曆，或複製活動為獨立任務。
- **Gmail 與訊息提醒**：並排瀏覽郵件、搜尋與展開討論串，拖放建立任務，集中查看開始／到期提醒。
- **資料與閱讀設定**：本機自動儲存、JSON 備份／還原、Drive 遠端同步備份，以及主題、字級與瀏覽狀態保存。

## 使用文件

| 想了解的內容 | 文件 |
| --- | --- |
| 第一次使用、工作空間、專案、任務與視圖 | [使用指南](docs/user-guide.md) |
| Client ID、個別服務連線與一次授權 | [Google 連線設定](docs/google-setup.md) |
| 外部月曆、更新、任務移轉與活動複製 | [Google Calendar 整合](docs/google-calendar.md) |
| 郵件標籤、搜尋、討論串、預覽與拖放 | [Gmail 郵件與任務](docs/gmail-design.md) |
| JSON 備份、Drive 接續、歷史版本與衝突處理 | [備份、還原與遠端同步](docs/backup-and-sync.md) |

完整導覽與設計紀錄見 **[文件索引](docs/README.md)**。

## 本機開發

建議使用與 CI 相同的 Node.js 24.19.0。

```sh
npm ci
npm start
```

開啟 [http://127.0.0.1:4200](http://127.0.0.1:4200)。

檢查、測試、正式建置、GitHub Pages workflow 與主要檔案位置見 [開發與部署](docs/development.md)；儲存位置、舊資料升級與備份格式見 [資料儲存與相容性](docs/data-storage.md)。

專案關閉 SSR 與預先渲染，GitHub Pages 只部署靜態檔案。Google 活動／郵件快取與授權憑證不加入備份；已建立的 Orbit 任務照常保存。清除瀏覽器資料或更換網站來源前，請先匯出備份。

各次驗證與限制見 [QA 紀錄](QA.md)。真實 Google 資料與跨裝置操作由使用者手動驗收；本機模擬測試不代表真實服務驗收。

## 授權

本專案採用 [MIT 授權](LICENSE.md)。
