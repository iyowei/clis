/**
 * determinism-audit 确定性探针的结构化输出契约与共享类型。
 */

export const PROBE_SCHEMA_VERSION = 2;

export type ArchitectureShape =
  | 'script-backed-loop'
  | 'hybrid-assisted'
  | 'pure-prompt-skill'
  | 'thin-dispatcher'
  | 'unresolved-dispatcher';

export type SkillKind = 'workflow' | 'dispatcher' | 'reference-kb';

export type SignalCategory =
  | 'FULL_REPO_SCAN'
  | 'AST_OR_DEPENDENCY_GRAPH'
  | 'EXACT_DIFF_OR_MATCHING'
  | 'FORMAT_OR_SCHEMA_VALIDATION'
  | 'STATE_MACHINE_OR_ROLLBACK'
  | 'STATISTICAL_OR_BENCHMARK'
  | 'PURE_SHELL_OR_ENV_PROBE';

export type DocumentRole =
  | 'skill-entry'
  | 'skill-source'
  | 'skill-compiled-mirror'
  | 'reference'
  | 'forwarded-agent'
  | 'resource-doc'
  | 'linked-rule';

export type AssetOrigin =
  'skill' | 'forwarded-resource' | 'external-ref' | 'shared-infra';

export interface ResolvedDocument {
  path: string;
  role: DocumentRole;
  lineCount: number;
  byteCount: number;
  hasFrontmatter: boolean;
  dispatchTarget?: string;
  disallowedTools?: string[];
  designDocs?: string[];
  excludedFromHotspotScan?: boolean;
}

export interface ScriptAsset {
  path: string;
  lines: number;
  bytes: number;
  ext: string;
  origin: AssetOrigin;
}

export interface TestAsset {
  path: string;
  lines: number;
  origin: AssetOrigin;
}

export interface SchemaAsset {
  path: string;
  bytes: number;
  origin: AssetOrigin;
}

export interface ScriptInventory {
  implScripts: ScriptAsset[];
  sharedInfraScripts: ScriptAsset[];
  testFiles: TestAsset[];
  schemaFiles: SchemaAsset[];
  sidecarConfigFiles: string[];
  docOnlyFiles: number;
}

export interface CommandCallSite {
  file: string;
  line: number;
  command: string;
  kind: 'local-script' | 'external-script' | 'cli-tool' | 'git-or-shell';
}

export interface CandidateHotspot {
  id: string;
  file: string;
  docRole: DocumentRole;
  section: string;
  lineStart: number;
  lineEnd: number;
  categories: SignalCategory[];
  matchedTerms: string[];
  score: number;
  likelyBackedByScript: boolean;
  delegatedOrNegated: boolean;
  nearbyScripts: string[];
  excerpt: string;
}

export interface HotspotPointer {
  id: string;
  location: string;
  section: string;
  score: number;
  categories: SignalCategory[];
}

export interface UnresolvedTarget {
  kind: 'agent' | 'resource-dir' | 'linked-file' | 'rule' | 'skill-source';
  reference: string;
  sourceFile: string;
  line: number;
  searchedPaths: string[];
}

export interface EngineeringFootprint {
  docCount: number;
  docLines: number;
  docBytes: number;
  implScriptCount: number;
  implScriptLines: number;
  sharedInfraScriptCount: number;
  testFileCount: number;
  schemaFileCount: number;
  hasDeterministicRunner: boolean;
  hasVerificationGate: boolean;
  hasMachineReadableContract: boolean;
  hasTestSuite: boolean;
  scriptToDocLineRatio: number;
}

export interface AuditSummaryForJudge {
  totalRawHotspotCount: number;
  unbackedHotspotCount: number;
  backedHotspotCount: number;
  topUnbackedHotspots: HotspotPointer[];
  auditFocusHints: string[];
}

export interface ProbeReport {
  schemaVersion: number;
  targetInput: string;
  skillName: string;
  resolvedEntryPath: string;
  symlinkChain: string[];
  isThinDispatcher: boolean;
  skillKind: SkillKind;
  forwardedAgents: string[];
  linkedSkills: string[];
  excludedSkills: string[];
  linkedRules: string[];
  dotaiRoot?: string;
  archivePath?: string;
  architectureShape: ArchitectureShape;
  engineeringFootprint: EngineeringFootprint;
  documents: ResolvedDocument[];
  inventory: ScriptInventory;
  executedCommandRefs: CommandCallSite[];
  candidateHotspots: CandidateHotspot[];
  unresolvedTargets: UnresolvedTarget[];
  summaryForJudge: AuditSummaryForJudge;
}

export interface SkillListItem {
  name: string;
  source: 'workspace' | 'global-agents' | 'global-claude' | 'builtin';
  entryPath: string;
  isSymlink: boolean;
  isThinDispatcher: boolean;
  skillKind: SkillKind;
  architectureShape: ArchitectureShape;
  docLines: number;
  implScriptCount: number;
  testFileCount: number;
  schemaFileCount: number;
  unbackedHotspotCount: number;
  totalRawHotspotCount: number;
  unresolvedCount: number;
}

export interface SkillListReport {
  schemaVersion: number;
  dotaiRoot?: string;
  totalSkills: number;
  skills: SkillListItem[];
}

export interface ResolveOptions {
  cwd: string;
  dotaiRoot?: string;
  disableDotai?: boolean;
}
