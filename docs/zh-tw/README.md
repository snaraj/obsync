> 本譯文以[英文原文](../../README.md)為準。英文版是正式版本；指令、參數、URL 與預留位置保持英文原樣，未作更動。

# Self Hosted Private Sync

為 [Obsidian](https://obsidian.md) 打造的自架、端對端加密即時同步：一個由你自己執行、沒有任何相依套件並內建儀表板的 Rust 伺服器，加上這個外掛程式。檔案大小不限，支援每一種 Obsidian 平台，不必訂閱，也沒有第三方。

在 Obsidian 1.13.0 或更新的版本上，從「設定 → 第三方外掛程式 → 瀏覽」中搜尋 **Self Hosted Private Sync**（外掛程式 ID `obsync-private-sync`）即可安裝。

> [!IMPORTANT]
> 這個外掛程式同步的對象，是由**你**自己執行的伺服器。沒有任何託管服務，除了你自己之外也不需要在任何人那裡開帳號：沒有一台你自己的、能透過 HTTPS 連到的 `obsyncd`，這個外掛程式就沒有任何可以同步的對象。

> [!IMPORTANT]
> 第一次同步之前請先備份你的儲存庫，並把 24 個單字的復原詞組保存在產生它的那台裝置以外的地方。伺服器只存放密文，無法替你復原儲存庫。

> [!IMPORTANT]
> 不要讓這個外掛程式和另一套同步方案同時作用在同一個儲存庫上 —— 不論是 Obsidian Sync、會同步檔案的雲端資料夾，還是另一個同步外掛程式。同一個儲存庫上有兩個寫入者，會產生兩邊都無法調解的衝突。

## 在你依賴它之前

這是一套年輕的軟體，而它同步的是你筆記的唯一一份副本。

- **[`CHANGELOG.md`](../../CHANGELOG.md) 是持續維護的已知事項清單。** 請讀你目前所用版本的條目，以及它上面的那些條目。發行頁面保留的是發布當下的說明；之後才發現的事情會補在這裡。
- **凡是同步某個儲存庫的裝置，每一台都要更新。** 只要有一台裝置還停在舊版本，它就可能依舊照著舊的行為動作，進而影響其他裝置。
- **實際在硬體上驗證過哪些項目**，逐次記錄在 [`docs/validation-runs/`](../validation-runs/)，其中也包含每次驗證沒有涵蓋的範圍。沒有任何一次驗證提到的平台，就是還沒有獲得證明。
- **兩台裝置同時編輯同一則筆記，出現一連串「merged concurrent edits」提示時**：在其中一台上結束 Obsidian，讓另一台把累積的工作做完，把兩台都更新之後再繼續。

## 這個外掛程式會存取什麼

簡短而完整，讓你在安裝之前就能做決定。

- **只有一個網路目的地：你自己的伺服器。** 每個請求都送往你在外掛程式設定裡填入的 **Server URL**，不會送到別處。沒有遙測、沒有分析、沒有當機回報、沒有廣告，同步路徑上的任何一段也沒有第三方服務。外掛程式同樣從不會從那台伺服器下載或執行程式碼。
- **那台伺服器上的一個帳號，由你自己建立。** 第一台裝置使用伺服器首次啟動時寫下的設定權杖；其餘每一台裝置，都是從一台已經在同步的裝置配對過來的。你的 Obsidian 帳號在這裡完全派不上用場。
- **Obsidian 與 GitHub，只用於安裝與更新。** 是 Obsidian 自己從這個程式碼庫的 GitHub Releases 下載 `main.js`、`manifest.json` 與 `styles.css`。每個 Release 另外還附上一個外掛程式 ZIP 和一份發行資訊清單，供要部署伺服器的人使用；這兩者 Obsidian 都會忽略。
- **你的邊緣節點，而且只有在你設定過的時候。** 你貼在 **Edge service-token headers** 底下的標頭，會隨每個送往上述伺服器 URL 的請求一起送出，因為需要這些標頭的代理伺服器就在通往你伺服器的路徑上。
- **你儲存庫的檔案清單。** 外掛程式會列出儲存庫裡的每個檔案，藉此判斷哪些在同步範圍內，讀取你所選資料夾裡的檔案，並寫入其他裝置改動的內容。隱藏資料夾（`.obsidian`、`.git`）和符號連結的資料夾會略過。
- **剪貼簿，只寫入、從不讀取。** 只有 **Pair a new device** 裡的 **Copy code** 與 **Copy link** 按鈕會寫入剪貼簿。外掛程式裡沒有任何部分會讀取剪貼簿。
- **你的瀏覽器，在你要求開啟儀表板的時候。** **Open dashboard** 會在你的瀏覽器裡開啟一個登入連結，而且只有在那個連結位於你自己伺服器的來源位址上時才會開啟。
- **Obsidian 的機密儲存區。** 儲存庫金鑰、裝置密鑰，以及任何邊緣節點標頭的值都放在那裡，絕不會放在外掛程式的一般資料中。

伺服器看得到什麼、看不到什麼，寫在 [`SECURITY.md`](../../SECURITY.md) 與 [`docs/threat-model.md`](../threat-model.md)。

## 五個步驟完成同步

這是這個版本實際驗證過的路徑，從一個空的儲存庫，到兩台裝置彼此同步。這五個步驟都假設你自己的伺服器已經在執行，那是下面那一節的內容；每個步驟在快速入門裡都有完整寫出。

1. **從第三方外掛程式安裝。** 在「設定 → 第三方外掛程式 → 瀏覽」中搜尋 **Self Hosted Private Sync**，選擇安裝，接著啟用 —— 和其他每一個 Obsidian 外掛程式的安裝方式一樣，在每個平台上都是如此。

   ![Obsidian 的第三方外掛程式瀏覽畫面，顯示 Self Hosted Private Sync 以及它的安裝按鈕](../captures/01-install-from-directory.png)

2. **指向你的伺服器並完成設定。** 開啟外掛程式的設定分頁，把 **Server URL** 設成你自己的伺服器，選擇這台裝置要同步哪些資料夾，然後把你的設定權杖貼到 **First-time setup** 底下。

   ![外掛程式的設定分頁，捲動到資料夾選擇、Pairing，以及 First-time setup 的權杖欄位](../captures/02-first-time-setup.png)

3. **保管好復原詞組。** 設定流程會在這台裝置上產生儲存庫金鑰，並且只顯示一次 24 個單字的詞組：把它抄下來，保存在這台裝置以外的地方，因為伺服器只保有密文，無法替你復原儲存庫。

   ![首次設定之後出現的復原詞組對話框，詞組內容已遮蔽](../captures/03-recovery-phrase.png)

4. **用一次性代碼配對第二台裝置。** 在第一台裝置上執行 **Pair a new device**，十分鐘內把它顯示的代碼輸入到第二台裝置，再依名稱核准這台裝置 —— 儲存庫金鑰是在一組伺服器永遠看不到的配對密鑰保護下加密傳送的。

   ![第一台裝置上的 Pair a new device 對話框，一次性代碼已遮蔽](../captures/04-pair-a-new-device.png)

5. **在任一台裝置上編輯，看著它抵達另一台。** 在一台裝置的筆記裡打字，幾秒之內它就會出現在另一台上，兩個方向都是如此，狀態列則會顯示同步正在做什麼。

   ![那則用完即丟的筆記帶著兩台裝置的編輯內容，同步狀態列清晰可見](../captures/05-sync-both-ways.png)

儀表板的裝置清單與它的撤銷按鈕，說明在[查看你的裝置](../daily-use.md#see-your-devices)一節；在 [docs/validation-runs/2026-09-14.md](../validation-runs/2026-09-14.md) 所記錄的 1.0.0 裝置驗證中，並沒有實際測試過它們。

## 開始同步

最短的正確路徑：一台屬於你的機器執行伺服器，每台裝置透過 HTTPS 連到它，而每台裝置各配對一次。登入 Obsidian 在這裡不會授權任何事；唯一的帳號就是你伺服器上的那一個。

### 1. 啟動伺服器

有兩種啟動方式。兩種執行的都是發布者簽署過的那一批位元組：驗證簽章，從驗證過的輸出裡讀出摘要，再執行那個摘要。`v1.0.6` 是撰寫這一頁時所依據的發行版本；請改用你正在安裝的那個發行版本的標籤。

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**還沒有 HTTPS 嗎？** `deploy/compose` 會把伺服器放在它自己的 TLS 終止點（Caddy）後面啟動，任何網路都適用，不需要網域，也不需要在任何人那裡開帳號。在這個程式碼庫的一份工作副本裡執行：

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` 是你的裝置要輸入的名稱，它只需要在你自己的網路裡解析得到。`OBSYNC_BIND_ADDRESS` 是這台主機上用來發布 80 與 443 連接埠的位址：繫結位址限制的是目的端介面，而不是來源端，所以真正決定誰連得到它的是你的防火牆。在你做出選擇之前，Compose 會拒絕啟動。兩者都在[執行伺服器](../server.md)裡說明。

**機器前面已經有 HTTPS 了嗎** —— 由一個反向代理，或一條你信任的通道提供？那就單獨執行伺服器本身。它在 8080 連接埠上講純 HTTP，由你的終止點轉送給它：

```sh
docker volume create obsync-blobs
docker volume create obsync-journal
docker run -d --name obsync -p 127.0.0.1:8080:8080 \
  -v obsync-blobs:/data/blobs -v obsync-journal:/data/journal \
  -e OBSYNC_BLOBS_CAPACITY=250GiB -e OBSYNC_JOURNAL_CAPACITY=4GiB \
  -e OBSYNC_PUBLIC_URL=https://sync.example.org \
  ghcr.io/snaraj/obsync@sha256:<the digest cosign just verified>
```

### 2. 讀取設定權杖

伺服器首次啟動時會鑄出一組設定權杖，寫進它的日誌磁碟區，權限 0600，而且從不寫進記錄檔。這組權杖只用來建立你的帳號一次，之後在伺服器的整個生命週期裡，它都會是儀表板的復原登入方式：請以對待復原詞組的同等謹慎來保管它。直接從容器本身把它讀出來，不需要任何輔助映像檔。在 Compose 路徑上：

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

在單獨執行伺服器的路徑上：

```sh
docker cp obsync:/data/journal/v1/setup-token - | tar -xO
```

### 3. 信任憑證，每台裝置一次（Compose 路徑）

Caddy 的憑證，是由它在首次啟動時自行產生的憑證授權單位所簽發，所以每台裝置都必須被明確告知一次，要去信任那個授權單位。把根憑證匯出來：

```sh
docker cp obsync-caddy-1:/data/caddy/pki/authorities/local/root.crt - | tar -xO > obsync-root.crt
```

在每台裝置上安裝 `obsync-root.crt`。macOS、Windows、Linux、iOS 與 Android 的步驟，寫在[信任憑證授權單位，每台裝置一次](../server.md#trust-the-certificate-authority-once-per-device)。在 iOS 上，安裝完之後還要再打開一個開關，才算信任這張憑證。

### 4. 設定第一台裝置

1. 設定 → 第三方外掛程式 → 瀏覽 → **Self Hosted Private Sync** → 安裝 → 啟用。
2. 在外掛程式的設定裡，把 **Server URL** 設成你的伺服器，如果連接埠不是 443 就要一併填上：`https://sync.example.org`。

   ![外掛程式的設定分頁：填著示範主機名稱的 Server URL 欄位、邊緣節點標頭的輸入框，以及帶有 Check 與 Open dashboard 按鈕的 Connection 這一列](../assets/settings-server.png)

3. 現在就選擇 **Whole vault** 或 **Selected folders only**。裝置一旦同步過，它的選擇範圍就只能縮小。
4. 把設定權杖貼到 **First-time setup** 底下，然後選擇 **Set up**。把 24 個單字的復原詞組抄下來，別留在這台裝置上。

   ![設定分頁的 This device 區塊：含有 Pair this device 與 Pair a new device 的 Pairing 這一列、含有 Setup token 欄位與 Set up 按鈕的 First-time setup 這一列，以及 Vault key 這一列](../assets/settings-setup.png)

### 5. 配對第二台裝置

1. 在那台裝置上安裝並啟用這個外掛程式，設定同一個 **Server URL**，並選擇它要同步的資料夾。
2. 在第一台裝置上執行 **Pair a new device**。它會顯示一組代碼，有效期是十分鐘。

   ![第一台裝置上的 Pair a new device 對話框，代碼已遮蔽，帶有 Copy code 與 Copy link 按鈕，以及 Waiting for the new device 這一行字](../assets/pair-new-device.png)

3. 在第二台裝置上開啟 **Pair this device**，貼上代碼，然後選擇 **Pair**。

   ![第二台裝置上的 Pair this device 對話框，其中是空白的 Pairing code 欄位與 Pair 按鈕](../assets/pair-this-device.png)

4. 回到第一台裝置，依名稱核准這台新裝置。在任一台上編輯一則筆記；它會在幾秒之內出現在另一台上。

   ![第一台裝置詢問是否要依名稱核准這台新裝置，帶有 Approve 與 Reject 按鈕](../assets/pair-approve.png)

   ![第二台裝置顯示著在第一台裝置上寫下的那則筆記，狀態列顯示 obsync idle](../assets/first-sync.png)

整個配對過程，濃縮成一小段循環動畫：

![動畫：配對代碼在第一台裝置上顯示，貼到第二台裝置，在第一台上核准，然後第一則筆記抵達第二台](../assets/pairing.gif)

手機截圖目前還不在這個程式碼庫裡；它們是在維護者自己的裝置上拍攝的，會在某次驗證把它們記錄下來時補上。

每個步驟的完整說明，連同每個畫面會問你什麼、又為什麼要問：[快速入門](../quickstart.md)。

**只想在一台電腦上試試看嗎？** 在電腦上，外掛程式也接受單純的 `http://` 位址，所以 `http://127.0.0.1:8080` 不必經過終止點，就能連到上面那台單獨執行的伺服器。手機則不行：iOS 與 Android 上的 Obsidian 會拒絕純 HTTP。

## 進階：Cloudflare

參考部署**沒有公開主機名稱**。一條 Cloudflare Tunnel 把伺服器的私有網路連到 Cloudflare，一條私有路由告訴 Cloudflare 哪些位址在這條通道後面，而每台裝置上的 Cloudflare One 用戶端則把前往伺服器 URL 的流量送進去。沒有任何東西能從網際網路連到，大量的首次同步也不會經由公開主機名稱代理。另一種方式，也就是放在 Cloudflare Access 後方的公開主機名稱，搭配填在 **Edge service-token headers** 裡的服務權杖與伺服器上的 `OBSYNC_EDGE=cloudflare`，同樣受支援。兩者的逐步做法：[Cloudflare](cloudflare.md)。

## 連到你伺服器的其他方式

每種方式一行，不是教學。不論你選哪一種，外掛程式都需要 HTTPS，而且憑證要是每台裝置都信任的；伺服器本身則留在那個終止點後面，繼續講純 HTTP。

- **只在區域網路內。** 上面的 Compose 路徑，只在家裡連得到。最簡單；出了門就不能同步。
- **WireGuard。** 你自己回到自家網路的 VPN。最快，而且完全屬於你；你要在每台裝置上帶著一份對端設定，並讓一個端點保持連得到。
- **Tailscale。** 一個受託管、自帶一套名稱的 WireGuard 網狀網路。裝置上要做的設定最少；由第三方協調這個網狀網路，而它的方案限制要你自己去讀。
- **具備自動 TLS 的反向代理**，例如架在公開名稱上的 Caddy。你會得到一張公開受信任的憑證和一個固定位址；但伺服器從此就能從網際網路連到，而這個代理與它的更新要由你自己顧好。
- **Cloudflare Tunnel。** 見上文。不需要對外開放連接埠；路徑上會有一個有自己條款的服務商。

不論你選哪一種，在外漫遊的裝置需要些什麼（路由、名稱、憑證、iOS 的區域網路存取提示、防火牆）：[從區域網路外連到它](../server.md#reaching-it-from-outside-your-lan)。

## 疑難排解

| 症狀 | 可能的原因 | 先試這個 |
| --- | --- | --- |
| `obsync: offline` | 裝置連不到伺服器 URL | 在同一台裝置的瀏覽器裡開啟這個 URL；檢查連接埠、HTTPS 與路由 |
| 電腦同步正常，手機卻連不上 | 手機上沒有信任那張私有憑證 | 安裝根憑證；在 iOS 上還要到「憑證信任設定」裡把它打開 |
| `401 stale_timestamp` | 某一邊的時鐘誤差超過 300 秒 | 在裝置或伺服器上開啟自動校時 |
| `403 device_pending` | 還沒有人核准這台裝置 | 在你用來配對的那台裝置上，依名稱核准它 |
| 某個檔案一直沒有送達 | 它不在資料夾選擇範圍內，或超過手機的大小上限 | 檢查 **Sync folders on this device**；在手機上執行 **Show remote-only files** |

其他所有症狀、每一種錯誤碼，以及如何收集一份值得送出的報告：[疑難排解](../troubleshooting.md)。

## 文件

| 頁面 | 它回答什麼 |
| --- | --- |
| [快速入門](../quickstart.md) | 第一台裝置與第二台裝置，每個步驟的完整說明 |
| [執行伺服器](../server.md) | Docker、搭配 Caddy 的 Compose、憑證、備份，以及從區域網路外連到它 |
| [Cloudflare](cloudflare.md) | 搭配私有路由與 Cloudflare One 用戶端的通道，或放在 Access 後方的公開主機名稱 |
| [Kubernetes](../../chart/README.md) | 用已簽署的 Helm chart 安裝伺服器 |
| [日常使用](../daily-use.md) | 指令、狀態列、哪些會同步哪些不會、還原某個版本，以及儀表板 |
| [設定](../settings.md) | 每一項設定、它的預設值，以及什麼時候該改它 |
| [疑難排解](../troubleshooting.md) | 症狀、原因、解法，以及如何收集報告 |
| [衝突](../conflicts.md) | 衝突副本是什麼，以及該拿它怎麼辦 |
| [復原](../recovery.md) | 遺失的裝置、遺失的伺服器、搬過家的伺服器、輪替過的權杖 |
| [安裝與更新](../community-plugin.md) | Obsidian 的外掛程式目錄、更新、認證資料的保管，以及上架審查 |
| [威脅模型](../threat-model.md) | 哪些有防護，哪些沒有 |
| [儀表板的威脅模型](../security/dashboard.md) | 工作階段、登入、撤銷、殘餘風險 |
| [架構](../architecture.md) | 整個系統是怎麼建起來的，以及每一個環境變數 |
| [協定](../protocol.md) | 外掛程式與伺服器之間的通訊契約 |
| [儲存](../storage.md) | 磁碟區、耐久性、保留、清查，以及每一種拒絕 |
| [驗證](../validation.md) | 裝置驗證計畫，以及「就緒」代表什麼 |
| [發行](../release.md) | 一次發行是怎麼切出、簽署與稽核的 |
| [翻譯](../translations.md) | 這些指南有哪些語言版本，以及它們如何保持在最新狀態 |
| [`CHANGELOG.md`](../../CHANGELOG.md) | 每個版本改了什麼 |
| [`SECURITY.md`](../../SECURITY.md) | 安全態勢、支援的版本，以及如何回報漏洞 |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | 如何在這個程式碼庫上開發 |

## 問題、錯誤與安全性

- **有疑問，或不確定某件事算不算錯誤：**[Discussions](https://github.com/snaraj/obsync/discussions)。
- **發現錯誤：**請[開一則議題](https://github.com/snaraj/obsync/issues/new/choose)，使用錯誤回報範本，並附上[疑難排解](../troubleshooting.md)裡說明的那份報告。不要放入任何權杖、任何復原詞組，也不要放入任何你不願公開的位址。
- **疑似有漏洞：**請依照 [`SECURITY.md`](../../SECURITY.md) 私下回報 —— 絕對不要開成公開的議題。

## 授權

MIT。見 [`LICENSE`](../../LICENSE)。
