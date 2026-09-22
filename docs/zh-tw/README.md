> 本譯文以[英文原文](../../README.md)為準。英文版是正式版本；指令、參數、URL 與預留位置保持英文原樣，未作更動。

<img src="../../brand/obsync-icon-256.png" alt="obsync 圖示：兩個相互扣合的圓環" width="96" height="96">

# Self Hosted Private Sync

為 [Obsidian](https://obsidian.md) 打造的自架、端對端加密即時同步：一個由你自己執行、沒有任何相依套件並內建儀表板的 Rust 伺服器，加上這個外掛程式。檔案大小不限，支援每一種 Obsidian 平台，不必訂閱，也沒有第三方。

在 Obsidian 1.13.0 或更新的版本上，從「設定 → 第三方外掛程式 → 瀏覽」中搜尋 **Self Hosted Private Sync**（外掛程式 ID `obsync-private-sync`）即可安裝。

> [!IMPORTANT]
> - 它同步的對象，是由**你**自己執行的伺服器：沒有託管服務，也不必在別處開帳號。
> - 請先備份你的儲存庫；24 個單字的復原詞組，別留在產生它的那台裝置上。
> - 絕對不要在同一個儲存庫上，讓它和另一套同步方案（Obsidian Sync、雲端資料夾、另一個外掛程式）並行。
> - 這是年輕的軟體：請讀 [`CHANGELOG.md`](../../CHANGELOG.md) 裡對應你所用版本的條目，更新每一台裝置，並弄清楚每次[驗證](../validation-runs/)涵蓋了哪些範圍。

## 這個外掛程式會存取什麼

- **只有你的伺服器，沒有別的。** 每個請求都送往你填入的 **Server URL**；沒有遙測，也沒有第三方。
- **那台伺服器上的一個帳號**，由設定權杖建立；你的 Obsidian 帳號在這裡派不上用場。
- **GitHub Releases，透過 Obsidian**，用於安裝與更新；額外附上的發行檔案，Obsidian 會忽略。
- **你儲存庫的檔案清單**，用來決定要同步哪些；隱藏資料夾（`.obsidian`、`.git`）與符號連結的資料夾會略過。
- **剪貼簿，只寫入**，由 **Pair a new device** 裡的 **Copy code** 與 **Copy link** 寫入，從不讀取。

伺服器看得到什麼、看不到什麼：[`SECURITY.md`](../../SECURITY.md) 與[威脅模型](../threat-model.md)。

## 開始同步

從零到兩台裝置彼此同步，五個步驟。`v1.0.6` 是撰寫這一頁時所依據的發行版本；請改用你正在安裝的那個版本的標籤。

### 1. 啟動伺服器

先驗證簽章，然後執行的就是它印出來的那個摘要：

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

最簡單的路徑，是在這個程式碼庫的一份工作副本裡用 Compose 搭配 Caddy：任何網路都有 HTTPS，不需要網域，也不需要在任何人那裡開帳號。

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` 是你的裝置要輸入的名稱，它只需要在你自己的網路裡解析得到。`OBSYNC_BIND_ADDRESS` 是用來發布 80 與 443 連接埠的位址：繫結位址限制的是目的端介面，而不是來源端，所以真正決定誰連得到它的是你的防火牆。在你做出選擇之前，Compose 會拒絕啟動。

前面已經有 HTTPS 了嗎 —— 由一個你信任的代理伺服器或通道提供？那就改為單獨執行伺服器本身：[執行伺服器](../server.md)。

### 2. 讀取設定權杖

伺服器首次啟動時會鑄出一組設定權杖，寫進它的日誌磁碟區，權限 0600，而且從不寫進記錄檔。它只用來建立你的帳號一次，之後則一直是儀表板的復原登入方式：請像保管復原詞組一樣保管它。直接從容器裡把它讀出來：

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

### 3. 信任憑證，每台裝置一次

Caddy 是用它在首次啟動時自行產生的憑證授權單位來簽發憑證的；每台裝置都必須信任它一次。把根憑證匯出來，並依照[執行伺服器](../server.md#trust-the-certificate-authority-once-per-device)所示，在各個平台上安裝；在 iOS 上，安裝完之後還要再打開一個開關，才算信任它。

### 4. 設定第一台裝置

1. 設定 → 第三方外掛程式 → 瀏覽 → **Self Hosted Private Sync** → 安裝 → 啟用。
2. 把 **Server URL** 設成你的伺服器（`https://sync.example.org`，連接埠不是 443 就要一併填上），然後選擇 **Whole vault** 或 **Selected folders only**；這個範圍之後只能縮小。

   ![外掛程式的設定分頁：填著示範主機名稱的 Server URL 欄位、邊緣節點標頭的輸入框，以及帶有 Check 與 Open dashboard 按鈕的 Connection 這一列](../assets/settings-server.png)

3. 把設定權杖貼到 **First-time setup** 底下，選擇 **Set up**，然後把 24 個單字的復原詞組抄下來。

   ![設定分頁的 This device 區塊：含有 Pair this device 與 Pair a new device 的 Pairing 這一列、含有 Setup token 欄位與 Set up 按鈕的 First-time setup 這一列，以及 Vault key 這一列](../assets/settings-setup.png)

### 5. 配對第二台裝置

1. 在那台裝置上用同一個 **Server URL** 安裝這個外掛程式；在第一台裝置上執行 **Pair a new device**，取得一組有效期十分鐘的代碼。

   ![第一台裝置上的 Pair a new device 對話框，代碼已遮蔽，帶有 Copy code 與 Copy link 按鈕，以及 Waiting for the new device 這一行字](../assets/pair-new-device.png)

2. 在第二台裝置上開啟 **Pair this device**，貼上代碼，然後選擇 **Pair**。
3. 回到第一台裝置，依名稱核准它。在任一台上編輯一則筆記；幾秒之內它就會出現在另一台上。

   ![第一台裝置詢問是否要依名稱核准這台新裝置，帶有 Approve 與 Reject 按鈕](../assets/pair-approve.png)

![動畫：配對代碼在第一台裝置上顯示，貼到第二台裝置，在第一台上核准，然後第一則筆記抵達第二台](../assets/pairing.gif)

只想在一台電腦上試試看嗎？在電腦上，`http://127.0.0.1:8080` 就能連到單獨執行的伺服器；iOS 與 Android 上的 Obsidian 則會拒絕純 HTTP。

手機截圖目前還不在這個程式碼庫裡；它們是在維護者自己的裝置上拍攝的，會在某次驗證把它們記錄下來時補上。

每個步驟的完整說明：[快速入門](../quickstart.md)。

## 進階：Cloudflare

參考部署沒有公開主機名稱：一條 Cloudflare Tunnel 與一條私有路由連到伺服器所在的網路，每台裝置上的 Cloudflare One 用戶端則把伺服器 URL 的流量帶進去。另一種方式，也就是放在 Cloudflare Access 後方的公開主機名稱，搭配填在 **Edge service-token headers** 裡的服務權杖與 `OBSYNC_EDGE=cloudflare`，同樣可行。兩者的逐步做法：[Cloudflare](cloudflare.md)。

## 連到你伺服器的其他方式

不論你選哪一種，外掛程式都需要 HTTPS，而且憑證要是每台裝置都信任的；伺服器本身則留在那個終止點後面，繼續講純 HTTP。

- **只在區域網路內。** 上面的 Compose 路徑，只在家裡連得到；出了門就不能同步。
- **WireGuard。** 你自己回到自家網路的 VPN：最快，而且完全屬於你；每台裝置上都要帶一份對端設定。
- **Tailscale。** 一個受託管的 WireGuard 網狀網路：設定最少；由第三方協調，並依它的方案條款。
- **具備自動 TLS 的反向代理**，例如架在公開名稱上的 Caddy：從網際網路連得到，更新要由你自己顧好。
- **Cloudflare Tunnel。** 見上文。不需要對外開放連接埠；路徑上會有一個服務商，依它自己的條款。

在外漫遊的裝置需要些什麼（路由、名稱、憑證、防火牆、iOS 的區域網路存取提示）：[從區域網路外連到它](../server.md#reaching-it-from-outside-your-lan)。

## 疑難排解

| 症狀 | 可能的原因 | 先試這個 |
| --- | --- | --- |
| `obsync: offline` | 裝置連不到伺服器 URL | 在那台裝置的瀏覽器裡開啟這個 URL；檢查連接埠、HTTPS 與路由 |
| 電腦同步正常，手機卻連不上 | 手機不信任那張私有憑證 | 安裝根憑證；在 iOS 上還要到「憑證信任設定」裡把它打開 |
| `401 stale_timestamp` | 某一邊的時鐘誤差超過 300 秒 | 在裝置或伺服器上開啟自動校時 |
| `403 device_pending` | 還沒有人核准這台裝置 | 在你用來配對的那台裝置上，依名稱核准它 |
| 某個檔案一直沒有送達 | 它不在資料夾選擇範圍內，或超過手機的大小上限 | 檢查 **Sync folders on this device**；在手機上執行 **Show remote-only files** |

其他所有症狀、每一種錯誤碼，以及如何回報：[疑難排解](../troubleshooting.md)。

## 文件

[快速入門](../quickstart.md) · [執行伺服器](../server.md) · [Cloudflare](cloudflare.md) · [日常使用](../daily-use.md) · [設定](../settings.md) · [疑難排解](../troubleshooting.md) · [復原](../recovery.md) · [變更紀錄](../../CHANGELOG.md)

其餘全部內容：[docs/README.md](../README.md)。

## 問題、錯誤與安全性

- **有疑問，或不確定某件事算不算錯誤：**[Discussions](https://github.com/snaraj/obsync/discussions)。
- **發現錯誤：**請[開一則議題](https://github.com/snaraj/obsync/issues/new/choose)，並附上[疑難排解](../troubleshooting.md)所說明的那份報告；不要放入任何權杖、任何詞組，也不要放入任何你不願公開的位址。
- **疑似有漏洞：**請依照 [`SECURITY.md`](../../SECURITY.md) 私下回報，絕對不要開成公開的議題。

## 授權

MIT。見 [`LICENSE`](../../LICENSE)。
