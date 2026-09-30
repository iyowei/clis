/**
 * 发行面闸门测试的共享夹具: 临时目录与临时 git 检出 (一次初始提交 + 忽略 dist/ 的 .gitignore)。
 * 为什么用真 git 而不是打桩: 闸门的事实输入就是 git 命令的输出, 打桩只能证明判定函数自洽,
 * 证明不了「porcelain 空输出等于工作树干净」这条口径; 临时仓库建一次几十毫秒, 换的是真口径。
 * 建仓是夹具内部步骤, 与产品代码的只读 git 探测 (release-artifact.ts) 无关。
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

/** 临时目录 (realpath 归一: macOS 上 /var 与 /private/var 是同一处的两种拼写) */
export const makeTempDir = async (prefix: string): Promise<TempDir> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
};

/**
 * 同步跑一条 git 命令 (夹具自用; 失败即抛: 建仓出错不该被当成用例结论继续跑)。
 * env 经 cleanGitEnv: 宿主的 GIT_* 坐标不得把临时仓库的 init / add / commit 改道到宿主仓库。
 */
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

/**
 * 临时 git 检出: 一次初始提交, 工作树干净; .gitignore 忽略 dist/ (与真实仓库同款,
 * 使「造产物」这一步不会反过来把工作树弄脏)。
 * 提交带上 --no-verify 与 commit.gpgsign=false: 夹具不该被宿主的钩子 / 签名配置干扰。
 */
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
    'user.name=sweep-lab',
    '-c',
    'user.email=sweep-lab@example.com',
    'commit',
    '--no-verify',
    '-m',
    '基线',
  ]);
  return temp;
};
