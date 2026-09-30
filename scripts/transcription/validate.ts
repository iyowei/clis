/**
 * 转写契约套件 · 语料手写校验层 (schema 的物化子集)。
 *
 * 职责: 对 loadCorpus 读入的单条 case 做结构校验 (cli 与 api 两类按 kind 分流), 返回可读
 * 问题清单; 字段语义以 docs/sweep/protocol/conformance/corpus.schema.json 为准, 本层只为尽早给出
 * 报错, 不复刻 schema 的全部约束。
 */
import { isAbsolute } from 'node:path';

// ---------------------------------------------------------------------------
// 手写校验 (schema 的物化子集)
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SPEC_REF_PATTERN = /^[A-Z]{2,4}-[0-9]+$/;

/** 相对路径判定: 非空、非绝对 (含 win 盘符)、不含反斜杠与 '..' 段 */
function isSafeRelPath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  if (isAbsolute(value) || /^[a-zA-Z]:/.test(value)) return false;
  if (value.includes('\\')) return false;
  return !value.split('/').includes('..');
}

/** 校验单条 fixture.projects 项 (抽出以压平嵌套深度; 报错文案与顺序与内联时一致) */
function validateProjectEntry(
  item: unknown,
  index: number,
  problems: string[],
): void {
  const project = asRecord(item);
  if (project === null || !isSafeRelPath(project.dir)) {
    problems.push(`fixture.projects[${index}].dir 须为相对路径`);
    return;
  }
  for (const key of ['files', 'bytesPerFile'] as const) {
    const value = project[key];
    if (
      value !== undefined &&
      (!Number.isInteger(value) || (value as number) < 0)
    ) {
      problems.push(`fixture.projects[${index}].${key} 须为非负整数`);
    }
  }
}

function validateFixture(fixture: unknown, problems: string[]): void {
  const record = asRecord(fixture);
  if (record === null) {
    problems.push('fixture 缺失或不是对象');
    return;
  }
  const projects = record.projects;
  if (projects !== undefined) {
    if (!Array.isArray(projects)) {
      problems.push('fixture.projects 须为数组');
    } else {
      for (const [index, item] of projects.entries()) {
        validateProjectEntry(item, index, problems);
      }
    }
  }
  const symlinks = record.symlinks;
  if (symlinks !== undefined) {
    if (!Array.isArray(symlinks)) {
      problems.push('fixture.symlinks 须为数组');
    } else {
      for (const [index, item] of symlinks.entries()) {
        const link = asRecord(item);
        if (
          link === null ||
          !isSafeRelPath(link.at) ||
          !isSafeRelPath(link.to)
        ) {
          problems.push(`fixture.symlinks[${index}] 的 at / to 须为相对路径`);
        }
      }
    }
  }
  const unreadable = record.unreadable;
  if (unreadable !== undefined) {
    if (!Array.isArray(unreadable) || !unreadable.every(isSafeRelPath)) {
      problems.push('fixture.unreadable 须为相对路径数组');
    }
  }
  const readonly = record.readonly;
  if (readonly !== undefined) {
    if (!Array.isArray(readonly) || !readonly.every(isSafeRelPath)) {
      problems.push('fixture.readonly 须为相对路径数组');
    }
  }
}

function validateSetup(setup: unknown, problems: string[]): void {
  if (setup === undefined) return;
  if (!Array.isArray(setup)) {
    problems.push('setup 须为数组');
    return;
  }
  for (const [index, item] of setup.entries()) {
    const step = asRecord(item);
    const write = step === null ? null : asRecord(step.write);
    if (
      write === null ||
      !isSafeRelPath(write.path) ||
      typeof write.text !== 'string'
    ) {
      problems.push(
        `setup[${index}] 须为 { write: { path: 相对路径, text: 字符串 } }`,
      );
    }
  }
}

function validateRun(run: unknown, problems: string[]): void {
  const record = asRecord(run);
  if (record === null) {
    problems.push('run 缺失或不是对象');
    return;
  }
  const argv = record.argv;
  if (
    argv !== undefined &&
    (!Array.isArray(argv) || !argv.every((item) => typeof item === 'string'))
  ) {
    problems.push('run.argv 须为字符串数组');
  }
  const env = record.env;
  if (env !== undefined) {
    const envRecord = asRecord(env);
    if (
      envRecord === null ||
      !Object.values(envRecord).every((item) => typeof item === 'string')
    ) {
      problems.push('run.env 须为字符串值对象');
    }
  }
  if (record.cwd !== undefined && !isSafeRelPath(record.cwd)) {
    problems.push('run.cwd 须为相对路径');
  }
}

/** fs 断言族校验 (cli 与 api 两面共用) */
function validateFs(fs: unknown, problems: string[]): void {
  if (fs === undefined) return;
  if (!Array.isArray(fs)) {
    problems.push('expect.fs 须为数组');
    return;
  }
  for (const [index, item] of fs.entries()) {
    const entry = asRecord(item);
    const state = entry === null ? undefined : entry.state;
    if (
      entry === null ||
      !isSafeRelPath(entry.path) ||
      !['gone', 'exists', 'empty'].includes(String(state))
    ) {
      problems.push(
        `expect.fs[${index}] 须为 { path: 相对路径, state: gone|exists|empty }`,
      );
    }
  }
}

function validateExpect(expect: unknown, problems: string[]): void {
  const record = asRecord(expect);
  if (record === null) {
    problems.push('expect 缺失或不是对象');
    return;
  }
  for (const key of ['result', 'error', 'events'] as const) {
    if (record[key] !== undefined) {
      problems.push(`expect.${key} 仅 api case 可用 (本 case 为 cli)`);
    }
  }
  if (!Number.isInteger(record.exitCode)) {
    problems.push('expect.exitCode 须为整数 (cli case 必填)');
  }
  if (
    record.stdoutExact !== undefined &&
    typeof record.stdoutExact !== 'string'
  ) {
    problems.push('expect.stdoutExact 须为字符串');
  }
  for (const key of [
    'stdoutContains',
    'stdoutMustNotContain',
    'stderrContains',
    'stderrMustNotContain',
  ] as const) {
    const value = record[key];
    if (
      value !== undefined &&
      (!Array.isArray(value) ||
        !value.every((item) => typeof item === 'string'))
    ) {
      problems.push(`expect.${key} 须为字符串数组`);
    }
  }
  validateFs(record.fs, problems);
}

/** 环境增量校验 (api case 顶层 env; 与 run.env 同形态) */
function validateEnv(env: unknown, problems: string[]): void {
  if (env === undefined) return;
  const record = asRecord(env);
  if (
    record === null ||
    !Object.values(record).every((item) => typeof item === 'string')
  ) {
    problems.push('env 须为字符串值对象');
  }
}

/** steps 校验 (api case): 每步恰为创建步 (call.export) 或方法步 (call.on + call.method) */
function validateSteps(steps: unknown, problems: string[]): void {
  if (!Array.isArray(steps) || steps.length === 0) {
    problems.push('steps 须为非空数组 (api case)');
    return;
  }
  for (const [index, item] of steps.entries()) {
    const step = asRecord(item);
    const call = step === null ? null : asRecord(step.call);
    if (step === null || call === null) {
      problems.push(`steps[${index}] 须为 { call: { ... } }`);
      continue;
    }
    const hasExport = typeof call.export === 'string' && call.export !== '';
    const hasOn = typeof call.on === 'string' && call.on !== '';
    const hasMethod = typeof call.method === 'string' && call.method !== '';
    if (!(hasExport !== (hasOn && hasMethod)) || hasOn !== hasMethod) {
      problems.push(
        `steps[${index}].call 须恰为创建步 (export) 或方法步 (on + method)`,
      );
    }
    if (hasExport && step.collectEvents === true) {
      problems.push(`steps[${index}]: 创建步不支持 collectEvents (仅方法步)`);
    }
    if (
      step.as !== undefined &&
      (typeof step.as !== 'string' || step.as === '')
    ) {
      problems.push(`steps[${index}].as 须为非空字符串`);
    }
    if (call.args !== undefined && !Array.isArray(call.args)) {
      problems.push(`steps[${index}].call.args 须为数组`);
    }
    if (
      step.collectEvents !== undefined &&
      typeof step.collectEvents !== 'boolean'
    ) {
      problems.push(`steps[${index}].collectEvents 须为布尔`);
    }
  }
}

/** api case 断言族校验: result (恰含 exact / subset 之一) / error (code 必填) / events / fs */
function validateApiExpect(expect: unknown, problems: string[]): void {
  const record = asRecord(expect);
  if (record === null) {
    problems.push('expect 缺失或不是对象');
    return;
  }
  for (const key of [
    'exitCode',
    'stdoutExact',
    'stdoutContains',
    'stdoutMustNotContain',
    'stderrContains',
    'stderrMustNotContain',
  ] as const) {
    if (record[key] !== undefined) {
      problems.push(`expect.${key} 仅 cli case 可用 (本 case 为 api)`);
    }
  }
  const result = record.result;
  if (result !== undefined) {
    const shape = asRecord(result);
    const hasExact = shape !== null && 'exact' in shape;
    const hasSubset = shape !== null && 'subset' in shape;
    if (shape === null || hasExact === hasSubset) {
      problems.push('expect.result 须恰含 exact 或 subset 之一');
    }
  }
  const error = record.error;
  if (error !== undefined) {
    const shape = asRecord(error);
    if (shape === null || typeof shape.code !== 'string' || shape.code === '') {
      problems.push('expect.error 须含非空字符串 code');
    } else if (shape.name !== undefined && typeof shape.name !== 'string') {
      problems.push('expect.error.name 须为字符串');
    }
  }
  const events = record.events;
  if (events !== undefined) {
    const shape = asRecord(events);
    if (shape === null) {
      problems.push('expect.events 须为对象');
    } else {
      if (shape.lastIs !== undefined && typeof shape.lastIs !== 'string') {
        problems.push('expect.events.lastIs 须为字符串');
      }
      if (
        shape.mustInclude !== undefined &&
        (!Array.isArray(shape.mustInclude) ||
          !shape.mustInclude.every((item) => typeof item === 'string'))
      ) {
        problems.push('expect.events.mustInclude 须为字符串数组');
      }
    }
  }
  validateFs(record.fs, problems);
}

/** 校验单条 case (按 kind 分流); 返回问题清单 (空数组即通过) */
export function validateCase(data: unknown): string[] {
  const problems: string[] = [];
  const record = asRecord(data);
  if (record === null) return ['case 顶层须为 JSON 对象'];

  if (typeof record.id !== 'string' || !ID_PATTERN.test(record.id)) {
    problems.push('id 缺失或不合 kebab-case 形态 (小写字母数字与 -)');
  }
  const refs = record.specRefs;
  if (
    !Array.isArray(refs) ||
    refs.length === 0 ||
    !refs.every(
      (item) => typeof item === 'string' && SPEC_REF_PATTERN.test(item),
    )
  ) {
    problems.push(
      'specRefs 须为非空数组, 元素为条款编号形态 (如 BC-03 / OF-01 / EC-02)',
    );
  }
  const kind = record.kind ?? 'cli';
  if (kind !== 'cli' && kind !== 'api') {
    problems.push('kind 须为 "cli" 或 "api"');
    return problems;
  }
  validateFixture(record.fixture, problems);
  validateSetup(record.setup, problems);
  if (kind === 'api') {
    if (record.run !== undefined) {
      problems.push('api case 不得含 run (cli 专属, 用 steps 声明调用)');
    }
    validateEnv(record.env, problems);
    validateSteps(record.steps, problems);
    validateApiExpect(record.expect, problems);
  } else {
    if (record.steps !== undefined) {
      problems.push('cli case 不得含 steps (api 专属)');
    }
    if (record.env !== undefined) {
      problems.push('cli case 不得含顶层 env (请用 run.env)');
    }
    validateRun(record.run, problems);
    validateExpect(record.expect, problems);
  }
  return problems;
}
