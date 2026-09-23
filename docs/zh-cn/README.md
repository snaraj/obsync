> 本译文以[英文原文](../../README.md)为准。英文版是规范版本；命令、参数、URL 和占位符保持英文原样，未作改动。

<img src="../../brand/obsync-icon-256.png" alt="obsync 图标：两个相互扣合的圆环" width="96" height="96">

# Self Hosted Private Sync

为 [Obsidian](https://obsidian.md) 提供的自托管、端到端加密的实时同步：一个由你自己运行、没有任何依赖的 Rust 服务器，内置控制面板，再加上这个插件。文件不限大小，支持 Obsidian 的每一个平台，无需订阅，不经第三方。

在 Obsidian 1.13.0 或更新的版本中，从设置 → 第三方插件 → 浏览里搜索 **Self Hosted Private Sync**（插件 ID `obsync-private-sync`）来安装。

> [!IMPORTANT]
> - 它同步到的是**你自己**运行的服务器：没有托管服务，也不需要在别处开账号。
> - 请先备份你的仓库；24 个单词的恢复短语要保存在生成它的那台设备之外的地方。
> - 绝不要在同一个仓库上让它和另一套同步方案（Obsidian Sync、云盘文件夹、另一个插件）一起运行。
> - 这是年轻的软件：请阅读你所用版本在 [`CHANGELOG.md`](../../CHANGELOG.md) 里对应的条目，更新每一台设备，并弄清每次[验证运行](../validation-runs/)覆盖了什么。

## 这个插件会访问什么

- **只有你自己的服务器，没有别的。** 每个请求都发往你填写的 **Server URL**；没有遥测，没有第三方。
- **那台服务器上的一个账号**，由设置令牌创建；你的 Obsidian 账号在这里不起任何作用。
- **GitHub Releases，经由 Obsidian**，用于安装和更新；发布里多出来的附件 Obsidian 不予理会。
- **你仓库的文件列表**，用来判断同步什么；隐藏文件夹（`.obsidian`、`.git`）和符号链接的文件夹会被跳过。
- **剪贴板，只写入**，只有 **Pair a new device** 里的 **Copy code** 和 **Copy link** 会写，从不读取。

服务器能看到什么、不能看到什么：[`SECURITY.md`](../../SECURITY.md) 和[威胁模型](../threat-model.md)。

## 开始同步

五个步骤，从零到两台设备保持同步。`v1.0.6` 是撰写本页时所针对的发布版本；请使用你正在安装的那个标签。

### 1. 启动服务器

先验证签名，再严格按它打印出的那个摘要运行：

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

最简单的路径是在这个代码仓库的一份检出里用 Compose 加 Caddy：在任何网络里都有 HTTPS，不需要域名，也不需要在任何地方开账号。

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` 是你的设备将要输入的名称，它只需要在你自己的网络里能解析。`OBSYNC_BIND_ADDRESS` 是发布 80 和 443 端口所用的地址：绑定地址限制的是目的接口，而不是来源，所以决定谁能访问它的是你的防火墙。在你作出选择之前，Compose 拒绝启动。

前面已经有 HTTPS 了，来自一个你信任的代理或隧道？那就改为运行裸服务器：[运行服务器](../server.md)。

### 2. 读取设置令牌

首次启动时，服务器会铸造一个设置令牌，并把它写入自己的日志卷，权限 0600，绝不会打印到日志里。它只用来创建一次你的账号，此后一直是控制面板的恢复登录方式：请像对待恢复短语一样保管它。从容器里读取它：

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

### 3. 信任证书，每台设备一次

Caddy 用它首次启动时生成的颁发机构签发证书，每台设备都必须信任它一次。请导出根证书，并按[运行服务器](../server.md#trust-the-certificate-authority-once-per-device)里各平台的说明安装；在 iOS 上，信任它是安装之后的第二个开关。

### 4. 设置第一台设备

1. 设置 → 第三方插件 → 浏览 → **Self Hosted Private Sync** → 安装 → 启用。
2. 把 **Server URL** 设为你的服务器（`https://sync.example.org`，端口不是 443 时要带上端口），然后选择 **Whole vault** 或 **Selected folders only**；以后只能把范围缩小。

   ![插件的设置页：Server URL 字段里填着一个示例主机名，边缘节点头部输入框，以及带有 Check 和 Open dashboard 按钮的 Connection 行](../assets/settings-server.png)

3. 把设置令牌粘贴到 **First-time setup** 下，选择 **Set up**，然后把 24 个单词的恢复短语抄下来。

   ![设置页的 This device 区域：带有 Pair this device 和 Pair a new device 的 Pairing 行，带有 Setup token 字段和 Set up 按钮的 First-time setup 行，以及 Vault key 行](../assets/settings-setup.png)

### 5. 配对第二台设备

1. 在那台设备上安装插件，填写相同的 **Server URL**；在第一台设备上运行 **Pair a new device**，得到一个十分钟内有效的验证码。

   ![第一台设备上的 Pair a new device 对话框，验证码已做模糊处理，带有 Copy code 和 Copy link 按钮以及 Waiting for the new device 这一行](../assets/pair-new-device.png)

2. 在第二台设备上打开 **Pair this device**，粘贴验证码，然后选择 **Pair**。
3. 回到第一台设备，按名称批准它。在任意一台上编辑一篇笔记；几秒钟内它就会出现在另一台上。

   ![第一台设备询问是否按名称批准这台新设备，带有 Approve 和 Reject 按钮](../assets/pair-approve.png)

![动画：配对验证码在第一台设备上显示，粘贴到第二台设备上，在第一台设备上获得批准，然后第一篇笔记到达第二台设备](../assets/pairing.gif)

只想在一台电脑上试试？在电脑上，`http://127.0.0.1:8080` 就能访问裸服务器；iOS 和 Android 上的 Obsidian 拒绝普通 HTTP。

手机截图还没有收进这个代码仓库；它们要在维护者自己的设备上拍摄，等某次验证把它们记录下来之后再补充进来。

每一步的完整版本：[快速上手](../quickstart.md)。

## 进阶：Cloudflare

参考部署没有公开主机名：一条 Cloudflare Tunnel 加一条私有路由通到服务器所在的网络，每台设备上的 Cloudflare One 客户端把服务器 URL 带到那里。在 Cloudflare Access 背后使用公开主机名，配合 **Edge service-token headers** 里的一个服务令牌和 `OBSYNC_EDGE=cloudflare`，同样可行。两种方式的分步说明见 [Cloudflare](cloudflare.md)。

## 访问你服务器的其他方式

无论你选哪一种，插件都需要 HTTPS，而且证书要被每台设备信任；服务器本身则在那个终止点后面继续使用普通 HTTP。

- **只用局域网。** 上面的 Compose 路径，只能在家里访问；外出时无法同步。
- **WireGuard。** 你自己通回家庭网络的 VPN：最快，而且完全属于你；每台设备上都要有一份对等端配置。
- **Tailscale。** 一个托管的 WireGuard 网状网络：配置最少；由第三方来协调，按它套餐的条款。
- **带自动 TLS 的反向代理**，例如架在公开名称上的 Caddy：可以从互联网访问，打补丁的事由你自己负责。
- **Cloudflare Tunnel。** 见上文。不需要入站端口；路径上有一家服务商，按它自己的条款。

外出的设备需要什么（路由、名称、证书、防火墙、iOS 的本地网络提示）：[从局域网之外访问它](../server.md#reaching-it-from-outside-your-lan)。

## 故障排查

| 症状 | 可能的原因 | 首先试什么 |
| --- | --- | --- |
| `obsync: offline` | 设备访问不到服务器 URL | 在那台设备的浏览器里打开这个 URL；检查端口、HTTPS 和路由 |
| 电脑在同步，手机却连不上 | 手机上没有信任这张私有证书 | 安装根证书；在 iOS 上还要在"证书信任设置"里把它打开 |
| `401 stale_timestamp` | 某个时钟偏差超过 300 秒 | 在设备或服务器上打开自动对时 |
| `403 device_pending` | 还没有人批准这台设备 | 在你发起配对的那台设备上按名称批准它 |
| 某个文件始终没有到达 | 它在文件夹选择之外，或者超过了手机的大小上限 | 检查 **Sync folders on this device**；在手机上运行 **Show remote-only files** |

其他所有症状和错误码，以及如何上报：[故障排查](../troubleshooting.md)。

## 文档

[快速上手](../quickstart.md) · [运行服务器](../server.md) · [Cloudflare](cloudflare.md) · [日常使用](../daily-use.md) · [设置](../settings.md) · [故障排查](../troubleshooting.md) · [恢复](../recovery.md) · [更新日志](../../CHANGELOG.md)

其余全部内容：[docs/README.md](../README.md)。

## 问题、缺陷与安全

- **有疑问，或者不确定某件事是不是缺陷：** [Discussions](https://github.com/snaraj/obsync/discussions)。
- **确实是缺陷：** [新建一个 issue](https://github.com/snaraj/obsync/issues/new/choose)，并附上[故障排查](../troubleshooting.md)里说明的那份报告；不要包含令牌、恢复短语，也不要包含任何你不愿意公开的地址。
- **疑似漏洞：** 请私下通过 [`SECURITY.md`](../../SECURITY.md) 报告，绝不要发成公开 issue。

## 许可证

MIT。见 [`LICENSE`](../../LICENSE)。
