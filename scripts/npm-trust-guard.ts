/**
 * 发布凭据闸门: 核对 npm 侧 Trusted Publisher 登记与当前仓库形态是否一致。
 *
 * 动机: 2026-09-30 仓库改名 iyowei/clis 后, npm 侧两包的登记 (repository 字段) 仍指旧仓库名,
 * 发布链在 release job 以误导性的 ENONPMTOKEN 挂掉 (OIDC 换证被拒后回落到 token 检查)。
 * 「改名」是平台动作不进 git diff, npm 侧登记是仓库外状态, 本地预演触碰不到, 失配发生时
 * 没有任何机制会喊一声。本闸门分两个场景补上这道声音:
 *
 * - CI (`verify-oidc`): 用 GitHub OIDC 对每包试一次 token exchange。这一步本身就是 npm 拿
 *   OIDC 令牌与登记表 (repository / workflow file / environment) 逐字段核对的过程: 换到
 *   凭证即全对, 被拒即失配。零密钥, 走的是发布链同一条 OIDC 通道。核对面 = 仓内可发布包
 *   (非 private 且不在根 package.json 的 multi-release.ignorePackages 名单内, 与发布链同源)。
 * - 本地 (`check` / `fix`): 经 `npm trust list` 对账; fix 删旧建新 (npm 侧已存配置不支持
 *   就地修改, 只能 revoke + 重建)。需要 npm 登录态与交互式终端; npm 对这类敏感操作逐步
 *   要求网页一次性认证, 且认证只对当次调用有效, 一次 fix 可能要在浏览器确认多轮。
 *   npm 的 web 认证交互要求 stdin 与 stdout 都是 TTY (非 TTY 直接把 EOTP 抛给你), 故对
 *   npm 的调用一律经 pty 包装 (`script`), 输出流式透传给操作者。
 *
 * 期望值: repository 从 git origin 派生; workflow 文件名与环境名取下方常量 (与 release.yml 同步)。
 *
 * 用法:
 *   bun scripts/npm-trust-guard.ts verify-oidc   # CI: OIDC 换证预检 (需 id-token: write)
 *   bun scripts/npm-trust-guard.ts check         # 本地: 只读对账
 *   bun scripts/npm-trust-guard.ts fix           # 本地: 对账并修复 (revoke + 重建)
 * 退出码: 0 通过 (或环境不适用); 1 失配或失败。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readGitText } from './lib/release-verify.ts';
import {
  type WorkspacePackage,
  listWorkspacePackages,
} from './lib/workspace.ts';
import { REPO_ROOT } from './lint-doc-shared.ts';

/** npm 官方 registry (OIDC 换证与 trust 管理端点只存在于官方源, 镜像源没有) */
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/';

/** 发布 workflow 文件名: 常量单点, 与 `.github/workflows/release.yml` 同步 */
const RELEASE_WORKFLOW = 'release.yml';

/** 发布环境名: 常量单点, 与 release.yml 的 `environment: release` 同步 */
const RELEASE_ENVIRONMENT = 'release';

/** OIDC 令牌 audience: npm 约定值, 与发布链 @semantic-release/npm 的换证请求一致 */
const OIDC_AUDIENCE = 'npm:registry.npmjs.org';

/** npm trust list 解析出的登记条目 (缺行字段落成 null) */
export interface TrustEntry {
  type: string | null;
  id: string | null;
  file: string | null;
  environment: string | null;
  repository: string;
}

/** 期望的登记形态 (owner/repo 从 git origin 派生, 其余为常量) */
export interface TrustExpectation {
  repository: string;
  file: string;
  environment: string;
}

/** OIDC 运行环境判定: ready = 可预检; missing-permission = Actions 里漏配 id-token; not-ci = 本地 */
export type OidcEnvVerdict = 'ready' | 'missing-permission' | 'not-ci';

/** 剥终端 CSI 序列 (颜色着色与 spinner 的光标控制; 参数段 [0-9;?]*, 末字符为任意字母) */
const stripCsi = (text: string): string =>
  text.replace(
    new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[A-Za-z]', 'g'),
    '',
  );

/** 剥控制字符并收拢空白 (npm 输出属低信任输入, 落进人读文案前先降噪) */
const cleanText = (text: string): string =>
  text.replace(/[\p{Cc}]+/gu, ' ').trim();

/**
 * 剥 pty 伪影: `script` 开场的 ^D + 退格序列、CRLF 行尾与孤立终端控制符。
 * 须在 stripCsi 之后调用: 本函数的控制符剥离面覆盖 ESC 本身, 先把完整 CSI 序列剥掉再除残留。
 */
const stripPtyNoise = (text: string): string =>
  text
    .replace(/\r/g, '')
    // eslint-disable-next-line no-control-regex -- 此处刻意匹配 pty 残留控制符 (script 开场的 ^D 与退格), 属预期匹配
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

/** 从 git remote 原文派生 owner/repo; 非 GitHub 远端或形状不符返回 null */
export function deriveRepoFromRemoteUrl(raw: string): string | null {
  const cleaned = raw.trim().replace(/\.git$/, '');
  const match = cleaned.match(/github\.com[:/]([^/\s]+)\/([^/\s]+)$/);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return `${match[1]}/${match[2]}`;
}

/**
 * 解析 `npm trust list` 的人读输出 (键值行形态)。
 * 噪音行 (认证提示、npm notice) 天然不含键名冒号行, 不干扰解析; 未见 repository 行时返回 null
 * (认不出核心字段即视为形状不符, 不猜测)。
 */
export function parseTrustListOutput(raw: string): TrustEntry | null {
  const text = stripPtyNoise(stripCsi(raw));
  const pick = (key: string): string | null => {
    const match = new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(text);
    if (match === null || match[1] === undefined) return null;
    return cleanText(match[1]);
  };
  const repository = pick('repository');
  if (repository === null || repository === '') return null;
  return {
    type: pick('type'),
    id: pick('id'),
    file: pick('file'),
    environment: pick('environment'),
    repository,
  };
}

/** 登记比对 (纯函数): 逐字段列出与期望值的差异, 全一致返回空列表 */
export function diffTrust(
  actual: TrustEntry,
  expected: TrustExpectation,
): string[] {
  const problems: string[] = [];
  if (actual.repository !== expected.repository) {
    problems.push(
      `repository: ${actual.repository} → 期望 ${expected.repository}`,
    );
  }
  if (actual.file !== expected.file) {
    problems.push(
      `workflow 文件: ${actual.file ?? '(未设置)'} → 期望 ${expected.file}`,
    );
  }
  if (actual.environment !== expected.environment) {
    problems.push(
      `environment: ${actual.environment ?? '(未设置)'} → 期望 ${expected.environment}`,
    );
  }
  return problems;
}

/** OIDC 环境判定 (纯函数): 三分支各自对应不同出口, 防「权限漏配」被静默放过 */
export function classifyOidcEnv(
  env: Record<string, string | undefined>,
): OidcEnvVerdict {
  if (env.GITHUB_ACTIONS !== 'true') return 'not-ci';
  return env.ACTIONS_ID_TOKEN_REQUEST_URL !== undefined &&
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== undefined
    ? 'ready'
    : 'missing-permission';
}

/**
 * 生成经 pty 包装的 npm 调用坐标。npm 的 web 认证交互 (npm 源码 lib/utils/auth.js 的 otplease)
 * 要求 stdin 与 stdout 都是 TTY, 非 TTY 会直接把 EOTP 抛给调用方 (附 URL 让你自己去认证, 会话内
 * 无法完成); `script` 起 pty 后既保交互又保捕获。
 * - darwin: `script -q /dev/null <cmd...>` (退出码透传, Darwin 25 实测);
 * - linux: `script -qec "<cmd 串>" /dev/null` (util-linux 语法; 调用点参数值全部受控:
 *   包名 / UUID / 常量, 无空白字符);
 * - 其余平台 (如 win32) 无 script, 降级直跑 (会话内认证可能不可用, 由 mainLocal 的预警兜底)。
 */
export function ptyWrapArgs(
  platform: NodeJS.Platform,
  npm: string,
  args: string[],
): { command: string; args: string[] } {
  if (platform === 'darwin') {
    return { command: 'script', args: ['-q', '/dev/null', npm, ...args] };
  }
  if (platform === 'linux') {
    return {
      command: 'script',
      args: ['-qec', [npm, ...args].join(' '), '/dev/null'],
    };
  }
  return { command: npm, args };
}

/** npm 可执行名 (Windows 是 npm.cmd, execFile/spawn 不走 shell 时不会自动补扩展名) */
const npmBin = (): string => (process.platform === 'win32' ? 'npm.cmd' : 'npm');

/**
 * 经 pty 跑一条 npm 命令并流式收输出: stdout 逐块透传给操作者 (认证提示 "Press ENTER..." 必须
 * 实时可见) 同时累积供解析; stdin 与 stderr 直通。
 * 不设超时: 网页认证与人工按键的耗时不可控, 等待即预期行为。
 */
function runNpmCaptured(
  args: string[],
): Promise<{ status: number | null; stdout: string; error?: Error }> {
  const wrapped = ptyWrapArgs(process.platform, npmBin(), args);
  return new Promise((resolve) => {
    const child = spawn(wrapped.command, wrapped.args, {
      stdio: ['inherit', 'pipe', 'inherit'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    let captured = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      captured += chunk.toString('utf8');
      process.stdout.write(chunk);
    });
    child.on('error', (error) =>
      resolve({ status: null, stdout: captured, error }),
    );
    child.on('close', (status) => resolve({ status, stdout: captured }));
  });
}

/**
 * 读根 package.json 的 multi-release.ignorePackages (发布链的包豁免名单, 与
 * multi-semantic-release 同字段同源)。缺字段时返回 undefined, 由 filterPublishable 按空名单兜底。
 */
function readIgnorePackages(): unknown {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as { 'multi-release'?: { ignorePackages?: unknown } };
  return manifest['multi-release']?.ignorePackages;
}

/**
 * 预检核对面 (纯函数): 可发布 (非 private) 且不在发布链豁免名单内的包。
 * 核对面与发布链 (multi-semantic-release) 的「可发布包」定义保持单源一致: mrs 按
 * multi-release.ignorePackages 排除的包 (如首发前 npm 侧尚无 Trusted Publisher 登记、无法预配的
 * 新包), 预检也不应要求其有 npm 侧登记。名单缺失或非数组时视为空名单, 不误伤任何包。
 */
export function filterPublishable(
  packages: readonly WorkspacePackage[],
  ignoreList: unknown,
): WorkspacePackage[] {
  const ignored = new Set(Array.isArray(ignoreList) ? ignoreList : []);
  return packages.filter(
    (pkg) => pkg.manifest.private !== true && !ignored.has(pkg.name),
  );
}

/** 可发布的 workspace 包 (预检核对面, 见 filterPublishable) */
function publishablePackages(): WorkspacePackage[] {
  return filterPublishable(
    listWorkspacePackages(REPO_ROOT),
    readIgnorePackages(),
  );
}

/** 从 git origin 派生 owner/repo; 读不到或非 GitHub 返回 null */
function originRepo(): string | null {
  const raw = readGitText(REPO_ROOT, ['remote', 'get-url', 'origin']);
  return raw === null ? null : deriveRepoFromRemoteUrl(raw);
}

/** 异常转人话 (网络类错误的 message 也过一遍降噪) */
function describeError(error: unknown): string {
  return error instanceof Error ? cleanText(error.message) : String(error);
}

/** 读 npm 换证失败的响应 message (取不到返回空串; 截长防刷屏) */
async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === 'string'
      ? cleanText(body.message).slice(0, 300)
      : '';
  } catch {
    return '';
  }
}

/**
 * 对单包试一次 OIDC 换证: 通过返回 null, 否则返回人话原因。
 * 换到的短期凭证只用于证明「登记对得上」, 随即丢弃: 不打印、不落盘、不传递 (发布链自己会再换一次)。
 */
async function tryExchange(pkgName: string): Promise<string | null> {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (requestUrl === undefined || requestToken === undefined) {
    return '缺少 OIDC 请求变量 (工作流需授予 id-token: write)';
  }
  let idToken: string;
  try {
    const url = new URL(requestUrl);
    url.searchParams.append('audience', OIDC_AUDIENCE);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${requestToken}` },
    });
    if (!response.ok) {
      return `获取 GitHub OIDC 令牌失败 (HTTP ${response.status})`;
    }
    const body = (await response.json()) as { value?: unknown };
    if (typeof body.value !== 'string' || body.value === '') {
      return 'GitHub OIDC 响应形状不符 (缺 value)';
    }
    idToken = body.value;
  } catch (error) {
    return `获取 GitHub OIDC 令牌失败 (${describeError(error)})`;
  }
  try {
    const response = await fetch(
      `${OFFICIAL_REGISTRY}-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(pkgName)}`,
      { method: 'POST', headers: { authorization: `Bearer ${idToken}` } },
    );
    if (response.ok) return null;
    const message = await readErrorMessage(response);
    return `换证被拒 (HTTP ${response.status}${message === '' ? '' : `: ${message}`})`;
  } catch (error) {
    return `请求 npm 换证端点失败 (${describeError(error)})`;
  }
}

/** 失配后的排查清单 (指向本地修复入口与文档) */
function printRemediation(repo: string | null): void {
  const repoText = repo === null ? '(读不到 git origin)' : repo;
  process.stderr.write(
    [
      '',
      '排查清单 (按可能性排序):',
      `  1. 仓库改名后 npm 侧登记未更新: 登记须与当前仓库 ${repoText} 一致, 改名不会自动跟改`,
      `  2. workflow 文件名不符: 登记应为 ${RELEASE_WORKFLOW}`,
      `  3. environment 名不符: 登记应为 ${RELEASE_ENVIRONMENT}`,
      '  4. 包尚未在 npm 配置 Trusted Publisher (或包不存在)',
      '',
      '修复: 在交互式终端跑 bun scripts/npm-trust-guard.ts fix (需 npm 登录态, 按提示在浏览器完成认证)',
      '背景: 见 docs/development.md 「发布」章节',
      '',
    ].join('\n'),
  );
}

/** CI 预检: 对每个可发布包试 OIDC 换证, 任一被拒即红灯 (改名后的第一次 CI 即被拦下并点名) */
async function mainVerifyOidc(): Promise<void> {
  const verdict = classifyOidcEnv(process.env);
  if (verdict === 'not-ci') {
    process.stdout.write(
      '非 GitHub Actions 环境, OIDC 预检不适用; 本地登记核对请用 npm-trust-guard.ts check\n',
    );
    return;
  }
  if (verdict === 'missing-permission') {
    process.stderr.write(
      'GitHub Actions 环境缺少 OIDC 请求变量: 该 job 需授予 id-token: write 权限\n',
    );
    process.exitCode = 1;
    return;
  }
  const failures: { packageName: string; reason: string }[] = [];
  for (const pkg of publishablePackages()) {
    const reason = await tryExchange(pkg.name);
    if (reason === null) {
      process.stdout.write(
        `✔ ${pkg.name}: OIDC 换证通过 (npm 侧登记与当前仓库匹配)\n`,
      );
    } else {
      failures.push({ packageName: pkg.name, reason });
    }
  }
  if (failures.length === 0) return;
  process.stderr.write(
    'npm Trusted Publisher 预检未通过 (发布会在 npm 认证处失败, 这里提前拦下):\n',
  );
  for (const failure of failures) {
    process.stderr.write(`  ✘ ${failure.packageName}: ${failure.reason}\n`);
  }
  printRemediation(originRepo());
  process.exitCode = 1;
}

/** 本地读单包登记: ok = 解析成功; error = npm 跑不起来 / 退出非零 / 输出形状不符 */
type TrustRead =
  { kind: 'ok'; entry: TrustEntry } | { kind: 'error'; detail: string };

/** 跑 `npm trust list` 读登记 (经 pty 包装, 见 runNpmCaptured) */
async function readTrustEntry(pkgName: string): Promise<TrustRead> {
  const result = await runNpmCaptured([
    'trust',
    'list',
    pkgName,
    `--registry=${OFFICIAL_REGISTRY}`,
  ]);
  if (result.error !== undefined) {
    return {
      kind: 'error',
      detail: `npm 跑不起来 (${describeError(result.error)})`,
    };
  }
  if (result.status !== 0) {
    return {
      kind: 'error',
      detail: `npm trust list 失败 (退出码 ${String(result.status)}); 若上方提示了网页认证, 请按提示完成后重试`,
    };
  }
  const entry = parseTrustListOutput(result.stdout);
  if (entry === null) {
    return {
      kind: 'error',
      detail: 'npm trust list 输出无法解析 (未见 repository 行)',
    };
  }
  return { kind: 'ok', entry };
}

/** 跑一条需要交互的 npm 命令 (经 pty, 认证提示与输入都透传), 返回是否成功 */
async function runNpmInteractive(args: string[]): Promise<boolean> {
  const result = await runNpmCaptured(args);
  if (result.error !== undefined) {
    process.stderr.write(
      `  ✘ npm ${args[0] ?? ''} 跑不起来 (${describeError(result.error)})\n`,
    );
    return false;
  }
  if (result.status !== 0) {
    process.stderr.write(
      `  ✘ npm ${args.slice(0, 2).join(' ')} 失败 (退出码 ${String(result.status)})\n`,
    );
    return false;
  }
  return true;
}

/**
 * 重建单包登记: 先 revoke 旧记录 (npm 侧一条包只支持一份登记, 不支持就地修改), 再按期望值创建。
 * 新登记取最小权限: 仅 publish (stage publish 未使用, 不勾)。
 */
async function repairPackage(
  pkgName: string,
  entry: TrustEntry,
  expected: TrustExpectation,
): Promise<boolean> {
  process.stdout.write(`  → 重建 ${pkgName} 的 Trusted Publisher 登记:\n`);
  // 两个动作都执行 (revoke 失败仍尝试 create), 结果取合
  const revoked =
    entry.id === null
      ? true
      : await runNpmInteractive([
          'trust',
          'revoke',
          pkgName,
          `--id=${entry.id}`,
          `--registry=${OFFICIAL_REGISTRY}`,
        ]);
  const created = await runNpmInteractive([
    'trust',
    'github',
    pkgName,
    '--file',
    expected.file,
    '--repo',
    expected.repository,
    '--env',
    expected.environment,
    '--allow-publish',
    `--registry=${OFFICIAL_REGISTRY}`,
  ]);
  return revoked && created;
}

/** 本地对账 (check) 与修复 (fix) 的主流程 */
async function mainLocal(command: 'check' | 'fix'): Promise<void> {
  // npm 的认证交互要求 TTY; 非交互环境 (管道 / 钩子) 里会卡在等待输入, 先在入口预警
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    process.stderr.write(
      '提示: 当前不是交互式终端; npm 的网页认证需要 TTY, 请在交互式终端重跑本命令\n',
    );
  }
  const repo = originRepo();
  if (repo === null) {
    process.stderr.write(
      '读不到 git origin 的 GitHub 坐标 (git remote get-url origin), 无法派生期望的 repository\n',
    );
    process.exitCode = 1;
    return;
  }
  const expected: TrustExpectation = {
    repository: repo,
    file: RELEASE_WORKFLOW,
    environment: RELEASE_ENVIRONMENT,
  };
  let failed = false;
  for (const pkg of publishablePackages()) {
    const read = await readTrustEntry(pkg.name);
    if (read.kind === 'error') {
      process.stderr.write(`✘ ${pkg.name}: ${read.detail}\n`);
      failed = true;
      continue;
    }
    const problems = diffTrust(read.entry, expected);
    if (problems.length === 0) {
      process.stdout.write(`✔ ${pkg.name}: npm 侧登记与当前仓库一致\n`);
      continue;
    }
    process.stderr.write(`✘ ${pkg.name}: npm 侧登记与当前仓库不一致:\n`);
    for (const problem of problems) process.stderr.write(`    ${problem}\n`);
    if (command === 'check') {
      failed = true;
      continue;
    }
    if (!(await repairPackage(pkg.name, read.entry, expected))) {
      failed = true;
    }
    const after = await readTrustEntry(pkg.name);
    if (after.kind === 'ok' && diffTrust(after.entry, expected).length === 0) {
      process.stdout.write(`  ✔ ${pkg.name}: 重建后复查通过\n`);
    } else {
      process.stderr.write(
        `  ✘ ${pkg.name}: 重建后复查未通过, 请人工检查 npm 侧配置\n`,
      );
      failed = true;
    }
  }
  if (!failed) return;
  if (command === 'check') {
    process.stderr.write(
      '\n修复: 在交互式终端跑 bun scripts/npm-trust-guard.ts fix (需 npm 登录态)\n',
    );
  }
  process.exitCode = 1;
}

/** 用法说明 */
function printUsage(): void {
  process.stderr.write(
    [
      '发布凭据闸门: 核对 npm 侧 Trusted Publisher 登记与当前仓库形态是否一致',
      '',
      '用法: bun scripts/npm-trust-guard.ts <命令>',
      '  verify-oidc  CI 预检: 用 GitHub OIDC 对每包试一次 token exchange (需 id-token: write)',
      '  check        本地对账: npm trust list 与期望值比对, 只读',
      '  fix          本地修复: 对失配项 revoke + 重建 (需 npm 登录态与交互式终端)',
      '',
    ].join('\n'),
  );
}

/** 入口: 分发子命令 (未知命令打用法并退 2) */
async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'verify-oidc') {
    await mainVerifyOidc();
    return;
  }
  if (command === 'check' || command === 'fix') {
    await mainLocal(command);
    return;
  }
  printUsage();
  process.exitCode = 2;
}

// 仅作为入口执行时跑主流程 (被 import 时不执行, 供测试)
if (import.meta.main) await main();
