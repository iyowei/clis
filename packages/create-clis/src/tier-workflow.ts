/**
 * GitHub Actions workflow job 裁剪辅助:
 * 摘除二级 job 块 (含紧贴其上的注释行), 并同步收缩 release.yml 的 `needs` 数组引用。
 */

export function pruneWorkflowJobs(
  source: string,
  jobs: readonly string[],
): string {
  const jobSet = new Set(jobs);
  const lines = source.split('\n');
  const out: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const jobMatch = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch !== null) {
      const jobName = jobMatch[1]!;
      if (jobSet.has(jobName)) {
        while (out.length > 0 && /^ {2}#/.test(out[out.length - 1]!)) {
          out.pop();
        }
        while (out.length > 0 && out[out.length - 1]!.trim() === '') {
          out.pop();
        }
        skipping = true;
        continue;
      }
      if (skipping) {
        out.push('');
        skipping = false;
      }
    } else if (skipping && /^[^ \t#]/.test(line)) {
      skipping = false;
    }
    if (skipping) continue;

    const needsMatch = /^(\s*needs:\s*)\[([^\]]+)\]\s*$/.exec(line);
    if (needsMatch !== null) {
      const kept = needsMatch[2]!
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && !jobSet.has(item));
      if (kept.length === 1) {
        out.push(`${needsMatch[1]!}${kept[0]!}`);
        continue;
      }
      if (kept.length > 1) {
        out.push(`${needsMatch[1]!}[${kept.join(', ')}]`);
        continue;
      }
    }
    out.push(line);
  }
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
