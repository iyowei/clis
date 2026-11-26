/**
 * 发布闸门测试共享夹具 (临时目录与临时 git 检出)。
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanGitEnv } from '../../../scripts/lib/git-env.ts';

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
  await writeFile(join(temp.root, '.gitignore'), 'dist/\n');
  await writeFile(join(temp.root, 'workspace.txt'), '基线\n');
  runGit(temp.root, ['init']);
  runGit(temp.root, ['add', '-A']);
  runGit(temp.root, [
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=release-test',
    '-c',
    'user.email=release-test@example.com',
    'commit',
    '--no-verify',
    '-m',
    '基线',
  ]);
  return temp;
};
