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
- **空間總覽**：目前空間的任務數、完成率、狀態／分類分布、各分類完成情況、專案概況、時程與待處理項目，可點選開啟任務清單彈窗，關閉後繼續查看總覽。
- **任務管理**：分類、狀態、優先順序、子任務、日期時間，以及 Markdown 描述、專注編輯與本機草稿；垃圾桶支援單筆徹底刪除。
- **五種視圖**：看板、清單、月曆、週視圖與甘特；月曆記住全部展開選擇，甘特提供專案分區、日／週／月時間軸、縮放、狀態列背景、分類任務條及日期範圍篩選，也可拖入郵件／檔案建立任務或加入連結。
- **Google Calendar**：顯示外部活動、移轉任務到可寫入月曆，或複製活動為獨立任務。
- **Gmail 與訊息提醒**：並排瀏覽郵件、搜尋與展開討論串，拖放建立已連結任務、查看每封郵件的相關任務，集中查看開始／到期提醒。
- **任務資訊連結**：多個 Drive 檔案來源與獨立授權，跨來源選檔、檔案／郵件拖放、任務雙欄與用途排序；共用檔名／位置查驗、從任務建立 Google 文件／試算表／簡報／Colab，並可瀏覽選擇保存資料夾及安全整理來源。
- **資料與閱讀設定**：本機自動儲存、JSON 備份／還原、Drive 遠端同步備份，以及主題、字級與瀏覽狀態保存。

## 使用文件

| 想了解的內容 | 文件 |
| --- | --- |
| 第一次使用、工作空間、專案、任務與視圖 | [使用指南](docs/user-guide.md) |
| 任務統計、專案概況與下鑽清單 | [空間總覽](docs/workspace-overview.md) |
| 時間軸、單一日期與未排程任務 | [甘特視圖](docs/gantt.md) |
| Client ID、個別服務連線與一次授權 | [Google 連線設定](docs/google-setup.md) |
| 外部月曆、更新、任務移轉與活動複製 | [Google Calendar 整合](docs/google-calendar.md) |
| 郵件標籤、搜尋、討論串、預覽與拖放 | [Gmail 郵件與任務](docs/gmail-design.md) |
| 任務雙欄、連結用途與手動排序 | [操作說明](docs/task-editor-information.md) |
| 多個 Drive 檔案來源、選檔與授權續接 | [多個 Drive 檔案來源](docs/drive-file-sources.md) |
| 連結名稱／位置更新、存取狀態與快取整理 | [檔案資訊更新](docs/document-information-refresh.md) |
| 從任務建立文件、失敗接續與無使用來源整理 | [建立文件與安全整理](docs/document-creation-and-cleanup.md) |
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

專案關閉 SSR 與預先渲染，GitHub Pages 只部署靜態檔案。Google 活動／郵件快取、Gmail 篩選標籤偏好、本機任務草稿與授權憑證不加入備份；已建立的 Orbit 任務及資訊連結照常保存。清除瀏覽器資料或更換網站來源前，請先正式儲存任務並匯出備份。

各次驗證與限制見 [QA 紀錄](QA.md)。真實 Google 資料與跨裝置操作由使用者手動驗收；本機模擬測試不代表真實服務驗收。

## 授權

本專案採用 [MIT 授權](LICENSE.md)。
