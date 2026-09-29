> 本譯文以[英文原文](../../README.md)為準。英文版是正式版本；指令、參數、URL 與預留位置保持英文原樣，未作更動。

<img src="../../brand/obsync-icon-256.png" alt="obsync 圖示：兩個相互扣合的圓環" width="96" height="96">

# Self Hosted Private Sync

為 [Obsidian](https://obsidian.md) 打造的自架、端對端加密即時同步。你的筆記透過你自己執行的伺服器同步。筆記、附件與檔案名稱都在你的裝置上加密，伺服器永遠拿不到金鑰。外掛程式在 Obsidian 能執行的每個平台上都能運作，桌面與行動裝置皆然。不必訂閱，也不必在別處開帳號。

**遇到問題？→ [疑難排解](https://snaraj.github.io/obsync/troubleshooting/)（英文）**

## 依需求查找

每一頁也都在[文件網站](https://snaraj.github.io/obsync/)（英文）上。

### 使用 obsync

| 我想要… | 前往 |
| --- | --- |
| 選擇裝置連線到伺服器的方式 | [選擇你的架設方式](../setup.md) |
| 在家用網路裡完成全部設定，並看到手機上的每個畫面 | [同一網路，逐步操作](../same-network.md) |
| 安裝外掛程式 | [安裝外掛程式](../community-plugin.md) |
| 設定第一台裝置 | [快速入門](../quickstart.md) |
| 配對一支手機或另一台電腦 | [配對你的手機](../quickstart.md#pair-your-phone) |
| 了解狀態圖示與各個指令的意思 | [日常使用](../daily-use.md)與[看懂狀態列](../troubleshooting.md#reading-the-status-bar) |
| 找回一則筆記的舊版本 | [還原保留的版本](../daily-use.md#restore-a-retained-version) |
| 了解某個設定項目的作用 | [設定](../settings.md) |
| 處理衝突副本 | [衝突](../conflicts.md) |
| 解決問題 | [疑難排解](../troubleshooting.md) |
| 遺失裝置後重新進入 | [復原](../recovery.md) |
| 把儲存庫搬到另一台伺服器 | [把這個儲存庫搬到另一台伺服器](../recovery.md#moving-this-vault-to-a-different-server) |

### 執行伺服器

| 我想要… | 前往 |
| --- | --- |
| 用 Docker 或 Compose 執行伺服器 | [執行伺服器](../server.md) |
| 把它放在我自己的代理伺服器（Caddy、nginx、Traefik、HAProxy）後方 | [已經有 TLS 終止點](../server.md#already-have-a-tls-terminator-docker) |
| 不用容器，在 systemd 底下執行 | [靜態二進位檔](../server.md#without-a-container-the-static-binary) |
| 在 Kubernetes 上執行伺服器 | [Kubernetes](../kubernetes.md) 與 [chart 參考](../../chart/README.md) |
| 透過我自己的 VPN 或代理伺服器，在外出時連到伺服器 | [從區域網路外連線](../server.md#reaching-it-from-outside-your-lan) |
| 使用 Cloudflare（選用） | [Cloudflare](cloudflare.md) |
| 在每台裝置上信任伺服器的憑證 | [信任憑證授權單位](../server.md#trust-the-certificate-authority-once-per-device) |
| 了解需要多少記憶體與磁碟空間 | [需要多少記憶體](../server.md#how-much-memory-it-needs)與[儲存](../storage.md) |
| 備份伺服器 | [備份兩個磁碟區](../server.md#back-up-the-two-volumes) |
| 升級伺服器 | [依摘要升級](../server.md#upgrade-by-digest) |
| 查看我的裝置並撤銷其中一台 | [儀表板](../dashboard.md) |
| 清空伺服器，從頭開始 | [清空伺服器](../purge.md) |
| 查看每個版本改了什麼 | [`CHANGELOG.md`](../../CHANGELOG.md) |

### 信任與隱私

| 我想要… | 前往 |
| --- | --- |
| 了解這個外掛程式在我的裝置與網路上會碰到什麼 | [這個外掛程式會存取什麼](#這個外掛程式會存取什麼) |
| 了解哪些內容會加密、伺服器看得到什麼 | [威脅模型](../threat-model.md)與[儀表板的威脅模型](../security/dashboard.md) |
| 回報安全性問題 | [`SECURITY.md`](../../SECURITY.md) |

### 專案內部

給貢獻者與審閱者：[`CONTRIBUTING.md`](../../CONTRIBUTING.md)、[架構](../architecture.md)、[協定](../protocol.md)、[效能基準](../benchmarks.md)、[裝置驗證紀錄](../validation-runs/)，以及[所有頁面](../README.md)。

## 安裝

![外掛程式的設定以 Get started 開頭：Setup guide 一列與它的 Open the guide 按鈕，位在 Server URL 欄位上方](../assets/settings-get-started.png)

從 **設定 → 第三方外掛程式 → 瀏覽** 安裝外掛程式。搜尋 **Self Hosted Private Sync**（外掛程式 ID `obsync-private-sync`）。需要 Obsidian 1.13.0 或更新的版本。外掛程式的設定以設定指南開頭，按一下就能開啟。

> [!IMPORTANT]
> - 它同步的對象，是由**你**自己執行的伺服器：沒有託管服務，也不必在別處開帳號。
> - 請先備份你的儲存庫；24 個單字的復原詞組，別留在產生它的那台裝置上。
> - 絕對不要在同一個儲存庫上，讓它和另一套同步方案（Obsidian Sync、雲端資料夾、另一個外掛程式）並行。
> - 這是年輕的軟體：請讀 [`CHANGELOG.md`](../../CHANGELOG.md) 裡對應你所用版本的條目，更新每一台裝置，並弄清楚每次[驗證](../validation-runs/)涵蓋了哪些範圍。

## 開始同步

最短的完整路徑，是從本儲存庫的簽出目錄，在你自己的網路裡使用搭配 Caddy 的 Compose。它在任何網路上都能提供 HTTPS，不需要網域，也不必在任何地方開帳號。[同一網路，逐步操作](../same-network.md)會帶著每個畫面走完這條路徑。把下面的 `vX.Y.Z` 換成你要安裝的發行版本，也就是 [Releases 頁面](https://github.com/snaraj/obsync/releases/latest)上最新的標籤。

**1. 驗證映像檔。** 接著原封不動地執行驗證印出的摘要：

```sh
cosign verify ghcr.io/snaraj/obsync:vX.Y.Z \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**2. 啟動伺服器：**

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` 是你的裝置要填入的名稱。它只需要在你自己的網路裡能解析。`OBSYNC_BIND_ADDRESS` 是發布 80 與 443 連接埠的位址：繫結位址限制的是目的地介面，而不是來源，所以誰能連到它由你的防火牆決定。在你做出選擇之前，Compose 會拒絕啟動。

**3. 讀取設定權杖。** 首次啟動時，伺服器會產生一組設定權杖，以 0600 權限寫入它的 journal 磁碟區，且從不記錄到日誌裡。它只用來建立一次你的帳號，之後仍是儀表板的復原登入方式。請像保管復原詞組一樣保管它：

```sh
docker exec obsync-obsync-1 obsyncd setup-token
```

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

**4. 設定每台裝置。** 信任一次伺服器的憑證（[做法](../server.md#trust-the-certificate-authority-once-per-device)）。安裝外掛程式，然後依照[快速入門](../quickstart.md)操作：先設定第一台裝置，再配對其他裝置。

前方已經有來自你信任的代理伺服器或通道的 HTTPS？那就改為執行[單純的伺服器](../server.md#already-have-a-tls-terminator-docker)。

## 這個外掛程式會存取什麼

- **只有你的伺服器，沒有別的。** 每個請求都送往你填入的 **Server URL**；沒有遙測，也沒有第三方。
- **那台伺服器上的一個帳號**，由設定權杖建立；你的 Obsidian 帳號在這裡派不上用場。
- **GitHub Releases，透過 Obsidian**，用於安裝與更新；額外附上的發行檔案，Obsidian 會忽略。
- **你儲存庫的檔案清單**，用來決定要同步哪些；隱藏資料夾（`.obsidian`、`.git`）與符號連結的資料夾會略過。
- **剪貼簿，只寫入**，由 **Pair a new device** 裡的 **Copy code** 與 **Copy link** 寫入，從不讀取。
- **你的瀏覽器，在你要求開啟設定指南時。** 專案的指南會在瀏覽器裡開啟；外掛程式本身什麼也不送出。

伺服器看得到什麼、看不到什麼：[`SECURITY.md`](../../SECURITY.md) 與[威脅模型](../threat-model.md)。

## 版本

LATEST 版本是 [Releases 頁面](https://github.com/snaraj/obsync/releases/latest)上最新的標籤，也是 Obsidian 安裝與更新到的版本。`main` 是 EDGE：已經合併但尚未發行的工作，給從原始碼建置的人使用。沒有 beta 通道，也沒有預先發行的標籤。變更紀錄的 Unreleased 區段就是 EDGE 的紀錄。

## 問題、錯誤與安全性

- **有疑問，或不確定是不是錯誤：** [Discussions](https://github.com/snaraj/obsync/discussions)。
- **錯誤：** 附上[疑難排解](../troubleshooting.md#how-to-collect-a-report)所描述的報告，[開一個 issue](https://github.com/snaraj/obsync/issues/new/choose)。不要放入任何你不願公開的權杖、詞組或位址。
- **疑似漏洞：** 透過 [`SECURITY.md`](../../SECURITY.md) 私下回報，不要開公開的 issue。

## 授權

MIT。請參閱 [`LICENSE`](../../LICENSE)。
