# sweep-node-modules-cli

[![CI](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@iyowei/sweep-node-modules-cli)](https://www.npmjs.com/package/@iyowei/sweep-node-modules-cli)
[![npm downloads](https://img.shields.io/npm/dm/@iyowei/sweep-node-modules-cli)](https://www.npmjs.com/package/@iyowei/sweep-node-modules-cli)
![node](https://img.shields.io/node/v/@iyowei/sweep-node-modules-cli)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fsweep-node-modules%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

[English](README.md) | **中文**

工作区级 `node_modules` 清理工具: 一次扫描多个根目录, 把各个项目里的 `node_modules` 连同体积一起列出来, 确认后批量删除, 回收磁盘空间。本 CLI 只是套在 API 包 [`@iyowei/sweep-node-modules`](https://www.npmjs.com/package/@iyowei/sweep-node-modules) 外面的一层薄壳。要在你自己的脚本与工具里直接调用, 请用该包 (用法见该包文档)。

> 分层说明: 单项目清理工具管「进入某个项目, 清它自己的产物」; 本工具管「站在工作区层面, 一次清理很多个项目」。两者分层共存, 见 [ADR 0001](../sweep-node-modules/docs/adrs/0001-workspace-level-cleaner.md)。

## 要求

- 业务逻辑**双运行时**: 有 bun 走 bun, 没有就用 node (功能一致, bun 启动更快)。
- 运行时 API 取最新一代: bun 任意近期版本; node 要能原生直跑 TypeScript 的版本 (源码方式与包方式取同一版本下限; 版本快照与实测记录见 [ADR 0006](../../docs/adrs/0006-dual-runtime-bun-first.md))。
- 零第三方运行时依赖 (只用运行时内置能力)。
- 平台: 目前实际验证过的只有 macOS 与 Linux; Windows 启动器已随包分发, 但还没在真机上验证过 (详见 [ADR 0007](../sweep-node-modules/docs/adrs/0007-platform-portability.md))。

## 安装

三种方式, 按你机器上已有的运行时挑。**每条下的「需要」是硬门槛**:

> **机器上只有 bun、没装 node?** 直接走 ① 或 ③; ② 的全局安装不管用 npm 还是 bun, 都需要 node。

① ② 的包都来自包注册表: 本机如果配了镜像源、镜像还没同步到想装的版本, 可以在命令后临时加 `--registry=https://registry.npmjs.org` 直连官方源。

### ① 免安装 (试用或偶尔用)

```shell
# 机器上有 bun
bunx @iyowei/sweep-node-modules-cli

# 机器上有 node (npx 随 npm 一同安装, 本身就需要 node)
npx @iyowei/sweep-node-modules-cli
```

- **需要**: bun 或 node, 与所选命令对应
- 特点: 零安装; 每次运行会解析一次包
- 注意: `bunx` 与 `npx` 各自依附一个运行时, 不是可互换的通用选项: 只有 bun 的机器没有 `npx`, 只有 node 的机器没有 `bunx`

### ② 包管理器全局安装 (常用推荐)

```shell
npm install -g @iyowei/sweep-node-modules-cli
bun install -g @iyowei/sweep-node-modules-cli
```

- **需要**: **node** (两条命令都要)。npm 本身跑在 node 上; `bun install -g` 生成的是指向入口文件的符号链接, 执行时由系统内核读该文件的 shebang (node) 来决定解释器, 应用层插不上手
- 特点: 装一次后直接敲 `sweep-nm`; 有 bun 时业务逻辑仍优先走 bun

### ③ 从源码 (开发, 或无 node 环境)

**macOS / Linux**:

```shell
# 克隆后进入仓库根 (路径按你的实际位置调整)
cd "<克隆位置>/sweep-node-modules"

chmod +x packages/sweep-node-modules-cli/bin/sweep-nm

# 软链进 ~/.local/bin (通常已在 PATH 中), 启动器会挑选运行时
ln -sf "$PWD/packages/sweep-node-modules-cli/bin/sweep-nm" ~/.local/bin/sweep-nm
```

**Windows** (PowerShell):

```powershell
# 把仓库的 bin 目录加入用户 PATH, 只需一次, 重开终端后生效
# 路径按你的实际克隆位置调整 (启动器靠自身位置定位 src, 故不能把脚本单独复制走)
$bin = "$env:USERPROFILE\tools\sweep-node-modules\packages\sweep-node-modules-cli\bin"
[Environment]::SetEnvironmentVariable(
  'Path',
  [Environment]::GetEnvironmentVariable('Path', 'User') + ";$bin",
  'User'
)
```

> 也可以不经命令行: 在「系统属性 → 环境变量」里把该 `bin` 目录加到用户变量 `Path` 中。

- **需要**: bun 或 node 任一 (启动器是 shell / cmd 脚本, 由系统执行, 不依赖 node); **机器上只有 node 的话**: 克隆下来的代码要先构建一次, 而构建本身需要 bun (`bun install && bun run build`): node 不解析仓库里的路径映射, 没构建过的代码会找不到 API 包的产物
- 特点: 入口最直接; 之后直接敲 `sweep-nm` (Windows 经 `packages\sweep-node-modules-cli\bin\sweep-nm.cmd`)

## 使用

```shell
# 预览: 列出配置中各根目录下所有 node_modules 与体积, 不动手
sweep-nm

# 复核无误后执行删除
sweep-nm --yes

# 连同「疑似安装树」一并删除 (包管理器 / 版本管理器 / 编辑器扩展、家目录隐藏目录、系统数据根名; 默认跳过)
sweep-nm --yes --force

# 临时追加排除(可重复)
sweep-nm --exclude my-kits --exclude url-tool

# 只清理名单命中的目录(可重复, 与配置合并)
sweep-nm --include my-kits

# 查看实际生效的配置文件位置与状态 (来源 / 路径 / 是否存在)
sweep-nm config

# 初始化向导: 交互式生成配置文件
sweep-nm init

# 完整选项表 (亦可 -h)
sweep-nm --help
```

清单顶栏尾部会标注本次实际使用的运行时 (如 `bun 1.4.2`), 只在交互终端显示 (非 TTY 不添噪音)。

## 退出码

`0` 表示成功 (预览与空结果也算); 其余一律 `1` (删除失败 / 整批中止 / 有目标没处理 / 配置损坏或不存在 / 参数错误 / 没有配置时拒绝执行)。

## 配置

配置文件位置随平台走: Windows 是 `%APPDATA%\sweep-node-modules\config.json`, 其余平台是 `~/.config/sweep-node-modules/config.json`; 可以用 `--config` 或环境变量 `SWEEP_NM_CONFIG` 覆盖, 本次实际生效的路径与文件状态, 用 `sweep-nm config` 查看。**写配置要求真实路径**: 配置路径或它的祖先链上有符号链接 (包括 `/tmp`、`/var` 这类系统自带的链接) 时, `sweep-nm init` 会在写盘前拒绝, 并指出链接在哪; 按提示改写成真实路径 (如 `/private/tmp/x`) 即可放行。

```json
{
  "roots": ["/Users/you/workspace", "/Users/you/projects"],
  "exclude": ["my-kits"],
  "include": []
}
```

- `roots`: 扫描根目录, 数量不限; 重复或嵌套的根按真实路径去重。**要删除的话, 根必须是真实路径**: 根本身和它的祖先链上都不能有符号链接 (包括 `/tmp`、`/var` 这类系统自带的链接), 命中就 `--yes` 整批拒绝, 按提示改写成真实路径 (如 `/private/tmp/x`) 即可放行; 只扫描不受这条限制 (根是符号链接也照常扫)。
- `exclude`: 排除名单; 从根往下到 `node_modules` 的任意一级目录名命中就跳过 (排除越多, 删得越少, 安全方向)。**不写这个字段时, 用内置默认名单** (包管理器 / 版本管理器的安装树、编辑器扩展目录、系统与应用数据根, 词表与理由见[设计文档](../../docs/sweep/designs/config-and-initialization.md)「默认排除名单」; 这些名字随平台而异, 一个都没命中也不会告警); 只要把该字段写出来 (哪怕写空数组), 就以你自己的名单为准。
- **疑似安装树默认不参与删除**: 长得像安装树的目标 (如 `~/.bun/install/global/node_modules`、`<版本目录>/lib/node_modules`、编辑器扩展目录、家目录下任意隐藏目录里的 `node_modules`, 或 `Library` / `.local` / `.config` / `.cache` 等系统数据根名下的) 在清单里会带 `疑似安装树: <理由>` 标记, 并保留 `node_modules` 后缀; `--yes` 不删这些 (算作失败, 并给出跳过说明); 要清理得显式加 `--force`, 它只放行这一批目标, 不放宽任何删除安全闸。
- **跨设备的目标默认也不删**: 目标跟它所属的根不在同一个文件系统时 (根下面挂了云盘 / 网络盘 / 容器卷, 而目标落在那一卷上) 同样不删; 清单行尾会标注 `跨设备: 根与目标之间有挂载点` 或 `跨设备: 目标本体即挂载点`。前一种把那个挂载点加进 `roots` 就能照常清理; 后一种 (目标本身就是挂载点) 只能先卸载那个卷; `--force` 不放行这一类。
- `include`: 包含名单 (白名单); 命中才纳入, 判定方式和 `exclude` 一样; 默认或空数组 = 不过滤 (包含越多, 删得越多); 同时被两份名单命中时 `exclude` 优先。名字写错会让结果直接为空, 所以没命中的名字会在 stderr 给出警示。
- 两份名单里出现的 `node_modules` 与 `.git` 都会被剔除: 前者是本工具的目标 (写进排除等于排掉唯一目标, 写进包含则永远零命中), 后者是扫描时一直跳过的目录; 剔除之后 `include` 若是空数组, 同样等于不过滤 (不是「只扫 node_modules」)。
- 首次运行且没有配置: 交互终端下自动进入初始化向导 (扫描根默认家目录); 非交互环境 (脚本等) 以当前工作目录为根并提示, 不询问; 随时可以用 `sweep-nm init` 重进向导。

> 字段定义以[设计文档](../../docs/sweep/designs/config-and-initialization.md)为准。

## 安全防护

删除是这套工具唯一不可逆的动作, 围绕它攒下了一整套防护纪律。下面挑出分量最重的几条; 全量版 (含已知残余风险的诚实账) 见 [安全防护保障](../../docs/sweep/designs/safety-guardrails.md)。

> 这套工具的性格, 一句话: 看不准的时候, 默认不删。

**默认什么都不做。** 预览是默认态, 删除要显式加 `--yes`; 没有配置文件时 `--yes` 被硬拒绝, 零删除; 向导刚写入配置的那一轮强制预览, 即便带了 `--yes` 也只预览。`--force` 只放行「疑似安装树」这一批目标, 不放宽任何删除安全闸。

**删什么, 由名字与归属双重判定。** 只认名字恰好是 `node_modules` 的目录, 且必须落在声明的扫描根之下; 归属按路径层级判定, 不是字符串前缀, `..` 上溯与冒名路径一概拒绝。体积测不到的目标一律不删: 宁可留着, 不猜。两类目标默认拦下: 删了装不回来的「疑似安装树」 (要清理须显式加 `--force`), 与落在另一文件系统上的跨设备目标 (`--force` 同样不放行); 另有一份默认排除名单 (包管理器 / 版本管理器 / 编辑器扩展与 `Library` / `.local` / `.config` / `.cache` / `.claude` 等系统数据根的名字) 挨着就不扫。

**一处不过, 整批不删; 动手前逐级复核。** 只要有一个目标没过检查, 整批一个都不删, 而不是逐条放行; 删除前从根到目标的父目录, 一级一级复核, 半路发现被掉包就停手, 不再往下删 (已经在删的条目会跑完, 并如实报告)。配置的根或它的祖先被换成符号链接时, 删除整批拒绝, 拒绝信息里直接给出改写方向; 系统自带的链接 (`/tmp`、`/var` 这类) 照样会被拦下, 改写成真实路径就放行。

**符号链接: 门槛跟着可逆性走。** 同一份配置, 只读的扫描照常跟进 (根为符号链接照常出清单), 不可逆的删除整批拒绝, 写入 (`init` 写盘) 只要路径上有链接, 就一个字节不落。这个分叉是有意的: 链接的来路判不了, 就不放行不可逆的那一步。

**输出不可伪造。** 一切外部数据 (磁盘上的目录名、命令报错、名单拼写) 进输出前先净化: 剥掉控制字节、折叠换行, 防终端控制序列注入, 也防换行劈出伪造的可信行; 名字被净化改写过的, 行尾会加标注。被跳过的目标带标注留在清单里, 末尾有跳过计数。名单里没命中的名字会在 stderr 告警, 白名单全零命中还点明「结果必为空」; 出错提示里带错误码、人话、目标定位和部分删除的复查提示, 「没删」与「删失败」分开展示。

**分发链路可自证。** 零第三方运行时依赖, 运行过程中不发起任何网络调用; npm 安装的用户拿到的产物, 用之前先和随附清单核对摘要, 对不上就拒收; 发布侧还设了四道闸门: 干净检出、产物出自本次提交、清单自洽、发布包文件白名单; 仓库根目录下散落的文件 (比如 README 的备份) 进不了包。

## 开发

环境准备、常用命令、双运行时验证与提交钩子, 见 [开发指南](../../docs/development.md)。

## 文档

- [工程技术文档总索引](../../docs/README.md)
