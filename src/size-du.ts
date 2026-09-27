/**
 * 候选 A (双轨快路径): 系统 du 批量单次统计磁盘占用。
 * 探针: 绝对路径 /usr/bin/du 与 /bin/du, 均缺失时本候选标记不可用, measure 返回空结果 + 告警。
 * 口径: 磁盘占用 (按块取整, 恒 ≥ 逻辑字节), 与 js 候选的差异由基准环节记录裁定。
 * du 的英文 stderr 一律转成自家中文告警, 不得原样透传; 输入 target 存在但不可测时结构化记入 unmeasured。
 * 防注入: `--` 终止选项解析; 含控制字符 (换行 / 回车) 的 target 前置拒绝; stdout 路径集合与输入不符即整体降级。
 * 输出形态 (已核实, 2026-09-27): du 仅在 stdout 为终端时按 shell-escape 引用文件名 (GNU 手册 du 节点
 * 「When standard output is a terminal, file names are quoted using the shell-escape style」; 源码侧
 * isatty 门控, 9.12 之前的版本无引用逻辑), 本候选以管道捕获 stdout, 恒非终端, 故路径恒按输入原样成行
 * (TAB / ESC / 引号等原样保留, 实测 GNU du 9.12); 含换行 / 回车者会劈裂行结构, 由前置拒绝接住。
 * 不走 runtime 适配层 spawnCapture: 需捕获 stderr 转中文告警, 其 stderr inherit (直通) 语义接不住本需求。
 */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';

import type { SizeEntry, SizeResult, Sizer, UnmeasuredEntry } from './types.ts';

/** du 探针路径: 绝对路径, 依序探测 */
const DU_PROBES = ['/usr/bin/du', '/bin/du'];

/** target 是否含控制字符 (换行 / 回车): 会劈裂 du 的输出行结构, 属注入面 */
const hasControlChar = (target: string): boolean =>
  target.includes('\n') || target.includes('\r');

/** 探测可用的 du 可执行文件; 均缺失返回 null */
export function findDu(): string | null {
  for (const probe of DU_PROBES) {
    try {
      accessSync(probe, constants.X_OK);
      return probe;
    } catch {
      // 该探针缺失或不可执行, 继续探测下一个
    }
  }
  return null;
}

/** spawn 一次 `du -sk --` 汇总全部 target, 原样收回 stdout / stderr */
function runDu(
  bin: string,
  targets: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // `--` 终止选项解析: 目标以 `-` 开头时不得被 du 当选项吞掉 (如 -P 会静默输出 cwd 统计)
    const child = spawn(bin, ['-sk', '--', ...targets], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      // spawn 级失败 (如探针被并发移除), 并入 stderr 交上层转中文告警
      resolve({ stdout, stderr: `${stderr}${String(error)}` });
    });
    child.on('close', () => resolve({ stdout, stderr }));
  });
}

/** 解析 `du -sk` 输出: 每行 `<KiB>\t<绝对路径>`; duplicated 标记同一路径被输出多行 (行结构可疑) */
function parseDuSizes(stdout: string): {
  sizes: Map<string, number>;
  duplicated: boolean;
} {
  const sizes = new Map<string, number>();
  let duplicated = false;
  for (const line of stdout.split('\n')) {
    // 以 TAB 为硬分隔; 不用 \s+ (贪婪空白会吞掉路径的前导空格, 怪名 target 会落进「原因未知」)
    const match = /^(\d+)\t(.+)$/.exec(line);
    if (match === null) continue;
    const sizeKiB = match[1];
    const path = match[2];
    // 捕获组由上面的正则结构保证存在; 此判仅为 noUncheckedIndexedAccess 的类型收窄
    if (sizeKiB === undefined || path === undefined) continue;
    if (sizes.has(path)) duplicated = true;
    sizes.set(path, Number(sizeKiB) * 1024);
  }
  return { sizes, duplicated };
}

/** stdout 与输入集合的一致性判定结果 (解析与判定合一, 供单测注入样本验证) */
export interface DuOutputAssessment {
  /** 解析出的 路径 → 字节; 仅当 intact 为真时可信 */
  sizes: Map<string, number>;
  /** stdout 与本次输入相符 (无重复、无输入之外的路径): 每条可按下标归因 */
  intact: boolean;
  /** 同一路径出现多行 (行结构可疑) */
  duplicated: boolean;
  /** 出现输入集合之外的路径 (形态被改写或注入) */
  unexpected: boolean;
}

/**
 * 解析 du 的 stdout 并判定与输入集合的一致性。
 * 判据是「解析出的路径须全部来自本次输入且无重复」: 任一不符即整批不可信 (fail-safe, 不逐条采信),
 * 因为不符只可能来自输出行结构被破坏 (注入 / 形态改写), 逐条采信会给伪行留下覆盖真实体积的入口。
 */
export function assessDuOutput(
  stdout: string,
  safeTargets: readonly string[],
): DuOutputAssessment {
  const safeSet = new Set(safeTargets);
  const parsed = parseDuSizes(stdout);
  let unexpected = false;
  for (const path of parsed.sizes.keys()) {
    if (!safeSet.has(path)) unexpected = true;
  }
  const intact =
    !parsed.duplicated &&
    parsed.sizes.size <= safeTargets.length &&
    !unexpected;
  return {
    sizes: parsed.sizes,
    intact,
    duplicated: parsed.duplicated,
    unexpected,
  };
}

/** 一致性判定失败的形态归类 (人话短语; 只述形态, 不含路径, 低信任内容不外溢) */
function describeAnomaly(assessment: DuOutputAssessment): string {
  const shapes: string[] = [];
  if (assessment.duplicated) shapes.push('同一路径多行');
  if (assessment.unexpected) shapes.push('含输入之外的路径');
  if (shapes.length === 0) shapes.push('行数与输入不符');
  return shapes.join(' / ');
}

/** du 单路径失败的归因 */
interface DuFailure {
  /** 中文人话原因 (人话短语, 不含路径) */
  reason: string;
  /** 「不存在」维持裁定 (跳过、不入任何桶), 不得记入 unmeasured */
  missing: boolean;
}

/** 把 du 的英文错误短语转成中文人话原因; 未知短语保留原文便于诊断 (已剥离 `du:` 前缀) */
function describeDuFailure(detail: string): DuFailure {
  if (/no such file or directory/i.test(detail))
    return { reason: '不存在', missing: true };
  if (/permission denied/i.test(detail))
    return { reason: '权限不足, 无法读取', missing: false };
  if (/not a directory/i.test(detail))
    return { reason: '不是目录', missing: false };
  if (/too many levels of symbolic links/i.test(detail)) {
    return { reason: '符号链接层级过深', missing: false };
  }
  return { reason: `读取失败 (${detail})`, missing: false };
}

/** 解析 du stderr 行 `du: <路径>: <英文短语>`; 无法解析时返回 null */
function parseDuErrorLine(
  line: string,
): { path: string; detail: string } | null {
  const match = /^du:\s+(.+):\s+(.+)$/.exec(line);
  if (match === null) return null;
  const path = match[1];
  const detail = match[2];
  // 同 parseDuSizes: 判空只为类型收窄, 正则已保证两个捕获组存在
  if (path === undefined || detail === undefined) return null;
  return { path, detail };
}

/**
 * 构造 du 候选。
 * bin 缺省走 findDu() 探针; 显式传入供测试注入 (如用包管理器装的 GNU du 复现 Linux 侧形态),
 * 生产调用不传。
 */
export function createDuSizer(bin: string | null = findDu()): Sizer {
  return {
    name: 'du',
    async measure(targets: string[]): Promise<SizeResult> {
      if (bin === null) {
        return {
          entries: [],
          warnings: [
            'du 候选不可用: /usr/bin/du 与 /bin/du 均不存在, 本候选跳过体积统计',
          ],
          unmeasured: [],
        };
      }
      if (targets.length === 0) {
        return { entries: [], warnings: [], unmeasured: [] };
      }

      const sorted = [...targets].sort();
      const warnings: string[] = [];
      const entries: SizeEntry[] = [];
      const unmeasured: UnmeasuredEntry[] = [];

      // 含控制字符的 target 会劈裂 du 的 `size\t路径` 行结构 (伪造行可覆盖真实体积): 前置拒绝, 不进 du
      const safeTargets = sorted.filter((target) => !hasControlChar(target));
      const safeSet = new Set(safeTargets);

      // stdout 解析与 stderr 归因只对安全 target 做; 空集不 spawn (du 无路径参数会统计 cwd)
      const sizes = new Map<string, number>();
      const failures = new Map<string, DuFailure>();
      let intact = true;
      if (safeTargets.length > 0) {
        const { stdout, stderr } = await runDu(bin, safeTargets);

        // 集合一致性校验: 解析出的路径必须全部来自本次输入且无重复; 不符即视为输出行结构
        // 被破坏 (注入 / 形态改写), 由下方循环 fail-safe 整体降级, 不逐条赋值
        const assessment = assessDuOutput(stdout, safeTargets);
        intact = assessment.intact;
        if (!intact) {
          // 整批降级不得静默: 交代后果与形态归类, 让「什么都没删」可被归因 (路径本身不进文案)
          warnings.push(
            `du 输出与输入集合不符 (${describeAnomaly(assessment)}): 本批 ${safeTargets.length} 个目标的体积均未采信`,
          );
        }
        for (const [path, bytes] of assessment.sizes) sizes.set(path, bytes);

        // stderr 逐行转中文告警, 英文原文不外泄; 键为路径, 供下面按 target 归因
        for (const line of stderr.split('\n')) {
          if (line.trim() === '') continue;
          const errorLine = parseDuErrorLine(line);
          if (errorLine === null) {
            warnings.push(`体积统计失败 (未归因): ${line.trim()}`);
            continue;
          }
          const failure = describeDuFailure(errorLine.detail);
          if (!safeSet.has(errorLine.path)) {
            // 输入 target 之外的路径 (如 target 内的子目录): 部分降级, 告警但该 target 结果仍有效
            warnings.push(
              `体积统计失败 (${failure.reason}): ${errorLine.path}`,
            );
            continue;
          }
          failures.set(errorLine.path, failure);
        }
      }

      for (const target of sorted) {
        if (hasControlChar(target)) {
          unmeasured.push({ target, reason: '路径含控制字符' });
          continue;
        }
        // 一致性校验不过: 本批 du 输出不可信, 整体降级 unmeasured, 不逐条赋值
        if (!intact) {
          unmeasured.push({ target, reason: '输出不可解析' });
          continue;
        }
        const bytes = sizes.get(target);
        if (bytes !== undefined) {
          entries.push({ target, bytes });
          continue;
        }
        const failure = failures.get(target);
        if (failure === undefined) {
          // 解析不出且无 stderr 归因: 结构化为 unmeasured, 不得静默丢弃 (types.ts: 存在但无法测量的
          // 目标必须上报)。现实触发面是含换行 / 回车的目标 (劈裂 `size\t路径` 行结构), 该形态已被上方
          // 前置拒绝接住, 故本分支接住的是探针或 du 侧未知形态; 引用形态不在此列 (见文件头「输出形态」)。
          unmeasured.push({ target, reason: '输出不可解析' });
          continue;
        }
        if (failure.missing) {
          // 「不存在」维持裁定: 告警并跳过, 不入任何桶
          warnings.push(`体积统计失败 (不存在): ${target}`);
          continue;
        }
        unmeasured.push({ target, reason: failure.reason });
      }

      return { entries, warnings, unmeasured };
    },
  };
}
