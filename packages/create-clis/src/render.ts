/**
 * 泛化替换引擎: 把「原项目词汇」的全部实测形态替换为「目标词汇」。
 *
 * 两处消费 (设计见 docs/designs/scaffold-template-snapshot.md):
 * - 构建期 (build-template): 用模板占位词汇把本仓文件泛化成模板资产;
 * - 生成期 (generate): 用用户词汇代入模板。
 * containsResidual 是两处共用的零残留判据 (构建自检与生成二道防线)。
 *
 * 形态面 (长形态优先, 由单遍扫描消化包含关系):
 * - 基线五形态 (spec 词汇表): `{scope}/{name}` (含 `-cli` 薄壳包坐标) / `{name}` / `{binName}` /
 *   `{owner}` / `{repoUrl}`;
 * - 实测扩展形态 (实扫 generalize 文件面暴露): 作者署名 author (owner 的展示名, 见于 LICENSE 与
 *   package.json author, 如 iTonyYo) / 裸 slug (无 scheme 的 `{owner}/{repoName}`, 如 npm 命令
 *   的 `--repo iyowei/clis`) / 仓库名 repoName (根包名与文档标题, 从 repoUrl 末段解析) / 产品短名
 *   product (产品区与语料路径前缀, 如 docs/sweep/)。
 *
 * 替换语义: 单遍从左到右扫描, 每个位置取最长匹配形态, 命中即整体替换并跳过该段; 已写出的目标
 * 文本不参与后续匹配 (目标值里含源形态也不会被二次替换)。
 */

/** 词汇: spec 词汇表五基线变量 + 两个实测扩展形态 (可选, 缺省回退见各字段说明) */
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
  /** 产品短名 (产品区与语料路径前缀, 如 sweep 出现于 docs/sweep/); 缺省回退 name */
  product?: string;
}

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
 * 解析仓库地址的 slug 与仓库名 (路径末段);
 * 非 URL 形态 (如构建期的模板占位符 `{repoUrl}`) 返回 undefined, 相应形态自动跳过。
 */
function parseRepoUrl(
  repoUrl: string,
): { slug: string; name: string } | undefined {
  const matched = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(repoUrl.trim());
  if (matched === null) return undefined;
  const segments = (matched[1] ?? '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter((segment) => segment.length > 0);
  const name = segments.at(-1);
  if (name === undefined) return undefined;
  return { slug: segments.join('/'), name };
}

/**
 * 建「源形态 → 目标值」对照表 (同源去重, 先注册者胜; 末尾按形态长度降序)。
 *
 * **执行步骤**：
 * 1. 仓库地址整段 (带 `.git` / `#readme` / `/issues` 等后缀时由剩余文本承接) 与裸 slug;
 * 2. 包坐标 (含 `-cli` 薄壳包, 先于裸 name 注册);
 * 3. 裸 name; 4. bin 名; 5. 作者署名 (回退 owner) 与 owner;
 * 6. 仓库名 (从 repoUrl 解析, 与 name 同值时不重复) 与产品短名 (回退 name)。
 */
function buildForms(target: Vocabulary, source: Vocabulary): Form[] {
  const forms: Form[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string): void => {
    if (from.length === 0 || seen.has(from)) return;
    seen.add(from);
    forms.push({ from, to });
  };

  const sourceRepo = parseRepoUrl(source.repoUrl);
  const targetRepo = parseRepoUrl(target.repoUrl);
  const targetSlug = targetRepo?.slug ?? packageName(target.owner, target.name);
  const targetRepoName = targetRepo?.name ?? target.name;

  add(source.repoUrl, target.repoUrl);
  if (sourceRepo !== undefined) add(sourceRepo.slug, targetSlug);
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
  if (sourceRepo !== undefined && sourceRepo.name !== source.name) {
    add(sourceRepo.name, targetRepoName);
  }
  const sourceProduct = source.product ?? source.name;
  if (sourceProduct !== source.name)
    add(sourceProduct, target.product ?? target.name);

  return forms.sort((left, right) => right.from.length - left.from.length);
}

/**
 * 渲染模板: 把 content 里的原词汇形态替换为目标词汇对应值; 不含词汇的内容原样返回。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   content = '@iyowei/sweep-node-modules 与 sweep-nm 与 docs/sweep/ 与 https://github.com/iyowei/clis'
 *   v = { name: 'my-tool', scope: '@me', binName: 'mt', owner: 'me', repoUrl: 'https://github.com/me/my-tool' }
 *   original = { name: 'sweep-node-modules', scope: '@iyowei', binName: 'sweep-nm', owner: 'iyowei', repoUrl: 'https://github.com/iyowei/clis', author: 'iTonyYo', product: 'sweep' }
 *
 * 步骤 1：建形态表 (长形态在前)
 *   forms = [
 *     'https://github.com/iyowei/clis' → 'https://github.com/me/my-tool',
 *     '@iyowei/sweep-node-modules' → '@me/my-tool', 'sweep-node-modules' → 'my-tool',
 *     'sweep-nm' → 'mt', 'iyowei' → 'me', 'clis' → 'my-tool', 'sweep' → 'my-tool', ...
 *   ]
 *
 * 步骤 2：单遍扫描, 每个位置取最长匹配整体替换 (已写出的目标文本不参与后续匹配)
 *   '@iyowei/sweep-node-modules' 命中包坐标形态; 'sweep-nm' 命中 bin 形态;
 *   'docs/sweep/' 的 sweep 命中产品形态; 整段地址命中地址形态
 *
 * Output（数据契约）
 *   return '@me/my-tool 与 mt 与 docs/my-tool/ 与 https://github.com/me/my-tool'
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
 * 判据只看源形态集合, 与目标值无关, 故以 original 自身作目标词汇建表取源形态。
 */
export function containsResidual(
  content: string,
  original: Vocabulary,
): boolean {
  return buildForms(original, original).some((form) =>
    content.includes(form.from),
  );
}
