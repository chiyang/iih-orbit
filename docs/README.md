# IIH Orbit 文件索引

[返回專案首頁](../README.md)

## 使用與設定

| 文件 | 內容 |
| --- | --- |
| [使用指南](user-guide.md) | 第一次使用、工作空間與樣板、專案、任務、四種視圖、閱讀設定與訊息提醒 |
| [Google 連線設定](google-setup.md) | 申請共用 Client ID、啟用各服務、個別或一次授權、帳號與憑證保存 |
| [Google Calendar 整合](google-calendar.md) | 綁定月曆、活動顯示、更新與離線快取、移轉任務與複製活動 |
| [Gmail 郵件與任務](gmail-design.md) | 標籤、搜尋、討論串、預覽、拖放建立任務與快取規則 |
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
| [Calendar 移轉設計](calendar-transfer-design.md) | 可寫入月曆、截止任務的時段、子任務格式、獨立副本及中斷處理 |
| [提醒設計](reminder-design.md) | 已實作的訊息提醒、前景提示，以及尚未加入的系統通知／背景推播 |
| [改版設計與實作順序](next-release-design.md) | 早期規劃、資料格式及各階段演進；部分段落描述的是當時的設計起點 |
| [任務文件連結與儲存演進規劃](task-document-hub-design.md) | 2026-10-13 討論：先實作備份優化；文件雙向關聯、側欄目錄及授權方案仍待後續實作 |

真實 Google 授權、信件／活動資料、Drive API 與跨裝置操作由使用者手動驗收；本機模擬測試不代表真實服務驗收。
