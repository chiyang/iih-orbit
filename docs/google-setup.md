# Google 連線設定

[文件索引](README.md) · [專案首頁](../README.md)

Orbit 不需要 Google 帳號即可管理本機任務。要使用 Gmail、Google Calendar 或遠端同步備份時，每位使用者自行申請 OAuth Client ID，於「設定 → Google 連線」填入一次，再按需要啟用服務。

## 首次設定

1. 在 [Google Cloud Console](https://console.cloud.google.com/) 建立專案，啟用需要的 **Google Calendar API**、**Gmail API**、**Google Drive API**。
2. 設定 Google Auth Platform 的品牌、對象與資料存取權。使用外部測試模式時，加入會操作 Orbit 的測試使用者。
3. 建立類型為「網頁應用程式」的 OAuth 用戶端。
4. 已授權的 JavaScript 來源加入 [https://chiyang.github.io](https://chiyang.github.io)。
5. 複製 Client ID，貼至 Orbit 的「Google 連線」分頁並保存。來源不包含 `/iih-orbit/` 路徑；本機開發的設定見 [開發與部署](development.md)。

「首次設定」說明位於 Google 連線分頁最上方，可展開查看。尚未設定 ID 時也可從頁首 G 按鈕進入；保存 ID 後，此按鈕隱藏，仍可由設定管理連線。

Client ID 欄位旁的「複製」按鈕可複製目前填寫的 ID，方便在其他裝置設定；欄位空白時按鈕停用，成功後顯示確認訊息。

Orbit 使用 Google Identity Services Token Model，直接由瀏覽器呼叫 REST API，無須 API Key 或 Client Secret。Client ID 是公開設定，不是授權憑證；不要將 Client Secret 填入 Orbit。參考 [建立 Client ID](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid) 與 [Token Model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)。

## 各服務的權限與入口

同一個 Client ID 可供三項服務使用；各服務保留自己的帳號與連線紀錄，可分別選擇不同 Google 帳號。

| 服務 | 個別連線取得的權限 | 功能設定 |
| --- | --- | --- |
| Google Calendar | 月曆讀取與帳號識別；首次移轉任務時另取得活動寫入權限 | 「Google 月曆」：工作空間綁定、來源與更新頻率 |
| Gmail | 郵件唯讀與帳號識別 | 「Gmail」：郵件使用與更新說明；側欄操作標籤、搜尋與更新 |
| 遠端同步備份 | Drive `drive.file` 與帳號識別 | 「遠端同步備份」：保存範圍、模式、頻率與雲端資料 |

可以在「Google 連線」同一頁分別連線或解除。已有 Client ID 時，各功能分頁上方也直接提供連線、切換帳號／重新授權及解除連線；沒有 ID 時才顯示「前往 Google 連線設定」。三個功能分頁共用相同的連線區樣式。

授權元件準備完成後，按連線才開啟 Google 授權視窗。Calendar 的寫入權限不代表所有月曆都能寫入；移轉只能選擇具有 `writerWithoutPrivateAccess`、`writer` 或 `owner` 權限的月曆。Drive 僅管理 Orbit 建立或明確授權的檔案，不列出帳號的所有 Drive 檔案。參考 [Drive 權限說明](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)。

## 一次授權全部服務

三個個別服務上方的「一次授權全部服務」只開啟一個 Google 視窗，以同一帳號申請 Calendar 讀取／移轉、Gmail 讀取與 Drive 檔案權限。

- 只同意部分權限時，接續已取得權限的服務，其餘顯示提示。
- 取消授權保留原有連線；各服務仍可之後個別改用其他帳號或解除。
- 此次憑證包含已同意的合併權限，各服務的本機連線紀錄仍分開管理。
- 授權本身不建立 Drive 備份，也不啟用自動同步。有待上傳資料時，先完成保存再使用合併授權。
- 關閉設定，或授權期間改變資料、Client ID 或帳號時，舊回覆不會接續連線。

## 授權保存與重新連線

| 服務 | 未過期憑證的本機保存方式 | 重新開啟時 |
| --- | --- | --- |
| Gmail | 目前瀏覽器的 localStorage | 驗證帳號、Client ID、資料世代、權限與原期限後接續 |
| Calendar | 每個分頁的 sessionStorage | 同一分頁重新整理可接續；新分頁可向同來源已連線分頁取得仍有效的憑證 |
| Drive | 獨立的 sessionStorage | 重新整理及同來源分頁可接續仍有效的連線 |

原到期時間不延長，沒有背景自動續期。到期後按連線恢復；離線或到期時仍可查看已有的 Calendar／Gmail 快取。

個別解除連線會停止該服務的本機讀取，其他服務保留。解除本機連線不撤銷 Google 端的應用程式授權；需要撤銷時使用設定中的應用存取權管理連結。更換 Client ID 會解除舊授權並停止 Drive 自動處理，須重新連線及啟用。

所有 Access Token 與授權狀態均不進 JSON／Drive 備份。完整備份可保存公開 Client ID 與部分帳號／服務設定，但在新瀏覽器還原後仍須授權。Gmail 的帳號、郵件預覽與標籤偏好只保存在目前瀏覽器。完整規則見 [備份與同步](backup-and-sync.md) 及 [資料儲存](data-storage.md)。

同來源包含相同協定、主機與連接埠。`localhost`、`127.0.0.1`、不同連接埠及正式站台各自保存本機資料；需要搬移時先匯出再匯入。

## 接著使用

- [Google Calendar 整合](google-calendar.md)：顯示活動、移轉任務與複製活動。
- [Gmail 郵件與任務](gmail-design.md)：搜尋、討論串與拖放建立任務。
- [備份、還原與遠端同步](backup-and-sync.md)：接續已有雲端資料，再設定自動保存。
