import { afterEach, describe, expect, test } from 'bun:test';

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveSkillBundle } from './resolver.ts';
import { scanResolvedBundle } from './scanner.ts';
import { PROBE_SCHEMA_VERSION } from './types.ts';

const createdDirs: string[] = [];

function makeSandboxRoot(prefix: string): string {
  const base = join(homedir(), 'tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, prefix));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('基础拓扑与脚本化形态判定', () => {
  test('识别纯文本全仓扫描 skill 为 pure-prompt-skill 并精准定位步骤', () => {
    const root = makeSandboxRoot('da-pure-');
    const skillDir = join(root, '.agents', 'skills', 'manual-cia');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: manual-cia',
        'description: manual impact scanner',
        '---',
        '',
        '## 执行步骤',
        '',
        '1. 读 `git diff HEAD`, 提取变更契约。',
        '2. 按载体分层全仓扫描连带修改点: 代码内部调用点与导出面、测试断言、文档与配置, 逐条列出位置。',
        '3. 输出 Markdown 清单。',
      ].join('\n'),
    );

    const bundle = resolveSkillBundle(skillDir, {
      cwd: root,
      disableDotai: true,
    });
    const report = scanResolvedBundle(bundle, root);

    expect(report.schemaVersion).toBe(PROBE_SCHEMA_VERSION);
    expect(report.architectureShape).toBe('pure-prompt-skill');
    expect(report.engineeringFootprint.implScriptCount).toBe(0);
    expect(report.summaryForJudge.unbackedHotspotCount).toBeGreaterThanOrEqual(
      1,
    );
    const step2 = report.candidateHotspots.find((h) =>
      h.section.includes('步骤 2'),
    );
    expect(step2).toBeDefined();
    expect(step2!.likelyBackedByScript).toBe(false);
    expect(step2!.categories).toContain('FULL_REPO_SCAN');
    expect(step2!.categories).toContain('AST_OR_DEPENDENCY_GRAPH');
  });

  test('识别脚本闭环 skill 为 script-backed-loop 且严防同节向后误洗白', () => {
    const root = makeSandboxRoot('da-backed-');
    const skillDir = join(root, '.agents', 'skills', 'mixed-loop');
    mkdirSync(join(skillDir, 'scripts'), { recursive: true });
    writeFileSync(
      join(skillDir, 'scripts', 'runner.ts'),
      Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`).join(
        '\n',
      ),
    );
    writeFileSync(
      join(skillDir, 'scripts', 'runner.test.ts'),
      'import { expect, test } from "bun:test";\ntest("ok", () => expect(1).toBe(1));\n',
    );
    writeFileSync(
      join(skillDir, 'scripts', 'report.schema.json'),
      '{"type":"object"}\n',
    );
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: mixed-loop',
        'description: mixed runner skill',
        '---',
        '',
        '## 工作流',
        '',
        '1. 运行 `bun .agents/skills/mixed-loop/scripts/runner.ts scan` 完成全仓扫描。',
        '2. 逐条比对 Markdown 死链并手动维护台账与回滚状态。',
      ].join('\n'),
    );

    const bundle = resolveSkillBundle(skillDir, {
      cwd: root,
      disableDotai: true,
    });
    const report = scanResolvedBundle(bundle, root);

    const step1 = report.candidateHotspots.find((h) =>
      h.section.includes('步骤 1'),
    );
    const step2 = report.candidateHotspots.find((h) =>
      h.section.includes('步骤 2'),
    );
    expect(step1).toBeDefined();
    expect(step1!.likelyBackedByScript).toBe(true);
    expect(step2).toBeDefined();
    expect(step2!.likelyBackedByScript).toBe(false);
    expect(step2!.nearbyScripts).toEqual([]);
  });

  test('同级 ## 标题正确弹栈, 且自指禁止与反例命令行不误报', () => {
    const root = makeSandboxRoot('da-headings-');
    const skillDir = join(root, '.agents', 'skills', 'self-guard');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: self-guard',
        'description: check headings and negations',
        '---',
        '',
        '## 派发模式',
        '',
        '❌ grep "pattern" path',
        '严禁派 ${SKILL_REF:self-guard} 自身造成递归。',
        '',
        '## 稳定性循环模式',
        '',
        '1. 人工计数连续全 PASS 轮次并维护台账。',
      ].join('\n'),
    );

    const bundle = resolveSkillBundle(skillDir, {
      cwd: root,
      disableDotai: true,
    });
    const report = scanResolvedBundle(bundle, root);

    expect(report.linkedSkills).not.toContain('self-guard');
    expect(report.executedCommandRefs.length).toBe(0);
    const loopStep = report.candidateHotspots.find((h) =>
      h.section.includes('稳定性循环模式'),
    );
    expect(loopStep).toBeDefined();
    expect(loopStep!.section).toBe('稳定性循环模式');
  });
});

describe('软链入参、转发薄壳与多级祖先追踪', () => {
  test('支持直接传入指向目录的符号链接路径, 且解包下游测试与 Schema', () => {
    const root = makeSandboxRoot('da-dispatch-');
    const dotai = join(root, 'dotAI');
    const srcAgentDir = join(dotai, 'src', 'agents');
    const srcResDir = join(dotai, 'src', 'resources', 'auditor');
    const srcSkillsDir = join(dotai, 'src', 'skills');
    const targetSkillDir = join(
      dotai,
      'targets',
      'codex',
      'skills',
      'proxy-check',
    );
    const installedSkillsDir = join(root, '.agents', 'skills');

    mkdirSync(srcAgentDir, { recursive: true });
    mkdirSync(srcResDir, { recursive: true });
    mkdirSync(srcSkillsDir, { recursive: true });
    mkdirSync(targetSkillDir, { recursive: true });
    mkdirSync(installedSkillsDir, { recursive: true });

    writeFileSync(
      join(targetSkillDir, 'SKILL.md'),
      [
        '---',
        'name: proxy-check',
        'description: thin wrapper',
        '---',
        '',
        '本 skill 是转发薄壳: 严禁当前会话自行执行, 必须立即派发 proxy-worker 子代理全权处理。',
      ].join('\n'),
    );
    writeFileSync(
      join(srcSkillsDir, 'proxy-check.md'),
      [
        '---',
        'description: thin wrapper',
        'dispatch: proxy-worker',
        '---',
        '转发输入给执行体。',
      ].join('\n'),
    );
    writeFileSync(
      join(srcAgentDir, 'proxy-worker.md'),
      [
        '---',
        'name: proxy-worker',
        'claude:',
        '  disallowedTools: Edit, Write',
        '---',
        '## 执行步骤',
        '',
        '运行 `bun ${RESOURCES_ROOT}/auditor/run_gates.ts` 校验 schema 与死链。',
      ].join('\n'),
    );
    writeFileSync(
      join(srcResDir, 'run_gates.ts'),
      Array.from({ length: 30 }, (_, i) => `export const g${i} = ${i};`).join(
        '\n',
      ),
    );
    writeFileSync(
      join(srcResDir, 'run_gates.test.ts'),
      'import { expect, test } from "bun:test";\ntest("gate", () => expect(1).toBe(1));\n',
    );
    writeFileSync(join(srcResDir, 'audit.schema.json'), '{"type":"object"}\n');
    writeFileSync(join(srcResDir, 'README.md'), '# Auditor Resources\n');

    const installedLink = join(installedSkillsDir, 'proxy-check');
    symlinkSync(targetSkillDir, installedLink);

    const bundleByLink = resolveSkillBundle(installedLink, { cwd: root });
    const reportByLink = scanResolvedBundle(bundleByLink, root);
    expect(reportByLink.isThinDispatcher).toBe(true);
    expect(reportByLink.forwardedAgents).toContain('proxy-worker');
    expect(reportByLink.architectureShape).toBe('script-backed-loop');
    expect(reportByLink.documents.some((d) => d.role === 'resource-doc')).toBe(
      true,
    );
    const agentDoc = reportByLink.documents.find(
      (d) => d.role === 'forwarded-agent',
    );
    expect(agentDoc?.disallowedTools).toEqual(['Edit', 'Write']);

    const bundleBySource = resolveSkillBundle(
      join(srcSkillsDir, 'proxy-check.md'),
      { cwd: root },
    );
    const reportBySource = scanResolvedBundle(bundleBySource, root);
    const nonExcluded = reportBySource.documents.filter(
      (d) => !d.excludedFromHotspotScan,
    );
    expect(nonExcluded.some((d) => d.role === 'skill-compiled-mirror')).toBe(
      false,
    );
  });

  test('转发薄壳目标 agent 不存在时, 明确标记 unresolved-dispatcher 与缺失坐标', () => {
    const root = makeSandboxRoot('da-missing-');
    const skillDir = join(root, '.agents', 'skills', 'ghost-dispatch');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: ghost-dispatch',
        'description: broken wrapper',
        '---',
        '',
        '本 skill 是转发薄壳: 必须立即派发 nonexistent-ghost-agent 子代理执行全仓扫描。',
      ].join('\n'),
    );

    const bundle = resolveSkillBundle(skillDir, {
      cwd: root,
      disableDotai: true,
    });
    const report = scanResolvedBundle(bundle, root);

    expect(report.isThinDispatcher).toBe(true);
    expect(report.architectureShape).toBe('unresolved-dispatcher');
    expect(report.unresolvedTargets.length).toBe(1);
    expect(report.unresolvedTargets[0]!.reference).toBe(
      'nonexistent-ghost-agent',
    );
  });
});

describe('半脚本化边界、外部共享测试带出与 Schema 契约自证', () => {
  test('仅配末步校验脚本但主体扫描未脚本化时, 判定为 hybrid-assisted', () => {
    const root = makeSandboxRoot('da-hybrid-');
    const skillDir = join(root, '.agents', 'skills', 'partial-audit');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'validate.cjs'),
      Array.from({ length: 120 }, (_, i) => `const x${i} = ${i};`).join('\n'),
    );
    writeFileSync(join(skillDir, 'report.schema.json'), '{"type":"object"}\n');
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: partial-audit',
        'description: partial scripted audit',
        '---',
        '',
        '## 第 1 步: 全仓扫描调用点',
        '',
        '全仓扫描并列出所有导出面与调用点。',
        '',
        '## 第 2 步: 逐条核对死链',
        '',
        '逐条比对所有 Markdown 相对链接是否存在死链。',
        '',
        '## 第 3 步: 跑状态台账与一致性核对',
        '',
        '检查全部默认值与枚举成员并计数汇总。',
        '',
        '## 第 4 步: 最终校验',
        '',
        '运行 `node validate.cjs report.json` 检查输出。',
      ].join('\n'),
    );

    const bundle = resolveSkillBundle(skillDir, {
      cwd: root,
      disableDotai: true,
    });
    const report = scanResolvedBundle(bundle, root);

    expect(report.architectureShape).toBe('hybrid-assisted');
    expect(report.summaryForJudge.unbackedHotspotCount).toBe(3);
    expect(report.summaryForJudge.backedHotspotCount).toBe(1);
  });

  test('自身 ProbeReport 严格对齐 probe_report.schema.json 必填顶层字段', () => {
    const schemaPath = join(import.meta.dir, 'probe_report.schema.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
      required: string[];
    };
    const selfSkillDir = join(import.meta.dir, '..');
    const cwd = join(selfSkillDir, '..', '..', '..');
    const report = scanResolvedBundle(
      resolveSkillBundle(selfSkillDir, { cwd, disableDotai: true }),
      cwd,
    );

    for (const key of schema.required) {
      expect(report).toHaveProperty(key);
    }
    expect(report.engineeringFootprint.schemaFileCount).toBeGreaterThanOrEqual(
      1,
    );
    expect(report.engineeringFootprint.testFileCount).toBeGreaterThanOrEqual(1);
  });

  test('反引号包裹的 AGENT_REF 与 SKILL_REF 阐述性提及不误入转发与关联链路', () => {
    const root = makeSandboxRoot('da-backtick-');
    const skillDir = join(root, '.agents', 'skills', 'doc-mentions');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: doc-mentions',
        'description: mention isolation check',
        '---',
        '',
        '## 边界',
        '',
        '- 与 `${SKILL_REF:coder}` 和 `${AGENT_REF:rv}` 分工协作, 本文不直接派发.',
      ].join('\n'),
    );

    const report = scanResolvedBundle(
      resolveSkillBundle(skillDir, { cwd: root, disableDotai: true }),
      root,
    );
    expect(report.forwardedAgents).toEqual([]);
    expect(report.linkedSkills).toEqual([]);
  });
});
