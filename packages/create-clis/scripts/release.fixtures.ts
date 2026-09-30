/**
 * 发行面闸门测试的共享夹具: 临时目录与临时 git 检出 (一次初始提交 + 忽略 dist/ 与 assets/ 的
 * .gitignore: 两者都是构建产物, 与真实仓库同款忽略, 使「造产物 / 造资产」不会反过来把工作树
 * 弄脏)。
 * 为什么用真 git 而不是打桩: 闸门的事实输入就是 git 命令的输出, 打桩只能证明判定函数自洽,
 * 证明不了「porcelain 空输出等于工作树干净」这条口径; 临时仓库建一次几十毫秒, 换的是真口径。
 * 建仓是夹具内部步骤, 与产品代码的只读 git 探测 (release-artifact.ts) 无关。
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
 * 临时 git 检出: 一次初始提交, 工作树干净; .gitignore 忽略 dist/ 与 assets/ (与真实仓库同款,
 * 使「造产物 / 造资产」这一步不会反过来把工作树弄脏)。
 * 提交带上 --no-verify 与 commit.gpgsign=false: 夹具不该被宿主的钩子 / 签名配置干扰。
 */
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
    'user.name=create-clis-lab',
    '-c',
    'user.email=create-clis-lab@example.com',
    'commit',
    '--no-verify',
    '-m',
    '基线',
  ]);
  return temp;
};

/** 用例统一铺的模板资产 (一份就够: 白名单对账只看文件集, 不看内容) */
export const STAGED_TEMPLATE_FILES: Record<string, string> = {
  'README.md': '模板资产\n',
};

/**
 * 在检出内造模板资产: 写 assets/template/ 下的文件, 并在同级落资产清单 (build-template 的产出
 * 契约形态)。默认铺 STAGED_TEMPLATE_FILES, 用例可注入自己的文件集 (如验证 npm 不可发项的扣除)。
 */
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

/** 与 STAGED_TEMPLATE_FILES 相符的白名单期望 (固定项 + 资产清单自身 + 展开的资产文件) */
export const STAGED_EXPECTED_PACK: readonly string[] = [
  ...PACK_FILES_BASE,
  `${ASSET_DIR}/${ASSET_MANIFEST_FILE}`,
  `${ASSET_DIR}/${ASSET_TEMPLATE_DIR}/README.md`,
];
