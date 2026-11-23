import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  resolve,
} from 'node:path';

import {
  type InventoryCollector,
  classifyFileIntoCollector,
  walkSkillDirectory,
} from './pointers.ts';
import type { ResolveOptions } from './types.ts';

export interface DiscoveredSkillEntry {
  name: string;
  source: 'workspace' | 'global-agents' | 'global-claude' | 'builtin';
  entryPath: string;
  isSymlink: boolean;
}

/** 跨平台逐级提取路径前缀 (兼容 POSIX `/`、Windows 盘符根 `C:\` 与 UNC `\\server\share`) */
export function splitPathPrefixes(targetPath: string): string[] {
  const winDrive = targetPath.match(/^([A-Za-z]:)[\\/](.*)$/);
  if (winDrive !== null) {
    const root = `${winDrive[1]!}\\`;
    const rest = winDrive[2]!.split(/[\\/]+/).filter(Boolean);
    const prefixes: string[] = [];
    let acc = root;
    for (let i = 0; i < rest.length; i += 1) {
      acc = i === 0 ? `${root}${rest[i]!}` : `${acc}\\${rest[i]!}`;
      prefixes.push(acc);
    }
    return prefixes;
  }

  const unc = targetPath.match(
    /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)(?:[\\/](.*))?$/,
  );
  if (unc !== null) {
    const root = `\\\\${unc[1]!}\\${unc[2]!}`;
    const rest = (unc[3] ?? '').split(/[\\/]+/).filter(Boolean);
    const prefixes: string[] = [];
    let acc = root;
    for (const seg of rest) {
      acc = `${acc}\\${seg}`;
      prefixes.push(acc);
    }
    return prefixes;
  }

  const normalized = resolve(targetPath);
  const parsed = parse(normalized);
  const relBody = normalized.slice(parsed.root.length);
  const segments = relBody.split(/[\\/]+/).filter(Boolean);
  const prefixes: string[] = [];
  let current = parsed.root;
  for (const seg of segments) {
    current = join(current, seg);
    prefixes.push(current);
  }
  return prefixes;
}

function findHighestSymlinkPrefix(targetPath: string): string | undefined {
  for (const prefix of splitPathPrefixes(targetPath)) {
    try {
      if (lstatSync(prefix).isSymbolicLink()) return prefix;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function traceSymlinkChain(entryPath: string): {
  resolved: string;
  chain: string[];
} {
  const chain: string[] = [entryPath];
  let current = resolve(entryPath);

  for (let hop = 0; hop < 16; hop += 1) {
    const linkNode = findHighestSymlinkPrefix(current);
    if (linkNode === undefined) break;
    try {
      const linkTarget = readlinkSync(linkNode);
      const nextBase = isAbsolute(linkTarget)
        ? linkTarget
        : resolve(dirname(linkNode), linkTarget);
      const suffix = current.slice(linkNode.length).replace(/^[\\/]+/, '');
      const nextPath = suffix.length > 0 ? join(nextBase, suffix) : nextBase;
      if (nextPath === current) break;
      current = nextPath;
      if (chain[chain.length - 1] !== current) chain.push(current);
    } catch {
      break;
    }
  }

  const resolved = existsSync(entryPath) ? realpathSync(entryPath) : current;
  if (chain[chain.length - 1] !== resolved) chain.push(resolved);
  return { resolved, chain };
}

function looksLikeDotaiRoot(dir: string): boolean {
  return (
    existsSync(join(dir, 'src', 'agents')) ||
    existsSync(join(dir, 'targets', 'codex', 'agents'))
  );
}

export function detectDotaiRoot(
  candidatePaths: readonly string[],
  options: ResolveOptions,
): string | undefined {
  if (options.disableDotai) return undefined;
  if (options.dotaiRoot !== undefined) {
    const resolved = resolve(options.cwd, options.dotaiRoot);
    return existsSync(resolved) ? resolved : undefined;
  }
  for (const candidate of candidatePaths) {
    let cur = dirname(candidate);
    for (let depth = 0; depth < 8; depth += 1) {
      if (looksLikeDotaiRoot(cur)) return cur;
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  const fallback = join(homedir(), 'lab', 'dotAI');
  return looksLikeDotaiRoot(fallback) ? fallback : undefined;
}

export function getSearchRoots(cwd: string, dotaiRoot?: string) {
  const home = homedir();
  const roots: Array<{
    source: DiscoveredSkillEntry['source'];
    dir: string;
    mode: 'dir' | 'flat-md';
  }> = [
    { source: 'workspace', dir: join(cwd, '.agents', 'skills'), mode: 'dir' },
    {
      source: 'global-agents',
      dir: join(home, '.agents', 'skills'),
      mode: 'dir',
    },
    {
      source: 'global-claude',
      dir: join(home, '.claude', 'skills'),
      mode: 'dir',
    },
    {
      source: 'builtin',
      dir: join(home, '.gemini', 'antigravity-cli', 'builtin', 'skills'),
      mode: 'dir',
    },
  ];
  if (dotaiRoot !== undefined) {
    roots.push({
      source: 'global-agents',
      dir: join(dotaiRoot, 'src', 'skills'),
      mode: 'flat-md',
    });
  }
  return roots;
}

function resolveRootItemEntry(
  rootDir: string,
  mode: 'dir' | 'flat-md',
  entryName: string,
): { name: string; entryPath: string; isSymlink: boolean } | undefined {
  if (entryName.startsWith('.')) return undefined;
  const itemPath = join(rootDir, entryName);
  if (mode === 'flat-md' && entryName.endsWith('.md')) {
    if (entryName.toLowerCase() === 'readme.md') return undefined;
    if (!existsSync(itemPath) || !statSync(itemPath).isFile()) return undefined;
    return {
      name: basename(entryName, '.md'),
      entryPath: itemPath,
      isSymlink: lstatSync(itemPath).isSymbolicLink(),
    };
  }
  const entryPath = join(itemPath, 'SKILL.md');
  if (!existsSync(entryPath)) return undefined;
  return {
    name: entryName,
    entryPath,
    isSymlink:
      lstatSync(itemPath).isSymbolicLink() ||
      lstatSync(entryPath).isSymbolicLink(),
  };
}

function hasCompiledMirrorSeen(
  dotaiRoot: string | undefined,
  skillName: string,
  seen: ReadonlySet<string>,
): boolean {
  if (dotaiRoot === undefined) return false;
  const compiledMd = join(
    dotaiRoot,
    'targets',
    'codex',
    'skills',
    skillName,
    'SKILL.md',
  );
  if (!existsSync(compiledMd)) return false;
  return seen.has(realpathSync(compiledMd));
}

export function listAllInstalledSkills(options: ResolveOptions): {
  dotaiRoot?: string;
  entries: DiscoveredSkillEntry[];
} {
  const dotaiRoot = detectDotaiRoot([options.cwd], options);
  const roots = getSearchRoots(options.cwd, dotaiRoot);
  const seen = new Set<string>();
  const entries: DiscoveredSkillEntry[] = [];

  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    for (const dirent of readdirSync(root.dir, { withFileTypes: true })) {
      const item = resolveRootItemEntry(root.dir, root.mode, dirent.name);
      if (item === undefined) continue;
      const canonical = realpathSync(item.entryPath);
      if (seen.has(canonical)) continue;
      if (
        root.mode === 'flat-md' &&
        hasCompiledMirrorSeen(dotaiRoot, item.name, seen)
      ) {
        continue;
      }
      seen.add(canonical);
      entries.push({
        name: item.name,
        source: root.source,
        entryPath: item.entryPath,
        isSymlink: item.isSymlink,
      });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { dotaiRoot, entries };
}

export function resolveTargetEntryPath(
  targetInput: string,
  options: ResolveOptions,
): { entryPath: string; isSingleFileSkill: boolean } {
  const searchedPaths: string[] = [];
  const candidatePath = isAbsolute(targetInput)
    ? targetInput
    : resolve(options.cwd, targetInput);

  if (existsSync(candidatePath)) {
    const stat = statSync(candidatePath);
    if (stat.isDirectory()) {
      const skillMd = join(candidatePath, 'SKILL.md');
      searchedPaths.push(skillMd);
      if (existsSync(skillMd)) {
        return { entryPath: skillMd, isSingleFileSkill: false };
      }
    } else if (candidatePath.endsWith('.md')) {
      searchedPaths.push(candidatePath);
      return {
        entryPath: candidatePath,
        isSingleFileSkill: basename(candidatePath) !== 'SKILL.md',
      };
    }
  }

  const dotaiHint = detectDotaiRoot([options.cwd], options);
  for (const root of getSearchRoots(options.cwd, dotaiHint)) {
    const candidate =
      root.mode === 'dir'
        ? join(root.dir, targetInput, 'SKILL.md')
        : join(root.dir, `${targetInput}.md`);
    searchedPaths.push(candidate);
    if (existsSync(candidate)) {
      return {
        entryPath: candidate,
        isSingleFileSkill: root.mode === 'flat-md',
      };
    }
  }

  throw new Error(
    `未找到目标 skill "${targetInput}", 已检索路径:\n${searchedPaths.map((p) => `  - ${p}`).join('\n')}`,
  );
}

export function resolveFirstExisting(
  candidates: readonly string[],
): string | undefined {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  return undefined;
}

export function resolveAgentPath(agentName: string, dotaiRoot?: string) {
  const candidates: string[] = [];
  if (dotaiRoot !== undefined) {
    candidates.push(join(dotaiRoot, 'src', 'agents', `${agentName}.md`));
    candidates.push(
      join(dotaiRoot, 'targets', 'codex', 'agents', `${agentName}.toml`),
    );
  }
  candidates.push(join(homedir(), '.claude', 'agents', `${agentName}.md`));
  return {
    foundPath: resolveFirstExisting(candidates),
    searchedPaths: candidates,
  };
}

export function resolveResourceDir(subdir: string, dotaiRoot?: string) {
  if (dotaiRoot === undefined)
    return { foundPath: undefined, searchedPaths: [] };
  const candidates = [
    join(dotaiRoot, 'src', 'resources', subdir),
    join(dotaiRoot, 'targets', 'codex', 'resources', subdir),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && lstatSync(candidate).isDirectory()) {
      return { foundPath: realpathSync(candidate), searchedPaths: candidates };
    }
  }
  return { foundPath: undefined, searchedPaths: candidates };
}

export function resolveExternalScript(
  ref: string,
  baseDocDir: string,
  cwd: string,
  dotaiRoot?: string,
): string | undefined {
  if (isAbsolute(ref)) {
    if (dotaiRoot !== undefined) {
      const m = ref
        .replaceAll('\\', '/')
        .match(/\/targets\/[^/]+\/resources\/([^/]+)\/(.+)$/);
      if (m?.[1] !== undefined && m[2] !== undefined) {
        const srcVer = join(dotaiRoot, 'src', 'resources', m[1], m[2]);
        if (existsSync(srcVer)) return realpathSync(srcVer);
      }
    }
    return existsSync(ref) ? realpathSync(ref) : undefined;
  }
  const candidates = [resolve(baseDocDir, ref), resolve(cwd, ref)];
  if (dotaiRoot !== undefined) candidates.push(resolve(dotaiRoot, ref));
  return resolveFirstExisting(candidates);
}

export function attachCompanionTestsAndSchemas(
  scriptAbsPath: string,
  cwd: string,
  collector: InventoryCollector,
  walkedSubdirs: Set<string>,
): void {
  const dir = dirname(scriptAbsPath);
  const stem = basename(scriptAbsPath, extname(scriptAbsPath));
  const isDedicatedShared =
    basename(dir) === '_shared' ||
    dir.replaceAll('\\', '/').includes('/_runner/');
  if (isDedicatedShared && !walkedSubdirs.has(dir)) {
    walkedSubdirs.add(dir);
    walkSkillDirectory(dir, 'external-ref', cwd, collector);
    return;
  }
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (
      entry.name.startsWith(`${stem}.test.`) ||
      entry.name.startsWith(`${stem}.spec.`)
    ) {
      classifyFileIntoCollector(
        join(dir, entry.name),
        'external-ref',
        cwd,
        collector,
      );
    }
  }
}
