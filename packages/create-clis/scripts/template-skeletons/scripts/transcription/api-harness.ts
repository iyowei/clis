/**
 * API 黑盒验收适配器骨架 (增强档 `full` 保留):
 * 默认直连示例包 `{{SCOPE}}/{{NAME}}` 的公开入口; 填入真实业务 API 与金样本语料后按需扩展。
 */
import * as api from '../../packages/{{NAME}}/src/index.ts';

interface RequestPayload {
  call?: { export?: string; args?: unknown[] };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const raw = (await readStdin()).trim();
  if (raw === '') {
    process.stdout.write(`${JSON.stringify({ ok: false, error: '空请求' })}\n`);
    return;
  }
  const req = JSON.parse(raw) as RequestPayload;
  const exportName = req.call?.export;
  const fn =
    typeof exportName === 'string'
      ? (api as Record<string, unknown>)[exportName]
      : undefined;
  if (typeof fn !== 'function') {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: `未知导出函数: ${String(exportName)}` })}\n`,
    );
    return;
  }
  const value = await fn(...(req.call?.args ?? []));
  process.stdout.write(`${JSON.stringify({ ok: true, value })}\n`);
}

if (import.meta.main) await main();
