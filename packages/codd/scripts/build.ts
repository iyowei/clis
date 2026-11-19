/**
 * API 包 (@iyowei/codd) 构建脚本:
 * 清产物 -> bun build 出 JS -> tsc 出类型声明 -> 剔除未导出内部 .d.ts -> 改写 .d.ts 相对 .ts specifier -> 写 dist/manifest.json。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanGitEnv } from '../../../scripts/lib/git-env.ts';

export const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);

/** 非公开内部实现模块产出的 .d.ts (不被 index.d.ts 链引用, 清理出发行面) */
export const INTERNAL_DTS_FILES: readonly string[] = [
  'emit-k8s.d.ts',
  'emit-podman.d.ts',
  'emit-podman-helpers.d.ts',
  'validate-sections.d.ts',
];

/**
 * 递归改写目录下所有 .d.ts 的相对 .ts 扩展名为 .js:
 * 覆盖 `from './x.ts'`、`import './x.ts'`、`import('./x.ts')` 三类形态, 幂等。
 */
export const rewriteDtsSpecifiers = (dir: string): number => {
  let rewrittenCount = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      rewrittenCount += rewriteDtsSpecifiers(abs);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.d.ts')) continue;
    const before = readFileSync(abs, 'utf8');
    const after = before
      .replace(/(from\s+['"])(\.[^'"]+)\.ts(['"])/g, '$1$2.js$3')
      .replace(/(import\s+['"])(\.[^'"]+)\.ts(['"])/g, '$1$2.js$3')
      .replace(/(import\(\s*['"])(\.[^'"]+)\.ts(['"]\s*\))/g, '$1$2.js$3');
    if (after !== before) {
      writeFileSync(abs, after, 'utf8');
      rewrittenCount += 1;
    }
  }
  return rewrittenCount;
};

/** 清理未导出内部模块 .d.ts 并防御性核对公开 .d.ts 未引用被清理模块 */
export const pruneInternalDts = (distDir: string): string[] => {
  for (const file of INTERNAL_DTS_FILES) {
    rmSync(join(distDir, file), { force: true });
  }
  const internalStems = INTERNAL_DTS_FILES.map((f) =>
    f.slice(0, -'.d.ts'.length),
  );
  const leakedRefs: string[] = [];
  const walk = (dir: string, prefix = ''): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.d.ts')) continue;
      const text = readFileSync(abs, 'utf8');
      for (const stem of internalStems) {
        if (new RegExp(`['"]\\./${stem}\\.(?:js|ts)['"]`).test(text)) {
          leakedRefs.push(`${rel} -> ${stem}`);
        }
      }
    }
  };
  walk(distDir);
  return leakedRefs;
};

const gitText = (root: string, args: string[]): string | null => {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: cleanGitEnv(),
  });
  return result.status === 0 ? result.stdout.trim() : null;
};

const runBuild = (): number => {
  const distDir = join(PACKAGE_ROOT, 'dist');

  // 1. 清产物: 整目录重建, 防残留文件混进发布包
  rmSync(distDir, { recursive: true, force: true });

  // 2. JS 产物: 单文件 bundle, node 目标 (标准 ESM, bun / node 双运行时均可)
  const bundle = spawnSync(
    'bun',
    [
      'build',
      join(PACKAGE_ROOT, 'src/index.ts'),
      '--target=node',
      `--outfile=${join(distDir, 'index.js')}`,
    ],
    { stdio: 'inherit' },
  );
  if (bundle.status !== 0) return bundle.status ?? 1;

  // 3. 类型声明: 独立 tsconfig.build.json (emitDeclarationOnly; --no-install 防误拉外部包)
  const types = spawnSync(
    'bun',
    [
      'x',
      '--no-install',
      'tsc',
      '-p',
      join(PACKAGE_ROOT, 'tsconfig.build.json'),
    ],
    { stdio: 'inherit' },
  );
  if (types.status !== 0) return types.status ?? 1;

  // 4. 清理未导出内部 .d.ts + 递归改写相对 .ts specifier 为 .js
  const leaked = pruneInternalDts(distDir);
  if (leaked.length > 0) {
    process.stderr.write(
      `构建失败: 公开 .d.ts 仍引用被清理的内部模块: ${leaked.join(', ')}\n`,
    );
    return 1;
  }
  rewriteDtsSpecifiers(distDir);

  // 5. 自证清单: 记录入口产物摘要与 git 事实
  const head = gitText(PACKAGE_ROOT, ['rev-parse', 'HEAD']);
  const status = gitText(PACKAGE_ROOT, ['status', '--porcelain']);
  writeFileSync(
    join(distDir, 'manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        entry: 'index.js',
        entrySha256: createHash('sha256')
          .update(readFileSync(join(distDir, 'index.js')))
          .digest('hex'),
        commit: head,
        dirty: status === null ? null : status.length > 0,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return 0;
};

if (import.meta.main) {
  process.exitCode = runBuild();
}
