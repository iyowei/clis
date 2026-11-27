# @iyowei/wake-cli

[![CI & Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/@iyowei/wake-cli)](https://www.npmjs.com/package/@iyowei/wake-cli)
[![npm downloads](https://img.shields.io/npm/dm/@iyowei/wake-cli)](https://www.npmjs.com/package/@iyowei/wake-cli)
![node](https://img.shields.io/node/v/%40iyowei%2Fwake-cli)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fclis%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

[English](README.md) | **中文**

`wake` 是一个跨平台远程开机命令行工具 (`Wake-on-LAN`, 简称 `WoL`), 零第三方运行时依赖。不管你和目标电脑在不在同一个路由器下面, 它都能帮你把睡着或关机的电脑叫醒, 并自动等到对方 SSH / 指定端口通了才返回。

如果你要在代码或脚本里直接调用开机逻辑, 可以安装底层 API 包 [`@iyowei/wake`](https://www.npmjs.com/package/@iyowei/wake)。

## 它解决什么问题

电脑关机或深度睡眠后, 操作系统和 IP 往往都不在线, 但主板上的网卡还在低功耗待命。只要向网卡所在的局域网发送一段带着它 **MAC 地址** (网卡出厂自带的 12 位十六进制物理编号, 形如 `00:11:22:33:44:55`) 的 102 字节广播数据包 (俗称"魔术包"), 网卡认出自己的编号就会给主板通电开机。

常见的使用场景有两种:

1. **同一局域网直接开机**: 你的笔记本和目标主机连着同一个路由器。直接跑一条 `wake`, 它会避开本机上的 VPN / Docker 虚拟网卡, 从真实物理局域网口把广播发出去。
2. **人在外网或隔着 WireGuard / VPN 开机**: 路由器默认不会把广播包转发进另一个网段, 而且 VPN 隧道接口经常会把本机广播吞掉。这时候可以在目标主机所在的家里/办公室找一台**长期开着的小主机或 NAS** (比如树莓派、不关机的 Mac) 当**跳板机** (命令行选项里叫 `--relay`): 你的电脑通过 `SSH` 远程登录跳板机, 让跳板机在本地局域网代发开机广播。如果填了多台跳板机, 第一台连不上会自动换下一台。

## 准备目标电脑

动手之前, 先确认你要唤醒的那台电脑开启了网络唤醒:

1. 进入主板 BIOS 打开 `Power On By PCI-E` (不同主板可能叫 `Wake on LAN` 或 `Resume by PCI-E Device`), 同时关闭会把待机网卡断电的 `ErP Ready`。
2. 记下目标主机联网网卡的 **MAC 地址** 和局域网 IP (可选, 用于唤醒后检测是否顺利进了系统):
   - Windows: 在命令行跑 `ipconfig /all`, 找到当前网卡的「物理地址」;
   - macOS: 跑 `ifconfig`, 看 `en0` / `en1` 下的 `ether`;
   - Linux: 跑 `ip link`, 看 `link/ether`。
3. 如需让 `wake` 自动等到系统就绪, 目标主机建议开启 SSH (端口 `22`) 或任意可供 TCP 连接探测的端口。

## 安装

### 1. 一键脚本安装 (macOS / Linux / Windows, 无需预装 Node / Bun)

脚本会自动检查本机现有的 `bun` 或 `node >= 22.18.0`; 都没有时会在 `~/.local/share/clis/runtime` 安装一份不污染系统的私有 Bun:

```shell
# macOS / Linux (curl)
curl \
  -fsSL \
  https://raw.githubusercontent.com/iyowei/clis/main/packages/wake-cli/install.sh \
  | sh

# 国内镜像加速
curl \
  -fsSL \
  https://gh-proxy.com/https://raw.githubusercontent.com/iyowei/clis/main/packages/wake-cli/install.sh \
  | sh \
    -s -- \
    --installer-url \
      https://gh-proxy.com/https://raw.githubusercontent.com/iyowei/clis/main/install.sh \
    --bun-url \
      https://gh-proxy.com/https://github.com/oven-sh/bun/releases/latest/download \
    --registry \
      https://registry.npmmirror.com
```

### 2. 全局安装 (已装 npm / bun)

```shell
npm install -g @iyowei/wake-cli
bun install -g @iyowei/wake-cli
```

### 3. 免安装试跑

```shell
bunx @iyowei/wake-cli --help
npx @iyowei/wake-cli --help
```

## 场景一: 同局域网直接开机

如果控制端和目标主机都在家里同一个路由器下, 三步就能用起来。

```shell
# 1. 打开交互向导 (会扫描本机 ARP 表, 近期通信过的机器可直接选编号带入 IP 和 MAC)
wake init

# 或者一条命令非交互写入配置 (将 workstation 设为默认开机设备)
wake init --name workstation --mac 00:11:22:33:44:55 --host 192.0.2.10 --default --yes

# 2. 唤醒默认电脑并等它的 22 端口连通
wake

# 3. 不写配置, 临时按 MAC 开机 (加 --no-wait 发完包立刻退出)
wake --mac 00:11:22:33:44:55 --host 192.0.2.10
wake --mac 00:11:22:33:44:55 --no-wait
```

## 场景二: 外网借跳板机开机 (含 `.ssh/config` 零基础示例)

如果你在公司、咖啡店或连着 WireGuard / VPN, 直接广播过不去路由器, 需要让家里一台常开主机做跳板代发包。**跳板机链路走无密码弹窗的 `SSH` 登录** (`BatchMode=yes`), 这样才不会卡在密码提示上。

哪怕你以前没配过 SSH 远程登录, 照下面 5 步复制就能通:

### 第 1 步: 在你的电脑上生成 SSH 密钥

如果之前生成过 `~/.ssh/id_ed25519.pub`, 直接跳到第 2 步:

```text
ssh-keygen -t ed25519 -C "my-laptop"
# 一路按回车使用默认保存路径即可
```

### 第 2 步: 把公钥放进跳板机 (配免密登录)

把你的电脑公钥放到跳板机 (假设跳板机用户名是 `ops`, 内网/VPN IP 是 `192.0.2.50`) 里, 以后登录它就不用每次输入密码:

- **macOS / Linux**:

```text
ssh-copy-id ops@192.0.2.50
```

- **Windows (PowerShell)**:

```text
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh ops@192.0.2.50 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

### 第 3 步: 在 `~/.ssh/config` 给跳板机起个短别名

配置 `~/.ssh/config` (Windows 上路径是 `C:\Users\<用户名>\.ssh\config`) 的好处是: 你只要写一个顺口的名字 `home-pi`, 不用在每条 `wake` 命令里背 IP、用户名和端口。如果家里有第二台常开设备 (比如另一台一直开着的 Mac), 可以顺手再配一个备用别名 `backup-mac`:

```text
Host home-pi
  HostName 192.0.2.50
  User ops
  Port 22
  IdentityFile ~/.ssh/id_ed25519

Host backup-mac
  HostName 198.51.100.20
  User ops
  Port 22
  IdentityFile ~/.ssh/id_ed25519
```

配好后, 先在终端试跑一句 `ssh home-pi`. 如果**不用输密码就直接连上了**, 说明 SSH 免密通道没问题。

### 第 4 步: 在跳板机上装 `wake`, 并测试远程能调通

登录进跳板机, 按上面的「安装」章节在跳板机里装好 `wake`, 然后回到你自己常用的电脑上测一条不带交互的非登录式检查命令:

```text
ssh -o BatchMode=yes home-pi "wake --version"
```

只要直接打印出了版本号 (例如 `1.0.0`), 就说明「免密登录 + 远端找得到 `wake`」两件事同时过关。如果提示 `wake: command not found`, 通常是因为 Linux 非交互式 SSH 不会读取 `.bashrc` 里自定义的路径; 把跳板机上的 `wake` 软链进系统默认搜索路径即可:

```text
sudo ln -sf ~/.local/bin/wake /usr/local/bin/wake
```

### 第 5 步: 写入目标配置并用 `doctor` 检查

```shell
# 绑定主备两台跳板机: 先试 home-pi, 连不上自动切 backup-mac (--force 允许更新已有别名)
wake init --name workstation --mac 00:11:22:33:44:55 --host 192.0.2.10 --relay home-pi --relay backup-mac --default --yes --force

# 只读体检: 检查配置文件、本机网卡分类、各跳板机状态与目标是否在线 (不会发开机包)
wake doctor workstation

# 正式远程唤醒
wake workstation
```

## 常用命令与配置文件位置

```shell
# 查看所有已保存设备与默认开机目标
wake list

# 临时绕开跳板机仅本机广播, 或禁掉本机回退只允许走跳板机
wake workstation --local-only
wake workstation --no-local-fallback

# 切换显示语言或在线检查更新
wake lang zh
wake update --check
```

- 配置文件默认位置: POSIX 在 `~/.config/wake/config.json`, Windows 在 `%APPDATA%\wake\config.json` (也可传 `--config <path>` 或设 `WAKE_CONFIG` 环境变量覆盖)。

## 文档入口

- [工程技术文档总索引](https://github.com/iyowei/clis/blob/main/docs/README.md)
- [wake-cli 命令面与退出码契约](https://github.com/iyowei/clis/blob/main/packages/wake-cli/docs/README.md)
- [核心 API 库 (`@iyowei/wake`)](https://github.com/iyowei/clis/blob/main/packages/wake/README.zh-CN.md)
