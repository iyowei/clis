import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, relative } from 'node:path';

import type {
  AssetOrigin,
  SchemaAsset,
  ScriptAsset,
  TestAsset,
} from './types.ts';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  '__pycache__',
  '.venv',
  '.next',
  'mutants',
]);

const SCRIPT_EXTS = new Set([
  '.ts',
  '.mts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.py',
  '.sh',
  '.bash',
  '.zsh',
]);

const TEST_FILE_PATTERN =
  /\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.py$|test_.*\.py$/i;
const SCHEMA_FILE_PATTERN =
  /(?:^|[._-])(?:schema|manifest|catalog|checklist)\.json$/i;
const SIDECAR_CONFIG_PATTERN = /^(?:openai\.ya?ml|plugin\.json|hooks\.json)$/i;
const VALID_AGENT_NAME = /^[a-z0-9][a-z0-9_-]{1,63}$/i;
const IGNORED_AGENT_TOKENS = new Set([
  'name',
  'agent',
  'subagent',
  'worker',
  'example',
]);

const NEGATION_CONTEXT =
  /(?:严禁|禁止|不得|不(?!仅).*?(?:派发|加载|调用|唤起)|不属于|不在此处维护|职责分工|仅作.*界定)/;
const EXCLUSION_SKILL_CONTEXT =
  /(?:不在此处维护|(?:归|属于)\s*\/?\$\{SKILL_REF:|严禁.*?\$\{SKILL_REF:)/;
const RULE_FILENAME_PATTERN = /\b([A-Z][A-Z0-9_]{2,}\.md)\b/g;
const IGNORED_RULE_DOCS = new Set([
  'SKILL.md',
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'CHANGELOG.md',
  'ARCHITECTURE.md',
  'MEMORY.md',
  'TODO.md',
]);

export interface FrontmatterInfo {
  hasFrontmatter: boolean;
  name?: string;
  dispatch?: string;
  disallowedTools?: string[];
  designDocs?: string[];
  bodyStartLine: number;
}

export interface InventoryCollector {
  implScripts: Map<string, ScriptAsset>;
  sharedInfraScripts: Map<string, ScriptAsset>;
  testFiles: Map<string, TestAsset>;
  schemaFiles: Map<string, SchemaAsset>;
  sidecarConfigFiles: Set<string>;
  docFiles: Set<string>;
}

export interface ExtractedPointers {
  primaryDispatchAgent?: string;
  referencedAgents: Array<{ name: string; line: number; isPrimary: boolean }>;
  linkedSkills: string[];
  excludedSkills: string[];
  linkedRules: Array<{ name: string; line: number }>;
  resourceDirs: Array<{ ref: string; line: number }>;
  scriptPaths: Array<{ ref: string; line: number }>;
}

export function formatDisplayPath(absPath: string, cwd: string): string {
  const rel = relative(cwd, absPath).replaceAll('\\', '/');
  if (!rel.startsWith('..') && rel !== '') return rel;
  const home = homedir();
  if (absPath.startsWith(`${home}/`)) {
    return `~/${absPath.slice(home.length + 1)}`;
  }
  return absPath;
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

function parseListValue(raw: string): string[] {
  return raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter((item) => item.length > 0);
}

export function parseFrontmatter(content: string): FrontmatterInfo {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { hasFrontmatter: false, bodyStartLine: 0 };
  }
  let endLine = -1;
  let name: string | undefined;
  let dispatch: string | undefined;
  let disallowedTools: string[] | undefined;
  let designDocs: string[] | undefined;

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === '---') {
      endLine = i;
      break;
    }
    const nameMatch = line.match(/^name:\s*(.+)$/);
    if (nameMatch) name = nameMatch[1]!.trim().replace(/^['"]|['"]$/g, '');
    const dispatchMatch = line.match(/^dispatch:\s*(.+)$/);
    if (dispatchMatch) {
      dispatch = dispatchMatch[1]!.trim().replace(/^['"]|['"]$/g, '');
    }
    const toolsMatch = line.match(/^\s*disallowedTools:\s*(.+)$/);
    if (toolsMatch) disallowedTools = parseListValue(toolsMatch[1]!);
    const designMatch = line.match(/^design_docs:\s*(.+)$/);
    if (designMatch) designDocs = parseListValue(designMatch[1]!);
  }
  if (endLine === -1) return { hasFrontmatter: false, bodyStartLine: 0 };

  return {
    hasFrontmatter: true,
    name,
    dispatch,
    disallowedTools,
    designDocs,
    bodyStartLine: endLine + 1,
  };
}

export function createCollector(): InventoryCollector {
  return {
    implScripts: new Map(),
    sharedInfraScripts: new Map(),
    testFiles: new Map(),
    schemaFiles: new Map(),
    sidecarConfigFiles: new Set(),
    docFiles: new Set(),
  };
}

export function isSharedInfraScriptPath(absPath: string): boolean {
  return /\/scripts\/(?:translate-agents|setup|export-agent|remove-agent|lint-zh-typography|check-doc-links|clean-backups|lint-doc-|ci\.ts)/.test(
    absPath,
  );
}

export function classifyFileIntoCollector(
  filePath: string,
  origin: AssetOrigin,
  cwd: string,
  collector: InventoryCollector,
): void {
  let canonical: string;
  try {
    canonical = realpathSync(filePath);
  } catch {
    return;
  }
  const name = basename(canonical);
  const ext = extname(name).toLowerCase();

  if (name.endsWith('.md')) {
    collector.docFiles.add(canonical);
    return;
  }
  if (SIDECAR_CONFIG_PATTERN.test(name)) {
    collector.sidecarConfigFiles.add(formatDisplayPath(canonical, cwd));
    return;
  }
  if (SCHEMA_FILE_PATTERN.test(name)) {
    if (!collector.schemaFiles.has(canonical)) {
      const text = readFileSync(canonical, 'utf8');
      collector.schemaFiles.set(canonical, {
        path: formatDisplayPath(canonical, cwd),
        bytes: Buffer.byteLength(text, 'utf8'),
        origin,
      });
    }
    return;
  }
  if (!SCRIPT_EXTS.has(ext)) return;

  const text = readFileSync(canonical, 'utf8');
  const lines = countLines(text);
  if (TEST_FILE_PATTERN.test(name)) {
    if (!collector.testFiles.has(canonical)) {
      collector.testFiles.set(canonical, {
        path: formatDisplayPath(canonical, cwd),
        lines,
        origin,
      });
    }
    return;
  }
  const targetMap =
    origin === 'shared-infra' || isSharedInfraScriptPath(canonical)
      ? collector.sharedInfraScripts
      : collector.implScripts;
  if (!targetMap.has(canonical)) {
    targetMap.set(canonical, {
      path: formatDisplayPath(canonical, cwd),
      lines,
      bytes: Buffer.byteLength(text, 'utf8'),
      ext,
      origin: isSharedInfraScriptPath(canonical) ? 'shared-infra' : origin,
    });
  }
}

export function walkSkillDirectory(
  dir: string,
  origin: AssetOrigin,
  cwd: string,
  collector: InventoryCollector,
): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSkillDirectory(full, origin, cwd, collector);
    } else if (entry.isFile()) {
      classifyFileIntoCollector(full, origin, cwd, collector);
    }
  }
}

interface PointerScanState {
  referencedAgents: Array<{ name: string; line: number; isPrimary: boolean }>;
  seenAgents: Set<string>;
  linkedSkills: Set<string>;
  excludedSkills: Set<string>;
  linkedRules: Array<{ name: string; line: number }>;
  seenRules: Set<string>;
  resourceDirs: Array<{ ref: string; line: number }>;
  seenResourceDirs: Set<string>;
  scriptPaths: Array<{ ref: string; line: number }>;
  seenScripts: Set<string>;
}

function recordAgentCandidate(
  name: string,
  line: number,
  isPrimary: boolean,
  state: PointerScanState,
): void {
  const clean = name.trim().replace(/^[`'"]|[`'"]$/g, '');
  if (!VALID_AGENT_NAME.test(clean)) return;
  if (IGNORED_AGENT_TOKENS.has(clean.toLowerCase())) return;
  const key = `${clean}:${isPrimary ? '1' : '0'}`;
  if (state.seenAgents.has(key)) return;
  state.seenAgents.add(key);
  state.referencedAgents.push({ name: clean, line, isPrimary });
}

function scanLinePointers(
  line: string,
  lineNo: number,
  selfSkillName: string,
  state: PointerScanState,
): void {
  const isNegatedLine = NEGATION_CONTEXT.test(line);
  // 依 CLAUDE_CODE.md「反引号提及隔离」: 反引号包裹的引用属阐述性提及, 不作为真实触发/派发链路解包
  const strippedBackticks = line.replace(/`+[^`]*`+/g, ' ');
  const cnDispatch = strippedBackticks.match(
    /必须立即派发\s+([a-zA-Z0-9_-]+)\s+子代理/,
  );
  if (cnDispatch?.[1] !== undefined) {
    recordAgentCandidate(cnDispatch[1], lineNo, true, state);
  }
  if (!isNegatedLine) {
    for (const m of strippedBackticks.matchAll(
      /\$\{AGENT_REF:([a-zA-Z0-9_-]+)\}/g,
    )) {
      if (m[1] !== undefined) recordAgentCandidate(m[1], lineNo, false, state);
    }
    if (
      strippedBackticks.includes('子代理') ||
      strippedBackticks.includes('dispatch')
    ) {
      for (const m of strippedBackticks.matchAll(
        /(?:派|dispatch)\s+[`'"]?([a-z0-9][a-z0-9_-]{2,})[`'"]?\s*(?:子代理|agent)?/gi,
      )) {
        if (m[1] !== undefined)
          recordAgentCandidate(m[1], lineNo, false, state);
      }
    }
  }
  for (const m of strippedBackticks.matchAll(
    /\$\{SKILL_REF:([a-zA-Z0-9_-]+)\}/g,
  )) {
    const sk = m[1];
    if (sk === undefined || sk === selfSkillName) continue;
    if (EXCLUSION_SKILL_CONTEXT.test(line) || isNegatedLine) {
      state.excludedSkills.add(sk);
    } else {
      state.linkedSkills.add(sk);
    }
  }
  for (const m of line.matchAll(RULE_FILENAME_PATTERN)) {
    const ruleName = m[1];
    if (
      ruleName !== undefined &&
      !IGNORED_RULE_DOCS.has(ruleName) &&
      !state.seenRules.has(ruleName)
    ) {
      state.seenRules.add(ruleName);
      state.linkedRules.push({ name: ruleName, line: lineNo });
    }
  }
  for (const m of line.matchAll(/\$\{RESOURCES_ROOT\}\/([a-zA-Z0-9_-]+)/g)) {
    const ref = m[1];
    if (ref !== undefined && !state.seenResourceDirs.has(ref)) {
      state.seenResourceDirs.add(ref);
      state.resourceDirs.push({ ref, line: lineNo });
    }
  }
  for (const m of line.matchAll(
    /(?:\/Users\/[^\s`'")\]]+|(?:\.\.?\/)+[^\s`'")\]]+|[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+)\.(?:ts|mts|js|mjs|cjs|py|sh)\b/g,
  )) {
    const ref = m[0];
    if (ref !== undefined && !state.seenScripts.has(ref)) {
      state.seenScripts.add(ref);
      state.scriptPaths.push({ ref, line: lineNo });
    }
  }
  for (const m of line.matchAll(
    /(?:\/Users\/[^\s`'")\]]+|(?:\.\.?\/)+[^\s`'")\]]+)\/(?:targets\/[^/\s]+\/|src\/)?resources\/([a-zA-Z0-9_-]+)/g,
  )) {
    const ref = m[1];
    if (ref !== undefined && !state.seenResourceDirs.has(ref)) {
      state.seenResourceDirs.add(ref);
      state.resourceDirs.push({ ref, line: lineNo });
    }
  }
}

export function extractPointersFromMarkdown(
  content: string,
  frontmatter: FrontmatterInfo,
  selfSkillName = '',
): ExtractedPointers {
  const state: PointerScanState = {
    referencedAgents: [],
    seenAgents: new Set(),
    linkedSkills: new Set(),
    excludedSkills: new Set(),
    linkedRules: [],
    seenRules: new Set(),
    resourceDirs: [],
    seenResourceDirs: new Set(),
    scriptPaths: [],
    seenScripts: new Set(),
  };

  if (frontmatter.dispatch !== undefined) {
    recordAgentCandidate(frontmatter.dispatch, 1, true, state);
  }
  const lines = content.split('\n');
  for (let idx = 0; idx < lines.length; idx += 1) {
    scanLinePointers(lines[idx]!, idx + 1, selfSkillName, state);
  }

  const primary =
    state.referencedAgents.find((a) => a.isPrimary)?.name ??
    frontmatter.dispatch;
  return {
    primaryDispatchAgent: primary,
    referencedAgents: state.referencedAgents,
    linkedSkills: Array.from(state.linkedSkills),
    excludedSkills: Array.from(state.excludedSkills),
    linkedRules: state.linkedRules,
    resourceDirs: state.resourceDirs,
    scriptPaths: state.scriptPaths,
  };
}
