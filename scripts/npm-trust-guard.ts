/**
 * 发布凭据闸门: 核对 npm 侧 Trusted Publisher 登记与当前仓库形态是否一致。
 * 触发方: Release job (`bun scripts/ci.ts --only npm-trust`) 或本地运维 (`check` / `fix`)。
 *
 * 动机: 2026-09-30 仓库改名 iyowei/clis 后, npm 侧既有包的登记 (repository 字段) 仍指旧仓库名,
 * 发布链在 release job 以误导性的 ENONPMTOKEN 挂掉 (OIDC 换证被拒后回落到 token 检查)。
 * 本闸门分两个场景前置告警:
 *
 * - CI (`verify-oidc`): 用 GitHub OIDC 对仓内每个可发布包 (非 private) 试一次 token exchange,
 *   走发布链同一 OIDC 通道, 零密钥校验 repository / workflow file / environment 三字段匹配;
 * - 本地 (`check` / `fix`): 经 `script` pty 包装调用 `npm trust list` 对账 (满足 npm 网页认证
 *   对 stdin/stdout 双 TTY 的要求); `fix` 对失配项执行 revoke + 重建并复查。
 *
 * 期望值: repository 从 git origin 派生; workflow 文件名与环境名取下方常量 (与 release.yml 同步)。
 *
 * 用法:
 *   bun scripts/npm-trust-guard.ts verify-oidc   # CI: OIDC 换证预检 (需 id-token: write)
 *   bun scripts/npm-trust-guard.ts check         # 本地: 只读对账
 *   bun scripts/npm-trust-guard.ts fix           # 本地: 对账并修复 (revoke + 重建)
 * 退出码: 0 通过 (或环境不适用); 1 失配或失败; 2 参数非法。
 */
import { spawn } from 'node:child_process';

import {
  type OidcEnvVerdict,
  type TrustEntry,
  type TrustExpectation,
  classifyOidcEnv,
  cleanText,
  deriveRepoFromRemoteUrl,
  diffTrust,
  filterPublishable,
  isValidTrustId,
  parseTrustListEntries,
  parseTrustListOutput,
  ptyWrapArgs,
  stripCsi,
  stripPtyNoise,
} from './lib/npm-trust-parse.ts';
import { readGitText } from './lib/release-verify.ts';
import {
  type WorkspacePackage,
  listWorkspacePackages,
} from './lib/workspace.ts';
import { REPO_ROOT } from './lint-doc-shared.ts';

export {
  type OidcEnvVerdict,
  type TrustEntry,
  type TrustExpectation,
  classifyOidcEnv,
  deriveRepoFromRemoteUrl,
  diffTrust,
  filterPublishable,
  isValidTrustId,
  parseTrustListEntries,
  parseTrustListOutput,
  ptyWrapArgs,
};

/** npm 官方 registry (OIDC 换证与 trust 管理端点只存在于官方源, 镜像源没有) */
const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/';

/** 发布 workflow 文件名: 常量单点, 与 `.github/workflows/release.yml` 同步 */
const RELEASE_WORKFLOW = 'release.yml';

/** 发布环境名: 常量单点, 与 release.yml 的 `environment: release` 同步 */
const RELEASE_ENVIRONMENT = 'release';

/** OIDC 令牌 audience: npm 约定值, 与发布链 @semantic-release/npm 的换证请求一致 */
const OIDC_AUDIENCE = 'npm:registry.npmjs.org';

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
      shell: process.platform === 'win32',
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

/** 可发布的 workspace 包 (预检核对面, 见 filterPublishable) */
function publishablePackages(): WorkspacePackage[] {
  return filterPublishable(listWorkspacePackages(REPO_ROOT));
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

/**
 * CI 预检: 对每个可发布包试 OIDC 换证, 任一被拒即红灯 (改名后的第一次 CI 即被拦下并点名)。
 *
 * ### 数据流转示例
 * ```text
 * Input:  process.env (GITHUB_ACTIONS / ACTIONS_ID_TOKEN_REQUEST_*) + workspace 非 private 包清单
 * 步骤 1: classifyOidcEnv -> not-ci 跳过 (0), missing-permission 报错 (1), ready 继续
 * 步骤 2: 逐包 tryExchange: 向 GitHub 换 idToken -> POST npm OIDC exchange 端点 (成功即丢弃短期凭据)
 * 步骤 3: 汇总 failures; 非空时打印排查清单并置 process.exitCode = 1
 * Output: 0 (全通过或非 CI) / 1 (权限缺失或任一包换证被拒)
 * ```
 */
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

/** 本地读单包登记: ok = 解析成功; not-found = 尚未登记; error = 执行失败或输出异常 */
type TrustRead =
  | { kind: 'ok'; entry: TrustEntry }
  | { kind: 'not-found' }
  | { kind: 'error'; detail: string };

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
    const plain = stripPtyNoise(stripCsi(result.stdout));
    if (
      /no trusted publish/i.test(plain) ||
      plain.trim() === '' ||
      !/npm error/i.test(plain)
    ) {
      return { kind: 'not-found' };
    }
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

/** 创建单包 Trusted Publisher 登记 (最小权限: 仅 --allow-publish) */
async function createTrustEntry(
  pkgName: string,
  expected: TrustExpectation,
): Promise<boolean> {
  return runNpmInteractive([
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
}

/**
 * 重建或新建单包登记: 已有旧记录时先 revoke (ID 须通过白名单校验), 再按期望值创建。
 * 首次登记 (entry === null) 时直接创建。
 */
async function repairPackage(
  pkgName: string,
  entry: TrustEntry | null,
  expected: TrustExpectation,
): Promise<boolean> {
  const verb = entry === null ? '新建' : '重建';
  process.stdout.write(`  → ${verb} ${pkgName} 的 Trusted Publisher 登记:\n`);
  let revoked = true;
  if (entry !== null && entry.id !== null) {
    if (!isValidTrustId(entry.id)) {
      process.stderr.write(
        `  ✘ 拒绝 revoke: 登记 ID 含非法字符 (${cleanText(entry.id)})\n`,
      );
      return false;
    }
    revoked = await runNpmInteractive([
      'trust',
      'revoke',
      pkgName,
      `--id=${entry.id}`,
      `--registry=${OFFICIAL_REGISTRY}`,
    ]);
  }
  const created = await createTrustEntry(pkgName, expected);
  return revoked && created;
}

/** 执行单包修复并复查是否与期望一致, 返回是否最终通过 */
async function applyRepairAndVerify(
  pkgName: string,
  entry: TrustEntry | null,
  expected: TrustExpectation,
  label: string,
): Promise<boolean> {
  const repaired = await repairPackage(pkgName, entry, expected);
  const after = await readTrustEntry(pkgName);
  const verified =
    after.kind === 'ok' && diffTrust(after.entry, expected).length === 0;
  if (verified) {
    process.stdout.write(`  ✔ ${pkgName}: ${label}复查通过\n`);
    return repaired;
  }
  process.stderr.write(
    `  ✘ ${pkgName}: ${label}复查未通过, 请人工检查 npm 侧配置\n`,
  );
  return false;
}

/**
 * 本地对账 (check) 与修复 (fix) 的主流程。
 *
 * ### 数据流转示例
 * ```text
 * Input:  command = 'check' | 'fix', git origin URL -> expected = { repository, file, environment }
 * 步骤 1: 遍历 workspace 非 private 包, 经 pty 跑 `npm trust list` 解析现网登记 (ok / not-found / error)
 * 步骤 2: diffTrust 对比三字段; 全一致打 ✔, 缺失或失配按 command 分流:
 *         - check: 标记 failed 并输出差异
 *         - fix:   applyRepairAndVerify (白名单校验 ID -> revoke 旧项 -> create 新项 -> 重读复查)
 * Output: 0 (全部一致或修复复查通过) / 1 (存在失配或修复未通过)
 * ```
 */
async function mainLocal(command: 'check' | 'fix'): Promise<void> {
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
    if (read.kind === 'not-found') {
      process.stderr.write(`✘ ${pkg.name}: npm 侧尚未配置 Trusted Publisher\n`);
      if (
        command === 'check' ||
        !(await applyRepairAndVerify(pkg.name, null, expected, '首次登记'))
      ) {
        failed = true;
      }
      continue;
    }
    const problems = diffTrust(read.entry, expected);
    if (problems.length === 0) {
      process.stdout.write(`✔ ${pkg.name}: npm 侧登记与当前仓库一致\n`);
      continue;
    }
    process.stderr.write(`✘ ${pkg.name}: npm 侧登记与当前仓库不一致:\n`);
    for (const problem of problems) process.stderr.write(`    ${problem}\n`);
    if (
      command === 'check' ||
      !(await applyRepairAndVerify(pkg.name, read.entry, expected, '重建后'))
    ) {
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

/** 入口: 分发子命令 (未知命令打用法并退 2) */
async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'verify-oidc') return mainVerifyOidc();
  if (command === 'check' || command === 'fix') return mainLocal(command);
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
  process.exitCode = 2;
}

// 仅作为入口执行时跑主流程 (被 import 时不执行, 供测试)
if (import.meta.main) await main();
