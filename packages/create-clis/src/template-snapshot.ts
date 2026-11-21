/**
 * 模板快照装载面: 快照来源词汇 (ORIGINAL)、包内默认位置 (defaultTemplateDir)、目录走查
 * (listTemplateFiles / listTemplateDirs) 与资产载体改名表 (ASSET_CARRIERS)。
 *
 * 快照由 scripts/build-template.ts 构建链产出 (assets/template/), 生成期由 generate.ts 消费:
 * 同一条链的两端共用这里的 ORIGINAL 与 ASSET_CARRIERS (唯一事实来源), 防来源词汇与载体约定漂移。
 */
import { type Dirent, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Vocabulary } from './render.ts';

/**
 * 本仓 (模板来源) 的原项目词汇:
 * - `author` 是 `owner` 的展示名形态 (LICENSE / package.json author), 缺它会漏替换与漏自检;
 * - `compoundOnly: true` 因本仓包名与命令名均为常用短词 `sweep`, 强制仅按复合形态替换防误伤。
 */
export const ORIGINAL: Vocabulary = {
  name: 'sweep',
  scope: '@iyowei',
  binName: 'sweep',
  owner: 'iyowei',
  repoUrl: 'https://github.com/iyowei/clis',
  author: 'iTonyYo',
  compoundOnly: true,
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

/**
 * 资产载体改名表 (真实名 -> 随包载体名): npm 打包机制按文件名硬性剔除 `.gitignore` 与
 * `.npmrc` (任何层级, `files` 字段也救不回; 证据见 `scripts/release-artifact.ts` 的
 * `NPM_UNSHIPPABLE_BASENAMES`)。构建期改用 `_` 前缀载体名随发行包下发, 生成期在复制模板后
 * 立即还原成真实名 (见 `generate.ts` 的 `restoreCarrierNames`)。
 *
 * 本表是唯一事实来源: 构建侧 (`toCarrierPath`) 与生成侧 (`fromCarrierPath`) 共用。
 */
export const ASSET_CARRIERS: Readonly<Record<string, string>> = {
  '.gitignore': '_gitignore',
  '.npmrc': '_npmrc',
};

/** 反向表 (载体名 → 真实名), 由 ASSET_CARRIERS 派生, 防两表漂移 */
const CARRIER_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ASSET_CARRIERS).map(([real, carrier]) => [carrier, real]),
);

/** 取路径末段 (无 `/` 即整体) */
const basenameOf = (relative: string): string => {
  const at = relative.lastIndexOf('/');
  return at < 0 ? relative : relative.slice(at + 1);
};

/** 换掉路径末段 (目录部分原样) */
const withBasename = (relative: string, basename: string): string => {
  const at = relative.lastIndexOf('/');
  return at < 0 ? basename : `${relative.slice(0, at + 1)}${basename}`;
};

/** 落包改名 (构建侧): 末段命中载体表即换成载体名, 其余路径原样返回 */
export function toCarrierPath(relative: string): string {
  const carrier = ASSET_CARRIERS[basenameOf(relative)];
  return carrier === undefined ? relative : withBasename(relative, carrier);
}

/** 载体还原 (生成侧): 末段是载体名即换回真实名, 其余路径原样返回 */
export function fromCarrierPath(relative: string): string {
  const real = CARRIER_NAMES[basenameOf(relative)];
  return real === undefined ? relative : withBasename(relative, real);
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
