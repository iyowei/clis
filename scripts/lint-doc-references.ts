/**
 * 文档引用与排版闸门: 相对链接 / 本仓 GitHub 绝对链接 / HTML 相对链接 / 孤儿文档 / §章节 / ADR / 中文排版。
 * 触发方: `scripts/ci.ts` (`lint:refs` 并行只读闸门) 或手动执行。
 *
 * 两级文档模型 (仓库级治理文档 + 包级产品文档按需内聚):
 * - 仓库级: `docs/` (纯工程治理、通用设计、仓级 ADR)
 * - 包级:   `packages/<pkg>/docs/` (单包及产品主包的全部设计、协议与 ADR)
 *
 * 用法: bun scripts/lint-doc-references.ts (退出码: 0 全绿; 1 存在断裂或违规)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { listWorkspacePackages } from './lib/workspace.ts';
import { REPO_ROOT, walkFiles } from './lint-doc-shared.ts';

export interface RefFinding {
  file: string;
  line: number;
  kind: 'link' | 'section' | 'adr' | 'orphan' | 'typography';
  reference: string;
  message: string;
}

type EdgeMap = Map<string, Set<string>>;
interface LinkCtx {
  root: string;
  repoPrefix: string;
  edges?: EdgeMap;
  isHtml: boolean;
}

const issue = (
  file: string,
  line: number,
  kind: RefFinding['kind'],
  reference: string,
  message: string,
): RefFinding => ({ file, line, kind, reference, message });

/** 本仓 URL 前缀 (模板构建期经 generalize 替换为 {{REPO_URL}}, 生成新项目时替换为真实 repoUrl) */
const REPO_URL_PREFIX = 'https://github.com/iyowei/clis';

export const normalizeRepoPrefix = (url: string): string =>
  `${url.replace(/(?:\.git)?\/+$/i, '').replace(/\.git$/i, '')}/`;

export const DOC_ALIASES: Readonly<Record<string, string>> = {
  行为契约: 'packages/sweep/docs/protocol/behavior-contract.md',
  覆盖表: 'packages/sweep/docs/protocol/conformance/coverage.md',
};

const ADR_EXEMPT_RE = /不存在|未创建|待创建|历史已删|历史不存在|历史编号/;
const NATURAL_DOC_RE =
  /^(?:README(?:\.zh-CN)?|AGENTS|CLAUDE|GEMINI|CONTRIBUTING(?:\.zh-CN)?|CODE_OF_CONDUCT|SECURITY|CHANGELOG|packages\/[^/]+\/CHANGELOG|\.github\/.+)\.md$/;
const NPM_ALWAYS_RE =
  /^(?:package\.json|readme(?:\.[^/]+)?|license(?:\.[^/]+)?|licence(?:\.[^/]+)?|changelog(?:\.[^/]+)?|history(?:\.[^/]+)?|changes(?:\.[^/]+)?)$/i;
const PKG_README_RE = /^packages\/[^/]+\/README(?:\.[^/]+)?\.md$/;
const TYPO_EXEMPT_RE = /^(?:CHANGELOG|CODE_OF_CONDUCT|.*\/CHANGELOG)\.md$/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const TYPO_GLOBAL_RE = /\u2014\u2014|\u2014|[\uff0c\uff1a\uff1b\uff08\uff09]/g;
const INLINE_LINK_RE = /\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g;
const REF_DEF_RE = /^\s*\[[^\]^][^\]]*\]:\s*(\S+)/;

export const listDocFiles = (r: string): string[] => walkFiles(r, ['.md']);

const isInRoot = (absRoot: string, target: string): boolean => {
  const rel = relative(absRoot, target);
  return !rel.startsWith('..') && !isAbsolute(rel);
};

/** 围栏代码块内容置空 (保行数, 按开围栏字符及长度匹配闭围栏, 闭围栏禁止带 info string) */
export function stripFencedCode(content: string): string {
  let fence: { ch: string; len: number } | null = null;
  return content
    .split('\n')
    .map((line) => {
      const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      if (!fence) {
        if (!m || (m[1]![0] === '`' && m[2]!.includes('`'))) return line;
        fence = { ch: m[1]![0]!, len: m[1]!.length };
      } else if (
        m &&
        m[1]![0] === fence.ch &&
        m[1]!.length >= fence.len &&
        /^\s*$/.test(m[2]!)
      ) {
        fence = null;
      }
      return '';
    })
    .join('\n');
}

const stripHtmlComments = (s: string): string =>
  s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

const stripHtmlCode = (s: string): string =>
  s.replace(
    /<!--[\s\S]*?-->|<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi,
    (m) => m.replace(/[^\n]/g, ' '),
  );

export const collectSectionNumbers = (content: string): Set<string> =>
  new Set(
    [...content.matchAll(/^#{2,5}\s+(\d+(?:\.\d+)*)[.、\s]/gm)].map(
      (m) => m[1]!,
    ),
  );

const pkgPrefixOf = (relPath: string): string | null => {
  const m = /^(packages\/[^/]+)(?:\/|$)/.exec(relPath);
  return m ? `${m[1]!}/` : null;
};

function readPkgWhitelist(pkgRootAbs: string): string[] | null {
  const manifestPath = join(pkgRootAbs, 'package.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const { files } = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      files?: unknown;
    };
    if (!Array.isArray(files)) return null;
    return files
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.replace(/^\.\//, '').replace(/\/+$/, ''))
      .filter((x) => x !== '' && !x.startsWith('!'));
  } catch {
    return null;
  }
}

function isPublishedInPkg(
  rel: string,
  whitelist: readonly string[] | null,
): boolean {
  const norm = rel.replace(/^\.\//, '').replace(/\/+$/, '');
  if (norm === '' || NPM_ALWAYS_RE.test(norm) || whitelist === null)
    return true;
  return whitelist.some((entry) => {
    if (!entry.includes('*'))
      return norm === entry || norm.startsWith(`${entry}/`);
    const pat = entry
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*');
    return new RegExp(`^${pat}(?:/|$)`).test(norm);
  });
}

function decodeSafe(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function addEdge(ctx: LinkCtx, source: string, abs: string): void {
  if (!ctx.edges) return;
  const rel = relative(ctx.root, resolve(abs)).replaceAll('\\', '/');
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return;
  const set = ctx.edges.get(source) ?? new Set<string>();
  set.add(rel).add(`${rel}/README.md`);
  ctx.edges.set(source, set);
}

function checkPkgReadmeTarget(
  file: string,
  decoded: string,
  target: string,
  root: string,
): string | null {
  const pkgPrefix = PKG_README_RE.test(file) ? pkgPrefixOf(file) : null;
  if (pkgPrefix === null) return null;
  const pkgRootAbs = resolve(root, pkgPrefix.slice(0, -1));
  const relPkg = relative(pkgRootAbs, target).replaceAll('\\', '/');
  if (decoded.startsWith('/') || relPkg.startsWith('..')) {
    return '包根 README 禁止逃出包根的相对链接 (请用 GitHub URL)';
  }
  return isPublishedInPkg(relPkg, readPkgWhitelist(pkgRootAbs))
    ? null
    : '包根 README 指向未纳入 package.json files 的包内路径';
}

function resolveGhTarget(rest: string, root: string): string | null {
  const bt = /^(?:blob|tree)\/(?:main|HEAD)\/([^#?\s]+)/.exec(rest);
  if (bt) return resolve(root, decodeSafe(bt[1]!).replace(/\/+$/, '') || '.');
  const wf = /^actions\/workflows\/([^#?\s]+)/.exec(rest);
  if (!wf) return null;
  const sub = decodeSafe(wf[1]!)
    .replace(/\/badge\.svg$/i, '')
    .replace(/\/+$/, '');
  return resolve(root, '.github', 'workflows', sub);
}

function checkHref(
  raw: string,
  lineNo: number,
  file: string,
  ctx: LinkCtx,
): RefFinding | null {
  if (raw.startsWith(ctx.repoPrefix)) {
    const gh = resolveGhTarget(raw.slice(ctx.repoPrefix.length), ctx.root);
    if (gh !== null) {
      if (!isInRoot(ctx.root, gh) || !existsSync(gh)) {
        return issue(file, lineNo, 'link', raw, '本仓 GitHub 链接目标不存在');
      }
      addEdge(ctx, file, gh);
      return null;
    }
  }
  if (raw.startsWith('#') || raw.startsWith('<') || raw.startsWith('//'))
    return null;
  if (raw.includes('://') || (SCHEME_RE.test(raw) && !raw.startsWith('.')))
    return null;
  const [beforeHash, anchor] = raw.split('#');
  const decoded = decodeSafe((beforeHash ?? '').split('?')[0]!);
  if (decoded === '' || decoded.startsWith('//')) return null;

  const target = decoded.startsWith('/')
    ? join(ctx.root, decoded)
    : resolve(ctx.root, dirname(file), decoded);
  const valid = isInRoot(ctx.root, target) && existsSync(target);
  if (valid) addEdge(ctx, file, target);

  if (!ctx.isHtml) {
    const pkgErr = checkPkgReadmeTarget(file, decoded, target, ctx.root);
    if (pkgErr !== null) return issue(file, lineNo, 'link', raw, pkgErr);
  }
  if (!valid) {
    const msg = ctx.isHtml
      ? 'HTML 相对链接目标不存在'
      : `相对链接目标不存在${anchor === undefined ? '' : ' (锚点部分未单独校验)'}`;
    return issue(file, lineNo, 'link', raw, msg);
  }
  return null;
}

function scanRepoLinks(
  root: string,
  docFiles: readonly string[],
  edges: EdgeMap,
  repoUrl: string,
): { findings: RefFinding[]; docLines: Map<string, string[]> } {
  const absRoot = resolve(root);
  const repoPrefix = normalizeRepoPrefix(repoUrl);
  const mdCtx: LinkCtx = { root: absRoot, repoPrefix, edges, isHtml: false };
  const htmlCtx: LinkCtx = { root: absRoot, repoPrefix, edges, isHtml: true };
  const docLines = new Map<string, string[]>();
  const findings: RefFinding[] = [];
  for (const file of docFiles) {
    const rawText = readFileSync(join(root, file), 'utf8');
    const lines = stripHtmlComments(stripFencedCode(rawText)).split('\n');
    docLines.set(file, lines);
    for (const [idx, line] of lines.entries()) {
      const clean = line.replace(/(`+)[^\n]*?\1/g, '');
      const hrefs = [...clean.matchAll(INLINE_LINK_RE)].map((m) => m[1]!);
      const refDef = REF_DEF_RE.exec(clean);
      if (refDef) hrefs.push(refDef[1]!);
      for (const raw of hrefs) {
        const hit = checkHref(raw, idx + 1, file, mdCtx);
        if (hit) findings.push(hit);
      }
    }
  }
  for (const html of walkFiles(root, ['.html'])) {
    const text = stripHtmlCode(readFileSync(join(root, html), 'utf8'));
    for (const [idx, line] of text.split('\n').entries()) {
      for (const m of line.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        const raw = (m[1] ?? m[2] ?? '').trim();
        const hit = raw === '' ? null : checkHref(raw, idx + 1, html, htmlCtx);
        if (hit) findings.push(hit);
      }
    }
  }
  return { findings, docLines };
}

/** 孤儿 .md 文档有向图 BFS 可达性检查 (从自然根入口出发; 仅完整仓库结构存在 docs/README.md 时生效) */
export function findOrphanDocIssues(
  root: string,
  docFiles: readonly string[] = listDocFiles(root),
  precomputed?: ReadonlyMap<string, ReadonlySet<string>>,
  repoUrl = REPO_URL_PREFIX,
): RefFinding[] {
  if (!existsSync(join(resolve(root), 'docs', 'README.md'))) return [];
  let edges = precomputed;
  if (!edges) {
    const built: EdgeMap = new Map();
    scanRepoLinks(root, docFiles, built, repoUrl);
    edges = built;
  }
  const queue = docFiles.filter((f) => NATURAL_DOC_RE.test(f));
  const visited = new Set<string>(queue);
  for (let i = 0; i < queue.length; i += 1) {
    for (const next of edges.get(queue[i]!) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  const msg = '孤儿文档 (从根导航入口不可达, 请登记到所属索引)';
  return docFiles
    .filter((f) => !visited.has(f))
    .map((f) => issue(f, 1, 'orphan', f, msg));
}

/** 中文非代码行字符级排版守卫 (双破折号与全角标点无条件拦截, 单字符 — 仅同行含汉字时拦截) */
export function findTypographyIssues(
  lines: readonly string[],
  file: string,
): RefFinding[] {
  if (TYPO_EXEMPT_RE.test(file)) return [];
  const msg = '中文文档禁用破折号与全角逗号/冒号/分号/括号, 请改用半角标点';
  const findings: RefFinding[] = [];
  for (const [idx, rawLine] of lines.entries()) {
    const cleaned = rawLine
      .replace(/(`+)[^\n]*?\1/g, '')
      .replace(/\]\([^)]*\)/g, ']()')
      .replace(/<https?:\/\/[^>]+>/gi, '');
    if (/^\s*\|?[\s:|-]+\|\s*$/.test(cleaned)) continue;
    const hasHan = /[\u4e00-\u9fff]/.test(cleaned);
    for (const hit of cleaned.matchAll(TYPO_GLOBAL_RE)) {
      if (hit[0] === '\u2014' && !hasHan) continue;
      findings.push(issue(file, idx + 1, 'typography', hit[0], msg));
    }
  }
  return findings;
}

export function resolveSectionTarget(
  line: string,
  refIndex: number,
  dir: string,
  nameIndex: Map<string, string[]>,
): string | null {
  const before = line.slice(Math.max(0, refIndex - 30), refIndex);
  const names = [
    ...before.matchAll(/[^A-Za-z0-9._-]([A-Za-z0-9_-]+\.md)/g),
  ].map((m) => m[1]!);
  const pkgPrefix = pkgPrefixOf(dir);
  for (const name of names.reverse()) {
    const list = nameIndex.get(name.replace(/\.md$/, ''));
    if (list && list.length > 0) {
      const sameDir = list.find((c) => dirname(c) === dir);
      if (sameDir !== undefined) return sameDir;
      const samePkg = pkgPrefix
        ? list.find((c) => c.startsWith(pkgPrefix))
        : undefined;
      return samePkg ?? list[0]!;
    }
  }
  for (const [alias, target] of Object.entries(DOC_ALIASES)) {
    if (before.includes(alias)) return target;
  }
  return null;
}

export function collectAdrIndex(root: string): Map<string, string[]> {
  const dirs = new Set<string>([join(root, 'docs', 'adrs')]);
  try {
    for (const pkg of listWorkspacePackages(root)) {
      dirs.add(join(root, pkg.dir, 'docs', 'adrs'));
    }
  } catch {
    // 迷你根无 workspaces 时走下方目录扫描
  }
  const pkgsDir = join(root, 'packages');
  for (const e of existsSync(pkgsDir)
    ? readdirSync(pkgsDir, { withFileTypes: true })
    : []) {
    if (e.isDirectory()) dirs.add(join(pkgsDir, e.name, 'docs', 'adrs'));
  }
  const index = new Map<string, string[]>();
  for (const dir of dirs) {
    for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
      const m = /^(\d{4})-/.exec(name);
      if (!m) continue;
      const rel = relative(root, join(dir, name)).replaceAll('\\', '/');
      const list = index.get(m[1]!) ?? [];
      list.push(rel);
      index.set(m[1]!, list);
    }
  }
  return index;
}

export const collectAdrNumbers = (root: string): Set<string> =>
  new Set(collectAdrIndex(root).keys());

export function findAllIssues(
  root: string = REPO_ROOT,
  repoUrl = REPO_URL_PREFIX,
): RefFinding[] {
  const files = listDocFiles(root);
  const nameIndex = new Map<string, string[]>();
  for (const file of files) {
    const stem = file.split('/').pop()!.replace(/\.md$/, '');
    const list = nameIndex.get(stem) ?? [];
    list.push(file);
    nameIndex.set(stem, list);
  }
  const adrIndex = collectAdrIndex(root);
  const adrNums = new Set(adrIndex.keys());
  const sectionsCache = new Map<string, Set<string>>();
  const edges: EdgeMap = new Map();
  const { findings, docLines } = scanRepoLinks(root, files, edges, repoUrl);
  for (const [num, fs] of adrIndex) {
    if (fs.length > 1) {
      const msg = `ADR 编号重号碰撞: ${fs.join(' 与 ')}`;
      findings.unshift(issue(fs[1]!, 1, 'adr', `ADR ${num}`, msg));
    }
  }
  const adrMsg = '仓级或包级 docs/adrs 下没有对应编号的 ADR 文件';
  for (const [file, lines] of docLines) {
    const dir = dirname(file);
    for (const [idx, line] of lines.entries()) {
      for (const m of line.matchAll(/§(\d+(?:\.\d+)*)/g)) {
        const num = m[1]!;
        const target = resolveSectionTarget(line, m.index, dir, nameIndex);
        if (!target) continue;
        let secs = sectionsCache.get(target);
        if (!secs && existsSync(join(root, target))) {
          secs = collectSectionNumbers(
            readFileSync(join(root, target), 'utf8'),
          );
          sectionsCache.set(target, secs);
        }
        if (
          secs &&
          ![...secs].some((n) => n === num || n.startsWith(`${num}.`))
        ) {
          const msg = `目标文档 ${target} 的标题编号里没有 §${num}`;
          findings.push(issue(file, idx + 1, 'section', `§${num}`, msg));
        }
      }
      if (ADR_EXEMPT_RE.test(line)) continue;
      for (const m of line.matchAll(/ADR[ -]?(\d{3,4})/g)) {
        const num = String(Number(m[1])).padStart(4, '0');
        if (!adrNums.has(num))
          findings.push(issue(file, idx + 1, 'adr', `ADR ${num}`, adrMsg));
      }
    }
    findings.push(...findTypographyIssues(lines, file));
  }
  findings.push(...findOrphanDocIssues(root, files, edges, repoUrl));
  return findings;
}

function main(): void {
  const findings = findAllIssues();
  if (findings.length === 0) {
    process.stdout.write(
      '文档引用闸门全绿 ✓ (链接 / HTML / 孤儿文档 / §章节 / ADR / 中文排版)\n',
    );
    return;
  }
  process.stderr.write(`文档引用闸门检出 ${findings.length} 处问题:\n`);
  for (const f of findings) {
    process.stderr.write(
      `  ${f.file}:${f.line}  [${f.kind}] ${f.reference}  ${f.message}\n`,
    );
  }
  process.exitCode = 1;
}

if (import.meta.main) main();
