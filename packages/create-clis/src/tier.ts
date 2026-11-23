/**
 * 档位裁剪引擎: 三档 (`core` / `standard` / `full`) -> 「删除路径集 + `scripts/ci.ts` 步骤摘除集 +
 * 根 `package.json` 脚本摘除集 + `.github/workflows/{ci,release}.yml` job 摘除集」, 并执行先验后写裁剪。
 *
 * 上游由 `generate.ts` 在按档裁剪阶段调用 `pruneTemplate(targetDir, removeRulesFor(tier))`;
 * 下游委托 `tier-lexer.ts` / `tier-conformance.ts` / `tier-workflow.ts` 做语法安全摘除与零残留自检。
 * 档位关系 (`docs/designs/capability-tiers.md`): `full` 不裁剪; `standard` 摘转写契约套件; `core` 再摘技术债册子与依赖方向闸门。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  planConformanceConfigPrunes,
  planConformanceDocPrunes,
  planTechDebtDocPrunes,
  pruneEmptyConformanceGroup,
  pruneOrphanedCarriers,
  pruneWorkflowConformanceComments,
} from './tier-conformance.ts';
import { codeChars } from './tier-lexer.ts';
import {
  findResidualWorkflowJobs,
  listWorkflowJobs,
  pruneWorkflowJobs,
} from './tier-workflow.ts';

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

/** 增强档机制件目录 (转写契约套件 + 仓级通用转写文档 + 示例包协议目录) */
const CONFORMANCE_KIT_DIR = 'scripts/transcription/';
const CONFORMANCE_DOCS_DIR = 'docs/transcription/';
const CONFORMANCE_PROTOCOL_DIR = 'packages/{{NAME}}/docs/';

/** 标准档装备: 技术债登记册 + 依赖方向闸门及其单测 */
const TECH_DEBT_LEDGER = 'docs/designs/tech-debt.md';
const DEP_DIRECTION_SCRIPT = 'scripts/lint-dependency-direction.ts';
const DEP_DIRECTION_TEST = 'scripts/lint-dependency-direction.test.ts';

/** 增强档 ci 步骤 */
const CONFORMANCE_CI_STEPS: readonly string[] = [
  'lint:coverage',
  'lint:mutants',
  'fuzz',
  'conformance:portable',
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
const CONFORMANCE_PACKAGE_SCRIPTS: readonly string[] = [
  'conformance',
  'fuzz',
  'fuzz:diff',
];

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
    deletePaths: [
      CONFORMANCE_KIT_DIR,
      CONFORMANCE_DOCS_DIR,
      CONFORMANCE_PROTOCOL_DIR,
    ],
    ciSteps: CONFORMANCE_CI_STEPS,
    packageScripts: CONFORMANCE_PACKAGE_SCRIPTS,
    workflowJobs: CONFORMANCE_WORKFLOW_JOBS,
  },
  core: {
    deletePaths: [
      CONFORMANCE_KIT_DIR,
      CONFORMANCE_DOCS_DIR,
      CONFORMANCE_PROTOCOL_DIR,
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
 * 按档裁剪模板目录: 四维同步摘除 `deletePaths`、`scripts/ci.ts` 步骤声明 (含组数组引用、
 * 空 `CONFORMANCE_GROUP` 与专属载体声明/导入)、根 `package.json` 的 `scripts` 条目, 以及
 * `.github/workflows/{ci,release}.yml` 中的指定 job 与 `needs` 引用。
 *
 * 原子前检约束: 全部路径存在性校验、载体归属校验、内存干跑手术与术后零残留/括号配平自检通过后
 * 才统一删文件与写回磁盘, 任一校验不过即抛错不留半成品; `scripts/ci.ts` 行级摘除后的格式收敛
 * 交由 `generate.ts` 后续的 `formatTree` 统一处理。
 *
 * ### 数据流转示例
 * ```text
 * Input:  targetDir = '<模板副本根>'
 *         rules = removeRulesFor('standard')
 *               = { deletePaths: ['scripts/transcription/'],
 *                   ciSteps: ['lint:coverage', 'conformance:bun', 'conformance:node'],
 *                   packageScripts: ['conformance'],
 *                   workflowJobs: ['conformance'] }
 * Step 1: 全量前置校验 + 内存干跑
 *         - 核验 `scripts/transcription/` 存在且覆盖被摘步骤/脚本引用的全部 `scripts/...` 载体
 *         - pruneCiSource 摘除 3 个 STEPS 条目、组引用、空 CONFORMANCE_GROUP 及孤儿载体并验证括号配平
 *         - prunePackageScripts 摘除根 package.json 的 `conformance` 脚本并核对保留脚本无损
 *         - pruneWorkflowJobs 摘除 ci.yml / release.yml 的 `conformance` job 及 `needs` 引用并验证零残留
 * Step 2: 统一落盘 (删除 deletePaths 并回写 ci.ts / package.json / workflow 文件)
 * Output: targetDir 完成标准档裁剪 (保留 `lint:deps` 与 `tech-debt.md`; core 档会一并摘除二者)
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
    const foundWorkflows: { rel: string; path: string; source: string }[] = [];
    for (const rel of WORKFLOW_FILES) {
      const wfPath = join(targetDir, rel);
      if (!existsSync(wfPath)) continue;
      foundWorkflows.push({
        rel,
        path: wfPath,
        source: readFileSync(wfPath, 'utf8'),
      });
    }
    if (foundWorkflows.length === 0) {
      throw new Error(
        `模板缺少 workflow 文件 (${WORKFLOW_FILES.join(' / ')}), 无法摘除 job: ${workflowJobs.join(', ')}`,
      );
    }
    const existingJobs = new Set<string>();
    for (const wf of foundWorkflows) {
      for (const name of listWorkflowJobs(wf.source)) existingJobs.add(name);
    }
    for (const job of workflowJobs) {
      if (!existingJobs.has(job)) {
        throw new Error(
          `workflow job 不存在: '${job}' 未出现在模板 workflow 中 (裁剪规则与模板不同步)`,
        );
      }
    }
    for (const wf of foundWorkflows) {
      let pruned = pruneWorkflowJobs(wf.source, workflowJobs);
      if (workflowJobs.includes('conformance')) {
        pruned = pruneWorkflowConformanceComments(pruned, wf.rel);
      }
      const residuals = findResidualWorkflowJobs(pruned, workflowJobs);
      if (residuals.length > 0) {
        throw new Error(
          `workflow 裁剪自检未过 (${wf.rel}): 仍残留 ${residuals.join(', ')}`,
        );
      }
      prunedWorkflows.set(wf.path, pruned);
    }
  }
  const prunedDocs = planTechDebtDocPrunes(
    targetDir,
    rules.deletePaths,
    TECH_DEBT_LEDGER,
    planConformanceDocPrunes(
      targetDir,
      rules.deletePaths,
      CONFORMANCE_DOCS_DIR,
    ),
  );
  const prunedConfigs = planConformanceConfigPrunes(
    targetDir,
    rules.deletePaths,
    CONFORMANCE_KIT_DIR,
  );
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
  for (const [docPath, content] of prunedDocs) {
    writeFileSync(docPath, content);
  }
  for (const [cfgPath, content] of prunedConfigs) {
    writeFileSync(cfgPath, content);
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
  pruned = pruneEmptyConformanceGroup(source, pruned, CI_SCRIPT);
  pruned = pruneOrphanedCarriers(pruned, CI_SCRIPT);
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

/** 定位配对闭合括号 (从 openIndex 指向的 `{` 起; 引号 / 正则 / 模板文本与注释内的括号不计) */
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
