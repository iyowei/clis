/**
 * 删除安全闸契约测试 (设备边界面): 目标与所属根的文件系统比对 (st_dev) 与两形态分辨。
 * 判定本体是 IO + 纯比对, 而「另一文件系统」在测试环境里造不出挂载 (st_dev 由内核给出),
 * 故判定面由注入探针覆盖 (设备号按表给), 真实探针只跑「同卷不误判」与「不可核验不判」的对照;
 * 端到端的真实挂载现场在 cli.cross-device.e2e.test.ts (macOS + hdiutil 门控)。
 * 同批的不变量与锚点用例在 guard.contract.test.ts (按主题分文件, 与 cli.*.e2e.test.ts 同例)。
 * 设计: docs/designs/deletion-guard.md「设备边界」; 契约: docs/protocol/behavior-contract.md BC-41。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { join } from 'node:path';

import {
  type Workspace,
  type WorkspaceSpec,
  makeWorkspace,
} from './fixtures.ts';
import {
  type DeviceProbe,
  POSIX_STYLE,
  WIN32_STYLE,
  crossDeviceIndex,
  findCrossDeviceTargets,
} from './guard.ts';

const workspaces: Workspace[] = [];
async function make(spec: WorkspaceSpec): Promise<Workspace> {
  const workspace = await makeWorkspace(spec);
  workspaces.push(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(workspaces.map((workspace) => workspace.cleanup()));
  workspaces.length = 0;
});

/** 设备号探针的注入工厂 (纯函数): 记录调用序列, 未登记路径返回 null */
function makeProbe(devices: Record<string, number>): {
  probe: DeviceProbe;
  calls: { path: string; follow: boolean }[];
} {
  const calls: { path: string; follow: boolean }[] = [];
  const probe: DeviceProbe = async (path, follow) => {
    calls.push({ path, follow });
    return devices[path] ?? null;
  };
  return { probe, calls };
}

describe('设备边界: 目标与所属根的文件系统比对 (探针注入)', () => {
  /** 记录调用次序的探针工厂: 设备号按表查, 未列出的路径即「不可核验」 */
  test('posix: 同设备的目标不挑; 跨设备的目标挑出并给出形态', async () => {
    const { probe } = makeProbe({
      '/w': 1,
      '/w/plain/node_modules': 1,
      '/w/vol': 2,
      '/w/vol/proj': 2,
      '/w/vol/proj/node_modules': 2,
      '/w/onnm': 1,
      '/w/onnm/node_modules': 3,
    });
    const found = await findCrossDeviceTargets(
      [
        '/w/plain/node_modules',
        '/w/vol/proj/node_modules',
        '/w/onnm/node_modules',
      ],
      { roots: ['/w'], style: POSIX_STYLE, probe },
    );
    // 挂载点在根与目标之间 (父目录同设备) 与目标本体即挂载点 (父目录不同设备) 分形
    expect(found).toEqual([
      { target: '/w/vol/proj/node_modules', kind: 'on-path' },
      { target: '/w/onnm/node_modules', kind: 'target-itself' },
    ]);
  });
  test('形态分辨只对已挑出的目标做 (同设备目标不探父目录)', async () => {
    const { probe, calls } = makeProbe({
      '/w': 1,
      '/w/a/node_modules': 1,
      '/w/vol': 2,
      '/w/vol/node_modules': 2,
    });
    await findCrossDeviceTargets(['/w/a/node_modules', '/w/vol/node_modules'], {
      roots: ['/w'],
      style: POSIX_STYLE,
      probe,
    });
    expect(calls.map((call) => call.path)).toEqual([
      '/w',
      '/w/a/node_modules',
      '/w/vol/node_modules',
      '/w/vol', // 仅跨设备目标补探父目录
    ]);
  });
  test('父目录不可核验时归 on-path (解除路径取覆盖面更广的那条)', async () => {
    const { probe } = makeProbe({
      '/w': 1,
      '/w/vol/node_modules': 2,
      // '/w/vol' 未列出 → null
    });
    const found = await findCrossDeviceTargets(['/w/vol/node_modules'], {
      roots: ['/w'],
      style: POSIX_STYLE,
      probe,
    });
    expect(found).toEqual([{ target: '/w/vol/node_modules', kind: 'on-path' }]);
  });
  test('探针语义: 根取 stat (follow), 目标取 lstat (不 follow); 根设备号每根只探一次', async () => {
    const { probe, calls } = makeProbe({
      '/w': 1,
      '/w/a/node_modules': 1,
      '/w/b/node_modules': 1,
    });
    await findCrossDeviceTargets(['/w/a/node_modules', '/w/b/node_modules'], {
      roots: ['/w'],
      style: POSIX_STYLE,
      probe,
    });
    expect(calls).toEqual([
      { path: '/w', follow: true },
      { path: '/w/a/node_modules', follow: false },
      { path: '/w/b/node_modules', follow: false },
    ]);
  });
  test('最具体根优先: 挂载点被声明为独立根后即不再判跨设备 (解除路径)', async () => {
    const devices = { '/w': 1, '/w/vol': 2, '/w/vol/proj/node_modules': 2 };
    const target = '/w/vol/proj/node_modules';
    const flagged = await findCrossDeviceTargets([target], {
      roots: ['/w'],
      style: POSIX_STYLE,
      probe: makeProbe(devices).probe,
    });
    const released = await findCrossDeviceTargets([target], {
      roots: ['/w', '/w/vol'],
      style: POSIX_STYLE,
      probe: makeProbe(devices).probe,
    });
    expect(flagged.map((entry) => entry.target)).toEqual([target]);
    expect([...released]).toEqual([]);
  });
  test('无归属根 (根之外) 与不可核验 (设备号读不到) 均不入集', async () => {
    const { probe } = makeProbe({
      '/w': 1,
      // '/w/ghost/node_modules' 与 '/w/vol/node_modules' 未列出 → null
      '/w/vol/node_modules': 2,
    });
    const outside = await findCrossDeviceTargets(['/elsewhere/node_modules'], {
      roots: ['/w'],
      style: POSIX_STYLE,
      probe,
    });
    const unmeasurable = await findCrossDeviceTargets(
      ['/w/ghost/node_modules', '/w/vol/node_modules'],
      {
        roots: ['/w'],
        style: POSIX_STYLE,
        probe: makeProbe({ '/w': 1 }).probe,
      },
    );
    expect([...outside]).toEqual([]);
    expect([...unmeasurable]).toEqual([]);
  });
  test('根不可核验: 该根下目标一律不判 (无参照面)', async () => {
    const { probe } = makeProbe({ '/w/vol/node_modules': 2 });
    const found = await findCrossDeviceTargets(['/w/vol/node_modules'], {
      roots: ['/w'],
      style: POSIX_STYLE,
      probe,
    });
    expect([...found]).toEqual([]);
  });
  test('win32: 归属按大小写折叠; 跨盘符的目标无归属根即不判', async () => {
    const { probe } = makeProbe({
      'C:\\w': 1,
      'C:\\W\\proj\\node_modules': 1,
      'D:\\proj\\node_modules': 2,
    });
    const sameCase = await findCrossDeviceTargets(
      ['C:\\W\\proj\\node_modules'],
      {
        roots: ['C:\\w'],
        style: WIN32_STYLE,
        probe,
      },
    );
    const crossDrive = await findCrossDeviceTargets(
      ['D:\\proj\\node_modules'],
      {
        roots: ['C:\\w'],
        style: WIN32_STYLE,
        probe: makeProbe({
          'C:\\w': 1,
          'D:\\proj\\node_modules': 2,
        }).probe,
      },
    );
    expect([...sameCase]).toEqual([]);
    expect([...crossDrive]).toEqual([]);
  });
  test('win32: 跨设备目标的父目录按注入风格解析 (形态分辨不落宿主平台的 dirname)', async () => {
    const { probe, calls } = makeProbe({
      'C:\\w': 1,
      'C:\\w\\vol': 1, // 目标父目录与根同设备 → 目标本体即挂载点
      'C:\\w\\vol\\node_modules': 2,
    });
    const found = await findCrossDeviceTargets(['C:\\w\\vol\\node_modules'], {
      roots: ['C:\\w'],
      style: WIN32_STYLE,
      probe,
    });
    expect(found).toEqual([
      { target: 'C:\\w\\vol\\node_modules', kind: 'target-itself' },
    ]);
    expect(calls.map((call) => call.path)).toEqual([
      'C:\\w',
      'C:\\w\\vol\\node_modules',
      'C:\\w\\vol', // 父目录按 win32 语义取; 宿主平台的 dirname 会把该路径切成 '.'
    ]);
  });
  test('真实文件系统 (同一卷, 未挂载): 全部目标不判跨设备', async () => {
    const { root } = await make({ projects: [{ dir: 'app' }, { dir: 'lib' }] });
    const found = await findCrossDeviceTargets(
      [
        join(root, 'app', 'node_modules'),
        join(root, 'lib', 'node_modules'),
        join(root, 'ghost', 'node_modules'),
      ],
      { roots: [root] },
    );
    expect([...found]).toEqual([]);
  });
});

describe('设备边界结果形态 (数组形态与索引)', () => {
  test('crossDeviceIndex: 数组与索引往返等价 (has / get 与条目一致)', async () => {
    const devices = { '/w': 1, '/w/vol/proj/node_modules': 2, '/w/vol': 2 };
    const entries = await findCrossDeviceTargets(
      ['/w/vol/proj/node_modules', '/w/plain/node_modules'],
      { roots: ['/w'], style: POSIX_STYLE, probe: makeProbe(devices).probe },
    );

    const index = crossDeviceIndex(entries);

    expect(index.size).toBe(entries.length);
    for (const entry of entries) {
      expect(index.has(entry.target)).toBe(true);
      expect(index.get(entry.target)).toBe(entry.kind);
    }
    expect(index.has('/w/plain/node_modules')).toBe(false);
  });
  test('可序列化承诺: 条目数组 JSON 往返无损 (Map 形态会丢成空对象, 故改数组)', () => {
    const entries = [
      { target: '/w/vol/node_modules', kind: 'on-path' as const },
      { target: '/w/onnm/node_modules', kind: 'target-itself' as const },
    ];

    expect(JSON.parse(JSON.stringify(entries))).toEqual(entries);
  });
});
