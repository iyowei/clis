/**
 * 转写契约套件 · 语料手写校验层 (schema 的物化子集)。
 * 调用方: `corpus.ts` (`loadCorpus` 逐条校验) 与 `validate-coverage.ts` (共用 CLAUSE_ID_SOURCE / SPEC_REF_PATTERN)。
 *
 * 职责: 对读入的单条 case 做结构校验 (cli 与 api 两类按 kind 分流, 全层级拦截未知属性与重复项),
 * 返回可读问题清单; 字段语义以对应产品包的 `docs/protocol/conformance/corpus.schema.json` 为准。
 */
import { isAbsolute } from 'node:path';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const keysOf = (csv: string): ReadonlySet<string> => new Set(csv.split(','));
const isNonEmptyStr = (v: unknown): v is string =>
  typeof v === 'string' && v !== '';
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');
const isStringRecord = (v: unknown): boolean => {
  const r = asRecord(v);
  return r !== null && Object.values(r).every((s) => typeof s === 'string');
};

const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** 契约条款编号统一形态 (单源: validate.ts 与 validate-coverage.ts 共用) */
export const CLAUSE_ID_SOURCE = '(?:BC|OF|EC)-\\d+';
export const SPEC_REF_PATTERN = new RegExp(`^${CLAUSE_ID_SOURCE}$`);

const TOP_KEYS = keysOf(
  'id,kind,tags,specRefs,fixture,setup,run,env,steps,expect',
);
const FIXTURE_KEYS = keysOf('projects,symlinks,unreadable,readonly');
const PROJECT_KEYS = keysOf('dir,files,bytesPerFile,nested,git,noPackageJson');
const SYMLINK_KEYS = keysOf('at,to');
const SETUP_ITEM_KEYS = keysOf('write');
const SETUP_WRITE_KEYS = keysOf('path,text,mtimeMs,ageDays');
const RUN_KEYS = keysOf('argv,env,cwd');
const STEP_KEYS = keysOf('as,call,collectEvents');
const STEP_CALL_KEYS = keysOf('export,on,method,args');
const EXPECT_KEYS = keysOf(
  'exitCode,stdoutExact,stdoutContains,stdoutMustNotContain,stderrExact,stderrContains,stderrMustNotContain,result,error,events,fs',
);
const RESULT_KEYS = keysOf('exact,subset');
const ERROR_KEYS = keysOf('code,name,detailsSubset');
const EVENTS_KEYS = keysOf('lastIs,mustInclude,mustNotInclude');
const FS_ITEM_KEYS = keysOf('path,state,kind,contains,globExists');
const CLI_STRING_ARRAY_KEYS =
  'stdoutContains,stdoutMustNotContain,stderrContains,stderrMustNotContain'.split(
    ',',
  );
const CLI_ONLY_EXPECT_KEYS = [
  'exitCode',
  'stdoutExact',
  'stderrExact',
  ...CLI_STRING_ARRAY_KEYS,
];

/** 拒绝 schema additionalProperties: false 对象上的未知键 (防拼写错误静默假绿) */
function checkAllowedKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  problems: string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) problems.push(`${path} 含未知属性 "${key}"`);
  }
}

/** 校验字符串数组 uniqueItems: true */
function checkUniqueStrings(
  items: readonly unknown[],
  path: string,
  problems: string[],
): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'string') continue;
    if (seen.has(item)) {
      problems.push(`${path} 含重复元素 "${item}"`);
      return;
    }
    seen.add(item);
  }
}

/** 相对路径判定: 非空、非绝对 (含 win 盘符)、不含反斜杠与 '..' 段 */
function isSafeRelPath(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  if (isAbsolute(value) || /^[a-zA-Z]:/.test(value)) return false;
  return !value.includes('\\') && !value.split('/').includes('..');
}

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
  checkAllowedKeys(
    project,
    PROJECT_KEYS,
    `fixture.projects[${index}]`,
    problems,
  );
  for (const key of ['files', 'bytesPerFile'] as const) {
    const val = project[key];
    if (val !== undefined && (!Number.isInteger(val) || (val as number) < 0)) {
      problems.push(`fixture.projects[${index}].${key} 须为非负整数`);
    }
  }
  for (const key of ['nested', 'git', 'noPackageJson'] as const) {
    if (project[key] !== undefined && typeof project[key] !== 'boolean') {
      problems.push(`fixture.projects[${index}].${key} 须为布尔`);
    }
  }
}

function validateSymlinkEntry(
  item: unknown,
  index: number,
  problems: string[],
): void {
  const link = asRecord(item);
  if (link === null || !isSafeRelPath(link.at) || !isSafeRelPath(link.to)) {
    problems.push(`fixture.symlinks[${index}] 的 at / to 须为相对路径`);
    return;
  }
  checkAllowedKeys(link, SYMLINK_KEYS, `fixture.symlinks[${index}]`, problems);
}

function validateFixture(fixture: unknown, problems: string[]): void {
  const record = asRecord(fixture);
  if (record === null) {
    problems.push('fixture 缺失或不是对象');
    return;
  }
  checkAllowedKeys(record, FIXTURE_KEYS, 'fixture', problems);
  if (record.projects !== undefined) {
    if (!Array.isArray(record.projects)) {
      problems.push('fixture.projects 须为数组');
    } else {
      for (const [i, item] of record.projects.entries()) {
        validateProjectEntry(item, i, problems);
      }
    }
  }
  if (record.symlinks !== undefined) {
    if (!Array.isArray(record.symlinks)) {
      problems.push('fixture.symlinks 须为数组');
    } else {
      for (const [i, item] of record.symlinks.entries()) {
        validateSymlinkEntry(item, i, problems);
      }
    }
  }
  for (const key of ['unreadable', 'readonly'] as const) {
    const list = record[key];
    if (
      list !== undefined &&
      (!Array.isArray(list) || !list.every(isSafeRelPath))
    ) {
      problems.push(`fixture.${key} 须为相对路径数组`);
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
      step === null ||
      write === null ||
      !isSafeRelPath(write.path) ||
      typeof write.text !== 'string'
    ) {
      problems.push(
        `setup[${index}] 须为 { write: { path: 相对路径, text: 字符串 } }`,
      );
      continue;
    }
    checkAllowedKeys(step, SETUP_ITEM_KEYS, `setup[${index}]`, problems);
    checkAllowedKeys(
      write,
      SETUP_WRITE_KEYS,
      `setup[${index}].write`,
      problems,
    );
    if (
      write.mtimeMs !== undefined &&
      (typeof write.mtimeMs !== 'number' || !Number.isFinite(write.mtimeMs))
    ) {
      problems.push(`setup[${index}].write.mtimeMs 须为有限数字`);
    }
    if (
      write.ageDays !== undefined &&
      (typeof write.ageDays !== 'number' ||
        !Number.isFinite(write.ageDays) ||
        write.ageDays < 0)
    ) {
      problems.push(`setup[${index}].write.ageDays 须为非负有限数字`);
    }
  }
}

function validateRun(run: unknown, problems: string[]): void {
  const record = asRecord(run);
  if (record === null) {
    problems.push('run 缺失或不是对象');
    return;
  }
  checkAllowedKeys(record, RUN_KEYS, 'run', problems);
  if (record.argv !== undefined && !isStringArray(record.argv)) {
    problems.push('run.argv 须为字符串数组');
  }
  if (record.env !== undefined && !isStringRecord(record.env)) {
    problems.push('run.env 须为字符串值对象');
  }
  if (record.cwd !== undefined && !isSafeRelPath(record.cwd)) {
    problems.push('run.cwd 须为相对路径');
  }
}

function validateFsEntry(
  item: unknown,
  index: number,
  problems: string[],
): void {
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
    return;
  }
  checkAllowedKeys(entry, FS_ITEM_KEYS, `expect.fs[${index}]`, problems);
  if (
    entry.kind !== undefined &&
    !['file', 'dir', 'symlink'].includes(String(entry.kind))
  ) {
    problems.push(`expect.fs[${index}].kind 须为 file|dir|symlink`);
  }
  if (entry.contains !== undefined && !isStringArray(entry.contains)) {
    problems.push(`expect.fs[${index}].contains 须为字符串数组`);
  }
  if (entry.globExists !== undefined && !isNonEmptyStr(entry.globExists)) {
    problems.push(`expect.fs[${index}].globExists 须为非空字符串`);
  }
}

function validateFs(fs: unknown, problems: string[]): void {
  if (fs === undefined) return;
  if (!Array.isArray(fs)) {
    problems.push('expect.fs 须为数组');
    return;
  }
  for (const [index, item] of fs.entries())
    validateFsEntry(item, index, problems);
}

function validateExpect(expect: unknown, problems: string[]): void {
  const record = asRecord(expect);
  if (record === null) {
    problems.push('expect 缺失或不是对象');
    return;
  }
  checkAllowedKeys(record, EXPECT_KEYS, 'expect', problems);
  for (const key of ['result', 'error', 'events'] as const) {
    if (record[key] !== undefined) {
      problems.push(`expect.${key} 仅 api case 可用 (本 case 为 cli)`);
    }
  }
  if (!Number.isInteger(record.exitCode)) {
    problems.push('expect.exitCode 须为整数 (cli case 必填)');
  }
  for (const key of ['stdoutExact', 'stderrExact'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') {
      problems.push(`expect.${key} 须为字符串`);
    }
  }
  for (const key of CLI_STRING_ARRAY_KEYS) {
    if (record[key] !== undefined && !isStringArray(record[key])) {
      problems.push(`expect.${key} 须为字符串数组`);
    }
  }
  validateFs(record.fs, problems);
}

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
    checkAllowedKeys(step, STEP_KEYS, `steps[${index}]`, problems);
    checkAllowedKeys(call, STEP_CALL_KEYS, `steps[${index}].call`, problems);
    const hasExport = 'export' in call;
    const hasOn = 'on' in call;
    const hasMethod = 'method' in call;
    const validCreate =
      hasExport && !hasOn && !hasMethod && isNonEmptyStr(call.export);
    const validMethod =
      !hasExport &&
      hasOn &&
      hasMethod &&
      isNonEmptyStr(call.on) &&
      isNonEmptyStr(call.method);
    if (!validCreate && !validMethod) {
      problems.push(
        `steps[${index}].call 须恰为创建步 (export) 或方法步 (on + method)`,
      );
    }
    if (hasExport && 'collectEvents' in step) {
      problems.push(`steps[${index}]: 创建步不支持 collectEvents (仅方法步)`);
    }
    if (step.as !== undefined && !isNonEmptyStr(step.as)) {
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

function validateApiEvents(events: unknown, problems: string[]): void {
  if (events === undefined) return;
  const shape = asRecord(events);
  if (shape === null) {
    problems.push('expect.events 须为对象');
    return;
  }
  checkAllowedKeys(shape, EVENTS_KEYS, 'expect.events', problems);
  if (shape.lastIs !== undefined && typeof shape.lastIs !== 'string') {
    problems.push('expect.events.lastIs 须为字符串');
  }
  for (const key of ['mustInclude', 'mustNotInclude'] as const) {
    if (shape[key] !== undefined && !isStringArray(shape[key])) {
      problems.push(`expect.events.${key} 须为字符串数组`);
    }
  }
}

function validateApiExpect(expect: unknown, problems: string[]): void {
  const record = asRecord(expect);
  if (record === null) {
    problems.push('expect 缺失或不是对象');
    return;
  }
  checkAllowedKeys(record, EXPECT_KEYS, 'expect', problems);
  for (const key of CLI_ONLY_EXPECT_KEYS) {
    if (record[key] !== undefined) {
      problems.push(`expect.${key} 仅 cli case 可用 (本 case 为 api)`);
    }
  }
  const { result, error, events, fs } = record;
  if (result !== undefined && error !== undefined) {
    problems.push('expect.result 与 expect.error 互斥, 不能同时声明');
  }
  if (
    result === undefined &&
    error === undefined &&
    events === undefined &&
    fs === undefined
  ) {
    problems.push(
      'api case 的 expect 须至少含 result / error / events / fs 之一',
    );
  }
  if (result !== undefined) {
    const shape = asRecord(result);
    if (shape === null || 'exact' in shape === 'subset' in shape) {
      problems.push('expect.result 须恰含 exact 或 subset 之一');
    } else {
      checkAllowedKeys(shape, RESULT_KEYS, 'expect.result', problems);
    }
  }
  if (error !== undefined) {
    const shape = asRecord(error);
    if (shape === null || typeof shape.code !== 'string' || shape.code === '') {
      problems.push('expect.error 须含非空字符串 code');
    } else {
      checkAllowedKeys(shape, ERROR_KEYS, 'expect.error', problems);
      if (shape.name !== undefined && typeof shape.name !== 'string') {
        problems.push('expect.error.name 须为字符串');
      }
    }
  }
  validateApiEvents(events, problems);
  validateFs(fs, problems);
}

/** 校验单条 case (按 kind 分流); 返回问题清单 (空数组即通过) */
export function validateCase(data: unknown): string[] {
  const problems: string[] = [];
  const record = asRecord(data);
  if (record === null) return ['case 顶层须为 JSON 对象'];
  checkAllowedKeys(record, TOP_KEYS, 'case', problems);

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
  } else {
    checkUniqueStrings(refs, 'specRefs', problems);
  }
  const kind = record.kind === undefined ? 'cli' : record.kind;
  if (kind !== 'cli' && kind !== 'api') {
    problems.push('kind 须为 "cli" 或 "api"');
    return problems;
  }
  if (record.tags !== undefined) {
    if (!isStringArray(record.tags) || record.tags.some((t) => t === '')) {
      problems.push('tags 须为非空字符串数组');
    } else {
      checkUniqueStrings(record.tags, 'tags', problems);
    }
  }
  validateFixture(record.fixture, problems);
  validateSetup(record.setup, problems);
  if (kind === 'api') {
    if (record.run !== undefined) {
      problems.push('api case 不得含 run (cli 专属, 用 steps 声明调用)');
    }
    if (record.env !== undefined && !isStringRecord(record.env)) {
      problems.push('env 须为字符串值对象');
    }
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
