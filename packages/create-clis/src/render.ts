/**
 * 泛化替换引擎: 把「原项目词汇」的全部实测形态替换为「目标词汇」。
 *
 * 两处消费 (设计见 docs/designs/scaffold-template-snapshot.md):
 * - 构建期 (build-template): 用模板占位词汇把本仓文件泛化成模板资产;
 * - 生成期 (generate): 用用户词汇代入模板。
 * containsResidual 是两处共用的零残留判据 (构建自检与生成二道防线)。
 *
 * 形态面 (长形态优先, 由单遍扫描消化包含关系):
 * - 基线五形态 (spec 词汇表): `{{SCOPE}}/{{NAME}}` (含 `-cli` 薄壳包坐标) / `{{NAME}}` /
 *   `{{BIN_NAME}}` / `{{OWNER}}` / `{{REPO_URL}}`;
 * - 实测扩展形态 (实扫 generalize 文件面暴露): 作者署名 author (owner 的展示名, 见于 LICENSE 与
 *   package.json author, 如 iTonyYo) / 裸 slug (无 scheme 的 `{{OWNER}}/{{NAME}}`, 如 npm 命令
 *   的 `--repo iyowei/clis`)。
 *
 * 占位符拼写 (三轮裁定): 模板占位用双花括号大写形态 (`{{NAME}}` 式), 不用单花括号 —— 单花括号
 * `{name}` 是 JS 模板字面量插值 `${name}` 的真子串, 生成期替换会把代码里的插值打成 `$用户词`
 * (实测 8 处, 含 `=== ${name} ===` 这类闸门文案); 双花括号全库零命中, 且在 md / json / yaml / ts
 * 各载体下都不与既有语法撞车 (prettier 亦原样保留)。
 *
 * 裸词收窄 (二轮裁定, 与 template-manifest 的词面口径同源): 裸 `sweep` / `clis` 不入替换面 ——
 * 子串匹配会把动词义标识符 `sweepStale` 写成含连字符的错误标识符, 把生成器包名 `create-clis`
 * 写成生成物里不存在的包; 产品义只认复合形态, 落不进复合面的 (产品区路径 `docs/sweep/` 等)
 * 由清单按条目 note 移交 snapshot / reset 处置, 引擎不代劳。
 *
 * 替换语义: 单遍从左到右扫描, 每个位置取最长匹配形态, 命中即整体替换并跳过该段; 已写出的目标
 * 文本不参与后续匹配 (目标值里含源形态也不会被二次替换)。
 */

/** 词汇: spec 词汇表五基线变量 + 实测扩展形态 author (可选, 缺省回退见字段说明) */
export interface Vocabulary {
  /** 项目名: 包名 / 目录名 / 文档标题 (如 sweep-node-modules) */
  name: string;
  /** npm scope (如 @iyowei); 空串表示裸包名 */
  scope: string;
  /** 主 bin 名 (如 sweep-nm) */
  binName: string;
  /** 仓库所有者 (如 iyowei) */
  owner: string;
  /** 仓库地址 (如 https://github.com/iyowei/clis) */
  repoUrl: string;
  /** 作者署名 (owner 的展示名形态, 见于 LICENSE / package.json author, 如 iTonyYo); 缺省回退 owner */
  author?: string;
}

/**
 * 模板占位词汇: 构建期 (buildTemplate) 的替换目标, 也是生成期 (generate) 的替换来源 ——
 * 模板资产里存的就是这组形态, 两条链共用一处定义 (单源), 防占位约定漂移。
 * 拼写取双花括号大写形态 (不用单花括号): 见文件头「占位符拼写」。
 */
export const TEMPLATE_VOCABULARY: Vocabulary = {
  name: '{{NAME}}',
  scope: '{{SCOPE}}',
  binName: '{{BIN_NAME}}',
  owner: '{{OWNER}}',
  repoUrl: '{{REPO_URL}}',
};

/** 一条替换对照: from 为源形态, to 为目标值 */
interface Form {
  readonly from: string;
  readonly to: string;
}

/** 包坐标拼接: scope 为空 (裸包名) 时省略前缀 */
function packageName(scope: string, name: string): string {
  return scope.length > 0 ? `${scope}/${name}` : name;
}

/**
 * 解析仓库地址的 slug (路径段, 如 iyowei/clis);
 * 非 URL 形态 (如构建期的模板占位符 `{{REPO_URL}}`) 返回 undefined, 相应形态自动跳过。
 */
function parseRepoSlug(repoUrl: string): string | undefined {
  const matched = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(repoUrl.trim());
  if (matched === null) return undefined;
  const segments = (matched[1] ?? '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments.join('/') : undefined;
}

/**
 * 建「源形态 → 目标值」对照表 (同源去重, 先注册者胜; 末尾按形态长度降序)。
 *
 * **执行步骤**：
 * 1. 仓库地址整段 (带 `.git` / `#readme` / `/issues` 等后缀时由剩余文本承接) 与裸 slug
 *    (源地址非 URL 形态时注册 `owner/name` 组合: 模板占位词汇 `{{OWNER}}/{{NAME}}` 即由此覆盖);
 * 2. 包坐标 (含 `-cli` 薄壳包, 先于裸 name 注册);
 * 3. 裸 name; 4. bin 名; 5. 作者署名 (回退 owner) 与 owner。
 */
function buildForms(target: Vocabulary, source: Vocabulary): Form[] {
  const forms: Form[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string): void => {
    if (from.length === 0 || seen.has(from)) return;
    seen.add(from);
    forms.push({ from, to });
  };

  const sourceSlug = parseRepoSlug(source.repoUrl);
  const targetSlug =
    parseRepoSlug(target.repoUrl) ?? packageName(target.owner, target.name);

  add(source.repoUrl, target.repoUrl);
  // slug 形态: 源地址可解析时取路径段 (如 iyowei/clis); 不可解析 (模板占位词汇的
  // `{{REPO_URL}}`) 时注册 owner/name 组合 —— 模板资产里的裸 slug 形态 `{{OWNER}}/{{NAME}}`
  // 正是构建期 targetSlug 的写法。不注册该整体形态时它也会被 `{{OWNER}}` / `{{NAME}}` 两个
  // 单形态组合替换成 owner/name; 注册后与 targetSlug 定义对齐: `--repo` 路径段与 owner/name
  // 不一致时, 裸 slug 取仓库地址的路径段 (与构建期写出口径对称)
  if (sourceSlug !== undefined) add(sourceSlug, targetSlug);
  else add(packageName(source.owner, source.name), targetSlug);
  add(
    packageName(source.scope, `${source.name}-cli`),
    packageName(target.scope, `${target.name}-cli`),
  );
  add(`${source.name}-cli`, `${target.name}-cli`);
  add(
    packageName(source.scope, source.name),
    packageName(target.scope, target.name),
  );
  add(source.name, target.name);
  add(source.binName, target.binName);
  if (source.author !== undefined)
    add(source.author, target.author ?? target.owner);
  add(source.owner, target.owner);

  return forms.sort((left, right) => right.from.length - left.from.length);
}

/**
 * 渲染模板: 把 content 里的原词汇形态替换为目标词汇对应值; 不含词汇的内容原样返回。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   content = '@iyowei/sweep-node-modules 与 sweep-nm 与 iTonyYo 与 https://github.com/iyowei/clis 与 docs/sweep/'
 *   v = { name: 'my-tool', scope: '@me', binName: 'mt', owner: 'me', repoUrl: 'https://github.com/me/my-tool' }
 *   original = { name: 'sweep-node-modules', scope: '@iyowei', binName: 'sweep-nm', owner: 'iyowei', repoUrl: 'https://github.com/iyowei/clis', author: 'iTonyYo' }
 *
 * 步骤 1：建形态表 (长形态在前)
 *   forms = [
 *     'https://github.com/iyowei/clis' → 'https://github.com/me/my-tool',
 *     '@iyowei/sweep-node-modules' → '@me/my-tool', 'sweep-node-modules' → 'my-tool',
 *     'iyowei/clis' → 'me/my-tool', 'sweep-nm' → 'mt', 'iTonyYo' → 'me', 'iyowei' → 'me', ...
 *   ]
 *
 * 步骤 2：单遍扫描, 每个位置取最长匹配整体替换 (已写出的目标文本不参与后续匹配)
 *   '@iyowei/sweep-node-modules' 命中包坐标形态; 'sweep-nm' 命中 bin 形态; 'iTonyYo' 命中作者形态;
 *   整段地址命中地址形态; 'docs/sweep/' 的 sweep 是裸词形态, 不在替换面, 原样保留
 *
 * Output（数据契约）
 *   return '@me/my-tool 与 mt 与 me 与 https://github.com/me/my-tool 与 docs/sweep/'
 * ```
 */
export function renderTemplate(
  content: string,
  v: Vocabulary,
  original: Vocabulary,
): string {
  const forms = buildForms(v, original);
  let out = '';
  let index = 0;
  while (index < content.length) {
    const hit = forms.find((form) => content.startsWith(form.from, index));
    if (hit === undefined) {
      out += content.charAt(index);
      index += 1;
    } else {
      out += hit.to;
      index += hit.from.length;
    }
  }
  return out;
}

/**
 * 残留检测: content 里是否仍含原词汇的任一形态 (构建自检与生成二道防线的共用判据)。
 * 判据以 original 自身作目标词汇建表取源形态。
 *
 * 传入 target 时排除与目标词汇形态重合的源形态: 目标词汇与源词汇取值重合是合法配置
 * (如用户 owner 与本仓 owner 同名, 生成物里出现同名值是预期结果), 重合形态不算残留,
 * 防二道自检误报; 不传时维持「源形态全量」判据 (构建自检面)。
 */
export function containsResidual(
  content: string,
  original: Vocabulary,
  target?: Vocabulary,
): boolean {
  const forms = buildForms(original, original);
  if (target === undefined) {
    return forms.some((form) => content.includes(form.from));
  }
  const targetForms = new Set(
    buildForms(target, target).map((form) => form.from),
  );
  return forms.some(
    (form) => !targetForms.has(form.from) && content.includes(form.from),
  );
}
