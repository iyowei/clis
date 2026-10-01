/**
 * 档位裁剪: 三档 (core / standard / full) → 「删除路径集 + ci 步骤摘除集 + 根 package.json
 * 脚本摘除集」, 并对模板目录执行裁剪。
 *
 * 档位语义与裁剪点约定以 docs/designs/capability-tiers.md 为权威: 满档 = 全部装备; 标准档 =
 * 满档减去「增强档」; 核心档 = 标准档再减去「标准档」。每套装备的裁剪 = 删除它的文件 + 删除
 * 它在 `scripts/ci.ts` 里的步骤声明与根 `package.json` 里的脚本声明 (裁剪点约定, 2026-09-30
 * 单源化后成立; 脚本面 2026-10-01 终审补: 机制件删了而 `bun run <script>` 入口仍留在根
 * package.json, 实跑必死)。
 *
 * 消费方: 生成主流程 (Task 7) 在「按档裁剪」一步调 pruneTemplate (见
 * docs/designs/scaffold-contract.md 流程第 3 步)。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 装备档位 */
export type Tier = 'core' | 'standard' | 'full';

/** 一次裁剪要动的三处: 模板内的删除路径集 + `scripts/ci.ts` 的步骤摘除集 + 根 `package.json` 的脚本摘除集 */
export interface RemoveRule {
  /** 相对模板根的删除路径 (目录以 `/` 收尾); 规则与模板不同步时 pruneTemplate 抛错 */
  readonly deletePaths: readonly string[];
  /** 从 STEPS 表与组数组一并摘除的步骤名; 其载体文件须同在 deletePaths 内 */
  readonly ciSteps: readonly string[];
  /** 从根 `package.json` 的 scripts 一并摘除的脚本名; 其命令引用的载体文件须同在 deletePaths 内 (不摘会留下悬空脚本, 生成物 `bun run <脚本>` 必死) */
  readonly packageScripts: readonly string[];
}

/** 增强档机制件目录 (capability-tiers.md§增强档「转写契约套件」: 行为契约 + 金样本语料 + 确定性验收器 + 变异自证) */
const CONFORMANCE_KIT_DIR = 'scripts/transcription/';

/** 标准档装备 (capability-tiers.md§标准档「技术债登记册」; 模板内为空册骨架) */
const TECH_DEBT_LEDGER = 'docs/designs/tech-debt.md';

/**
 * 增强档 ci 步骤:
 * - `lint:coverage` = §增强档「台账对账闸门 (契约 / 语料 / 豁免三方对账, 只对启用 conformance 的项目有意义)」;
 * - `conformance:bun` / `conformance:node` = 转写契约套件的执行挂载 (载体 run-conformance.ts 随机制件摘除)。
 */
const CONFORMANCE_CI_STEPS: readonly string[] = [
  'lint:coverage',
  'conformance:bun',
  'conformance:node',
];

/** 闸门清单 (步骤声明手术的对象): 模板根相对路径 */
const CI_SCRIPT = 'scripts/ci.ts';

/** 根包清单 (脚本声明手术的对象): 模板根相对路径 */
const ROOT_PACKAGE_JSON = 'package.json';

/**
 * 增强档装备在根 `package.json` 里的脚本挂载: `conformance` 的载体 run-conformance.ts 随
 * `scripts/transcription/` 整目录摘除; 不摘此脚本, core / standard 档生成物会留下一条指向
 * 不存在文件的 `bun run conformance` (实跑必死)。
 */
const CONFORMANCE_PACKAGE_SCRIPTS: readonly string[] = ['conformance'];

/**
 * 档位 → 裁剪规则 (逐条映射 docs/designs/capability-tiers.md「三档」清单)。
 *
 * 增强档 → full 之外的两档均摘:
 * - §增强档「转写契约套件 (conformance): 行为契约 + 金样本语料 + 确定性验收器 + 变异自证」
 *   → `scripts/transcription/` 整目录 (机制件; 语料与条款本是项目自填内容);
 * - §增强档「台账对账闸门 (`lint:coverage`)」与套件的执行挂载 → CONFORMANCE_CI_STEPS; 套件在
 *   根 `package.json` 的 `conformance` 脚本 → CONFORMANCE_PACKAGE_SCRIPTS (载体随机制件摘除,
 *   脚本不摘即悬空)。
 *   注 (T4 移交项): `scripts/transcription/api-harness.ts` 直连示例包源码面, 依赖其导出领域常量;
 *   模板骨架不含领域常量 (不把领域噪声钉进模板), 该文件随套件在 standard / core 一并摘除
 *   (两档自洽), 仅 full 保留。
 *
 * 标准档 → 仅 core 摘 (逐条映射如下):
 * - §标准档「多包分层: 工具 + 库 (薄壳模式); 单包工具可跳过本档的包结构部分」: 无文件删除 ——
 *   本模板的包结构是硬耦合 (scripts/lib/workspace.ts#resolveCliAndApi 要求 CLI 包与 API 包同时
 *   在场, 由 ci.ts 顶层调用; CLI 骨架经薄壳依赖 API 包; 根 tsconfig 双态 paths 亦映射两包源码),
 *   摘任一包都会打断生成物; 单包化需生成期重写而非删文件, 超出生成器定位 (产出独立的新集合仓,
 *   即双包集合仓形态), core 档对该条为形状选择 (两包形态保留), 不落删除;
 * - §标准档「依赖方向闸门: 依赖方向纪律由工具强制执行」: 无对应实现物 —— 该闸门在本仓尚属规划
 *   (docs/designs/dependency-direction.md「执行 (规划)」), 模板内无文件与步骤可摘; 落地后在此补;
 * - §标准档「测试体系: 契约测试 + e2e (双载体参数化) + 冒烟 (node-smoke 直跑)」: 无对应实现物 ——
 *   三类测试的实现件全在各包 src 槽位 (packages/<pkg>/src/), 该槽位已判 reset 本就不进模板;
 *   模板内剩余测试皆为核心档闸门 / 发布链各自的配套测试, 不属于本档装备;
 * - §标准档「技术债登记册」→ TECH_DEBT_LEDGER (模板内唯一本档文件载体)。
 *
 * 裁决 (2026-10-01, Task 5 评审闭合, 选项①): 上述三条「无独立可摘载体」判定经独立复核成立 ——
 * core 档对它们为形状选择 / 豁免, 不落任何文件删除; 「单包工具可跳过本档的包结构部分」按形状
 * 选择解读 (单包化超出生成器定位), 其措辞修订归 Task 9 文档同步 (capability-tiers.md)。
 */
const TIER_RULES: Readonly<Record<Tier, RemoveRule>> = {
  full: { deletePaths: [], ciSteps: [], packageScripts: [] },
  standard: {
    deletePaths: [CONFORMANCE_KIT_DIR],
    ciSteps: CONFORMANCE_CI_STEPS,
    packageScripts: CONFORMANCE_PACKAGE_SCRIPTS,
  },
  core: {
    deletePaths: [CONFORMANCE_KIT_DIR, TECH_DEBT_LEDGER],
    ciSteps: CONFORMANCE_CI_STEPS,
    packageScripts: CONFORMANCE_PACKAGE_SCRIPTS,
  },
};

/** 取某档的裁剪规则 (full 档为空规则 = 不裁剪) */
export function removeRulesFor(tier: Tier): RemoveRule {
  return TIER_RULES[tier];
}

/**
 * 按档裁剪模板目录: 删除 deletePaths 指向的文件 / 目录, 对 `scripts/ci.ts` 做步骤声明手术
 * (删「单个 STEPS 条目块」(含紧贴其上的注释行)、「组数组中的引用行」, 与「只服务被摘步骤的
 * 载体声明及其来源导入」), 并对根 `package.json` 做脚本声明手术 (摘除 packageScripts 列出的
 * scripts 条目)。
 *
 * 先全量校验 (路径存在 + 手术干跑与自检) 再落盘, 任一项不过即抛错且不留半成品。
 * 边界: 手术只做行级摘除, 不重排格式 (组数组缩为单元素后的折叠、载体摘除留下的空行都属格式化
 * 面, 由生成流程的格式化收口处置: T7 替换后统一跑 prettier, 见 task-4 报告「生成期格式化漂移」);
 * 根 package.json 的脚本面按 JSON 结构摘除后序列化回 2 空格缩进 (与模板既有 prettier 稳定态
 * 同形)。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   targetDir = '<生成物根>'  (模板快照副本)
 *   rules = removeRulesFor('standard')
 *         = { deletePaths: ['scripts/transcription/'],
 *             ciSteps: ['lint:coverage', 'conformance:bun', 'conformance:node'],
 *             packageScripts: ['conformance'] }
 *
 * 步骤 1：前置校验 (任一项不过即抛错)
 *   <targetDir>/scripts/transcription/ 存在 ✓  *(缺失即「裁剪路径不存在」)*
 *   STEPS 表条目摘三后 = ['build', 'typecheck', 'test', 'lint', 'format-check', 'lint:refs',
 *                        'lint:examples', 'lint:backups', 'npm-trust']  *(手术干跑)*
 *   'lint:coverage' 块引用的 scripts/transcription/validate-coverage.ts 在删除面内 ✓
 *   'conformance' 脚本存在, 且其命令引用的 scripts/transcription/run-conformance.ts 在删除面内 ✓
 *
 * 步骤 2：落盘
 *   删 <targetDir>/scripts/transcription/ (整目录)
 *   回写 <targetDir>/scripts/ci.ts: STEPS 少三条; VERIFY_GROUP 少 'lint:coverage';
 *   CONFORMANCE_GROUP 余 ['build'] (转写步骤引用行同步摘除); CLI 入口坐标块与它的
 *   resolveCliAndApi 导入随 conformance 步骤摘净 (摘后全文已无引用 = 只服务被摘步骤)
 *   回写 <targetDir>/package.json: scripts 少 'conformance', 其余脚本原样
 *
 * Output（数据契约）
 *   <targetDir> 内增强档机制件、其步骤声明、根包上的套件脚本与专属载体声明一并消失,
 *   其余文件逐字节原样
 * ```
 */
export function pruneTemplate(targetDir: string, rules: RemoveRule): void {
  for (const path of rules.deletePaths) {
    if (!existsSync(join(targetDir, path))) {
      throw new Error(`裁剪路径不存在: ${path} (裁剪规则与模板不同步)`);
    }
  }
  const ciPath = join(targetDir, CI_SCRIPT);
  let prunedCi: string | null = null;
  if (rules.ciSteps.length > 0) {
    if (!existsSync(ciPath)) {
      throw new Error(`模板缺少闸门清单: ${CI_SCRIPT} (步骤声明手术无处可施)`);
    }
    prunedCi = pruneCiSource(
      readFileSync(ciPath, 'utf8'),
      rules.ciSteps,
      rules.deletePaths,
    );
  }
  const packageJsonPath = join(targetDir, ROOT_PACKAGE_JSON);
  let prunedPackageJson: string | null = null;
  if (rules.packageScripts.length > 0) {
    if (!existsSync(packageJsonPath)) {
      throw new Error(`模板缺少根 ${ROOT_PACKAGE_JSON} (脚本声明手术无处可施)`);
    }
    prunedPackageJson = prunePackageScripts(
      readFileSync(packageJsonPath, 'utf8'),
      rules.packageScripts,
      rules.deletePaths,
    );
  }
  for (const path of rules.deletePaths) {
    rmSync(join(targetDir, path), { recursive: true, force: true });
  }
  if (prunedCi !== null) writeFileSync(ciPath, prunedCi);
  if (prunedPackageJson !== null) {
    writeFileSync(packageJsonPath, prunedPackageJson);
  }
}

/**
 * 脚本声明手术: 从根 `package.json` 的 scripts 摘除指定脚本名。
 *
 * 术前校验: 每个名字都在 scripts 表里 (缺名前即抛, 规则与模板不同步不算静默略过), 且该脚本
 * 命令引用的载体文件进删除面 (防摘除后悬空: 载体已删而脚本还在, `bun run <脚本>` 必死;
 * 与 ciSteps 的载体校验同构)。
 * 术后自检: 摘名零残留, 其余脚本逐项原样, 产物仍是合法 JSON。
 */
function prunePackageScripts(
  source: string,
  scripts: readonly string[],
  deletePaths: readonly string[],
): string {
  const parsed: unknown = JSON.parse(source);
  const table =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { scripts?: unknown }).scripts
      : undefined;
  if (typeof table !== 'object' || table === null || Array.isArray(table)) {
    throw new Error(
      `${ROOT_PACKAGE_JSON} 形态预期不符: 找不到 scripts 表 (脚本声明手术无法进行)`,
    );
  }
  const scriptsTable = table as Record<string, unknown>;
  const retained: Record<string, string> = {};
  for (const [name, command] of Object.entries(scriptsTable)) {
    if (typeof command === 'string' && !scripts.includes(name)) {
      retained[name] = command;
    }
  }
  for (const name of scripts) {
    const command = scriptsTable[name];
    if (typeof command !== 'string') {
      throw new Error(
        `脚本不存在: '${name}' 不在模板 ${ROOT_PACKAGE_JSON} 的 scripts 里 (裁剪规则与模板不同步)`,
      );
    }
    assertScriptCarriageDeleted(name, command, deletePaths);
  }
  for (const name of scripts) delete scriptsTable[name];
  const pruned = `${JSON.stringify(parsed, null, 2)}\n`;

  const afterScripts =
    (JSON.parse(pruned) as { scripts?: Record<string, string> }).scripts ?? {};
  for (const name of scripts) {
    if (name in afterScripts) {
      throw new Error(
        `脚本手术自检未过: '${name}' 仍残留在 ${ROOT_PACKAGE_JSON}`,
      );
    }
  }
  for (const [name, command] of Object.entries(retained)) {
    if (afterScripts[name] !== command) {
      throw new Error(
        `脚本手术自检未过: 保留脚本 '${name}' 在手术后发生变化 (${ROOT_PACKAGE_JSON})`,
      );
    }
  }
  return pruned;
}

/** 脚本载体未进删除面即抛错: 摘除脚本会让其命令引用的文件悬空 (与 ciSteps 的载体校验同构) */
function assertScriptCarriageDeleted(
  name: string,
  command: string,
  deletePaths: readonly string[],
): void {
  for (const match of command.matchAll(/scripts\/[A-Za-z0-9._/-]+/g)) {
    const referenced: string = match[0];
    const covered = deletePaths.some((path) =>
      path.endsWith('/') ? referenced.startsWith(path) : referenced === path,
    );
    if (!covered) {
      throw new Error(
        `脚本载体未进删除面: 摘除 '${name}' 会让 ${referenced} 悬空 (deletePaths 未覆盖); 脚本须与其载体文件同进裁剪面`,
      );
    }
  }
}

/**
 * 步骤声明手术: 逐名摘除 STEPS 条目块与组数组引用行, 再做「术后自检」——
 * 步骤名集合 = 术前 − 摘除集、被摘名零残留、STEPS 表仍闭合、全文件三对括号配平。
 */
function pruneCiSource(
  source: string,
  steps: readonly string[],
  deletePaths: readonly string[],
): string {
  const entries = locateStepEntries(source);
  const spans = steps.map((name) => {
    const entry = entries.get(name);
    if (entry === undefined) {
      throw new Error(
        `步骤不存在: '${name}' 不在模板 ${CI_SCRIPT} 的 STEPS 表里 (裁剪规则与模板不同步)`,
      );
    }
    assertCarriageDeleted(name, entry.body, deletePaths);
    return entry;
  });

  let pruned = removeSpans(source, spans);
  pruned = removeGroupReferences(pruned, steps);
  pruned = pruneOrphanedCarriers(pruned);
  assertStepSurgery(source, pruned, steps, entries);
  return pruned;
}

/** 一道 STEPS 条目的位置与原文 (start / end 含紧随其后的换行; body 为不含前置注释的条目块) */
interface StepEntry {
  start: number;
  end: number;
  body: string;
}

/** STEPS 条目声明行的形态: 两空格缩进 + 步骤名 (带引号或裸标识符) + `: {` */
const STEP_ENTRY_PATTERN =
  /^ {2}(?:'([^'\n]+)'|([A-Za-z_$][A-Za-z0-9_$]*)): \{/gm;

/** STEPS 表声明行 (表块配平自检与条目定位的锚点) */
const STEPS_DECLARATION = /^const STEPS\b[^\n]*= \{/m;

/** 定位 STEPS 表 (返回 `{` 与其配对 `}` 的下标); 找不到或未闭合即抛错 */
function locateStepsTable(source: string): { open: number; close: number } {
  const declaration = STEPS_DECLARATION.exec(source);
  if (declaration === null) {
    throw new Error(
      `${CI_SCRIPT} 形态预期不符: 找不到 STEPS 表声明 (步骤声明手术无法进行)`,
    );
  }
  const open = declaration.index + declaration[0].length - 1;
  return { open, close: findMatchingBrace(source, open) };
}

/** 走查 STEPS 表内的全部条目 (按出现顺序; 只认表块范围内的声明行) */
function locateStepEntries(source: string): Map<string, StepEntry> {
  const table = locateStepsTable(source);
  const entries = new Map<string, StepEntry>();
  for (const match of source.matchAll(STEP_ENTRY_PATTERN)) {
    const at = match.index;
    if (at <= table.open || at >= table.close) continue;
    const braceEnd = findMatchingBrace(source, at + match[0].length - 1);
    const lineEnd = source.indexOf('\n', braceEnd);
    if (lineEnd < 0) {
      throw new Error(`${CI_SCRIPT} 形态预期不符: 步骤条目未以换行收尾`);
    }
    const name = match[1] ?? match[2]!;
    entries.set(name, {
      start: expandOverAttachedComments(source, at),
      end: lineEnd + 1,
      body: source.slice(at, lineEnd + 1),
    });
  }
  return entries;
}

/** 条目块连带紧贴其上的注释行一并摘除 (条目自带的说明不留在生成物里当孤儿) */
function expandOverAttachedComments(
  source: string,
  entryStart: number,
): number {
  const lines = source.slice(0, entryStart).split('\n');
  lines.pop(); // 末元素是条目行之前的部分 (空串)
  while (
    lines.length > 0 &&
    lines[lines.length - 1]!.trimStart().startsWith('//')
  ) {
    lines.pop();
  }
  return lines.length === 0 ? 0 : lines.join('\n').length + 1;
}

/** 摘除步骤载体未进删除面即抛错: 步骤与其载体文件必须同进删除面, 否则生成物静默少一道闸门 */
function assertCarriageDeleted(
  name: string,
  body: string,
  deletePaths: readonly string[],
): void {
  for (const match of body.matchAll(/scripts\/[A-Za-z0-9._/-]+/g)) {
    const referenced: string = match[0];
    const covered = deletePaths.some((path) =>
      path.endsWith('/') ? referenced.startsWith(path) : referenced === path,
    );
    if (!covered) {
      throw new Error(
        `步骤载体未进删除面: 摘除 '${name}' 会让 ${referenced} 悬空 (deletePaths 未覆盖); 步骤须与其载体文件同进裁剪面`,
      );
    }
  }
}

/** 按 span 摘除文本片段 (span 按 start 升序、互不重叠) */
function removeSpans(source: string, spans: readonly StepEntry[]): string {
  let out = '';
  let cursor = 0;
  for (const span of [...spans].sort(
    (left, right) => left.start - right.start,
  )) {
    out += source.slice(cursor, span.start);
    cursor = span.end;
  }
  return out + source.slice(cursor);
}

/** 摘除组数组里的引用行 (行内容恰为 `'<步骤名>',`) */
function removeGroupReferences(
  source: string,
  steps: readonly string[],
): string {
  const referenced = new Set(steps.map((step) => `'${step}',`));
  return source
    .split('\n')
    .filter((line) => !referenced.has(line.trim()))
    .join('\n');
}

/** CLI 入口坐标块 (前置注释行 + 两行声明 + 紧随的空行), 形态与模板 `scripts/ci.ts` 逐行同形 */
const CLI_COORDINATE_BLOCK =
  /\/\*\* CLI 入口坐标[^\n]*\nconst \{ cli \} = resolveCliAndApi\(process\.cwd\(\)\);\nconst CLI_SRC = [^\n]*\n\n?/;

/** 坐标块的来源导入 (只服务坐标块) */
const CLI_COORDINATE_IMPORT =
  /^import \{ resolveCliAndApi \} from '\.\/lib\/workspace\.ts';\n/m;

/**
 * 术后载体摘除: 「只服务被摘步骤」的顶层声明与其来源导入一并摘净。
 *
 * 动因 (T8 heavy-smoke 首跑实测): 步骤声明手术原本只摘 STEPS 条目与组数组引用, 留下 CLI 入口
 * 坐标块 (它只被 conformance 步骤消费); core / standard 档生成物的 lint 随即以 no-unused-vars
 * 三连打红 (CLI_SRC → cli → 来源导入), 与「生成物开箱即绿」的契约冲突; 摘净后才与删除面自洽
 * (载体文件删了, 消费它的声明也不留)。
 *
 * 判据取「把坐标块摘掉后全文再无 CLI_SRC 引用」这个可判定信号: 只服务被摘步骤才摘, 将来若有
 * 保留步骤也消费它则整块保留; 来源导入同理 (还有别的调用点则保留)。
 */
function pruneOrphanedCarriers(source: string): string {
  const block = CLI_COORDINATE_BLOCK.exec(source);
  if (block === null) return source;
  const withoutBlock = source.replace(block[0], '');
  if (withoutBlock.includes('CLI_SRC')) return source;
  const withoutImport = withoutBlock.replace(CLI_COORDINATE_IMPORT, '');
  return withoutImport.includes('resolveCliAndApi')
    ? withoutBlock
    : withoutImport;
}

/** 术后自检: 步骤名集合对账 + 被摘名零残留 + STEPS 表闭合 + 全文件括号配平 */
function assertStepSurgery(
  source: string,
  pruned: string,
  steps: readonly string[],
  entries: ReadonlyMap<string, StepEntry>,
): void {
  const expected = [...entries.keys()].filter((name) => !steps.includes(name));
  const actual = [...locateStepEntries(pruned).keys()];
  if (
    actual.length !== expected.length ||
    expected.some((name) => !actual.includes(name))
  ) {
    throw new Error(
      `步骤手术自检未过: STEPS 表期望 [${expected.join(', ')}], 实得 [${actual.join(', ')}]`,
    );
  }
  for (const name of steps) {
    if (pruned.includes(`'${name}'`)) {
      throw new Error(`步骤手术自检未过: '${name}' 仍残留在 ${CI_SCRIPT}`);
    }
  }
  assertBracketsBalanced(pruned);
  assertBracketsBalanced(source); // 术前基线: 源文件本身必须配平, 否则规则无从判定
}

/** 全文件三对括号配平自检 (`()` / `[]` / `{}`; 引号与注释内的括号不计) */
function assertBracketsBalanced(source: string): void {
  const closers: Readonly<Record<string, string>> = {
    '(': ')',
    '[': ']',
    '{': '}',
  };
  const stack: string[] = [];
  for (const { char } of codeChars(source)) {
    if (char in closers) stack.push(closers[char]!);
    else if (char === ')' || char === ']' || char === '}') {
      if (stack.pop() !== char) {
        throw new Error(
          `括号配平自检未过: ${CI_SCRIPT} 出现未配对闭合符 ${char}`,
        );
      }
    }
  }
  if (stack.length > 0) {
    throw new Error(
      `括号配平自检未过: ${CI_SCRIPT} 有 ${stack.length} 个未闭合的 ${stack.join('')}`,
    );
  }
}

/** 定位配对闭合括号 (从 openIndex 指向的 `{` 起; 引号与注释内的括号不计) */
function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  for (const { char, index } of codeChars(source, openIndex)) {
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(
    `${CI_SCRIPT} 形态预期不符: 第 ${openIndex} 字符起的 \`{\` 未闭合`,
  );
}

/** 代码字符走查: 跳过字符串 / 模板字面量 / 注释内内容 (括号判定与定位共用一处口径) */
function* codeChars(
  source: string,
  from = 0,
): Generator<{ char: string; index: number }> {
  let index = from;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const eol = source.indexOf('\n', index);
      if (eol < 0) return;
      index = eol + 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) return;
      index = end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') index += 2;
        else if (source[index] === char) {
          index += 1;
          break;
        } else index += 1;
      }
      continue;
    }
    yield { char, index };
    index += 1;
  }
}
