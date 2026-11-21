import { basename } from 'node:path';

import type { CommandCallSite, SignalCategory } from './types.ts';

interface SignalRule {
  category: SignalCategory;
  weight: number;
  patterns: readonly RegExp[];
}

export const SIGNAL_RULES: readonly SignalRule[] = [
  {
    category: 'FULL_REPO_SCAN',
    weight: 3,
    patterns: [
      /全仓(?:列出|扫描|检索|查找|搜索|审计|核对|追踪)/,
      /逐[个条一](?:扫描|对照|检查|核对|列出|审校|比对|提取|文件|包|模块|载体)/,
      /按载体分层[^\n]{0,16}?扫描|找出所有|遍历(?:全仓|目录|所有|全部)/,
      /列出[^\n]{0,16}?(?:清单|目录|文件|符号)/,
      /\b(?:scan|walk|traverse)\s+(?:the\s+)?(?:entire|whole|all)\b/i,
    ],
  },
  {
    category: 'AST_OR_DEPENDENCY_GRAPH',
    weight: 3,
    patterns: [
      /调用点|导出面|函数签名|传递可达|依赖图|调用链|同构链路|兄弟实现|符号重命名/,
      /公开(?:导出|接口|字段)|代码里有[^\n]{0,16}?文档没有/,
      /\bAST\b|\b(?:callers?|callees?|imports?|exports?|dependency\s+graph|reachability)\b/i,
    ],
  },
  {
    category: 'EXACT_DIFF_OR_MATCHING',
    weight: 2,
    patterns: [
      /对比[^\n]{0,24}?是否一致|逐条比对|死链|幽灵设施|过时[^\n]{0,12}?漂移|是否与实际一致/,
      /绑定\s*file:line|按[^\n]{0,12}?(?:分组|降序|排序)|计数|重号|去重|枚举成员|默认值|字段名与类型|覆盖表/,
      /\b(?:dead\s+links?|duplicates?|consistency|count|enum\s+members?)\b/i,
    ],
  },
  {
    category: 'FORMAT_OR_SCHEMA_VALIDATION',
    weight: 2,
    patterns: [
      /(?:跑|执行|过)[^\n]{0,14}?闸门|格式校验|门禁校验|必填字段|字段校验|实物校验/,
      /(?:文件名|frontmatter)[^\n]{0,12}?(?:检查|校验|核对)|非\s*git|空\s*diff[^\n]{0,12}?终止|固定句式/,
      /\b(?:schema|validate|lint|json\s+fields?|exit\s+code)\b/i,
    ],
  },
  {
    category: 'STATE_MACHINE_OR_ROLLBACK',
    weight: 2,
    patterns: [
      /台账|状态机|检查点|断点恢复|幂等|原子[^\n]{0,10}?备份|快照[^\n]{0,10}?回滚|收敛条件|熔断/,
      /\b(?:ledger|checkpoint|rollback|state\.json|convergence)\b/i,
    ],
  },
  {
    category: 'STATISTICAL_OR_BENCHMARK',
    weight: 2,
    patterns: [
      /性能基准|基准(?:对比|测量|采样|套件|压测|耗时)|压测|耗时[^\n]{0,12}?下降|统计显著|显著性检验|方差|噪声门槛|采样/,
      /\b(?:benchmark|p-value|mann-whitney|median|p95|latency)\b/i,
    ],
  },
  {
    category: 'PURE_SHELL_OR_ENV_PROBE',
    weight: 1,
    patterns: [
      /获取当前[^\n]{0,12}?目录结构|读\s*`?git\s+(?:diff|status)|硬件[^\n]{0,10}?采集|环境变量/,
      /\b(?:git\s+diff|git\s+status|readdir|lstat|uname|lsblk)\b/i,
    ],
  },
];

const RUNNER_COMMAND_PATTERN =
  /\b(?:bun|node|python3?|bash|sh|deno|uv)\s+([^\s`'"|;&&]+(?:\.(?:ts|mts|js|mjs|cjs|py|sh))?)/;

const SHELL_TOOL_PATTERN =
  /\b(?:git\s+(?:diff|status|log|show)[^\n`]*|eza\s+--tree[^\n`]*|rg\s+[^\n`]*|grep\s+[^\n`]*|oxlint\b[^\n`]*|tsc\b[^\n`]*)/;

const PROHIBITED_CMD_LINE =
  /^\s*(?:[-*]\s*)?❌|^\s*(?:[-*]\s*)?(?:严禁|禁止|不得|不要)[^\n]{0,12}?\b(?:grep|find|cat|ls|git\s+status|fd)\b/;

const DECLARATION_HEADING_PATTERN =
  /(?:边界|Boundary|Scope|范围|定位|锚点|Anchor|示例|Example|前置阅读|失效模式|黑名单|红线复述|Core Role|核心角色|导言)/i;

const ACTION_VERB_PATTERN =
  /(?:读取|读\s*`|运行|扫描|检索|查找|对比|比对|核对|校验|计算|生成|写入|输出|构建|派发)/;

const DELEGATED_OR_NEGATED_PROSE =
  /(?:已由[^\n]{0,20}?(?:脚本|闸门|buildCheck|validate|collect)|由[^\n]{0,24}?(?:脚本|闸门|buildCheck|validate\w*|collect\w*)[^\n]{0,12}?(?:负责|完成|校验|强制|把关|核验)|(?:禁止|严禁)[^\n]{0,16}?(?:手工|肉眼|靠记忆|自行|重新扫描))/;

export interface MarkdownChunk {
  section: string;
  topSection: string;
  isStepItem: boolean;
  lineStart: number;
  lineEnd: number;
  proseLines: string[];
  codeLines: string[];
  rawLines: string[];
}

interface TaggedLine {
  lineNo: number;
  text: string;
  inFence: boolean;
}

function buildChunk(
  section: string,
  topSection: string,
  isStepItem: boolean,
  entries: readonly TaggedLine[],
): MarkdownChunk | undefined {
  if (entries.length === 0) return undefined;
  const proseLines: string[] = [];
  const codeLines: string[] = [];
  const rawLines: string[] = [];
  for (const entry of entries) {
    rawLines.push(entry.text);
    if (entry.inFence) {
      codeLines.push(entry.text);
    } else {
      proseLines.push(entry.text);
    }
  }
  const nonEmptyProse = proseLines.join(' ').trim();
  if (nonEmptyProse.length < 12 && codeLines.length === 0) return undefined;
  return {
    section,
    topSection,
    isStepItem,
    lineStart: entries[0]!.lineNo,
    lineEnd: entries[entries.length - 1]!.lineNo,
    proseLines,
    codeLines,
    rawLines,
  };
}

function findFrontmatterEnd(lines: readonly string[]): number {
  if (lines[0]?.trim() !== '---') return 0;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === '---') return i + 1;
  }
  return 0;
}

function splitHeadingBlockIntoChunks(
  section: string,
  topSection: string,
  entries: readonly TaggedLine[],
): MarkdownChunk[] {
  const stepIndices: number[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (!entry.inFence && /^\d+\.\s+/.test(entry.text)) {
      stepIndices.push(i);
    }
  }

  if (stepIndices.length < 2) {
    const whole = buildChunk(section, topSection, false, entries);
    return whole === undefined ? [] : [whole];
  }

  const out: MarkdownChunk[] = [];
  if (stepIndices[0]! > 0) {
    const intro = buildChunk(
      section,
      topSection,
      false,
      entries.slice(0, stepIndices[0]!),
    );
    if (intro !== undefined) out.push(intro);
  }
  for (let s = 0; s < stepIndices.length; s += 1) {
    const from = stepIndices[s]!;
    const to =
      s + 1 < stepIndices.length ? stepIndices[s + 1]! : entries.length;
    const slice = entries.slice(from, to);
    const stepNo = slice[0]!.text.match(/^(\d+)\./)?.[1] ?? String(s + 1);
    const chunk = buildChunk(
      `${section} · 步骤 ${stepNo}`,
      topSection,
      true,
      slice,
    );
    if (chunk !== undefined) out.push(chunk);
  }
  return out;
}

export function splitMarkdownIntoChunks(content: string): MarkdownChunk[] {
  const lines = content.split('\n');
  const startIdx = findFrontmatterEnd(lines);

  const headingBlocks: Array<{
    section: string;
    topSection: string;
    entries: TaggedLine[];
  }> = [];
  let currentSection = '(导言 / 顶层正文)';
  let currentTopSection = '(导言 / 顶层正文)';
  let currentEntries: TaggedLine[] = [];
  let inFence = false;
  const headingStack: Array<{ level: number; title: string }> = [];

  for (let i = startIdx; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (/^(?:```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      currentEntries.push({ lineNo: i + 1, text: raw, inFence: true });
      continue;
    }
    const headingMatch = inFence ? null : raw.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (headingMatch !== null) {
      if (currentEntries.length > 0) {
        headingBlocks.push({
          section: currentSection,
          topSection: currentTopSection,
          entries: currentEntries,
        });
      }
      const level = headingMatch[1]!.length;
      const title = headingMatch[2]!.trim();
      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1]!.level >= level
      ) {
        headingStack.pop();
      }
      headingStack.push({ level, title });
      currentSection = headingStack.map((h) => h.title).join(' > ');
      currentTopSection = headingStack[0]!.title;
      currentEntries = [];
      continue;
    }
    currentEntries.push({ lineNo: i + 1, text: raw, inFence });
  }

  if (currentEntries.length > 0) {
    headingBlocks.push({
      section: currentSection,
      topSection: currentTopSection,
      entries: currentEntries,
    });
  }

  const chunks: MarkdownChunk[] = [];
  for (const block of headingBlocks) {
    chunks.push(
      ...splitHeadingBlockIntoChunks(
        block.section,
        block.topSection,
        block.entries,
      ),
    );
  }
  return chunks;
}

export function extractCommandCallSites(
  fileDisplay: string,
  content: string,
): CommandCallSite[] {
  const lines = content.split('\n');
  const calls: CommandCallSite[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (PROHIBITED_CMD_LINE.test(line)) continue;
    const runnerMatch = line.match(RUNNER_COMMAND_PATTERN);
    if (runnerMatch !== null) {
      const cmdText = runnerMatch[0]!;
      const arg = runnerMatch[1] ?? '';
      const isScriptArg = /\.(?:ts|mts|js|mjs|cjs|py|sh)$/.test(arg);
      let kind: CommandCallSite['kind'] = 'cli-tool';
      if (isScriptArg) {
        kind =
          arg.startsWith('/') || arg.includes('dotAI')
            ? 'external-script'
            : 'local-script';
      }
      calls.push({
        file: fileDisplay,
        line: i + 1,
        command: cmdText.slice(0, 120),
        kind,
      });
      continue;
    }
    const shellMatch = line.match(SHELL_TOOL_PATTERN);
    if (shellMatch !== null) {
      calls.push({
        file: fileDisplay,
        line: i + 1,
        command: shellMatch[0]!.trim().slice(0, 120),
        kind: 'git-or-shell',
      });
    }
  }
  return calls;
}

export function findNearbyScriptReferences(
  chunk: MarkdownChunk,
  knownScriptNames: ReadonlySet<string>,
): string[] {
  const found = new Set<string>();
  const combined = chunk.rawLines.join('\n');
  for (const m of combined.matchAll(
    /(?:bun|node|python3?|bash|sh)\s+([^\s`'"|;&&]+\.(?:ts|mts|js|mjs|cjs|py|sh))/g,
  )) {
    if (m[1] !== undefined) found.add(basename(m[1]));
  }
  for (const name of knownScriptNames) {
    if (combined.includes(name)) found.add(name);
  }
  return Array.from(found).sort();
}

export function isNonActionDeclarationChunk(chunk: MarkdownChunk): boolean {
  if (!DECLARATION_HEADING_PATTERN.test(chunk.section)) return false;
  if (chunk.codeLines.length > 0) return false;
  return !ACTION_VERB_PATTERN.test(chunk.proseLines.join(' '));
}

export function isDelegatedOrNegatedProse(prose: string): boolean {
  return DELEGATED_OR_NEGATED_PROSE.test(prose);
}

export function matchSignalCategories(prose: string): {
  categories: SignalCategory[];
  matchedTerms: string[];
  score: number;
} {
  const categories: SignalCategory[] = [];
  const matchedTerms: string[] = [];
  let score = 0;

  for (const rule of SIGNAL_RULES) {
    let hitRule = false;
    for (const pat of rule.patterns) {
      const match = prose.match(pat);
      if (match !== null) {
        hitRule = true;
        matchedTerms.push(match[0]!);
      }
    }
    if (hitRule) {
      categories.push(rule.category);
      score += rule.weight;
    }
  }

  return {
    categories,
    matchedTerms: Array.from(new Set(matchedTerms)).slice(0, 6),
    score,
  };
}
