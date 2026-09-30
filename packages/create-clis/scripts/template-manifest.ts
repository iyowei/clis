/**
 * 骨架清单登记表: 模板快照机制的唯一点 (设计见 docs/designs/scaffold-template-snapshot.md)。
 *
 * 快照只取登记在案的仓库文件, 四类处置:
 * - snapshot:   机制 / 配置文件, 与项目名和领域无关, 原样进模板;
 * - generalize: 机制文件但含原项目可识别形态 (包名 / scope / bin 名 / owner / 仓库地址 /
 *               作者名 / 仓库名 / 产品短名), 构建期替换为模板变量后进模板;
 * - reset:      槽位文件, 模板侧是重新编写的骨架 (README / CHANGELOG / docs 骨架 /
 *               最小示例包), 现内容不复用, note 记录换成什么;
 * - exclude:    本仓领域内容与历史 (sweep 产品区 / 领域包实现 / ADR 记录 / 生成器自身),
 *               不进模板, note 记录排除依据。
 *
 * 登记口径 (判据自证, 由 template-manifest.test.ts 强制):
 * - 路径相对仓库根, 目录条目以 `/` 收尾;
 * - snapshot 条目不得含原项目词汇; generalize 条目必须含 (构建期零残留自检以此为前提);
 * - 含原项目词汇的仓内文件必须被清单捕获 (generalize, 或落在 reset / exclude 条目内);
 * - 未登记的文件不进模板: 新增文件须先在此分类 (测试兜底)。
 *
 * 消费方: Task 3 替换引擎 (词汇面) 与 Task 4 构建链 (按处置产出 assets/template/)。
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
  /** 判定依据 (reset / exclude 必填): 一句说明换什么或为何排除 */
  note?: string;
}

export const TEMPLATE_MANIFEST: readonly ManifestEntry[] = [
  // snapshot: 原样进模板
  { path: '.editorconfig', disposition: 'snapshot' },
  { path: '.gitattributes', disposition: 'snapshot' },
  { path: '.npmrc', disposition: 'snapshot' },
  { path: '.nvmrc', disposition: 'snapshot' },
  { path: '.oxlintrc.json', disposition: 'snapshot' },
  { path: '.prettierignore', disposition: 'snapshot' },
  { path: '.prettierrc', disposition: 'snapshot' },
  { path: '.releaserc.json', disposition: 'snapshot' },
  { path: 'bunfig.toml', disposition: 'snapshot' },
  { path: 'lefthook.yml', disposition: 'snapshot' },
  { path: 'turbo.json', disposition: 'snapshot' },
  { path: '.github/PULL_REQUEST_TEMPLATE.md', disposition: 'snapshot' },
  { path: '.github/workflows/ci.yml', disposition: 'snapshot' },
  { path: '.github/workflows/release.yml', disposition: 'snapshot' },
  { path: '.vscode/extensions.json', disposition: 'snapshot' },
  { path: '.vscode/settings.json', disposition: 'snapshot' },
  { path: 'scripts/ci.ts', disposition: 'snapshot' },
  { path: 'scripts/install-git-hooks.mjs', disposition: 'snapshot' },
  { path: 'scripts/lib/git-env.ts', disposition: 'snapshot' },
  { path: 'scripts/lib/release-verify.ts', disposition: 'snapshot' },
  { path: 'scripts/lib/tmp-root.ts', disposition: 'snapshot' },
  { path: 'scripts/lib/workspace.ts', disposition: 'snapshot' },
  { path: 'scripts/lib/workspace.test.ts', disposition: 'snapshot' },
  { path: 'scripts/lint-doc-shared.ts', disposition: 'snapshot' },
  { path: 'scripts/lint-stray-backups.test.ts', disposition: 'snapshot' },
  { path: 'scripts/transcription/compare.ts', disposition: 'snapshot' },
  { path: 'scripts/transcription/fixture.ts', disposition: 'snapshot' },
  { path: 'scripts/transcription/report.ts', disposition: 'snapshot' },
  {
    path: 'packages/sweep-node-modules/tsconfig.json',
    disposition: 'snapshot',
  },
  {
    path: 'packages/sweep-node-modules/tsconfig.build.json',
    disposition: 'snapshot',
  },
  {
    path: 'packages/sweep-node-modules/scripts/build.ts',
    disposition: 'snapshot',
  },
  {
    path: 'packages/sweep-node-modules-cli/tsconfig.json',
    disposition: 'snapshot',
  },
  {
    path: 'packages/sweep-node-modules-cli/scripts/verify-release.ts',
    disposition: 'snapshot',
  },
  {
    path: 'packages/sweep-node-modules-cli/scripts/write-dist-manifest.ts',
    disposition: 'snapshot',
  },

  // generalize: 替换原项目词汇后进模板
  { path: '.gitignore', disposition: 'generalize' },
  { path: '.gitignorerc.json', disposition: 'generalize' },
  { path: '.vscode/launch.json', disposition: 'generalize' },
  {
    path: 'package.json',
    disposition: 'generalize',
    note: '含 bench 脚本路径与 multi-release 登记 (create-clis 为生成器本仓条目); 根包名 clis 不在词汇表, 泛化不改写',
  },
  {
    path: 'tsconfig.json',
    disposition: 'generalize',
    note: '双态 paths 映射两包源码 (含 testing 子入口), 随泛化指向示例包',
  },
  { path: 'CONTRIBUTING.md', disposition: 'generalize' },
  { path: 'CONTRIBUTING.zh-CN.md', disposition: 'generalize' },
  { path: 'CODE_OF_CONDUCT.md', disposition: 'generalize' },
  {
    path: 'LICENSE',
    disposition: 'generalize',
    note: '含作者名形态 iTonyYo (spec 词汇表 {owner} 行的位置约定, 词汇表需覆盖该形态)',
  },
  {
    path: '.github/ISSUE_TEMPLATE/bug_report.yml',
    disposition: 'generalize',
    note: '安全报告链接含仓库地址 (随 repoUrl 泛化)',
  },
  {
    path: '.github/ISSUE_TEMPLATE/feature_request.yml',
    disposition: 'generalize',
  },
  {
    path: 'scripts/install-git-hooks.test.ts',
    disposition: 'generalize',
    note: '测试夹具含本仓包名路径 (泛化后为示例包等值形态)',
  },
  {
    path: 'scripts/lint-doc-examples.ts',
    disposition: 'generalize',
    note: 'CLI 入口坐标与命令前缀含 bin 名, 泛化后指向示例 CLI 包',
  },
  { path: 'scripts/lint-doc-examples.test.ts', disposition: 'generalize' },
  {
    path: 'scripts/lint-doc-references.ts',
    disposition: 'generalize',
    note: 'DOC_ALIASES 含领域文档别名, 泛化后为悬空别名 (判定不受影响)',
  },
  { path: 'scripts/lint-doc-references.test.ts', disposition: 'generalize' },
  {
    path: 'scripts/npm-trust-guard.ts',
    disposition: 'generalize',
    note: '动机注释含本仓改名历史 (仓库名形态), 属前车之鉴, 泛化后保留',
  },
  { path: 'scripts/npm-trust-guard.test.ts', disposition: 'generalize' },
  {
    path: 'scripts/safe-install.ts',
    disposition: 'generalize',
    note: '清理面含 CLI 包 dist 路径, 泛化后指向示例包',
  },
  {
    path: 'scripts/transcription/api-harness.ts',
    disposition: 'generalize',
    note: '直连 API 包源码单源路径, 泛化后指向示例包源码',
  },
  {
    path: 'scripts/transcription/run-conformance.ts',
    disposition: 'generalize',
    note: '用法示例含 CLI 包路径; 缺省语料目录泛化后指向新项目产品区 (内容自填)',
  },
  {
    path: 'scripts/lint-stray-backups.ts',
    disposition: 'generalize',
    note: '补救提示中的备份目录约定含产品短名 (~/tmp/sweep_backups/), 泛化后随项目名',
  },
  {
    path: 'scripts/transcription/corpus.ts',
    disposition: 'generalize',
    note: '注释与示例含产品区路径 (docs/sweep/...), 泛化后指向新项目产品区',
  },
  {
    path: 'scripts/transcription/make-mutants.ts',
    disposition: 'generalize',
    note: '注释含产品区路径; 本地函数名 sweepStale 含产品短名, 泛化后随项目名更名',
  },
  {
    path: 'scripts/transcription/validate.ts',
    disposition: 'generalize',
    note: '注释引用产品区路径 (docs/sweep/...), 泛化后指向新项目产品区',
  },
  {
    path: 'scripts/transcription/validate-coverage.ts',
    disposition: 'generalize',
    note: '缺省契约 / 覆盖表 / 语料路径为功能面 (含产品短名), 泛化后指向新项目产品区',
  },
  {
    path: 'scripts/transcription/validate-coverage.test.ts',
    disposition: 'generalize',
    note: '夹具含产品区路径 (docs/sweep/...), 泛化后指向新项目产品区',
  },
  {
    path: 'packages/sweep-node-modules/package.json',
    disposition: 'generalize',
    note: 'description 为领域文案, 词汇替换不改写内容面 (示例包文案由骨架侧承接)',
  },
  { path: 'packages/sweep-node-modules/LICENSE', disposition: 'generalize' },
  {
    path: 'packages/sweep-node-modules/scripts/verify-release.ts',
    disposition: 'generalize',
    note: '发行面包白名单为功能面 (dist/sweep.d.ts 等含产品短名), 泛化后按示例包命名落位',
  },
  {
    path: 'packages/sweep-node-modules/scripts/verify-release.test.ts',
    disposition: 'generalize',
    note: '夹具临时目录前缀含产品短名, 泛化后随项目名',
  },
  {
    path: 'packages/sweep-node-modules-cli/package.json',
    disposition: 'generalize',
  },
  {
    path: 'packages/sweep-node-modules-cli/LICENSE',
    disposition: 'generalize',
  },
  {
    path: 'packages/sweep-node-modules-cli/scripts/release.fixtures.ts',
    disposition: 'generalize',
    note: '夹具 git 身份 (sweep-lab) 含产品短名, 泛化后随项目名',
  },
  {
    path: 'packages/sweep-node-modules-cli/scripts/write-dist-manifest.test.ts',
    disposition: 'generalize',
    note: '夹具临时目录前缀含产品短名, 泛化后随项目名',
  },
  {
    path: 'packages/sweep-node-modules-cli/bin/sweep-nm',
    disposition: 'generalize',
  },
  {
    path: 'packages/sweep-node-modules-cli/bin/sweep-nm.cmd',
    disposition: 'generalize',
  },
  {
    path: 'packages/sweep-node-modules-cli/bin/sweep-nm.d.mts',
    disposition: 'generalize',
  },
  {
    path: 'packages/sweep-node-modules-cli/bin/sweep-nm.mjs',
    disposition: 'generalize',
    note: '启动器组 (sh / cmd / mjs / d.mts): 文件名与内容均含 bin 名, 随路径泛化落位',
  },
  {
    path: 'packages/sweep-node-modules-cli/scripts/release-artifact.ts',
    disposition: 'generalize',
    note: '发行面白名单含 bin 文件名, 随泛化落位',
  },
  {
    path: 'packages/sweep-node-modules-cli/scripts/verify-release.test.ts',
    disposition: 'generalize',
    note: '夹具含包坐标 (tgz 文件名等)',
  },

  // reset: 换模板化骨架
  {
    path: 'README.md',
    disposition: 'reset',
    note: '根 README 为领域用法; 换模板化骨架 (项目名 / 徽章 / 用法占位)',
  },
  {
    path: 'README.zh-CN.md',
    disposition: 'reset',
    note: '根 README 中文版; 换模板化骨架',
  },
  {
    path: 'AGENTS.md',
    disposition: 'reset',
    note: 'AI 导航图含本仓文档结构 (含产品区与生成器文档); 换模板化骨架 (turbo 托管块 + 文档导航)',
  },
  {
    path: 'SECURITY.md',
    disposition: 'reset',
    note: '安全策略为本仓两包领域内容 (支持版本表 / 删除语义 scope / 领域文档链接); 换通用安全策略骨架',
  },
  {
    path: 'docs/README.md',
    disposition: 'reset',
    note: '总索引登记本仓领域文档; 换骨架索引 (按文档分层协议)',
  },
  {
    path: 'docs/development.md',
    disposition: 'reset',
    note: '开发指南为本仓发布链与双包实操 (含改名历史); 换通用开发指南骨架',
  },
  {
    path: 'docs/designs/README.md',
    disposition: 'reset',
    note: '设计索引登记本仓仓库级设计; 换空组索引骨架',
  },
  {
    path: 'docs/designs/tech-debt.md',
    disposition: 'reset',
    note: '技术债册内容为本仓债目; 换空册骨架 (标准档装备)',
  },
  {
    path: 'docs/adrs/README.md',
    disposition: 'reset',
    note: 'ADR 索引登记本仓编号; 换空组索引骨架 (新项目从 0001 起)',
  },
  {
    path: 'packages/sweep-node-modules/README.md',
    disposition: 'reset',
    note: '包 README 为领域用法; 换最小示例包骨架',
  },
  {
    path: 'packages/sweep-node-modules/README.zh-CN.md',
    disposition: 'reset',
    note: '包 README 中文版; 换最小示例包骨架',
  },
  {
    path: 'packages/sweep-node-modules/CHANGELOG.md',
    disposition: 'reset',
    note: 'CHANGELOG 为发布链生成的本仓历史; 换占位骨架 (首版由 semrel 生成)',
  },
  {
    path: 'packages/sweep-node-modules/src/',
    disposition: 'reset',
    note: '包源码槽: 换最小示例包骨架; 现实现为 sweep 领域代码与测试, 不复用',
  },
  {
    path: 'packages/sweep-node-modules/docs/README.md',
    disposition: 'reset',
    note: '包级文档入口登记领域文档; 换最小示例包文档骨架',
  },
  {
    path: 'packages/sweep-node-modules-cli/README.md',
    disposition: 'reset',
    note: '包 README 为领域用法; 换最小示例包骨架',
  },
  {
    path: 'packages/sweep-node-modules-cli/README.zh-CN.md',
    disposition: 'reset',
    note: '包 README 中文版; 换最小示例包骨架',
  },
  {
    path: 'packages/sweep-node-modules-cli/CHANGELOG.md',
    disposition: 'reset',
    note: 'CHANGELOG 为发布链生成的本仓历史; 换占位骨架 (首版由 semrel 生成)',
  },
  {
    path: 'packages/sweep-node-modules-cli/src/',
    disposition: 'reset',
    note: 'CLI 包源码槽: 换最小示例包 (薄壳) 骨架; 现实现为 sweep 领域代码与测试, 不复用',
  },
  {
    path: 'packages/sweep-node-modules-cli/docs/README.md',
    disposition: 'reset',
    note: '包级文档入口登记领域文档; 换最小示例包文档骨架',
  },

  // exclude: 不进模板
  {
    path: '.mailmap',
    disposition: 'exclude',
    note: '维护者个人数据 (作者名与邮箱归一化); 不进模板',
  },
  {
    path: 'bun.lock',
    disposition: 'exclude',
    note: '锁文件生成物; 新项目 bun install 自行重建',
  },
  {
    path: 'packages/create-clis/',
    disposition: 'exclude',
    note: '生成器自身 (本仓工具); 生成物不含生成器',
  },
  {
    path: 'docs/sweep/',
    disposition: 'exclude',
    note: '产品区领域内容 (sweep 设计 / 契约 / 语料) 整体排除; 空产品区占位由 docs 骨架承担',
  },
  {
    path: 'docs/adrs/0005-engineering-gates-and-hooks.md',
    disposition: 'exclude',
    note: '历史 ADR (本仓决策记录); 新项目自建编号',
  },
  {
    path: 'docs/adrs/0006-dual-runtime-bun-first.md',
    disposition: 'exclude',
    note: '历史 ADR (本仓决策记录); 新项目自建编号',
  },
  {
    path: 'docs/adrs/0009-npm-distribution-form.md',
    disposition: 'exclude',
    note: '历史 ADR (本仓决策记录); 新项目自建编号',
  },
  {
    path: 'docs/adrs/0010-dual-package-monorepo.md',
    disposition: 'exclude',
    note: '历史 ADR (本仓决策记录); 新项目自建编号',
  },
  {
    path: 'docs/adrs/0011-docs-and-adr-layering.md',
    disposition: 'exclude',
    note: '历史 ADR (本仓决策记录); 新项目自建编号',
  },
  {
    path: 'docs/designs/collection-positioning.md',
    disposition: 'exclude',
    note: '本仓定位 (私有边界 / 生成器身份 / 重定位链接); 生成物无对应实体',
  },
  {
    path: 'docs/designs/package-classification.md',
    disposition: 'exclude',
    note: '治理协议绑定本仓 ADR 引用与产品区链接, 链接面在模板内无法自洽; 不进模板',
  },
  {
    path: 'docs/designs/dependency-direction.md',
    disposition: 'exclude',
    note: '依赖契约面向本仓实际包结构; 生成物按自身包结构另立, 不进模板',
  },
  {
    path: 'docs/designs/docs-layering.md',
    disposition: 'exclude',
    note: '分层协议含本仓归属总表与 ADR 链接; 模板 docs 骨架按其声明的空组形态 (索引 / 空组 / 占位) 重建',
  },
  {
    path: 'docs/designs/capability-tiers.md',
    disposition: 'exclude',
    note: '档位机制在生成时已应用; 与生成器 / 重定位文档互相链接, 不随模板',
  },
  {
    path: 'docs/designs/collection-relocation.md',
    disposition: 'exclude',
    note: '本仓重定位执行计划与改名历史; 生成物无对应',
  },
  {
    path: 'docs/designs/scaffold-package.md',
    disposition: 'exclude',
    note: '生成器本体设计; 生成物不含 create-clis 包',
  },
  {
    path: 'docs/designs/scaffold-contract.md',
    disposition: 'exclude',
    note: '生成器命令与变量契约 (生成器自身文档); 不进模板',
  },
  {
    path: 'docs/designs/scaffold-template-snapshot.md',
    disposition: 'exclude',
    note: '模板快照机制设计 (生成器自身文档); 不进模板',
  },
  {
    path: 'packages/sweep-node-modules/bench/',
    disposition: 'exclude',
    note: '领域基准 (扫描 / 体积 / 真实工作区 / 压测); 不进模板',
  },
  {
    path: 'packages/sweep-node-modules/docs/adrs/',
    disposition: 'exclude',
    note: '包级历史 ADR (sweep 产品决策); 不进模板',
  },
  {
    path: 'packages/sweep-node-modules/docs/designs/',
    disposition: 'exclude',
    note: '领域设计 (api-surface); 不进模板',
  },
  {
    path: 'packages/sweep-node-modules-cli/docs/designs/',
    disposition: 'exclude',
    note: '领域设计 (cli-surface); 不进模板',
  },
];
