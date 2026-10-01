# create-clis

[![CI](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/ci.yml)

[English](README.md) | **中文**

从本仓骨架的泛化快照生成一个独立的新 clis 集合仓: 带能力档位与通用词汇, 开箱就是一条全绿的 CI。

> 状态: 尚未发布到 npm registry; npm 徽章随首个发布版本补上。

## 要求

- **运行时**: bun (任意近期版本), 或 node 22.18.0 或更新 (版本下限见包的 `engines` 声明)。
- **免安装**: 生成器无需预先全局安装; 每次运行按需从 registry 解析包。
- **生成物是 bun 工程**: 运行生成器 bun / node 皆可, 但生成出来的项目由 bun 管理 (版本 pin 与依赖安装都走 bun); 默认收尾会执行 `bun install`, `--no-install` 可跳过。

## 使用

```shell
# npm: npm create 约定等价于 npm exec create-clis
npm create clis

# pnpm
pnpm create clis

# bun: bun create clis 即 bunx create-clis
bun create clis

# 也可以直接跑包名
bunx create-clis
```

四个入口等价; 目标目录缺省是当前目录下以项目名命名的子目录:

```shell
# 交互问答: 位置参数是目标目录, 其余变量逐个提问
bunx create-clis my-tool

# 零交互: 全部取默认值
bunx create-clis my-tool --yes

# 经 npm create 调用时, 旗标写在 -- 后面 (这是 npm 生态的既有行为)
npm create clis -- my-tool --tier core
```

无旗标时逐项提问, 方括号内是默认值、回车采用, 答错会说明原因并重问; 给过旗标 (或位置参数) 的字段直接采用、不再提问; `--yes` 则全部取默认值, 全程零交互。

**目标目录**: 已存在且非空直接拒绝 (不做覆盖, 也没有 `--force` 逃生口; 覆盖的风险远大于那点便利); 已存在但为空的目录可用, 文件落进该目录。

失败时打印原因并以非零退出码结束; 写入开始后失败留下的半成品目录会如实指出并保留 (不悄悄清理, 可自行查看或删除)。

## 变量与旗标

五个变量, 与模板的泛化词汇表一一对应:

- **项目名**: 位置参数 (目标目录的 basename) 或 `--name`; 没有默认值, 校验 kebab-case (如 `my-tool`);
- **scope**: `--scope`; 默认不带 (裸包名), 带时以 `@` 开头 (如 `@me`);
- **bin 名**: `--bin`; 默认由项目名派生短形态 (三段及以上取「首段 + 其余段首字母」: `sweep-node-modules` → `sweep-nm`);
- **owner**: `--owner`; 默认取 git 全局 `user.name`;
- **仓库地址**: `--repo`; 默认 `https://github.com/<owner>/<name>`。

其余旗标:

- **`--tier <档>`**: `core` / `standard` / `full` 三选一, 默认 `standard`;
- **`--no-git`**: 跳过 `git init` (默认执行);
- **`--no-install`**: 跳过依赖安装 (默认执行);
- **`--yes`**: 全部取默认值, 零交互;
- **`--help`**: 打印帮助。

经 `npm create` 调用时, 旗标要写在 `--` 后面 (`npm create clis -- --tier core`); 这个 `--` 由 npm 剥离, 是生态的既有行为, 生成器不参与。各变量的取值在收集那一刻就校验 (项目名 kebab-case、bin 名命令行可用、scope / owner / 仓库地址形态), 不合法当场给原因。

## 档位

`--tier` 三选一, 默认 `standard`。三档是减法: `full` 是完整箱, `standard` 是 `full` 减增强档装备, `core` 是 `standard` 再减标准档装备。

- **core**: 工程骨架与发布闭环 (集合里每个仓库都默认全带的那一层);
- **standard** (默认): 再加标准档装备: 多包分层 (工具 + 库)、测试体系、技术债登记册;
- **full**: 再加增强档装备: 转写契约套件 (行为契约 + 金样本语料 + 确定性验收器 + 变异自证) 与它的台账对账闸门 (`lint:coverage`)。机制随模板, 内容要自填: `docs/sweep/protocol/` 下的契约 / 覆盖表 / 语料填上之前, `bun run ci` 会在 `lint:coverage` 与 `conformance:bun` / `conformance:node` 上红, full 档开箱不是全绿 (core 与 standard 是)。

生成物恒为双包集合仓形态 (工具 + 库): 生成器不产出单包仓, 要单包的话生成后自行裁剪。档位只是生成那一刻的装箱单: 它不写进任何配置文件, 之后升降档是手工的按件增删 (裁剪规则见 [capability-tiers.md](../../docs/designs/capability-tiers.md))。

## 生成物

模板是派生出来的, 不是维护出来的: 像依赖锁文件由包管理器生成而不是手抄, 模板由生成器的构建步骤从本仓直接产出; 仓库改了, 下次构建就带上, 不需要人工同步。构建还带一道零残留自检: 模板里不得再出现原项目词汇, 出现即构建失败。

生成物是一份独立的新集合仓, 从落成那一刻起就与本仓无持续关系 (生成即脱离): 生成器不提供对它的升级或同步, 模板之后的演进不回流进已生成的项目。它自带:

- **工程骨架**: workspaces / turbo / 根 tsconfig / 配置族 (oxlint / prettier / editorconfig / gitattributes / gitignorerc / nvmrc / bunfig) / 版本 pin;
- **提交与钩子链**: lefthook + `install-git-hooks` (机器上没有 lefthook 时降级) + `safe-install`;
- **闸门链单源**: `scripts/ci.ts` 是唯一一份步骤清单 (手动全链、pre-push、CI 与 Release 都从它走), `bun run ci` 一条命令跑完全套;
- **发布闭环**: semantic-release 自动发布, 凭据走 OIDC 可信发布 + environment 人工批准, 另有发布凭据预检与逐包发布自证;
- **文档体系**: docs 索引 / designs 最小单元组织 / ADR 模板 / CONTRIBUTING / SECURITY / 行为准则;
- **AI 协作文件**: AGENTS.md 与 `.vscode` 推荐配置;
- **两个示例包**: `<name>-cli` (CLI 薄壳) 与 `<name>` (库), 带一个 greet 最小示例, 整包替换成你自己的工具即可。

生成按固定顺序跑: 收集变量 → 复制快照 → 按档裁剪 → 代入词汇 → 格式化收口 (回到 prettier 稳定态, 也就是产物自己 `format-check` 闸门的前提) → 残留自检 → 收尾 (`git init` 与依赖安装, 默认都执行)。完成后打印 next steps: 进入目录、`bun run ci` 验证全绿、从 `docs/README.md` (文档总索引) 读起, 开始改造。

每个发布出去的版本都先自证过一遍: 拿它生成一个完整项目、装好依赖、把生成物的整套闸门链跑到全绿, 才允许发布。

## 开发

包脚本:

- `bun run build`: 一次产出两份东西: 模板资产 (`assets/template/`, 由骨架清单从本仓构建) 与可执行产物 (`dist/`, 含启动器对账用的清单);
- `bun run verify:release`: 发布前置校验: 干净检出、产物出自本提交、清单自洽、发行面包内文件与白名单相符;
- `bun run heavy-smoke`: 重量级冒烟: 现场生成一个 core 档完整项目, 跑它的整套闸门链, 全绿才算过。

`prepublishOnly` 按序串起三者, 发布出去的版本因此自带一份证明: 它生成的项目是绿的。设计与契约文档 (生成器包设计 / 契约 / 档位 / 快照机制) 都在 [docs/designs/](../../docs/designs/) 下。

---

- 生成器包设计: [scaffold-package.md](../../docs/designs/scaffold-package.md);
- 包级文档入口: [docs/README.md](docs/README.md)。
