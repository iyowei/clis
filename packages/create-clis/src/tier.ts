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

import { pruneWorkflowJobs } from './tier-workflow.ts';

/** 装备档位 */
export type Tier = 'core' | 'standard' | 'full';

/** 一次裁剪要动的地方: 删除路径集 + ci 步骤摘除集 + 根 package.json 脚本摘除集 + 可选 workflow job 摘除集 */
export interface RemoveRule {
  /** 相对模板根的删除路径 (目录以 `/` 收尾); 规则与模板不同步时 pruneTemplate 抛错 */
  readonly deletePaths: readonly string[];
  /** 从 STEPS 表与组数组一并摘除的步骤名; 其载体文件须同在 deletePaths 内 */
  readonly ciSteps: readonly string[];
  /** 从根 `package.json` 的 scripts 一并摘除的脚本名; 其命令引用的载体文件须同在 deletePaths 内 */
  readonly packageScripts: readonly string[];
  /** 从 `.github/workflows/{ci,release}.yml` 摘除的 job 名 (省略或空数组不触碰 workflow) */
  readonly workflowJobs?: readonly string[];
}

/** 增强档机制件目录 (转写契约套件) */
const CONFORMANCE_KIT_DIR = 'scripts/transcription/';

/** 标准档装备: 技术债登记册 + 依赖方向闸门及其单测 */
const TECH_DEBT_LEDGER = 'docs/designs/tech-debt.md';
const DEP_DIRECTION_SCRIPT = 'scripts/lint-dependency-direction.ts';
const DEP_DIRECTION_TEST = 'scripts/lint-dependency-direction.test.ts';

/** 增强档 ci 步骤 */
const CONFORMANCE_CI_STEPS: readonly string[] = [
  'lint:coverage',
  'conformance:bun',
  'conformance:node',
];

/** 标准档 ci 步骤 */
const STANDARD_CI_STEPS: readonly string[] = ['lint:deps'];

/** 闸门清单 (步骤声明手术的对象): 模板根相对路径 */
const CI_SCRIPT = 'scripts/ci.ts';

/** 根包清单 (脚本声明手术的对象): 模板根相对路径 */
const ROOT_PACKAGE_JSON = 'package.json';

/** GitHub Actions workflow 路径 (按需摘除 conformance job 防白烧 macOS runner) */
const WORKFLOW_FILES: readonly string[] = [
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
];

/** 增强档装备在根 `package.json` 里的脚本挂载 */
const CONFORMANCE_PACKAGE_SCRIPTS: readonly string[] = ['conformance'];

/** 增强档在 GitHub Actions 里对应的 job 名 */
const CONFORMANCE_WORKFLOW_JOBS: readonly string[] = ['conformance'];

const TIER_RULES: Readonly<Record<Tier, RemoveRule>> = {
  full: {
    deletePaths: [],
    ciSteps: [],
    packageScripts: [],
    workflowJobs: [],
  },
  standard: {
    deletePaths: [CONFORMANCE_KIT_DIR],
    ciSteps: CONFORMANCE_CI_STEPS,
    packageScripts: CONFORMANCE_PACKAGE_SCRIPTS,
    workflowJobs: CONFORMANCE_WORKFLOW_JOBS,
  },
  core: {
    deletePaths: [
      CONFORMANCE_KIT_DIR,
      TECH_DEBT_LEDGER,
      DEP_DIRECTION_SCRIPT,
      DEP_DIRECTION_TEST,
    ],
    ciSteps: [...CONFORMANCE_CI_STEPS, ...STANDARD_CI_STEPS],
    packageScripts: CONFORMANCE_PACKAGE_SCRIPTS,
    workflowJobs: CONFORMANCE_WORKFLOW_JOBS,
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
  const prunedWorkflows = new Map<string, string>();
  const workflowJobs = rules.workflowJobs ?? [];
  if (workflowJobs.length > 0) {
    for (const rel of WORKFLOW_FILES) {
      const wfPath = join(targetDir, rel);
      if (!existsSync(wfPath)) continue;
      prunedWorkflows.set(
        wfPath,
        pruneWorkflowJobs(readFileSync(wfPath, 'utf8'), workflowJobs),
      );
    }
  }
  for (const path of rules.deletePaths) {
    rmSync(join(targetDir, path), { recursive: true, force: true });
  }
  if (prunedCi !== null) writeFileSync(ciPath, prunedCi);
  if (prunedPackageJson !== null) {
    writeFileSync(packageJsonPath, prunedPackageJson);
  }
  for (const [wfPath, content] of prunedWorkflows) {
    writeFileSync(wfPath, content);
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

/** 旧形态 CLI 入口坐标块 (保留以兼容单测手写夹具) */
const CLI_COORDINATE_BLOCK =
  /\/\*\* CLI 入口坐标[^\n]*\nconst \{ cli \} = resolveCliAndApi\(process\.cwd\(\)\);\nconst CLI_SRC = [^\n]*\n\n?/;

/** 旧形态导入 */
const CLI_COORDINATE_IMPORT =
  /^import \{ resolveCliAndApi \} from '\.\/lib\/workspace\.ts';\n/m;

/** 新形态惰性派生函数块 (scripts/ci.ts 的 resolveConformanceCliSrc) */
const LAZY_CONFORMANCE_FN =
  /\/\*\* 惰性派生转写验收 CLI 入口坐标[^\n]*\nfunction resolveConformanceCliSrc\(\): string \{[\s\S]*?\n\}\n\n?/;

/** 新形态导入 */
const LAZY_CONFORMANCE_IMPORT =
  /^import \{ resolveProductPairs \} from '\.\/lib\/workspace\.ts';\n/m;

/** 术后载体摘除: 「只服务被摘步骤」的顶层声明与来源导入一并摘净 (兼顾新旧两种形态) */
function pruneOrphanedCarriers(source: string): string {
  let out = source;
  const legacyBlock = CLI_COORDINATE_BLOCK.exec(out);
  if (legacyBlock !== null) {
    const withoutBlock = out.replace(legacyBlock[0], '');
    if (!withoutBlock.includes('CLI_SRC')) {
      const withoutImport = withoutBlock.replace(CLI_COORDINATE_IMPORT, '');
      out = withoutImport.includes('resolveCliAndApi')
        ? withoutBlock
        : withoutImport;
    }
  }
  const lazyBlock = LAZY_CONFORMANCE_FN.exec(out);
  if (lazyBlock !== null) {
    const withoutBlock = out.replace(lazyBlock[0], '');
    if (!withoutBlock.includes('resolveConformanceCliSrc')) {
      const withoutImport = withoutBlock.replace(LAZY_CONFORMANCE_IMPORT, '');
      out = withoutImport.includes('resolveProductPairs')
        ? withoutBlock
        : withoutImport;
    }
  }
  return out;
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
