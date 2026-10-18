# IIH Orbit 文件索引

[返回專案首頁](../README.md)

## 使用與設定

| 文件 | 內容 |
| --- | --- |
| [使用指南](user-guide.md) | 第一次使用、工作空間與樣板、專案、任務、五種視圖、閱讀設定與訊息提醒 |
| [離線使用與安裝](offline-tasks.md) | 離線開啟、本機任務編輯、主畫面安裝、連線恢復與版本更新 |
| [甘特視圖](gantt.md) | 專案分區、日期排序、縮放、細分日期格、狀態／分類配色、日期範圍、日期拖移／伸縮及郵件／檔案拖放 |
| [相關任務](related-tasks.md) | 同空間跨專案雙向連結、拖放／選取、草稿及格式 9 相容性 |
| [空間總覽](workspace-overview.md) | 任務統計、狀態／分類分布、分類完成率、專案進度、時程、查驗覆蓋與清單彈窗 |
| [Google 連線設定](google-setup.md) | 申請共用 Client ID、啟用各服務、個別或一次授權、帳號與憑證保存 |
| [Google Calendar 整合](google-calendar.md) | 綁定月曆、活動顯示、更新與離線快取、移轉任務與複製活動 |
| [Gmail 郵件與任務](gmail-design.md) | 標籤、搜尋、討論串、預覽、拖放與相關任務，以及只保存在本機的篩選與快取 |
| [任務資訊連結：第一階段](task-document-phase1.md) | Drive 目錄、獨立選檔、Gmail／檔案四視圖拖曳與關聯保存 |
| [任務雙欄與連結用途](task-editor-information.md) | 任務雙欄、純文字用途、混合排序、復原及格式 7 相容性 |
| [多個 Drive 檔案來源](drive-file-sources.md) | 多帳號與不同 Client ID、獨立瀏覽位置、授權續接及來源移除 |
| [檔案資訊更新](document-information-refresh.md) | 共用檔名／位置查驗、存取狀態、多來源結果與快取整理 |
| [建立文件與安全整理](document-creation-and-cleanup.md) | Google 文件／試算表／簡報／Colab、資料夾選取、建立授權、逾時查核及孤立來源整理 |
| [備份、還原與遠端同步](backup-and-sync.md) | JSON 匯出／匯入、Drive 接續、自動保存、歷史版本、衝突與刪除 |

## 開發與資料機制

| 文件 | 內容 |
| --- | --- |
| [開發與部署](development.md) | 本機啟動、檢查、測試、正式建置、GitHub Pages workflow 與主要檔案 |
| [資料儲存與相容性](data-storage.md) | localStorage、sessionStorage、IndexedDB、分頁協調、舊資料升級與保存失敗 |
| [本機紀錄與雲端分塊備份](storage-sync-upgrade.md) | 本輪備份優化、資料升級、區塊重用、歷史維護與量測界線 |
| [QA 紀錄](../QA.md) | 各次修改的驗證結果、建置限制及尚需手動驗收的範圍 |

## 設計紀錄

這些文件保留設計決定及演進脈絡；首次使用請先閱讀上方的操作指南。

| 文件 | 內容 |
| --- | --- |
| [下一輪改版規劃（2026-10-15）](task-hub-next-release-plan.md) | 第一至五階段、G1／G2 甘特及後續完成趨勢／跨空間提醒／相關任務／系統通知已實作；來源永久壓縮仍待後續 |
| [Calendar 移轉設計](calendar-transfer-design.md) | 可寫入月曆、截止任務的時段、子任務格式、獨立副本及中斷處理 |
| [提醒設計](reminder-design.md) | 跨工作空間訊息提醒、提醒歷史、前景提示與可主動啟用的系統通知；純前端開啟期間排程，無背景推播 |
| [改版設計與實作順序](next-release-design.md) | 早期規劃、資料格式及各階段演進；部分段落描述的是當時的設計起點 |
| [任務文件連結與儲存演進規劃](task-document-hub-design.md) | 早期儲存與文件關聯設計、後續交付索引；pCloud／Microsoft 365 仍未串接 |

真實 Google 授權、信件／活動資料、Drive API 與跨裝置操作由使用者手動驗收；本機模擬測試不代表真實服務驗收。
