/**
 * 转写契约套件 · API 面参考 harness。
 *
 * 职责: 把一条 api 语料的调用指令 (stdin JSON) 物化为对 API 包真实导出的调用, 把末步返回值 /
 * 抛错 / 收集的进度事件写成 stdout JSON。它与 CLI 面「被测命令是参数」同构: 任何语言的实现
 * 按协议 (docs/protocol/conformance/api-harness-protocol.md) 提供自己的 harness 可执行,
 * 套件零改动即可验收。
 *
 * 指令形状 (stdin):
 *   { "steps": [
 *       { "as": "s", "call": { "export": "createScanner", "args": [ { ... } ] } },     // 创建步
 *       { "call": { "on": "s", "method": "scan", "args": [] }, "collectEvents": true }  // 方法步
 *   ] }
 * 步骤按序执行; 末步返回值即输出的 value; 任一步抛错即终止并以 error 形态输出。
 *
 * 输出形状 (stdout):
 *   { "ok": true, "value": <末步返回值>, "events": [ ... ]? }
 *   { "ok": false, "error": { "name", "code"?, "message", "details"? } }
 * (任一步骤声明过 collectEvents 即附 events 字段, 可为空数组。)
 *
 * 变量与探针: 字符串内的 $FIXTURE 由验收器 (runner) 在派发前替换; 参数中形如
 * { "$probe": "<名>" } 的对象整体替换为下方探针注册表的值。collectEvents 为 true 时,
 * 收集器以 onProgress 并入该次调用的末个参数 (末参为对象则合并其中并覆盖既有 onProgress,
 * 否则追加 { onProgress })。
 *
 * 路径策略: 本文件以相对路径直连 API 包单源 (.../packages/sweep-node-modules/src/index.ts);
 * mutant 副本按同相对结构复制本文件即自动指向副本源码 (见 make-mutants.ts)。bun 与 node
 * (≥ 22.18 类型剥离) 均可直跑。
 */
import { readFileSync } from 'node:fs';

import * as api from '../../packages/sweep-node-modules/src/index.ts';

/** harness 自身问题 (指令非法 / 探针未知 / 导出与方法不存在), 与被测 API 的抛错同形态输出 */
class HarnessError extends Error {
  override readonly name = 'HarnessError';
}

/**
 * 探针注册表 (初版最小集; 协议规定的命名集合, 语言实现者须提供同名等价物)。
 * - pathops.posix / pathops.win32: 真实 PathStyle (纯 path 语义, 可直接充当被测的注入面);
 * - deviceProbe.uniform: 恒报同一设备号的 DeviceProbe stub (同设备基准面; 跨设备类场景的
 *   细分 stub 按条款需求增补, 增补不破坏既有语料)。
 * 增补探针时须同步 docs/protocol/conformance/api-harness-protocol.md 的注册表清单。
 */
const PROBES: Record<string, unknown> = {
  'pathops.posix': api.POSIX_STYLE,
  'pathops.win32': api.WIN32_STYLE,
  'deviceProbe.uniform': async () => 1,
};

/** 单步指令 (字段全可选, 合法性由执行期校验并给出可读报错) */
interface CallStep {
  as?: string;
  call?: {
    export?: string;
    on?: string;
    method?: string;
    args?: unknown[];
  };
  collectEvents?: boolean;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 递归解析参数值: 恰为 { "$probe": "<名>" } 形态的对象替换为探针实现; 数组与普通对象递归
 * 下钻; 其余值原样。探针名不在注册表即抛 HarnessError (指令缺陷, 不静默透传)。
 */
function resolveProbes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolveProbes);
  if (isPlainObject(value)) {
    if ('$probe' in value) {
      const name = value.$probe;
      if (typeof name !== 'string' || !(name in PROBES)) {
        throw new HarnessError(`未知探针: ${String(name)}`);
      }
      return PROBES[name];
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveProbes(item)]),
    );
  }
  return value;
}

/**
 * 执行一条指令: 按 steps 顺序建句柄 / 调方法, 收集事件, 返回末步返回值。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   instruction.steps = [
 *     { as: 's', call: { export: 'createScanner', args: [{ roots: ['<fixture>/zone'], exclude: [] }] } },
 *     { call: { on: 's', method: 'scan' }, collectEvents: true },
 *   ]
 *
 * 步骤 1：创建步执行
 *   handles = { s: <Scanner 实例> }; value = Scanner 实例
 *
 * 步骤 2：collectEvents 并入末参
 *   finalArgs = [{ onProgress: <收集器> }]; returned = ScanResult; events 累计进度事件
 *
 * Output（数据契约）
 *   return { value: ScanResult, events: MeasureProgressEvent 以外的 ScanProgressEvent[] }
 * ```
 */
async function runInstruction(instruction: unknown): Promise<{
  value: unknown;
  events: unknown[];
  collected: boolean;
}> {
  if (
    !isPlainObject(instruction) ||
    !Array.isArray(instruction.steps) ||
    instruction.steps.length === 0
  ) {
    throw new HarnessError('指令缺少非空 steps 数组');
  }

  const handles = new Map<string, Record<string, unknown>>();
  const events: unknown[] = [];
  let collected = false;
  let value: unknown;

  for (const [index, item] of instruction.steps.entries()) {
    const step = item as CallStep;
    if (!isPlainObject(step) || !isPlainObject(step.call)) {
      throw new HarnessError(`steps[${index}] 须为 { call: { ... } } 形态`);
    }
    const call = step.call;
    const args = (call.args ?? []).map(resolveProbes);
    let returned: unknown;

    if (typeof call.export === 'string') {
      const fn = (api as Record<string, unknown>)[call.export];
      if (typeof fn !== 'function') {
        throw new HarnessError(
          `steps[${index}]: 导出不存在或不是函数: ${call.export}`,
        );
      }
      returned = await (fn as (...rest: unknown[]) => unknown)(...args);
    } else if (typeof call.on === 'string' && typeof call.method === 'string') {
      const handle = handles.get(call.on);
      if (handle === undefined) {
        throw new HarnessError(`steps[${index}]: 句柄未定义: ${call.on}`);
      }
      const method = handle[call.method];
      if (typeof method !== 'function') {
        throw new HarnessError(
          `steps[${index}]: 句柄 ${call.on} 上无方法: ${call.method}`,
        );
      }
      let finalArgs = args;
      if (step.collectEvents === true) {
        collected = true;
        const onProgress = (event: unknown): void => {
          events.push(event);
        };
        const lastIndex = args.length - 1;
        const last = args[lastIndex];
        finalArgs = isPlainObject(last)
          ? [...args.slice(0, lastIndex), { ...last, onProgress }]
          : [...args, { onProgress }];
      }
      returned = await (method as (...rest: unknown[]) => unknown).apply(
        handle,
        finalArgs,
      );
    } else {
      throw new HarnessError(
        `steps[${index}]: 须为创建步 (call.export) 或方法步 (call.on + call.method)`,
      );
    }

    if (typeof step.as === 'string') {
      if (!isPlainObject(returned)) {
        throw new HarnessError(
          `steps[${index}]: as 句柄要求返回对象, 实得 ${typeof returned}`,
        );
      }
      handles.set(step.as, returned);
    }
    value = returned;
  }

  return { value, events, collected };
}

try {
  const raw = readFileSync(0, 'utf8');
  const outcome = await runInstruction(JSON.parse(raw));
  const output: Record<string, unknown> = { ok: true, value: outcome.value };
  if (outcome.collected) output.events = outcome.events;
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  const failure = error as Error & { code?: unknown; details?: unknown };
  const errorOut: Record<string, unknown> = {
    name: failure.name !== '' ? failure.name : 'Error',
    message: failure.message,
  };
  if (typeof failure.code === 'string') errorOut.code = failure.code;
  if (failure.details !== undefined) errorOut.details = failure.details;
  process.stdout.write(`${JSON.stringify({ ok: false, error: errorOut })}\n`);
}
