# ADR 0024: 自动 `init` / `migrate`、无配置非 TTY 拒盲扫与模板化配置摘要展示

> **状态**: 已接受 (Accepted), 修订并局部取代 [ADR 0004](0004-config-initialization-wizard.md)
> **日期**: 2026-11-20
> **决策者**: 沈委
> **标签**: [体验, 安全, CLI]
> **影响范围**: [全项目]

## 上下文与问题 (Context & Problem)

[ADR 0004](0004-config-initialization-wizard.md) 针对 v1 单技术栈清理器设计了两项行为, 在演进为多技术栈清理器 ([ADR 0021](0021-sweep-general-cleaner-evolution.md)) 与配置 v2 ([ADR 0022](0022-config-v2-presets-and-rules.md)) 后不再适用:

1. **无配置且非 TTY 时的旧回退策略过宽**: v1 在无配置非 TTY 下会静默回退扫 `cwd`, 仅在带 `--yes` 时拒绝; 演进为多预设且默认扫描根升级为家目录后, 任何无配置非 TTY 下的静默扫描都容易在 CI/定时任务中偏离预期范围, 更严禁出现 `--yes` 盲扫家目录的隐患。
2. **落盘后回显原始 JSON 全文噪声过高**: 配置 v2 包含 `version`、`roots`、`exclude` (32 项默认护栏)、多组 `presets` 与 `rules`, 落盘后直接输出 `JSON.stringify(config, null, 2)` 会瞬间刷屏终端、淹没关键安全信息 (到底扫哪、启用了哪些预设、哪些是 `[TRASH]` 哪些是 `[DELETE]`)。
3. **缺少一键初始化与自动迁移入口**: 需要 `sweep init --default` 快速生成最佳实践配置, 并需要无感探测旧配置 (`sweep-node-modules/config.json`) 或旧版本 (`version < 2`) 的自动 `migrate` 流程。

## 放弃掉的替代方案 (Options Considered & Rejected)

**[无配置非 TTY 时默认扫描家目录或回退扫描 `cwd`]**

放弃理由: 在非交互脚本或定时任务中, 配置缺失通常意味着环境未初始化或路径设错; 静默扫描默认目录 (尤其家目录) 会掩盖配置缺口并放大误删风险。直接报错退出码 1 并指引 `sweep init` 最保守、最清晰。

**[`init` / `migrate` 写盘后继续打印完整格式化 JSON 文本]**

放弃理由: v2 配置含 32 条默认排除与嵌套预设/规则对象, 原文长达数十行, 用户第一眼看不到核心影响面; 改用紧凑结构化人话摘要并附上可复制的查看/编辑命令, 既能一眼核对安全范围, 又不牺牲查看原文的便捷性。

## 决策与理由 (Decision & Why)

1. **`sweep init` 与 `sweep init --default`**:
   - `sweep init`: 交互式向导 (TTY 专属), 引导生成包含完整最佳实践的 v2 配置 (扫描根默认 `~`、常用预设与默认启用的 `os-junk`、默认安全排除护栏), 完整继承双阶段配置路径目标与锚点链安全检查 (BC-40);
   - `sweep init --default`: 直接按完整最佳实践生成默认 v2 配置 (含默认扫描根、主流预设与 `os-junk` 默认启用、推荐安全护栏); 仍强制执行配置路径锚点校验与覆盖保护 (已有配置时 TTY 询问是否覆盖, 非 TTY 拒绝静默覆盖并返回退出码 1)。
2. **首次运行且新旧位置均无配置的分流**:
   - **TTY**: 自动拉起 `init` 向导; 向导落盘当轮**即使带 `--yes` 也强制仅预览**, 不得直接执行清理;
   - **非 TTY**: **严禁阻塞等待, 严禁回退盲扫家目录或 `cwd`, 严禁接受 `--yes` 执行**, 直接输出明确错误并指引执行 `sweep init` (或 `sweep init --default` / `--config <path>`), 返回退出码 1。
3. **自动触发与显式 `migrate` 流程**:
   - 当新默认配置不存在而旧 `sweep-node-modules/config.json` 存在, 或已存在配置 `version < 2` 时自动触发迁移 (亦提供 `sweep migrate` 显式子命令);
   - 写盘前必在用户配置目录创建 `config.json.YYYYMMDD_HHMMSS.modified` 备份;
   - **TTY**: 展示等价迁移摘要并等待确认 (`确认迁移? (Y/n)`), 确认后落盘并输出中性提示告知新增可用预设名;
   - **非 TTY**: 仅在判定为 100% 无损等价升版时自动备份落盘并输出 info 日志继续; 若非无损/结构损坏/高版本则中止报错退出码 1。
4. **模板化配置摘要展示 (严禁原始 JSON 全文输出)**:
   - `init` 与 `migrate` 落盘后**严禁向终端吐出原始 JSON 全文**, 必须复用 `▍ SWEEP` 视觉规范套用结构化模板展示:
     - 配置文件路径 (家目录缩写 + OF-14 净化);
     - 扫描根列表 (家目录缩写 + OF-14 净化);
     - 激活预设列表 (标注各预设生效动作 `[DELETE]` / `[TRASH]`);
     - 自定义规则列表 (标注 `[TRASH]` / `[DELETE]` 与保留天数如 `> N 天`);
     - 全局排除计数 (`N 条`);
   - 摘要末尾附上当前平台可直接复制执行的指令:
     - 查看生效定位: `sweep config`
     - 查看原文: POSIX `cat <path>` / Windows `Get-Content <path>`
     - 编辑配置: POSIX `${EDITOR:-vi} <path>` (macOS 另附 `open -e <path>`) / Windows `notepad <path>`
   - 所有输出路径与命令参数均统一通过 OF-14 单源净化管线处理。

## 后果与权衡取舍 (Consequences & Trade-offs)

**正面收益**

- 彻底封堵无配置非 TTY 场景下的误扫/盲删风险;
- 配置落盘反馈从几十行原始 JSON 收敛为一眼可读的安全摘要 + 即复制即用的查看/编辑命令;
- 老用户升级零手工迁移成本且零静默扩删风险。

**代价**

- 既有的非 TTY 无配置回退 `cwd` 契约条款 (`BC-18`) 与对应黑盒金样本需同步修订为「非 TTY 无配置硬报错退 1 并指引 `sweep init`」;
- `init` 原有的「落盘回显原始 JSON 全文」测试与文档口径需同步切换为「断言摘要模板存在且禁止原始 JSON 全文刷屏」。

## 验证方式与关联引用 (Validation & References)

**验证方式**

1. 单测与 e2e 断言 `init` / `init --default` / `migrate` 输出包含 `▍ SWEEP` 摘要各字段与平台对应查看/编辑命令, 且**不包含**格式化原始 JSON 全文 (`"version": 2` / `"presets": {` 等原始 JSON 块);
2. e2e 断言无配置非 TTY (无论是否带 `--yes`) 退出码恒为 1、零扫描零删除并指引 `sweep init`;
3. 断言 TTY 首次自动 `init` 落盘当轮即使带 `--yes` 也强制降为预览。

**关联引用**

- 被局部取代的历史向导决策: [ADR 0004](0004-config-initialization-wizard.md);
- 配置 v2 与无损迁移规格: [ADR 0022](0022-config-v2-presets-and-rules.md);
- CLI 视觉与命令面设计: [命令面与输出](../../../sweep-cli/docs/designs/cli-surface.md)。
