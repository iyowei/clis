/**
 * 模板快照装载面: 快照来源词汇 (ORIGINAL)、包内默认位置 (defaultTemplateDir) 与目录走查
 * (listTemplateFiles / listTemplateDirs)。
 *
 * 快照由 scripts/build-template.ts 构建链产出 (assets/template/), 生成期由 generate.ts 消费:
 * 同一条链的两端共用这里的 ORIGINAL (唯一事实来源), 防来源词汇漂移。
 */
import { type Dirent, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Vocabulary } from './render.ts';

/**
 * 本仓 (模板来源) 的原项目词汇: author 是 owner 的展示名形态 (LICENSE / package.json author),
 * 缺它会漏替换与漏自检。
 */
export const ORIGINAL: Vocabulary = {
  name: 'sweep-node-modules',
  scope: '@iyowei',
  binName: 'sweep-nm',
  owner: 'iyowei',
  repoUrl: 'https://github.com/iyowei/clis',
  author: 'iTonyYo',
};

/**
 * 默认模板目录 (包内 assets/template)。
 * 源码态 (src/) 与打包态 (dist/) 都是包根的一级子目录, 故相对本模块位置的上一级同构;
 * 构建链产物位置见 scripts/build-template.ts 的 DEFAULT_TEMPLATE_DIR (同一路径的两处视图)。
 */
export function defaultTemplateDir(
  moduleUrl: string = import.meta.url,
): string {
  return fileURLToPath(new URL('../assets/template', moduleUrl));
}

/** 目录走查: 递归收集相对路径 (前缀以 `/` 连接, 排序稳定); filter 决定收文件还是收目录 */
function walk(
  root: string,
  prefix: string,
  filter: (entry: Dirent) => boolean,
): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), {
    withFileTypes: true,
  })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (filter(entry)) out.push(rel);
    if (entry.isDirectory()) out.push(...walk(root, rel, filter));
  }
  return out.sort();
}

/** 列出快照目录下全部文件 (相对路径, 排序稳定); 生成期替换与自检的遍历面 */
export function listTemplateFiles(root: string): string[] {
  return walk(root, '', (entry) => entry.isFile());
}

/** 列出快照目录下全部子目录 (相对路径, 排序稳定); 路径改名后清理空目录用 */
export function listTemplateDirs(root: string): string[] {
  return walk(root, '', (entry) => entry.isDirectory());
}
