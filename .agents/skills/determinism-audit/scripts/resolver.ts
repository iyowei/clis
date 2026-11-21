import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  attachCompanionTestsAndSchemas,
  detectDotaiRoot,
  listAllInstalledSkills,
  resolveAgentPath,
  resolveExternalScript,
  resolveResourceDir,
  resolveTargetEntryPath,
  traceSymlinkChain,
} from './discovery.ts';
import {
  type FrontmatterInfo,
  type InventoryCollector,
  classifyFileIntoCollector,
  countLines,
  createCollector,
  extractPointersFromMarkdown,
  formatDisplayPath,
  parseFrontmatter,
  walkSkillDirectory,
} from './pointers.ts';
import type {
  DocumentRole,
  ResolveOptions,
  ResolvedDocument,
  ScriptInventory,
  UnresolvedTarget,
} from './types.ts';

export { formatDisplayPath, listAllInstalledSkills };

export interface ResolvedBundle {
  targetInput: string;
  skillName: string;
  resolvedEntryPath: string;
  symlinkChain: string[];
  isThinDispatcher: boolean;
  forwardedAgents: string[];
  linkedSkills: string[];
  excludedSkills: string[];
  linkedRules: string[];
  dotaiRoot?: string;
  documents: ResolvedDocument[];
  docContents: Map<string, string>;
  inventory: ScriptInventory;
  unresolvedTargets: UnresolvedTarget[];
}

interface UnpackContext {
  cwd: string;
  dotaiRoot?: string;
  entryDisplayPath: string;
  selfSkillName: string;
  documents: ResolvedDocument[];
  docContents: Map<string, string>;
  collector: InventoryCollector;
  unresolvedTargets: UnresolvedTarget[];
  allLinkedSkills: Set<string>;
  allExcludedSkills: Set<string>;
  allLinkedRules: Set<string>;
}

function registerDoc(
  absPath: string,
  role: DocumentRole,
  ctx: Pick<UnpackContext, 'documents' | 'docContents'>,
  excluded = false,
): FrontmatterInfo {
  const canonical = realpathSync(absPath);
  const cached = ctx.docContents.get(canonical);
  if (cached !== undefined) return parseFrontmatter(cached);
  const content = readFileSync(canonical, 'utf8');
  const fm = parseFrontmatter(content);
  ctx.docContents.set(canonical, content);
  ctx.documents.push({
    path: canonical,
    role,
    lineCount: countLines(content),
    byteCount: Buffer.byteLength(content, 'utf8'),
    hasFrontmatter: fm.hasFrontmatter,
    dispatchTarget: fm.dispatch,
    disallowedTools: fm.disallowedTools,
    designDocs: fm.designDocs,
    excludedFromHotspotScan: excluded ? true : undefined,
  });
  return fm;
}

function unpackAgentsBfs(
  initialAgents: ReadonlyArray<{
    name: string;
    line: number;
    isPrimary: boolean;
  }>,
  resourceDirs: Array<{ ref: string; line: number }>,
  scriptRefs: Array<{ ref: string; line: number; docPath: string }>,
  ruleRefs: Array<{ name: string; line: number }>,
  ctx: UnpackContext,
): string[] {
  const forwardedAgents: string[] = [];
  const seenNames = new Set<string>();
  const unpackedPaths = new Set<string>();
  const queue = initialAgents.map((item) => ({ ...item, hop: 1 }));

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (seenNames.has(item.name)) continue;
    seenNames.add(item.name);
    forwardedAgents.push(item.name);
    if (!item.isPrimary && initialAgents.length > 6 && item.hop === 1) continue;

    const { foundPath, searchedPaths } = resolveAgentPath(
      item.name,
      ctx.dotaiRoot,
    );
    if (foundPath === undefined) {
      ctx.unresolvedTargets.push({
        kind: 'agent',
        reference: item.name,
        sourceFile: ctx.entryDisplayPath,
        line: item.line,
        searchedPaths,
      });
      continue;
    }
    if (unpackedPaths.has(foundPath)) continue;
    unpackedPaths.add(foundPath);

    const fm = registerDoc(foundPath, 'forwarded-agent', ctx);
    const ptrs = extractPointersFromMarkdown(
      ctx.docContents.get(foundPath) ?? '',
      fm,
      ctx.selfSkillName,
    );
    resourceDirs.push(...ptrs.resourceDirs);
    ruleRefs.push(...ptrs.linkedRules);
    for (const s of ptrs.scriptPaths)
      scriptRefs.push({ ...s, docPath: foundPath });
    for (const sk of ptrs.linkedSkills) ctx.allLinkedSkills.add(sk);
    for (const ex of ptrs.excludedSkills) ctx.allExcludedSkills.add(ex);

    if (item.hop < 2 && ptrs.referencedAgents.length <= 4) {
      for (const nextAgent of ptrs.referencedAgents) {
        if (!seenNames.has(nextAgent.name)) {
          queue.push({ ...nextAgent, hop: item.hop + 1 });
        }
      }
    }
  }
  return forwardedAgents;
}

function unpackRulesAndInfra(
  ruleRefs: ReadonlyArray<{ name: string; line: number }>,
  ruleScriptRefs: Array<{ ref: string; line: number; docPath: string }>,
  ctx: UnpackContext,
): void {
  if (ctx.dotaiRoot === undefined) return;
  for (const ruleRef of ruleRefs) {
    const rulePath = join(ctx.dotaiRoot, 'src', 'rules', ruleRef.name);
    if (!existsSync(rulePath)) continue;
    const canonical = realpathSync(rulePath);
    ctx.allLinkedRules.add(formatDisplayPath(canonical, ctx.cwd));
    const fm = registerDoc(canonical, 'linked-rule', ctx, true);
    const ptrs = extractPointersFromMarkdown(
      ctx.docContents.get(canonical) ?? '',
      fm,
      ctx.selfSkillName,
    );
    for (const s of ptrs.scriptPaths) {
      ruleScriptRefs.push({ ...s, docPath: canonical });
    }
  }
}

function unpackResourcesAndScripts(
  resourceDirs: ReadonlyArray<{ ref: string; line: number }>,
  scriptRefs: ReadonlyArray<{ ref: string; line: number; docPath: string }>,
  ruleScriptRefs: ReadonlyArray<{ ref: string; line: number; docPath: string }>,
  ctx: UnpackContext,
): void {
  const unpackedDirs = new Set<string>();
  const walkedSubdirs = new Set<string>();

  for (const resRef of resourceDirs) {
    const { foundPath, searchedPaths } = resolveResourceDir(
      resRef.ref,
      ctx.dotaiRoot,
    );
    if (foundPath === undefined) {
      ctx.unresolvedTargets.push({
        kind: 'resource-dir',
        reference: resRef.ref,
        sourceFile: ctx.entryDisplayPath,
        line: resRef.line,
        searchedPaths,
      });
      continue;
    }
    if (unpackedDirs.has(foundPath)) continue;
    unpackedDirs.add(foundPath);
    walkSkillDirectory(foundPath, 'forwarded-resource', ctx.cwd, ctx.collector);
  }

  for (const scriptRef of scriptRefs) {
    const resolved = resolveExternalScript(
      scriptRef.ref,
      dirname(scriptRef.docPath),
      ctx.cwd,
      ctx.dotaiRoot,
    );
    if (resolved === undefined) continue;
    classifyFileIntoCollector(resolved, 'external-ref', ctx.cwd, ctx.collector);
    attachCompanionTestsAndSchemas(
      resolved,
      ctx.cwd,
      ctx.collector,
      walkedSubdirs,
    );

    const match = resolved.match(
      /\/(?:src|targets\/[^/]+)\/resources\/([^/]+)\//,
    );
    if (match?.[1] === undefined) continue;
    const resDir = resolveResourceDir(match[1], ctx.dotaiRoot);
    if (resDir.foundPath !== undefined && !unpackedDirs.has(resDir.foundPath)) {
      unpackedDirs.add(resDir.foundPath);
      walkSkillDirectory(
        resDir.foundPath,
        'forwarded-resource',
        ctx.cwd,
        ctx.collector,
      );
    }
  }

  for (const ruleScript of ruleScriptRefs) {
    const resolved = resolveExternalScript(
      ruleScript.ref,
      dirname(ruleScript.docPath),
      ctx.cwd,
      ctx.dotaiRoot,
    );
    if (resolved === undefined) continue;
    classifyFileIntoCollector(resolved, 'shared-infra', ctx.cwd, ctx.collector);
  }

  for (const docPath of ctx.collector.docFiles) {
    const canonical = realpathSync(docPath);
    if (!ctx.docContents.has(canonical)) {
      registerDoc(canonical, 'resource-doc', ctx, true);
    }
  }
}

export function resolveSkillBundle(
  targetInput: string,
  options: ResolveOptions,
): ResolvedBundle {
  const { entryPath, isSingleFileSkill } = resolveTargetEntryPath(
    targetInput,
    options,
  );
  const { resolved: resolvedEntryPath, chain: symlinkChain } =
    traceSymlinkChain(entryPath);
  const dotaiRoot = detectDotaiRoot(
    [resolvedEntryPath, ...symlinkChain, options.cwd],
    options,
  );

  const inferredName = isSingleFileSkill
    ? basename(resolvedEntryPath, '.md')
    : basename(dirname(resolvedEntryPath));

  const ctx: UnpackContext = {
    cwd: options.cwd,
    dotaiRoot,
    entryDisplayPath: formatDisplayPath(resolvedEntryPath, options.cwd),
    selfSkillName: inferredName,
    documents: [],
    docContents: new Map(),
    collector: createCollector(),
    unresolvedTargets: [],
    allLinkedSkills: new Set(),
    allExcludedSkills: new Set(),
    allLinkedRules: new Set(),
  };

  const entryFm = registerDoc(resolvedEntryPath, 'skill-entry', ctx);
  const skillName = entryFm.name ?? inferredName;
  ctx.selfSkillName = skillName;

  if (!isSingleFileSkill) {
    walkSkillDirectory(
      dirname(resolvedEntryPath),
      'skill',
      ctx.cwd,
      ctx.collector,
    );
    for (const docPath of ctx.collector.docFiles) {
      if (docPath !== resolvedEntryPath) registerDoc(docPath, 'reference', ctx);
    }
  } else if (dotaiRoot !== undefined) {
    const compiled = join(
      dotaiRoot,
      'targets',
      'codex',
      'skills',
      inferredName,
    );
    if (existsSync(compiled)) {
      walkSkillDirectory(compiled, 'skill', ctx.cwd, ctx.collector);
      for (const docPath of ctx.collector.docFiles) {
        const isCompiledMirror = basename(docPath) === 'SKILL.md';
        registerDoc(
          docPath,
          isCompiledMirror ? 'skill-compiled-mirror' : 'reference',
          ctx,
          isCompiledMirror,
        );
      }
    }
  }

  let sourceMirrorPath: string | undefined;
  let sourceFm: FrontmatterInfo | undefined;
  if (!isSingleFileSkill && dotaiRoot !== undefined) {
    const candidate = join(dotaiRoot, 'src', 'skills', `${inferredName}.md`);
    if (
      existsSync(candidate) &&
      realpathSync(candidate) !== resolvedEntryPath
    ) {
      sourceMirrorPath = realpathSync(candidate);
      sourceFm = registerDoc(sourceMirrorPath, 'skill-source', ctx, true);
    }
  }

  const entryText = ctx.docContents.get(resolvedEntryPath) ?? '';
  const entryPtrs = extractPointersFromMarkdown(entryText, entryFm, skillName);
  const sourcePtrs =
    sourceMirrorPath && sourceFm
      ? extractPointersFromMarkdown(
          ctx.docContents.get(sourceMirrorPath) ?? '',
          sourceFm,
          skillName,
        )
      : undefined;

  const nonEmptyBody = entryText
    .split('\n')
    .slice(entryFm.bodyStartLine)
    .filter((l) => l.trim().length > 0).length;
  const primaryAgent =
    entryPtrs.primaryDispatchAgent ?? sourcePtrs?.primaryDispatchAgent;
  const isThinDispatcher =
    /(?:^|\n)\s*本\s*skill\s*是转发薄壳/m.test(entryText) ||
    entryFm.dispatch !== undefined ||
    sourceFm?.dispatch !== undefined ||
    (primaryAgent !== undefined && nonEmptyBody <= 35);

  const resourceDirs = [
    ...entryPtrs.resourceDirs,
    ...(sourcePtrs?.resourceDirs ?? []),
  ];
  const ruleRefs = [
    ...entryPtrs.linkedRules,
    ...(sourcePtrs?.linkedRules ?? []),
  ];
  const scriptRefs = [
    ...entryPtrs.scriptPaths.map((s) => ({ ...s, docPath: resolvedEntryPath })),
    ...(sourcePtrs?.scriptPaths.map((s) => ({
      ...s,
      docPath: sourceMirrorPath!,
    })) ?? []),
  ];
  for (const sk of [
    ...entryPtrs.linkedSkills,
    ...(sourcePtrs?.linkedSkills ?? []),
  ]) {
    ctx.allLinkedSkills.add(sk);
  }
  for (const ex of [
    ...entryPtrs.excludedSkills,
    ...(sourcePtrs?.excludedSkills ?? []),
  ]) {
    ctx.allExcludedSkills.add(ex);
  }

  const ruleScriptRefs: Array<{ ref: string; line: number; docPath: string }> =
    [];
  const forwardedAgents = unpackAgentsBfs(
    [...entryPtrs.referencedAgents, ...(sourcePtrs?.referencedAgents ?? [])],
    resourceDirs,
    scriptRefs,
    ruleRefs,
    ctx,
  );
  unpackRulesAndInfra(ruleRefs, ruleScriptRefs, ctx);
  unpackResourcesAndScripts(resourceDirs, scriptRefs, ruleScriptRefs, ctx);

  const byPath = (a: { path: string }, b: { path: string }) =>
    a.path.localeCompare(b.path);

  return {
    targetInput,
    skillName,
    resolvedEntryPath,
    symlinkChain,
    isThinDispatcher,
    forwardedAgents,
    linkedSkills: Array.from(ctx.allLinkedSkills)
      .filter((sk) => !ctx.allExcludedSkills.has(sk))
      .sort(),
    excludedSkills: Array.from(ctx.allExcludedSkills).sort(),
    linkedRules: Array.from(ctx.allLinkedRules).sort(),
    dotaiRoot,
    documents: ctx.documents,
    docContents: ctx.docContents,
    inventory: {
      implScripts: Array.from(ctx.collector.implScripts.values()).sort(byPath),
      sharedInfraScripts: Array.from(
        ctx.collector.sharedInfraScripts.values(),
      ).sort(byPath),
      testFiles: Array.from(ctx.collector.testFiles.values()).sort(byPath),
      schemaFiles: Array.from(ctx.collector.schemaFiles.values()).sort(byPath),
      sidecarConfigFiles: Array.from(ctx.collector.sidecarConfigFiles).sort(),
      docOnlyFiles: ctx.collector.docFiles.size,
    },
    unresolvedTargets: ctx.unresolvedTargets,
  };
}
