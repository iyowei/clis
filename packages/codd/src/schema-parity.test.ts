/**
 * `deploy.schema.json` 与 `validateManifest` 双向等价对拍测试:
 * 内置零外部依赖的 JSON Schema draft-07 子集规则执行器 (带未知关键字硬断言防静默漏检),
 * 覆盖正反例矩阵, 验证静态 Schema 判定结果与运行期 `ConfigError` 100% 双向一致。
 *
 * 语法表达力边界说明: JSON Schema draft-07 可表达的全部结构、类型、枚举、数值边界 (含 MAX_SAFE_INTEGER)、
 * 条件依赖 (`mode` / `networkMode` / `os`) 与元素完全去重 (`uniqueItems`) 均已双向对齐;
 * 超出 draft-07 静态语法表达力的跨字段动态相等 (`hostPort === port`)、按子属性去重 (`apps[].db` /
 * `nodes[].name` / `nodes[].host` / `nodes[].bindIp`) 与 SSH 参数词法深检 (`parseSshInput`)
 * 由运行期 `validateManifest` 进一步纵深把守。
 */
import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigError, type DeployManifest, validateManifest } from './index.ts';

type JsonSchema = Record<string, unknown>;

const SOURCE_SCHEMA_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../template/schema',
);

const SUPPORTED_SCHEMA_KEYWORDS = new Set(
  '$schema title description default type required properties additionalProperties enum const minLength maxLength minimum maximum pattern items minItems maxItems uniqueItems allOf anyOf not if then else'.split(
    ' ',
  ),
);

const isPlainObject = (val: unknown): val is Record<string, unknown> =>
  val !== null && typeof val === 'object' && !Array.isArray(val);

const SUBSCHEMA_KEYS = new Set(['items', 'not', 'if', 'then', 'else']);

/** 递归扫描整棵 Schema 树, 确保不存在未被轻量执行器实现的关键字 (防假阳性) */
const assertSupportedSchemaKeywords = (node: unknown, path = '$'): void => {
  if (!isPlainObject(node)) return;
  for (const [key, val] of Object.entries(node)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      throw new Error(`Schema 包含执行器未支持的关键字: ${path}.${key}`);
    }
    if (key === 'properties' && isPlainObject(val)) {
      for (const [pk, ps] of Object.entries(val)) {
        assertSupportedSchemaKeywords(ps, `${path}.properties.${pk}`);
      }
    } else if ((key === 'allOf' || key === 'anyOf') && Array.isArray(val)) {
      for (const [i, sub] of val.entries()) {
        assertSupportedSchemaKeywords(sub, `${path}.${key}[${i}]`);
      }
    } else if (SUBSCHEMA_KEYS.has(key)) {
      assertSupportedSchemaKeywords(val, `${path}.${key}`);
    }
  }
};

const TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
  object: isPlainObject,
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  boolean: (v) => typeof v === 'boolean',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
};

const matchesType = (val: unknown, expectedType: string): boolean => {
  const pred = TYPE_CHECKS[expectedType];
  if (!pred) throw new Error(`未知 JSON Schema type: ${expectedType}`);
  return pred(val);
};

const evalScalarConstraints = (val: unknown, schema: JsonSchema): boolean => {
  if ('const' in schema && !Object.is(val, schema.const)) return false;
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => Object.is(val, item))
  ) {
    return false;
  }
  if (typeof val === 'string') {
    const len = [...val].length;
    if (typeof schema.minLength === 'number' && len < schema.minLength)
      return false;
    if (typeof schema.maxLength === 'number' && len > schema.maxLength)
      return false;
    if (
      typeof schema.pattern === 'string' &&
      !new RegExp(schema.pattern).test(val)
    ) {
      return false;
    }
  }
  if (typeof val === 'number' && Number.isFinite(val)) {
    if (typeof schema.minimum === 'number' && val < schema.minimum)
      return false;
    if (typeof schema.maximum === 'number' && val > schema.maximum)
      return false;
  }
  return true;
};

const evalObjectConstraints = (
  val: Record<string, unknown>,
  schema: JsonSchema,
  recurse: (v: unknown, s: JsonSchema) => boolean,
): boolean => {
  if (Array.isArray(schema.required)) {
    for (const reqKey of schema.required as string[]) {
      if (!Object.hasOwn(val, reqKey) || val[reqKey] === undefined)
        return false;
    }
  }
  const props = isPlainObject(schema.properties) ? schema.properties : {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(val)) {
      if (val[key] !== undefined && !Object.hasOwn(props, key)) return false;
    }
  }
  for (const [propKey, propSchema] of Object.entries(props)) {
    if (
      Object.hasOwn(val, propKey) &&
      val[propKey] !== undefined &&
      isPlainObject(propSchema) &&
      !recurse(val[propKey], propSchema)
    ) {
      return false;
    }
  }
  return true;
};

const jsonDeepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, idx) => jsonDeepEqual(item, b[idx]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => Object.hasOwn(b, k) && jsonDeepEqual(a[k], b[k]));
};

const hasDuplicateJsonItems = (arr: unknown[]): boolean => {
  for (let i = 0; i < arr.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (jsonDeepEqual(arr[j], arr[i])) return true;
    }
  }
  return false;
};

const evalArrayConstraints = (
  val: unknown[],
  schema: JsonSchema,
  recurse: (v: unknown, s: JsonSchema) => boolean,
): boolean => {
  if (typeof schema.minItems === 'number' && val.length < schema.minItems)
    return false;
  if (typeof schema.maxItems === 'number' && val.length > schema.maxItems)
    return false;
  if (schema.uniqueItems === true && hasDuplicateJsonItems(val)) return false;
  if (isPlainObject(schema.items)) {
    for (const item of val) {
      if (!recurse(item, schema.items)) return false;
    }
  }
  return true;
};

const evalCombinators = (
  val: unknown,
  schema: JsonSchema,
  recurse: (v: unknown, s: JsonSchema) => boolean,
): boolean => {
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      if (isPlainObject(sub) && !recurse(val, sub)) return false;
    }
  }
  if (
    Array.isArray(schema.anyOf) &&
    !schema.anyOf.some((sub) => isPlainObject(sub) && recurse(val, sub))
  ) {
    return false;
  }
  if (isPlainObject(schema.not) && recurse(val, schema.not)) return false;
  if (isPlainObject(schema.if)) {
    const cond = recurse(val, schema.if);
    if (cond && isPlainObject(schema.then) && !recurse(val, schema.then))
      return false;
    if (!cond && isPlainObject(schema.else) && !recurse(val, schema.else))
      return false;
  }
  return true;
};

const validateAgainstSchema = (val: unknown, schema: JsonSchema): boolean => {
  if (typeof schema.type === 'string' && !matchesType(val, schema.type)) {
    return false;
  }
  if (!evalScalarConstraints(val, schema)) return false;
  if (
    isPlainObject(val) &&
    !evalObjectConstraints(val, schema, validateAgainstSchema)
  ) {
    return false;
  }
  if (
    Array.isArray(val) &&
    !evalArrayConstraints(val, schema, validateAgainstSchema)
  ) {
    return false;
  }
  return evalCombinators(val, schema, validateAgainstSchema);
};

interface ParityCase {
  label: string;
  input: unknown;
}

const singleBase = (): Record<string, unknown> => ({
  mode: 'single',
  name: 'app',
  apps: [{ db: 'app', user: 'appu' }],
  nodes: [{ os: 'linux', backupDir: '/home/ops/srv/backups' }],
});

const mkRsNode = (name: string, bindIp: string) => ({
  name,
  os: 'linux',
  bindIp,
  backupDir: '/home/ops/b',
});

const rsBase = (): Record<string, unknown> => ({
  mode: 'replica-set',
  name: 'ha',
  apps: [{ db: 'app', user: 'appu' }],
  nodes: [
    mkRsNode('n1', '10.8.0.11'),
    mkRsNode('n2', '10.8.0.12'),
    mkRsNode('n3', '10.8.0.13'),
  ],
});

const k8sBase = (): Record<string, unknown> => ({
  mode: 'k8s-rs',
  name: 'cluster',
  apps: [{ db: 'orders', user: 'orderu' }],
});

const singleCase = (
  label: string,
  patch: Record<string, unknown>,
): ParityCase => ({
  label,
  input: { ...singleBase(), ...patch },
});

const nodeCase = (
  label: string,
  nodePatch: Record<string, unknown>,
): ParityCase =>
  singleCase(label, {
    nodes: [{ os: 'linux', backupDir: '/home/ops/bak', ...nodePatch }],
  });

const buildValidCases = (sample2c2g: unknown): ParityCase[] => [
  { label: '内置 deploy-2c2g.json 参考模板', input: sample2c2g },
  singleCase('空串 keyFile / sshTarget / auth.existingSecret 合法放行', {
    $schema: './deploy.schema.json',
    auth: { keyFile: '', existingSecret: '' },
    nodes: [
      {
        os: 'linux',
        backupDir: '/opt/bak',
        sshTarget: '',
        podmanBin: 'podman',
      },
    ],
  }),
  singleCase('macOS 外挂卷 + 16位 base64 keyFile + 自定义 podmanBin 绝对路径', {
    imageName: 'registry.example.com:5000/team/mongo',
    imageTag: '9.0.8_rc-1',
    bunImage: 'oven/bun:1.4.5-slim',
    tz: 'Etc/GMT+8',
    auth: { keyFile: 'QUJDREVGR0hJSktMTU5PUA==' },
    nodes: [
      {
        os: 'macos',
        bindIp: '0.0.0.0',
        backupDir: '/Volumes/DataDisk/bak',
        stackDir: '/Users/ops/stacks',
        sshTarget: 'ssh -p 2222 ops@192.168.1.20',
        podmanBin: '/opt/homebrew/bin/podman',
      },
    ],
  }),
  {
    label: 'replica-set 3 节点私网 IP + hardware 全字段',
    input: {
      ...rsBase(),
      ...hwPatch({
        cpuCores: 2.5,
        memoryGb: 4.5,
        workload: 'write-heavy',
        expectedAppConnections: 120,
      }),
    },
  },
  {
    label: 'k8s-rs 合规 DNS-1123 子域名 + 2 个可选 nodes',
    input: {
      ...k8sBase(),
      k8s: {
        namespace: 'prod-db',
        releaseName: 'mongo-c1',
        storageClass: 'ebs.csi.aws.com',
        existingSecret: 'vault-mongo.s1',
      },
      nodes: [
        { os: 'linux', backupDir: '/opt/b1' },
        { os: 'macos', backupDir: '/Volumes/Data/b2' },
      ],
    },
  },
  {
    label: 'k8s-single 空串 storageClass 与 existingSecret',
    input: {
      mode: 'k8s-single',
      name: 'k1',
      apps: [{ db: 'app_1-v2', user: 'appu1', password: 'SecretPassword123' }],
      k8s: { storageClass: '', existingSecret: '' },
    },
  },
];

const UNSAFE_INT = Number.MAX_SAFE_INTEGER + 1;
const hwPatch = (p: Record<string, unknown>): Record<string, unknown> => ({
  hardware: { cpuCores: 2, memoryGb: 4, diskGb: 50, ...p },
});

const buildSingleInvalidCases = (): ParityCase[] => {
  const dupApp = { db: 'shop', user: 'shopu' };
  const macNode = { os: 'macos', backupDir: '/Users/ops/bak' };
  const table: Record<string, Record<string, unknown>> = {
    '$schema 为数字': { $schema: 123 },
    '$schema 为布尔值': { $schema: true },
    '手写 fingerprint': { fingerprint: 'a1b2c3d4e5f6' },
    '手写 overrides': { overrides: { wtCacheGb: 2 } },
    'hardware 非对象': { hardware: '2c2g' },
    'hardware 空对象': { hardware: {} },
    'hardware 缺 cpuCores': { hardware: { memoryGb: 4, diskGb: 50 } },
    'hardware 缺 memoryGb': { hardware: { cpuCores: 2, diskGb: 50 } },
    'hardware 缺 diskGb': { hardware: { cpuCores: 2, memoryGb: 4 } },
    'cpuCores 超上限': hwPatch({ cpuCores: 257 }),
    'memoryGb 低于下限': hwPatch({ memoryGb: 0.5 }),
    'diskGb 低于下限': hwPatch({ diskGb: 9 }),
    'workload 非法枚举': hwPatch({ workload: 'olap' }),
    'expectedConns 小数': hwPatch({ expectedAppConnections: 1.5 }),
    'expectedConns 为 0': hwPatch({ expectedAppConnections: 0 }),
    'expectedConns 超界': hwPatch({ expectedAppConnections: UNSAFE_INT }),
    'imageName 含 ../': { imageName: 'org/../mongo' },
    'imageName 含 ..': { imageName: 'mongo..bad' },
    'bunImage 含 ../': { bunImage: 'oven/../bun:1.4' },
    'imageTag 首字符非法': { imageTag: '-9.0.8' },
    'tz 含分号注入': { tz: 'Asia/Shanghai;id' },
    'tz 超 3 级斜杠': { tz: 'A/B/C/D' },
    'apps 完全重复': { apps: [dupApp, { ...dupApp }] },
    'keyFile 过短': { auth: { keyFile: 'QUJDRA==' } },
    'keyFile 非 base64': { auth: { keyFile: 'ABCDEFGHIJKLMNOP$%' } },
    'keyFile 含空格': { auth: { keyFile: '  QUJDREVGR0hJSktMTU5PUA==  ' } },
    'keyFile 含换行': { auth: { keyFile: 'QUJDREVGR0hJSktMTU5PUA==\n' } },
    'host + macOS': { networkMode: 'host', nodes: [macNode] },
  };
  const intKeys = 'keepDaily keepWeekly backupMinFreeMb backupMaxTotalMb'.split(
    ' ',
  );
  return [
    ...Object.entries(table).map(([k, p]) => singleCase(k, p)),
    ...intKeys.map((k) => singleCase(`${k} 超界`, { [k]: UNSAFE_INT })),
    ...['admin', 'local', 'config'].map((db) =>
      singleCase(`保留库 ${db}`, { apps: [{ db, user: 'u1' }] }),
    ),
  ];
};

const buildNodeInvalidCases = (): ParityCase[] => {
  const table: Record<string, Record<string, unknown>> = {
    'sshTarget 纯空白': { sshTarget: '   ' },
    'sshTarget 分号注入': { sshTarget: 'ops@10.0.0.2;id' },
    'bindIp 首段超界': { bindIp: '999.0.0.1' },
    'bindIp 末段超界': { bindIp: '10.0.0.256' },
    'bindIp 前导零': { bindIp: '01.0.0.1' },
    'podmanBin 含 ..': { podmanBin: '/opt/../bin/podman' },
    'podmanBin 为 ..': { podmanBin: '..' },
    'backupDir 含 ..': { backupDir: '/home/ops/../bak' },
    'backupDir 含 CHANGE_ME': { backupDir: '/home/CHANGE_ME/bak' },
    'stackDir 含 ..': { stackDir: '/home/ops/../stacks' },
    'stackDir 含 CHANGE_ME': { stackDir: '/home/CHANGE_ME/stacks' },
    'macOS 命中 /System': { os: 'macos', backupDir: '/System/Volumes/x' },
  };
  return Object.entries(table).map(([k, p]) => nodeCase(k, p));
};

const buildTopologyInvalidCases = (): ParityCase[] => {
  const linuxNode = { os: 'linux', backupDir: '/opt/bak' };
  const macNode = { os: 'macos', backupDir: '/Users/ops/bak' };
  const k8sTable: Record<string, Record<string, unknown>> = {
    'auth.existingSecret 大写': { auth: { existingSecret: 'Bad_Secret' } },
    'k8s.storageClass 非法': { k8s: { storageClass: 'gp3_fast' } },
    'k8s.existingSecret 超长': { k8s: { existingSecret: 'a'.repeat(254) } },
    'k8s.namespace 大写': { k8s: { namespace: 'ProdNS' } },
    'k8s host + macOS': { networkMode: 'host', nodes: [macNode] },
    'k8s 非数组 nodes': { nodes: 'not-an-array' },
    'k8s nodes 非法目录': { nodes: [{ os: 'linux', backupDir: '/etc/x' }] },
    'k8s nodes 非法 os': { nodes: [{ os: 'windows', backupDir: '/opt/bak' }] },
    'k8s nodes 完全重复': { nodes: [linuxNode, { ...linuxNode }] },
  };
  const [n1, n2, n3] = [
    mkRsNode('n1', '10.8.0.11'),
    mkRsNode('n2', '10.8.0.12'),
    mkRsNode('n3', '10.8.0.13'),
  ];
  return [
    { label: '顶层 null', input: null },
    { label: '顶层数组', input: [] },
    { label: '缺必填 apps', input: { mode: 'single', name: 'app', nodes: [] } },
    ...Object.entries(k8sTable).map(([label, p]) => ({
      label,
      input: { ...k8sBase(), ...p },
    })),
    {
      label: 'rs bindIp 127.0.0.1',
      input: { ...rsBase(), nodes: [mkRsNode('n1', '127.0.0.1'), n2, n3] },
    },
    {
      label: 'rs bindIp 0.0.0.0',
      input: { ...rsBase(), nodes: [mkRsNode('n1', '0.0.0.0'), n2, n3] },
    },
    {
      label: 'rs nodes 完全重复',
      input: { ...rsBase(), nodes: [n1, { ...n1 }, n3] },
    },
  ];
};

const buildInvalidCases = (): ParityCase[] => [
  ...buildSingleInvalidCases(),
  ...buildNodeInvalidCases(),
  ...buildTopologyInvalidCases(),
];

describe('deploy.schema.json 与 validateManifest 双向等价对拍', () => {
  const schema = JSON.parse(
    readFileSync(join(SOURCE_SCHEMA_DIR, 'deploy.schema.json'), 'utf8'),
  ) as JsonSchema;
  const sample2c2g = JSON.parse(
    readFileSync(join(SOURCE_SCHEMA_DIR, 'deploy-2c2g.json'), 'utf8'),
  ) as unknown;

  test('轻量 Schema 执行器完整支持 deploy.schema.json 全部关键字', () => {
    expect(() => assertSupportedSchemaKeywords(schema)).not.toThrow();
  });

  test('全部正例同时通过 deploy.schema.json 与 validateManifest', () => {
    for (const c of buildValidCases(sample2c2g)) {
      expect(validateAgainstSchema(c.input, schema), c.label).toBe(true);
      expect(
        () => validateManifest(c.input as DeployManifest),
        c.label,
      ).not.toThrow();
    }
  });

  test('全部反例同时被 deploy.schema.json 拒收且 validateManifest 统一抛 ConfigError', () => {
    for (const c of buildInvalidCases()) {
      expect(validateAgainstSchema(c.input, schema), c.label).toBe(false);
      expect(
        () => validateManifest(c.input as DeployManifest),
        c.label,
      ).toThrow(ConfigError);
    }
  });
});
