> この翻訳は[英語版の原文](../../README.md)に従います。正本は英語版です。コマンド、フラグ、URL、プレースホルダーは英語のまま変更していません。

<img src="../../brand/obsync-icon-256.png" alt="obsync アイコン: 組み合わさった 2 つの輪" width="96" height="96">

# Self Hosted Private Sync

[Obsidian](https://obsidian.md) のための、自己ホスト型でエンドツーエンド暗号化されたライブ同期です。ノートは、あなた自身が動かすサーバーを通じて同期されます。ノート、添付ファイル、ファイル名はデバイス上で暗号化され、サーバーが鍵を受け取ることはありません。プラグインは、デスクトップでもモバイルでも、Obsidian が動くすべてのプラットフォームで動作します。サブスクリプションも、ほかのどこかのアカウントもありません。

**うまく動かないときは → [トラブルシューティング](https://snaraj.github.io/obsync/troubleshooting/)（英語）**

## 目的別の案内

すべてのページは[ドキュメントサイト](https://snaraj.github.io/obsync/)（英語）にもあります。

### obsync を使う

| やりたいこと | 参照先 |
| --- | --- |
| デバイスからサーバーへの接続方法を選ぶ | [構成を選ぶ](../setup.md) |
| 自宅のネットワークで、スマートフォンの画面ごとにすべてを設定する | [同じネットワークで、手順ごとに](../same-network.md) |
| プラグインをインストールする | [プラグインのインストール](../community-plugin.md) |
| 最初のデバイスを設定する | [クイックスタート](../quickstart.md) |
| スマートフォンや別のコンピューターをペアリングする | [スマートフォンをペアリングする](../quickstart.md#pair-your-phone) |
| ステータスアイコンとコマンドの意味を知る | [日々の使い方](../daily-use.md)と[ステータスバーの読み方](../troubleshooting.md#reading-the-status-bar) |
| ノートの以前のバージョンを取り戻す | [保持されたバージョンを復元する](../daily-use.md#restore-a-retained-version) |
| 設定項目の働きを知る | [設定](../settings.md) |
| 競合コピーに対処する | [競合](../conflicts.md) |
| 問題を解決する | [トラブルシューティング](../troubleshooting.md) |
| デバイスをなくしたあと、再びアクセスする | [復旧](../recovery.md) |
| 保管庫を別のサーバーへ移す | [この保管庫を別のサーバーへ移す](../recovery.md#moving-this-vault-to-a-different-server) |

### サーバーを動かす

| やりたいこと | 参照先 |
| --- | --- |
| Docker または Compose でサーバーを動かす | [サーバーを動かす](../server.md) |
| 自分のプロキシ（Caddy、nginx、Traefik、HAProxy）の背後に置く | [TLS 終端がすでにある場合](../server.md#already-have-a-tls-terminator-docker) |
| コンテナを使わず、systemd の下で動かす | [静的バイナリ](../server.md#without-a-container-the-static-binary) |
| Kubernetes でサーバーを動かす | [Kubernetes](../kubernetes.md) と[チャートのリファレンス](../../chart/README.md) |
| 自分の VPN やプロキシを通じて、外出先からサーバーに接続する | [LAN の外から到達する](../server.md#reaching-it-from-outside-your-lan) |
| Cloudflare を使う（任意） | [Cloudflare](cloudflare.md) |
| 各デバイスでサーバーの証明書を信頼する | [認証局を信頼する](../server.md#trust-the-certificate-authority-once-per-device) |
| 必要なメモリーとディスクの量を知る | [必要なメモリー](../server.md#how-much-memory-it-needs)と[ストレージ](../storage.md) |
| サーバーをバックアップする | [2 つのボリュームをバックアップする](../server.md#back-up-the-two-volumes) |
| サーバーをアップグレードする | [ダイジェストでアップグレードする](../server.md#upgrade-by-digest) |
| デバイスの一覧を見て、どれかを失効させる | [ダッシュボード](../dashboard.md) |
| サーバーを消去して最初からやり直す | [サーバーの消去](../purge.md) |
| 各バージョンの変更点を見る | [`CHANGELOG.md`](../../CHANGELOG.md) |

### 信頼とプライバシー

| やりたいこと | 参照先 |
| --- | --- |
| このプラグインがデバイスとネットワークで何に触れるかを知る | [このプラグインがアクセスするもの](#このプラグインがアクセスするもの) |
| 何が暗号化され、サーバーに何が見えるかを理解する | [脅威モデル](../threat-model.md)と[ダッシュボードの脅威モデル](../security/dashboard.md) |
| セキュリティ上の問題を報告する | [`SECURITY.md`](../../SECURITY.md) |

### プロジェクトの内側

コントリビューターとレビュアー向け: [`CONTRIBUTING.md`](../../CONTRIBUTING.md)、[アーキテクチャ](../architecture.md)、[プロトコル](../protocol.md)、[ベンチマーク](../benchmarks.md)、[実機での検証実行](../validation-runs/)、そして[すべてのページ](../README.md)。

## インストール

![プラグインの設定が Get started から始まっている様子。Setup guide の行とその Open the guide ボタンが、Server URL 欄の上にある](../assets/settings-get-started.png)

**設定 → コミュニティプラグイン → 閲覧** からプラグインをインストールします。**Self Hosted Private Sync**（プラグイン ID `obsync-private-sync`）を検索してください。Obsidian 1.13.0 以降が必要です。プラグインの設定はセットアップガイドから始まり、ボタン一つで開けます。

> [!IMPORTANT]
> - 同期先は、**あなた自身**が動かすサーバーです。ホスティングされたサービスはなく、ほかのどこかのアカウントもありません。
> - 先に保管庫をバックアップしてください。24 語のリカバリーフレーズは、それを生成したデバイス以外の場所に保管します。
> - 一つの保管庫で、ほかの同期手段（Obsidian Sync、クラウドフォルダー、ほかのプラグイン）と並べて動かさないでください。
> - 生まれて間もないソフトウェアです。自分のバージョンの [`CHANGELOG.md`](../../CHANGELOG.md) の項目を読み、すべてのデバイスを更新し、各[検証実行](../validation-runs/)が何をカバーしたかを把握してください。

## 同期を始める

完全な手順のうち最短なのは、このリポジトリのチェックアウトから、自分のネットワーク上で Caddy 付きの Compose を使う方法です。どのネットワークでも HTTPS が使え、ドメインも、どこのアカウントも要りません。[同じネットワークで、手順ごとに](../same-network.md)が、この手順をすべての画面とともに説明しています。以下の `vX.Y.Z` は、インストールするリリース、つまり[リリースページ](https://github.com/snaraj/obsync/releases/latest)の最新タグに置き換えてください。

**1. イメージを検証する。** そのうえで、検証が出力したダイジェストをそのまま実行します。

```sh
cosign verify ghcr.io/snaraj/obsync:vX.Y.Z \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**2. サーバーを起動する。**

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` は、デバイスに入力する名前です。自分のネットワーク内で名前解決できれば十分です。`OBSYNC_BIND_ADDRESS` は、ポート 80 と 443 を公開するアドレスです。バインドアドレスが制限するのは宛先のインターフェースであって送信元ではないので、誰が到達できるかを決めるのはファイアウォールです。選ぶまで Compose は起動しません。

**3. セットアップトークンを読む。** 初回起動時に、サーバーはセットアップトークンを発行し、ジャーナルのボリュームにモード 0600 で書き出します。ログには決して出ません。このトークンはアカウントを一度だけ作り、その後もダッシュボードの復旧用サインインとして使えます。リカバリーフレーズと同じように大切に保管してください。

```sh
docker exec obsync-obsync-1 obsyncd setup-token
```

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

**4. 各デバイスを設定する。** サーバーの証明書を一度だけ信頼します（[方法](../server.md#trust-the-certificate-authority-once-per-device)）。プラグインをインストールし、[クイックスタート](../quickstart.md)に従って、最初のデバイスを設定してからほかのデバイスをペアリングします。

信頼しているプロキシやトンネルによって、すでに前段に HTTPS がありますか。その場合は、代わりに[素のサーバー](../server.md#already-have-a-tls-terminator-docker)を動かします。

## このプラグインがアクセスするもの

- **自分のサーバーだけ。** すべてのリクエストは、入力した **Server URL** に送られます。テレメトリーも第三者もありません。
- **そのサーバー上のアカウント**。セットアップトークンから作成され、Obsidian のアカウントは一切関係しません。
- **Obsidian を通じた GitHub Releases**。インストールと更新のために使い、Obsidian は追加のリリース資材を無視します。
- **保管庫のファイル一覧**。何を同期するか判断するために使い、隠しフォルダー（`.obsidian`、`.git`）とシンボリックリンクのフォルダーは対象外です。
- **クリップボードへの書き込みだけ。** 書き込むのは **Pair a new device** の **Copy code** と **Copy link** だけで、読むことは決してありません。
- **セットアップガイドを求めたときのブラウザー。** プロジェクトのガイドがブラウザーで開きます。プラグイン自身は何も送信しません。

サーバーに何が見え、何が見えないかは [`SECURITY.md`](../../SECURITY.md) と[脅威モデル](../threat-model.md)にあります。

## バージョン

LATEST のリリースは、[リリースページ](https://github.com/snaraj/obsync/releases/latest)の最新タグです。Obsidian がインストールし、更新するのはこのリリースです。`main` は EDGE で、マージ済みだが未リリースの作業を含み、ソースからビルドする人向けです。ベータチャンネルもプレリリースのタグもありません。変更履歴の Unreleased セクションが EDGE の記録です。

## 質問、バグ、セキュリティ

- **質問、あるいはバグかどうか自信がないとき：** [Discussions](https://github.com/snaraj/obsync/discussions)。
- **バグ：** [トラブルシューティング](../troubleshooting.md#how-to-collect-a-report)に書かれているレポートを添えて、[イシューを作成してください](https://github.com/snaraj/obsync/issues/new/choose)。公開したくないトークン、フレーズ、アドレスは含めないでください。
- **脆弱性の疑い：** 公開のイシューにはせず、[`SECURITY.md`](../../SECURITY.md) を通じて非公開で報告してください。

## ライセンス

MIT。[`LICENSE`](../../LICENSE) を参照してください。
