import { basename } from 'node:path';

import { type ResolvedBundle, formatDisplayPath } from './resolver.ts';
import {
  extractCommandCallSites,
  findNearbyScriptReferences,
  isDelegatedOrNegatedProse,
  isNonActionDeclarationChunk,
  matchSignalCategories,
  splitMarkdownIntoChunks,
} from './signals.ts';
import type {
  ArchitectureShape,
  AuditSummaryForJudge,
  CandidateHotspot,
  CommandCallSite,
  EngineeringFootprint,
  HotspotPointer,
  ProbeReport,
  ResolvedDocument,
  SkillKind,
} from './types.ts';
import { PROBE_SCHEMA_VERSION } from './types.ts';

const VERIFICATION_SCRIPT_NAME =
  /(?:lint|validate|check|verify|gate|audit|conformance|ci|test|hardgate)/i;

function buildExcerpt(proseLines: readonly string[]): string {
  const joined = proseLines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ');
  return joined.length > 220 ? `${joined.slice(0, 217)}...` : joined;
}

function classifySkillKind(
  bundle: ResolvedBundle,
  footprint: EngineeringFootprint,
  hasDomainScriptCall: boolean,
): SkillKind {
  if (bundle.isThinDispatcher) return 'dispatcher';
  if (
    footprint.docCount >= 10 &&
    footprint.docLines >= 2500 &&
    footprint.implScriptCount === 0 &&
    !hasDomainScriptCall
  ) {
    return 'reference-kb';
  }
  return 'workflow';
}

function classifyArchitectureShape(
  bundle: ResolvedBundle,
  footprint: EngineeringFootprint,
  unbackedHotspots: readonly CandidateHotspot[],
  backedHotspots: readonly CandidateHotspot[],
  totalHotspots: number,
): ArchitectureShape {
  if (
    bundle.isThinDispatcher &&
    bundle.unresolvedTargets.some((t) => t.kind === 'agent') &&
    footprint.implScriptCount === 0
  ) {
    return 'unresolved-dispatcher';
  }
  if (footprint.implScriptCount === 0 && footprint.schemaFileCount === 0) {
    return bundle.isThinDispatcher ? 'thin-dispatcher' : 'pure-prompt-skill';
  }
  if (!footprint.hasDeterministicRunner) {
    return 'hybrid-assisted';
  }
  if (totalHotspots === 0 || unbackedHotspots.length <= 2) {
    return 'script-backed-loop';
  }
  const mostlyBacked = backedHotspots.length >= unbackedHotspots.length;
  const tolerableResidual =
    unbackedHotspots.length <= Math.floor(totalHotspots * 0.45) &&
    footprint.scriptToDocLineRatio >= 1.5;
  if (mostlyBacked || tolerableResidual) {
    return 'script-backed-loop';
  }
  return 'hybrid-assisted';
}

function buildAuditHints(
  bundle: ResolvedBundle,
  shape: ArchitectureShape,
  skillKind: SkillKind,
  footprint: EngineeringFootprint,
  unbackedHotspots: readonly CandidateHotspot[],
): string[] {
  const hints: string[] = [];
  if (bundle.unresolvedTargets.length > 0) {
    hints.push(
      `存在 ${bundle.unresolvedTargets.length} 个未解析外部坐标, 审计报告必须标注 [证据缺口]`,
    );
  }
  if (skillKind === 'reference-kb') {
    hints.push(
      '识别为静态百科参考库 (reference-kb), 请按 SKIP 克制原则避免强行脚本化',
    );
    return hints;
  }
  if (shape === 'pure-prompt-skill' || shape === 'thin-dispatcher') {
    hints.push(
      '当前零可执行脚本且零 Schema 契约, 重点检查全仓扫描、精确比对与校验步骤能否下沉为程序',
    );
  }
  if (footprint.implScriptCount > 0 && footprint.testFileCount === 0) {
    hints.push(
      '已存在脚本但配套自动化测试数为 0, 建议核验确定性脚本自身是否缺少回归门',
    );
  }
  if (footprint.implScriptCount > 0 && !footprint.hasMachineReadableContract) {
    hints.push(
      '存在脚本但缺少显式 .schema.json / catalog 契约, 建议检查脚本与 AI 交接是否靠自然语言解析',
    );
  }
  if (unbackedHotspots.length > 0) {
    const top = unbackedHotspots[0]!;
    hints.push(
      `首要待实读热区 ${top.id} (${top.file}:${top.lineStart}-${top.lineEnd}) 命中 ${top.categories.join(', ')}`,
    );
  }
  if (hints.length === 0) {
    hints.push(
      '核心扫描、门禁与测试体系已完备, 实读核验是否存在局部残留手工动作即可',
    );
  }
  return hints;
}

function isSimpleNativeDisplayStep(
  chunk: ReturnType<typeof splitMarkdownIntoChunks>[number],
  categories: readonly string[],
): boolean {
  if (categories.length !== 1 || categories[0] !== 'PURE_SHELL_OR_ENV_PROBE') {
    return false;
  }
  const combined = chunk.rawLines.join(' ');
  return (
    /\bgit\s+(?:diff|status|log|show)\b/.test(combined) &&
    /展示|查看/.test(combined)
  );
}

function scanDocumentHotspots(
  doc: ResolvedDocument,
  content: string,
  knownScriptNames: ReadonlySet<string>,
): CandidateHotspot[] {
  const hotspots: CandidateHotspot[] = [];
  const chunks = splitMarkdownIntoChunks(content);
  let activeIntroHeading = '';
  let activeIntroScripts: string[] = [];

  for (const chunk of chunks) {
    const baseHeading = chunk.section.split(' · ')[0] ?? chunk.section;
    const ownScripts = findNearbyScriptReferences(chunk, knownScriptNames);

    if (!chunk.isStepItem) {
      activeIntroHeading = baseHeading;
      activeIntroScripts = [...ownScripts];
    } else if (baseHeading !== activeIntroHeading) {
      activeIntroHeading = baseHeading;
      activeIntroScripts = [];
    }

    if (isNonActionDeclarationChunk(chunk)) continue;
    const prose = chunk.proseLines.join('\n');
    if (prose.trim().length === 0) continue;

    const { categories, matchedTerms, score } = matchSignalCategories(prose);
    if (categories.length === 0) continue;
    if (isSimpleNativeDisplayStep(chunk, categories)) continue;

    let nearbyScripts = [...ownScripts];
    if (
      nearbyScripts.length === 0 &&
      chunk.isStepItem &&
      baseHeading === activeIntroHeading
    ) {
      nearbyScripts = [...activeIntroScripts];
    }
    const delegatedOrNegated = isDelegatedOrNegatedProse(prose);
    const roleBonus =
      doc.role === 'skill-entry' || doc.role === 'forwarded-agent' ? 2 : 0;
    const finalScore = Math.max(
      1,
      score + roleBonus - (delegatedOrNegated ? 3 : 0),
    );

    hotspots.push({
      id: '',
      file: doc.path,
      docRole: doc.role,
      section: chunk.section,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
      categories,
      matchedTerms,
      score: finalScore,
      likelyBackedByScript: nearbyScripts.length > 0,
      delegatedOrNegated,
      nearbyScripts,
      excerpt: buildExcerpt(chunk.proseLines),
    });
  }
  return hotspots;
}

function toHotspotPointer(h: CandidateHotspot): HotspotPointer {
  return {
    id: h.id,
    location: `${h.file}:${h.lineStart}-${h.lineEnd}`,
    section: h.section,
    score: h.score,
    categories: h.categories,
  };
}

export function scanResolvedBundle(
  bundle: ResolvedBundle,
  cwd: string,
  maxHotspots = 25,
): ProbeReport {
  const knownScriptNames = new Set(
    bundle.inventory.implScripts.map((s) => basename(s.path)),
  );
  const executedCommandRefs: CommandCallSite[] = [];
  const rawHotspots: CandidateHotspot[] = [];

  for (const doc of bundle.documents) {
    if (doc.excludedFromHotspotScan) continue;
    const content = bundle.docContents.get(doc.path) ?? '';
    const displayFile = formatDisplayPath(doc.path, cwd);
    const docView: ResolvedDocument = { ...doc, path: displayFile };
    executedCommandRefs.push(...extractCommandCallSites(displayFile, content));
    rawHotspots.push(
      ...scanDocumentHotspots(docView, content, knownScriptNames),
    );
  }

  rawHotspots.sort((a, b) => {
    if (a.likelyBackedByScript !== b.likelyBackedByScript) {
      return a.likelyBackedByScript ? 1 : -1;
    }
    if (a.delegatedOrNegated !== b.delegatedOrNegated) {
      return a.delegatedOrNegated ? 1 : -1;
    }
    if (b.score !== a.score) return b.score - a.score;
    return a.lineStart - b.lineStart;
  });

  const totalRawHotspotCount = rawHotspots.length;
  const numberedHotspots = rawHotspots
    .slice(0, maxHotspots)
    .map((item, idx) => ({
      ...item,
      id: `H${String(idx + 1).padStart(2, '0')}`,
    }));

  const activeDocs = bundle.documents.filter((d) => !d.excludedFromHotspotScan);
  const docLines = activeDocs.reduce((sum, d) => sum + d.lineCount, 0);
  const docBytes = activeDocs.reduce((sum, d) => sum + d.byteCount, 0);
  const implScriptLines = bundle.inventory.implScripts.reduce(
    (sum, s) => sum + s.lines,
    0,
  );

  const hasDomainScriptCall = executedCommandRefs.some((c) => {
    if (c.kind !== 'local-script' && c.kind !== 'external-script') return false;
    return bundle.inventory.implScripts.some((s) =>
      c.command.includes(basename(s.path)),
    );
  });
  const allScripts = [
    ...bundle.inventory.implScripts,
    ...bundle.inventory.sharedInfraScripts,
  ];
  const hasVerificationGate = allScripts.some((s) =>
    VERIFICATION_SCRIPT_NAME.test(basename(s.path)),
  );

  const footprint: EngineeringFootprint = {
    docCount: activeDocs.length,
    docLines,
    docBytes,
    implScriptCount: bundle.inventory.implScripts.length,
    implScriptLines,
    sharedInfraScriptCount: bundle.inventory.sharedInfraScripts.length,
    testFileCount: bundle.inventory.testFiles.length,
    schemaFileCount: bundle.inventory.schemaFiles.length,
    hasDeterministicRunner:
      bundle.inventory.implScripts.length > 0 &&
      (hasDomainScriptCall || implScriptLines >= 80),
    hasVerificationGate,
    hasMachineReadableContract: bundle.inventory.schemaFiles.length > 0,
    hasTestSuite: bundle.inventory.testFiles.length > 0,
    scriptToDocLineRatio:
      docLines > 0 ? Number((implScriptLines / docLines).toFixed(2)) : 0,
  };

  const unbackedHotspots = numberedHotspots.filter(
    (h) => !h.likelyBackedByScript && !h.delegatedOrNegated,
  );
  const backedHotspots = numberedHotspots.filter(
    (h) => h.likelyBackedByScript || h.delegatedOrNegated,
  );
  const skillKind = classifySkillKind(bundle, footprint, hasDomainScriptCall);
  const architectureShape = classifyArchitectureShape(
    bundle,
    footprint,
    unbackedHotspots,
    backedHotspots,
    numberedHotspots.length,
  );

  const summaryForJudge: AuditSummaryForJudge = {
    totalRawHotspotCount,
    unbackedHotspotCount: unbackedHotspots.length,
    backedHotspotCount: backedHotspots.length,
    topUnbackedHotspots: unbackedHotspots.slice(0, 8).map(toHotspotPointer),
    auditFocusHints: buildAuditHints(
      bundle,
      architectureShape,
      skillKind,
      footprint,
      unbackedHotspots,
    ),
  };

  return {
    schemaVersion: PROBE_SCHEMA_VERSION,
    targetInput: bundle.targetInput,
    skillName: bundle.skillName,
    resolvedEntryPath: formatDisplayPath(bundle.resolvedEntryPath, cwd),
    symlinkChain: bundle.symlinkChain.map((p) => formatDisplayPath(p, cwd)),
    isThinDispatcher: bundle.isThinDispatcher,
    skillKind,
    forwardedAgents: bundle.forwardedAgents,
    linkedSkills: bundle.linkedSkills,
    excludedSkills: bundle.excludedSkills,
    linkedRules: bundle.linkedRules,
    dotaiRoot: bundle.dotaiRoot,
    architectureShape,
    engineeringFootprint: footprint,
    documents: bundle.documents.map((d) => ({
      ...d,
      path: formatDisplayPath(d.path, cwd),
    })),
    inventory: bundle.inventory,
    executedCommandRefs,
    candidateHotspots: numberedHotspots,
    unresolvedTargets: bundle.unresolvedTargets,
    summaryForJudge,
  };
}
