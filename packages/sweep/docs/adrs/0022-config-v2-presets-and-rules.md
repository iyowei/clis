# ADR 0022: 配置 v2、预设锚定校验、自定义规则与保守迁移

> **状态**: 已接受 (Accepted), 扩展并局部取代 [ADR 0002](0002-fixed-config-and-preview-execution.md) 与 [ADR 0007](0007-platform-portability.md) 中的配置结构与路径约定
> **日期**: 2026-11-20
> **决策者**: 沈委
> **标签**: [架构, 安全, 配置]
> **影响范围**: [全项目]

## 上下文与问题 (Context & Problem)

工具演进为多技术栈工作区清理器 ([ADR 0021](0021-sweep-general-cleaner-evolution.md)) 后, v1 配置仅含 `{ roots, exclude, include }` 无法表达:

1. 按技术栈启用不同清理目标, 并避免把非项目目录中的通用名 (`target`、`build`、`venv`) 当成构建产物误删;
2. 面向个人自定义临时文件/日志/旧目录的灵活规则 (支持回收站优先与按天数过滤);
3. 缺省以家目录为根扫描时, 跨三端 (macOS / Linux / Windows) 对回收站本体、Windows 应用目录与各语言全局工具链缓存的默认保护;
4. 老 v1 配置 (`sweep-node-modules/config.json`) 向 v2 (`sweep/config.json`) 升级时的零误删、零越权平滑过渡。

## 放弃掉的替代方案 (Options Considered & Rejected)

**[在 `presets.<name>` 内使用 `enabled: boolean` 开关]**

放弃理由: 引入 `enabled` 会造成「写了键但 `enabled: false`」与「漏写 `enabled` 默认 true/false」两套心智负担; 若用户误写拼错键名或误解缺省值, 极易导致静默扩删。采用「对象内出现技术栈键名即代表激活」语义单一、零歧义, 且对出现 `enabled` 字段直接硬报错拦截。

**[仅凭目录名匹配 `target` / `build` / `venv`, 不做项目锚定校验]**

放弃理由: 家目录下大量业务目录或资料目录可能叫 `target` 或 `build`; 不校验同级项目清单文件 (`Cargo.toml`、`pom.xml`、`build.gradle*`、`CMakeLists.txt`、`pyproject.toml` 等) 或内置指纹 (`CMakeCache.txt`、`pyvenv.cfg`), 会造成不可逆数据丢失。

**[在 `v1 → v2` 自动迁移时替用户顺手开启所有新预设]**

放弃理由: 迁移属于等价结构升版, 擅自激活 `rust` / `python` / `java` / `cpp` / `os-junk` 等预设会在用户下次带 `--yes` 运行时静默扩大删除面, 违背最小惊讶与数据安全最高优先级原则。

## 决策与理由 (Decision & Why)

1. **配置定位升级**:
   - 默认路径: POSIX `~/.config/sweep/config.json`, Windows `%APPDATA%\sweep\config.json` (缺失回退 `%USERPROFILE%\AppData\Roaming\sweep\config.json`);
   - 环境变量升级为 `SWEEP_CONFIG`, 优先级维持 `--config` > `SWEEP_CONFIG` > 平台默认;
   - 旧路径 (`sweep-node-modules/config.json`) 仅用于自动迁移探测。
2. **`roots` 语义与空数组硬拒**:
   - 配置 v2 (`version: 2`) 中省略 `roots` 时, 缺省取 `[realpath(os.homedir())]` (删除侧仍须满足无符号链接锚点链与跨设备边界不变量);
   - 显式写出 `"roots": []` 一律硬报错拒绝 (`CONFIG_CORRUPT_SHAPE`), 防止静默空扫。
3. **`DEFAULT_EXCLUDE` 三端家目录护栏扩容与 `.gradle` 边界裁决**:
   - 在原 20 项基础上补齐 12 项护栏: 回收站自身 (`.Trash`, `Trash`, `$Recycle.Bin`)、Windows 应用根 (`AppData`, `scoop`)、语言全局工具链与缓存 (`.cargo`, `.rustup`, `.m2`, `.gradle`, `.conda`, `.pyenv`, `.uv`), 共 32 项;
   - **`.gradle` 双重角色裁决**: `~/.gradle` 属全局 Gradle 缓存树必须受全局护栏保护; 而项目内的 `<project>/.gradle` 属 `java` 预设清理目标。裁定: 当 `java` 预设激活且 `.gradle` 位于非家目录本体的真实项目目录 (同级存在 `build.gradle*` / `settings.gradle*`, 且未被用户显式写入配置 `exclude` 或 `presets.java.exclude`) 时, 将该项目级 `.gradle` 识别为 `java` 预设目标并剪枝; 其余任何 `.gradle` (含 `~/.gradle` 及无 Gradle 锚点的目录) 严格受 `DEFAULT_EXCLUDE` 保护跳过不下钻。
4. **六大内置预设 (`presets`) 与强制锚定**:
   - 键名存在即激活, **严禁 `enabled` 字段** (出现即报 `CONFIG_CORRUPT_SHAPE`); 未知预设键硬报错; 默认 `action: "delete"`, 可局部覆写 `action` (`"trash" | "delete"`), 局部 `exclude` / `include` 仅在全局名单基础上收紧 (不削弱全局安全护栏);
   - `node`: 目标目录 `node_modules`, 校验同级 `package.json` 及既有安装树语义安全闸 (`classifyTarget`);
   - `rust`: 目标目录 `target`, 校验同级 `Cargo.toml`;
   - `python`: 目标目录 `.venv`、`venv` (校验同级 `pyproject.toml` / `requirements.txt` 或内含 `pyvenv.cfg`), 以及工具固有缓存 `__pycache__`、`.pytest_cache`、`.mypy_cache`、`.ruff_cache`;
   - `java`: Maven `target` (校验同级 `pom.xml`) 与 Gradle `.gradle`、`build` (校验同级 `build.gradle*` 或 `settings.gradle*`);
   - `cpp`: 目录 `build`、`cmake-build-*`, 校验内含 `CMakeCache.txt` 或同级 `CMakeLists.txt`;
   - `os-junk`: 仅匹配普通文件 `.DS_Store`、`Thumbs.db`、`ehthumbs.db`、`ehthumbs_vista.db`, 在 `sweep init` 默认配置中启用; **严禁纳入** `desktop.ini`、`.directory` 与 `._*`;
   - 预设注册表采用声明式可扩展结构, 便于后续继续增补技术栈而不改动扫描核心。
5. **自定义规则 (`rules`)**:
   - 每条规则含 `name`、`kind: "file" | "dir" | "any"`、`match` (支持精确名或简单文件名通配, **硬拒绝**空串、`.`、`..`、`.git`、`*`、`**`、纯通配及路径分隔符)、`action?: "trash" | "delete"` (**缺省强制为 `"trash"`**)、可选 `olderThanDays` (正数, 依 `lstat.mtimeMs` 判定)、局部 `exclude` / `include`;
   - 同一路径同时命中多条预设或规则时按 `realpath` 去重, 若动作冲突则**保守优先 (`"trash"` 优先于 `"delete"`)**。
6. **泛化安全闸**:
   - 保留五不变量核心防线 (路径归属某 `root`、非文件系统根与 `home` 本体、realpath 去重、根锚点链逐级 `lstat` 无软链、删除前逐级 `lstat` 复核与跨设备拦截);
   - 将原「末段必须为 `node_modules`」泛化为「拒绝空段 / `.` / `..` / `.git` / 尾分隔符, 且必须命中本次激活预设或规则允许的目标形态」。
7. **无损自动迁移 (`migrate`)**:
   - 新路径不存在而旧路径 `sweep-node-modules/config.json` 存在, 或既有配置 `version < 2` (含无 `version` 的 v1) 时自动触发迁移;
   - **写前必备份**: 写盘前必在用户配置目录创建 `config.json.YYYYMMDD_HHMMSS.modified` 备份, 备份失败即中止;
   - **严禁越权扩删**: v1 仅等价映射为 `{ version: 2, roots, ...原exclude/include, presets: { node: {} } }`, 绝不自动开启其他新预设, 仅输出一行中性提示告知新增可用预设名;
   - TTY 需用户确认摘要后落盘; 非 TTY 仅在 100% 无损等价升版时自动备份落盘并输出 info 日志继续, 非无损/含未知字段/高版本则中止报错退出码 1。

## 后果与权衡取舍 (Consequences & Trade-offs)

**正面收益**

- 锚定校验从机制上杜绝通用目录名 (`target` / `build` / `venv`) 误删;
- 自定义规则默认进回收站 (`trash`), 把手写规则的误伤代价降到可恢复区间;
- 老配置无损升级且不悄悄扩删, 保护既有工作流安全边界。

**代价**

- 扫描层在命中候选目录名时需做同级条目表查或轻量化 `lstat` 锚点核验 (目录内 `readdir` 同级列表已在内存, 多数锚定校验零额外磁盘 IO; 仅 `pyvenv.cfg` / `CMakeCache.txt` 等内嵌锚点多一次轻量 `access`/`lstat`)。
- `node` 预设新增同级 `package.json` 锚定后, 裸无 `package.json` 的散落 `node_modules` 不再自动纳入清理清单 (偏向保守安全)。

## 验证方式与关联引用 (Validation & References)

**验证方式**

1. 单测覆盖 6 大预设的全部正例与反例 (无 `Cargo.toml` 的 `target`、无 `pom.xml`/`build.gradle*` 的 `target`/`build`、无 `CMakeLists.txt`/`CMakeCache.txt` 的 `build`、`~/.gradle` 与项目 `.gradle` 隔离、`desktop.ini`/`.directory`/`._*` 绝不命中);
2. 单测覆盖 `rules` 非法 `match` 拒绝、`action` 缺省 `"trash"`、`olderThanDays` 边界与动作冲突 `"trash"` 优先;
3. 单测覆盖 `v1 → v2` 自动迁移: `config.json.YYYYMMDD_HHMMSS.modified` 备份落盘、`presets` 仅含 `node`、非 TTY 无损自动继续与非无损硬拒。

**关联引用**

- 总定位演进: [ADR 0021](0021-sweep-general-cleaner-evolution.md);
- 三端回收站实现与不降级铁律: [ADR 0023](0023-zero-dep-cross-platform-trash.md);
- 自动 `init` / `migrate` 与展示模板: [ADR 0024](0024-cli-init-migrate-and-summary-display.md);
- 历史配置与安全闸设计: [配置与初始化](../designs/config-and-initialization.md) / [删除安全闸](../designs/deletion-guard.md)。
