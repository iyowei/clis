/**
 * `node` 预设专属目标类别判定: 区分「用户项目依赖」与「工具/应用安装树」(纯函数, 零 IO)。
 * 上游: `sweep.ts` (仅对 `node` 预设命中调用, 非 `node` 预设与自定义规则在编排层直归 `project`) 与 `skip.ts`;
 * 下游: 消费 `config.ts` 的 `DEFAULT_EXCLUDE` 与 `guard.ts` 的 `PathStyle`, 为删除面语义闸与预览标注提供依据
 * (设计: packages/sweep/docs/designs/deletion-guard.md「语义闸」)。
 * 红线与口径: 仅看路径形态不读磁盘; 容器名与 `lib` 比较一律小写折叠, 家目录相对路径按 `style.caseInsensitive` 折叠;
 * 本模块不受用户 `exclude` 配置影响, 即使用户删掉默认排除项, 删除面语义闸仍生效 (需 `--force` 显式放行)。
 */
import { homedir } from 'node:os';

import { DEFAULT_EXCLUDE } from './config.ts';
import { type PathStyle, nativeStyle } from './guard.ts';

/** 大小写折叠: 仅 win32 生效 (与 guard / render 的折叠约定同源, 保证三处对同一 PathStyle 的解读一致) */
const fold = (text: string, style: PathStyle): string =>
  style.caseInsensitive ? text.toLowerCase() : text;

export type TargetKind = 'project' | 'suspect-install-tree';

export interface Classification {
  kind: TargetKind;
  /** kind 为 suspect-install-tree 时的理由 (人话短语, 供清单行尾标注); project 时缺省 */
  reason?: string;
}

/**
 * 安装树容器名 (小写): 与扫描面的默认排除名单同源, 再加两个只在形态上有意义的容器段。
 * - `extensions`: 编辑器 / IDE 的扩展根 (扩展自带 node_modules, 属应用而非用户项目);
 * - `_npx`: npm 的 npx 包缓存 (下划线前缀是 npm 私有约定, 用户项目不会取这个名)。
 */
const INSTALL_TREE_SEGMENTS = /*#__PURE__*/ new Set(
  [...DEFAULT_EXCLUDE, 'extensions', '_npx'].map((name) => name.toLowerCase()),
);

/**
 * 判定选项: 路径风味与家目录均可注入 (与 guard 的 ValidateOptions 同款),
 * 生产默认取当前平台与 os.homedir(), 测试可在任意宿主上跑平台矩阵。
 */
export interface ClassifyOptions {
  /** 路径风味 (分隔符与大小写敏感性); 缺省平台原生 */
  style?: PathStyle;
  /** 家目录 (判定「位于家目录下的隐藏目录」用); 缺省 os.homedir(), 显式传 null 关闭该判定 */
  home?: string | null;
}

/**
 * 判定 `node_modules` 目标类别 (逐条短路, 证据强度递减):
 * 1. `node_modules` 之上任一级命中安装树容器名 (`DEFAULT_EXCLUDE` + `extensions` + `_npx`, 小写折叠) -> `suspect-install-tree`;
 * 2. 直接父目录名为 `lib` (小写折叠, 兜住未收录版本管理器的 `<ver>/lib/node_modules`) -> `suspect-install-tree`;
 * 3. 位于家目录下的隐藏目录内 (相对 `home` 首段以 `.` 起头且非上溯/跨盘) -> `suspect-install-tree`;
 * 4. 其余 -> `project`。
 *
 * ### 数据流转示例
 * ```text
 * Input: target = '/Users/iyowei/.bun/install/global/node_modules', options = { home: '/Users/iyowei' }
 * 步骤 1: 规范路径并切段, 去末段得 ancestors = ['Users', 'iyowei', '.bun', 'install', 'global']
 * 步骤 2: 逐级查 INSTALL_TREE_SEGMENTS -> '.bun' 命中, 短路返回
 * Output: { kind: 'suspect-install-tree', reason: '位于 .bun 安装树目录' }
 *
 * 对照分支:
 * - '/opt/fnm/v22/lib/node_modules' -> 步骤 2 未命中 -> 步骤 3 命中父目录 lib -> suspect-install-tree
 * - '/Users/iyowei/.myapp/app/node_modules' -> 步骤 4 命中家目录隐藏首段 '.myapp' -> suspect-install-tree
 * - '/Users/iyowei/work/web/node_modules' -> 全部放行 -> { kind: 'project' }
 * ```
 */
export function classifyTarget(
  target: string,
  options: ClassifyOptions = {},
): Classification {
  const style = options.style ?? nativeStyle();
  const homeOption = options.home === undefined ? homedir() : options.home;

  const normalizedTarget = style.ops.normalize(target);
  const parts = (
    style.name === 'win32'
      ? normalizedTarget.split(/[\\/]+/)
      : normalizedTarget.split(style.ops.sep)
  ).filter((part) => part !== '');
  // 末段恒为 node_modules (调用方契约), 判定只看它之前的级别
  const ancestors = parts.slice(0, -1);

  for (const segment of ancestors) {
    if (INSTALL_TREE_SEGMENTS.has(segment.toLowerCase()))
      return {
        kind: 'suspect-install-tree',
        reason: `位于 ${segment} 安装树目录`,
      };
  }

  const parent = ancestors[ancestors.length - 1];
  if (parent !== undefined && parent.toLowerCase() === 'lib')
    return {
      kind: 'suspect-install-tree',
      reason: '父目录为 lib, 形如版本管理器的 node 安装树',
    };

  // 家目录下的隐藏目录: 取相对家目录的首段, 排除上溯 (..) 与跨盘绝对路径 (两者均说明目标不在家目录内)
  if (homeOption !== null && homeOption !== '') {
    const relative = style.ops.relative(
      fold(homeOption, style),
      fold(normalizedTarget, style),
    );
    const [first] =
      style.name === 'win32'
        ? relative.split(/[\\/]+/)
        : relative.split(style.ops.sep);
    if (
      first !== undefined &&
      first !== '..' &&
      first !== '.' &&
      first.startsWith('.') &&
      !style.ops.isAbsolute(relative)
    )
      return {
        kind: 'suspect-install-tree',
        reason: `位于 ${first} (家目录下的隐藏目录)`,
      };
  }

  return { kind: 'project' };
}
