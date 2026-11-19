/**
 * GitHub Actions workflow job 裁剪与自检辅助:
 * - 严格追踪顶层 `jobs:` 块作用域 (不误伤 on / env / permissions / concurrency 等块内同名键);
 * - 摘除二级 job 块 (含紧贴其上的两空格注释行与多余空行);
 * - 同步收缩保留 job 内的 `needs` 引用: 兼容行内数组 (`needs: [a, b]`)、单值 (`needs: a`)
 *   与多行列表 (`needs:\n  - a`), 被全部摘空时删除整行/整块 `needs:`, 不留悬空 YAML。
 */

const TOP_LEVEL_KEY_RE = /^[^ \t#]/;
const JOBS_HEADER_RE = /^jobs:\s*(?:#.*)?$/;
const JOB_DECL_RE = /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/;
const NEEDS_INLINE_ARRAY_RE = /^(\s+needs:\s*)\[([^\]]*)\](\s*(?:#.*)?)$/;
const NEEDS_SCALAR_RE = /^(\s+needs:\s*)([^\s[#][^#]*?)(\s*(?:#.*)?)$/;
const NEEDS_BLOCK_HEADER_RE = /^(\s+)needs:\s*(?:#.*)?$/;
const NEEDS_LIST_ITEM_RE = /^(\s+)-\s+([^\s#]+)(\s*(?:#.*)?)$/;

/** 剥离单个 YAML 标量可能带有的成对单/双引号 */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** 收集多行 `needs:` 列表块覆盖的行区间 (不含末尾脱离列表的空行) */
function scanNeedsBlock(
  lines: readonly string[],
  headerIndex: number,
  needsIndent: number,
): { endIndex: number; items: { index: number; name: string }[] } {
  const items: { index: number; name: string }[] = [];
  let cursor = headerIndex + 1;
  let lastItemOrComment = headerIndex;

  while (cursor < lines.length) {
    const raw = lines[cursor]!;
    if (raw.trim() === '') {
      cursor += 1;
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    if (indent <= needsIndent) break;

    const itemMatch = NEEDS_LIST_ITEM_RE.exec(raw);
    if (itemMatch !== null) {
      items.push({ index: cursor, name: unquote(itemMatch[2]!) });
      lastItemOrComment = cursor;
      cursor += 1;
      continue;
    }
    if (raw.trimStart().startsWith('#')) {
      lastItemOrComment = cursor;
      cursor += 1;
      continue;
    }
    break;
  }

  return { endIndex: lastItemOrComment, items };
}

/** 列出 workflow 顶层 `jobs:` 块内声明的全部二级 job 名 */
export function listWorkflowJobs(source: string): Set<string> {
  const names = new Set<string>();
  let inJobs = false;
  for (const line of source.split('\n')) {
    if (JOBS_HEADER_RE.test(line)) {
      inJobs = true;
      continue;
    }
    if (TOP_LEVEL_KEY_RE.test(line)) {
      inJobs = false;
      continue;
    }
    if (!inJobs) continue;
    const match = JOB_DECL_RE.exec(line);
    if (match !== null) names.add(match[1]!);
  }
  return names;
}

/** 术后零残留自检: 检查 `jobs:` 块内是否仍残留被摘除的 job 定义或 `needs` 引用 */
export function findResidualWorkflowJobs(
  source: string,
  jobs: readonly string[],
): string[] {
  const jobSet = new Set(jobs);
  const lines = source.split('\n');
  const hits: string[] = [];
  let inJobs = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (JOBS_HEADER_RE.test(line)) {
      inJobs = true;
      continue;
    }
    if (TOP_LEVEL_KEY_RE.test(line)) {
      inJobs = false;
      continue;
    }
    if (!inJobs) continue;

    const decl = JOB_DECL_RE.exec(line);
    if (decl !== null && jobSet.has(decl[1]!)) {
      hits.push(`job 定义 '${decl[1]!}'`);
      continue;
    }

    const arrayMatch = NEEDS_INLINE_ARRAY_RE.exec(line);
    if (arrayMatch !== null) {
      const items = arrayMatch[2]!
        .split(',')
        .map((item) => unquote(item))
        .filter((item) => item.length > 0);
      if (items.length === 0) {
        hits.push('悬空 needs: []');
      }
      for (const item of items) {
        if (jobSet.has(item)) hits.push(`needs 引用 '${item}'`);
      }
      continue;
    }

    const scalarMatch = NEEDS_SCALAR_RE.exec(line);
    if (scalarMatch !== null) {
      const target = unquote(scalarMatch[2]!);
      if (jobSet.has(target)) hits.push(`needs 引用 '${target}'`);
      continue;
    }

    const blockMatch = NEEDS_BLOCK_HEADER_RE.exec(line);
    if (blockMatch !== null) {
      const { endIndex, items } = scanNeedsBlock(
        lines,
        index,
        blockMatch[1]!.length,
      );
      if (items.length === 0) {
        hits.push('悬空 needs:');
      }
      for (const item of items) {
        if (jobSet.has(item.name)) hits.push(`needs 引用 '${item.name}'`);
      }
      index = endIndex;
    }
  }

  return hits;
}

/** 按保留集合过滤多行 `needs:` 块内的列表项行 (全摘空时返回空数组) */
function pruneNeedsBlockLines(
  lines: readonly string[],
  headerIndex: number,
  endIndex: number,
  items: readonly { index: number; name: string }[],
  jobSet: ReadonlySet<string>,
): string[] {
  const keptIndices = new Set(
    items.filter((item) => !jobSet.has(item.name)).map((item) => item.index),
  );
  if (keptIndices.size === 0) return [];
  const keptLines: string[] = [lines[headerIndex]!];
  for (let cursor = headerIndex + 1; cursor <= endIndex; cursor += 1) {
    const blockLine = lines[cursor]!;
    if (!NEEDS_LIST_ITEM_RE.test(blockLine) || keptIndices.has(cursor)) {
      keptLines.push(blockLine);
    }
  }
  return keptLines;
}

/** 摘除 `jobs:` 块内指定 job 定义并同步清理/收缩 `needs` 引用 */
export function pruneWorkflowJobs(
  source: string,
  jobs: readonly string[],
): string {
  const jobSet = new Set(jobs);
  const lines = source.split('\n');
  const out: string[] = [];
  let inJobs = false;
  let skipping = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    if (JOBS_HEADER_RE.test(line)) {
      inJobs = true;
      skipping = false;
      out.push(line);
      continue;
    }
    if (TOP_LEVEL_KEY_RE.test(line)) {
      inJobs = false;
      skipping = false;
      out.push(line);
      continue;
    }
    if (!inJobs) {
      out.push(line);
      continue;
    }

    const jobMatch = JOB_DECL_RE.exec(line);
    if (jobMatch !== null) {
      const jobName = jobMatch[1]!;
      if (jobSet.has(jobName)) {
        while (out.length > 0 && /^ {2}#/.test(out[out.length - 1]!)) {
          out.pop();
        }
        while (
          out.length > 0 &&
          out[out.length - 1]!.trim() === '' &&
          !JOBS_HEADER_RE.test(out[out.length - 1]!)
        ) {
          out.pop();
        }
        skipping = true;
        continue;
      }
      if (skipping) {
        const prev = out[out.length - 1];
        if (
          prev !== undefined &&
          prev.trim() !== '' &&
          !JOBS_HEADER_RE.test(prev)
        ) {
          out.push('');
        }
        skipping = false;
      }
      out.push(line);
      continue;
    }

    if (skipping) continue;

    // 1) 行内数组 needs: [a, b]
    const arrayMatch = NEEDS_INLINE_ARRAY_RE.exec(line);
    if (arrayMatch !== null) {
      const kept = arrayMatch[2]!
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && !jobSet.has(unquote(item)));
      const suffix = arrayMatch[3] ?? '';
      if (kept.length === 1) {
        out.push(`${arrayMatch[1]!}${kept[0]!}${suffix}`);
      } else if (kept.length > 1) {
        out.push(`${arrayMatch[1]!}[${kept.join(', ')}]${suffix}`);
      }
      // kept.length === 0 时删除整行, 不留悬空 needs
      continue;
    }

    // 2) 单值 needs: foo
    const scalarMatch = NEEDS_SCALAR_RE.exec(line);
    if (scalarMatch !== null) {
      if (!jobSet.has(unquote(scalarMatch[2]!))) {
        out.push(line);
      }
      continue;
    }

    // 3) 多行列表 needs:\n  - foo
    const blockMatch = NEEDS_BLOCK_HEADER_RE.exec(line);
    if (blockMatch !== null) {
      const { endIndex, items } = scanNeedsBlock(
        lines,
        index,
        blockMatch[1]!.length,
      );
      if (items.length === 0) {
        out.push(line);
        continue;
      }
      out.push(...pruneNeedsBlockLines(lines, index, endIndex, items, jobSet));
      index = endIndex;
      continue;
    }

    out.push(line);
  }

  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
