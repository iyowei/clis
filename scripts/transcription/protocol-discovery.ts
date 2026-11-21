/**
 * 转写契约套件 · 多产品协议目录自动发现 (零产品名硬编码)。
 *
 * 从根 package.json workspaces 派生的双包产品对 (CLI → API) 中, 自动发现所有具备
 * `<api.dir>/docs/protocol/` 的产品及其契约 / 覆盖表 / 语料 / 模糊目标 / 变异体 / 探针坐标;
 * 供 ci.ts / run-conformance.ts / run-diff-fuzz.ts / make-mutants.ts / validate-coverage.ts 共享。
 */
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  type ProductPair,
  type WorkspacePackage,
  resolveProductPairs,
} from '../lib/workspace.ts';

/** 一个带完整协议区的双包产品坐标 */
export interface ProtocolProduct {
  api: WorkspacePackage;
  cli: WorkspacePackage;
  /** 产品短名 (API 包目录末段, 如 demo-tool) */
  id: string;
  /** 协议目录相对仓根路径 (如 packages/<api>/docs/protocol) */
  protocolRel: string;
  contractRel: string;
  coverageRel: string;
  corpusRel: string;
  fuzzTargetsRel: string;
  mutantsRel: string;
  probesRel: string;
}

function toProtocolProduct(pair: ProductPair): ProtocolProduct {
  const protocolRel = `${pair.api.dir}/docs/protocol`;
  return {
    api: pair.api,
    cli: pair.cli,
    id: basename(pair.api.dir),
    protocolRel,
    contractRel: `${protocolRel}/behavior-contract.md`,
    coverageRel: `${protocolRel}/conformance/coverage.md`,
    corpusRel: `${protocolRel}/conformance/corpus`,
    fuzzTargetsRel: `${protocolRel}/conformance/fuzz-targets.json`,
    mutantsRel: `${protocolRel}/conformance/mutants.json`,
    probesRel: `${protocolRel}/conformance/probes.ts`,
  };
}

function matchesProductHint(product: ProtocolProduct, hint: string): boolean {
  return (
    product.id === hint ||
    product.api.dir === hint ||
    product.api.name === hint ||
    product.cli.dir === hint ||
    product.cli.name === hint ||
    basename(product.cli.dir) === hint
  );
}

/** 发现仓内全部带有 `docs/protocol/` 目录的双包产品 (按 API 目录字典序稳定排序) */
export function discoverProtocolProducts(root: string): ProtocolProduct[] {
  const pairs = resolveProductPairs(root);
  const products: ProtocolProduct[] = [];
  for (const pair of pairs) {
    if (!existsSync(join(root, pair.api.dir, 'docs', 'protocol'))) continue;
    products.push(toProtocolProduct(pair));
  }
  return products.sort((a, b) => a.api.dir.localeCompare(b.api.dir));
}

/**
 * 解析指定 (或唯一) 带协议区的产品:
 * - 传 productHint 时精确匹配 (支持短名 / 目录 / 包名);
 * - 未传 productHint 且仓内恰有一个带协议区的产品时返回该产品;
 * - 存在多个时显式抛错要求传 `--product`, 绝不静默误选。
 */
export function resolveProtocolProduct(
  root: string,
  productHint?: string,
): ProtocolProduct {
  const products = discoverProtocolProducts(root);
  if (products.length === 0) {
    throw new Error(`仓内未发现任何带 docs/protocol/ 的双包产品 (${root})`);
  }
  if (productHint !== undefined && productHint !== '') {
    const matched = products.find((p) => matchesProductHint(p, productHint));
    if (matched === undefined) {
      const available = products
        .map((p) => `${p.id} (${p.api.dir})`)
        .join(', ');
      throw new Error(
        `未找到匹配 --product "${productHint}" 的协议产品 (现有: ${available})`,
      );
    }
    return matched;
  }
  if (products.length > 1) {
    const available = products.map((p) => `${p.id} (${p.api.dir})`).join(', ');
    throw new Error(
      `仓内存在 ${products.length} 个带协议区的产品 (${available}), 请通过 --product 显式指定`,
    );
  }
  return products[0]!;
}
