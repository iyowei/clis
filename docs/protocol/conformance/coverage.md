# 覆盖表与变异自证 (终稿)

> 判据 (见 [套件门面](../README.md)「维护规则」): 每 case `specRefs` 非空且指向真实条款; 产出「契约条款 × 语料」
> 覆盖表, 未被覆盖的条款要么补 case, 要么显式标注「不可黑盒验收」并给出理由。
> **终稿数据**: 双载体 (bun / node) 各三连跑全绿, 判定层逐字节一致;
> 判定基准为白名单 (`include`) 落地及其后续修正后的实现态: 起点为白名单落地提交 `15bc404`,
> 含 `7e2c9bd` (名单静默剔除) 与 `b8297e9` (include 命中计数修正); 本次校准的末位提交为 `d0b64b3` (新增名单语料与 `stderrMustNotContain` 原语);
> 可追溯校验 (jq): 台账与语料引用逐条对齐, 无悬空引用, 未被引用者恰为下表豁免项。
> **派生声明**: 本表由 `corpus/*.json` 的 `specRefs` 机械汇总 (jq) 生成, 权威在语料与条款台账,
> 本表是派生索引, 严禁反向手改本表来「修」覆盖关系。
> **本次加固依据 (维护规则「只增不改既有期望」的三向定责记录)**: 新增语料 `scan-node-modules-and-git-in-lists-noop` (BC-34),
> 并给 `scan-include-exclude-priority` 补 `stderrMustNotContain` 与 BC-33 背书; 既有期望逐条未动, 属加固而非改判。
> 定责结论: 修条款 (BC-33 补计数口径 / BC-34 新立) + 修语料 (两处), 实现侧对照 `7e2c9bd` 与 `b8297e9` 已正确, 无需改实现。
>
> **`config` 子命令一轮的定责记录 (2026-09-24)**: 新增子命令 `config` (BC-35 新立, 可验收性 posix 分支)
> 与其三条语料 `cli-config-default-source` / `cli-config-env-source` / `cli-config-flag-source`
> (后两条兼背书 BC-16 的三级覆盖, flag 条同时钉住「旗标优先于环境变量」)。
> `cli-help` 的逐字节期望随命令面扩展同步更新 (帮助新增 `sweep-nm config` 行, 「默认配置位置」行补
> 「仅为平台默认、覆盖通道下不成立」的限定并补 `查实际生效的路径: sweep-nm config` 指引), BC-30 条款补记该要求;
> 属需求变更引发的同步, 非基准降级 (期望由 BC-30 / BC-35 条款原文辩护, 非按实现反推)。
> 本轮双载体 (bun / node) 全量各跑一遍全绿。
>
> **渲染视觉升级一轮的定责记录 (2026-09-24)**: 本轮属**改契约** (渲染输出形态被 OF 条款与金样本钉住, 视觉规范升级系主动设计变更,
> 非基准降级), 各改动逐条定责:
> ① 三条 `cli-config-*` 的 `stdoutExact` 改为新 `config` 形态的降级版 (零 ANSI; 顶栏 `▍ SWEEP-NM  配置 · 来源: <对应三档标签>`
> 加两行 `  ░ 配置路径` / `  ░ 文件状态`): 定为**修语料**, 内容三要素与退出码均不变, 仅呈现形态随 BC-35 补写的形态说明变,
> 期望由 BC-35 改写后的条款推演 (非按实现反推);
> ② `render-tier-mid-and-order` 期望逐字未动: 其 fixture 恰为 100 MiB (`TIER_MID` 边界), 新阈值集 (100 MiB / 512 MiB) 下仍判中档,
> 逐字复核一致; OF-04 / OF-05 的覆盖关系不变;
> ③ OF-04 阈值数字改 `大 ≥ 1 GiB` → `大 ≥ 512 MiB`: 定为**修契约**, 依据 2026-09-24 实测分布
> (主样本 n=5 加 2 项范围外观测; 原 1 GiB 高于全样本最大值 590.72 MiB, 该档永不触发),
> 依据与口径见 `docs/designs/cli-surface.md`「输出规格 · 体积档位与阈值」;
> ④ 不新增大档 (≥ 512 MiB) 语料: 保留 EC-06 成本性豁免, 理由按新阈值改写并补记模块级替代护栏
> (重判依据见「二、未覆盖条款」EC-06 行);
> ⑤ `init` 向导视觉层按 TTY 专属面同体例登记 (见「二、未覆盖条款」), 不产生语料条目; 向导内容与三态出口不在本轮改动面内。
> 本轮条款与语料先行、实现侧随后跟进; 收口轮已重跑 (2026-09-24): 双载体验收器各 49/49, 六 mutant 抓取数 27 / 11 / 3 (波动) / 4 / 7 / 26, 与上一轮一致 (含阈值重标后), 第三节数字表据此维持不变。
>
> **安全审计修复一轮的定责记录 (2026-09-24)**: 本轮属**改契约** (默认排除名单改变「配置缺省 exclude」的行为; 疑似安装树改变渲染标记 / 删除批次 / 退出码三面), 各改动逐条定责:
> ① 修契约: 新立 BC-36 (默认排除名单) / BC-37 (目标类别判定) / BC-38 (疑似安装树默认跳过与 `--force` 放行) / OF-13 (疑似行保后缀与末尾跳过说明); 并同步修订 BC-09 (内置默认名单项零命中不告警的例外) / BC-26 (退出码含「有跳过」) / BC-30 (帮助含 `--force` 行与默认排除名单说明) / OF-03 (路径后缀剥离的例外);
> ② 修语料: 新增三条 — `scan-default-exclude-install-tree` (背书 BC-36 / BC-09)、`delete-suspect-install-tree-skip` (背书 BC-37 / BC-38 / BC-26)、`delete-force-includes-suspect` (背书 BC-38 / BC-23); 既有期望逐条未动;
> ③ 同步既有语料 `cli-help`: 命令面新增 `--force` 行、说明段新增默认排除名单与 `--force` 口径, 逐字节期望随 BC-30 改写同步 — 属需求变更引发的同步 (期望由条款原文推演), 非基准降级;
> ④ 实现侧与条款同批落地 (`classify.ts` 判定 / `config.ts` 默认名单 / `cli.ts` 批次构造与退出码 / `render.ts` 保后缀与尾注), 双载体 (bun / node) 全量各跑一遍全绿 (52/52);
> ⑤ 变异自证**已在本轮重跑** (2026-09-24): `make-mutants.ts` 重建六个 mutant (含新增 `classify.ts` / `help.ts` 的副本, 锚点全部命中), 逐一对全量语料 (52 条) 跑验收器并三连跑;
> 六 mutant 抓取数 30 / 12 / 3 至 5 (波动) / 5 / 7 / 29, 数字为本次实测, 第三节数字表已据此改写; 三条新语料落在注入面上, 四个 mutant 的抓取数被抬高 (归因与逐条增量见第三节末的重测校准段)。
>
> **信任锚换位修复一轮的定责记录 (2026-09-24)**: 本轮属**改契约 + 补防线** (删除前的根锚点检查改变了「配置根为符号链接 + `--yes`」的行为: 旧版照删, 新版整批拒绝), 各改动逐条定责:
> ① 修契约: 新立 BC-39 (删除前的根锚点检查, 判在配置拼写形态上); BC-21 去掉「四」字计数并指向 BC-39, BC-38 与 `deletion-guard.md` / `cli-surface.md` / `install-tree-hardening.md` / `architecture-overview.md` 等处散落的「四不变量」措辞同步去数字化 (计数属会漂移的派生事实, 不写死);
> ② 修语料: 新增两条 — `delete-root-symlink-anchor-rejected` (根自身为符号链接) 与 `delete-root-ancestor-symlink-rejected` (根的祖先链被换成符号链接), 均背书 BC-39 与 BC-26 (整批拒绝的退出码面); 既有期望逐条未动: 尤其 `scan-root-symlink-followed` (BC-11 扫描侧骨架) 实跑仍绿, 即「扫描照常 / 删除拒绝」的分工不冲突 (同一场景下预览退 0、`--yes` 退 1, 属预期分叉而非条款打架);
> ③ 实现侧与条款同批落地: `guard.ts` 第五道不变量 (纯判定 `firstSymlinkOnAnchor` / `anchorChainPaths` + IO 层逐级 lstat); `delete.ts` 链头判定与 `TrustRoot` (配置拼写 + realpath 归一的类型强制配对); `cli.ts` 接线改 `trustRoots`; `fixtures.ts` 的 workspace root 改 realpath 归一 (使测试根为真实路径形态, 与 `run-conformance.ts` 既有惯例一致);
> ④ 本轮双载体 (bun / node) 全量各跑一遍全绿 (54/54);
> ⑤ 变异自证**已在本轮重跑** (2026-09-24): 重建六个 mutant (锚点全部命中) 并对全量语料 (54 条) 两连跑;
> `prune-negated` 30 → 32 与 `exit-swallowed` 12 → 14 两个数字上调 (两条新语料各贡献 +1, 归因经子集复跑实证), 第三节数字表已据此改写 (逐条归因见第三节末的重测校准段)。
>
> **信任锚换位连带 (CIA 扫描) 一轮的定责记录 (2026-09-24)**: 本轮属**改契约 + 补防线** (向导的逐根校验新增根锚点形态检查: 旧版放行「向导通过、`--yes` 全拒」的符号链接根, 新版当场提示并重问), 各改动逐条定责:
> ① 修契约: BC-30 补记帮助新增的「删除侧根形态口径」行; BC-39 与 `deletion-guard.md`「校验不变量」5 的锚点链端点表述改写 (「自文件系统根至根自身」→「自根的一级子目录至根自身, 文件系统根本身不入链」, 与实现 `anchorChainPaths` 对齐, 属描述纠正而非行为变更); `config-and-initialization.md`「配置初始化模型」补记逐根校验新增的形态面, `cli-surface.md` 的校验失败行登记随之补一形;
> ② 同步语料: 既有语料 `cli-help` 的逐字节期望新增一行 (随 BC-30 补记) — 属需求变更引发的同步, 期望由条款原文推演, 非基准降级; 其余既有期望逐条未动, 本轮无新增语料 (向导行为是 TTY 专属面, 非 TTY 入口直接报错, 黑盒面无语料可造, 登记见「二、未覆盖条款」);
> ③ 实现侧与条款同批落地: `init.ts` 的根校验补形态分支 (判定经 `guard.ts` 新导出的 `firstSymlinkOnRoot` 复用, 向导侧与删除侧口径唯此一处)、`cli.ts` 接线、`init.test.ts` 补两条模块级用例、`init.smoke.ts` 补真实壳 `symlink-root` 场景 (冒烟基路径改 realpath 归一: macOS 的 tmpdir 穿在 `/var` 符号链接下, 正是本轮要拒的形态); 另修 `createReadlineIO` 一处潜伏缺陷 (提问间的真实等待让 EOF 抢先落地时, 已到达的缓冲行会被丢、后续提问静默折算取消; 由新校验引入的 IO 等待暴露, 单行探针与两载体冒烟实证);
> ④ 本轮双载体 (bun / node) 全量各跑一遍全绿 (54/54);
> ⑤ 变异自证**已在本轮重跑** (2026-09-24): 重建六个 mutant (锚点全部命中) 并对全量语料 (54 条) 跑一遍, 六项抓取数 32 / 14 / 3 / 5 / 7 / 29, 与第三节数字表逐项一致 (`sort-missing` 3 落在其波动区间内), 数字表维持不变 (见第三节末的重测校准段)。

> **诊断面净化 (C3) 一轮的定责记录 (2026-09-25)**: 本轮属**改契约 + 补防线** (旧版净化只挂在清单显示名上,
> 诊断 stderr 原样直写: 磁盘路径 / `du` 的 stderr 原文 / 名单拼写 / 参数原文均可携控制字节直达终端,
> 换行还能把一条告警劈成两行、伪造出一行可信输出; `--yes` 下 stdout 为空, 该面是删除前唯一可见信息), 各改动逐条定责:
> ① 修契约: 新立 OF-14 (输出面净化: 覆盖清单 / stderr 诊断 / `config` 报告 / 向导回显 / `--help` 的默认配置位置行五面,
> 剥离集与空白折叠、行首缩进保留、诊断面不附净化提示、向导落盘回显块的排除项一并写明); `cli-surface.md`「输出规格」的
> 净化条目与 stderr 条目同步指向该条款;
> ② 修语料: 新增三条 — `scan-unreadable-dir-control-bytes` (磁盘目录名带 ESC, 背书 BC-08 / OF-12 / OF-14)、
> `scan-unmatched-name-control-bytes` (配置名单拼写带 ESC + 换行 + RLO, 背书 BC-09 / OF-12 / OF-14)、
> `cli-unknown-arg-control-bytes` (argv 带同款样本, 背书 BC-27 / OF-12 / OF-14); 既有期望逐条未动;
> ③ 实现侧与条款同批落地: 净化提升为单源导出 (`render.ts` 的 `sanitizeLine` 由原私有 `oneLine` 重命名导出,
> 另增保留行首缩进的 `sanitizeOutputLine`), `cli.ts` 的 `warn` / `notice` 两处 stderr 出口与 `config` 报告路径行、
> `init.ts` 的五处外部路径回显 (含第一问 hint 的默认值) 改为同源消费; 清单面行为逐字节不变 (金样本 `render-preview-sanitized.txt` 与
> `robustness.render.test.ts` 全绿为证);
> ④ 新语料的抓取力以**一次性阴性对照**实证 (未固化 mutant, 归因需长期护栏时再议): 在把 `cli.ts` 两处出口净化摘除的副本上三条全 FAIL,
> 失败详情正是审计描述的三形 (ESC 直写 / 换行劈行 / RLO 直写); 正常副本上逐条通过;
> ⑤ 本轮双载体 (bun / node) 全量各跑一遍全绿 (57/57);
> ⑥ 变异自证**已在本轮重跑** (2026-09-25): 重建六个 mutant (锚点全部命中; `cli.ts` 的锚点行号随本轮注释位移而锚点仍稳),
> 对全量语料 (57 条) 跑一遍, 六项抓取数 34 / 15 / 5 / 5 / 7 / 31, 第三节数字表已据此改写; 归因经子集复跑实证
> (剔除三条新语料的 54 条上回落至 32 / 14 / 5 / 5 / 7 / 29, 与上一轮记录逐项一致; 差集即三条新语料的贡献:
> 两条含清单与体积断言的语料各贡献 `prune-negated` 与 `size-unit-wrong` 的 +1 (合计 +2 / +2),
> 参数错误条贡献 `exit-swallowed` 的 +1; 其余三个 mutant 的抓取集合不含新语料)。

> **C3 连带处置 (CIA 扫描) 一轮的定责记录 (2026-09-25)**: 本轮属**改契约 + 补防线 + 补护栏**, 各改动逐条定责:
> ① 修契约: OF-14 的覆盖面补 `--help` 的默认配置位置行 (该行插值读 `os.homedir()`, 实测坐实: HOME 带 ESC 时 `--help` 输出含原形控制字节),
> 并把向导落盘回显块的排除理由收窄为如实版: 内容源是本轮用户答案 (非磁盘 / 他方数据), 承诺与落盘文件逐字一致供对照复制,
> 净化会破坏该承诺; JSON 转义只覆盖 C0 类, DEL / C1 / bidi / 零宽 / BOM 在该面以原形保留, 属已知缺口 (接受):
> 旧措辞「内容经 JSON 转义故 C0 控制字符不以原形出现」覆盖不了后几类; `cli-surface.md` 的输出规格净化条目 / stderr 条目 / 修订表、
> `config-and-initialization.md` 的「向导内容」条 / 修订表与 `init.ts` 回显块附近的注释同源改写;
> ② 修实现 (两处外部数据面补齐同源净化): `help.ts` 的默认配置位置行套 `sanitizeLine` (与 `cli.ts` 的 `config` 报告路径行同坐标);
> `init.ts` 第一问 hint 的默认值改「缩写在前、净化在后」: 该处 `shortenHome(home, home)` 取值恒为 `~`, 净化是坐标一致而非可观测改写,
> 一并如实登记 (无对应可造的控制字节输入, 故不造语料、不写无法判别的断言);
> ③ 补护栏 (阴性对照实证缺口): CIA 扫描的阴性对照已实证「摘除 `notice` 出口净化后 57 语料 + 343 测试全绿」, 即该缺陷形态无护栏,
> 故在 `cli.sanitize.e2e.test.ts` (参数化双 runner, 一例即双载体覆盖) 补两条: notice 面 (回退态 cwd 带 ESC / RLO / 换行, 经无配置 `--yes` 硬拒的
> `将扫的根` 行露出) 与帮助面 (HOME 带同款样本, 经默认配置位置行露出); **阴性对照已实测**: 在摘除对应处净化的副本上, 两条用例逐条 FAIL
> (bun / node 两 runner 各一), 正常副本上全绿;
> ④ 派生表重跑 (第一节表自述由 jq 机械汇总, 上轮只手工补了 OF-14 一行): 全表按 `corpus/*.json` 的 `specRefs` 重跑, 五处数字据实测修正:
> BC-08 1 → 2、BC-09 2 → 3、BC-27 3 → 4、OF-12 9 → 12 (上轮三条新语料未重算) 与 BC-36 2 → 3 (上批遗漏); 复核: 悬空引用为空,
> 契约内有而表内无的 8 条恰为「未覆盖条款」的登记项, 第 8 行自述句与事实相符;
> ⑤ 登记不改项: 其一, `cli.sanitize.e2e.test.ts` 的参数错误用例与语料 `cli-unknown-arg-control-bytes` 场景重叠, 属分层冗余 (语料走黑盒验收器,
> e2e 走双运行时冒烟), 接受; 其二, `docs/designs/install-tree-hardening.md` 的零净化表述无强制连带, 该文件本批不动 (登记事实);
> 其三, 第三节变异数字表与定责记录一致, 本轮改动不落在任何 mutant 的注入面;
> ⑥ 变异自证**已在本轮重跑** (2026-09-25): 重建六个 mutant (锚点全部命中, 行号 `scan-parallel.ts:171` / `:194` / `:301`、`cli.ts:739`、
> `render.ts:181`、`size-du.ts:76`) 并对全量语料 (57 条) 跑一遍, 六项抓取数 34 / 15 / 5 / 5 / 7 / 31, 与第三节数字表逐项一致, 数字表维持不变;
> ⑦ 本轮双载体 (bun / node) 全量各跑一遍全绿 (57/57); 模块级测试 347 条全绿 (基线 343 + 新增 2 用例 × 双 runner)。

> **写入侧锚点 (安全审计 C4) 一轮的定责记录 (2026-09-25)**: 本轮属**改契约 + 补防线** (旧版 `init` 的落盘通道对「目标是不是链接」零判定:
> 覆盖确认回显用户给的拼写、`mkdir` 与 `writeFile` 双双跟随符号链接, 落盘会完整改写链接目标 (任意可写文件), 而回执报的仍是原拼写,
> 事后看不出实际写到哪; 前提是把 `--config` 指向他人可布置的路径), 各改动逐条定责:
> ① 修契约: 新立 BC-40 (写入前的配置路径锚点检查); `config-and-initialization.md`「配置初始化模型」补该条与「配置规格」的 `roots` 条目呼应,
> `cli-surface.md` 的向导校验失败行登记补配置路径锚点一形 (重问的是「确认写入?」这一问);
> ② 修实现: `guard.ts` 新增面向任意目标的组合入口 `firstSymlinkOnTarget`, 删除侧的 `firstSymlinkOnRoot` 改为委托同一实现 (逐级 lstat 与坐标唯此一处),
> 经 `InitDeps.firstSymlinkOnTarget` 注入 `init.ts` (照 `firstSymlinkOnRoot` 先例, 由 `cli.ts` 直传同一函数引用); `init.ts` 在确认写入后、任何写动作 (含建目标目录) 之前判形态,
> 命中即红色 `✗` 给出链接定位与配置拼写并重问「确认写入?」(与逐根校验同形), 路径修好前不写一个字节; 拒绝行经 `sanitizeLine` (C3 净化面, 链接位置来自磁盘、配置拼写来自旗标 / 环境变量, 同属外部数据);
> ③ 本轮无新增语料: 向导是 TTY 专属面 (入口即要求 TTY, 见 BC-29), 语料运行器无 pty 通道, 拿不到 `init` 的落盘面, 故按既有先例登记「未覆盖条款」(见下 BC-40 行), 不硬造语料; 既有语料期望逐字节未动;
> ④ 模块级护栏: `init.test.ts` 增 5 条 (自身为链接被拒并重问后取消 / 父目录某级为链接同样拒 / 拒绝后重问转好则同一轮照常落盘 / 正常路径通过且判定收到的正是配置拼写 / 拒绝行净化) 并单立 describe;
> `guard.contract.test.ts` 增 5 条真实文件系统用例 (目标自身为链接 / 祖先链某级为链接 / 悬空链接 / 全链真身含尚未创建的末段 / 与 `firstSymlinkOnRoot` 同源同结论);
> ⑤ 真实壳: `init.smoke.ts` 增 `symlink-config` 场景: 配置路径被换成指向无关第三方文件的符号链接, 断言写入未发生 (state 为 cancelled)、**链接目标逐字未动**、配置路径仍是符号链接;
> ⑥ 本轮双载体 (bun / node) 全量各跑一遍全绿 (57/57); 模块级测试 357 条全绿 (基线 347 + 新增 10 条);
> ⑦ 变异自证**已在本轮重跑** (2026-09-25): 重建六个 mutant (锚点全部命中, `cli.ts` 锚点行号随本轮 import 展开由 739 位移至 745, 锚点文本未动),
> 对全量语料 (57 条) 跑一遍, 六项抓取数 34 / 15 / 5 / 5 / 7 / 31, 与第三节数字表逐项一致, 数字表维持不变 (本轮改动不落在任何 mutant 的注入面:
> `init.ts` / `guard.ts` / `init.test.ts` / `init.smoke.ts` 均不在注入文件清单内);
> ⑧ 派生一致性复核 (jq): 契约 60 条中未被语料引用者 9 条 (BC-13 / BC-21 / BC-22 / BC-40 / EC-01 至 EC-04 / EC-06),
> 与「二、未覆盖条款」的登记项逐条对应, 第 8 行自述句与事实相符; 第一节表与语料 `specRefs` 本轮均未变动;
> ⑨ 写入侧锚点连带 (CIA 处置, 行为不变): 新增 1 条模块级用例 (悬空链接的两问先后: 覆盖判重先出覆盖一问、随后在写入面被拒),
> 模块级 358 条全绿 (前项 357 + 本条 1); 改动落在注释与文档面 (判定实现与语料均未动), 变异自证仍按重跑纪律实测:
> 重建六个 mutant (锚点全部命中) 并对全量语料 (57 条) 跑一遍, 六项抓取数 34 / 15 / 6 / 5 / 7 / 31, 与第三节数字表逐项一致
> (`sort-missing` 本轮实测 6, 该 mutant 数字随调度波动、判据取 ≥2, 仍属其观察段登记的形态), 数字表维持不变; 双载体 (bun / node) 全量语料各跑一遍全绿 (57/57)。

> **设备边界 (安全审计 C6) 一轮的定责记录 (2026-09-27)**: 本轮属**改契约 + 补防线** (旧版全链不看设备维度: 目标子树位于另一文件系统时 `du` 照常计量、删除照常发生, 报告写「成功」), 各改动逐条定责:
> ① 修契约: 新立 BC-41 (设备边界: 目标与所属根不同文件系统即逐条跳过, 两形态 on-path / target-itself 的解除路径各按事实) 与 OF-15 (跨设备行的标注 / 跳过说明 / 末行说明行); BC-26 的退出码列举补「跨设备目标」; BC-38 补与 BC-41 的边界一行 (`--force` 不放行跨设备; 后者属授权面, 不是语义面); `deletion-guard.md` 新增「设备边界」节并把挂载点屏障的实测更正与子挂载点残留面写进「残余风险」, `scan-and-size.md`「体积统计」补口径与设备边界的差异登记 (含 `du -x` 评估结论), `cli-surface.md` 清单面补跨设备行登记;
> ② 本轮无新增语料, 也**未改任何既有期望**: 跨设备场景造不出来: 黑盒运行器只建目录树 (fixture schema 无挂载通道), 而 `st_dev` 由内核给出、不可伪造; macOS 侧虽有 `hdiutil`, 但挂载属宿主级动作 (Linux 侧更需 root), 不适配「确定性、零 AI、语言中立」的语料运行器。故按 EC-02 先例登记「未覆盖条款」(见下 BC-41 / OF-15 行), 判定本体与接线由模块级与 e2e 两层钉死 (见 ④);
> ③ 实现侧与条款同批落地: `guard.ts` 新增 `findCrossDeviceTargets` (设备探针 `DeviceProbe` 可注入, 目标取 lstat / 根取 stat, 归属取最具体根, 仅对跨设备目标补探父目录以分辨形态) 与 `fsDeviceProbe`; 新立 `skip.ts` (两类跳过目标: 疑似安装树与跨设备的判定集、批次排除与全部文案单源; `cli.ts` 因 `max-lines` 闸门达到上限, 该层只留接线: 条目成型前接一次判定、跨设备条目落 note、批次与说明行走 `skip.ts`); `render.ts` 未动 (标注走既有 note 通道);
> ④ 分层护栏: 设备边界的模块级用例另立 `guard.device.contract.test.ts` (10 条: 同设备不挑 / 两形态分形 / 父目录补探只对跨设备目标做 / 最具体根优先即解除路径 / 无归属根与不可核验不挑 / 父目录不可核验归 on-path / win32 归属折叠 / 跨盘符不判 / win32 父目录按注入风格解析 (形态分辨不落宿主平台的 `dirname`) / 真实文件系统同卷对照; 原 `guard.contract.test.ts` 触 `max-lines` 上限, 按主题分文件与 `cli.*.e2e.test.ts` 同例); 新增 `cli.cross-device.e2e.test.ts` (双载体参数化, macOS + hdiutil 门控, 非 macOS 整组跳过) 两用例: 两形态的预览标注与 `--yes --force` 仍跳过 (卷内内容逐字完好、根内其余目标照常删除)、on-path 声明独立根后照常删除而 target-itself 仍跳过;
> ⑤ 本轮双载体 (bun / node) 全量语料各跑一遍全绿 (57/57), 既有期望逐条未动 (设备判定在无挂载的 fixture 上恒为空集, 属结构性不触发, 非期望放宽);
> ⑥ 变异自证**已在本轮重跑** (2026-09-27): 重建六个 mutant (锚点全部命中; `cli.ts` 锚点行号随本轮改动由 745 位移至 753, 锚点文本未动) 并对全量语料 (57 条) 两连跑 (收口态重跑): 34 / 15 / 2 至 3 (该 mutant 数字随调度波动, 判据取 ≥2, 本次落在其登记区间内) / 5 / 7 / 31, 与第三节数字表逐项一致, 数字表维持不变 (本轮改动不落在任何 mutant 的注入面: 注入文件为 `scan-parallel.ts` / `cli.ts` 末行 / `render.ts` / `size-du.ts`, 新增判定在 `guard.ts` 且既有语料不触发);
> ⑥′ 新增护栏的阴性对照 (一次性, 未固化 mutant, 与 C3 轮同例): 在 `~/tmp` 副本上把 `guard.ts` 的设备比对改成恒返回空集, 设备边界两组 14 条中 10 条 FAIL (e2e 四条全中, 模块级六条: 断言「挑出」与「形态分辨」的两条、父目录不可核验归 on-path、探针语义与调用次数、最具体根优先的对照、win32 父目录解析; FAIL 数为本轮重跑重数所得), 恢复原实现后 14 条全绿, 该组对「跨设备判定缺失」这一缺陷形态确有抓取力;
> ⑦ 派生一致性复核 (jq): 契约 62 条中未被语料引用者 11 条 (BC-13 / BC-21 / BC-22 / BC-40 / BC-41 / OF-15 / EC-01 至 EC-04 / EC-06), 与「二、未覆盖条款」的登记项逐条对应; 悬空引用为空, 第 8 行自述句与事实相符; 第一节表本轮未变动 (无新增语料);
> ⑧ 实测记录 (本地, 判据「修复前后行为对照」): 用 `hdiutil` 建 8 MiB 映像挂进 fixture 根, 修复前 `--yes` 把另一设备上的 `node_modules` 照删并报成功 (退 0); 修复后同一现场按形态跳过、卷内文件逐字未动、退 1, 声明独立根后照常删除。另实测更正了审计对「挂载点屏障」的否证: 该屏障在 node 侧成立, 但 bun 侧对「目标内部含非空子挂载点」的删除会下探删掉卷内内容 (两运行时对撞记录见 `deletion-guard.md`「残余风险」)。
> ⑨ CIA 连带 (第 4 轮 CIA 收敛扫描扫出, 行为不变): `guard.ts` 的 `PathOps` 增加 `dirname`: 形态分辨探父目录时须按注入的 path 风格解析 (落宿主平台的 `dirname` 会把 win32 路径按 posix 语义切分), 并新增 1 条模块级用例 (`guard.device.contract.test.ts` 的 win32 父目录解析条); 模块级 453 → 454, 计数落点与同步见下「运行时解析 (安全审计 C10)」⑨。
> ⑩ 已知未钉住面 (如实登记): 「疑似安装树 × 跨设备」同时命中的组合面: 清单行尾 note 两类理由并置、放行说明取设备侧 (设备侧 `--force` 放行不了, 提示取更严的一侧); 目前无语料与 e2e 钉住 (语料面疑似安装树一侧由 `delete-suspect-install-tree-skip` 单钉, 跨设备一侧不可黑盒, 见下「二、未覆盖条款」BC-41 / OF-15 行; e2e 现场只造跨设备目标, 未叠加安装树形态), 取舍依据见 `src/skip.ts` 的注释 (两类同时命中时设备说明后写入胜出); 登记为已知未钉住面。
> ⑪ CIA 连带 (第 3 轮 CIA 收敛扫描扫出, 行为不变): 测试侧清理自愈。`fixtures.ts` 增 `removeDirResilient`: 至多 3 轮「rm + 复查现场」, 每轮 rm 后以 lstat 复核存在性 (判据不看错误码: Bun 的 fs.rm 在并发删除下会静默半途而废, 挂载点活跃时抛 EBUSY), 仍删不净即降级为警告并留现场待人工, 绝不抛断调用方收尾链; 工作区清理 (`makeWorkspace` 的 cleanup) 与 `delete.node-smoke.ts` 收尾均改走此路。`cli.cross-device.e2e.test.ts` 补「挂载 / 卸载双侧容错」: 卸载侧 `detachWithRetry` 至多 3 次、退避 200ms, afterEach 未卸掉的登记 `stuckMounts` 留到 afterAll 再试, 两处失败都降级为警告而不抛断 (抛断会让数组复位不执行、现场跨用例累积); 挂载侧 `attachWithRetry` 至多 3 次、退避 0 / 500 / 1000ms 线性拉长 (attach 比 detach 慢一截, 且挂不上即整条用例失去现场, 容错预算比卸载侧给得更宽), 只包 `hdiutil attach` 这一原子步骤 (断言与用例体都不进重试面, 真实逻辑错误不被退避掩盖), 只在实际挂上时才登记 `mounted` (没挂上即无现场残留)。环境不可用按两道注册期门控分流, 不制造假 FAIL: 第一道门 `hdiutil info` 只证命令在, 第二道门 `probeMountCapability` 按用例同路径真挂一次 (共享映像与副本各一) 再卸掉, 探针不过即整组经 `test.skipIf` 跳过 (与非 macOS 门控同形态, 失败原因播报一次); 运行期挂载一线耗尽重试的用例以「`[Skip]` 播报 + 早退不跑用例体」等价落地, 并由 afterAll 的 `[Warning]` 汇总, 不让跳过静默成假绿。实测约束: bun:test 无运行时动态 skip (用例体内 `test.skip()` 当场抛错并记 fail), 故早退用例在汇总里仍计 pass, 跳过事实靠播报暴露而非状态位。验证方式取「宿主残留零新增」: 全量套件跑完后核对宿主临时目录无 `sweep-lab-*` 残留目录、宿主挂载表无遗留映像卷 (本次复核: 跑前 / 跑后残留目录均为 0, 附挂映像数均为 5)。

> **rm 阶段 ENOENT 分桶 (安全审计 C8) 一轮的定责记录 (2026-09-27)**: 本轮属**改契约 + 修实现** (旧版把 rm 阶段任何 ENOENT 一律归 `missing` 成功侧, 依据是「链路已全验为真目录, 消失的即目标本体」这一仅在 Node 侧成立的前提; 实测 Bun 侧不成立: 删除途中内部条目消失会被冒泡为顶层 ENOENT 且错误形态与顶层缺失逐字段同形, 目标仍占盘而报告写成功、退出码 0), 各改动逐条定责:
> ① 修契约: 新立 EC-07 (rm 阶段 ENOENT 须先复核目标本体: 确认已消失才归 `missing`; 目标仍在或复核不可达归 `failed`); EC-01 (TOCTOU 真消失归 missing) 语义不变、保持原样, 两者边界: EC-01 管「目标确实消失」, EC-07 管「错误码声称消失而本体仍在」的兜底; `deletion-guard.md` 的「执行语义」ENOENT 阶段两分条目改写、「错误与边界」表对应行改写、「残余风险」补双运行时对撞实测登记、修订记录补一行;
> ② 本轮无新增语料, 也**未改任何既有期望**: 「删除中途内部条目消失」需竞态时序缝 (另一并发删除者), CLI 黑盒面不可静态构造, 按 EC-01 / EC-02 先例登记「未覆盖条款」(见下 EC-07 行);
> ③ 修实现: `delete.ts` 的 rm 阶段 catch 分支在 ENOENT 时先做一次目标本体复核 (`checkGone`, lstat 三态 gone / present / unknown), 仅确认已消失才归 `missing`, 其余归 `failed` (新增 `describeSurvivor` 文案, 复用 `PARTIAL_DELETION_HINT` 的内容残缺复查提示); `fixtures.ts` 增竞态构造辅助 (`makeWideTree` / `startChildRacer`) 供双载体用例共用;
> ④ 分层护栏: `delete.contract.test.ts` 增竞态压测用例 (bun 侧, 10 轮实测全落 `failed`; 硬断言为不变量「missing 桶 ⟹ 目标本体真已消失」), 并接 `delete.node-smoke.ts` 子进程直跑 (未装 node 时 skip); 新增 `delete.node-smoke.ts` (node 侧直跑: 顶层缺失归 missing / 正常删除 / 竞态压测不变量 + node 侧「rm 不冒泡」实测形态断言);
> ⑤ 红绿对照 (一次性, 与 C3 / C6 轮同例): 旧实现下竞态用例 FAIL (归 missing 而目标仍存在), 新实现下全绿, 用例对「按错误码乐观分类」这一缺陷形态确有抓取力;
> ⑥ 本轮双载体 (bun / node) 全量语料各跑一遍全绿 (57/57); 模块级测试 427 条全绿 (基线 425 + 新增 2 条);
> ⑦ 变异自证**已在本轮重跑** (2026-09-27): 重建六个 mutant (锚点全部命中) 并对全量语料 (57 条) 跑一遍, 六项抓取数 34 / 15 / 4 (该 mutant 数字随调度波动, 判据取 ≥2, 本次落在其登记区间内) / 5 / 7 / 31, 与第三节数字表逐项一致, 数字表维持不变 (本轮改动不落在任何 mutant 的注入面: 注入文件为 `scan-parallel.ts` / `cli.ts` 末行 / `render.ts` / `size-du.ts`);
> ⑧ 派生一致性复核 (jq): 契约 63 条中未被语料引用者 12 条 (BC-13 / BC-21 / BC-22 / BC-40 / BC-41 / OF-15 / EC-01 至 EC-04 / EC-06 / EC-07), 与「二、未覆盖条款」登记项逐条对应; 悬空引用为空; 第一节表本轮未变动 (无新增语料);
> ⑨ 实测记录 (本地双运行时对撞, 判据「同一竞态下两运行时的原始行为」): 大扇出树 (240 子目录, 并发删子项且恒保留 ≥ 2 个、绝不删根) 下, node v26.7.0 40/40 不抛 (内部条目 ENOENT 归一为成功), bun 1.4.2 40/40 抛顶层 ENOENT 且抛错后目标本体仍在 (残留 169 至 236 个条目); 端到端 (removeTargets) 修复前 20/20 落 `missing` (目标仍在的伪成功), 修复后 20/20 落 `failed`; node 侧修复后 20/20 落 `removed` 且目标确实消失。

## 一、条款 × 语料覆盖

| 条款  | 用例数 | 覆盖用例                                                                                                                                                                                                                                                                                                                                                                        |
| ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BC-01 | 2      | scan-basic-preview, scan-nested-prune                                                                                                                                                                                                                                                                                                                                           |
| BC-02 | 1      | scan-symlink-not-followed                                                                                                                                                                                                                                                                                                                                                       |
| BC-03 | 2      | scan-exclude-cli-merge, scan-exclude-config                                                                                                                                                                                                                                                                                                                                     |
| BC-04 | 2      | scan-multi-root-dedupe, scan-symlink-not-followed                                                                                                                                                                                                                                                                                                                               |
| BC-05 | 1      | scan-git-bait                                                                                                                                                                                                                                                                                                                                                                   |
| BC-06 | 3      | scan-basic-preview, scan-multi-root-dedupe, scan-order-target-asc                                                                                                                                                                                                                                                                                                               |
| BC-07 | 3      | scan-root-eacces-warn, scan-root-is-file-warn, scan-root-missing-warn                                                                                                                                                                                                                                                                                                           |
| BC-08 | 2      | scan-unreadable-dir-control-bytes, scan-unreadable-dir-warn                                                                                                                                                                                                                                                                                                                     |
| BC-09 | 3      | scan-default-exclude-install-tree, scan-exclude-unmatched-warn, scan-unmatched-name-control-bytes                                                                                                                                                                                                                                                                               |
| BC-10 | 1      | scan-root-is-node-modules                                                                                                                                                                                                                                                                                                                                                       |
| BC-11 | 1      | scan-root-symlink-followed                                                                                                                                                                                                                                                                                                                                                      |
| BC-12 | 1      | render-tier-mid-and-order                                                                                                                                                                                                                                                                                                                                                       |
| BC-14 | 1      | size-unmeasured-preview                                                                                                                                                                                                                                                                                                                                                         |
| BC-15 | 1      | size-unmeasured-blocks-delete                                                                                                                                                                                                                                                                                                                                                   |
| BC-16 | 4      | cli-config-env-source, cli-config-flag-source, config-env-source, config-flag-over-env                                                                                                                                                                                                                                                                                          |
| BC-17 | 1      | config-explicit-missing-hard-error                                                                                                                                                                                                                                                                                                                                              |
| BC-18 | 2      | cli-no-config-non-tty-cwd-fallback, config-env-source                                                                                                                                                                                                                                                                                                                           |
| BC-19 | 3      | config-corrupt-json, config-corrupt-shape-roots-missing, config-shape-item-type                                                                                                                                                                                                                                                                                                 |
| BC-20 | 2      | config-corrupt-shape-roots-missing, config-exclude-default-ok                                                                                                                                                                                                                                                                                                                   |
| BC-23 | 4      | cli-no-config-non-tty-cwd-fallback, delete-execute-ok, delete-force-includes-suspect, scan-basic-preview                                                                                                                                                                                                                                                                        |
| BC-24 | 2      | delete-execute-multi-summary, delete-execute-ok                                                                                                                                                                                                                                                                                                                                 |
| BC-25 | 1      | delete-partial-failure-shell                                                                                                                                                                                                                                                                                                                                                    |
| BC-26 | 12     | cli-no-config-non-tty-cwd-fallback, cli-no-config-yes-hard-reject, config-corrupt-json, config-explicit-missing-hard-error, delete-execute-multi-summary, delete-execute-ok, delete-partial-failure-shell, delete-root-ancestor-symlink-rejected, delete-root-symlink-anchor-rejected, delete-suspect-install-tree-skip, render-empty-result, size-unmeasured-blocks-delete     |
| BC-27 | 4      | cli-extra-positional, cli-missing-value, cli-unknown-arg, cli-unknown-arg-control-bytes                                                                                                                                                                                                                                                                                         |
| BC-28 | 1      | cli-no-config-yes-hard-reject                                                                                                                                                                                                                                                                                                                                                   |
| BC-29 | 1      | cli-init-non-tty                                                                                                                                                                                                                                                                                                                                                                |
| BC-30 | 1      | cli-help                                                                                                                                                                                                                                                                                                                                                                        |
| BC-31 | 2      | scan-include-cli-merge, scan-include-config                                                                                                                                                                                                                                                                                                                                     |
| BC-32 | 2      | scan-ancestor-excluded-unmatched-warn, scan-include-exclude-priority                                                                                                                                                                                                                                                                                                            |
| BC-33 | 3      | scan-ancestor-excluded-unmatched-warn, scan-include-exclude-priority, scan-include-unmatched-warn                                                                                                                                                                                                                                                                               |
| BC-34 | 1      | scan-node-modules-and-git-in-lists-noop                                                                                                                                                                                                                                                                                                                                         |
| BC-35 | 3      | cli-config-default-source, cli-config-env-source, cli-config-flag-source                                                                                                                                                                                                                                                                                                        |
| BC-36 | 3      | cli-help, config-exclude-default-ok, scan-default-exclude-install-tree (非 TTY 面; 向导排除一问为 TTY 专属, 见下)                                                                                                                                                                                                                                                               |
| BC-37 | 1      | delete-suspect-install-tree-skip                                                                                                                                                                                                                                                                                                                                                |
| BC-38 | 2      | delete-force-includes-suspect, delete-suspect-install-tree-skip                                                                                                                                                                                                                                                                                                                 |
| BC-39 | 2      | delete-root-ancestor-symlink-rejected, delete-root-symlink-anchor-rejected                                                                                                                                                                                                                                                                                                      |
| OF-01 | 4      | render-banner-4-roots, render-empty-result, render-path-tilde, scan-basic-preview                                                                                                                                                                                                                                                                                               |
| OF-02 | 4      | render-tier-mid-and-order, scan-basic-preview, scan-order-target-asc, size-unmeasured-preview                                                                                                                                                                                                                                                                                   |
| OF-03 | 13     | delete-execute-ok, render-align-cjk, render-path-tilde, scan-basic-preview, scan-exclude-cli-merge, scan-exclude-config, scan-git-bait, scan-include-cli-merge, scan-include-config, scan-include-exclude-priority, scan-nested-prune, scan-root-symlink-followed, scan-symlink-not-followed                                                                                    |
| OF-04 | 1      | render-tier-mid-and-order (小 / 中两档; 大档见下)                                                                                                                                                                                                                                                                                                                               |
| OF-05 | 1      | render-tier-mid-and-order                                                                                                                                                                                                                                                                                                                                                       |
| OF-06 | 1      | render-align-cjk                                                                                                                                                                                                                                                                                                                                                                |
| OF-07 | 4      | render-empty-result, scan-root-eacces-warn, scan-root-is-file-warn, scan-root-is-node-modules                                                                                                                                                                                                                                                                                   |
| OF-08 | 1      | scan-basic-preview                                                                                                                                                                                                                                                                                                                                                              |
| OF-09 | 4      | delete-execute-multi-summary, delete-execute-ok, delete-force-includes-suspect, size-unmeasured-blocks-delete                                                                                                                                                                                                                                                                   |
| OF-10 | 2      | cli-help, render-no-color-degraded (非 TTY 面; TTY 彩色面见下)                                                                                                                                                                                                                                                                                                                  |
| OF-11 | 2      | size-unmeasured-blocks-delete, size-unmeasured-preview                                                                                                                                                                                                                                                                                                                          |
| OF-12 | 12     | cli-help, cli-unknown-arg, cli-unknown-arg-control-bytes, scan-ancestor-excluded-unmatched-warn, scan-basic-preview, scan-default-exclude-install-tree, scan-exclude-unmatched-warn, scan-include-unmatched-warn, scan-root-missing-warn, scan-unmatched-name-control-bytes, scan-unreadable-dir-control-bytes, scan-unreadable-dir-warn (非 TTY 面; 名单回执为 TTY 专属, 见下) |
| OF-13 | 2      | delete-force-includes-suspect, delete-suspect-install-tree-skip                                                                                                                                                                                                                                                                                                                 |
| OF-14 | 3      | cli-unknown-arg-control-bytes, scan-unmatched-name-control-bytes, scan-unreadable-dir-control-bytes (非 TTY 面; 向导回显与 TTY 着色面见下)                                                                                                                                                                                                                                      |
| EC-05 | 1      | delete-partial-failure-shell                                                                                                                                                                                                                                                                                                                                                    |

## 二、未覆盖条款 (显式标注与理由)

| 条款                      | 状态                  | 理由                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BC-13                     | 不可黑盒 (竞态)       | 「target 在扫描命中后、体积统计前消失」需竞态时序缝, CLI 黑盒面不可静态构造; 语义与 EC-01 同源 (模块级已钉死)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| BC-21 / BC-22             | 不可黑盒 (竞态)       | 安全闸「拒绝 → 整批拒绝」需在校验与删除之间换掉目标 (转写 / 逃逸 / 重复), 属竞态时序缝; 语义见 `deletion-guard.md`「校验不变量」, 模块级已钉死。根锚点分支不属此列 (符号链接根为静态可造态, 已由 BC-39 的两条语料黑盒验收)                                                                                                                                                                                                                                                                                                                                                                          |
| BC-36 向导子句            | TTY 专属面 (需 pty)   | 「向导的排除一问以该名单为默认回填」只在真终端可触达 (入口即要求 TTY, 见 BC-29), 语料运行器无 pty 通道; 空答取默认名单与提示段 (`回车采用默认名单 (N 条)`) 由 `init.test.ts` 模块级钉死, 真实壳路径由 `init.smoke.ts` 钉死; 条款其余子句 (缺省值 / 覆盖语义 / 零命中静默) 已由语料覆盖                                                                                                                                                                                                                                                                                                              |
| 向导逐根校验 (不编条款号) | TTY 专属面 (需 pty)   | 「不存在的根与落在符号链接路径上的根当场提示并重问」只在真终端可触达 (入口即要求 TTY, 见 BC-29), 语料运行器无 pty 通道; 两形提示与重问回路由 `init.test.ts` 模块级钉死, 真实壳路径 (含符号链接根被拒后重问) 由 `init.smoke.ts` 的 `symlink-root` 场景钉死; 权威出处见 `config-and-initialization.md`「配置初始化模型」, 与删除侧同口径的判定在 `guard.ts` (BC-39)                                                                                                                                                                                                                                   |
| EC-01                     | 不可黑盒 (竞态)       | TOCTOU missing 桶同上                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| EC-02                     | 不可黑盒 (竞态)       | 与 BC-21 / BC-22 同源                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| EC-03                     | 不可黑盒 (平台矩阵)   | win32 路径折叠与 `%APPDATA%` 默认路径需 win32 宿主 (或平台 CI); 模块级注入 `platform` 已钉死                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| EC-08                     | 不可黑盒 (平台矩阵)   | 外部命令解析面不含 cwd 需 win32 宿主实跑 (CreateProcessW 与 libuv 的裸名搜索序是否先搜 cwd); 模块级注入单测已钉死 win32 分支, POSIX 面有实跑对照 (command -v 与 Node 裸名 spawn 均不命中 cwd 里的同名探针)                                                                                                                                                                                                                                                                                                                                                                                          |
| EC-04                     | 不可黑盒 (不可造)     | 「符号链接作删除目标只删链接本身」: 扫描不跟进符号链接, 黑盒面拿不到这样的删除目标; 模块级已钉死                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| EC-06 / OF-04 大档        | 成本性未覆盖          | 大档 (≥ 512 MiB) 展示需真实写入 512 MiB 数据 (du 按磁盘块占用计, 稀疏文件不产生占用), 是现行最大 fixture (100 MiB) 的 5 倍量级, 仍超语料运行预算; 档位逻辑经小 / 中两档与 OF-05 覆盖, 大档判定分支另由 `render.test.ts` 对 `TIER_BIG` 两侧的边界断言钉死 (重判结论: 阈值下调只减半成本、量级未变, 替代护栏已实证存在, 维持豁免)                                                                                                                                                                                                                                                                     |
| EC-07                     | 不可黑盒 (竞态)       | 「rm 阶段 ENOENT 须先复核目标本体再归 `missing`」需「删除中途内部条目消失」的竞态时序缝 (另一并发删除者在递归途中删掉子项), CLI 黑盒面不可静态构造; 判定本体 (`delete.ts` 的 `checkGone` 三态分桶) 由 `delete.contract.test.ts` 的竞态压测 (bun 侧, 10 轮实测全落 `failed`) 与 `delete.node-smoke.ts` 直跑 (node 侧, 实测 rm 不冒泡、无伪成功) 双载体钉住; 双运行时对撞数据与语义见 `deletion-guard.md`「执行语义」「残余风险」                                                                                                                                                                     |
| OF-10 TTY 彩色面          | TTY 专属面 (需 pty)   | 彩色 / 着色只在 TTY 下开启, 需 pty 承载 (语料运行器无 pty 通道, e2e 侧 pty 冒烟未覆盖此面); 非 TTY 降级面已覆盖 (`config` 子命令的着色版同属此面)                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 运行时自述                | TTY 专属面 (需 pty)   | 顶栏尾部的运行时版本段 (` · bun 1.4.2`) 仅在 stdout 为真终端时出现, 非 TTY 下整段省略, 需 pty 承载; 不编条款号, 见 `behavior-contract.md`「OF」区注                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 名单回执                  | TTY 专属面 (需 pty)   | 顶栏下方的 `░ 排除生效 / 包含命中` 回执所在行同属 TTY 专属面 (非 TTY 下整段省略), 需 pty 承载; 名单未匹配警示走 stderr, 那一面已由语料覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 初始化向导视觉面          | TTY 专属面 (需 pty)   | 向导的顶栏 / 中性块前缀 / 压暗提示段只在真终端存在 (入口即要求 TTY, 非 TTY 下 `init` 报错退出, 无降级形态); 语料运行器无 pty 通道, e2e 侧伪终端冒烟覆盖流程 (不逐字节断言视觉); 向导内容与三态出口由 `init.test.ts` / `init.smoke.test.ts` 模块级钉死; 不编条款号, 见 `behavior-contract.md`「TTY 专属输出面」注                                                                                                                                                                                                                                                                                    |
| BC-40                     | TTY 专属面 (需 pty)   | 「`init` 落盘前拒符号链接配置路径并重问该问」只在真终端可触达 (入口即要求 TTY, 见 BC-29), 语料运行器无 pty 通道; 判定本体 `guard.ts` 的 `firstSymlinkOnTarget` 由 `guard.contract.test.ts` 的真实文件系统用例钉死 (目标自身 / 祖先链 / 悬空链接 / 全链真身), 向导侧的拒绝、重问回路与「链接目标逐字未动」由 `init.test.ts` 与 `init.smoke.ts` 的 `symlink-config` 场景 (双载体) 钉死; 权威出处见 `config-and-initialization.md`「配置初始化模型」                                                                                                                                                   |
| BC-41 / OF-15             | 不可黑盒 (需真实挂载) | 跨设备场景需要真实挂载点: `st_dev` 由内核给出、造不了假, fixture schema 无挂载通道, 黑盒运行器也无权 (且不宜) 做宿主级挂载 (macOS 需 `hdiutil`、Linux 需 root), 与套件「确定性、零 AI、语言中立」的定位相斥。判定本体由 `guard.device.contract.test.ts` 的注入探针用例钉死 (两形态分辨 / 归属取最具体根 / 探针语义与调用次数 / 不可核验不判 / win32 折叠 / 真实文件系统同卷对照), 端到端接线由 `cli.cross-device.e2e.test.ts` 在 macOS (hdiutil 可用时) 的真实挂载现场钉死: 该组在非 macOS 宿主整组跳过, 属平台性豁免而非未测; 挂载点屏障与子挂载点残留面的实测另见 `deletion-guard.md`「残余风险」 |
| OF-14 向导回显子句        | TTY 专属面 (需 pty)   | 向导的五处外部路径回显 (覆盖确认里的配置路径 / 不存在的根 / 符号链接根 / 第一问 hint 的默认值 / 写入回执路径) 只在真终端可触达 (入口即要求 TTY), 语料运行器无 pty 通道; 净化本体是同一纯函数 (render.ts 的 sanitizeLine, 由 robustness.render.test.ts 的纯函数断言钉死), 向导侧的调用由 init.test.ts 的模块级用例钉死 (控制字节样本经回显行剥除; hint 处的取值恒为 `~`, 其上游无可达控制字节输入, 该调用只保坐标一致, 故无独立可观测断言); 条款其余子句 (诊断面 / `config` 报告面 / 帮助面 / notice 面) 已由三条语料与 `cli.sanitize.e2e.test.ts` 的 notice / 帮助两用例覆盖                        |

## 三、变异自证 (语料抓缺陷能力)

inject mutant (经 `make-mutants.ts` 从冻结源复制 + 单行级补丁生成), 逐一对全量语料 (本次快照) 跑:
**全部被抓住** (判据要求 ≥2 条用例; 该门槛对全部 mutant 均有实测支撑, 含抓取面最窄者)。六个 mutant 中除 `sort-missing` 外,
本轮 (诊断面净化轮) 重跑数字为 34 / 15 / 5 / 5 / 7 / 31, 相对上一轮的上调逐条归因于三条新语料 (见第三节末的重测校准段); `sort-missing` 见下方观察, 数字本身不稳定。

| mutant (注入缺陷)                | 抓住它的用例数 | 代表用例                                                                   |
| -------------------------------- | -------------- | -------------------------------------------------------------------------- |
| prune-negated (剪枝谓词取反)     | 34             | scan-basic-preview, scan-nested-prune, scan-include-config                 |
| exit-swallowed (退出码吞掉)      | 15             | cli-unknown-arg, config-corrupt-json, size-unmeasured-blocks-delete        |
| sort-missing (排序缺失)          | 波动 (见观察)  | delete-execute-multi-summary, scan-basic-preview                           |
| exclude-silent (排除静默失效)    | 5              | scan-exclude-config, scan-exclude-cli-merge, scan-include-exclude-priority |
| message-removed (提示语删改)     | 7              | render-empty-result, render-banner-4-roots, scan-include-unmatched-warn    |
| size-unit-wrong (体积计数单位错) | 31             | render-tier-mid-and-order, scan-basic-preview, scan-include-cli-merge      |

观察: `sort-missing` 抓取面最窄, 因它依赖「并发完成序 ≠ 升序」是否在本次调度中落败,
抓到的用例数随调度波动, 是本表唯一数字不稳定的 mutant (多次重跑从未见 0 抓);
其判据按该随机性取 ≥2 (与其余 mutant 同口径)。**本 mutant 无每轮必抓的用例**: 同体积清单类语料
(`scan-order-target-asc` 与 `scan-include-cli-merge`) 与 `delete-execute-multi-summary`
等命中率最高, 但放大样本后仍见缺席轮, 故本 mutant 的抓取集合整体随调度浮动。

> **`config` 子命令一轮的重测校准 (2026-09-24)**: 随本轮全量重跑一并重测全部 mutant (三连跑逐条一致)。
> 两个数字相对本表旧值上调: `exclude-silent` 3 → 4、`message-removed` 6 → 7; 归因已实证:
> 用剔除 `scan-ancestor-excluded-unmatched-warn` 的子集语料复跑, 两者即回落至 3 / 6, 故增量的来源即该条语料。
> 该条由 `8f9e9b8` 引入, 而该提交只重算了本表第一部分的覆盖关系 (三行), 未重测变异自证, 属遗留漂移, 本轮以实测校准。
> 本轮新增的三条 `cli-config-*` 语料不被任何 mutant 抓住: mutant 注入面在扫描 / 渲染 / 退出码主链路上, 与 `config` 子命令无交集。

> **信任锚换位修复一轮的重测校准 (2026-09-24)**: 该轮新增两条语料 (`delete-root-symlink-anchor-rejected` / `delete-root-ancestor-symlink-rejected`),
> 重建六个 mutant (锚点全部命中, `cli.ts` 行号随本轮改动位移而锚点仍稳) 并对全量语料 (54 条) 两连跑, 逐条一致。
> 两个数字相对上一轮上调: `prune-negated` 30 → 32、`exit-swallowed` 12 → 14 (`exclude-silent` / `message-removed` / `size-unit-wrong` 不变; `sort-missing` 本轮实测 2 至 4, 仍属调度波动);
> 归因已实证: 用 `fd` 剔除两条新语料后的子集语料 (52 条) 复跑, 两者即回落至 30 / 12, 故增量的来源即这两条语料 (各贡献 +1)。
> 注入面解释: 两条新语料走「扫描命中 → 删除前置检查」主链路, 故被剪枝谓词反转 (清单为空, 拒绝文案不再出现) 与退出码吞掉 (期望 1 实得 0) 两面抓住; 其余四个 mutant 的注入点与删除前置检查无交集。

> **安全审计修复一轮的重测校准 (2026-09-24)**: 该轮新增三条语料 (`scan-default-exclude-install-tree` / `delete-suspect-install-tree-skip` / `delete-force-includes-suspect`), 随本轮全量重跑一并重测全部 mutant (三连跑)。
> 四个数字相对上一轮上调: `prune-negated` 27 → 30、`exit-swallowed` 11 → 12、`exclude-silent` 4 → 5、`size-unit-wrong` 26 → 29 (`message-removed` 不变; `sort-missing` 仍属调度波动);
> 归因: 三条新语料落在扫描剪枝与体积数字两面 (`prune-negated` 与 `size-unit-wrong` 各 +3), 其中 `delete-suspect-install-tree-skip` 另命中退出码面 (计入 `exit-swallowed` 的 +1), `scan-default-exclude-install-tree` 另命中排除判定面 (计入 `exclude-silent` 的 +1);
> 各 mutant 的抓取集合剔除三条新语料后恰等于上一轮数字, 差集自洽即归因依据, 未另做子集复跑。

> **信任锚换位连带 (CIA 扫描) 一轮的重测校准 (2026-09-24)**: 该轮改动不落在任何 mutant 的注入面
> (补丁锚点所在文件为 `cli.ts` / `scan-parallel.ts` / `size-du.ts` / `render.ts`, 且 `cli.ts` 的锚点
> `process.exitCode = await main();` 未动), 仍按重跑纪律实测核对: 重建六个 mutant (锚点全部命中) 并对全量语料 (54 条) 跑一遍,
> 六项抓取数 32 / 14 / 3 / 5 / 7 / 29, 与第三节数字表逐项一致 (`sort-missing` 3 落在其波动区间 2 至 4 内), 数字表维持不变, 无增量归因需登记。
> 本轮新增的三处用例面 (`init.test.ts` 两条模块级用例、`init.smoke.ts` 的 `symlink-root` 场景) 均不在语料与 mutant 面内, 不影响本表任何数字。

> **诊断面净化 (C3) 一轮的重测校准 (2026-09-25)**: 本轮新增三条语料 (`scan-unreadable-dir-control-bytes` /
> `scan-unmatched-name-control-bytes` / `cli-unknown-arg-control-bytes`), 随之重建六个 mutant (锚点全部命中) 并对全量语料 (57 条) 跑一遍。
> 三个数字相对上一轮上调: `prune-negated` 32 → 34、`exit-swallowed` 14 → 15、`size-unit-wrong` 29 → 31
> (`exclude-silent` / `message-removed` 不变; `sort-missing` 本轮实测 5, 落在其波动区间); 归因已实证:
> 用 `--corpus` 指向剔除三条新语料的子集 (54 条) 复跑, 三者即回落至 32 / 14 / 29, 与上一轮记录逐项一致,
> 差集即三条新语料的贡献 (两条扫描类语料带清单与体积断言, 各贡献 `prune-negated` 与 `size-unit-wrong` 的 +1;
> 参数错误条期望退出码 1, 贡献 `exit-swallowed` 的 +1)。三条新语料不在 `sort-missing` / `exclude-silent` /
> `message-removed` 的注入面上, 三者数字不变。
> 另: 三条新语料对「诊断出口净化被摘除」这一缺陷形态的抓取力, 以**一次性阴性对照**实证 (把 `cli.ts` 两处出口净化摘除的副本上
> 三条全 FAIL, 失败详情即 ESC 直写 / 换行劈行 / RLO 直写三形; 正常副本上三条全 PASS), 未固化 mutant。

> **安全审计 C7 闭环一轮的定责记录 (2026-09-27)**: 审计条目 `DU-QUOTING-BATCH-SUPPRESSION` (du 输出形态一处不符即整批 unmeasured, 单个目录名可让整批清理静默变 no-op)
> 主张的机制链为「GNU du 非 TTY 下对不可打印字符做 C 风格转义 → 一致性校验失败 → 整批降级」。本轮核实结论: **「整批降级」这一段在代码上成立**
> (单批任一形态不符即整批 `unmeasured`、不进删除批, 审计的 trace 逐条属实), **但触发它的「非终端转义」前提不成立**; 故本轮属**核证 + 可诊断性加固 + 形态固化**,
> 按「前提证伪, 防线保留」定责, 各改动逐条登记:
> ① 核证 (三重证据): 官方手册 du 节点原文 `When standard output is a terminal, file names are quoted using the shell-escape style` (仅终端时引用);
> 源码 `du.c` 以 `isatty (STDOUT_FILENO)` 门控 quoting, 且 9.12 之前的版本 `print_size` 无引用逻辑 (v8.32 / v9.1 / v9.4 / v9.7 逐版核对);
> 实测 GNU du 9.12: 非终端 (管道) 下 27 种名称形态 (TAB / ESC / BEL / 引号 / 反斜杠 / 中文 / 空格 / 通配符) 逐字原样, `QUOTING_STYLE` 环境变量在非终端下亦不生效,
> 同组路径在 pty 下才出现 `'...'` / `"..."` / `$'\t'` 引用形态; 本快路径以管道捕获 stdout, 恒非终端。旁证: BSD du (macOS 实测) 与 BusyBox / toybox 的 du 实现 (源码 printf 直出) 均无引用行为。
> ② 修实现 (`size-du.ts`): 抽出导出 `assessDuOutput` (解析 + 一致性判定 + 不符形态归类), `measure` 消费之; 整批降级时**新增一条随附告警** (交代后果与形态归类
> `同一路径多行` / `含输入之外的路径`), 使「什么都没删」可被归因: 原实现只有逐条 `输出不可解析` 占位, 成因不可辨; 告警文案不含 du 输出的原始路径 (零低信任内容, 故不新增净化点, C3 口径不变);
> `createDuSizer` 增可选 `bin` 入参 (供测试注入 GNU du, 生产调用不传); 文件头补「输出形态」依据, 删除原「非 TTY 转义会扩大触发面」的 `[证据缺口]` 注释 (该说被证伪)。
> **防线未动**: 判据仍是「输出须全部来自输入且无重复」, 不符仍整批降级, 未引入逐条采信 (审计要求的「保持防伪造强度」)。
> ③ 修契约 / 注释: `scan-and-size.md`「体积统计」补「输出形态 (已核实)」条目与降级告警说明, 「错误与边界」表相应行改写为「du 输出与输入集合不符 / 目标无法归因」;
> `scripts/transcription/fixture.ts` 的 `QUOTING_STYLE` 白名单注释修正: 原注释「非 TTY 下默认对文件名做 shell 转义, 强制 literal」与事实相反 (且该白名单并不改写宿主值, 仅放行)。
> **不新立 BC 条款**: 行为面 (整批降级) 已由 `scan-and-size.md`「解析防御」钉住, 新增告警属诊断面, 无语料背书需求。
> ④ 模块级测试: 新增 `size-du.output-shape.test.ts` 10 条 (非终端怪名样本全采信 / 输出少于输入不降级 / 空输出不降级 / 终端引用形态样本整体降级 / 引用与字面混排整体降级 /
> 伪行整体降级 / 重复整体降级 / 注入假 du 的 measure 端到端三条: 集合外路径整批落 unmeasured 且告警可归因、重复同降级、形态正常零告警), 引用形态样本逐字取自 GNU du 9.12 + pty 实测;
> `size.contract.test.ts` 增 2 条 (探针 du 与注入 gdu 的怪名 target 逐字保真, 后者无 gdu 宿主整条跳过) 并修正原 `[证据缺口]` 注释。**既有期望一律未动** (只增不改)。
> ⑤ 本轮无新增语料, 登记为「形态不可黑盒 / 断言面退化」类豁免: 终端引用形态本就不在黑盒运行器的可达面内 (它走管道, 无 pty 通道, 与「未覆盖条款」各 TTY 行同源);
> 而怪名 target 的保真面即便造得出来, 其逐字节期望也会与显示层净化 (render.ts `sanitizeLine` 剥 C0 控制字节并标注「名字已净化显示」) 交互, 断言退化为「负向断言 + fs 断言」,
> 增量价值低于 ④ 的模块级用例组 (后者还能注入引用形态样本与 GNU du 实测), 故不硬造语料, 替代护栏即 ④。
> ⑥ 变异自证**已在本轮重跑** (2026-09-27): 重建六个 mutant (锚点全部命中; `size-du.ts` 锚点随本轮文件头增行由 76 位移至 80, 锚点文本未动) 并对全量语料 (57 条) 各跑一遍,
> 六项抓取数 34 / 15 / 5 / 5 / 7 / 31, 与第三节数字表逐项一致, 表维持不变 (`sort-missing` 本轮实测 5, 落在其波动区间内)。
> ⑦ 本轮双载体 (bun / node) 全量各跑一遍全绿 (57/57); 模块级测试 425 条全绿 (基线 413 + 新增 12)。

> **运行时解析 (安全审计 C10) 一轮的定责记录 (2026-09-27)**: 审计条目 `runtime-resolution:bare-name-cwd-precedence-windows` (三入口挑运行时的裸名解析可能先搜当前工作目录, 被扫目录内放一个同名可执行文件即可顶替真实运行时进入执行链)。本轮核实结论: **前提成立**, 属**补防线 + 修实现 + 修契约**; 各改动逐条登记:
> ① 核证 (官方文档 + 上游源码): CreateProcessW 的搜索序把「parent 的当前目录」排在 PATH 之前 (微软 CreateProcessW / CreateProcessA 文档的参数节); Node 走的 libuv 亦以 `NeedCurrentDirectoryForExePathW` 门控先试 cwd 再扫 PATH, 且扩展名只试 `.com` / `.exe` (libuv `src/win/process.c` 的 `search_path` / `path_search_walk_ext`); `where` 命令默认搜索含当前目录 (官方 where 文档), cmd 的裸名执行同理 (官方 path 文档: the current directory is always searched before the directories specified in the command path)。缓解机制 `NoDefaultCurrentDirectoryInExePath` 存在但默认不设 (官方 `NeedCurrentDirectoryForExePathW` 文档), 不能当承重手段。
> ② 修实现 (三入口): `bin/sweep-nm.mjs` 在 win32 下先按 PATH 解析绝对路径再探测与执行 (新增 `resolveWin32Executable` / `pickRuntime`: 只认绝对目录条目, 空条目与相对条目在 Windows 上均意为当前目录故不解析, 引号包裹的条目剥引号; 扩展名面与 libuv 等价), POSIX 分支维持裸名不动 (execvp 只搜 PATH); `bin/sweep-nm.cmd` 弃用 `where` 判定与裸名赋值, 改用 for 的 PATH 展开修饰符 (官方 for 文档: 只搜 PATH), 并把解析出的绝对路径交给末行执行; `bin/sweep-nm` (sh) 经核证**无需改动** (`command -v` 与 `exec` 的裸名查找本就只按 PATH), 仅补证据注释。
> ③ 同型修复 (审计附带发现): `size-du.ts` 的 `findDu` 加平台守卫 (win32 一律返回 null): du 探针是 POSIX 绝对路径, 在 Windows 上会被解析为「当前盘根」下的 `usr\bin\du`, 与被扫目录同盘时构成同类执行链劫持面; 该守卫同时把设计侧「无 du 平台走纯 JS 候选」的语义落到实现。
> ④ 修契约: 新立 EC-08 (外部命令解析面不含当前工作目录); EC-03 补实现守卫的指代 (`findDu` 在 win32 一律返回 null)。ADR 0007 决策第 3 / 4 条各补记一段。
> ⑤ 分层护栏: 新增 `launcher.runtime-resolution.test.ts` 13 条: win32 分支经注入 platform / pathEnv / 探针钉死 (相对与空条目不入解析面、扩展名顺序 .com 先于 .exe、引号条目、pickRuntime 的 win32 与 POSIX 分岔), 三入口解析形态静态钉住 (防回调回裸名与含 cwd 的搜索), POSIX 面另有实跑对照 (command -v 与 node 裸名 spawn 均不命中 cwd 里的同名可执行探针, 并配「PATH 挂上后即命中」的对照组); `size.contract.test.ts` 增 2 条 (`findDu('win32') === null`, 非 win32 不受守卫影响)。
> ⑥ 本轮无新增语料: 劫持面需真实 win32 宿主与「被扫目录内放同名可执行文件」的执行现场, 黑盒运行器不可造; 登记为「未覆盖条款」表 EC-08 行。
> ⑦ 真机缺口 (如实登记): win32 侧的解析防御 (mjs 的 PATH 解析与 cmd 的 PATH 展开) 及 `.cmd` 启动器整体均未经真机实跑, 属既有 `[证据缺口]` 的适用面 (ADR 0007 决策第 4 条补记)。
> ⑧ 变异自证**已在本轮重跑** (2026-09-27): 重建六个 mutant, 锚点全部命中 (`size-du.ts` 锚点随本轮 findDu 注释与文件头增行由 80 位移至 91, 锚点文本未动)。
> ⑨ 本轮双载体 (bun / node) 全量语料各跑一遍全绿 (57/57); 模块级测试 454 条全绿 (基线 438 + 新增 16, 其中 1 条为 C6 轮 CIA 连带所增, 见上「设备边界 (安全审计 C6)」⑨)。
> ⑩ 派生一致性复核 (jq): 契约 64 条, 被语料引用 51 条; 未被引用者 13 条 (BC-13 / BC-21 / BC-22 / BC-40 / BC-41 / OF-15 / EC-01 至 EC-04 / EC-06 / EC-07 / EC-08) 与「二、未覆盖条款」登记项逐条对应; 悬空引用为空; 第一节表本轮未变动 (无新增语料);
