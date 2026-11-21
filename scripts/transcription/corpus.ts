/**
 * 转写契约套件 · 语料层 (覆盖 cli + api 双面, 当前全集 93 条 = 61 CLI + 32 API, 以目录实有 .json 为准)。
 *
 * 职责: 语料字段类型 (与 packages/sweep/docs/protocol/conformance/corpus.schema.json 对应) + $FIXTURE 变量替换
 * 契约 + 目录加载。字段语义以 schema 为准; 手写校验 (schema 的物化子集) 在 validate.ts, 只为尽早
 * 给出可读报错, 不复刻 schema 的全部约束。
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { validateCase } from './validate.ts';

/** 协议区相对仓根的唯一路径常量 (文档目录迁徙时仅需单点切换此处) */
export const PROTOCOL_ROOT = 'packages/sweep/docs/protocol';
export const CONTRACT_REL = `${PROTOCOL_ROOT}/behavior-contract.md`;
export const COVERAGE_REL = `${PROTOCOL_ROOT}/conformance/coverage.md`;
export const CORPUS_REL = `${PROTOCOL_ROOT}/conformance/corpus`;

// ---------------------------------------------------------------------------
// 语料类型 (与 corpus.schema.json 对应)
// ---------------------------------------------------------------------------

export interface ProjectSpec {
  dir: string;
  files?: number;
  bytesPerFile?: number;
  nested?: boolean;
  git?: boolean;
  /** true 时不写同级 package.json (供 node 预设无锚点防误删反例使用) */
  noPackageJson?: boolean;
}

export interface SymlinkSpec {
  at: string;
  to: string;
}

export interface FixtureSpec {
  projects?: ProjectSpec[];
  symlinks?: SymlinkSpec[];
  unreadable?: string[];
  /** 只读目录 (chmod 0500): 可读可进入、不可写, 供删除失败 / 部分删除类用例 */
  readonly?: string[];
}

export interface SetupStep {
  write: {
    path: string;
    text: string;
    /** 可选绝对修改时间 (毫秒戳, 写入后调用 utimes 设置 mtime) */
    mtimeMs?: number;
    /** 可选相对当前时间前移的天数 (写入后按 now - ageDays * 86400000 设置 mtime) */
    ageDays?: number;
  };
}

export interface RunSpec {
  argv?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export type FsState = 'gone' | 'exists' | 'empty';
export type FsEntryKind = 'file' | 'dir' | 'symlink';

export interface FsExpectation {
  path: string;
  state: FsState;
  /** 可选实体形态校验 (仅 exists/empty 有效) */
  kind?: FsEntryKind;
  /** 可选文件内容子串断言 (仅 state=exists 常规文件有效, 支持 $FIXTURE) */
  contains?: string[];
  /** 可选同级目录通配匹配 (在 path 目录下须存在至少一个匹配该简单通配符 * / ? 的条目) */
  globExists?: string;
}

export interface ExpectSpec {
  exitCode: number;
  stdoutExact?: string;
  stdoutContains?: string[];
  /** 「不该出现」面: 剪枝 / 排除 / 诱饵类用例的禁含断言 */
  stdoutMustNotContain?: string[];
  /** stderr 逐字节期望 (如强制要求正常路径 stderr 为空串 "") */
  stderrExact?: string;
  stderrContains?: string[];
  /** 「不该出现」面: 「正确行为是静默」类用例的 stderr 禁含断言 */
  stderrMustNotContain?: string[];
  fs?: FsExpectation[];
}

/** cli 用例 (缺省形态): 经 --target 的被测命令做黑盒验收 */
export interface CliCorpusCase {
  id: string;
  kind?: 'cli';
  /** 可选运行标签 (如 apfs-block-size, 供 --exclude-tag 跨文件系统筛选) */
  tags?: string[];
  specRefs: string[];
  fixture: FixtureSpec;
  setup?: SetupStep[];
  run: RunSpec;
  expect: ExpectSpec;
}

/** api 用例的单步调用指令 (形状与执行语义见 packages/sweep/docs/protocol/conformance/api-harness-protocol.md) */
export interface ApiCallStep {
  as?: string;
  call: {
    export?: string;
    on?: string;
    method?: string;
    args?: unknown[];
  };
  collectEvents?: boolean;
}

/** api 用例的断言族: 末步返回值 / 抛错码 / 事件流 / fs (fs 与 cli 面共用) */
export interface ApiExpectSpec {
  result?: { exact?: unknown; subset?: unknown };
  error?: { code: string; name?: string; detailsSubset?: unknown };
  events?: {
    lastIs?: string;
    mustInclude?: string[];
    mustNotInclude?: string[];
  };
  fs?: FsExpectation[];
}

/** api 用例: 经被测方按协议提供的 harness 可执行做黑盒验收 (--api-target) */
export interface ApiCorpusCase {
  id: string;
  kind: 'api';
  /** 可选运行标签 */
  tags?: string[];
  specRefs: string[];
  fixture: FixtureSpec;
  setup?: SetupStep[];
  env?: Record<string, string>;
  steps: ApiCallStep[];
  expect: ApiExpectSpec;
}

export type CorpusCase = CliCorpusCase | ApiCorpusCase;

// ---------------------------------------------------------------------------
// 变量替换契约 ($FIXTURE)
// ---------------------------------------------------------------------------

/** 语料中的 fixture 根变量 (字符串字段内出现即替换为 realpath 形态的绝对路径) */
export const FIXTURE_VAR = '$FIXTURE';

/** 字符串字段的变量替换 (仅 $FIXTURE 一个变量, 保持最小面) */
export const applyVars = (text: string, root: string): string =>
  text.split(FIXTURE_VAR).join(root);

/**
 * 递归对任意 JSON 值里的字符串做 $FIXTURE 替换 (保结构)。
 * 两处消费: api 用例的 steps 指令在派发给 harness 前替换; result 期望值在比对前替换。
 * ({ "$probe": ... } 标记对象可安全穿过: 探针名不含 $FIXTURE。)
 */
export function replaceVarsDeep(value: unknown, root: string): unknown {
  if (typeof value === 'string') return applyVars(value, root);
  if (Array.isArray(value)) {
    return value.map((item) => replaceVarsDeep(item, root));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceVarsDeep(item, root),
      ]),
    );
  }
  return value;
}

/**
 * 读语料目录下全部 .json (按文件名升序, 执行次序确定)。
 * 任一文件非法即抛错 (语料缺陷属于 runner 级错误, 不降级为用例失败)。
 *
 * ### 数据流转示例
 * ```text
 * Input (真实 Payload):
 *   dir = 'packages/sweep/docs/protocol/conformance/corpus' (含 cli 与 api 两类 .json)
 *
 * 步骤 1: 取 .json 文件名并字典序排序 (空目录直接抛错防假绿)
 * 步骤 2: 逐文件 JSON 解析 -> validateCase -> 校验文件名 === `${id}.json` 与 id 唯一性
 *
 * Output (数据契约):
 *   return 按文件名升序的 CorpusCase[]; 任一环节失败即 throw (调用方落退出码 2)
 * ```
 */
export async function loadCorpus(dir: string): Promise<CorpusCase[]> {
  let names: string[];
  try {
    names = (await readdir(dir))
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch (error) {
    throw new Error(`语料目录不可读: ${dir} (${(error as Error).message})`);
  }
  if (names.length === 0) {
    throw new Error(
      `语料目录没有 .json 用例: ${dir} (空语料按 runner 级错误处理, 退 2 不假绿; 约定见 corpus/README.md)`,
    );
  }

  const cases: CorpusCase[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const file = join(dir, name);
    const text = await readFile(file, 'utf8');
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `语料非法 (${name}): JSON 解析失败: ${(error as Error).message}`,
      );
    }
    const problems = validateCase(data);
    if (problems.length > 0) {
      throw new Error(`语料非法 (${name}):\n  - ${problems.join('\n  - ')}`);
    }
    const caseSpec = data as CorpusCase;
    if (`${caseSpec.id}.json` !== name) {
      throw new Error(
        `语料非法 (${name}): 文件名须与 id 一致 (期望 ${caseSpec.id}.json)`,
      );
    }
    if (seen.has(caseSpec.id)) {
      throw new Error(`语料非法 (${name}): id 重复: ${caseSpec.id}`);
    }
    seen.add(caseSpec.id);
    cases.push(caseSpec);
  }
  return cases;
}
