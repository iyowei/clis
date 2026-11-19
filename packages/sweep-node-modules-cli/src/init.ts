/**
 * 初始化向导: 三问 (扫描根 / 排除名单 / 包含名单) + 覆盖保护 + 落盘前锚点检查, 交互 IO 依赖注入。
 * 权威: config-and-initialization.md「配置初始化模型」与 ADR 0004 (配置初始化向导)。
 * 纯逻辑 (答案解析 / 状态流转 / 落盘文本) 与 readline 交互分离, 前者由 init.test.ts 钉死。
 * 视觉: 与清单同一套色块语言 (顶栏 / 中性行 / 标记原语见 render.ts), 着色开关经 IO 层注入。
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Interface, createInterface } from 'node:readline/promises';

import { type Config, DEFAULT_EXCLUDE } from '@iyowei/sweep-node-modules';

import {
  bannerLine,
  neutralLine,
  paint,
  sanitizeLine,
  shortenHome,
} from './render.ts';

/** 交互 IO: ask 返回 null 表示取消 (Ctrl+C / EOF) */
export interface InitIO {
  /** 提问并等待一行答案; 返回 null 即取消 (hint 非空时以压暗的 [hint] 附在问句后) */
  ask(question: string, hint?: string): Promise<string | null>;
  /** 是 / 否确认; 空答取 defaultYes */
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  /** 输出一行普通信息 */
  print(line: string): void;
  /** 可选: 结束会话时释放底层资源 (如关闭 readline interface 并解挂 SIGINT 监听) */
  close?(): void;
  /** 着色开关 (非 TTY / NO_COLOR 为 false): 本次向导的问句提示与回执按它着色, 与清单同一降级契约 */
  color: boolean;
}

/** 运行依赖: 文件系统与 IO 全部注入, 本模块不直接碰 stdin / fs */
export interface InitDeps {
  /** 配置文件目标路径 */
  configPath: string;
  /** 配置文件是否已存在 (lstat 语义: 悬空符号链接也算已存在, 触发覆盖保护) */
  configExists(path: string): Promise<boolean>;
  /** 可选: 配置目标路径是否为既有目录 (前置与落盘前拦截 EISDIR) */
  configIsDirectory?(path: string): Promise<boolean>;
  /** 扫描根是否为真实目录 (lstat + isDirectory: 不存在、普通文件与符号链接均返 false) */
  rootIsDirectory(path: string): Promise<boolean>;
  /** 可选: 扫描根路径是否存在 (lstat 语义); 提供时可精确区分「根不存在」与「根不是目录」 */
  rootExists?(path: string): Promise<boolean>;
  /** 根锚点链上首个符号链接的路径 (null 即全链为真目录); 判定口径由删除侧同一实现供给 (guard.ts), 本模块不自判 */
  firstSymlinkOnRoot(root: string): Promise<string | null>;
  /** 配置路径 (落盘目标) 锚点链上首个符号链接的路径; 与根的判定同一实现, 判的是「写入会不会跟随链接改写其目标」 */
  firstSymlinkOnTarget(target: string): Promise<string | null>;
  writeFile(path: string, text: string): Promise<void>;
  /** 家目录 (默认根、~ 展开与回显缩写用); 缺省 os.homedir() */
  home?: string;
  io: InitIO;
}

export interface InitResult {
  state: 'written' | 'cancelled' | 'declined-overwrite';
  /** 仅 state 为 written 时存在: 实际落盘的配置 (复用 Config 而非重述形状, 加字段时不会漏改) */
  config?: Config;
}

/** 空白判定: 正则 \s 已覆盖全角空格 (\u3000) 等 Unicode 空白 */
const WHITESPACE = /\s/;

/** 家目录展开: 仅认 ~ 与 ~/... / ~\... (后者是 win32 习惯; 不解析 ~user: 跨平台语义不一) */
function expandHome(token: string, home: string): string {
  if (token === '~') return home;
  if (token.startsWith('~/') || token.startsWith('~\\'))
    return join(home, token.slice(2));
  return token;
}

/**
 * 答案切分: 逗号 (半角 / 全角) 与未加引号的空白作分隔; 成对引号 (双 / 单) 内的
 * 空格与逗号原样保留、引号字符剥离; 未配对的引号按普通字符处理, 不吞后续内容。
 */
function splitAnswer(answer: string): string[] {
  const items: string[] = [];
  let current = '';
  let openQuote: string | null = null;

  for (let index = 0; index < answer.length; index += 1) {
    const char = answer[index]!;

    if (openQuote !== null) {
      if (char === openQuote) {
        openQuote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      // 仅当后方存在配对引号才进入引用态; 未配对时按普通字符累积
      if (answer.indexOf(char, index + 1) !== -1) {
        openQuote = char;
        continue;
      }
      current += char;
      continue;
    }

    if (char === ',' || char === '，' || WHITESPACE.test(char)) {
      if (current.length > 0) items.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  if (current.length > 0) items.push(current);
  return items;
}

/**
 * 路径列表解析 (用于扫描根 roots): 切分 (见 splitAnswer) → 家目录展开; 空答案 (含 null) 回落 fallback。
 *
 * ### 数据追踪示例
 *
 * Input（真实 Payload）
 *   answer = '"~/My Projects", ~/lab'
 *   fallback = ['/Users/iyowei/tmp']
 *
 * 步骤 1：切分 (引号内空格保留, 未加引号的逗号 / 空白作分隔)
 *   items = ['~/My Projects', '~/lab']
 *
 * 步骤 2：展开家目录 (~ 与 ~/...)
 *   items = ['/Users/iyowei/My Projects', '/Users/iyowei/lab']
 *
 * Output（数据契约）
 *   return ['/Users/iyowei/My Projects', '/Users/iyowei/lab']
 */
export function parsePathList(
  answer: string | null,
  fallback: string[],
  home: string = homedir(),
): string[] {
  if (answer === null) return [...fallback];
  // 展开家目录后一律 resolve 绝对化并去重, 确保落盘配置与唤起 cwd 无关且 Windows 正斜杠归一
  const items = [
    ...new Set(
      splitAnswer(answer).map((token) => resolve(expandHome(token, home))),
    ),
  ];
  return items.length > 0 ? items : [...fallback];
}

/**
 * 目录名列表解析 (用于 exclude / include): 仅切分, 不做 ~ 家目录展开 (目录名按精确名匹配,
 * 展开 ~ 会把字面目录名改写成绝对路径); 空答案 (含 null) 回落 fallback。
 */
export function parseNameList(
  answer: string | null,
  fallback: string[],
): string[] {
  if (answer === null) return [...fallback];
  const items = splitAnswer(answer);
  return items.length > 0 ? items : [...fallback];
}

/** 目录名是否包含路径分隔符 (单级目录名精确匹配下含分隔符永远无法命中) */
const hasPathSeparator = (name: string): boolean =>
  name.includes('/') || name.includes('\\');

/** 逐根校验结果 */
interface RootCheckResult {
  missing: string[];
  notDir: string[];
  symlinked: { root: string; link: string }[];
}

/**
 * 逐根校验: 存在性 → 根锚点链无符号链接 → 目标为目录 (拦截普通文件路径写入 roots)。
 * 抽成独立函数以保持 runInit 扁平且清晰。
 */
async function checkRoots(
  roots: readonly string[],
  deps: Pick<InitDeps, 'rootExists' | 'rootIsDirectory' | 'firstSymlinkOnRoot'>,
): Promise<RootCheckResult> {
  const missing: string[] = [];
  const notDir: string[] = [];
  const symlinked: { root: string; link: string }[] = [];

  for (const root of roots) {
    if (deps.rootExists !== undefined && !(await deps.rootExists(root))) {
      missing.push(root);
      // 不存在的根已足以下判: 不再叠报形态问题 (同一根只给一条提示)
      continue;
    }
    // 判在解析后的拼写上 (即写进配置的形态), 与删除侧的判据同一坐标
    const link = await deps.firstSymlinkOnRoot(root);
    if (link !== null) {
      symlinked.push({ root, link });
      continue;
    }
    if (!(await deps.rootIsDirectory(root))) {
      if (deps.rootExists !== undefined) notDir.push(root);
      else missing.push(root);
    }
  }
  return { missing, notDir, symlinked };
}

/**
 * 装配配置并落盘 (2 空格缩进 + 末尾换行)。
 * 外部副作用：经 deps.writeFile 写入 configPath; 结束时在 finally 经 io.close?.() 释放交互资源。
 *
 * 执行步骤：
 * 1. 顶栏先出 (与清单同一视觉语言), 配置已存在则再确认覆盖 (默认否), 拒绝即返回 declined-overwrite;
 * 2. 开场提示后问扫描根 (默认值为家目录而非 cwd): 逐根校验存在性、根锚点形态与目录类型,
 *    不存在、普通文件或落在符号链接路径上的根以红色 ✗ 提示后重问该问;
 * 3. 依次问排除名单与包含名单 (不做 ~ 展开; 含路径分隔符时提示), 回显解析结果并确认 (默认写入);
 * 4. 中途取消与回显拒绝统一返回 cancelled 且不落盘 (取消文案保持原样, 不带视觉标记);
 * 5. 确认写入后、任何写动作 (含建目标目录) 之前做落盘前锚点检查 (口径见 deps.firstSymlinkOnTarget);
 * 6. 落盘后回显 (写入路径带家目录缩写与绿色 ✓; 落盘全文内容与文件一致、整体缩进 2), 返回 written。
 */
export async function runInit(deps: InitDeps): Promise<InitResult> {
  const { configPath, configExists, firstSymlinkOnTarget, writeFile, io } =
    deps;
  const { color } = io;
  // 默认取注入家目录或 os.homedir(): 工作区级清理与唤起目录无关; 非 TTY 回退按 cwd, 见 cli.ts
  const home = deps.home ?? homedir();

  /** 统一取消出口: 中途取消与回显拒绝共用同一措辞 */
  function cancelled(): InitResult {
    io.print('已取消, 未写入配置');
    return { state: 'cancelled' };
  }

  /** 检查配置路径是否可安全落盘 (拦截既有目录与锚点软链); 不可写时输出清晰拒绝并返 false */
  async function checkConfigTarget(): Promise<boolean> {
    if (
      deps.configIsDirectory !== undefined &&
      (await deps.configIsDirectory(configPath))
    ) {
      io.print(
        `  ${paint('✗', '31', color)} 配置路径是既有目录, 无法写入文件: ${sanitizeLine(configPath)}; 请用 --config 指定文件路径或先移走该目录`,
      );
      return false;
    }
    const link = await firstSymlinkOnTarget(configPath);
    if (link !== null) {
      io.print(
        `  ${paint('✗', '31', color)} 配置路径锚点链上有符号链接: ${sanitizeLine(link)} (配置: ${sanitizeLine(configPath)}); 写入会跟随符号链接改写其目标, 改写为不含符号链接的形态 (macOS 上如 /tmp/x 写成 /private/tmp/x)`,
      );
      return false;
    }
    return true;
  }

  try {
    io.print(bannerLine('初始化向导', color));

    // 进入覆盖确认与三问前先校验 configPath: 既有目录或锚点软链立即前置拒绝, 避免答完三问才撞墙或陷死循环
    if (!(await checkConfigTarget())) return cancelled();

    if (await configExists(configPath)) {
      const overwrite = await io.confirm(
        `配置已存在 (${sanitizeLine(configPath)}), 是否覆盖?`,
        false,
      );
      if (!overwrite) return { state: 'declined-overwrite' };
    }

    io.print(neutralLine('首次使用, 先确定扫描范围', color));

    let roots: string[] = [];

    // 存在性、根锚点形态与目录类型校验挡在落盘前: 坏根提示后重问, 不让无效路径或普通文件进配置
    for (;;) {
      const rootsAnswer = await io.ask(
        '扫描根 (逗号或空白分隔多个)',
        // 缩写在前、净化在后 (与落盘回执同款): home 源自环境属外部数据, 此坐标与其余回显面一致
        `默认: ${sanitizeLine(shortenHome(home, home))}`,
      );
      if (rootsAnswer === null) return cancelled();
      roots = parsePathList(rootsAnswer, [home], home);

      const { missing, notDir, symlinked } = await checkRoots(roots, deps);
      if (missing.length === 0 && notDir.length === 0 && symlinked.length === 0)
        break;
      // 路径与根都是用户答案原样透传 (外部数据): 经同一净化, 防控制序列改写回显行
      for (const path of missing)
        io.print(
          `  ${paint('✗', '31', color)} 根不存在: ${sanitizeLine(path)}`,
        );
      for (const path of notDir)
        io.print(
          `  ${paint('✗', '31', color)} 根不是目录: ${sanitizeLine(path)}`,
        );
      for (const item of symlinked)
        io.print(
          `  ${paint('✗', '31', color)} 根锚点链上有符号链接: ${sanitizeLine(item.link)} (根: ${sanitizeLine(item.root)}); 删除侧要求真实路径, 改写为不含符号链接的形态 (macOS 上如 /tmp/x 写成 /private/tmp/x)`,
        );
    }

    // 空答取内置默认名单 (而非空数组): 显式写出的 exclude 会完全接管默认值 (见 config.ts 的 DEFAULT_EXCLUDE)
    const excludeAnswer = await io.ask(
      '排除名单 (目录名)',
      `回车采用默认名单 (${DEFAULT_EXCLUDE.length} 条)`,
    );
    if (excludeAnswer === null) return cancelled();
    const exclude = parseNameList(excludeAnswer, [...DEFAULT_EXCLUDE]);
    for (const bad of exclude.filter(hasPathSeparator)) {
      io.print(
        `  ${paint('!', '33', color)} 排除名含路径分隔符, 不会命中任何目录 (请填写单级目录名): ${sanitizeLine(bad)}`,
      );
    }

    const includeAnswer = await io.ask('包含名单 (目录名, 可留空)', '回车跳过');
    if (includeAnswer === null) return cancelled();
    const include = parseNameList(includeAnswer, []);
    for (const bad of include.filter(hasPathSeparator)) {
      io.print(
        `  ${paint('!', '33', color)} 包含名含路径分隔符, 不会命中任何目录 (请填写单级目录名): ${sanitizeLine(bad)}`,
      );
    }

    io.print(
      neutralLine(
        `将写入 ${roots.length} 个扫描根 · 排除 ${exclude.length} 条 · 包含 ${include.length} 条`,
        color,
      ),
    );
    // 落盘前 TOCTOU 复检 (写入侧): 问答期间目标变为目录或锚点链出现符号链接即拒, 重问默认改为 false (y/N) 防死循环
    let confirmDefault = true;
    for (;;) {
      if (!(await io.confirm('确认写入?', confirmDefault))) return cancelled();
      if (await checkConfigTarget()) break;
      confirmDefault = false;
    }

    const config = { roots, exclude, include };
    const text = `${JSON.stringify(config, null, 2)}\n`;
    await writeFile(configPath, text);
    io.print(
      `  配置已写入: ${sanitizeLine(shortenHome(configPath, home))}  ${paint('✓', '32', color)}`,
    );
    io.print('');
    // 回显逐行缩进 2, 与叙述行/交互行同一左缘 (内容与落盘文件逐字一致, 仅整体加固定两空格缩进)
    io.print(
      text
        .trimEnd()
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    );
    io.print('');
    return { state: 'written', config };
  } finally {
    io.close?.();
  }
}

/**
 * stdin 的进程引用管理: 等待一行期间保持 ref, 等待结束 (一行到手 / 流关闭) 即 unref,
 * 使 TTY 场景向导完成后进程能自然退出 (pty 实测: 不释放则挂在 stdin 上, 契约又无 close 通道)。
 * 为何 close 路径也显式释放: 官方文档 (nodejs.org/api/readline.html) 未承诺 close 释放引用,
 * 反而直接推荐 process.stdin.unref() 让进程退出; 虽 pty 双载体实测 (node v26 / bun 1.4.2)
 * close 后进程立即退出, 但那是未文档化的实现细节, 故按对称语义显式释放 (幂等, 防运行时差异)。
 * bun 的 process.stdin 在流结束后 ref / unref 会消失 (eof 场景实测: 无条件调用抛 TypeError),
 * 故按存在性调用, 缺失时跳过 (此刻流已结束, 引用管理本就无意义)。
 */
function setStdinRef(shouldRef: boolean): void {
  const fn = shouldRef ? process.stdin.ref : process.stdin.unref;
  if (typeof fn === 'function') fn.call(process.stdin);
}

/**
 * 真实 readline 适配 (薄壳, 由 e2e 覆盖)。
 * 单 interface 长存 + 自管行缓冲: 管道一次性投喂多行时, 先到的行入队, 后续问题依次取走
 * (每问新开 interface 的形态会丢行并因 EOF 已发生而永久挂起, 冒烟实测坐实)。
 * color 由调用方判定后传入 (见 cli.ts 的 colorEnabled); 问句里的 [hint] 与 (Y/n) 标记按它压暗。
 * prompt 内嵌 ANSI 安全: readline 算光标位置前会剥控制序列 (node 源码 _getDisplayPos 实证)。
 * 外部副作用：读写 process.stdin / process.stdout。
 * stdin 结束 (EOF) 或 Ctrl+C 一律折算为取消 (ask 返 null, confirm 返 false)。
 */
export function createReadlineIO(color: boolean): InitIO {
  /** 已到达但尚无问题认领的行 (先于问题到达的答案) */
  const buffered: string[] = [];
  let rl: Interface | null = null;
  let ended = false;
  let aborted = false;
  /** 当前等待中的问题; 调用方串行提问, 同一时刻至多一个 */
  let pending: ((line: string | null) => void) | null = null;

  const onSigint = (): void => {
    aborted = true;
    buffered.length = 0;
    if (process.stdout.isTTY === true) process.stdout.write('\n');
    rl?.close();
  };

  function ensure(): Interface {
    if (rl !== null) return rl;

    const created = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    created.on('line', (line) => {
      if (pending === null) {
        buffered.push(line);
        return;
      }
      const resolve = pending;
      pending = null;
      setStdinRef(false);
      resolve(line);
    });
    created.on('close', () => {
      ended = true;
      if (pending === null) return;
      const resolve = pending;
      pending = null;
      setStdinRef(false); // 与 line 路径对称: 等待因流关闭而结束, 同样释放引用
      resolve(null);
    });
    created.on('SIGINT', onSigint);
    rl = created;
    return created;
  }

  /**
   * 取一行: 先回显提示, 缓冲命中立即取, 否则挂起等待; 会话已结束且缓冲已空时返回 null。
   * 缓冲里已到达的行优先于「会话已结束」交付: 提问之间的真实等待 (如向导逐级 lstat 的形态校验)
   * 会让出 macrotask, 管道投喂的 EOF 可能先被处理并把 ended 置起, 此时若因 ended 丢弃缓冲, 重问
   * 一次就把后续答案整批丢掉 (实测形态: 全流程静默折算取消)。该分支下提示改由 stdout 直写:
   * 已关闭的 interface 再 prompt 会被官方实现拒绝 (ERR_USE_AFTER_CLOSE, 实测坐实)。
   */
  function readLine(prompt: string): Promise<string | null> {
    if (aborted) return Promise.resolve(null);
    // 会话已结束: 缓冲里还有行就照常交付 (提示直写 stdout, 保持输出的行结构), 否则折算取消
    // (重建 interface 也等不到已发生过的 EOF)
    if (ended) {
      const bufferedLine = buffered.shift();
      if (bufferedLine === undefined) return Promise.resolve(null);
      process.stdout.write(`${prompt}\n`);
      return Promise.resolve(bufferedLine);
    }

    const created = ensure();
    created.setPrompt(prompt);
    created.prompt();

    const ready = buffered.shift();
    if (ready !== undefined) {
      process.stdout.write('\n');
      return Promise.resolve(ready);
    }

    setStdinRef(true);
    return new Promise((resolve) => {
      pending = resolve;
    });
  }

  return {
    color,
    ask(question, hint) {
      // 缩进 2: 与叙述行 (neutralLine) 同一左缘, 全流程不横跳 (视觉规格见 cli-surface.md「init 向导」)
      const prompt =
        hint === undefined
          ? `  ${question} `
          : `  ${question} [${paint(hint, '2', color)}] `;
      return readLine(prompt);
    },
    async confirm(question, defaultYes) {
      const mark = paint(defaultYes ? '(Y/n)' : '(y/N)', '2', color);
      const answer = await readLine(`  ${question} ${mark} `);
      if (answer === null) return false;
      const normalized = answer.trim().toLowerCase();
      if (normalized === '') return defaultYes;
      return normalized === 'y' || normalized === 'yes';
    },
    print(line) {
      process.stdout.write(`${line}\n`);
    },
    close() {
      if (rl === null) return;
      const current = rl;
      rl = null;
      current.off('SIGINT', onSigint);
      current.close();
      setStdinRef(false);
    },
  };
}
