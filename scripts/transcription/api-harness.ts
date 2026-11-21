/**
 * 转写契约套件 · API 面参考 harness。
 *
 * 职责: 把一条 api 语料的调用指令 (stdin JSON) 物化为对 API 包真实导出的调用, 把末步返回值 /
 * 抛错 / 收集的进度事件写成 stdout JSON。它与 CLI 面「被测命令是参数」同构: 任何语言的实现
 * 按协议 (packages/sweep/docs/protocol/conformance/api-harness-protocol.md) 提供自己的 harness 可执行,
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
 * (方法步声明过 collectEvents 即附 events 字段, 可为空数组; 创建步声明该字段按指令错误处理。)
 *
 * 变量与探针: 字符串内的 $FIXTURE 由验收器 (runner) 在派发前替换; 参数中形如
 * { "$probe": "<名>" } 的对象整体替换为下方探针注册表的值。collectEvents 为 true 时,
 * 收集器以 onProgress 并入该次调用的末个参数 (末参为对象则合并其中并覆盖既有 onProgress,
 * 否则追加 { onProgress })。
 *
 * 路径策略: 本文件经 resolveApiEntry() 基于仓根 (`../..`) 扫描 workspaces (无根 package.json 时
 * 默认 `packages/*`), 定位带 `docs/protocol` 锚点且被 CLI 包依赖的 API 包 `src/index.ts` 动态导入;
 * mutant 副本按同相对结构复制本文件即自动指向副本源码 (见 make-mutants.ts)。bun 与 node
 * (>= 22.18 类型剥离) 均可直跑。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 基于仓根动态解析主 API 包的源码入口 (src/index.ts):
 * 与 scripts/lib/workspace.ts 同算法 (带 bin 的主 CLI 包依赖的仓内无 bin 包),
 * 但内联仅依赖 node:fs / node:path 以便 make-mutants.ts 单独复制本文件到副本根下时零外部依赖、
 * 自动指向副本内的 API 源码 (无论仓库或副本包目录名如何变化)。
 */
function resolveApiEntry(): string {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let patterns = ['packages/*'];
  const rootPkgPath = join(root, 'package.json');
  if (existsSync(rootPkgPath)) {
    const parsed = JSON.parse(readFileSync(rootPkgPath, 'utf8')) as {
      workspaces?: unknown;
    };
    if (Array.isArray(parsed.workspaces)) {
      patterns = parsed.workspaces.filter(
        (item): item is string => typeof item === 'string',
      );
    }
  }
  const packages: {
    name: string;
    dir: string;
    manifest: Record<string, unknown>;
  }[] = [];
  for (const pattern of patterns) {
    const match = pattern.match(/^([^/*]+)\/\*$/);
    if (match === null) continue;
    const parent = join(root, match[1]!);
    if (!existsSync(parent)) continue;
    const entries = readdirSync(parent, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(parent, entry.name);
      const manifestPath = join(dir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
        string,
        unknown
      >;
      if (typeof manifest.name !== 'string') continue;
      packages.push({ name: manifest.name, dir, manifest });
    }
  }
  packages.sort((a, b) => a.dir.localeCompare(b.dir));
  const apiCandidates = packages.filter((pkg) => {
    if (pkg.manifest.bin !== undefined) return false;
    return packages.some((other) => {
      if (other === pkg || other.manifest.bin === undefined) return false;
      const deps = (other.manifest.dependencies ?? {}) as Record<
        string,
        unknown
      >;
      const devDeps = (other.manifest.devDependencies ?? {}) as Record<
        string,
        unknown
      >;
      return pkg.name in deps || pkg.name in devDeps;
    });
  });
  let apiPkg = apiCandidates.length === 1 ? apiCandidates[0]! : null;
  if (apiPkg === null && apiCandidates.length > 1) {
    const withProtocol = apiCandidates.filter((pkg) =>
      existsSync(join(pkg.dir, 'docs', 'protocol')),
    );
    if (withProtocol.length === 1) {
      apiPkg = withProtocol[0]!;
    } else {
      throw new Error(
        `仓内存在多个 API 候选包 (${apiCandidates.map((p) => p.name).join(', ')}), 无法唯一确定带 docs/protocol 的被测包`,
      );
    }
  }
  if (apiPkg === null) {
    throw new Error(`无法基于仓根 (${root}) 定位 API 包源码入口`);
  }
  return join(apiPkg.dir, 'src', 'index.ts');
}

const api = (await import(pathToFileURL(resolveApiEntry()).href)) as Record<
  string,
  unknown
>;

/** harness 自身问题 (指令非法 / 探针未知 / 导出与方法不存在), 与被测 API 的抛错同形态输出 */
class HarnessError extends Error {
  override readonly name = 'HarnessError';
}

/**
 * 探针注册表 (初版最小集; 协议规定的命名集合, 语言实现者须提供同名等价物)。
 * - pathops.posix / pathops.win32: 真实 PathStyle (纯 path 语义, 可直接充当被测的注入面);
 * - deviceProbe.uniform: 恒报同一设备号的 DeviceProbe stub (同设备基准面; 跨设备类场景的
 *   细分 stub 按条款需求增补, 增补不破坏既有语料)。
 * 增补探针时须同步 packages/sweep/docs/protocol/conformance/api-harness-protocol.md 的注册表清单。
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
 * 递归解析参数值: 含 $probe 键的对象整体替换为探针实现 (对象其余键不参与); 数组与普通对象递归
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
 * 执行一条指令: 按 steps 顺序解析 $probe、建句柄 / 调方法、收集事件, 返回末步返回值。
 *
 * ### 数据流转示例
 * ```text
 * Input (真实 Payload, $FIXTURE 已由 runner 在派发前替换为 realpath):
 *   instruction.steps = [
 *     { as: 's', call: { export: 'createScanner', args: [{ roots: ['<fixture>/zone'], exclude: [] }] } },
 *     { call: { on: 's', method: 'scan' }, collectEvents: true },
 *   ]
 *
 * 步骤 1: 解析参数中 { "$probe": "<名>" } -> PROBES 注册表实例; 执行创建步 -> handles['s'] = Scanner 实例
 * 步骤 2: 执行方法步, collectEvents=true 将 { onProgress } 并入末参 -> 累计进度事件至 events[]
 *
 * Output (数据契约):
 *   return { value: ScanResult, events: ScanProgressEvent[], collected: true }
 *   (顶层封装为 stdout JSON: { ok: true, value, events? } 或抛错态 { ok: false, error })
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
    if (call.args !== undefined && !Array.isArray(call.args)) {
      throw new HarnessError(`steps[${index}]: args 须为数组`);
    }
    const args = (call.args ?? []).map(resolveProbes);
    let returned: unknown;

    if (typeof call.export === 'string') {
      if (step.collectEvents === true) {
        throw new HarnessError(
          `steps[${index}]: 创建步不支持 collectEvents (仅方法步)`,
        );
      }
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

/** 将未知抛出物归一化为协议规定的 error 输出形态 (确保 name / message 恒有) */
function formatErrorOutput(error: unknown): Record<string, unknown> {
  const failure: Error & { code?: unknown; details?: unknown } =
    error instanceof Error
      ? (error as Error & { code?: unknown; details?: unknown })
      : new Error(String(error));
  const errorOut: Record<string, unknown> = {
    name: failure.name !== '' ? failure.name : 'Error',
    message: failure.message,
  };
  if (typeof failure.code === 'string') errorOut.code = failure.code;
  if (failure.details !== undefined) errorOut.details = failure.details;
  return { ok: false, error: errorOut };
}

/** 执行单条指令并始终返回协议规定的 JSON 对象 (单条抛错不外泄, 供单步与批量复用) */
async function executeSingleInstruction(
  instruction: unknown,
): Promise<Record<string, unknown>> {
  try {
    const outcome = await runInstruction(instruction);
    const output: Record<string, unknown> = { ok: true, value: outcome.value };
    if (outcome.collected) output.events = outcome.events;
    return output;
  } catch (error) {
    return formatErrorOutput(error);
  }
}

try {
  const raw = readFileSync(0, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (isPlainObject(parsed) && Array.isArray(parsed.batch)) {
    // 可选批量扩展 (协议 §2.1): 单进程依次执行多条独立指令, 加速差分模糊测试
    const results: Record<string, unknown>[] = [];
    for (const item of parsed.batch) {
      results.push(await executeSingleInstruction(item));
    }
    process.stdout.write(`${JSON.stringify({ ok: true, results })}\n`);
  } else {
    const result = await executeSingleInstruction(parsed);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) {
  // 顶层 JSON.parse 失败或 stdin 不可读时兜底回写协议错误对象
  process.stdout.write(`${JSON.stringify(formatErrorOutput(error))}\n`);
}
