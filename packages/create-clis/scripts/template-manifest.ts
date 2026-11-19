/**
 * 骨架清单登记表: 模板快照机制的唯一点 (设计见 docs/designs/scaffold-template-snapshot.md)。
 *
 * 四类处置:
 * - snapshot:   与项目名和领域无关的机制/配置文件, 原样进模板;
 * - generalize: 含原项目复合词汇形态的机制文件, 构建期替换为模板变量后进模板;
 * - reset:      槽位文件或含多产品本仓专属排除项的根配置, 改取 scripts/template-skeletons/ 干净骨架;
 * - exclude:    本仓领域产品、历史 ADR 与生成器自身, 不进模板 (且 packages/<pkg>/ 自动派生为构建禁词)。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根 (packages/create-clis/scripts/ 上溯三级) */
export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

/** 条目处置: 原样快照 / 泛化替换 / 重置为骨架 / 排除不进模板 */
export type Disposition = 'snapshot' | 'generalize' | 'reset' | 'exclude';

export interface ManifestEntry {
  /** 相对仓库根的路径; 目录条目以 `/` 收尾 */
  path: string;
  disposition: Disposition;
  /** 判定依据 (reset / exclude 必填) */
  note?: string;
}

const snap = (path: string): ManifestEntry => ({
  path,
  disposition: 'snapshot',
});
const gen = (path: string): ManifestEntry => ({
  path,
  disposition: 'generalize',
});
const rst = (path: string, note: string): ManifestEntry => ({
  path,
  disposition: 'reset',
  note,
});
const excl = (path: string, note: string): ManifestEntry => ({
  path,
  disposition: 'exclude',
  note,
});

export const TEMPLATE_MANIFEST: readonly ManifestEntry[] = [
  // snapshot: 纯通用机制与配置, 原样进模板
  ...[
    '.editorconfig',
    '.gitattributes',
    '.npmrc',
    '.nvmrc',
    '.prettierrc',
    '.releaserc.json',
    'lefthook.yml',
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
    '.vscode/extensions.json',
    '.vscode/settings.json',
    '.vscode/tasks.json',
    'scripts/ci.ts',
    'scripts/install-git-hooks.mjs',
    'scripts/safe-install.ts',
    'scripts/lib/git-env.ts',
    'scripts/lib/npm-trust-parse.ts',
    'scripts/lib/release-cli.ts',
    'scripts/lib/release-verify.ts',
    'scripts/lib/tmp-root.ts',
    'scripts/lib/workspace.ts',
    'scripts/lib/workspace.test.ts',
    'scripts/lint-dependency-direction.ts',
    'scripts/lint-dependency-direction.test.ts',
    'scripts/lint-stray-backups.ts',
    'scripts/lint-stray-backups.test.ts',
    'scripts/transcription/compare.ts',
    'scripts/transcription/compare.test.ts',
    'scripts/transcription/fixture.ts',
    'scripts/transcription/make-mutants.ts',
    'scripts/transcription/report.ts',
    'scripts/transcription/validate.ts',
    'scripts/transcription/validate-coverage.ts',
    'scripts/transcription/validate-coverage.test.ts',
    'packages/sweep-node-modules/tsconfig.build.json',
    'packages/sweep-node-modules/scripts/build.ts',
    'packages/sweep-node-modules/scripts/verify-release.test.ts',
    'packages/sweep-node-modules-cli/tsconfig.json',
    'packages/sweep-node-modules-cli/bin/bunfig.toml',
    'packages/sweep-node-modules-cli/scripts/release.fixtures.ts',
    'packages/sweep-node-modules-cli/scripts/write-dist-manifest.test.ts',
  ].map(snap),

  // generalize: 替换原项目复合词汇后进模板
  ...[
    'CODE_OF_CONDUCT.md',
    'LICENSE',
    'scripts/install-git-hooks.test.ts',
    'scripts/lint-doc-examples.ts',
    'scripts/lint-doc-examples.test.ts',
    'scripts/lint-doc-references.ts',
    'scripts/lint-doc-references.test.ts',
    'scripts/npm-trust-guard.ts',
    'scripts/npm-trust-guard.test.ts',
    'scripts/transcription/corpus.ts',
    'scripts/transcription/run-conformance.ts',
    'packages/sweep-node-modules/LICENSE',
    'packages/sweep-node-modules-cli/LICENSE',
    'packages/sweep-node-modules-cli/bin/sweep-nm',
    'packages/sweep-node-modules-cli/bin/sweep-nm.cmd',
    'packages/sweep-node-modules-cli/bin/sweep-nm.d.mts',
    'packages/sweep-node-modules-cli/bin/sweep-nm.mjs',
    'packages/sweep-node-modules-cli/scripts/release-artifact.ts',
    'packages/sweep-node-modules-cli/scripts/verify-release.ts',
    'packages/sweep-node-modules-cli/scripts/verify-release.test.ts',
    'packages/sweep-node-modules-cli/scripts/write-dist-manifest.ts',
  ].map(gen),

  // reset: 换用干净的模板化骨架 (隔离本仓私有包路径、镜像源与领域文案)
  rst(
    '.oxlintrc.json',
    '根配置含本仓私有包 (create-clis/codd/codd-cli) 排除项; 换干净骨架防泄漏',
  ),
  rst('.prettierignore', '根配置含本仓私有包与模板排除项; 换干净骨架防泄漏'),
  rst('tsconfig.json', '根配置含多产品 paths 与私有包排除; 换干净双包骨架'),
  rst('bunfig.toml', '根配置含本仓私有包测试排除项; 换干净官方源骨架'),
  rst('turbo.jsonc', '根配置含本仓注释与 bench 任务; 换干净通用 turbo 骨架'),
  rst(
    '.gitignore',
    '根 .gitignore 含本仓私有包与 bench/mutants 路径; 换干净通用骨架',
  ),
  rst(
    '.gitignorerc.json',
    '根 .gitignorerc.json 含本仓私有包路径; 换干净通用骨架',
  ),
  rst(
    'scripts/lint-doc-shared.ts',
    '根脚本 SKIP_PATHS 含本仓私有包模板路径; 换空 SKIP_PATHS 干净骨架',
  ),
  rst(
    'scripts/transcription/api-harness.ts',
    '本仓 harness 引用 sweep 领域常量; 换直连示例包 greet 的骨架使 full 档 typecheck 归绿',
  ),
  rst('.vscode/launch.json', '根配置列全仓多产品调试项; 换新项目双包调试骨架'),
  rst(
    '.github/ISSUE_TEMPLATE/bug_report.yml',
    '根模板列出本仓全量包清单; 换新项目双包缺陷报告骨架',
  ),
  rst(
    '.github/ISSUE_TEMPLATE/feature_request.yml',
    '根模板列出本仓全量包清单; 换新项目双包需求建议骨架',
  ),
  rst(
    'package.json',
    '根 package.json 换新项目骨架 (与本仓根 devDependencies 保持单测强制同步)',
  ),
  rst('CONTRIBUTING.md', '换通用贡献指南骨架'),
  rst('CONTRIBUTING.zh-CN.md', '换通用贡献指南中文骨架'),
  rst('README.md', '换模板化根 README 骨架'),
  rst('README.zh-CN.md', '换模板化根 README 中文骨架'),
  rst('AGENTS.md', '换模板化 AI 导航骨架'),
  rst('SECURITY.md', '换通用安全策略骨架'),
  rst('docs/README.md', '换两级文档骨架总索引'),
  rst('docs/development.md', '换通用开发指南骨架'),
  rst('docs/designs/README.md', '换空组设计索引骨架'),
  rst('docs/designs/tech-debt.md', '换空技术债登记册骨架 (标准档装备)'),
  rst('docs/adrs/README.md', '换空 ADR 索引骨架 (新项目从 0001 起)'),
  rst(
    'packages/sweep-node-modules/package.json',
    '换中性示例 API 包清单骨架 (version 0.0.0)',
  ),
  rst(
    'packages/sweep-node-modules/tsconfig.json',
    '换只含 src 的示例包 tsconfig 骨架',
  ),
  rst('packages/sweep-node-modules/README.md', '换最小示例 API 包 README 骨架'),
  rst(
    'packages/sweep-node-modules/README.zh-CN.md',
    '换最小示例 API 包中文 README 骨架',
  ),
  rst('packages/sweep-node-modules/CHANGELOG.md', '换占位 CHANGELOG 骨架'),
  rst('packages/sweep-node-modules/src/', '换最小 greet 示例源码骨架'),
  rst(
    'packages/sweep-node-modules/scripts/verify-release.ts',
    '换示例 API 包发布自证骨架',
  ),
  rst(
    'packages/sweep-node-modules/docs/README.md',
    '换最小示例包级文档入口骨架',
  ),
  rst(
    'packages/sweep-node-modules-cli/package.json',
    '换中性示例 CLI 包清单骨架 (version 0.0.0)',
  ),
  rst(
    'packages/sweep-node-modules-cli/README.md',
    '换最小示例 CLI 包 README 骨架',
  ),
  rst(
    'packages/sweep-node-modules-cli/README.zh-CN.md',
    '换最小示例 CLI 包中文 README 骨架',
  ),
  rst('packages/sweep-node-modules-cli/CHANGELOG.md', '换占位 CHANGELOG 骨架'),
  rst('packages/sweep-node-modules-cli/src/', '换最小 greet CLI 薄壳骨架'),
  rst(
    'packages/sweep-node-modules-cli/docs/README.md',
    '换最小示例 CLI 包级文档入口骨架',
  ),

  // exclude: 本仓私有包、领域内容与历史记录 (packages/* 自动派生构建期禁词)
  excl('.mailmap', '维护者个人提交映射; 不进模板'),
  excl('bun.lock', '锁文件生成物; 新项目 bun install 重建'),
  excl('packages/create-clis/', '生成器自身; 生成物不含生成器'),
  excl(
    'packages/codd/',
    'MongoDB 模板化装配 API 主包与文档 (本仓领域工具); 不进模板',
  ),
  excl(
    'packages/codd-cli/',
    'MongoDB 模板化装配 CLI 包 (本仓领域工具); 不进模板',
  ),
  ...[
    'docs/adrs/0005-engineering-gates-and-hooks.md',
    'docs/adrs/0006-dual-runtime-bun-first.md',
    'docs/adrs/0009-npm-distribution-form.md',
    'docs/adrs/0010-dual-package-monorepo.md',
    'docs/adrs/0011-docs-and-adr-layering.md',
    'docs/adrs/0019-two-tier-package-owned-docs.md',
  ].map((p) => excl(p, '本仓历史 ADR')),
  ...[
    'docs/designs/collection-positioning.md',
    'docs/designs/package-classification.md',
    'docs/designs/dependency-direction.md',
    'docs/designs/docs-layering.md',
    'docs/designs/capability-tiers.md',
    'docs/designs/collection-relocation.md',
    'docs/designs/scaffold-package.md',
    'docs/designs/scaffold-contract.md',
    'docs/designs/scaffold-template-snapshot.md',
  ].map((p) => excl(p, '本仓治理与脚手架设计')),
  excl('packages/sweep-node-modules/bench/', 'sweep 领域基准'),
  excl('packages/sweep-node-modules/docs/adrs/', 'sweep 历史产品 ADR'),
  excl('packages/sweep-node-modules/docs/designs/', 'sweep 领域产品设计'),
  excl(
    'packages/sweep-node-modules/docs/protocol/',
    'sweep 转写契约与金样本语料',
  ),
  excl('packages/sweep-node-modules-cli/docs/designs/', 'sweep CLI 领域设计'),
];
