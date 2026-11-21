/**
 * 泛化替换引擎与残留检测: 供构建期 (`scripts/build-template.ts`) 泛化模板资产与生成期
 * (`generate.ts`) 代入用户词汇共用, `TEMPLATE_VOCABULARY` 作为双花括号占位单源 (`{{NAME}}` 等,
 * 避开 JS `${name}` 模板插值冲突)。
 *
 * 核心机制: `buildForms` 按「同源去重先注册胜 + 形态长度降序」建表, `renderTemplate` 单遍从左到右
 * 取最长匹配整体替换 (已写出文本不参与二次匹配); 短词源词汇可开 `Vocabulary.compoundOnly` 仅按
 * 无歧义复合形态替换防误伤标识符; `containsResidual` 兼顾构建自检与生成二道防线。
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
  /**
   * 仅按无歧义复合形态替换 name / binName (跳过裸 name 与裸 binName):
   * 当源项目名或命令名为常用英文短词 (如 `ORIGINAL` 的 `sweep`) 时开启,
   * 仅替换包坐标、`packages/<name>`、`vendor/<name>`、`bin/<bin>` 及受限引号/命令上下文,
   * 防止无边界子串替换误伤 `sweepStale` / `sweep.ts` 或普通英文文本。
   */
  compoundOnly?: boolean;
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
 * 建「源形态 -> 目标值」对照表 (同源去重先注册胜, 末尾按 `from.length` 降序供单遍最长匹配)。
 *
 * 注册序与防误伤规则:
 * 1. `repoUrl` 整段与裸 slug (源 URL 可解析取路径段, 不可解析如 `{{REPO_URL}}` 时用 `owner/name`);
 * 2. 包坐标 (`<scope>/<name>-cli`, `<name>-cli`, `<scope>/<name>`);
 * 3. `name` / `binName`: `source.compoundOnly === true` 时仅注册 13 种路径/引号/命令复合形态
 *    (`packages/<name>/`, `packages/<name>`, `vendor/<name>`, `bin/<bin>`, `<bin>: `, `<bin> 启动器`,
 *    `'<bin>'`, `"<bin>"`, `'<bin> `, `"<bin> `, `bunx <bin>`, `<bin>-rs`, `{ <bin>: ` -> `{ '<target>': `),
 *    不注册裸 `name` 与裸 `binName`; 否则注册裸 `name` 与裸 `binName`;
 * 4. `scope`: 始终注册 `<scope>/` (目标无 scope 时连同 `/` 剥离防出现 `/pkg`),
 *    仅当 `source.scope !== @${source.owner}` 才注册裸 `scope` (防误伤 GitHub `@owner` mention);
 * 5. `author` (目标缺省回退 `target.owner`) 与 `owner`。
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
  if (source.compoundOnly === true) {
    // 裸短词 (如 sweep) 只走无歧义复合形态, 严禁裸词无边界替换误伤 sweepStale / sweep.ts 等标识
    add(`packages/${source.name}/`, `packages/${target.name}/`);
    add(`packages/${source.name}`, `packages/${target.name}`);
    add(`vendor/${source.name}`, `vendor/${target.name}`);
    add(`bin/${source.binName}`, `bin/${target.binName}`);
    add(`${source.binName}: `, `${target.binName}: `);
    add(`${source.binName} 启动器`, `${target.binName} 启动器`);
    add(`'${source.binName}'`, `'${target.binName}'`);
    add(`"${source.binName}"`, `"${target.binName}"`);
    add(`'${source.binName} `, `'${target.binName} `);
    add(`"${source.binName} `, `"${target.binName} `);
    add(`bunx ${source.binName}`, `bunx ${target.binName}`);
    add(`${source.binName}-rs`, `${target.binName}-rs`);
    add(`{ ${source.binName}: `, `{ '${target.binName}': `);
  } else {
    add(source.name, target.name);
  }
  if (source.scope.length > 0) {
    // 带斜杠的 npm scope 前缀: 目标无 scope 时连同尾部 `/` 一起省略, 防出现非法 `/pkg`
    add(`${source.scope}/`, target.scope.length > 0 ? `${target.scope}/` : '');
    // 仅当 source.scope 与 `@${source.owner}` 不同名 (如独立占位 `{{SCOPE}}` 或异名组织 scope)
    // 才注册裸 scope, 防把 GitHub @mention (`@owner`) 误当 npm scope 清空或错换
    if (source.scope !== `@${source.owner}`) {
      add(source.scope, target.scope);
    }
  }
  if (source.compoundOnly !== true) {
    add(source.binName, target.binName);
  }
  if (source.author !== undefined)
    add(source.author, target.author ?? target.owner);
  add(source.owner, target.owner);

  return forms.sort((left, right) => right.from.length - left.from.length);
}

/**
 * 渲染模板: 把 content 里的原词汇形态替换为目标词汇对应值; 不含词汇的内容原样返回。
 *
 * ### 数据流转示例
 * ```text
 * Input:  content = "@iyowei/sweep-cli | 'sweep' | sweepStale() | https://github.com/iyowei/clis"
 *         v        = { name: 'my-tool', scope: '', binName: 'mt', owner: 'me', repoUrl: 'https://github.com/me/my-tool' }
 *         original = { name: 'sweep', scope: '@iyowei', binName: 'sweep', owner: 'iyowei',
 *                      repoUrl: 'https://github.com/iyowei/clis', author: 'iTonyYo', compoundOnly: true }
 * Step 1: buildForms(v, original) 生成按长度降序的形态表:
 *         'https://github.com/iyowei/clis' -> 'https://github.com/me/my-tool',
 *         '@iyowei/sweep-cli' -> 'my-tool-cli' (目标无 scope), "'sweep'" -> "'mt'", ... (不注册裸 'sweep')
 * Step 2: 单遍从左到右最长匹配替换 (已写出文本不二次匹配); 'sweepStale()' 未命中复合形态, 原样保留
 * Output: "my-tool-cli | 'mt' | sweepStale() | https://github.com/me/my-tool"
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
 * 残留检测: 检查 content 是否仍含 `original` 任一注册形态 (构建自检与生成二道防线共用)。
 *
 * 传入 `target` 时采用哨兵遮蔽而非直接剔除源形态: 仅把「包含任一原词汇形态的合法目标形态」
 * (如同名 `owner === 'iyowei'` 或超集 `owner === 'iyowei-lab'`) 按长形态优先替换为 `'\0'`,
 * 再检查剩余文本是否仍含原词汇形态 —— 既放行合法重合, 又防短目标词切碎真残留、并拦截同文件混杂的漏替。
 *
 * ### 数据流转示例
 * ```text
 * Input:  content = 'https://github.com/iyowei-lab/my-tool 与残留 https://github.com/iyowei/clis'
 *         original = ORIGINAL (含 owner='iyowei', repoUrl='https://github.com/iyowei/clis')
 *         target   = { ..., owner: 'iyowei-lab', repoUrl: 'https://github.com/iyowei-lab/my-tool' }
 * Step 1: 筛出含原形态的目标形态 ['https://github.com/iyowei-lab/my-tool', 'iyowei-lab/my-tool', 'iyowei-lab']
 * Step 2: 依次用 '\0' 遮蔽 -> remaining = '\0 与残留 https://github.com/iyowei/clis'
 * Step 3: 扫描 remaining 命中原形态 'https://github.com/iyowei/clis'
 * Output: true (检出混杂真残留; 若无后半段则 remaining = '\0' 返回 false)
 * ```
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
  // 仅对包含任一原词汇形态的合法目标形态 (同名或超集重合) 用不可匹配哨兵 '\0' 遮蔽:
  // 1) 短目标词 (如 --name node / --owner i) 与原形态无包含关系, 不做遮蔽, 防切碎真残留致失明;
  // 2) 用 '\0' 而非空串, 防止左右残留字符拼接出伪原词汇导致误报;
  // 3) 长形态优先遮蔽, 放行同名 (owner === 'iyowei') 与超集 (owner === 'iyowei-lab'),
  //    又仍能精准抓住同一文件中混杂的真实残留。
  const targetForms = buildForms(target, target)
    .map((form) => form.from)
    .filter(
      (tf) => tf.length > 0 && forms.some((form) => tf.includes(form.from)),
    );
  let remaining = content;
  for (const tf of targetForms) {
    remaining = remaining.replaceAll(tf, '\0');
  }
  return forms.some((form) => remaining.includes(form.from));
}
