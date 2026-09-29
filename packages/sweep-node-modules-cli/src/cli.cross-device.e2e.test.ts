/**
 * cli 端到端契约 (设备边界面): 目标落在根之下的另一文件系统 (挂载点) 时的默认跳过、--force 不放行
 * 与解除路径 (把挂载点声明为独立根)。
 * 现场用 macOS 的 hdiutil 建小磁盘映像挂进 fixture 根 —— 这是测试里造出「另一文件系统」的唯一手段
 * (st_dev 由内核给出, 造不了假); 非 macOS / 无 hdiutil 的宿主整组跳过, 登记见
 * docs/protocol/conformance/coverage.md「未覆盖条款」。
 * 两道环境门 (任一道不过即整组跳过并播报原因, 不制造假 FAIL): 平台门 (MOUNTABLE, 命令在不在) 与
 * 注册期的真实挂载探针 (probeMountCapability, 映像真挂得起来吗); 用例内的挂载一线
 * (attachImage / attachImageCopy) 与卸载侧对称带重试。
 * 与 cli.e2e.test.ts / cli.anchor.e2e.test.ts 同款双载体参数化。
 * 设计: docs/designs/deletion-guard.md「设备边界」; 契约: docs/protocol/behavior-contract.md BC-41 / OF-15。
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type Workspace,
  type WorkspaceSpec,
  makeWorkspace,
} from '@iyowei/sweep-node-modules/testing';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const RUNNERS = ['bun', 'node'];

/** 造挂载点的第一道门 (命令在不在): macOS 的 hdiutil 可用 (Linux 挂载需 root, 不在此列) */
const MOUNTABLE =
  process.platform === 'darwin' &&
  spawnSync('hdiutil', ['info'], { stdio: 'ignore', timeout: 10_000 })
    .status === 0;

const workspaces: Workspace[] = [];
/** 本用例已挂载的挂载点, 收尾时逐个卸载 */
const mounted: string[] = [];
/** afterEach 重试后仍未卸载的挂载点, afterAll 再给一次机会 */
const stuckMounts: string[] = [];
/** 本组用例用过的临时目录 (映像与副本), 收尾时整目录回收 */
const tempDirs: string[] = [];
/** 因环境不可用而跳过的用例 (断言未验证), 收尾时汇总播报, 不让跳过静默成假绿 */
const envSkips: string[] = [];

/** 卸载重试上限与退避基数 (毫秒): 卷被索引进程一类瞬态占用时, 首次 detach 会失败 */
const DETACH_ATTEMPTS = 3;
const DETACH_RETRY_DELAY_MS = 200;

/** 挂载重试上限与退避基数 (毫秒): attach 比 detach 慢一截 (要先加载映像), 退避基数取更大一份,
 * 且挂载失败即整条用例失去现场, 容错预算比卸载侧给得更宽 */
const ATTACH_ATTEMPTS = 3;
const ATTACH_RETRY_DELAY_MS = 500;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * 卸载挂载点 (失败重试至多 DETACH_ATTEMPTS 次): 选项必须前置 (hdiutil 走 getopt: 选项放在
 * 挂载点之后会被当成多余参数丢掉, 非强制卸载就可能在卷仍被占用时失败并留下残留挂载)。
 * 返回是否已卸载; 失败交调用方降级 (警告并继续清理其余现场, 不抛断), 卸载不掉时挂载点由
 * 调用方登记, 留到 afterAll 再试。
 */
async function detachWithRetry(point: string): Promise<boolean> {
  for (let attempt = 0; attempt < DETACH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(DETACH_RETRY_DELAY_MS * attempt);
    const detach = spawnSync('hdiutil', ['detach', '-force', '-quiet', point], {
      stdio: 'ignore',
      timeout: 20_000,
    });
    if (detach.status === 0) return true;
  }
  return false;
}

async function make(spec: WorkspaceSpec): Promise<Workspace> {
  const workspace = await makeWorkspace(spec);
  workspaces.push(workspace);
  return workspace;
}

afterEach(async () => {
  // 卸载必须先于 fixture 清理: 挂载点未卸载时 rm 会穿透到挂载卷内, 且挂载点自身删不掉 (EBUSY)。
  // 卸载失败重试后降级为警告并继续: 绝不抛断本钩子, 否则其后的数组复位不执行, 现场跨用例累积。
  for (const point of mounted.splice(0)) {
    if (await detachWithRetry(point)) continue;
    stuckMounts.push(point);
    process.stderr.write(
      `[Warning] 磁盘映像卸载失败 (已重试 ${DETACH_ATTEMPTS} 次), 请人工卸载: ${point}\n`,
    );
  }
  try {
    await Promise.all(workspaces.map((workspace) => workspace.cleanup()));
  } finally {
    // 单个工作区清理失败已由 cleanup 内部降级为警告; 此处兜底复位, 防跨用例重复清理同一现场
    workspaces.length = 0;
  }
});

afterAll(async () => {
  // afterEach 未卸载掉的挂载点再试一次: 瞬态占用 (索引 / 进程退出) 过后多半可卸
  for (const point of stuckMounts.splice(0)) {
    if (!(await detachWithRetry(point))) {
      process.stderr.write(
        `[Warning] 仍有磁盘映像挂载未卸载, 请人工处理: ${point}\n`,
      );
    }
  }
  for (const dir of [imageDir, ...tempDirs]) {
    if (dir === null) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      // 卷仍挂载时删映像文件会 EBUSY: 降级为警告, 不抛断其余目录的清理
      const code = (error as { code?: string } | null)?.code ?? String(error);
      process.stderr.write(
        `[Warning] 临时映像目录清理失败 (${code}), 请人工清理: ${dir}\n`,
      );
    }
  }
  // 跳过的用例断言未验证, 汇总播报 (只在真发生跳过时出), 不让它在绿字里静默
  if (envSkips.length > 0) {
    process.stderr.write(
      `[Warning] 设备边界面 ${envSkips.length} 条用例因环境跳过 (断言未验证): ${envSkips.join('; ')}\n`,
    );
  }
});

/** 跑一次 CLI: 清宿主 SWEEP_NM_CONFIG, 固定 NO_COLOR (断言面为降级纯文本) */
function runCli(runner: string, args: string[]) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NO_COLOR: '1',
  };
  delete env.SWEEP_NM_CONFIG;
  return spawnSync(runner, [CLI, ...args], {
    encoding: 'utf8',
    env,
    timeout: 10_000,
  });
}

/** 写配置 (exclude 显式写空数组 = 用户接管, 内置默认名单不参与) */
function writeConfig(workspace: Workspace, roots: string[]): string {
  const file = join(workspace.root, 'sweep-config.json');
  writeFileSync(file, JSON.stringify({ roots, exclude: [], include: [] }));
  return file;
}

/** 映像文件全程只建一次 (create 约 1s, 是本组用例的主要成本), 逐用例现挂现卸 */
let imageDir: string | null = null;

function ensureImage(): string | null {
  if (imageDir !== null) return join(imageDir, 'vol.dmg');
  const dir = mkdtempSync(join(tmpdir(), 'sweep-lab-dev-'));
  const image = join(dir, 'vol.dmg');
  const created = spawnSync(
    'hdiutil',
    [
      'create',
      '-size',
      '8m',
      '-fs',
      'HFS+',
      '-volname',
      'SWEEPNMDEV',
      '-quiet',
      image,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  if (created.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  imageDir = dir;
  tempDirs.push(dir);
  return image;
}

/**
 * 挂载映像到挂载点 (失败重试至多 ATTACH_ATTEMPTS 次, 退避随轮次线性拉长): 与卸载侧对称的重试,
 * 只包 hdiutil 这一原子步骤 —— 断言与用例体都不进重试面, 真实逻辑错误不会被退避掩盖。
 * 选项必须前置的理由同 detachWithRetry (hdiutil 走 getopt)。
 * @returns 是否挂上 (挂上即登记待卸)
 */
async function attachWithRetry(image: string, point: string): Promise<boolean> {
  for (let attempt = 0; attempt < ATTACH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(ATTACH_RETRY_DELAY_MS * attempt);
    const attach = spawnSync(
      'hdiutil',
      [
        'attach',
        image,
        '-nobrowse',
        '-noverify',
        '-mountpoint',
        point,
        '-quiet',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    if (attach.status === 0) return true;
  }
  return false;
}

/** 挂载一线的末次失败说明 (空串 = 未失败): 按环境跳过的用例拿它当播报原因 */
let attachFailure = '';

/** 8 MiB 稀疏映像挂到 point; 成败作环境事实报给调用方 (没挂上就没登记, 现场无残留) */
async function attachImage(point: string): Promise<boolean> {
  const image = ensureImage();
  if (image === null) {
    attachFailure = '磁盘映像创建失败 (hdiutil create)';
    return false;
  }
  if (!(await attachWithRetry(image, point))) {
    attachFailure = `磁盘映像挂载失败 (hdiutil attach 已重试 ${ATTACH_ATTEMPTS} 次): ${point}`;
    return false;
  }
  mounted.push(point);
  return true;
}

/** 复制映像再挂一份 (同一映像不能同时挂两次), 供「目标本体即挂载点」形态用 */
async function attachImageCopy(point: string): Promise<boolean> {
  const image = ensureImage();
  if (image === null) {
    attachFailure = '磁盘映像创建失败 (hdiutil create)';
    return false;
  }
  const dir = mkdtempSync(join(tmpdir(), 'sweep-lab-dev-copy-'));
  const copy = join(dir, 'vol.dmg');
  copyFileSync(image, copy);
  tempDirs.push(dir);
  if (!(await attachWithRetry(copy, point))) {
    attachFailure = `磁盘映像副本挂载失败 (hdiutil attach 已重试 ${ATTACH_ATTEMPTS} 次): ${point}`;
    return false;
  }
  mounted.push(point);
  return true;
}

/**
 * 注册期挂载能力探针 (第二道门): `hdiutil info` 只证明命令在, 不证明映像真挂得起来, 而这两类
 * 失败在用例里完全同形 (挂载一线拿不到现场)。
 * 故按用例同路径真挂一次 (共享映像与副本各一) 再卸掉: 挂不上即整组按环境门控跳过并播报原因
 * (与非 macOS 门控同一形态), 不让环境瞬态演成一串假 FAIL。
 * 探针现场在探针内清干净: 卸不掉的点登记给 afterAll 再试, 不留在 mounted 里让 afterEach 空转。
 * @returns 失败原因 (空串 = 能力具备)
 */
async function probeMountCapability(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'sweep-lab-dev-probe-'));
  tempDirs.push(root);
  const first = join(root, 'vol');
  const second = join(root, 'onnm');
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  await attachImage(first);
  await attachImageCopy(second);
  let failure = attachFailure;
  for (const point of mounted.splice(0)) {
    if (await detachWithRetry(point)) continue;
    stuckMounts.push(point);
    if (failure === '') failure = `探针挂载的映像卸载失败: ${point}`;
  }
  // 卸净后才删探针目录: 卷还挂着时 rm 会穿透进卷内, 且挂载点自身删不掉 (EBUSY)
  if (failure === '') rmSync(root, { recursive: true, force: true });
  return failure;
}

/**
 * 环境跳过: 挂载一线耗尽重试即环境不可用 (挂不上映像是宿主级动作失败, 与用例要验的删除语义无关),
 * 按环境跳过并播报原因, 不制造假 FAIL。bun:test 的 skip 只能在注册期声明, 运行期以「播报 + 早退
 * 不跑用例体」等价落地; 真实逻辑错误走断言抛出, 与本路径不相干 (重试只包挂载原子步骤)。
 */
function skipCaseOnEnvironment(name: string, reason: string): void {
  envSkips.push(`${name}: ${reason}`);
  process.stderr.write(`[Skip] ${name} 因环境跳过: ${reason}\n`);
}

/**
 * 造现场: fixture 根内给一个普通项目 (宿主卷) 与两种跨设备形态 ——
 * <root>/vol 是挂在根之下的另一文件系统 (目标在其下, 入口在根与目标之间);
 * <root>/onnm/node_modules 这一条自身就是挂载点 (目标本体即挂载点)。
 * 两卷内各放一个无关文件 (证明删除只动了目标、没动卷内其余内容)。
 * @returns 现场; 挂载一线耗尽重试时返回 null (环境不可用), 由调用方按环境跳过
 */
async function makeSplitWorkspace(): Promise<{
  workspace: Workspace;
  vol: string;
} | null> {
  const workspace = await make({ projects: [{ dir: 'plain' }] });
  const vol = join(workspace.root, 'vol');
  const onnm = join(workspace.root, 'onnm', 'node_modules');
  mkdirSync(vol, { recursive: true });
  mkdirSync(onnm, { recursive: true });
  if (!(await attachImage(vol)) || !(await attachImageCopy(onnm))) return null;
  mkdirSync(join(vol, 'proj', 'node_modules'), { recursive: true });
  writeFileSync(join(vol, 'proj', 'node_modules', 'b.js'), 'yyyy');
  writeFileSync(join(vol, 'other.txt'), 'zzzz');
  writeFileSync(join(onnm, 'host.js'), 'hhhh');
  return { workspace, vol };
}

/** 设备边界面用例组, 逐 runner 注册 */
function defineCrossDeviceCases(runner: string, available: boolean): void {
  describe(`cli e2e [${runner}] 设备边界面`, () => {
    test.skipIf(!available || !MOUNT_READY)(
      '两种跨设备形态: 预览各按形态标注, --yes --force 仍跳过 (卷内内容逐字完好, 根内其余目标照常删除)',
      async () => {
        const split = await makeSplitWorkspace();
        if (split === null) {
          skipCaseOnEnvironment('两种跨设备形态', attachFailure);
          return;
        }
        const { workspace, vol } = split;
        const onnm = join(workspace.root, 'onnm', 'node_modules');
        const config = writeConfig(workspace, [workspace.root]);

        const preview = runCli(runner, ['--config', config]);
        expect(preview.status).toBe(0);
        expect(preview.stdout).toContain('跨设备: 根与目标之间有挂载点');
        expect(preview.stdout).toContain('跨设备: 目标本体即挂载点');
        expect(preview.stdout).toContain(
          '跨设备目标 1 处默认跳过 (把根与目标之间的挂载点声明为独立根即可清理)',
        );
        expect(preview.stdout).toContain(
          '跨设备目标 1 处默认跳过 (目标本体即挂载点, 需先卸载该卷)',
        );

        // --force 只放行疑似安装树, 不放行跨设备: 两条仍不进删除批
        const execute = runCli(runner, [
          '--yes',
          '--force',
          '--config',
          config,
        ]);
        expect(execute.status).toBe(1);
        expect(execute.stdout).toContain(
          '已跳过 (把该挂载点声明为独立根即可清理)',
        );
        expect(execute.stdout).toContain(
          '已跳过 (挂载点无法删除, 需先卸载该卷)',
        );
        expect(existsSync(join(workspace.root, 'plain', 'node_modules'))).toBe(
          false,
        );
        expect(existsSync(join(vol, 'proj', 'node_modules', 'b.js'))).toBe(
          true,
        );
        expect(existsSync(join(vol, 'other.txt'))).toBe(true);
        expect(existsSync(join(onnm, 'host.js'))).toBe(true);
      },
    );

    test.skipIf(!available || !MOUNT_READY)(
      '入口形态声明为独立根后照常删除; 目标本体为挂载点的仍跳过 (两条解除路径各按事实)',
      async () => {
        const split = await makeSplitWorkspace();
        if (split === null) {
          skipCaseOnEnvironment('声明独立根解除路径', attachFailure);
          return;
        }
        const { workspace, vol } = split;
        const onnm = join(workspace.root, 'onnm', 'node_modules');
        // 第二个根就是那个挂载点: 其下目标归属它, 设备比对以它的设备为参照
        const config = writeConfig(workspace, [workspace.root, vol]);

        const execute = runCli(runner, ['--yes', '--config', config]);

        // 入口形态已放行 → 删除成功; 目标本体是挂载点的那条与根声明无关, 仍为跳过
        expect(execute.status).toBe(1);
        expect(execute.stdout).toContain(
          '已跳过 (挂载点无法删除, 需先卸载该卷)',
        );
        expect(execute.stdout).toContain('跨设备: 目标本体即挂载点');
        expect(execute.stdout).not.toContain('根与目标之间有挂载点');
        expect(existsSync(join(vol, 'proj', 'node_modules'))).toBe(false);
        expect(existsSync(join(vol, 'other.txt'))).toBe(true);
        expect(existsSync(join(onnm, 'host.js'))).toBe(true);
      },
    );
  });
}

// 注册期门控的第二道门 (见 probeMountCapability): 挂不上映像即整组按环境跳过, 失败原因播报一次
const probeFailure = MOUNTABLE ? await probeMountCapability() : '';
if (probeFailure !== '') {
  process.stderr.write(
    `[Skip] 设备边界面整组跳过 (执行机挂不上磁盘映像): ${probeFailure}\n`,
  );
}
const MOUNT_READY = MOUNTABLE && probeFailure === '';

for (const runner of RUNNERS) {
  const available = spawnSync(runner, ['-v'], { timeout: 10_000 }).status === 0;
  defineCrossDeviceCases(runner, available);
}
