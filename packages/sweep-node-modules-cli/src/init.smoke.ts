/**
 * 初始化向导真实壳冒烟: runInit + createReadlineIO 走真实管道 stdin 与真实文件落盘。
 * 六态: 多行投喂 (真实存在的子目录做根 + 排除 + 写入确认回车) → written (钉落盘内容);
 * 排除一问空答 → written-default-exclude (钉空答取内置默认名单与真实壳层写出的提示段);
 * 首行投喂符号链接根 → symlink-root (钉根锚点校验当场提示并重问, 真实壳下的重问回路);
 * 配置路径是符号链接 → symlink-config (钉落盘前锚点检查拒写: 链接目标原样未动, 重问后 EOF 折算取消);
 * 空输入 EOF → cancelled (不落盘); 预置配置 + 投喂 n → declined-overwrite (既有文件原样不动)。
 * 各态各需独立 stdin, 单进程只有一个, 故驱动器派生自身逐场景投喂 (真实管道, 非伪终端);
 * 逐项打印 ok / FAIL 且失败不中断, 收尾任一不符 exit 1, 全通 exit 0 (失败响亮)。
 * 用法: <bun|node> src/init.smoke.ts <config-path>   (路径经 argv 注入, 脚本不自选位置)
 * 由 init.smoke.test.ts 以 bun / node 双载体 spawn 并带 timeout 守卫:
 * 历史失败模式是 readline 壳死锁, 挂死必须判失败而非无限等待。
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_EXCLUDE,
  firstSymlinkOnRoot,
  firstSymlinkOnTarget,
} from '@iyowei/sweep-node-modules';

import { createReadlineIO, runInit } from './init.ts';

const SELF = fileURLToPath(new URL('./init.smoke.ts', import.meta.url));

/** 派生 worker 的超时守卫: 单场景挂死 (历史缺陷形态) 即杀子进程判失败, 不拖垮整轮 */
const WORKER_TIMEOUT_MS = 3000;

/**
 * 注入路径先归一到真实形态: 向导的根锚点校验与删除侧同口径 (判在拼写上, 见 guard.ts 不变量 ⑤),
 * 而 macOS 的 tmpdir (/var/folders/...) 整条路径穿在 /var 符号链接下, 拿它当根会被向导当场拒
 * (行为正确, 但那样各场景就测不到本意了)。与 fixtures.ts / run-conformance.ts 的 workspace root
 * 同款: 测试根一律取真实路径形态。
 */
function realConfigPath(raw: string): string {
  return join(realpathSync(dirname(raw)), basename(raw));
}

/** written 场景的两个根: 真实存在的子目录 (过存在性校验); 投喂答案与断言两侧同源派生 */
function sceneRoots(configPath: string): [string, string] {
  const base = dirname(configPath);
  return [join(base, 'root-a'), join(base, 'root-b')];
}

/** symlink-root 场景的符号链接根 (指向第一个真实根): 删除侧会整批拒绝的那种拼写 */
function sceneLink(configPath: string): string {
  return join(dirname(configPath), 'link-root');
}

/**
 * symlink-config 场景的受害者文件: 配置路径被换成指向它的符号链接。
 * 写入若跟随链接, 被完整改写的就是它 —— 本场景钉的正是「链接目标一个字节都没动」。
 */
function sceneVictim(configPath: string): string {
  return join(dirname(configPath), 'victim.json');
}

/** 受害者文件的既有内容 (与原配置无干的第三方文件, 任何改写都可见) */
const VICTIM_TEXT = '{"keep":"untouched"}\n';

/** 场景表: name 为 worker 分派键; input 为投喂给 worker stdin 的真实管道内容 */
function makeScenes(configPath: string): {
  name: string;
  input: string;
  /** 需在 worker 透传的 stdout 里核对的文案 (真实壳层写出的提示段); 缺省不核对 */
  expectStdoutContains?: string;
}[] {
  return [
    // 四行: 多根 / 排除名单 / 包含名单 / 写入确认 (空行取默认 Y)
    {
      name: 'written',
      input: `${sceneRoots(configPath).join(', ')}\ndist\n\n\n`,
    },
    // 同前四行, 但排除一问投空行 (取内置默认名单); 提示文案在驱动侧查 (worker 的 stdout 即真实壳层输出)
    {
      name: 'written-default-exclude',
      input: `${sceneRoots(configPath).join(', ')}\n\n\n\n`,
      expectStdoutContains: `回车采用默认名单 (${DEFAULT_EXCLUDE.length} 条)`,
    },
    // 五行的前半 (符号链接根被拒 → 重问给真实根) 与 written 同款, 钉的是真实壳下的重问回路与提示文案
    {
      name: 'symlink-root',
      input: `${sceneLink(configPath)}\n${sceneRoots(configPath).join(', ')}\n\n\n\n`,
      expectStdoutContains: '删除侧要求真实路径',
    },
    // 首行回应覆盖确认 (配置路径是符号链接, 文件在), 后四行同 written;
    // 写入确认被拒后重问该问, 管道已尽 → EOF 折算取消, 全程不写一个字节
    {
      name: 'symlink-config',
      input: `y\n${sceneRoots(configPath).join(', ')}\n\n\n\n`,
      expectStdoutContains: '配置路径锚点链上有符号链接',
    },
    { name: 'eof', input: '' },
    { name: 'decline', input: 'n\n' },
  ];
}

/** decline 场景预置的既有配置: 覆盖保护下应原样不动 */
const EXISTING_CONFIG_TEXT = `${JSON.stringify({ roots: ['/existing'], exclude: [] }, null, 2)}\n`;

const failures: string[] = [];

/** 记录单条检查结果; 不中断执行, 收尾统一判定退出码 */
function check(ok: boolean, label: string): void {
  if (ok) {
    console.log(`ok: ${label}`);
    return;
  }

  failures.push(label);
  console.error(`FAIL: ${label}`);
}

/** 单场景 worker: 自建入口态 → 真实壳提问 → 断言 → 清理; 任一不符 exit 1 */
async function runWorker(name: string, configPath: string): Promise<void> {
  const roots = sceneRoots(configPath);
  const link = sceneLink(configPath);
  const victim = sceneVictim(configPath);

  // 清掉任何残留, 使场景可独立重复运行 (写入类场景需文件与子目录均不存在, decline 需预置配置)
  rmSync(configPath, { force: true });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  rmSync(link, { force: true });
  rmSync(victim, { force: true });
  if (
    name === 'written' ||
    name === 'written-default-exclude' ||
    name === 'symlink-root' ||
    name === 'symlink-config'
  ) {
    for (const root of roots) mkdirSync(root, { recursive: true });
  }
  // 符号链接根: 拼写上有链接介入 (删除侧据此整批拒绝), 向导须当场提示并重问
  if (name === 'symlink-root') await symlink(roots[0], link);
  // 符号链接配置路径: 指向一个无关的第三方文件, 写入若跟随链接就会把它整篇改写
  if (name === 'symlink-config') {
    await writeFile(victim, VICTIM_TEXT);
    await symlink(victim, configPath);
  }
  if (name === 'decline') {
    await writeFile(configPath, EXISTING_CONFIG_TEXT);
  }

  try {
    const result = await runInit({
      configPath,
      fileExists: async (path) => existsSync(path),
      firstSymlinkOnRoot,
      firstSymlinkOnTarget,
      writeFile: async (path, text) => {
        await writeFile(path, text);
      },
      // 冒烟经真实管道投喂 (非 TTY), 着色恒关闭: 钉的是壳不死锁与落盘契约, 非着色形态
      io: createReadlineIO(false),
    });

    if (
      name === 'written' ||
      name === 'written-default-exclude' ||
      name === 'symlink-root'
    ) {
      // 排除名单: written 显式投喂 dist, 另两态投空行 → 取内置默认名单 (显式写出的 exclude
      // 接管默认值, 回填空数组即等于「一路回车丢保护」); symlink-root 的根取重问后的真实路径
      const expected = {
        roots,
        exclude: name === 'written' ? ['dist'] : [...DEFAULT_EXCLUDE],
        include: [],
      };
      check(
        result.state === 'written',
        `${name}: state 为 written (实际 ${result.state})`,
      );
      check(
        JSON.stringify(result.config) === JSON.stringify(expected),
        `${name}: 返回 config 命中期望 (实际 ${JSON.stringify(result.config)})`,
      );

      const persisted = existsSync(configPath);
      check(persisted, `${name}: 配置已落盘`);
      const text = persisted ? readFileSync(configPath, 'utf8') : '';
      check(
        text === `${JSON.stringify(expected, null, 2)}\n`,
        `${name}: 落盘内容为 2 空格缩进 + 末尾换行`,
      );
    } else if (name === 'eof') {
      check(
        result.state === 'cancelled',
        `eof: state 为 cancelled (实际 ${result.state})`,
      );
      check(!existsSync(configPath), 'eof: 未落盘');
    } else if (name === 'symlink-config') {
      // 写入确认被拒 → 重问该问 → 管道已尽折算取消; 关键是链接目标一个字节都没动
      check(
        result.state === 'cancelled',
        `symlink-config: state 为 cancelled (实际 ${result.state})`,
      );
      check(
        readFileSync(victim, 'utf8') === VICTIM_TEXT,
        'symlink-config: 链接目标未被改写 (写入未跟随符号链接)',
      );
      check(
        lstatSync(configPath).isSymbolicLink(),
        'symlink-config: 配置路径仍是符号链接 (未被换成普通文件)',
      );
    } else if (name === 'decline') {
      check(
        result.state === 'declined-overwrite',
        `decline: state 为 declined-overwrite (实际 ${result.state})`,
      );
      check(
        existsSync(configPath) &&
          readFileSync(configPath, 'utf8') === EXISTING_CONFIG_TEXT,
        'decline: 既有配置原样未动',
      );
    } else {
      check(false, `未知场景: ${name}`);
    }
  } catch (error) {
    check(
      false,
      `${name}: 未捕获异常 (${error instanceof Error ? error.message : String(error)})`,
    );
  } finally {
    // 完成后清理, 不留残留 (断言已在清理前读盘完成; 配置路径是符号链接时 rm 只删链接本身)
    rmSync(configPath, { force: true });
    rmSync(victim, { force: true });
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    rmSync(link, { force: true });
  }

  if (failures.length > 0) {
    console.error(`init smoke [${name}]: ${failures.length} 项失败`);
    process.exit(1);
  }

  console.log(`init smoke [${name}]: 全部通过`);
}

/** 驱动器: 逐场景派生 worker 并透传其输出; 任一场景未通过即收尾 exit 1 */
function driveScenes(configPath: string): void {
  const scenes = makeScenes(configPath);
  const failedScenes: string[] = [];

  for (const scene of scenes) {
    console.log(`--- 场景 ${scene.name}: 派生 worker, 管道投喂 stdin ---`);
    const worker = spawnSync(
      process.execPath,
      [SELF, '--case', scene.name, configPath],
      {
        input: scene.input,
        encoding: 'utf8',
        timeout: WORKER_TIMEOUT_MS,
      },
    );

    // 透传 worker 逐项输出; 挂死或失败时同样保留已产生的诊断
    if (worker.stdout) process.stdout.write(worker.stdout);
    if (worker.stderr) process.stderr.write(worker.stderr);

    // 真实壳层写出的提示段在驱动器侧核对: worker 的 stdout 即真实 readline 的输出, 无需劫持流
    if (
      worker.status === 0 &&
      scene.expectStdoutContains !== undefined &&
      !(worker.stdout ?? '').includes(scene.expectStdoutContains)
    ) {
      failedScenes.push(scene.name);
      console.error(
        `FAIL: 场景 ${scene.name} (stdout 未出现期望文案: ${scene.expectStdoutContains})`,
      );
      continue;
    }

    if (worker.status === 0) continue;

    let reason: string;
    if (worker.error !== undefined)
      reason = `运行错误 (${worker.error.message})`;
    else if (worker.signal !== null)
      reason = `被 ${worker.signal} 终止, 疑似挂死`;
    else reason = `退出码 ${worker.status}`;

    failedScenes.push(scene.name);
    console.error(`FAIL: 场景 ${scene.name} (${reason})`);
  }

  if (failedScenes.length > 0) {
    console.error(
      `init smoke: ${failedScenes.length}/${scenes.length} 个场景失败 (${failedScenes.join(', ')})`,
    );
    process.exit(1);
  }

  console.log(`init smoke: 全部通过 (${scenes.length} 个场景)`);
}

const args = process.argv.slice(2);

function usage(): never {
  console.error('用法: <bun|node> src/init.smoke.ts <config-path>');
  process.exit(2);
}

if (args[0] === '--case') {
  const name = args[1];
  const configPath = args[2];
  if (name === undefined || configPath === undefined) usage();
  await runWorker(name, realConfigPath(configPath));
} else {
  const configPath = args[0];
  if (configPath === undefined) usage();
  driveScenes(realConfigPath(configPath));
}
