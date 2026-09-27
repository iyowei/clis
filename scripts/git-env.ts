/**
 * 进程环境清洗: 剔掉 git 注入的「当前仓库坐标」。
 *
 * 背景: git 运行钩子时会把 GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE 等坐标导出进进程
 * 环境, 经 lefthook 一路透传给钩子里跑的命令 (如 bun test 与发布闸门)。任何以 cwd 定位
 * 目标仓库的 git 调用, 若沿用未清洗的环境, 目标仓库都会被这份坐标顶掉: 临时仓库的
 * init / add / commit 落进宿主仓库, 钩子装不进沙箱 .git/hooks (用例静默失败), 重则覆写
 * 宿主自己的钩子。清洗后, git 只按调用点给的 cwd 认仓库。
 *
 * 构建侧 (release-artifact.ts) 与测试夹具共用本模块, 规则只此一处。
 */

/** 剔掉全部 GIT_ 前缀键, 保留其余环境变量 */
export const cleanGitEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('GIT_')) continue;
    env[key] = value;
  }
  return env;
};
