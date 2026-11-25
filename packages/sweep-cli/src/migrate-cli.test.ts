/**
 * 配置迁移 CLI 编排 (`runMigrationFlow`) 单测:
 * 覆盖 TTY 确认与取消流程、非 TTY 自动无损迁移与非无损中止、显式 `sweep migrate`
 * 无旧配置 / 已是 v2 / 显式路径不存在分支, 以及写前备份落地与零原始 JSON 红线。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  type ResolvedConfigPath,
  resolveConfigPath,
  resolveLegacyConfigPath,
} from '@iyowei/sweep';

import type { InitIO } from './init-io.ts';
import { runMigrationFlow } from './migrate-cli.ts';

const tempDirs: string[] = [];

const realpathNative = realpathSync.native ?? realpathSync;

/** 临时沙箱 (取 realpath.native 归一形态: 绕过 macOS /var 软链并展开 Windows 8.3 短路径) */
function makeSandbox(): string {
  const dir = realpathNative(mkdtempSync(join(tmpdir(), 'sweep-migrate-cli-')));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function makeStubIO(confirmAnswer: boolean) {
  const prints: string[] = [];
  const confirms: { question: string; defaultYes: boolean }[] = [];
  let closed = 0;
  const createIO = (color: boolean): InitIO => ({
    color,
    async ask() {
      throw new Error('migrate-cli 不应调用 ask');
    },
    async confirm(question, defaultYes) {
      confirms.push({ question, defaultYes });
      return confirmAnswer;
    },
    print(line) {
      prints.push(line);
    },
    close() {
      closed += 1;
    },
  });
  return { createIO, prints, confirms, getClosed: () => closed };
}

function makeCollectors() {
  const prints: string[] = [];
  const warns: string[] = [];
  const notices: string[] = [];
  return {
    prints,
    warns,
    notices,
    print: (line: string) => prints.push(line),
    warn: (line: string) => warns.push(line),
    notice: (line: string) => notices.push(line),
  };
}

const FIXED_DATE = new Date(2026, 10, 20, 18, 30, 45);

describe('runMigrationFlow · TTY 确认与取消流程', () => {
  test('旧路径 v1 + TTY 确认: 展示来源/目标/备份/等价承诺 → 备份落地 + 结构化摘要 (零原始 JSON)', async () => {
    const home = makeSandbox();
    const env =
      process.platform === 'win32'
        ? { APPDATA: join(home, 'AppData', 'Roaming') }
        : {};
    const resolved = resolveConfigPath({
      homedir: home,
      env,
    });
    const legacy = resolveLegacyConfigPath({
      homedir: home,
      env,
    });
    const v1Text = `${JSON.stringify({ roots: [home], exclude: ['vendor'] }, null, 2)}\n`;
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, v1Text);

    const ioStub = makeStubIO(true);
    const col = makeCollectors();

    const result = await runMigrationFlow({
      resolved,
      explicit: false,
      interactive: true,
      colors: { stdout: false, stderr: false },
      home,
      env,
      ...col,
      createIO: ioStub.createIO,
      now: () => FIXED_DATE,
    });

    const expectedBackup = join(
      dirname(legacy),
      'config.json.20261120_183045.modified',
    );
    expect(result.state).toBe('migrated');
    if (result.state === 'migrated') {
      expect(result.backupPath).toBe(expectedBackup);
      expect(result.excludeExplicit).toBe(true);
      expect(Object.keys(result.config.presets)).toEqual(['node']);
    }

    expect(existsSync(expectedBackup)).toBe(true);
    expect(readFileSync(expectedBackup, 'utf8')).toBe(v1Text);
    expect(existsSync(resolved.path)).toBe(true);

    const saved = JSON.parse(readFileSync(resolved.path, 'utf8')) as {
      version: number;
      presets: Record<string, unknown>;
    };
    expect(saved.version).toBe(2);
    expect(Object.keys(saved.presets)).toEqual(['node']);

    const output = ioStub.prints.join('\n');
    expect(output).toContain('▍ SWEEP  配置迁移');
    expect(output).toContain('迁移来源:');
    expect(output).toContain('目标路径:');
    expect(output).toContain('config.json.YYYYMMDD_HHMMSS.modified');
    expect(output).toContain('仅启用 node 预设');
    expect(output).toContain('配置已迁移:');
    expect(output).toContain('原配置已备份:');
    expect(output).toContain('新增可用预设:');
    expect(output).toContain('快捷指令:');
    let expectedEditorCmd = '${EDITOR:-vi}';
    if (process.platform === 'darwin') expectedEditorCmd = 'open -e';
    else if (process.platform === 'win32') expectedEditorCmd = 'notepad';
    expect(output).toContain(expectedEditorCmd);
    expect(output).not.toContain('"version":');
    expect(output).not.toContain('"presets":');
    expect(ioStub.confirms).toEqual([
      { question: '确认执行配置迁移?', defaultYes: true },
    ]);
    expect(ioStub.getClosed()).toBe(1);
  });

  test('TTY 取消: 原文件不动、不生成备份、不写目标路径、返回 cancelled', async () => {
    const home = makeSandbox();
    const env =
      process.platform === 'win32'
        ? { APPDATA: join(home, 'AppData', 'Roaming') }
        : {};
    const resolved = resolveConfigPath({
      homedir: home,
      env,
    });
    const legacy = resolveLegacyConfigPath({
      homedir: home,
      env,
    });
    const v1Text = `${JSON.stringify({ roots: [home] })}\n`;
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, v1Text);

    const ioStub = makeStubIO(false);
    const col = makeCollectors();

    const result = await runMigrationFlow({
      resolved,
      explicit: true,
      interactive: true,
      colors: { stdout: false, stderr: false },
      home,
      env,
      ...col,
      createIO: ioStub.createIO,
      now: () => FIXED_DATE,
    });

    expect(result).toEqual({ state: 'cancelled' });
    expect(ioStub.prints).toContain('已取消, 未迁移配置');
    expect(existsSync(resolved.path)).toBe(false);
    expect(readFileSync(legacy, 'utf8')).toBe(v1Text);
    expect(
      readdirSync(dirname(legacy)).filter((n) => n.endsWith('.modified')),
    ).toHaveLength(0);
    expect(ioStub.getClosed()).toBe(1);
  });
});

describe('runMigrationFlow · 非 TTY 自动无损迁移与非无损中止', () => {
  test('隐式主流程非 TTY: 无损自动迁移, 备份落地、仅激活 node、stderr 输出 [info] 日志', async () => {
    const home = makeSandbox();
    const cfg = join(home, 'config.json');
    const v1Text = `${JSON.stringify({ roots: [home] })}\n`;
    writeFileSync(cfg, v1Text);

    const resolved: ResolvedConfigPath = { path: cfg, source: 'flag' };
    const col = makeCollectors();

    const result = await runMigrationFlow({
      resolved,
      explicit: false,
      interactive: false,
      colors: { stdout: false, stderr: false },
      home,
      platform: 'linux',
      ...col,
      now: () => FIXED_DATE,
    });

    expect(result.state).toBe('migrated');
    if (result.state === 'migrated') {
      expect(Object.keys(result.config.presets)).toEqual(['node']);
      expect(result.excludeExplicit).toBe(false);
      expect(existsSync(result.backupPath)).toBe(true);
      expect(readFileSync(result.backupPath, 'utf8')).toBe(v1Text);
    }
    expect(col.prints).toEqual([]);
    expect(col.warns).toEqual([]);
    expect(col.notices).toHaveLength(2);
    expect(col.notices[0]).toContain('[info] 已自动无损迁移配置到 v2');
    expect(col.notices[1]).toContain('[info] 新增可用预设:');
  });

  test('非无损旧配置 (含未知字段 / version: 3): 中止返 error 且不改原文件不生备份', async () => {
    for (const badPayload of [
      { roots: ['/tmp'], legacyExtra: 123 },
      { version: 3, roots: ['/tmp'], presets: { node: {} } },
    ]) {
      const dir = makeSandbox();
      const cfg = join(dir, 'config.json');
      const raw = `${JSON.stringify(badPayload)}\n`;
      writeFileSync(cfg, raw);

      const col = makeCollectors();
      const result = await runMigrationFlow({
        resolved: { path: cfg, source: 'flag' },
        explicit: false,
        interactive: false,
        colors: { stdout: false, stderr: false },
        home: dir,
        platform: 'linux',
        ...col,
      });

      expect(result).toEqual({ state: 'error' });
      expect(col.warns.join('\n')).toContain('配置无法自动迁移');
      expect(readFileSync(cfg, 'utf8')).toBe(raw);
      expect(
        readdirSync(dir).filter((n) => n.endsWith('.modified')),
      ).toHaveLength(0);
    }
  });
});

describe('runMigrationFlow · 显式 `sweep migrate` 的 none / 幂等 / 错误分支', () => {
  test('无旧配置 (platform-default): 提示无需迁移并返 none', async () => {
    const home = makeSandbox();
    const env =
      process.platform === 'win32'
        ? { APPDATA: join(home, 'AppData', 'Roaming') }
        : {};
    const resolved = resolveConfigPath({
      homedir: home,
      env,
    });
    const col = makeCollectors();

    const result = await runMigrationFlow({
      resolved,
      explicit: true,
      interactive: false,
      colors: { stdout: false, stderr: false },
      home,
      env,
      ...col,
    });

    expect(result).toEqual({ state: 'none' });
    expect(col.prints.join('\n')).toContain('未发现旧版配置, 无需迁移');
    expect(col.warns).toEqual([]);
  });

  test('已是 v2 配置: 提示已是最新版无需迁移并返 none', async () => {
    const dir = makeSandbox();
    const cfg = join(dir, 'config.json');
    writeFileSync(
      cfg,
      JSON.stringify({ version: 2, roots: [dir], presets: { node: {} } }),
    );
    const col = makeCollectors();

    const result = await runMigrationFlow({
      resolved: { path: cfg, source: 'flag' },
      explicit: true,
      interactive: false,
      colors: { stdout: false, stderr: false },
      home: dir,
      platform: 'linux',
      ...col,
    });

    expect(result).toEqual({ state: 'none' });
    expect(col.prints.join('\n')).toContain('当前配置已是最新版 v2, 无需迁移');
    expect(col.warns).toEqual([]);
  });

  test('显式 --config 不存在: 报错并返 error', async () => {
    const dir = makeSandbox();
    const missing = join(dir, 'missing.json');
    const col = makeCollectors();

    const result = await runMigrationFlow({
      resolved: { path: missing, source: 'flag' },
      explicit: true,
      interactive: false,
      colors: { stdout: false, stderr: false },
      home: dir,
      platform: 'linux',
      ...col,
    });

    expect(result).toEqual({ state: 'error' });
    expect(col.warns.join('\n')).toContain(`配置不存在 (${missing})`);
  });

  test('非 TTY 显式 `sweep migrate` 迁移成功: stdout 输出摘要且零原始 JSON', async () => {
    const dir = makeSandbox();
    const cfg = join(dir, 'config.json');
    writeFileSync(cfg, JSON.stringify({ roots: [dir], exclude: [] }));
    const col = makeCollectors();

    const result = await runMigrationFlow({
      resolved: { path: cfg, source: 'flag' },
      explicit: true,
      interactive: false,
      colors: { stdout: false, stderr: false },
      home: dir,
      platform: 'win32',
      ...col,
      now: () => FIXED_DATE,
    });

    expect(result.state).toBe('migrated');
    const out = col.prints.join('\n');
    expect(out).toContain('▍ SWEEP  配置迁移');
    expect(out).toContain('配置已迁移:');
    expect(out).toContain('Get-Content');
    expect(out).toContain('notepad');
    expect(out).not.toContain('"version":');
    expect(out).not.toContain('"presets":');
  });

  test('显式 `sweep migrate` 遇到损坏 JSON 或非法 v2 配置: 报错返 error, 绝不误报已是最新版', async () => {
    for (const [name, payload] of [
      ['corrupt.json', '{ invalid json'],
      [
        'invalid-v2.json',
        JSON.stringify({ version: 2, roots: [], presets: { node: {} } }),
      ],
    ] as const) {
      const dir = makeSandbox();
      const cfg = join(dir, name);
      writeFileSync(cfg, payload);
      const col = makeCollectors();

      const result = await runMigrationFlow({
        resolved: { path: cfg, source: 'flag' },
        explicit: true,
        interactive: false,
        colors: { stdout: false, stderr: false },
        home: dir,
        platform: 'linux',
        ...col,
      });

      expect(result, name).toEqual({ state: 'error' });
      expect(col.prints.join('\n')).not.toContain('已是最新版 v2');
      expect(col.warns.length).toBeGreaterThan(0);
    }
  });
});
