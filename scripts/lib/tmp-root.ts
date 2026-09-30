/**
 * 临时根工厂: 在 ~/tmp 下建独占临时目录, 测试与闸门生产代码统一经此创建。
 *
 * 动机: 套件惯例是临时目录落 ~/tmp (不用系统 /tmp), 本地 ~/tmp 常备而 CI runner
 * 的 HOME 下没有 tmp 目录, 直接 mkdtemp 会因父目录缺失报 ENOENT (2026-09-30 CI
 * 实翻, 6 处调用点集体挂红); 前置补建在此一处兜底, 调用点不再各自假设目录已存在。
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 在 ~/tmp 下建独占临时目录, 返回其绝对路径; 父目录缺失时先补建 */
export function makeTmpRoot(prefix: string): string {
  const tmpBase = join(homedir(), 'tmp');
  mkdirSync(tmpBase, { recursive: true });
  return mkdtempSync(join(tmpBase, prefix));
}
