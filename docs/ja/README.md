> この翻訳は[英語版の原文](../../README.md)に従います。正本は英語版です。コマンド、フラグ、URL、プレースホルダーは英語のまま変更していません。

<img src="../../brand/obsync-icon-256.png" alt="obsync アイコン: 組み合わさった 2 つの輪" width="96" height="96">

# Self Hosted Private Sync

[Obsidian](https://obsidian.md) のための、自己ホスト型でエンドツーエンド暗号化されたライブ同期です。ダッシュボードを内蔵した依存関係のない Rust 製サーバーを一つ自分で動かし、そこにこのプラグインを組み合わせます。どんなサイズのファイルも扱え、Obsidian のすべてのプラットフォームに対応し、サブスクリプションも第三者もありません。

設定 → コミュニティプラグイン → 閲覧 から **Self Hosted Private Sync**（プラグイン ID `obsync-private-sync`）としてインストールします。Obsidian 1.13.0 以降が必要です。

> [!IMPORTANT]
> - 同期先は、**あなた自身**が動かすサーバーです。ホスティングされたサービスはなく、ほかのどこかのアカウントもありません。
> - 先に保管庫をバックアップしてください。24 語のリカバリーフレーズは、それを生成したデバイス以外の場所に保管します。
> - 一つの保管庫で、ほかの同期手段（Obsidian Sync、クラウドフォルダー、ほかのプラグイン）と並べて動かさないでください。
> - 生まれて間もないソフトウェアです。自分のバージョンの [`CHANGELOG.md`](../../CHANGELOG.md) の項目を読み、すべてのデバイスを更新し、各[検証実行](../validation-runs/)が何をカバーしたかを把握してください。

## このプラグインがアクセスするもの

- **自分のサーバーだけ。** すべてのリクエストは、入力した **Server URL** に送られます。テレメトリーも第三者もありません。
- **そのサーバー上のアカウント**。セットアップトークンから作成され、Obsidian のアカウントは一切関係しません。
- **Obsidian を通じた GitHub Releases**。インストールと更新のために使い、Obsidian は追加のリリース資材を無視します。
- **保管庫のファイル一覧**。何を同期するか判断するために使い、隠しフォルダー（`.obsidian`、`.git`）とシンボリックリンクのフォルダーは対象外です。
- **クリップボードへの書き込みだけ。** 書き込むのは **Pair a new device** の **Copy code** と **Copy link** だけで、読むことは決してありません。

サーバーに何が見え、何が見えないかは [`SECURITY.md`](../../SECURITY.md) と[脅威モデル](../threat-model.md)にあります。

## 同期を始める

何もない状態から、二台のデバイスが同期している状態までの五つのステップです。`v1.0.6` はこのページを書いた時点のリリースです。自分がインストールするタグを使ってください。

### 1. サーバーを起動する

署名を検証し、そこに出力されたダイジェストをそのまま実行します。

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

いちばん簡単な道筋は、このリポジトリのチェックアウトから Caddy 付きの Compose を使うことです。どのネットワークでも HTTPS が使え、ドメインも、どこのアカウントも要りません。

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` は、デバイスに入力する名前です。自分のネットワーク内で解決できればそれで十分です。`OBSYNC_BIND_ADDRESS` は、ポート 80 と 443 を公開するアドレスです。バインドアドレスが制限するのは宛先のインターフェースであって送信元ではないので、誰が到達できるかを決めるのはファイアウォールです。選ぶまで Compose は起動しません。

信頼しているプロキシやトンネルによって、すでに前段に HTTPS がありますか。その場合は、代わりに素のサーバーを動かします：[サーバーを動かす](../server.md)。

### 2. セットアップトークンを読む

初回起動時に、サーバーはセットアップトークンを発行し、ジャーナルのボリュームにモード 0600 で書き出します。ログには決して出ません。このトークンはアカウントを一度だけ作り、その後もダッシュボードの復旧用サインインであり続けます。リカバリーフレーズと同じだけの注意を払って扱ってください。コンテナから読み出します。

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

### 3. 証明書を信頼する。デバイスごとに一度

Caddy は、初回起動時に自分で生成した認証局で署名します。各デバイスは、その認証局を一度だけ信頼する必要があります。ルート証明書を書き出し、[サーバーを動かす](../server.md#trust-the-certificate-authority-once-per-device)が示すとおりにプラットフォームごとにインストールしてください。iOS では、証明書を信頼することは、インストールしたあとの二つ目のスイッチです。

### 4. 一台目のデバイスを設定する

1. 設定 → コミュニティプラグイン → 閲覧 → **Self Hosted Private Sync** → インストール → 有効化。
2. **Server URL** を自分のサーバーに設定し（`https://sync.example.org`。443 以外ならポートも含めます）、**Whole vault** か **Selected folders only** を選びます。あとから変えられるのは、狭める方向だけです。

   ![プラグインの設定タブ。デモ用のホスト名が入った Server URL 欄、エッジヘッダーの入力欄、Check と Open dashboard のボタンがある Connection の行](../assets/settings-server.png)

3. セットアップトークンを **First-time setup** の下に貼り付け、**Set up** を選び、24 語のリカバリーフレーズを書き留めます。

   ![設定タブの This device セクション。Pair this device と Pair a new device がある Pairing の行、Setup token 欄と Set up ボタンがある First-time setup の行、そして Vault key の行](../assets/settings-setup.png)

### 5. 二台目のデバイスをペアリングする

1. 二台目でも同じ **Server URL** でプラグインをインストールします。一台目で **Pair a new device** を実行すると、10 分間有効なコードが表示されます。

   ![一台目のデバイスの Pair a new device ダイアログ。コードは伏せられ、Copy code と Copy link のボタン、そして Waiting for the new device の行がある](../assets/pair-new-device.png)

2. 二台目で **Pair this device** を開き、コードを貼り付けて **Pair** を選びます。
3. 一台目に戻り、新しいデバイスを名前で承認します。どちらかでノートを編集すると、数秒のうちにもう片方に現れます。

   ![新しいデバイスを名前で承認するかどうかを尋ねている一台目のデバイス。Approve と Reject のボタンがある](../assets/pair-approve.png)

![アニメーション：一台目に表示されたペアリングコードが二台目に貼り付けられ、一台目で承認され、最初のノートが二台目に届くまで](../assets/pairing.gif)

一台のコンピューターで試しますか。コンピューターなら `http://127.0.0.1:8080` で素のサーバーに届きます。iOS と Android の Obsidian は平文の HTTP を拒否します。

スマートフォンのスクリーンショットは、まだこのリポジトリにはありません。メンテナー自身のデバイスで撮影され、検証実行がそれを記録した時点で追加されます。

各ステップの全文は[クイックスタート](../quickstart.md)にあります。

## 応用：Cloudflare

リファレンス構成には公開ホスト名がありません。Cloudflare Tunnel とプライベートルートがサーバーのネットワークに到達し、各デバイスの Cloudflare One クライアントが Server URL への通信をそこへ運びます。**Edge service-token headers** にサービストークンを入れ、`OBSYNC_EDGE=cloudflare` を設定した、Cloudflare Access の背後の公開ホスト名でも動きます。どちらも手順を追って説明しています：[Cloudflare](cloudflare.md)。

## サーバーに届くほかの方法

何を選ぶにしても、プラグインにはすべてのデバイスが信頼する証明書を備えた HTTPS が必要で、サーバー自身はその終端の背後で平文の HTTP のままです。

- **LAN だけ。** 上記の Compose の構成を、自宅でだけ使います。外出先での同期はできません。
- **WireGuard。** 自分のネットワークへ戻る自前の VPN です。最も速く完全に自分のものですが、すべてのデバイスにピア設定が要ります。
- **Tailscale。** 管理された WireGuard のメッシュです。設定はいちばん少なくて済みますが、調整するのは第三者であり、そのプランの条件に従います。
- **自動 TLS 付きのリバースプロキシ**。公開の名前で動く Caddy などです。インターネットから到達可能になり、更新を当てるのは自分の責任です。
- **Cloudflare Tunnel。** 上記のとおりです。受信ポートは不要ですが、経路上に独自の条件を持つプロバイダーがいます。

外出先のデバイスに必要なもの（経路、名前、証明書、ファイアウォール、iOS のローカルネットワークの確認）は[LAN の外から到達する](../server.md#reaching-it-from-outside-your-lan)にあります。

## トラブルシューティング

| 症状 | 考えられる原因 | まず試すこと |
| --- | --- | --- |
| `obsync: offline` | デバイスが Server URL に到達できない | 同じデバイスのブラウザーでその URL を開き、ポート、HTTPS、経路を確認する |
| コンピューターは同期しているのに、スマートフォンがつながらない | スマートフォンでプライベート証明書が信頼されていない | ルート証明書をインストールする。iOS ではさらに「証明書信頼設定」でオンにする |
| `401 stale_timestamp` | どこかの時計が 300 秒以上ずれている | デバイスかサーバーで、時刻の自動設定をオンにする |
| `403 device_pending` | まだ誰もそのデバイスを承認していない | ペアリング元のデバイスで、名前を見て承認する |
| ファイルがいつまでも届かない | フォルダー選択の外にあるか、スマートフォンのサイズ上限を超えている | **Sync folders on this device** を確認する。スマートフォンでは **Show remote-only files** を実行する |

それ以外のすべての症状とエラーコード、そして報告のしかたは[トラブルシューティング](../troubleshooting.md)にあります。

## ドキュメント

[クイックスタート](../quickstart.md) · [サーバーを動かす](../server.md) · [Cloudflare](cloudflare.md) · [日々の使い方](../daily-use.md) · [設定](../settings.md) · [トラブルシューティング](../troubleshooting.md) · [復旧](../recovery.md) · [変更履歴](../../CHANGELOG.md)

そのほかはすべて [docs/README.md](../README.md) にあります。

## 質問、バグ、セキュリティ

- **質問、あるいはバグかどうか自信がないとき：** [Discussions](https://github.com/snaraj/obsync/discussions)。
- **バグ：** [トラブルシューティング](../troubleshooting.md)に書かれているレポートを添えて、[イシューを作成してください](https://github.com/snaraj/obsync/issues/new/choose)。トークン、リカバリーフレーズ、公開したくないアドレスは含めないでください。
- **脆弱性の疑い：** 公開のイシューにはせず、[`SECURITY.md`](../../SECURITY.md) を通じて非公開で報告してください。

## ライセンス

MIT。[`LICENSE`](../../LICENSE) を参照してください。
