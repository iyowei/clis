/**
 * 文档引用闸门: 相对链接 / §章节引用 / ADR 编号与重号检测 / 包 README npm 外链防 404。
 * 触发方: `scripts/ci.ts` (`lint:refs` 并行只读闸门) 或手动执行。
 *
 * 两级文档模型 (ADR 0019 / docs/designs/docs-layering.md):
 * - 仓库级: `docs/` (纯工程治理、通用设计、仓级 ADR)
 * - 包级:   `packages/<pkg>/docs/` (单包及产品主包的全部设计、协议与 ADR)
 *
 * 检查面:
 * 1. 相对链接: `](路径)` 解析到仓内文件/目录须存在; 外链、纯锚点与围栏代码块跳过;
 * 2. 包 README 逃逸拦截: `packages/<pkg>/README*.md` 面向 npm 发布, 禁止逃出包根 (`../` 或
 *    仓库根 `/...`) 的相对链接, 必须改用 GitHub 绝对链接 (消除 npm 页面 404);
 * 3. §章节引用: 目标明确形态 (`x.md §N` 或别名), 同名文件按「同目录 -> 同包 -> 全仓」就近消歧;
 * 4. ADR 编号与唯一性: 扫描 `docs/adrs/` 与全部 workspace 包 `packages/<pkg>/docs/adrs/`,
 *    既拦截幽灵编号, 也拦截跨目录重号碰撞。
 *
 * 用法: bun scripts/lint-doc-references.ts
 * 退出码: 0 全绿; 1 存在断裂。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { listWorkspacePackages } from './lib/workspace.ts';
import { REPO_ROOT, walkFiles } from './lint-doc-shared.ts';

/** 一条断裂发现 */
export interface RefFinding {
  file: string;
  line: number;
  kind: 'link' | 'section' | 'adr';
  reference: string;
  message: string;
}

/** 文档别名表 (保留既有通用称谓映射; 仅在目标文件真实存在时参与解析) */
export const DOC_ALIASES: Readonly<Record<string, string>> = {
  '可编程 API 面': 'packages/sweep/docs/designs/api-surface.md',
  行为契约: 'packages/sweep/docs/protocol/behavior-contract.md',
  覆盖表: 'packages/sweep/docs/protocol/conformance/coverage.md',
  安全防护: 'packages/sweep/docs/designs/safety-guardrails.md',
};

/** ADR 引用的行级豁免词: 文档正在陈述「该 ADR 尚不存在」时不算断裂 */
const ADR_LINE_EXEMPT_MARKERS = ['不存在', '未创建', '待创建', '历史'] as const;

/** §引用解析窗口: § 之前多少字符内找目标文档线索 */
const SECTION_TARGET_WINDOW = 30;

/** 走查全部 .md (共享走查的文档薄壳; 保留独立导出供测试注入临时根) */
export function listDocFiles(root: string): string[] {
  return walkFiles(root, ['.md']);
}

/** 围栏代码块内容置空 (保行数, 保行号) */
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

/** 文件名 stem 到仓库相对路径的索引 */
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

/** 收集一个文档的节号集合 (`## N.` / `### N.M` / `#### N.M.K`) */
export function collectSectionNumbers(content: string): Set<string> {
  const numbers = new Set<string>();
  for (const m of content.matchAll(/^#{2,5}\s+(\d+(?:\.\d+)*)[.、\s]/gm)) {
    numbers.add(m[1]!);
  }
  return numbers;
}

/** 提取相对路径所属包前缀 (`packages/<pkg>/`), 非包内返回 null */
function packagePrefixOf(relPath: string): string | null {
  const m = relPath.match(/^(packages\/[^/]+)(?:\/|$)/);
  return m ? `${m[1]!}/` : null;
}

/** 是否属于可发 npm 的包根 README (`packages/<pkg>/README.md` 或 `README.*.md`) */
function isPackageRootReadme(relPath: string): boolean {
  return /^packages\/[^/]+\/README(?:\.[^/]+)?\.md$/.test(relPath);
}

/** 校验一个文件里的相对链接 (存在性 + 包根 README 禁止逃逸出包根) */
export function findLinkIssues(
  lines: string[],
  file: string,
  root: string,
): RefFinding[] {
  const findings: RefFinding[] = [];
  const dir = dirname(file);
  const pkgPrefix = isPackageRootReadme(file) ? packagePrefixOf(file) : null;
  const pkgRootAbs =
    pkgPrefix === null ? null : resolve(root, pkgPrefix.slice(0, -1));

  for (const [index, line] of lines.entries()) {
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const raw = m[1]!;
      if (raw.startsWith('#') || raw.includes('://') || raw.startsWith('<')) {
        continue;
      }
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) && !raw.startsWith('.')) {
        continue;
      }
      const [pathPart, anchor] = raw.split('#');
      if (!pathPart) continue;
      let decoded = pathPart;
      try {
        decoded = decodeURIComponent(pathPart);
      } catch {
        // 非标准编码按原样解析
      }
      if (decoded.startsWith('//')) continue;

      if (pkgRootAbs !== null) {
        const targetAbs = decoded.startsWith('/')
          ? join(root, decoded)
          : resolve(root, dir, decoded);
        const relFromPkg = relative(pkgRootAbs, targetAbs).replaceAll(
          '\\',
          '/',
        );
        if (
          decoded.startsWith('/') ||
          relFromPkg.startsWith('..') ||
          relFromPkg === '..'
        ) {
          findings.push({
            file,
            line: index + 1,
            kind: 'link',
            reference: raw,
            message:
              '包根 README 禁止指向包目录之外的相对链接 (发布到 npm 后会 404, 请改用 GitHub 绝对 URL)',
          });
          continue;
        }
      }

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

/**
 * 解析 § 引用的目标文档: 在 § 前 30 字符窗口内提取 `*.md` (按「同目录 -> 同包 -> 全仓首项」消歧),
 * 无文件名线索时回退 DOC_ALIASES 别名映射。
 *
 * ### 数据流转示例
 * ```text
 * Input:  line = "见 behavior-contract.md §3.2", dir = "packages/sweep/docs/designs"
 * 步骤 1: 截取 § 前 30 字符窗口 -> 命中 "behavior-contract.md"
 * 步骤 2: 查 nameIndex['behavior-contract'] -> 优先同目录, 其次同包前缀 packages/sweep/, 最后首项
 * Output: "packages/sweep/docs/protocol/behavior-contract.md" (未命中则回退别名或 null)
 * ```
 */
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
  const names: string[] = [];
  for (const m of before.matchAll(/[^A-Za-z0-9._-]([A-Za-z0-9_-]+\.md)/g)) {
    names.push(m[1]!);
  }
  const pkgPrefix = packagePrefixOf(dir);
  for (const name of names.reverse()) {
    const candidates = nameIndex.get(name.replace(/\.md$/, ''));
    if (candidates && candidates.length > 0) {
      const sameDir = candidates.find((c) => dirname(c) === dir);
      if (sameDir !== undefined) return sameDir;
      if (pkgPrefix !== null) {
        const samePkg = candidates.find((c) => c.startsWith(pkgPrefix));
        if (samePkg !== undefined) return samePkg;
      }
      return candidates[0]!;
    }
  }
  for (const [alias, target] of Object.entries(DOC_ALIASES)) {
    if (before.includes(alias)) return target;
  }
  return null;
}

/** 校验一个文件里的 §章节引用 */
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
      if (sections === null) continue;
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

/** 收集仓内全部 ADR 目录 (仓级 docs/adrs + workspace 包级 packages/<pkg>/docs/adrs) */
function collectAdrDirs(root: string): string[] {
  const dirs = [join(root, 'docs', 'adrs')];
  const seen = new Set<string>(dirs);
  if (existsSync(join(root, 'package.json'))) {
    try {
      for (const pkg of listWorkspacePackages(root)) {
        const candidate = join(root, pkg.dir, 'docs', 'adrs');
        if (!seen.has(candidate)) {
          seen.add(candidate);
          dirs.push(candidate);
        }
      }
    } catch {
      // 迷你根无 workspaces 时走下方兜底扫描
    }
  }
  const packagesDir = join(root, 'packages');
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(packagesDir, entry.name, 'docs', 'adrs');
      if (!seen.has(candidate)) {
        seen.add(candidate);
        dirs.push(candidate);
      }
    }
  }
  return dirs;
}

/** 收集仓内全部 ADR 编号到相对文件路径数组的映射 (用于存在性校验与重号碰撞检测) */
export function collectAdrIndex(root: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const dir of collectAdrDirs(root)) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const m = name.match(/^(\d{4})-/);
      if (!m) continue;
      const num = m[1]!;
      const rel = relative(root, join(dir, name)).replaceAll('\\', '/');
      const list = index.get(num) ?? [];
      list.push(rel);
      index.set(num, list);
    }
  }
  return index;
}

/** 收集仓内真实存在的 ADR 编号集合 */
export function collectAdrNumbers(root: string): Set<string> {
  return new Set(collectAdrIndex(root).keys());
}

/** 校验全仓 ADR 编号是否存在跨目录重号碰撞 */
export function findDuplicateAdrIssues(
  adrIndex: Map<string, string[]>,
): RefFinding[] {
  const findings: RefFinding[] = [];
  for (const [num, files] of adrIndex.entries()) {
    if (files.length <= 1) continue;
    findings.push({
      file: files[1]!,
      line: 1,
      kind: 'adr',
      reference: `ADR ${num}`,
      message: `ADR 编号重号碰撞: ${files.join(' 与 ')}`,
    });
  }
  return findings;
}

/** 校验一个文件里的 ADR 编号引用 */
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
          message: '仓级或包级 docs/adrs 下没有对应编号的 ADR 文件',
        });
      }
    }
  }
  return findings;
}

/**
 * 全仓扫描引用 (导出供测试用临时根), 返回全部断裂。
 *
 * ### 数据流转示例
 * ```text
 * Input:  root = 仓库根
 * 步骤 1: listDocFiles -> 建立文件名索引 nameIndex 与两级 ADR 编号索引 adrIndex
 * 步骤 2: 先跑 findDuplicateAdrIssues 拦截跨目录 ADR 重号碰撞
 * 步骤 3: 逐文件 stripFencedCode (保行号) -> 并行采集 link / section / adr 三类断裂
 * Output: RefFinding[] (空数组 = 全绿)
 * ```
 */
export function findAllIssues(root: string = REPO_ROOT): RefFinding[] {
  const files = listDocFiles(root);
  const nameIndex = buildNameIndex(files);
  const adrIndex = collectAdrIndex(root);
  const adrNumbers = new Set(adrIndex.keys());
  const sectionsCache = new Map<string, Set<string>>();
  const findings: RefFinding[] = [...findDuplicateAdrIssues(adrIndex)];
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

/** 主流程: 打印全部断裂并以退出码收口 */
function main(): void {
  const findings = findAllIssues();
  if (findings.length === 0) {
    process.stdout.write(
      '文档引用闸门全绿 ✓ (相对链接 / 包 README npm 外链 / §章节 / ADR 唯一性)\n',
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

if (import.meta.main) main();
