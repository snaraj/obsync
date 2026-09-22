> 本译文以[英文原文](../../README.md)为准。英文版是规范版本；命令、参数、URL 和占位符保持英文原样，未作改动。

# Self Hosted Private Sync

为 [Obsidian](https://obsidian.md) 提供的自托管、端到端加密的实时同步：一个由你自己运行、没有任何依赖的 Rust 服务器，内置控制面板，再加上这个插件。文件不限大小，支持 Obsidian 的每一个平台，无需订阅，不经第三方。

在 Obsidian 1.13.0 或更新的版本中，从设置 → 第三方插件 → 浏览里搜索 **Self Hosted Private Sync**（插件 ID `obsync-private-sync`）来安装。

> [!IMPORTANT]
> 这个插件只同步到**你自己**运行的服务器。没有托管服务，也不需要在除你自己之外的任何人那里开账号：没有一台属于你自己、通过 HTTPS 可达的 `obsyncd`，这个插件就没有任何可同步的对象。

> [!IMPORTANT]
> 首次同步之前请备份你的仓库，并把 24 个单词的恢复短语保存在生成它的那台设备之外的地方。服务器只保存密文，无法替你恢复仓库。

> [!IMPORTANT]
> 不要在同一个仓库上把这个插件和另一套同步方案一起使用 —— 无论是 Obsidian Sync、会同步文件的云盘文件夹，还是另一个同步插件。同一个仓库上有两个写入方，会产生两边都无法调和的冲突。

## 在你依赖它之前

这是一款年轻的软件，而它同步的是你笔记的唯一一份副本。

- **[`CHANGELOG.md`](../../CHANGELOG.md) 是持续维护的已知情况清单。** 请阅读你所用版本对应的条目，以及它上面的那些条目。发布页面保留的是发布当时附带的说明；后来发现的情况会补充到这里。
- **同步同一个仓库的每台设备都要更新。** 只要有一台设备停留在旧版本，它就仍然会按旧的行为行事，并影响其他设备。
- **在真实硬件上实际验证过什么**，按每次验证运行分别记录在 [`docs/validation-runs/`](../validation-runs/) 中，其中也写明了每次验证没有覆盖什么。没有哪次验证提到的平台，就是没有得到证明的平台。
- **两台设备编辑同一篇笔记时不断出现的 "merged concurrent edits" 提示**：在其中一台上退出 Obsidian，让另一台把积压的工作做完，把两台都更新，然后再继续。

## 这个插件会访问什么

简短而完整，好让你在安装之前就能作出判断。

- **只有一个网络目的地：你自己的服务器。** 每个请求都发往你在插件设置里填写的 **Server URL**，不会发往别处。没有遥测，没有使用分析，没有崩溃上报，没有广告，同步路径上任何位置都没有第三方服务。插件也从不从那台服务器下载或运行代码。
- **那台服务器上的一个账号，由你自己创建。** 第一台设备使用服务器首次启动时写下的设置令牌；其余每台设备都从一台已经在同步的设备上配对而来。你的 Obsidian 账号在这里不起任何作用。
- **Obsidian 和 GitHub，只用于安装和更新。** Obsidian 自己从这个代码仓库的 GitHub Releases 下载 `main.js`、`manifest.json` 和 `styles.css`。每个发布版本还附带一个插件 ZIP 和一份发布清单，供部署服务器的人使用；Obsidian 对这两者都不理会。
- **你的边缘节点，仅当你配置了一个时。** 你在 **Edge service-token headers** 下粘贴的头部会随每个发往上述服务器 URL 的请求一起发送，因为需要它们的那个代理就在通往你服务器的路径上。
- **你仓库的文件列表。** 插件会列出仓库中的每个文件，以判断哪些在同步范围内，读取你所选文件夹中的文件，并写入其他设备改动的内容。隐藏文件夹（`.obsidian`、`.git`）和符号链接的文件夹会被跳过。
- **剪贴板，只写入、从不读取。** 只有 **Pair a new device** 里的 **Copy code** 和 **Copy link** 按钮会写入剪贴板。插件里没有任何地方会读取剪贴板。
- **你的浏览器，当你要打开控制面板时。** **Open dashboard** 会在你的浏览器里打开一个登录链接，而且仅当该链接位于你自己服务器的源上时才会打开。
- **Obsidian 的密钥存储。** 仓库密钥、设备密钥以及任何边缘节点头部的值都存放在那里，绝不会放在明文的插件数据里。

服务器能看到什么、不能看到什么，写在 [`SECURITY.md`](../../SECURITY.md) 和 [`docs/threat-model.md`](../threat-model.md) 里。

## 五步完成同步

本次发布验证走的就是这条路径：从一个空仓库，到两台设备保持同步。这五步都假设你自己的服务器已经在运行，那正是下面一节的内容；每一步在快速上手里都写成了完整版本。

1. **从第三方插件里安装。** 在设置 → 第三方插件 → 浏览中搜索 **Self Hosted Private Sync**，选择安装，然后启用 —— 和其他每一个 Obsidian 插件的安装方式一样，在每个平台上都如此。

   ![Obsidian 的第三方插件浏览界面，显示 Self Hosted Private Sync 及其安装按钮](../captures/01-install-from-directory.png)

2. **把它指向你的服务器并完成设置。** 打开插件的设置页，把 **Server URL** 设为你自己的服务器，选择这台设备要同步哪些文件夹，然后把你的设置令牌粘贴到 **First-time setup** 下。

   ![插件设置页滚动到文件夹选择、Pairing 行以及 First-time setup 的令牌字段处](../captures/02-first-time-setup.png)

3. **保存好恢复短语。** 设置过程会在这台设备上生成仓库密钥，并一次性显示一段 24 个单词的短语：把它抄下来，保存在这台设备之外的地方，因为服务器只保存密文，无法替你恢复仓库。

   ![首次设置之后显示的恢复短语对话框，其中的单词已做模糊处理](../captures/03-recovery-phrase.png)

4. **用一次性验证码配对第二台设备。** 在第一台设备上运行 **Pair a new device**，十分钟之内在第二台设备上输入它显示的验证码，然后按名称批准这台设备 —— 仓库密钥在传输时由一个服务器永远看不到的配对密钥加密。

   ![第一台设备上的 Pair a new device 对话框，其中的一次性验证码已做模糊处理](../captures/04-pair-a-new-device.png)

5. **在任意一台设备上编辑，看着它落地。** 在一台设备的笔记里打字，几秒钟内它就会出现在另一台设备上，两个方向都是如此，同时状态栏会显示同步正在做什么。

   ![那篇临时笔记里带着两台设备各自的改动，同步状态栏清晰可见](../captures/05-sync-both-ways.png)

控制面板的设备列表和它的吊销按钮在[查看你的设备](../daily-use.md#see-your-devices)中有说明，而 [docs/validation-runs/2026-09-14.md](../validation-runs/2026-09-14.md) 记录的 1.0.0 设备验证并没有测试它们。

## 开始同步

最短的正确路径：一台属于你的机器运行服务器，每台设备通过 HTTPS 访问它，每台设备配对一次。登录 Obsidian 在这里不授予任何权限；唯一的账号就是你服务器上的那个。

### 1. 启动服务器

有两种启动方式。两者运行的都是发布者签名过的那份字节：先验证签名，从验证过的输出中读取摘要，再运行那个摘要。`v1.0.6` 是撰写本页时所针对的发布版本；请使用你正在安装的那个发布版本的标签。

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**还没有 HTTPS？** `deploy/compose` 会让服务器运行在它自己的 TLS 终止点（Caddy）后面，可以在任何网络里，不需要域名，也不需要在任何人那里开账号。在这个代码仓库的一份检出中执行：

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` 是你的设备将要输入的名称。它只需要在你自己的网络里能解析。`OBSYNC_BIND_ADDRESS` 是这台主机上用来发布 80 和 443 端口的地址：绑定地址限制的是目的接口，而不是来源，所以决定谁能访问它的是你的防火墙。在你作出选择之前，Compose 拒绝启动。两者都在[运行服务器](../server.md)中有说明。

**机器前面已经有 HTTPS 了**，来自一个反向代理或一条你信任的隧道？那就运行裸服务器。它在 8080 端口上使用普通 HTTP，由你的终止点转发给它：

```sh
docker volume create obsync-blobs
docker volume create obsync-journal
docker run -d --name obsync -p 127.0.0.1:8080:8080 \
  -v obsync-blobs:/data/blobs -v obsync-journal:/data/journal \
  -e OBSYNC_BLOBS_CAPACITY=250GiB -e OBSYNC_JOURNAL_CAPACITY=4GiB \
  -e OBSYNC_PUBLIC_URL=https://sync.example.org \
  ghcr.io/snaraj/obsync@sha256:<the digest cosign just verified>
```

### 2. 读取设置令牌

首次启动时，服务器会铸造一个设置令牌，并把它写入自己的日志卷，权限 0600，绝不会打印到日志输出里。这个令牌只用来创建一次你的账号，此后在服务器的整个生命周期内一直是控制面板的恢复登录方式：请像对待恢复短语一样小心保管它。直接从容器里读取它，不需要任何辅助镜像。在 Compose 路径上：

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

在裸服务器路径上：

```sh
docker cp obsync:/data/journal/v1/setup-token - | tar -xO
```

### 3. 信任证书，每台设备一次（Compose 路径）

Caddy 用它首次启动时生成的证书颁发机构签发了这张证书，所以每台设备都需要被告知一次去信任这个机构。导出根证书：

```sh
docker cp obsync-caddy-1:/data/caddy/pki/authorities/local/root.crt - | tar -xO > obsync-root.crt
```

在每台设备上安装 `obsync-root.crt`。macOS、Windows、Linux、iOS 和 Android 的具体步骤见[信任证书颁发机构，每台设备一次](../server.md#trust-the-certificate-authority-once-per-device)。在 iOS 上，信任这张证书是安装之后的第二个开关。

### 4. 设置第一台设备

1. 设置 → 第三方插件 → 浏览 → **Self Hosted Private Sync** → 安装 → 启用。
2. 在插件的设置里，把 **Server URL** 设为你的服务器，端口不是 443 时要带上端口：`https://sync.example.org`。

   ![插件的设置页：Server URL 字段里填着一个示例主机名，边缘节点头部输入框，以及带有 Check 和 Open dashboard 按钮的 Connection 行](../assets/settings-server.png)

3. 现在就选择 **Whole vault** 或 **Selected folders only**。设备一旦同步过，它的选择范围就只能缩小。
4. 把设置令牌粘贴到 **First-time setup** 下，然后选择 **Set up**。把 24 个单词的恢复短语抄下来，不要留在这台设备上。

   ![设置页的 This device 区域：带有 Pair this device 和 Pair a new device 的 Pairing 行，带有 Setup token 字段和 Set up 按钮的 First-time setup 行，以及 Vault key 行](../assets/settings-setup.png)

### 5. 配对第二台设备

1. 在那台设备上安装并启用插件，设置相同的 **Server URL**，并选择它要同步的文件夹。
2. 在第一台设备上运行 **Pair a new device**。它会显示一个十分钟内有效的验证码。

   ![第一台设备上的 Pair a new device 对话框，验证码已做模糊处理，带有 Copy code 和 Copy link 按钮以及 Waiting for the new device 这一行](../assets/pair-new-device.png)

3. 在第二台设备上打开 **Pair this device**，粘贴验证码，然后选择 **Pair**。

   ![第二台设备上的 Pair this device 对话框，其中有空的 Pairing code 字段和 Pair 按钮](../assets/pair-this-device.png)

4. 回到第一台设备，按名称批准这台新设备。在任意一台上编辑一篇笔记；几秒钟内它就会出现在另一台上。

   ![第一台设备询问是否按名称批准这台新设备，带有 Approve 和 Reject 按钮](../assets/pair-approve.png)

   ![第二台设备显示着在第一台设备上写下的那篇笔记，状态栏显示 obsync idle](../assets/first-sync.png)

整个配对过程，一段简短的循环动画：

![动画：配对验证码在第一台设备上显示，粘贴到第二台设备上，在第一台设备上获得批准，然后第一篇笔记到达第二台设备](../assets/pairing.gif)

手机截图还没有收进这个代码仓库；它们要在维护者自己的设备上拍摄，等某次验证把它们记录下来之后再补充进来。

每一步的完整版本，包括每个界面要求你做什么以及为什么：[快速上手](../quickstart.md)。

**只想在一台电脑上试试？** 在电脑上，插件也接受普通的 `http://` 地址，所以 `http://127.0.0.1:8080` 不需要终止点就能访问上面那台裸服务器。手机上不行：iOS 和 Android 上的 Obsidian 拒绝普通 HTTP。

## 进阶：Cloudflare

参考部署**没有公开主机名**。一条 Cloudflare Tunnel 把服务器的私有网络连到 Cloudflare，一条私有路由告诉 Cloudflare 哪些地址在这条隧道后面，每台设备上的 Cloudflare One 客户端把服务器 URL 带到那里。互联网上什么都访问不到，大体量首次同步也不会经由公开主机名代理。另一种方式 —— 在 Cloudflare Access 背后的公开主机名，配合 **Edge service-token headers** 里的一个服务令牌和服务器上的 `OBSYNC_EDGE=cloudflare` —— 同样受支持。两种方式的分步说明见 [Cloudflare](cloudflare.md)。

## 访问你服务器的其他方式

每种方式一行，不展开教程。无论你选哪一种，插件都需要 HTTPS，而且证书要被每台设备信任，服务器自身则在那个终止点后面继续使用普通 HTTP。

- **只用局域网。** 上面的 Compose 路径，只能在家里访问。最简单；外出时无法同步。
- **WireGuard。** 你自己通回家庭网络的 VPN。最快，而且完全属于你；你要在每台设备上带一份对等端配置，并保持一个端点可达。
- **Tailscale。** 一个托管的 WireGuard 网状网络，带有自己的名称体系。设备上要做的配置最少；由第三方来协调这个网状网络，它的套餐限额需要你自己去读。
- **带自动 TLS 的反向代理**，例如架在公开名称上的 Caddy。你会得到一张公开受信任的证书和一个固定地址；但服务器从此可以从互联网访问，而这个代理及其更新要由你自己维护妥当。
- **Cloudflare Tunnel。** 见上文。不需要入站端口；路径上有一家服务商，带着它自己的条款。

无论你选哪一种，外出的设备都需要这些东西（路由、名称、证书、iOS 的本地网络提示、防火墙）：[从局域网之外访问它](../server.md#reaching-it-from-outside-your-lan)。

## 故障排查

| 症状 | 可能的原因 | 首先试什么 |
| --- | --- | --- |
| `obsync: offline` | 设备访问不到服务器 URL | 在同一台设备的浏览器里打开这个 URL；检查端口、HTTPS 和路由 |
| 电脑在同步，手机却连不上 | 手机上没有信任这张私有证书 | 安装根证书；在 iOS 上还要在"证书信任设置"里把它打开 |
| `401 stale_timestamp` | 某个时钟偏差超过 300 秒 | 在设备或服务器上打开自动对时 |
| `403 device_pending` | 还没有人批准这台设备 | 在你发起配对的那台设备上按名称批准它 |
| 某个文件始终没有到达 | 它在文件夹选择之外，或者超过了手机的大小上限 | 检查 **Sync folders on this device**；在手机上运行 **Show remote-only files** |

其他所有症状、所有错误码，以及如何收集一份值得发出去的报告：[故障排查](../troubleshooting.md)。

## 文档

| 页面 | 它回答什么 |
| --- | --- |
| [快速上手](../quickstart.md) | 第一台设备和第二台设备，每一步的完整说明 |
| [运行服务器](../server.md) | Docker、带 Caddy 的 Compose、证书、备份、从局域网之外访问 |
| [Cloudflare](cloudflare.md) | 带私有路由的隧道加 Cloudflare One 客户端，或者 Access 背后的公开主机名 |
| [Kubernetes](../../chart/README.md) | 用签名的 Helm chart 安装服务器 |
| [日常使用](../daily-use.md) | 命令、状态栏、什么会同步什么不会、恢复某个版本、控制面板 |
| [设置](../settings.md) | 每一项设置、它的默认值，以及什么时候该改它 |
| [故障排查](../troubleshooting.md) | 症状、原因、修复办法，以及如何收集报告 |
| [冲突](../conflicts.md) | 冲突副本是什么，以及该拿它怎么办 |
| [恢复](../recovery.md) | 设备丢失、服务器丢失、服务器搬家、令牌轮换 |
| [安装与更新](../community-plugin.md) | Obsidian 的插件目录、更新、凭证保管、上架审核 |
| [威胁模型](../threat-model.md) | 什么受到防护，什么没有 |
| [控制面板的威胁模型](../security/dashboard.md) | 会话、登录、吊销、残余风险 |
| [架构](../architecture.md) | 整个系统是怎么搭起来的，以及每一个环境变量 |
| [协议](../protocol.md) | 插件与服务器之间的通信约定 |
| [存储](../storage.md) | 卷、持久性、保留、清理，以及每一种拒绝 |
| [验证](../validation.md) | 设备验证计划，以及"就绪"意味着什么 |
| [发布](../release.md) | 一次发布如何切出、签名和审计 |
| [翻译](../translations.md) | 这些指南有哪些语言版本，以及如何保持更新 |
| [`CHANGELOG.md`](../../CHANGELOG.md) | 每个版本改了什么 |
| [`SECURITY.md`](../../SECURITY.md) | 安全姿态、受支持的版本，以及如何报告漏洞 |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | 如何参与这个代码仓库的开发 |

## 问题、缺陷与安全

- **有疑问，或者不确定某件事是不是缺陷：** [Discussions](https://github.com/snaraj/obsync/discussions)。
- **确实是缺陷：** 用缺陷报告模板[新建一个 issue](https://github.com/snaraj/obsync/issues/new/choose)，并附上[故障排查](../troubleshooting.md)里说明的那份报告。不要包含任何令牌、任何恢复短语，也不要包含任何你不愿意公开的地址。
- **疑似漏洞：** 请私下通过 [`SECURITY.md`](../../SECURITY.md) 报告 —— 绝不要发成公开 issue。

## 许可证

MIT。见 [`LICENSE`](../../LICENSE)。
