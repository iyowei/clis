# Rust 跨语言转写通用模板 (全仓通用)

> 继承: [`common-discipline.md`](common-discipline.md) 全量适用 (角色边界 / 反敷衍三条红线 / 映射表与试跑闸门 / 双面 `release` 终验)。
>
> 配合使用: 转写具体包时, 须同时读取目标包的 `packages/<pkg>/docs/protocol/behavior-contract.md` 与该包可选的领域特化补充 (如 `packages/<pkg>/docs/protocol/prompts/transcribe-rust.md`)。与包级行为契约冲突时, 一律以行为契约为准。
>
> **占位约定**: `{{...}}` 为任务启动时的必填项, 带着未填占位开工视为违规。

## 一、工程基线

- **工具链与 edition**: `{{TOOLCHAIN}}` / `{{EDITION}}`
- **内存安全红线**: crate 根默认声明 `#![forbid(unsafe_code)]`; 如确需系统调用 (如极窄 FFI), 须先在缺口清单立项获批并隔离在独立小模块内。
- **依赖策略**: 默认仅用 Rust 标准库、零第三方 crate (无网络环境可离线构建); 若包级补充显式放行特定 crate, 须登记理由与锁定版本。
- **双交付物形态**:
  - CLI 二进制: `{{BINARY_NAME}}` (供验收器 `--target` 校验);
  - API harness 可执行: `{{API_HARNESS_BINARY}}` (按包级 API harness 协议实现 stdin JSON -> stdout JSON, 与 CLI 二进制分开交付, 供验收器 `--api-target` 与差分模糊测试校验)。
- **提交与验收门禁 (全部在 `release` 构建下通过)**:
  1. `cargo fmt --check`
  2. `cargo clippy --all-targets -- -D warnings`
  3. `cargo test --release`
  4. `bun scripts/transcription/run-conformance.ts --target "<release CLI>" --api-target "<release harness>"` (全集 `skipped = 0`, 连续 3 次一致)
  5. `bun scripts/transcription/run-diff-fuzz.ts --targets "<包级 fuzz-targets.json>" --api-target "<release harness>"` (0 差异, 0 崩溃)

## 二、通用行为面陷阱对照 (每项必须明确落地方案)

| 行为面           | Rust 侧高频陷阱                                                             | 通用落点与填实项                                                                                         |
| ---------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| stdout 缓冲      | 非 TTY 下 `stdout` 默认块缓冲; `process::exit` 会跳过 `Drop` 与缓冲区刷盘   | `main() -> ExitCode` 统一返回并在退出前显式 `flush()`; 方案: `{{STDOUT_STRATEGY}}`                       |
| stderr 分离      | 诊断与告警混入 stdout 会污染机器可解析输出与逐字节快照                      | 统一走独立 `eprintln!`, 文本过单源净化; 不依赖 stdout/stderr 交错顺序                                    |
| 错误类型与判别码 | 零第三方 crate 下错误携带 `code` + 逐字中文 `message` + 可选 `details`      | 手写强类型 `enum` + `Display` + JSON 序列化 (缺省字段省略, 不写 `null`); 方案: `{{ERROR_TYPE_STRATEGY}}` |
| JSON 解析与输出  | 零依赖自写或选用解析器时的转义、科学计数法、未知字段与 `undefined` 省略语义 | 严格对齐包级契约与 API harness 协议; 方案: `{{JSON_PARSER_STRATEGY}}`                                    |
| 符号链接与元信息 | `Path::is_dir()` / `fs::metadata()` 会静默跟进软链                          | 一律使用 `fs::symlink_metadata()` 与 `DirEntry::file_type()`                                             |
| 原子排他写盘     | 先 `exists()` 再 `write()` 存在 TOCTOU 竞态                                 | 使用 `OpenOptions::new().write(true).create_new(true)`                                                   |
| 非 UTF-8 路径    | Unix 路径可能含非 UTF-8 字节, `.to_str().unwrap()` 直接 panic               | 内部尽量持 `PathBuf` / `OsString`, 展示面按契约裁决; 策略: `{{NON_UTF8_PATH_POLICY}}`                    |
| `readdir` 排序   | `fs::read_dir` 顺序跨平台/跨文件系统不确定                                  | 所有对外输出与事件汇总前显式按契约排序                                                                   |
| 环境变量         | `env::var` 遇非 UTF-8 报 `NotUnicode`, 与空串语义易混                       | 统一用 `env::var_os` 并明确空串 = 未设置                                                                 |
| 并发与资源清理   | 提前 `?` 返回漏清临时目录/锁; 并发线程完成顺序污染输出顺序                  | 用 `Drop` 守卫托底清理; 并发结果收集后按确定性键排序再输出                                               |

## 三、开工前检查单与 3 文件试跑闸门

- [ ] 包级输入包齐备 (`behavior-contract.md`、全量语料、覆盖表、API harness 协议、`fuzz-targets.json`)
- [ ] 对 TS 参考实现跑绿双面全量验收 (`0 skipped`) 与变异自证 (`make-mutants.ts` 全部 mutant 被抓住)
- [ ] 本模板与包级补充中的全部 `{{...}}` 占位已填实
- [ ] `PORTING_MAP.tsv` 已建立, 包含源模块、目标模块、条款编号与状态列
- [ ] **3 文件试跑 (`Trial Run`) 已通过**:
  - 已选定 3 个代表性模块 (`{{TRIAL_MODULES}}`: 1 纯函数 + 1 解析/校验 + 1 系统 IO);
  - 已完成「实现 -> 独立上下文对抗评审 ([`adversarial-reviewer.md`](adversarial-reviewer.md)) -> 修复 -> `cargo test --release` 过关」;
  - 确认公共错误类型、JSON 序列化与 harness 协议骨架运行顺畅后再展开剩余模块。

## 四、验收失败闭环与盲区补测

1. 验收出现失败用例时, 务必带 `--emit-failures ~/tmp/conformance-failures` 运行验收器, 按生成的单用例诊断单逐条定责修复, 再重跑全量 (勿把 `--filter` 局部绿当最终过关)。
2. 验收器与差分模糊测试均全绿后, 对照包级 `conformance/coverage.md` 的不可黑盒豁免条目 (如 TTY 交互、真机跨设备挂载、异构 OS 路径与大文件), 逐条补齐 Rust 原生测试并登记在缺口清单中。
