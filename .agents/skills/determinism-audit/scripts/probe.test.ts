import { afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { listAllInstalledSkills, splitPathPrefixes } from './discovery.ts';
import { resolveSkillBundle } from './resolver.ts';
import { scanResolvedBundle } from './scanner.ts';
import type { ProbeReport, SkillListReport } from './types.ts';
import { PROBE_SCHEMA_VERSION } from './types.ts';

interface SchemaNode {
  $ref?: string;
  oneOf?: SchemaNode[];
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  minimum?: number;
  minLength?: number;
  items?: SchemaNode;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  additionalProperties?: boolean | SchemaNode;
  $defs?: Record<string, SchemaNode>;
}

const SCHEMA = JSON.parse(
  fs.readFileSync(join(import.meta.dir, 'probe_report.schema.json'), 'utf8'),
) as SchemaNode;
const TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
  null: (v) => v === null,
  boolean: (v) => typeof v === 'boolean',
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  string: (v) => typeof v === 'string',
  array: Array.isArray,
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};

function validateObj(
  obj: Record<string, unknown>,
  node: SchemaNode,
  root: SchemaNode,
  at: string,
): void {
  expect(node.properties !== undefined, `${at} 空壳`).toBe(true);
  for (const req of node.required ?? []) {
    expect(req in obj && obj[req] !== undefined, `${at}.${req}`).toBe(true);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const prop = node.properties?.[k];
    if (prop !== undefined) assertValidBySchema(v, prop, root, `${at}.${k}`);
    else if (node.additionalProperties === false) {
      expect(false, `${at} 多余字段 ${k}`).toBe(true);
    }
  }
}

function assertValidBySchema(
  val: unknown,
  node: SchemaNode,
  root: SchemaNode = SCHEMA,
  at = '$',
): void {
  if (node.$ref !== undefined) {
    const target = root.$defs?.[node.$ref.replace('#/$defs/', '')];
    expect(target, node.$ref).toBeDefined();
    assertValidBySchema(val, target!, root, at);
    return;
  }
  if (node.oneOf !== undefined) {
    let ok = 0;
    for (const b of node.oneOf) {
      try {
        assertValidBySchema(val, b, root, at);
        ok += 1;
      } catch {}
    }
    expect(ok, `${at} oneOf`).toBe(1);
    return;
  }
  if (node.const !== undefined) expect(val, at).toBe(node.const);
  if (node.enum !== undefined) expect(node.enum.includes(val), at).toBe(true);
  if (node.type !== undefined) {
    const ts = Array.isArray(node.type) ? node.type : [node.type];
    expect(
      ts.some((t) => TYPE_CHECKS[t]?.(val) === true),
      at,
    ).toBe(true);
  }
  if (typeof val === 'string' && node.minLength !== undefined) {
    expect(val.length >= node.minLength, at).toBe(true);
  }
  if (typeof val === 'number' && node.minimum !== undefined) {
    expect(val >= node.minimum, at).toBe(true);
  }
  if (Array.isArray(val) && node.items !== undefined) {
    for (let i = 0; i < val.length; i += 1) {
      assertValidBySchema(val[i], node.items, root, `${at}[${i}]`);
    }
  }
  if (TYPE_CHECKS.object!(val)) {
    validateObj(val as Record<string, unknown>, node, root, at);
  }
}

const createdDirs: string[] = [];

function makeSandbox(
  prefix: string,
  files: Record<string, string> = {},
): string {
  const base = join(homedir(), 'tmp');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(join(base, prefix));
  createdDirs.push(root);
  for (const [rel, txt] of Object.entries(files)) {
    const abs = join(root, rel);
    fs.mkdirSync(dirname(abs), { recursive: true });
    fs.writeFileSync(abs, txt);
  }
  return root;
}

function probeLocal(
  target: string,
  cwd: string,
  disableDotai = true,
  max = 25,
) {
  const rep = scanResolvedBundle(
    resolveSkillBundle(target, { cwd, disableDotai }),
    cwd,
    max,
  );
  assertValidBySchema(JSON.parse(JSON.stringify(rep)), SCHEMA);
  return rep;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    fs.rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
});

describe('基础拓扑与脚本化形态判定', () => {
  test('识别纯文本全仓扫描 skill 为 pure-prompt-skill 并精准定位步骤', () => {
    const root = makeSandbox('da-pure-', {
      '.agents/skills/manual-cia/SKILL.md':
        '---\nname: manual-cia\ndescription: manual impact scanner\n---\n\n## 执行步骤\n\n1. 读 `git diff HEAD`, 提取变更契约。\n2. 按载体分层全仓扫描连带修改点: 代码内部调用点与导出面、测试断言、文档与配置, 逐条列出位置。\n3. 输出 Markdown 清单。',
    });
    const report = probeLocal(join(root, '.agents/skills/manual-cia'), root);
    expect(report.schemaVersion).toBe(PROBE_SCHEMA_VERSION);
    expect(report.architectureShape).toBe('pure-prompt-skill');
    expect(report.engineeringFootprint.implScriptCount).toBe(0);
    expect(report.summaryForJudge.unbackedHotspotCount).toBeGreaterThanOrEqual(
      1,
    );
    const step2 = report.candidateHotspots.find((h) =>
      h.section.includes('步骤 2'),
    );
    expect(step2?.likelyBackedByScript).toBe(false);
    expect(step2?.categories).toContain('FULL_REPO_SCAN');
    expect(step2?.categories).toContain('AST_OR_DEPENDENCY_GRAPH');
  });

  test('识别脚本闭环 skill 为 script-backed-loop 且严防同节向后误洗白', () => {
    const code = Array.from(
      { length: 40 },
      (_, i) => `export const v${i} = ${i};`,
    ).join('\n');
    const root = makeSandbox('da-backed-', {
      '.agents/skills/mixed-loop/scripts/runner.ts': code,
      '.agents/skills/mixed-loop/scripts/runner.test.ts':
        'import { expect, test } from "bun:test";\ntest("ok", () => expect(1).toBe(1));\n',
      '.agents/skills/mixed-loop/scripts/report.schema.json':
        '{"type":"object"}\n',
      '.agents/skills/mixed-loop/SKILL.md':
        '---\nname: mixed-loop\ndescription: mixed runner skill\n---\n\n## 工作流\n\n1. 运行 `bun .agents/skills/mixed-loop/scripts/runner.ts scan` 完成全仓扫描。\n2. 逐条比对 Markdown 死链并手动维护台账与回滚状态。',
    });
    const report = probeLocal(join(root, '.agents/skills/mixed-loop'), root);
    const step1 = report.candidateHotspots.find((h) =>
      h.section.includes('步骤 1'),
    );
    const step2 = report.candidateHotspots.find((h) =>
      h.section.includes('步骤 2'),
    );
    expect(step1?.likelyBackedByScript).toBe(true);
    expect(step2?.likelyBackedByScript).toBe(false);
    expect(step2?.nearbyScripts).toEqual([]);
  });

  test('同级 ## 标题正确弹栈, 4 反引号嵌套围栏不提前闭合, 且反例命令行不误报', () => {
    const root = makeSandbox('da-headings-', {
      '.agents/skills/self-guard/SKILL.md':
        '---\nname: self-guard\ndescription: fences\n---\n## 派发模式\n❌ grep "pattern" path\n严禁派 ${SKILL_REF:self-guard} 自身造成递归。\n````markdown\n```shell\n# 伪标题不应切块\n全仓扫描导出面与死链\n```\n仍在 4 反引号代码块内: 逐条比对死链与枚举成员\n````\n## 稳定性循环模式\n1. 人工计数连续全 PASS 轮次并维护台账。',
    });
    const report = probeLocal(join(root, '.agents/skills/self-guard'), root);
    expect(report.linkedSkills).not.toContain('self-guard');
    expect(report.executedCommandRefs.length).toBe(0);
    expect(report.candidateHotspots).toHaveLength(1);
    expect(report.candidateHotspots[0]?.section).toBe('稳定性循环模式');
  });
});

describe('软链入参、转发薄壳与多级祖先追踪', () => {
  test('支持直接传入指向目录的符号链接路径, 且解包下游测试与 Schema (含 disallowedTools 递归契约校验)', () => {
    const code = Array.from(
      { length: 30 },
      (_, i) => `export const g${i} = ${i};`,
    ).join('\n');
    const root = makeSandbox('da-dispatch-', {
      'dotAI/targets/codex/skills/proxy-check/SKILL.md':
        '---\nname: proxy-check\ndescription: thin wrapper\n---\n\n本 skill 是转发薄壳: 严禁当前会话自行执行, 必须立即派发 proxy-worker 子代理全权处理。',
      'dotAI/src/skills/proxy-check.md':
        '---\ndescription: thin wrapper\ndispatch: proxy-worker\n---\n转发输入给执行体。',
      'dotAI/src/agents/proxy-worker.md':
        '---\nname: proxy-worker\nclaude:\n  disallowedTools: Edit, Write\n---\n## 执行步骤\n\n运行 `bun ${RESOURCES_ROOT}/auditor/run_gates.ts` 校验 schema 与死链。',
      'dotAI/src/resources/auditor/run_gates.ts': code,
      'dotAI/src/resources/auditor/run_gates.test.ts':
        'import { expect, test } from "bun:test";\ntest("gate", () => expect(1).toBe(1));\n',
      'dotAI/src/resources/auditor/audit.schema.json': '{"type":"object"}\n',
      'dotAI/src/resources/auditor/README.md': '# Auditor Resources\n',
    });
    fs.mkdirSync(join(root, '.agents/skills'), { recursive: true });
    const installedLink = join(root, '.agents/skills/proxy-check');
    fs.symlinkSync(
      join(root, 'dotAI/targets/codex/skills/proxy-check'),
      installedLink,
    );

    const reportByLink = probeLocal(installedLink, root, false);
    expect(reportByLink.isThinDispatcher).toBe(true);
    expect(reportByLink.forwardedAgents).toContain('proxy-worker');
    expect(reportByLink.architectureShape).toBe('script-backed-loop');
    const agentDoc = reportByLink.documents.find(
      (d) => d.role === 'forwarded-agent',
    );
    expect(agentDoc?.disallowedTools).toEqual(['Edit', 'Write']);

    const reportBySource = probeLocal(
      join(root, 'dotAI/src/skills/proxy-check.md'),
      root,
      false,
    );
    const activeDocs = reportBySource.documents.filter(
      (d) => !d.excludedFromHotspotScan,
    );
    expect(activeDocs.some((d) => d.role === 'skill-compiled-mirror')).toBe(
      false,
    );
  });

  test('转发薄壳目标 agent 不存在时, 明确标记 unresolved-dispatcher 与缺失坐标并通过递归 Schema', () => {
    const root = makeSandbox('da-missing-', {
      '.agents/skills/ghost-dispatch/SKILL.md':
        '---\nname: ghost-dispatch\ndescription: broken wrapper\n---\n\n本 skill 是转发薄壳: 必须立即派发 nonexistent-ghost-agent 子代理执行全仓扫描。',
    });
    const report = probeLocal(
      join(root, '.agents/skills/ghost-dispatch'),
      root,
    );
    expect(report.architectureShape).toBe('unresolved-dispatcher');
    expect(report.unresolvedTargets[0]?.reference).toBe(
      'nonexistent-ghost-agent',
    );
  });
});

describe('超 25 热区不误降级、落盘归档一致性与 Schema 深度自证', () => {
  test('仅配末步校验脚本判为 hybrid-assisted; 大型 script-backed-loop 超 25 热区不因截断误算 backed=0', () => {
    const unbacked = Array.from(
      { length: 26 },
      (_, i) => `## 手工节 ${i + 1}\n逐条比对死链与枚举成员 ${i + 1}。`,
    );
    const backed = Array.from(
      { length: 30 },
      (_, i) =>
        `## 脚本节 ${i + 1}\n运行 \`bun scripts/engine.ts\` 全仓扫描导出面 ${i + 1}。`,
    );
    const root = makeSandbox('da-hybrid-', {
      '.agents/skills/partial-audit/validate.cjs': Array.from(
        { length: 120 },
        (_, i) => `const x${i} = ${i};`,
      ).join('\n'),
      '.agents/skills/partial-audit/report.schema.json': '{"type":"object"}\n',
      '.agents/skills/partial-audit/SKILL.md':
        '---\nname: partial-audit\ndescription: partial\n---\n\n## 第 1 步\n全仓扫描并列出所有导出面与调用点。\n\n## 第 2 步\n逐条比对所有 Markdown 相对链接是否存在死链。\n\n## 第 3 步\n检查全部默认值与枚举成员并计数汇总。\n\n## 第 4 步\n运行 `node validate.cjs report.json` 检查输出。',
      '.agents/skills/large-backed/scripts/engine.ts': Array.from(
        { length: 200 },
        (_, i) => `export const k${i} = ${i};`,
      ).join('\n'),
      '.agents/skills/large-backed/SKILL.md': [
        '---\nname: large-backed\ndescription: >25\n---',
        ...unbacked,
        ...backed,
      ].join('\n\n'),
    });

    const partial = probeLocal(
      join(root, '.agents/skills/partial-audit'),
      root,
    );
    expect(partial.architectureShape).toBe('hybrid-assisted');
    expect(partial.summaryForJudge.unbackedHotspotCount).toBe(3);
    expect(partial.summaryForJudge.backedHotspotCount).toBe(1);

    const large = probeLocal(
      join(root, '.agents/skills/large-backed'),
      root,
      true,
      25,
    );
    expect(large.candidateHotspots).toHaveLength(25);
    expect(large.summaryForJudge.totalRawHotspotCount).toBe(56);
    expect(large.summaryForJudge.unbackedHotspotCount).toBe(26);
    expect(large.summaryForJudge.backedHotspotCount).toBe(30);
    expect(large.architectureShape).toBe('script-backed-loop');
  });

  test('CLI 落盘归档 JSON 含 archivePath 且与 stdout 完全一致, 自身 ProbeReport 递归对齐 Schema', () => {
    for (const [name, def] of Object.entries(SCHEMA.$defs ?? {})) {
      if (def.type === 'object') {
        expect(def.additionalProperties, `${name} 须锁紧`).toBe(false);
        expect(def.properties, `${name} 须声明 properties`).toBeDefined();
      }
    }
    const selfSkillDir = join(import.meta.dir, '..');
    probeLocal(selfSkillDir, join(selfSkillDir, '../../..'));

    const root = makeSandbox('da-archive-', {
      '.agents/skills/archive-check/SKILL.md':
        '---\nname: archive-check\ndescription: parity\n---\n## 边界\n- 与 `${SKILL_REF:coder}` 和 `${AGENT_REF:rv}` 分工协作, 本文不直接派发.\n## 步骤\n1. 全仓扫描调用点。\n',
    });
    const fakeHome = join(root, 'fake-home');
    const skillDir = join(root, '.agents/skills/archive-check');
    const cliRes = spawnSync(
      'bun',
      [join(import.meta.dir, 'probe.ts'), 'probe', skillDir, '--no-dotai'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
      },
    );
    expect(cliRes.status).toBe(0);
    const archiveFile = join(
      fakeHome,
      'tmp/determinism-audit/archive-check.probe.json',
    );
    expect(fs.existsSync(archiveFile)).toBe(true);
    const archivedRaw = fs.readFileSync(archiveFile, 'utf8');
    expect(archivedRaw).toBe(cliRes.stdout);
    const archivedJson = JSON.parse(archivedRaw) as ProbeReport;
    expect(archivedJson.archivePath).toBe(
      '~/tmp/determinism-audit/archive-check.probe.json',
    );
    assertValidBySchema(archivedJson, SCHEMA);
    expect(archivedJson.forwardedAgents).toEqual([]);
    expect(archivedJson.linkedSkills).toEqual([]);
  });
});

describe('list --dotai-root 与跨平台路径前缀', () => {
  test('[P1-2] list --dotai-root 输出严格递归符合 SkillListReport Schema, 且 splitPathPrefixes 跨平台兼容', () => {
    const root = makeSandbox('da-list-dotai-', {
      '.agents/skills/ws-dir-skill/SKILL.md':
        '---\nname: ws-dir-skill\ndescription: ws\n---\n# WS\n',
      'custom-dotai/targets/codex/skills/mirrored-skill/SKILL.md':
        '---\nname: mirrored-skill\ndescription: m\n---\n# M\n',
      'custom-dotai/src/skills/mirrored-skill.md':
        '---\nname: mirrored-skill\ndescription: s\n---\n# S\n',
      'custom-dotai/src/skills/flat-alpha.md':
        '---\nname: flat-alpha\ndescription: f\n---\n1. 全仓扫描导出面。\n',
      'custom-dotai/src/skills/nested-dir-skill/SKILL.md':
        '---\nname: nested-dir-skill\ndescription: d\n---\n# D\n',
      'custom-dotai/src/skills/README.md': '# Index\n',
    });
    const fakeHome = join(root, 'isolated-home');
    const dotai = join(root, 'custom-dotai');
    fs.mkdirSync(join(fakeHome, '.agents/skills'), { recursive: true });
    fs.mkdirSync(join(dotai, 'src/agents'), { recursive: true });
    fs.symlinkSync(
      join(dotai, 'targets/codex/skills/mirrored-skill'),
      join(fakeHome, '.agents/skills/mirrored-skill'),
    );

    const cliRes = spawnSync(
      'bun',
      [join(import.meta.dir, 'probe.ts'), 'list', '--dotai-root', dotai],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
      },
    );
    expect(cliRes.status).toBe(0);
    const parsed = JSON.parse(cliRes.stdout) as SkillListReport;
    assertValidBySchema(parsed, SCHEMA);
    expect(parsed.dotaiRoot).toBe(dotai);
    expect(parsed.skills.map((s) => s.name).sort()).toEqual([
      'flat-alpha',
      'mirrored-skill',
      'nested-dir-skill',
      'ws-dir-skill',
    ]);

    const direct = listAllInstalledSkills({
      cwd: root,
      dotaiRoot: 'custom-dotai',
    });
    expect(direct.dotaiRoot).toBe(dotai);
    expect(direct.entries.some((e) => e.name === 'flat-alpha')).toBe(true);
    expect(direct.entries.some((e) => e.name === 'nested-dir-skill')).toBe(
      true,
    );

    expect(
      splitPathPrefixes('C:\\Users\\dev\\skills\\demo\\SKILL.md').join('|'),
    ).toBe(
      'C:\\Users|C:\\Users\\dev|C:\\Users\\dev\\skills|C:\\Users\\dev\\skills\\demo|C:\\Users\\dev\\skills\\demo\\SKILL.md',
    );
    expect(splitPathPrefixes('D:/work\\repo/skill').join('|')).toBe(
      'D:\\work|D:\\work\\repo|D:\\work\\repo\\skill',
    );
    expect(
      splitPathPrefixes('\\\\srv\\share\\skills\\a\\SKILL.md').join('|'),
    ).toBe(
      '\\\\srv\\share\\skills|\\\\srv\\share\\skills\\a|\\\\srv\\share\\skills\\a\\SKILL.md',
    );
    expect(splitPathPrefixes('/opt/skills/demo').join('|')).toBe(
      '/opt|/opt/skills|/opt/skills/demo',
    );
  });
});
