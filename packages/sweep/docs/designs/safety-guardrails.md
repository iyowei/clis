# 安全防护保障

> 定位: 面向想深挖的用户与未来维护者的参考文档, 完整记录这套工具的安全防护保障点与内部账目。
> 与 CLI 包 README 的关系: CLI 包 README 的安全防护节从本文裁剪而来 (挑出分量重的条目, 写成面向用户的功能细节); 本文是全量版。
> 权威: 行为语义以包级设计文档 (`packages/sweep/docs/designs/` 与 `packages/sweep-cli/docs/designs/`)、包级 ADR (`0001..0004` / `0007..0008` / `0021..0024`) 与 `packages/sweep/docs/protocol/behavior-contract.md` 的编号条款为准; 本文是面向读者的一份整理稿, 依据都在写作时对照实现核验过。
> 路径约定: 下文「依据」中的 `src/xxx.ts` 为简写。归属 CLI 包 (`packages/sweep-cli/src/`) 的是 `cli.ts` / `cli-commands.ts` / `args.ts` / `render.ts` / `config-summary.ts` / `progress.ts` / `help.ts` / `init.ts` / `init-io.ts` / `migrate-cli.ts` / `outcome.ts`; 其余 (`guard.ts` / `guard-device.ts` / `scan-parallel.ts` / `scan-match.ts` / `scan-roots.ts` / `presets.ts` / `rules.ts` / `trash.ts` / `delete.ts` / `delete-review.ts` / `config.ts` / `config-validate.ts` / `migrate.ts` / `size-du.ts` / `size.ts` / `size-js.ts` / `skip.ts` / `classify.ts` / `stale.ts` / `summary.ts` / `types.ts` / `codes.ts` / `errors.ts` / `scan.ts` / `runtime.ts` / `display.ts` / `sweep.ts`) 归 API 主包 (`packages/sweep/src/`)。

## 目录

- [这份文档怎么读](#这份文档怎么读)
- [A. 防误删](#a-防误删)
- [B. 软链与掉包](#b-软链与掉包)
- [C. 防注入与伪造](#c-防注入与伪造)
- [D. 保守默认](#d-保守默认)
- [E. 透明披露](#e-透明披露)
- [F. 韧性、输入健壮与分发](#f-韧性输入健壮与分发)
- [G. 内部账目](#g-内部账目)
  - [已知残余风险 (诚实账)](#已知残余风险-诚实账)

## 这份文档怎么读

这套工具 (`@iyowei/sweep` / `@iyowei/sweep-cli`, 命令 `sweep`, 演进决策见 [ADR 0021](../adrs/0021-sweep-general-cleaner-evolution.md) ~ [ADR 0024](../adrs/0024-cli-init-migrate-and-summary-display.md)) 在多工作区根下统一识别 6 大技术栈预设的构建/依赖产物、系统元数据垃圾文件与自定义规则目标, 量出体积, 确认后移入系统回收站或批量删除。围绕清理动作, 它攒下了一整套防护纪律: A~F 六组安全保障点, 外加一组面向深度读者与维护者的内部账目 (G 节)。

每条保障点按三要素写:

- **功能承诺**: 它对用户承诺了什么;
- **依据**: 承诺落在哪个实现、哪条契约条款、哪份测试或语料上;
- **边界**: 承诺在哪儿止步, 哪些代价与例外是如实披露的。

边界不是免责声明。这套工具的性格是「看不准的时候, 默认不删」, 边界写在明处, 是因为一条不写边界的承诺不值得信任。

**依据怎么读**: 依据只写到「文件 + 函数 / 契约条款」这一级, 不写行号, 行号随代码漂移, 写进文档即过期。名词对照:

- 实现: 两包 `src/` 下的模块文件 (归属见上「路径约定」); 启动器在 CLI 包 `bin/`; 发布脚本在 CLI 包 `scripts/`, 转写套件在仓库根 `scripts/transcription/`。
- 契约: `packages/sweep/docs/protocol/behavior-contract.md` 的编号条款 (BC / OF / EC 三族); 语料名指 `packages/sweep/docs/protocol/conformance/corpus/` 下的金样本用例。
- 设计文档: 分册 (`deletion-guard.md` / `install-tree-hardening.md` / `scan-and-size.md` / `config-and-initialization.md` / `architecture-overview.md` 在 `packages/sweep/docs/designs/`; `cli-surface.md` 在 CLI 包 `packages/sweep-cli/docs/designs/`); 平台、发布与演进决策在仓库级 `docs/adrs/` 与 API 主包 `packages/sweep/docs/adrs/` (`0001..0004`, `0007..0008`, `0021..0024`)。
- 覆盖表: 条款与语料的对照见 `packages/sweep/docs/protocol/conformance/coverage.md`。

**分组不是严格分类**: A 到 F 六组按「防的是哪一类错」划分, 同一条防线可能被不止一组提到; 条目编号 (A1 到 F22) 在本文内唯一, 供引用与挑选。

## A. 防误删

删除是这套工具唯一不可逆的动作, 围绕它的第一层纪律是: 进删除批的目标, 必须先是「该删的」。这一组管「什么会被删、什么碰都不碰」, 从名字形态与归属判定, 到两类默认拦下的目标: 删了装不回来的疑似安装树, 与落在另一文件系统上的跨设备目标。

> 这一组的口号是「宁可留着」: 体积测不到的不删, 判不准的不删, 但凡有一点说不准, 默认落在这边。

**A1. 泛化目标叶名防线 + 6 预设强制项目锚定 + 自定义规则安全词表**

- 依据: `src/guard.ts` 的 `hasNodeModulesLeaf` / `hasSafeTargetLeaf` / `validateTargets` (默认模式严格要求末段恰为 `node_modules`; 泛化模式通过 `hasSafeTargetLeaf` 硬拒绝空串、尾斜杠、`.`、`..`、`.git`、`*` 与文件系统根并可叠加 `allowedLeaf` 白名单)、`src/presets.ts` 的 `BUILTIN_PRESETS` (对 `node`/`rust`/`python`/`java`/`cpp` 通用目录名强制校验同级项目清单或内嵌指纹, `os-junk` 严格限定 4 个文件并禁删 `desktop.ini`/`.directory`/`._*`)、`src/rules.ts` 的 `validateRuleMatch` (硬拒危险通配、路径分隔符与控制字符); 契约 BC-21; ADR 0022; 测试 `src/guard.contract.test.ts` / `src/presets.test.ts` / `src/rules.test.ts`。
- 边界: 裸无 `package.json` 的 `node_modules` 或无项目锚点的 `target`/`build`/`venv` 保守不纳入; posix 下名称大小写敏感。

**A2. 只删声明的扫描根之下的目录 (按路径层级判定, 不是字符串前缀)**

- 依据: `src/guard.ts` 的 `insideAnyRoot` (`path.relative` 语义: 相等、上溯与跨盘符均判不通过); 契约 BC-21; 测试 `src/guard.contract.test.ts` (`/work/proj-evil` 冒充 `/work/proj`、`../` 上溯、win32 跨盘符全拒)。

**A3. 不删文件系统根与家目录本体**

- 依据: `src/guard.ts` 的 `isFilesystemRootBody` 与 `isHomeBody`; 契约 BC-21; 测试 `src/guard.contract.test.ts`; e2e `src/cli.e2e.test.ts`。

**A4. 同一目录的多种写法只算一个, 不重复删、不误报重复**

- 依据: `src/guard.ts` 的 `dedupeKey` (realpath 归一 + win32 折叠); 扫描与安全闸共用同一来源的判定 (`src/scan-parallel.ts` 消费 `src/guard.ts` 的导出); 契约 BC-04 / BC-21; 测试 `src/guard.contract.test.ts` 与 `src/scan.contract.test.ts`。

**A5. 一个目标没通过检查, 就整批一个都不删 (而不是逐条放行)**

- 依据: `src/cli.ts` 的 `sweep` (任一目标被拒即整批拒绝、零删除、退 1; 整批而非逐条, 是因为这些事实会让整批的可信度一起失效); 契约 BC-22; 语料 `delete-root-symlink-anchor-rejected` / `delete-root-ancestor-symlink-rejected`。
- 边界: 仅 `--yes` 执行路径。

**A6. 动手删除前逐级复核路径, 半路被掉包就整批停手**

- 依据: `src/delete-review.ts` 的 `reviewPathOnDisk` (自根至目标父目录逐级 `lstat`) 与 `src/delete.ts` 的 `removeTargets` (复核紧跟删除, 压缩替换窗口); 测试 `src/delete.contract.test.ts`。
- 边界: 复核只缩短窗口, 不构成零窗口保证, 复核与 `rm` 之间的微秒级窗口如实登记为残余风险 (见 G 节)。

**A7. 配置里的根或其任一祖先被掉包成符号链接, 删除整批中止 (不可核验亦 fail-closed 拒删)**

- 依据: `src/delete-review.ts` 的 `rootAncestorChain` 与 `reviewPathOnDisk` (删前对信任根的 `configured` 与 `real` 完整祖先链逐级 `lstat`, 非真目录触发 `REVIEW_HEAD_SYMLINK` 整批中止, 消失或不可核验按 fail-closed 记单条 `failed` 拒删); 测试 `src/delete.contract.test.ts` 与 `src/delete.result-shape.test.ts`。
- 边界: 仅删除侧; 扫描侧照常 (见 B1)。

**A8. 删除目标是符号链接时只删链接, 不跟进到它指向的目录**

- 依据: `src/delete-review.ts` 的 `tailComponentChain` (复核链不含末段) 与 `fs.rm` 的 lstat 语义; 契约 EC-04; 测试 `src/delete.contract.test.ts`。

**A9. 疑似安装树默认不进删除批 (删了装不回来的那类, 先拦下)**

- 依据: `src/classify.ts` 的 `classifyTarget` (三级形态判定) 与 `src/skip.ts` 的 `skipReasonOf` / `deletionBatch` (批次构造); 契约 BC-37 / BC-38; 语料 `delete-suspect-install-tree-skip`。
- 边界: 判定只看路径形态; 已知误判面 (monorepo 里名为 `lib` / `extensions` 的包) 登记在 `deletion-guard.md` 的「语义闸」。

**A10. 缺省排除名单: 32 项三端家目录安全护栏, 挨着就不扫 (含 `.gradle` 双重角色裁决)**

- 依据: `src/config.ts` 的 `DEFAULT_EXCLUDE` (32 项: 10 项包/版本管理器 + 5 项编辑器 + 5 项系统/应用数据根 + 3 项三端回收站本体 `.Trash`/`Trash`/`$Recycle.Bin` + 2 项 Windows 应用根 `AppData`/`scoop` + 7 项语言全局工具链 `.cargo`/`.rustup`/`.m2`/`.gradle`/`.conda`/`.pyenv`/`.uv`) 与 `src/scan-match.ts` 的 `canBypassDefaultGradleExclude` (`~/.gradle` 恒受保护, 仅真实项目下含 Gradle 锚点且未显式排除的 `.gradle` 归 `java` 预设); 契约 BC-36; ADR 0022; 测试 `src/config.contract.test.ts` / `src/presets.test.ts`。
- 边界: 显式写出 `exclude` (含空数组) 即以显式名单为准; 删除面另有 A9 语义闸兜底。

**A11. `--force` 的边界: 只放行「疑似安装树」, 不放宽任何删除安全不变量**

- 依据: `src/cli.ts` 的批次构造与 `src/help.ts` 的命令面说明; 契约 BC-38; 语料 `delete-force-includes-suspect`。
- 边界: 跨设备目标不走 `--force` (见 A19); 它只影响批次构造, 不改预览的零副作用语义。

**A12. 体积测不到的目标一律不删 (宁可留着, 不猜)**

- 依据: `src/sweep.ts` 的批次构造 (只收体积已测到的条目); 契约 BC-15; 语料 `size-unmeasured-blocks-delete`。
- 边界: 预览模式测不到只影响显示 (`?`), 退 0。

**A13. 根自身就叫 `node_modules` 时, 不会把根当目标**

- 依据: 契约 BC-10 (根 = 容器语义); 语料 `scan-root-is-node-modules`。

**A14. 文件与目录形态严格分流: 目录预设绝不误删同名普通文件, `os-junk` 严格限定普通文件白名单**

- 依据: `src/presets.ts` (`kinds: ['dir']` vs `kinds: ['file']`, `OS_JUNK_FILES` 仅含 4 项, 严禁 `desktop.ini`/`.directory`/`._*`)、`src/rules.ts` (`ruleMatchesKind`) 与 `src/scan-parallel.ts`; 测试 `src/robustness.scan.test.ts` / `src/presets.test.ts`。

**A15. 扫描不跟进符号链接 (防环、防把根外的树算进来)**

- 依据: `src/scan-parallel.ts` (Dirent 为 lstat 语义, 链接一律跳过); 契约 BC-02; 测试 `src/robustness.scan.test.ts`; 语料 `scan-symlink-not-followed`。
- 边界: 仅扫描与体积统计; 根自身为链接是显式授权 (见 B1)。

**A16. `.git` 目录整棵跳过 (里面埋的诱饵 `node_modules` 也不会被算)**

- 依据: `src/scan-parallel.ts` 的 `.git` 跳过; 契约 BC-05; 语料 `scan-git-bait`。

**A17. 嵌套的 `node_modules` 只报最外层, 不重复统计体积**

- 依据: `src/scan-parallel.ts` (命中即剪枝, 不再下钻); 契约 BC-01; 语料 `scan-nested-prune`; 体积侧同口径 (`src/size.contract.test.ts`)。

**A18. 重复根、嵌套根、大小写双写的根只遍历一次**

- 依据: `src/scan-parallel.ts` 的根去重 (realpath 折叠); 契约 BC-04; 测试 `src/scan.contract.test.ts`; 语料 `scan-multi-root-dedupe`。

**A19. 跨设备目标默认不进删除批 (删的是授权路径之外的实际存储, 先拦下)**

- 依据: `src/guard.ts` 的 `findCrossDeviceTargets` (`st_dev` 比对, 归属取最具体的根) 与 `src/skip.ts` 的批次排除; 契约 BC-41; 判定由 `src/guard.device.contract.test.ts` 注入探针钉死, 端到端由 `src/cli.cross-device.e2e.test.ts` 的真实挂载现场钉死。
- 边界: 逐条跳过而非整批拒绝 (挂载点只是单个目标的局部事实, 不牵连同根下的其余目标); `--force` 不放行这一类; 两形态解除路径不同: 挂载点在根与目标之间 (`on-path`) 时把该挂载点声明为独立根即可清理, 目标本体即挂载点 (`target-itself`) 时只能先卸载该卷。

**A20. 零依赖三端回收站失败绝不降级永久删除 (数据安全绝对红线)**

- 依据: ADR 0023; `src/trash.ts` 的 `moveToTrash` 与 `src/delete.ts` 的 `executeTrash`: 任一平台回收站失败 (命令缺失、权限拒绝、跨盘 `EXDEV`、Windows 路径 `>= 260` 字符或异常) 均返回 `TRASH_FAILED` (`partialRisk: false`), **磁盘原文件 100% 保持不动, 零调用 `fs.rm`**, CLI 退出码 `1`。
- 边界: 旧版 macOS 降级 `osascript` 依赖图形会话与自动化权限; Windows `>= 260` 字符需用户改 `action: "delete"` 或缩短路径; Windows 宿主机真机与真实 Linux 桌面集成实测边界见 G 节。

**A21. 自定义规则默认走回收站, 多源命中冲突时保守优先 (`trash` 胜过 `delete`)**

- 依据: ADR 0022; `src/config-validate.ts` (规则省略 `action` 强制补 `'trash'`) 与 `src/scan-match.ts` 的 `mergeCleanupActions` (同一 realpath 同时命中预设与规则时 `'trash'` 覆盖 `'delete'`)。

## B. 软链与掉包

符号链接是这套工具里分叉最多的一件事: 同一份配置, 扫描面照常跟进、删除面整批拒绝、写入面一个字节不落。三个面三种答法, 理由只有一个: 门槛跟着可逆性走。只读的扫描容得下错, 不可逆的删除赌不起。

> 符号链接的判词是「判不了来路, 一律不放行」: 这个链接是用户当初亲手写下的, 还是后来被人换上的, 两种可能长得一模一样。

**B1. 配置根自身是符号链接时, 预览照常出清单 (显式即授权, 只读跟进无风险)**

- 依据: 契约 BC-11; `src/scan-parallel.ts` 的根处理; 语料 `scan-root-symlink-followed`; e2e `src/cli.anchor.e2e.test.ts`。
- 边界: 仅扫描侧; 同一配置在 `--yes` 下被拒 (见 B2), 这是有意的分叉。

**B2. 同一份配置: 预览有清单, `--yes` 整批拒绝 (门槛跟着可逆性走)**

- 依据: 契约 BC-39 (与 BC-11 的分工); `src/guard.ts` 的根锚点检查; 语料 `delete-root-symlink-anchor-rejected`; e2e `src/cli.anchor.e2e.test.ts`。
- 边界: 拒绝文案自带改写方向。

**B3. 根的祖先链任一级被换成符号链接, 同样整批拒绝**

- 依据: `src/guard.ts` 的 `anchorChainPaths` 与 `firstSymlinkOnAnchor` (自根的一级子目录至根自身逐级判, 文件系统根本身不入链); 语料 `delete-root-ancestor-symlink-rejected`。

**B4. 拒绝的判据落在「配置拼写」上 (改不了口供的信任锚)**

- 依据: `src/guard.ts` 的判定注释 (为何以拼写而非 realpath 为判据: realpath 只报告此刻的解析结果, 看不出映射被改过); `install-tree-hardening.md` 的「把根钉在拼写上」。
- 边界: 覆盖「链接介入」这一载体; 同型真目录换位不可识别, 已登记残余风险 (见 G 节)。

**B5. 系统固有链接 (macOS 的 `/tmp`、`/var`) 同样命中, 给出改写指引而非白名单**

- 依据: `src/guard.ts` 的锚点判定; `src/help.ts` 与 `src/init.ts` 的改写指引文案; README 的配置节。
- 边界: 改写真身形态即放行; 让诚实路径多改一次拼写是明示的代价, 白名单按名字挑, 会被同一命名方式绕过。

**B6. 写入侧: 配置路径或迁移备份路径为既有目录或锚点链 (含祖先链) 有符号链接, `init` / `init --default` / `migrate` 拒写、一个字节不落**

- 依据: 契约 BC-40; `src/guard.ts` 的 `firstSymlinkOnTarget`、`src/init.ts` 的 `checkTargetWritable` 双阶段校验与 `src/migrate.ts` 的 `applyMigration` (对目标配置与备份路径双重检查); 测试 `src/init.test.ts`; 冒烟 `src/init.smoke.ts`。
- 边界: 交互向导中既有目录与悬空链接均在前置阶段直接报错取消退出, 不进入覆盖确认与提问。

**B7. 悬空符号链接照样认得出 (lstat 不跟进末段)**

- 依据: `src/guard.ts` 的 `collectAnchorLinks` (逐级 lstat); 测试 `src/guard.contract.test.ts`。

**B8. 向导逐根校验: 不存在的根、落在链接上的根当场提示并重问, 坏输入不进配置**

- 依据: `src/init.ts` 的逐根校验; 测试 `src/init.test.ts`; 冒烟 `symlink-root` 场景; `config-and-initialization.md` 的「配置初始化模型」。
- 边界: 仅 TTY 向导。

**B9. 一个根被判死, 不牵连其他根**

- 依据: `src/guard.ts` 的根锚点判定 (根不可解析时该根无归属目标); 测试 `src/guard.contract.test.ts`。
- 边界: 最终仍是「任一被拒即整批拒绝」的保守口径。

**B10. 删除复核与目标同源拼写 (入口形态违约或归属不明的目标一律不删)**

- 依据: `src/delete.ts` 的 `TrustRoot` (配置拼写与 realpath 归一在类型上强制配对) 与 `toTrustRoots`, `src/delete-review.ts` 的 `resolveTargetRootSync` (入口形态硬拒绝尾分隔符 / `.` / `..`, 末段校验缺省要求恰为 `node_modules`, 泛化多预设/自定义规则模式 `allowGeneralTargets: true` 下经 `hasSafeTargetLeaf` 校验安全末段并硬拒空串 / `.` / `..` / `.git` / `*` / 文件系统根, 再叠加 `insideAnyRoot` 归属判定); 测试 `src/delete.contract.test.ts` 与 `src/delete.result-shape.test.ts`。

## C. 防注入与伪造

工具的输出里带着大量它控制不了的数据: 磁盘上的目录名、`du` 的报错、配置与命令行的名单拼写。这一组是两件事: 外部数据进输出前的净化, 和对外部命令 (运行时、`du`) 的不轻信。

> 这两件事防的方向是一样的: 不让任何不受控的输入, 伪造出一行看起来可信的输出。

**C1. 一切外部数据进输出前都会被净化: 剥控制字节 + 折叠换行**

- 依据: `src/display.ts` 的 `sanitizeLine` / `sanitizeOutputLine` (剥 C0 含 ESC / DEL / C1 / bidi / 零宽 / BOM, 剩余空白折成单空格); 契约 OF-14; ADR 0024 (`init` / `migrate` 已取消原始 JSON 全文回显, 摘要中全部路径与规则名均经本管线净化); 语料 `scan-unreadable-dir-control-bytes` / `scan-unmatched-name-control-bytes` / `cli-unknown-arg-control-bytes`。

**C2. 净化的两个目的: 防终端控制序列注入与防换行劈出伪造的可信输出**

- 依据: `src/display.ts` 的净化注释; `src/cli.ts` 的 `warn`; `cli-surface.md` 的输出规格 (换行折叠的现场: 非 TTY 下 stderr 常被 tee 与 CI 原样落盘, 劈行在日后回放时同样生效)。

**C3. 覆盖面是整个输出面, 且集中在同一处 (单源): 清单显示名与路径、stderr 告警与错误、`config` 报告路径、向导路径回显、`--help` 默认配置位置行**

- 依据: 契约 OF-14; `src/cli.ts` / `src/help.ts` / `src/init.ts` 的消费点; e2e `src/cli.sanitize.e2e.test.ts`。
- 边界: 诊断面不附「已净化」提示 (告警是事件通报, 不是展示面); 非 TTY 输出必不含 ESC。

**C4. 显示名被净化改写时, 行尾标注「名字已净化显示」**

- 依据: `src/render.ts` 的 `tailsOf`; 测试 `src/robustness.render.test.ts`; 金样本 `src/goldens/render-preview-sanitized.txt`。

**C5. `du` 调用有注入防线: `--` 终止选项解析 + 含控制字符的路径前置拒绝**

- 依据: `src/size-du.ts` 的 `runDu` (选项终止符) 与 `hasControlChar` 前置过滤; 测试 `src/size.contract.test.ts`。
- 边界: 含控制字符的目标以 `unmeasured` 结构化上报, 不静默丢。

**C6. `du` 输出被伪造时会整体降级, 不逐条采信; 降级不静默, 随附归因告警**

- 依据: `src/size-du.ts` 的 `assessDuOutput` (多重集一致性校验: 解析出的路径须全部来自输入且无重复); 测试 `src/size.contract.test.ts` 与 `src/size-du.output-shape.test.ts`。
- 边界: 降级告警只述形态 (同一路径多行 / 含输入之外的路径) 且不带原始路径, 让「什么都没删」可被归因; 判据是 fail-safe, 不引入逐条采信。

**C7. `du` 的英文报错一律转中文告警, 不原样透传**

- 依据: `src/size-du-parse.ts` 的 `describeDuFailure` 与 `parseDuErrorLine` (`src/size-du.ts` 消费); 测试 `src/size.contract.test.ts`。
- 边界: 未识别的短语保留原文摘录便于诊断 (已剥 `du:` 前缀)。

**C8. 体积统计用绝对路径探针找 `du` (`/usr/bin/du`、`/bin/du`), 不经 PATH**

- 依据: `src/size-du.ts` 的 `DU_PROBES` 与 `findDu`; 配套: 空集不调用 `du` (避免它没有路径参数时统计当前目录)。
- 边界: 探针双缺时降级纯 JS 基线 (`src/size.ts` 的门面分流); win32 一律不用 `du` (见 C11)。

**C9. 体积统计与扫描同策: 不跟随符号链接**

- 依据: `src/size-js.ts` 的条目遍历 (链接跳过); 测试 `src/size.contract.test.ts`。

**C10. 非 TTY 或 `NO_COLOR` 时输出零 ANSI 纯文本, 行结构、信息都与着色版逐字等价**

- 依据: 契约 OF-10; `src/render.ts` 的 `paint` 与 `src/cli.ts` 的着色开关; 测试 `src/render.test.ts`; 语料 `render-no-color-degraded`。
- 边界: 设计上仅真终端出现的内容 (顶栏运行时自述、名单回执) 非 TTY 整段省略, 不在「零丢失」承诺内。

**C11. 启动器与回收站调用排除当前工作目录与脚本注入 (防被扫目录劫持或路径字符注入)**

- 依据: 契约 EC-08; ADR 0007 / ADR 0023; `bin/sweep.mjs` 的 `resolveWin32Executables` (按 PATH 解析绝对路径, 跳过空条目/相对条目/盘根相对条目) 与 `bin/sweep.cmd` 的 PATH 展开修饰符; `src/trash.ts` 固定绝对路径调用 `/usr/bin/trash`、`/usr/bin/osascript` (经 `on run argv` 传参) 与 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` (经环境变量 `$env:SWEEP_TRASH_TARGET` 传参); 测试 `src/launcher.runtime-resolution.test.ts`。
- 边界: `bin/sweep.mjs` 已有 Windows CI 覆盖; 源码检出 `.cmd` 启动器与 Windows 宿主机真机 PowerShell 回收站未在目标宿主机实跑 (见 G 节)。

## D. 保守默认

这一组是工具的性格说明书: 默认什么都不做, 每往前一步都要一个显式的理由。预览是默认态, 删除要 `--yes`, 覆盖要确认, 名单写错要让人看见。每个默认都落在不删的那一侧。

**D1. 默认只预览、不动手; 要删必须显式加 `--yes`**

- 依据: 契约 BC-23; `src/cli.ts` 的模式分流; 语料 `scan-basic-preview`。

**D2. 没有配置文件时 `--yes` 被硬拒绝, 零删除**

- 依据: 契约 BC-28; `src/cli.ts` 的回退态分流; 语料 `cli-no-config-yes-hard-reject`。

**D3. 无配置且非 TTY 严禁盲扫或阻塞: 直接报错退 1 并指引 `sweep init` / `sweep init --default`**

- 依据: ADR 0024 (修订 BC-18); `src/cli.ts` 的无配置非 TTY 分流: 不阻塞等待、不回退扫描家目录或 `cwd`、不接受 `--yes`, 直接输出错误指引并返回退出码 `1`。

**D4. 首次向导刚写入配置的那一轮强制预览 (即便带了 `--yes` 也只预览)**

- 依据: ADR 0024; `src/cli.ts` 的向导写入轮分流; `config-and-initialization.md`; pty e2e `src/cli.e2e.test.ts`。

**D5. `init` 非 TTY 报错退出并指引 `init --default`; `init --default` 非 TTY 拒绝静默覆盖既有配置**

- 依据: 契约 BC-29; ADR 0024; `src/cli-commands.ts` 的 `handleInitCommand` 与 `src/init.ts` 的 `runInitDefault`。

**D6. 覆盖保护: 配置已存在时先问是否覆盖, 默认「否」; 中途取消一律不落盘**

- 依据: `src/init.ts` 的覆盖确认与取消出口; ADR 0004; 测试 `src/init.test.ts`; 冒烟 `decline` 场景。

**D7. 向导问到排除名单时, 「一路回车」取到的就是内置默认名单, 而不是空数组**

- 依据: `src/init.ts` 的排除一问 (空答回填默认名单); 测试 `src/init.test.ts`; 冒烟 `written-default-exclude` 场景。

**D8. 显式写出的 `exclude` (哪怕空数组) 完全接管默认名单**

- 依据: `src/config.ts` 的 `loadConfig` (按「缺省」而非「空」判定); 契约 BC-36; 测试 `src/config.contract.test.ts`。
- 边界: 覆盖是既定权利; 删除面另有语义闸兜底 (见 D10)。

**D9. 显式指定的配置路径不存在时, 硬报错 (不静默降级成「无配置」)**

- 依据: 契约 BC-17; `src/config.ts` 的 `loadResolvedConfig`; 语料 `config-explicit-missing-hard-error`; e2e `src/cli.e2e.test.ts`。
- 边界: 仅显式来源 (`--config` / `SWEEP_CONFIG`); 平台默认缺失时 TTY 走向导, 非 TTY 报错退 1 (见 D3)。

**D10. 疑似安装树这道闸不受用户配置影响 (删掉默认排除项, 删除批门口的闸仍站着)**

- 依据: `src/classify.ts` (判定与配置解耦); 契约 BC-37; `deletion-guard.md` 的「语义闸」。

**D11. 判定只看路径形态、不看目录内容; 误判方向刻意落在安全侧**

- 依据: `src/classify.ts` 的判定注释; `install-tree-hardening.md` 的「保守的代价」; 测试 `src/classify.test.ts`。
- 边界: 已知误判面 (同名 `lib` / `extensions` / 点目录里的项目) 会要求 `--force`; 判定不看内容是为了不把判定与磁盘状态耦合。

**D12. 退出码语义: 预览与空结果记 0; 执行有失败、有跳过 (疑似安装树 / 跨设备目标) 或有未测到的, 记 1; 参数错误 / 配置损坏记 1**

- 依据: 契约 BC-26; `src/cli.ts` 的退出码落点; 语料 `delete-execute-ok` / `delete-suspect-install-tree-skip` / `size-unmeasured-blocks-delete` / `cli-unknown-arg`。

**D13. 「没删」和「删失败」分开展示, 不混为一谈**

- 依据: `src/outcome.ts` 的 `outcomeResult` 三分 (整批中止 / 跳过项 / 体积未测到); 契约 BC-38; 契约 OF-13。

**D14. 无损配置迁移 (`v1 → v2`): 写前强制备份原配置, 严禁替用户静默激活新预设**

- 依据: ADR 0022 / ADR 0024; `src/migrate.ts` 的 `convertV1ToV2` 与 `applyMigration` (写盘前以 `flag: 'wx'` 在源配置目录创建 `config.json.YYYYMMDD_HHMMSS.modified` 备份, 失败即停写; 仅等价映射为 `presets: { node: {} }`; 非 TTY 仅在 100% 无损时自动放行, 含未知字段或高版本则报错退 1)。

## E. 透明披露

工具对输出的态度是「如实」: 体积按什么口径量、配置从哪来、名字有没有被改写过、跳过了几处、释放了多少, 全都摆在清单与报告里。这一组清点「用户能核对到什么」。

**E1. 预览清单: 体积降序 (测不到的排末尾)、体积档位色块、CJK 双宽对齐、家目录缩写、合计**

- 依据: 契约 OF-02 / OF-03 / OF-06 / OF-08; `src/render.ts` 的渲染与 `displayWidth`; 测试 `src/render.test.ts`; 语料 `render-tier-mid-and-order` / `render-align-cjk` / `render-path-tilde`。

**E2. 体积口径如实: 按平台惯例 (有 `du` 平台报磁盘占用, 与 Finder 一致; 无 `du` 平台报逻辑字节, 与 Explorer 一致)**

- 依据: `scan-and-size.md` 的「体积统计」; `src/types.ts` 的口径注释; `src/size.ts` 的门面分流。
- 边界: 两种口径数值可以不同, 差异文档明示保留。

**E3. 疑似安装树行保留 `node_modules` 后缀 + 行尾标注理由 + 清单末跳过计数 (非 TTY 也出现)**

- 依据: 契约 OF-13; `src/render.ts` 的 `displayPath` 与 trailer 通道; `src/cli.ts`; 语料 `delete-suspect-install-tree-skip`。
- 边界: 后缀保留是刻意的, 剥掉后缀会把安装树显示成项目。

**E4. 名单回执 (TTY): 排除侧报「排除生效: 名字 (N 处)」, 包含侧报「包含命中: 名字 (N 处)」; 包含侧刻意不说「生效」**

- 依据: 契约 BC-33; `src/cli.ts` 的 `collectNameNotes`; `src/scan-parallel.ts` 的逐名计数。
- 边界: 仅真终端显示; 同一名字同时命中两份名单时 `exclude` 优先截走, 此时说「生效」即是不实承诺。

**E5. 名单里的名字写错了必须响: 未命中即 stderr 告警; 白名单全零命中另点明「结果必为空」**

- 依据: 契约 BC-09 / BC-33; `src/cli.ts` 的名单反馈; 语料 `scan-exclude-unmatched-warn` / `scan-include-unmatched-warn`。
- 边界: 内置默认名单项零命中不告警; 用户显式写同名项同样静默 (该项已由默认名单覆盖)。

**E6. 措辞不冤枉名字: 报的是「未命中已扫描的目录」, 并附「若其上层目录已被排除则属预期」**

- 依据: 契约 BC-33 的例外条款; `src/cli.ts` 的告警措辞; 语料 `scan-ancestor-excluded-unmatched-warn`。

**E7. `config` 子命令如实报告本次实际生效的配置: 来源三档标签 + 路径 + 文件状态, 退出码恒 0**

- 依据: 契约 BC-35; `src/cli-commands.ts` 的 `reportConfig`; 语料 `cli-config-default-source` / `cli-config-env-source` / `cli-config-flag-source`。

**E8. `--help` 的「默认配置」行点明它只对没做覆盖的用户成立, 并指向 `sweep config`**

- 依据: 契约 BC-30; `src/help.ts` 的 `defaultConfigPath`; 语料 `cli-help`。

**E9. 错误文案四件套: 错误码 + 人话 + 目标定位 + 复查或保留提示**

- 依据: 契约 BC-25; `src/delete.ts` 的 `describeRemovalError` (`partialRisk: true` 附部分删除复查提示) 与 `src/trash.ts` 的 `failTrash` (`partialRisk: false`, 明示「已保留原文件, 未执行永久删除」)。

**E10. `init` / `init --default` / `migrate` 落盘后展示紧凑结构化摘要与快捷指令, 严禁吐出原始 JSON 全文**

- 依据: ADR 0024; `src/config-summary.ts` 的 `renderConfigSummary` 与 `buildConfigQuickCommands`: 渲染配置路径、迁移备份路径、扫描根、激活预设 (`[DELETE]`/`[TRASH]`)、自定义规则及保留天数、全局排除计数与适配当前平台的查看/编辑指令; 所有外部路径与规则名统一经过 OF-14 单源净化。

**E11. 清单与诊断分流: 清单与名单回执走 stdout, 告警与错误走 stderr, 互不污染**

- 依据: 契约 OF-12; `src/cli.ts` 的 `print` / `warn` / `notice`; 测试 `src/cli.e2e.test.ts`。

**E12. 顶栏如实标注本次实际运行时 (`bun 1.4.5` 或 node)**

- 依据: `src/cli.ts` 的运行时标签 (自取 `process.versions`, 直接跑与经启动器跑都报真身); `src/render.ts` 的顶栏渲染。
- 边界: 仅真终端显示。

**E13. 执行汇总给释放量, 且 0 B 与「未提供」可区分**

- 依据: `src/sweep.ts` 的释放量累计 (按成功侧条目计); `src/render.ts` 的 `footExecute`; 测试 `src/render.test.ts`。

**E14. 空结果明确提示无待清理目标且退 0**

- 依据: 契约 OF-07; `src/render.ts` 的空结果分支; 语料 `render-empty-result` / `scan-root-is-node-modules`。

**E15. 根数不超过 3 时, 顶栏直接列出根路径 (光报数量, 用户无法确认扫描范围)**

- 依据: 契约 OF-01; `src/render.ts` 的 `ROOT_LIST_LIMIT`; 测试 `src/render.test.ts`。

**E16. 跨设备行的呈现: 行尾按形态标注 + 执行侧跳过说明 + 末行说明行 (非 TTY 也出现)**

- 依据: 契约 OF-15; `src/skip.ts` (跳过类文案与批次排除的单源); `src/outcome.ts` 的 `toRenderEntry`; `src/render.ts` 的 trailer 通道; e2e `src/cli.cross-device.e2e.test.ts`。
- 边界: 路径照常剥 `node_modules` 后缀 (与疑似安装树行的保后缀规则不同, 类别提示落在行尾标注上)。

## F. 韧性、输入健壮与分发

前面的组管「删得对不对」, 这一组管「不管遇到什么, 都能把话说清楚」: 目录读不了、体积测不到、运行时缺一个、输入是管道灌进来的, 局部错误降级为告警, 整批不中断, 报告不撒谎。分发链路上的三道关 (启动器挑运行时、npm 产物自证、发布闸门) 也归这一组。

**F1. 单条删除或移入回收站失败不中断整批, 末尾分桶汇总 (removed / trashed / missing / failed 四桶内部均保持输入顺序)**

- 依据: 契约 BC-24; `src/delete.ts` 的 `removeTargets` 与 `assembleRemovalResult`; 测试 `src/delete.contract.test.ts`。
- 边界: 例外是复核未通过 (整批中止), 那是有意的保守。

**F2. 扫描与体积的局部错误不致命: 不可读目录告警跳过; 根预检失败按病因分流且不中断其余根**

- 依据: 契约 BC-07 / BC-08; `src/scan-roots.ts` 的 `rootFailureWarning`; `src/size-js.ts` 的子树降级; 语料 `scan-root-eacces-warn` / `scan-root-is-file-warn` / `scan-root-missing-warn` / `scan-unreadable-dir-warn`。

**F3. 输出确定性: 并发扫描的清单按 target 升序 (不受完成先后影响)**

- 依据: 契约 BC-06; `src/scan-parallel.ts` 的 `compareTarget` (码元序, 不依赖 locale); 测试 `src/scan.contract.test.ts` 的「候选间一致」对撞套件。

**F4. 规模与深度不炸: 200 层嵌套不爆栈、2000 条目不阻塞、有界并发**

- 依据: 测试 `src/robustness.scan.test.ts`; `src/scan-parallel.ts` 的 `CONCURRENCY` (显式栈 + 在飞计数, 上层封顶)。

**F5. 长时间反复跑不泄漏: 堆增量有上限、句柄回落基线**

- 依据: 测试 `src/stress.scan.test.ts`。

**F6. 三个入口 (sh / cmd / 分发 mjs 启动器) 职责同逻辑: 挑运行时 (Bun 优先、Node 回退), 参数与退出码原样透传**

- 依据: `bin/sweep` / `bin/sweep.cmd` / `bin/sweep.mjs`; 测试 `src/npm-launcher.smoke.test.ts`; ADR 0007。
- 边界: 面向源码检出的 `bin/sweep.cmd` 未在 Windows CI 独立实跑, 本文如实标注 (见 G 节)。

**F7. 找不到运行时给出可操作提示并非零退出 (不是静默失败)**

- 依据: `bin/sweep` 与 `bin/sweep.mjs` 的运行时缺席分支。

**F8. 平台可移植: win32 路径大小写折叠、`%APPDATA%` 默认配置路径、核心功能零 POSIX 假设**

- 依据: ADR 0007; `src/guard.ts` 的路径风味注入 (`PathStyle`); `src/config.ts` 的平台默认路径; 测试 `src/config.contract.test.ts`。
- 边界: 核心逻辑与测试套件已由真机 Windows CI (`verify-windows`) 常驻覆盖, 仅源码检出用的 `.cmd` 启动器未在 CI 独立实跑 (见 G 节)。

**F9. 零运行时依赖 + 核心清理路径零网络调用 (运行路径只用运行时内置模块)**

- 依据: ADR 0003; `package.json` (无 `dependencies`); API 主包与扫描/清理/初始化/迁移全路径零网络调用 (仅显式执行 `sweep update` 子命令时经内联的 `@iyowei/cli-updater` 访问 npm registry 查询新版本)。
- 边界: 属「不给新风险」, 不是主动防护功能。

**F10. 分发产物自证来源: 启动器用产物前先与随附清单对账摘要, 不符即拒收 (不静默换源码)**

- 依据: `bin/sweep.mjs` 的 `artifactProblem`; 测试 `src/npm-launcher.smoke.test.ts`; ADR 0009 补记。(注: 两包当前标 `"private": true`, 在首发前与公开 npm 发布链隔离, 自证机制保留就绪。)

**F11. 发布闸门: 干净检出 + 本提交构建的产物 + 清单自洽 + 发行包白名单相符, 四者齐备才放行发布**

- 依据: CLI 包 `scripts/verify-release.ts` 与 `scripts/release-artifact.ts` 的 `judgeRelease` (四项按序短路); `package.json` 的 `prepublishOnly`; ADR 0009 补记。
- 边界: 面向发布者, 对安装者是间接价值; 已知残留口见 G 节。

**F12. 发行包白名单: 防止仓库根的 README / LICENSE 类文件 (如备份) 被 npm 静默收进包**

- 依据: CLI 包 `scripts/release-artifact.ts` 的 `PACK_FILES_EXPECTED` 与 `judgePackFiles` (集合相等才算过); ADR 0009 补记。

**F13. 配置损坏或非法结构拒绝且报错具体: 非法 JSON / 显式空 `roots: []` / 预设含 `enabled` / 未知预设键 / 非法规则 `match` / 旧版 v1 需迁移, 报错含路径与精确错误码, 退 1**

- 依据: 契约 BC-19; ADR 0022; `src/config.ts` / `src/config-validate.ts` / `src/rules.ts`; 语料 `config-corrupt-json` / `config-corrupt-shape-roots-empty` / `config-shape-item-type`。
- 边界: 字段「缺省」与「写错」严格区分: `roots` 省略取家目录而显式 `[]` 硬拒; `exclude` 省略用 32 项护栏而显式 `[]` 接管。

**F14. 名单输入健壮: 扫描恒定跳过的 `.git` 写进任何名单都静默剔除、永不制造假未命中告警**

- 依据: 契约 BC-34; `src/config.ts` 的 `mergeNames`。

**F15. 命令行与配置名单合并: 去重、保首见序、不改动入参**

- 依据: `src/config.ts` 的 `mergeNames`; 测试 `src/config.contract.test.ts`。

**F16. 向导输入解析容错: `~` 展开 (含 win32 习惯 `~\`)、成对引号内的空格与逗号保留、未配对引号不吞后续内容、半角与全角逗号及空白均作分隔、中文路径不被破坏**

- 依据: `src/init.ts` 的 `parsePathList` / `parseNameList` / `splitAnswer` / `expandHome`; 测试 `src/init.test.ts`。
- 边界: 仅向导输入; 不解析 `~user` (跨平台语义不一)。

**F17. 交互壳韧性: 管道一次性多行投喂不丢行、EOF 与 Ctrl+C 一律折算取消 (不挂死)、进程退出前释放 stdin 引用**

- 依据: `src/init-io.ts` 的 `createReadlineIO` (单 interface 长存 + 自管行缓冲, `src/init.ts` re-export); 冒烟驱动器 `src/init.smoke.ts` (挂死即超时判失败)。
- 边界: 仅向导交互路径。

**F18. 「不存在」与「测不到」严格分桶: 不存在的目标告警并单列 `gone` 桶 (不进 `entries` / `unmeasured`, 不伪造 0 字节, 三桶构成入参全划分); 存在但测不到的结构化记 `unmeasured`、以占位行留在清单里 (不静默移出)**

- 依据: 契约 BC-13 / BC-14 / BC-43; `src/types.ts` 的 `SizeResult` (`entries` / `unmeasured` / `gone`) 与 `UnmeasuredEntry`; `src/size-du.ts` 与 `src/size-js.ts` 的分桶; 测试 `src/size.contract.test.ts` 与 `src/size.result-shape.test.ts`; 语料 `size-unmeasured-preview` / `api-size-gone-bucket` / `api-size-three-buckets-and-warning`。

**F19. 体积未测到显示 `?` + 中性色块 + 行尾原因 (与 0 B 区分开)**

- 依据: 契约 OF-11; `src/render.ts` 的占位行; 测试 `src/render.test.ts`。
- 边界: 占位行不计入合计总量, 但行数照常计入。

**F20. 交互面的视觉与清单同源 (顶栏 / 中性块 / 压暗 / 对错标记一处定义, 各面复用)**

- 依据: `src/render.ts` 的构件常量与 `src/cli.ts` 的复用; `cli-surface.md` 的视觉规范。
- 边界: 内部一致性, 用户面只体现为「各界面风格统一」。

**F21. 长文与异常输入不劈碎输出结构: 净化把任意输入压成单行 (注记与失败原因并置时仍保持单行)**

- 依据: `src/display.ts` 的空白折叠; 测试 `src/robustness.render.test.ts`。

**F22. `rm` 阶段 ENOENT 先复核目标本体再分桶 (不以错误码定论, 目标仍在不得报成功)**

- 依据: 契约 EC-07; `src/delete.ts` 的 `checkGone` (三态分桶) 与 `describeSurvivor`; 测试 `src/delete.contract.test.ts` (竞态压测, bun 侧) 与 `src/delete.node-smoke.ts` (node 侧直跑)。
- 边界: 这是双运行时语义分叉的兜底 (Bun 会把递归途中的内部条目消失冒泡为顶层 ENOENT, 且与顶层缺失逐字段同形), 复核不依赖运行时错误形态; 触发条件是并发删除者, 非远程攻击面。

## G. 内部账目

下面这些内容不写进 README, 因为那里是用户面。放在这份全量文档里, 是给想深挖的读者与未来维护者的账目: 验收体系有多狠、哪些数字不可复现、哪些面尚未经真机验证、哪些风险如实挂着没修。

一份只讲承诺、不讲账的清单, 不值得信任。这 14 类账目同样是这套保障的一部分。

1. **金样本语料与覆盖表**: 全量金样本语料 (实时数量与逐条映射以 `coverage.md` 为准, 由确定性闸门 `validate-coverage.ts` 执行三角对账) 在双载体 (bun / node) 上全量全绿, 覆盖表登记「条款 × 语料」的覆盖关系与逐条豁免理由 (不可黑盒项写明理由)。
   - 依据: `packages/sweep/docs/protocol/conformance/coverage.md` 全篇。
   - 不进 README 的理由: 开发侧验收资产, 用户无从操作或验证。
2. **变异自证**: 故意往实现里注入缺陷 (覆盖 CLI / API 三态矩阵的 mutant), 看语料抓不抓得住, 抓不住的语料不算数; 实时抓取数矩阵与代表用例以 `coverage.md`「变异自证」为准 (不在此处重复抄录明细, 防计数漂移)。
   - 依据: `coverage.md` 的「变异自证」一节。
   - 不进 README 的理由: 属「测试体系有多狠」这一类账目, 面向维护者。
3. **转写契约套件**: 为未来以 Rust / C 等语言重写准备的机械验收路径 (编号契约 + 金样本语料 + 确定性验收器), 被测命令只是参数, 语言中立。
   - 依据: ADR 0008; `packages/sweep/docs/protocol/README.md`。
   - 不进 README 的理由: 对终端用户无直接价值。
4. **工程闸门与依赖锁定**: lefthook 提交钩子 (pre-commit 增量 / pre-push 全量: 经 `scripts/ci.ts` 单源调度全套验证组与双端 conformance)、oxlint、`bun fmt`、`bun check` (ADR 0020), 与 devDependencies 无范围符号的精确锁定; 装钩子收窄到本包仓库 (被作为依赖安装时不写使用方仓库的 `.git/hooks`)。
   - 依据: ADR 0005; `.oxlintrc.json` / `lefthook.yml`; 守卫脚本 `scripts/install-git-hooks.mjs`。
   - 不进 README 的理由: 仓库内开发设施, 写进用户面会让保障清单失焦。
5. **候选制与程序设计范式**: 同一能力多份实现竞争、由基准数据裁定 (3 个扫描候选、2 个体积候选), 门面只暴露胜出者; 分层、依赖注入、判别联合等范式与它们的代价账单。
   - 依据: `architecture-overview.md`; `src/scan.ts` 与 `src/size.ts` 的门面。
   - 不进 README 的理由: 内部架构决策, 不改变用户可观察行为。
6. **不可复现的性能数字**: 并发上限 32 的取值依据 (拐点扫描)、扫描约 4.8 倍提速、`du` 快路径约 11 倍比值。实测现场 (约 3.8 万目录的真实工作区) 现已不存在, 数字不可复现。
   - 依据: ADR 0007 与 `architecture-overview.md` 的性能要点。
   - 不进 README 的理由: 最多说「快」不报数, 报数即不可核验。
7. **残余风险登记**: 安全复核与删除之间仍有微秒级窗口、同型真目录换位不可识别、持续振荡可低成本触发整批中止 (fail-safe 方向) 等负面事实。属诚实账而非保障点, 精确措辞另立小节 (见下「已知残余风险」)。
   - 依据: `deletion-guard.md` 的「残余风险」。
   - 不进 README 的理由: 负面事实且用户无法据以行动, 写进用户面须另设段落精确措辞。
8. **跨平台真机验证边界 (`[证据缺口]`)**: CI 常驻 Windows 任务 (`verify-windows`, `windows-latest`) 覆盖构建、双包核心测试与 `bin/sweep.mjs`; 源码检出用的 `bin/sweep.cmd` 未纳入独立实跑; 此外按 ADR 0023, macOS 回收站与 Linux 纯 TS XDG Trash 协议逻辑已在本机实测, **Windows 宿主机真机 PowerShell 回收站 (`Microsoft.VisualBasic.FileIO.FileSystem` / 只读剥离 / 260 字符边界) 与真实 Linux 桌面集成仅经桩/逻辑测试覆盖, 尚未在目标宿主机真机实测**。
   - 依据: `.github/workflows/ci.yml` 的 `verify-windows` job; ADR 0007 / ADR 0023; `src/trash.ts`。
   - 不进 README 的理由: 细粒度 CI 覆盖边界属工程内部账目; 用户面作结论性披露。
9. **提交闸门的质量账**: 提交闸门只覆盖本机已装的运行时 (缺 node 时 node 侧用例静默跳过而整体仍全绿); 转写验收现由 pre-push 与 CI 自动双跑 (conformance 双 target), 不再依赖手动。
   - 依据: ADR 0005 的「代价」; `docs/development.md` 的「运行时双跑」。
   - 不进 README 的理由: 维护者视角的质量账目。
10. **私有演进隔离与发布闸门残留口**: `@iyowei/sweep` 与 `@iyowei/sweep-cli` 当前标记 `"private": true` 暂隔离公开 npm 发布链 (ADR 0021); 发布闸门挂在 `prepublishOnly`, 仅在仓目录发布时触发 (`npm pack` 与 `npm publish <tarball>` 不经该钩子)。
    - 依据: ADR 0009 补记第 4 条; ADR 0021; `scripts/verify-release.ts`。
    - 不进 README 的理由: 面向发布者的操作限制。
11. **模板化配置摘要替代原始 JSON 回显 (历史缺口已关闭)**: 早期向导落盘后直接输出未净化原始 JSON 全文曾留有 OF-14 排除项; 按 ADR 0024, `init` / `init --default` / `migrate` 现已改为输出结构化摘要模板且全部路径与规则名统一走 OF-14 单源净化, 原有未净化回显暴露面已消除。
    - 依据: ADR 0024; `src/config-summary.ts`。
    - 不进 README 的理由: 历史演进销账记录。
12. **测试覆盖的已知缺口账**: TTY 专属面 (真终端才有输出) 不参与黑盒语料覆盖 (运行器无 pty 通道), 逐条登记豁免理由; 另登记「疑似安装树 × 跨设备」组合面为已知未钉住项。
    - 依据: `coverage.md` 的「未覆盖条款」; `src/skip.ts` 的注释。
    - 不进 README 的理由: 测试体系内部账目。
13. **契约体系的三向维护纪律**: 契约条款、金样本语料、设计文档三者同批演进; 语料只增不改既有期望, 改期望须先过「三向定责」(修语料 / 修契约 / 修实现) 并写明依据。
    - 依据: `packages/sweep/docs/protocol/README.md` 的「维护规则」。
    - 不进 README 的理由: 内部流程。
14. **实现结构细节**: 有界并发的实现结构 (显式栈 / 在飞计数 / pump) 与去重键编码业务语义等数据结构选择。
    - 依据: `architecture-overview.md` 的「数据结构」一节。
    - 不进 README 的理由: 实现细节; 用户只需知道「深目录不炸、输出有序」(已列 F3 / F4)。

### 已知残余风险 (诚实账)

以下是安全复核能覆盖到哪儿、覆盖不到哪儿的如实登记。它们不是待办清单 (有的是明确的取舍, 有的现实不可达), 而是这份保障的信用边界: 知道围栏在哪儿为止, 才知道它拦得住什么。

- **复核与删除之间的窗口**: 逐级复核完成到 `rm` 解析之间, 仍有微秒级窗口可被掉包路径 (实测小于 1.4 微秒, 而攻击者的最小操作周期约 195 微秒; 系统调用级振荡压测 322 次机会零越界)。彻底关闭需要文件描述符级的 `openat` / `O_NOFOLLOW`, 运行时未暴露。判定「现实不可达, 可接受」。
- **同型真实目录换位不可识别**: 若被换位的不是符号链接而是同名真目录, `lstat` 层分不出两个真目录的差别, 仍不可识别; 其「假成功」危害面另有兜底: 复核发现路径组件半路消失时, 宁可要求复查, 也不报成功。
- **持续振荡可低成本触发整批中止**: 约 4% 概率命中; 这是 fail-safe 方向 (无数据损失), 登记为已知拒绝服务面。
- **目标内部子挂载点的残留面**: 设备边界闸管的是「目标与根不同设备」; 目标内部再嵌一个子挂载点 (如容器给 `node_modules/.cache` 挂卷) 不在判定面内。实测两运行时行为分叉: node 侧不下探卷内 (挂载点成为意外屏障), bun 侧会下探删除卷内内容后以 `EBUSY` 收尾。检出该形态需要一次整棵子树走查 (另一次与体积统计同量级的遍历), 本轮不修, 登记为已知残留; 触发条件是部署期的显式布置, 非攻击面; 失败如实上报, 不是静默成功。
- **判定与删除之间的挂载窗口**: 跨设备判定在批次构造时做, 到 `rm` 之间若新挂载点出现 (自动挂载 / 人工挂载), 该目标会跨设备删除。窗口是本次运行内的秒级段, 且每次运行都重判; 窗口内布置挂载需挂载权限, 登记为已知面。
- **`rm` 阶段 ENOENT 的运行时语义分叉, 未核部分**: 已加本体复核兜底 (见 F22), 但 Bun 内部为何把子项级失败记为顶层 `lstat` 错误, 未查证运行时源码, 登记为未核事实。
