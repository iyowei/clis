/**
 * 目标类别判定: 区分「用户项目依赖」与「工具 / 应用安装树」(纯函数, 零 IO)。
 * 用途是删除面的语义闸 —— 安装树 (包管理器的全局包树与缓存、版本管理器的 node 安装、
 * 编辑器扩展目录、系统 / 应用数据根) 下的 node_modules 删除后无法由项目级重装恢复,
 * 与用户项目依赖的可恢复性前提不同, 故默认不进删除批 (设计: deletion-guard.md「语义闸」);
 * 预览面据此给出行尾标记并保留 `node_modules` 后缀 (见 render.ts 的 displayPath)。
 *
 * 判定只看路径形态, 不看目录内容: 目标是显式构造出来的 (删错代价不可逆), 而「读取内容再判」
 * 会把判定与磁盘状态耦合 (竞态与权限噪声), 也越过纯函数的边界。
 * 保守取向: 宁可把同名目录判成安装树 (用户加 --force 即可清理), 也不漏放真安装树;
 * 大小写一律折叠比较 (不区分平台), 多出来的误判同样落在安全侧。
 * 与 DEFAULT_EXCLUDE (扫描面的名单) 的关系: 名字集合取自同一份常量 (单一事实来源),
 * 但本模块不受用户配置影响 —— 用户删掉配置里的默认排除项, 删除面的这道闸仍在。
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
const INSTALL_TREE_SEGMENTS = new Set(
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
 * 判定目标类别。
 *
 * 判定顺序 (逐条短路, 证据强度递减):
 *   1. `node_modules` 之上任一级目录名命中安装树容器名 → 安装树
 *      (容器名是工具私有约定, 指认最具体: `~/.nvm/.../lib/node_modules` 报的是 `.nvm` 而非泛化的 lib);
 *   2. `node_modules` 的父目录名为 `lib` → 安装树形态
 *      (fnm / nvm / volta / asdf 的全局包一律落在 `<版本目录>/lib/node_modules`, 管理器的根不在
 *      默认名单里时由本形态兜住);
 *   3. `node_modules` 落在**家目录下的隐藏目录**里 → 安装树形态
 *      (隐藏目录是应用私有数据的惯例落点: 实测命中 `~/.oh-my-opencode` 237 MB、`~/.stepfun/releases/deps-6`
 *      51 MB、`~/.jcode/skills/archify` 等未收录进默认名单的应用根; 用户项目极少藏进点目录, 而这批
 *      应用的安装树形态各异、名字无法穷举, 故按形态兜);
 *   4. 其余 → 用户项目依赖。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   target = '/Users/iyowei/.bun/install/global/node_modules'
 *
 * 步骤 1：切段并去掉末段 (node_modules 自身不构成路径上的一级)
 *   ancestors = ['Users', 'iyowei', '.bun', 'install', 'global']
 *
 * 步骤 2：逐级判容器名 ('.bun' 命中安装树容器名)
 *   kind = 'suspect-install-tree', reason = '位于 .bun 安装树目录'
 *
 * Output（数据契约）
 *   return { kind: 'suspect-install-tree', reason: '位于 .bun 安装树目录' }
 * ```
 */
export function classifyTarget(
  target: string,
  options: ClassifyOptions = {},
): Classification {
  const style = options.style ?? nativeStyle();
  const homeOption = options.home === undefined ? homedir() : options.home;

  const parts = target.split(style.ops.sep).filter((part) => part !== '');
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

  // 家目录下的隐藏目录: 取相对家目录的首段, 排除上溯 (..) 与跨盘绝对路径 —— 两者都说明目标不在家目录内
  if (homeOption !== null) {
    const relative = style.ops.relative(
      fold(homeOption, style),
      fold(target, style),
    );
    const [first] = relative.split(style.ops.sep);
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
