/**
 * 文档引用闸门: 相对链接 / §章节引用 / ADR 编号的静态一致性。
 *
 * 动机: 连续两轮全仓漂移审计 (2026-09-30) 反复检出三类引用断裂 (死链 / 幽灵章节 / 幽灵
 * ADR), 三类均为确定性可判的事实, 不该等下一轮人工审计才暴露, 故落为提交时闸门。
 *
 * 口径 (保守读数, 宁漏勿误):
 * - 相对链接: `](路径)` 解析到仓内文件 / 目录须存在; 支持 `./` 与 `../` (相对本文件) 与 `/`
 *   (相对仓库根, GitHub 渲染语义) 两种形态; 外链 (含合法 scheme) 与纯锚点 `](#...)` 跳过;
 *   围栏代码块内不查 (示例里的路径是示意)。
 * - §引用: 只校验「目标明确」的形态: § 前 30 字符窗口内出现 `x.md` 文件名或已知文档别名时,
 *   校验目标文档的节号存在性; 裸 `§N` (无目标线索) 一律跳过 —— 跨文档裸引用与泛称
 *   「设计文档 §7」无法机械定目标, 回落「本文档」的口径实测全为误报 (2026-09-30)。
 * - ADR 编号: `ADR 0005` / `ADR-0005` 形态须有对应 `docs/adrs/00XX-*.md`; 行内含
 *   「不存在 / 未创建 / 待创建 / 历史」字样时豁免 (文档正在陈述它不存在, 是真话)。
 *
 * 节号引擎: 收集标题 `## N.` / `### N.M` / `#### N.M.K` 的编号; `§N.M` 的命中规则为编号集合
 * 中存在 `N.M` 或以 `N.M.` 开头的编号 (指向 N.M 的任一子节与指向该节同义)。
 *
 * 用法: bun scripts/lint-doc-references.ts
 * 退出码: 0 全绿; 1 存在断裂 (逐条打印 file:line 定位)。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { REPO_ROOT, walkFiles } from './lint-doc-shared.ts';

/** 一条断裂发现 */
export interface RefFinding {
  file: string;
  line: number;
  kind: 'link' | 'section' | 'adr';
  reference: string;
  message: string;
}

/** 文档别名表: 直角引号里的文档「别称」到仓库相对路径; 实测出现即增补 */
export const DOC_ALIASES: Readonly<Record<string, string>> = {
  '可编程 API 面': 'docs/designs/api-surface.md',
  行为契约: 'docs/protocol/behavior-contract.md',
  覆盖表: 'docs/protocol/conformance/coverage.md',
  安全防护: 'docs/safety-guardrails.md',
};

/** ADR 引用的行级豁免词: 文档正在陈述「该 ADR 尚不存在」时不算断裂 */
const ADR_LINE_EXEMPT_MARKERS = ['不存在', '未创建', '待创建', '历史'] as const;

/** §引用解析窗口: § 之前多少字符内找目标文档线索 */
const SECTION_TARGET_WINDOW = 30;

/** 走查全部 .md (共享走查的文档薄壳; 保留独立导出供测试注入临时根) */
export function listDocFiles(root: string): string[] {
  return walkFiles(root, ['.md']);
}

/**
 * 围栏代码块内容置空 (保行数, 保行号): ``` 或 ~~~ 围栏, 支持带语言标注的开启行。
 * 引用检查在置空后的文本上做, 示例代码里的路径 / § 不参与判定。
 */
export function stripFencedCode(content: string): string {
  let fence: string | null = null;
  return content
    .split('\n')
    .map((line) => {
      const m = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence === null && m) {
        fence = m[1]![0]!;
        return '';
      }
      if (fence !== null) {
        if (m && m[1]![0] === fence) fence = null;
        return '';
      }
      return line;
    })
    .join('\n');
}

/** 文件名 stem 到仓库相对路径的索引 (同 stem 多值时全部保留, 解析时优先同目录) */
export function buildNameIndex(files: string[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const file of files) {
    const stem = file.split('/').pop()!.replace(/\.md$/, '');
    const list = index.get(stem) ?? [];
    list.push(file);
    index.set(stem, list);
  }
  return index;
}

/** 收集一个文档的节号集合 (`## N.` / `### N.M` / `#### N.M.K` 的 N 与 N.M 与 N.M.K) */
export function collectSectionNumbers(content: string): Set<string> {
  const numbers = new Set<string>();
  for (const m of content.matchAll(/^#{2,5}\s+(\d+(?:\.\d+)*)[.、\s]/gm)) {
    numbers.add(m[1]!);
  }
  return numbers;
}

/** 校验一个文件里的相对链接 (存在性; 外链 / 纯锚点 / 代码块 / 尖括号占位跳过) */
export function findLinkIssues(
  lines: string[],
  file: string,
  root: string,
): RefFinding[] {
  const findings: RefFinding[] = [];
  const dir = dirname(file);
  for (const [index, line] of lines.entries()) {
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const raw = m[1]!;
      if (raw.startsWith('#') || raw.includes('://') || raw.startsWith('<')) {
        continue;
      }
      // 带 scheme 的非 URL 形态 (mailto: 等) 跳过
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) && !raw.startsWith('.')) {
        continue;
      }
      const [pathPart, anchor] = raw.split('#');
      if (!pathPart) continue;
      let decoded = pathPart;
      try {
        decoded = decodeURIComponent(pathPart);
      } catch {
        // 非标准编码: 按原样解析
      }
      // 协议相对形态 (//host) 不参与; 以 / 开头按仓库根解析 (GitHub 渲染语义); 其余相对本文件
      if (decoded.startsWith('//')) continue;
      const target = decoded.startsWith('/')
        ? join(root, decoded)
        : resolve(root, dir, decoded);
      if (!existsSync(target)) {
        findings.push({
          file,
          line: index + 1,
          kind: 'link',
          reference: raw,
          message: `相对链接目标不存在${anchor === undefined ? '' : ' (锚点部分未单独校验)'}`,
        });
      }
    }
  }
  return findings;
}

/** 解析 § 引用的目标文档: 窗口内的 `x.md` 文件名或已知别名; 无线索返回 null (跳过) */
export function resolveSectionTarget(
  line: string,
  refIndex: number,
  dir: string,
  nameIndex: Map<string, string[]>,
): string | null {
  const before = line.slice(
    Math.max(0, refIndex - SECTION_TARGET_WINDOW),
    refIndex,
  );
  // 候选文件名要求前置分隔符 (不认窗口起点): 窗口截断会把长名切成残片
  // (api-surface.md → rface.md), 残片按 stem 查索引必然落空, 必须由右向左取
  // 第一个「能在索引里解析出真实文档」的名字 (离 § 最近者优先)
  const names: string[] = [];
  for (const m of before.matchAll(/[^A-Za-z0-9._-]([A-Za-z0-9_-]+\.md)/g)) {
    names.push(m[1]!);
  }
  for (const name of names.reverse()) {
    const candidates = nameIndex.get(name.replace(/\.md$/, ''));
    if (candidates && candidates.length > 0) {
      // 同目录优先, 其次全仓首个 (文档内引用自己的兄弟文档是主流形态)
      return candidates.find((c) => c.startsWith(dir + '/')) ?? candidates[0]!;
    }
  }
  for (const [alias, target] of Object.entries(DOC_ALIASES)) {
    if (before.includes(alias)) return target;
  }
  return null;
}

/** 校验一个文件里的 §章节引用 (仅目标明确形态; 节号须在目标文档的标题编号集合内) */
export function findSectionIssues(
  lines: string[],
  file: string,
  root: string,
  nameIndex: Map<string, string[]>,
  sectionsCache: Map<string, Set<string>>,
): RefFinding[] {
  const findings: RefFinding[] = [];
  const dir = dirname(file);
  const sectionsOf = (rel: string): Set<string> | null => {
    const cached = sectionsCache.get(rel);
    if (cached) return cached;
    const abs = join(root, rel);
    if (!existsSync(abs)) return null;
    const numbers = collectSectionNumbers(readFileSync(abs, 'utf8'));
    sectionsCache.set(rel, numbers);
    return numbers;
  };
  for (const [index, line] of lines.entries()) {
    for (const m of line.matchAll(/§(\d+(?:\.\d+)*)/g)) {
      const number = m[1]!;
      const target = resolveSectionTarget(line, m.index, dir, nameIndex);
      if (target === null) continue;
      const sections = sectionsOf(target);
      if (sections === null) continue; // 目标文档不存在由链接类检查负责
      const hit = [...sections].some(
        (n) => n === number || n.startsWith(number + '.'),
      );
      if (!hit) {
        findings.push({
          file,
          line: index + 1,
          kind: 'section',
          reference: `§${number}`,
          message: `目标文档 ${target} 的标题编号里没有 §${number}`,
        });
      }
    }
  }
  return findings;
}

/** 收集仓内真实存在的 ADR 编号 (四位), 来源为 docs/adrs/00XX-*.md */
export function collectAdrNumbers(root: string): Set<string> {
  const dir = join(root, 'docs', 'adrs');
  const numbers = new Set<string>();
  if (!existsSync(dir)) return numbers;
  for (const name of readdirSync(dir)) {
    const m = name.match(/^(\d{4})-/);
    if (m) numbers.add(m[1]!);
  }
  return numbers;
}

/** 校验一个文件里的 ADR 编号引用 (不存在即断裂; 行级豁免词命中时跳过) */
export function findAdrIssues(
  lines: string[],
  file: string,
  adrNumbers: Set<string>,
): RefFinding[] {
  const findings: RefFinding[] = [];
  for (const [index, line] of lines.entries()) {
    if (ADR_LINE_EXEMPT_MARKERS.some((marker) => line.includes(marker))) {
      continue;
    }
    for (const m of line.matchAll(/ADR[ -]?(\d{3,4})/g)) {
      const number = String(Number(m[1])).padStart(4, '0');
      if (!adrNumbers.has(number)) {
        findings.push({
          file,
          line: index + 1,
          kind: 'adr',
          reference: `ADR ${number}`,
          message: 'docs/adrs 下没有对应编号的 ADR 文件',
        });
      }
    }
  }
  return findings;
}

/** 全仓扫描三类引用 (导出供测试用临时根); 返回全部断裂 */
export function findAllIssues(root: string = REPO_ROOT): RefFinding[] {
  const files = listDocFiles(root);
  const nameIndex = buildNameIndex(files);
  const adrNumbers = collectAdrNumbers(root);
  const sectionsCache = new Map<string, Set<string>>();
  const findings: RefFinding[] = [];
  for (const file of files) {
    const lines = stripFencedCode(readFileSync(join(root, file), 'utf8')).split(
      '\n',
    );
    findings.push(
      ...findLinkIssues(lines, file, root),
      ...findSectionIssues(lines, file, root, nameIndex, sectionsCache),
      ...findAdrIssues(lines, file, adrNumbers),
    );
  }
  return findings;
}

/** 主流程: 打印全部断裂并以退出码收口 (0 全绿 / 1 有断裂) */
function main(): void {
  const findings = findAllIssues();
  if (findings.length === 0) {
    process.stdout.write(
      '文档引用闸门全绿 ✓ (相对链接 / §章节引用 / ADR 编号)\n',
    );
    return;
  }
  process.stderr.write(`文档引用闸门检出 ${findings.length} 处断裂:\n`);
  for (const finding of findings) {
    process.stderr.write(
      `  ${finding.file}:${finding.line}  [${finding.kind}] ${finding.reference}  ${finding.message}\n`,
    );
  }
  process.exitCode = 1;
}

// 仅作为入口执行时跑主流程 (被 import 时不执行, 供测试)
if (import.meta.main) main();
