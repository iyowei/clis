#!/usr/bin/env bun
/**
 * determinism-audit 确定性探针 CLI:
 * 1 秒解包指定 skill 的全拓扑资产 (含软链与转发薄壳关联的 agent / resources / rules),
 * 输出精简结构化体检单 JSON 供 AI 做人机职责边界裁决, 并将全量档案隔离写入 ~/tmp/determinism-audit/。
 *
 * 用法:
 *   bun .agents/skills/determinism-audit/scripts/probe.ts probe <target> [--dotai-root <dir>] [--no-dotai] [--max-hotspots <n>] [--no-archive]
 *   bun .agents/skills/determinism-audit/scripts/probe.ts list [--dotai-root <dir>] [--no-dotai]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { listAllInstalledSkills } from './discovery.ts';
import { formatDisplayPath, resolveSkillBundle } from './resolver.ts';
import { scanResolvedBundle } from './scanner.ts';
import type {
  ProbeReport,
  ResolveOptions,
  SkillKind,
  SkillListItem,
  SkillListReport,
} from './types.ts';
import { PROBE_SCHEMA_VERSION } from './types.ts';

interface ParsedCliArgs {
  command: 'probe' | 'list' | 'help';
  target?: string;
  dotaiRoot?: string;
  disableDotai: boolean;
  noArchive: boolean;
  maxHotspots: number;
}

function parseArgs(argv: readonly string[]): ParsedCliArgs {
  const positional: string[] = [];
  let dotaiRoot: string | undefined;
  let disableDotai = false;
  let noArchive = false;
  let maxHotspots = 25;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      return {
        command: 'help',
        disableDotai: false,
        noArchive: false,
        maxHotspots,
      };
    }
    if (arg === '--no-dotai') {
      disableDotai = true;
      continue;
    }
    if (arg === '--no-archive') {
      noArchive = true;
      continue;
    }
    if (arg === '--dotai-root') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--dotai-root 缺少路径参数');
      dotaiRoot = next;
      i += 1;
      continue;
    }
    if (arg === '--max-hotspots') {
      const next = argv[i + 1];
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error('--max-hotspots 必须为正整数');
      }
      maxHotspots = parsed;
      i += 1;
      continue;
    }
    positional.push(arg);
  }

  const sub = positional[0];
  if (sub === undefined || sub === 'help') {
    return { command: 'help', disableDotai, noArchive, maxHotspots };
  }
  if (sub === 'list') {
    return { command: 'list', dotaiRoot, disableDotai, noArchive, maxHotspots };
  }
  if (sub === 'probe') {
    if (positional[1] === undefined)
      throw new Error('probe 子命令缺少 <target> 参数');
    return {
      command: 'probe',
      target: positional[1],
      dotaiRoot,
      disableDotai,
      noArchive,
      maxHotspots,
    };
  }
  return {
    command: 'probe',
    target: sub,
    dotaiRoot,
    disableDotai,
    noArchive,
    maxHotspots,
  };
}

function printUsage(): void {
  const lines = [
    '用法:',
    '  probe.ts probe <target> [--dotai-root <dir>] [--no-dotai] [--max-hotspots <n>] [--no-archive]',
    '  probe.ts list [--dotai-root <dir>] [--no-dotai]',
    '',
    '说明:',
    '  <target> 支持 skill 名称 (如 cia / drift-audit)、skill 目录路径或 SKILL.md 文件路径。',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function writeArchiveReport(report: ProbeReport): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  const archiveDir = join(home, 'tmp', 'determinism-audit');
  mkdirSync(archiveDir, { recursive: true });
  const safeName = report.skillName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const displayPath = `~/tmp/determinism-audit/${safeName}.probe.json`;
  report.archivePath = displayPath;
  const archiveFile = join(archiveDir, `${safeName}.probe.json`);
  writeFileSync(archiveFile, `${JSON.stringify(report, null, 2)}\n`);
  return displayPath;
}

function kindPriority(kind: SkillKind): number {
  if (kind === 'workflow') return 0;
  if (kind === 'dispatcher') return 1;
  return 2;
}

function runListCommand(options: ResolveOptions): SkillListReport {
  const { dotaiRoot, entries } = listAllInstalledSkills(options);
  const skills: SkillListItem[] = [];

  for (const entry of entries) {
    const bundle = resolveSkillBundle(entry.entryPath, options);
    const report = scanResolvedBundle(bundle, options.cwd);
    skills.push({
      name: report.skillName,
      source: entry.source,
      entryPath: formatDisplayPath(entry.entryPath, options.cwd),
      isSymlink: entry.isSymlink,
      isThinDispatcher: report.isThinDispatcher,
      skillKind: report.skillKind,
      architectureShape: report.architectureShape,
      docLines: report.engineeringFootprint.docLines,
      implScriptCount: report.engineeringFootprint.implScriptCount,
      testFileCount: report.engineeringFootprint.testFileCount,
      schemaFileCount: report.engineeringFootprint.schemaFileCount,
      unbackedHotspotCount: report.summaryForJudge.unbackedHotspotCount,
      totalRawHotspotCount: report.summaryForJudge.totalRawHotspotCount,
      unresolvedCount: report.unresolvedTargets.length,
    });
  }

  skills.sort((a, b) => {
    const kindDiff = kindPriority(a.skillKind) - kindPriority(b.skillKind);
    if (kindDiff !== 0) return kindDiff;
    if (b.unbackedHotspotCount !== a.unbackedHotspotCount) {
      return b.unbackedHotspotCount - a.unbackedHotspotCount;
    }
    if (a.implScriptCount !== b.implScriptCount) {
      return a.implScriptCount - b.implScriptCount;
    }
    return b.docLines - a.docLines;
  });

  return {
    schemaVersion: PROBE_SCHEMA_VERSION,
    dotaiRoot,
    totalSkills: skills.length,
    skills,
  };
}

function main(): void {
  let parsed: ParsedCliArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`参数错误: ${message}\n`);
    process.exitCode = 2;
    return;
  }

  if (parsed.command === 'help') {
    printUsage();
    return;
  }

  const cwd = process.cwd();
  const options: ResolveOptions = {
    cwd,
    dotaiRoot: parsed.dotaiRoot,
    disableDotai: parsed.disableDotai,
  };

  try {
    if (parsed.command === 'list') {
      const report = runListCommand(options);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    const bundle = resolveSkillBundle(parsed.target!, options);
    const report = scanResolvedBundle(bundle, cwd, parsed.maxHotspots);
    if (!parsed.noArchive) {
      report.archivePath = writeArchiveReport(report);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`探测失败: ${message}\n`);
    process.exitCode = 2;
  }
}

main();
