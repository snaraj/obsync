> 本译文以[英文原文](../../README.md)为准。英文版是规范版本；命令、参数、URL 和占位符保持英文原样，未作改动。

<img src="../../brand/obsync-icon-256.png" alt="obsync 图标：两个相互扣合的圆环" width="96" height="96">

# Self Hosted Private Sync

为 [Obsidian](https://obsidian.md) 提供的自托管、端到端加密的实时同步。你的笔记通过你自己运行的服务器同步。笔记、附件和文件名都在你的设备上加密，服务器永远拿不到密钥。插件在 Obsidian 能运行的每个平台上都能工作，桌面端和移动端都一样。无需订阅，也不需要在别处开账号。

**遇到问题？→ [故障排查](https://snaraj.github.io/obsync/troubleshooting/)（英文）**

## 按需查找

每一页也都在[文档站点](https://snaraj.github.io/obsync/)（英文）上。

### 使用 obsync

| 我想要… | 去看 |
| --- | --- |
| 选择设备连接服务器的方式 | [选择你的部署方式](../setup.md) |
| 在家庭网络里完成全部设置，并看到手机上的每个界面 | [同一网络，逐步操作](../same-network.md) |
| 安装插件 | [安装插件](../community-plugin.md) |
| 设置第一台设备 | [快速开始](../quickstart.md) |
| 配对一部手机或另一台电脑 | [配对你的手机](../quickstart.md#pair-your-phone) |
| 了解状态图标和各个命令的含义 | [日常使用](../daily-use.md)和[读懂状态栏](../troubleshooting.md#reading-the-status-bar) |
| 找回一条笔记的旧版本 | [恢复保留的版本](../daily-use.md#restore-a-retained-version) |
| 了解某个设置项的作用 | [设置](../settings.md) |
| 处理冲突副本 | [冲突](../conflicts.md) |
| 解决问题 | [故障排查](../troubleshooting.md) |
| 丢失设备后重新进入 | [恢复](../recovery.md) |
| 把仓库迁移到另一台服务器 | [把这个仓库迁移到另一台服务器](../recovery.md#moving-this-vault-to-a-different-server) |

### 运行服务器

| 我想要… | 去看 |
| --- | --- |
| 用 Docker 或 Compose 运行服务器 | [运行服务器](../server.md) |
| 把它放在我自己的代理（Caddy、nginx、Traefik、HAProxy）后面 | [已经有 TLS 终止点](../server.md#already-have-a-tls-terminator-docker) |
| 不用容器，在 systemd 下运行 | [静态二进制文件](../server.md#without-a-container-the-static-binary) |
| 在 Kubernetes 上运行服务器 | [Kubernetes](../kubernetes.md) 和 [chart 参考](../../chart/README.md) |
| 通过我自己的 VPN 或代理，在外出时访问服务器 | [从局域网外访问](../server.md#reaching-it-from-outside-your-lan) |
| 使用 Cloudflare（可选） | [Cloudflare](cloudflare.md) |
| 在每台设备上信任服务器的证书 | [信任证书颁发机构](../server.md#trust-the-certificate-authority-once-per-device) |
| 了解需要多少内存和磁盘 | [需要多少内存](../server.md#how-much-memory-it-needs)和[存储](../storage.md) |
| 备份服务器 | [备份两个卷](../server.md#back-up-the-two-volumes) |
| 升级服务器 | [按摘要升级](../server.md#upgrade-by-digest) |
| 查看我的设备并吊销其中一台 | [控制面板](../dashboard.md) |
| 清空服务器，从头开始 | [清空服务器](../purge.md) |
| 查看每个版本改了什么 | [`CHANGELOG.md`](../../CHANGELOG.md) |

### 信任与隐私

| 我想要… | 去看 |
| --- | --- |
| 了解这个插件在我的设备和网络上会碰到什么 | [这个插件会访问什么](#这个插件会访问什么) |
| 理解哪些内容被加密、服务器能看到什么 | [威胁模型](../threat-model.md)和[控制面板的威胁模型](../security/dashboard.md) |
| 报告安全问题 | [`SECURITY.md`](../../SECURITY.md) |

### 项目内部

面向贡献者和审阅者：[`CONTRIBUTING.md`](../../CONTRIBUTING.md)、[架构](../architecture.md)、[协议](../protocol.md)、[基准测试](../benchmarks.md)、[设备验证运行](../validation-runs/)，以及[所有页面](../README.md)。

## 安装

![插件设置以 Get started 开头：Setup guide 一行及其 Open the guide 按钮，位于 Server URL 输入框上方](../assets/settings-get-started.png)

从 **设置 → 第三方插件 → 浏览** 安装插件。搜索 **Self Hosted Private Sync**（插件 ID `obsync-private-sync`）。需要 Obsidian 1.13.0 或更新版本。插件设置以设置指南开头，按一下就能打开。

> [!IMPORTANT]
> - 它同步到的是**你自己**运行的服务器：没有托管服务，也不需要在别处开账号。
> - 请先备份你的仓库；24 个单词的恢复短语要保存在生成它的那台设备之外的地方。
> - 绝不要在同一个仓库上让它和另一套同步方案（Obsidian Sync、云盘文件夹、另一个插件）一起运行。
> - 这是年轻的软件：请阅读你所用版本在 [`CHANGELOG.md`](../../CHANGELOG.md) 里对应的条目，更新每一台设备，并弄清每次[验证运行](../validation-runs/)覆盖了什么。

## 开始同步

最短的完整路径，是从本仓库的检出目录，在你自己的网络里使用带 Caddy 的 Compose。它在任何网络上都能提供 HTTPS，不需要域名，也不需要在任何地方开账号。[同一网络，逐步操作](../same-network.md)带着每个界面走完这条路径。把下面的 `vX.Y.Z` 换成你要安装的发布版本，也就是 [Releases 页面](https://github.com/snaraj/obsync/releases/latest)上最新的标签。

**1. 验证镜像。** 然后原样运行验证打印出的摘要：

```sh
cosign verify ghcr.io/snaraj/obsync:vX.Y.Z \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**2. 启动服务器：**

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` 是你的设备要填写的名称。它只需要在你自己的网络里能解析。`OBSYNC_BIND_ADDRESS` 是发布 80 和 443 端口的地址：绑定地址限制的是目标接口，而不是来源，所以谁能访问它由你的防火墙决定。在你做出选择之前，Compose 会拒绝启动。

**3. 读取设置令牌。** 首次启动时，服务器会生成一个设置令牌，以 0600 权限写入它的 journal 卷，且从不记录到日志里。它只用来创建一次你的账号，之后仍是控制面板的恢复登录方式。请像保管恢复短语一样保管它：

```sh
docker exec obsync-obsync-1 obsyncd setup-token
```

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

**4. 设置每台设备。** 信任一次服务器的证书（[方法](../server.md#trust-the-certificate-authority-once-per-device)）。安装插件，然后按[快速开始](../quickstart.md)操作：先设置第一台设备，再配对其他设备。

前面已经有来自你信任的代理或隧道的 HTTPS？那就改为运行[裸服务器](../server.md#already-have-a-tls-terminator-docker)。

## 这个插件会访问什么

- **只有你自己的服务器，没有别的。** 每个请求都发往你填写的 **Server URL**；没有遥测，没有第三方。
- **那台服务器上的一个账号**，由设置令牌创建；你的 Obsidian 账号在这里不起任何作用。
- **GitHub Releases，经由 Obsidian**，用于安装和更新；发布里多出来的附件 Obsidian 不予理会。
- **你仓库的文件列表**，用来判断同步什么；隐藏文件夹（`.obsidian`、`.git`）和符号链接的文件夹会被跳过。
- **剪贴板，只写入**，只有 **Pair a new device** 里的 **Copy code** 和 **Copy link** 会写，从不读取。
- **你的浏览器，在你要求打开设置指南时。** 项目的指南会在浏览器里打开；插件本身什么也不发送。

服务器能看到什么、不能看到什么：[`SECURITY.md`](../../SECURITY.md) 和[威胁模型](../threat-model.md)。

## 版本

LATEST 版本是 [Releases 页面](https://github.com/snaraj/obsync/releases/latest)上最新的标签，也是 Obsidian 安装和更新到的版本。`main` 是 EDGE：已经合并但尚未发布的工作，面向从源码构建的人。没有 beta 渠道，也没有预发布标签。更新日志的 Unreleased 部分就是 EDGE 的记录。

## 问题、缺陷与安全

- **有疑问，或者不确定是不是缺陷：** [Discussions](https://github.com/snaraj/obsync/discussions)。
- **缺陷：** 附上[故障排查](../troubleshooting.md#how-to-collect-a-report)里描述的报告，[提交一个 issue](https://github.com/snaraj/obsync/issues/new/choose)。不要写入任何你不愿公开的令牌、短语或地址。
- **疑似漏洞：** 通过 [`SECURITY.md`](../../SECURITY.md) 私下报告，不要提交公开 issue。

## 许可证

MIT。参见 [`LICENSE`](../../LICENSE)。
