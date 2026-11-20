/**
 * codd-cli 发行面闸门测试共享夹具: 临时目录与临时 git 检出 (忽略 dist/ 与 assets/)。
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { cleanGitEnv } from '../../../scripts/lib/git-env.ts';
import {
  ASSET_DIR,
  ASSET_MANIFEST_FILE,
  ASSET_TEMPLATE_DIR,
  PACK_FILES_BASE,
} from './release-artifact.ts';

export interface TempDir {
  root: string;
  cleanup: () => Promise<void>;
}

export const makeTempDir = async (prefix: string): Promise<TempDir> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  return {
    root,
    cleanup: async () => {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    },
  };
};

export const runGit = (cwd: string, args: string[]): string => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: cleanGitEnv(),
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败: ${result.stderr.trim()}`);
  }
  return result.stdout;
};

export const makeTempRepo = async (prefix: string): Promise<TempDir> => {
  const temp = await makeTempDir(prefix);
  await writeFile(join(temp.root, '.gitignore'), 'dist/\nassets/\n');
  await writeFile(join(temp.root, 'workspace.txt'), '基线\n');
  runGit(temp.root, ['init']);
  runGit(temp.root, ['add', '-A']);
  runGit(temp.root, [
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=codd-cli-lab',
    '-c',
    'user.email=codd-cli-lab@example.com',
    'commit',
    '--no-verify',
    '-m',
    '基线',
  ]);
  return temp;
};

export const STAGED_TEMPLATE_FILES: Record<string, string> = {
  'helm/Chart.yaml': 'name: mongo-replica\n',
};

export const stageTemplateAssets = async (
  root: string,
  files: Record<string, string> = STAGED_TEMPLATE_FILES,
): Promise<void> => {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, ASSET_DIR, ASSET_TEMPLATE_DIR, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  await writeFile(
    join(root, ASSET_DIR, ASSET_MANIFEST_FILE),
    `${JSON.stringify({ schemaVersion: 1, files: Object.keys(files).sort() }, null, 2)}\n`,
  );
};

export const STAGED_EXPECTED_PACK: readonly string[] = [
  ...PACK_FILES_BASE,
  `${ASSET_DIR}/${ASSET_MANIFEST_FILE}`,
  `${ASSET_DIR}/${ASSET_TEMPLATE_DIR}/helm/Chart.yaml`,
];
