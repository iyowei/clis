/**
 * 类别判定测试: 钉死安装树与项目依赖的判定边界。
 * 用例形态取自本机实测的安装树布局 (2026-09-24 实测: 先按默认排除名单扫家目录的 node_modules,
 * 再对留下的命中逐条核对), 而非凭空构造 — 判定规则正是从这些形态归纳出来的
 * (设计: deletion-guard.md「语义闸」)。
 */
import { describe, expect, test } from 'bun:test';

import { type ClassifyOptions, classifyTarget } from './classify.ts';
import { DEFAULT_EXCLUDE } from './config.ts';
import { POSIX_STYLE, WIN32_STYLE } from './guard.ts';

const HOME = '/Users/iyowei';

/** 判定为安装树即返回理由 (断言用), 否则返回 null; 家目录固定注入, 不依赖宿主 HOME */
function suspectReason(
  target: string,
  options: ClassifyOptions = {},
): string | null {
  const result = classifyTarget(target, { home: HOME, ...options });
  return result.kind === 'suspect-install-tree' ? (result.reason ?? '') : null;
}

describe('classify: 安装树形态 (本机实测布局)', () => {
  test('包管理器与版本管理器的私有根 (bun / npm / nvm / fnm / yarn)', () => {
    // bun 的全局安装树: 本工具自身即装于其中, 实测 1627 包 / 4.25 GB
    expect(suspectReason(`${HOME}/.bun/install/global/node_modules`)).toBe(
      '位于 .bun 安装树目录',
    );
    expect(
      suspectReason(
        `${HOME}/.bun/install/cache/npm@11.19.1@@registry.npmmirror.com@@@1/node_modules`,
      ),
    ).toBe('位于 .bun 安装树目录');
    // npm 的 npx 包缓存 (实测 26 处)
    expect(
      suspectReason(`${HOME}/.npm/_npx/04d20361a9c2ba4a/node_modules`),
    ).toBe('位于 .npm 安装树目录');
    expect(
      suspectReason(`${HOME}/.nvm/versions/node/v22.18.0/lib/node_modules`),
    ).toBe('位于 .nvm 安装树目录');
    expect(
      suspectReason(`${HOME}/nvm/versions/node/v22.18.0/node_modules`),
    ).toBe('位于 nvm 安装树目录');
    expect(
      suspectReason(`${HOME}/.fnm/node-versions/v24.4.0/lib/node_modules`),
    ).toBe('位于 .fnm 安装树目录');
    expect(suspectReason(`${HOME}/.yarn/global/node_modules`)).toBe(
      '位于 .yarn 安装树目录',
    );
    expect(suspectReason(`${HOME}/.pnpm-store/v3/node_modules`)).toBe(
      '位于 .pnpm-store 安装树目录',
    );
  });

  test('版本管理器的 node 安装树: 父目录为 lib (即使路径里没有管理器的名字)', () => {
    expect(
      suspectReason(
        '/opt/homebrew/opt/node-versions/v22.18.0/installation/lib/node_modules',
      ),
    ).toBe('父目录为 lib, 形如版本管理器的 node 安装树');
    // 实测命中: stepfun 的运行时安装树 (~/.stepfun/runtimes/node/<id>/<triple>/lib/node_modules);
    // 理由取更具体的 lib 形态 (家目录隐藏目录那条留在它后面兜底)
    expect(
      suspectReason(
        `${HOME}/.stepfun/runtimes/node/install_1772766984047/node-v22.18.0-darwin-arm64/lib/node_modules`,
      ),
    ).toBe('父目录为 lib, 形如版本管理器的 node 安装树');
  });

  test('编辑器 / IDE 扩展目录 (vscode / antigravity, 含 dist / webview 等中间级)', () => {
    expect(
      suspectReason(
        `${HOME}/.vscode/extensions/esbenp.prettier-vscode-12.4.0/node_modules`,
      ),
    ).toBe('位于 .vscode 安装树目录');
    expect(
      suspectReason(
        `${HOME}/.vscode/extensions/ms-azuretools.vscode-containers-2.5.1/dist/node_modules`,
      ),
    ).toBe('位于 .vscode 安装树目录');
    expect(
      suspectReason(
        `${HOME}/.antigravity/extensions/ms-azuretools.vscode-containers-2.4.4-universal/dist/node_modules`,
      ),
    ).toBe('位于 .antigravity 安装树目录');
    // 编辑器根不在默认名单里时, 由 extensions 形态兜住 (形态判定独立于名单)
    expect(
      suspectReason('/opt/editors/some-ide/extensions/foo/node_modules'),
    ).toBe('位于 extensions 安装树目录');
    // 实测命中: 名字里带连字符的编辑器根 (.antigravity-ide) 与 LM Studio 的扩展插件目录
    expect(
      suspectReason(
        `${HOME}/.antigravity-ide/extensions/ms-python.python-2026.4.0-universal/out/client/node_modules`,
      ),
    ).toBe('位于 extensions 安装树目录');
    expect(
      suspectReason(
        `${HOME}/.lmstudio/extensions/plugins/lmstudio/rag-v1/node_modules`,
      ),
    ).toBe('位于 extensions 安装树目录');
  });

  test('系统与应用数据根 (macOS Library / XDG 根 / 应用私有根)', () => {
    expect(
      suspectReason(
        `${HOME}/Library/Application Support/Kap/plugins/node_modules`,
      ),
    ).toBe('位于 Library 安装树目录');
    expect(
      suspectReason(`${HOME}/Library/Caches/typescript/5.9/node_modules`),
    ).toBe('位于 Library 安装树目录');
    expect(suspectReason(`${HOME}/.config/opencode/node_modules`)).toBe(
      '位于 .config 安装树目录',
    );
    expect(
      suspectReason(
        `${HOME}/.claude/plugins/marketplaces/thedotmack/node_modules`,
      ),
    ).toBe('位于 .claude 安装树目录');
    expect(
      suspectReason(
        `${HOME}/.local/share/fnm/node-versions/v24.4.0/installation/lib/node_modules`,
      ),
    ).toBe('位于 .local 安装树目录');
  });

  test('家目录下的隐藏目录: 名字无法穷举的应用私有根由形态兜住', () => {
    // 实测命中 (默认排除名单未收录这批应用根): .oh-my-opencode 237 MB /
    // .stepfun/releases/deps-6 51 MB / .jcode/skills/archify / .hyper_plugins
    expect(suspectReason(`${HOME}/.oh-my-opencode/node_modules`)).toBe(
      '位于 .oh-my-opencode (家目录下的隐藏目录)',
    );
    expect(suspectReason(`${HOME}/.stepfun/releases/deps-6/node_modules`)).toBe(
      '位于 .stepfun (家目录下的隐藏目录)',
    );
    expect(suspectReason(`${HOME}/.jcode/skills/archify/node_modules`)).toBe(
      '位于 .jcode (家目录下的隐藏目录)',
    );
    expect(suspectReason(`${HOME}/.hyper_plugins/node_modules`)).toBe(
      '位于 .hyper_plugins (家目录下的隐藏目录)',
    );
    // 规则限定在家目录之下: 家目录之外的隐藏目录不受影响
    expect(suspectReason('/srv/.hidden-app/node_modules')).toBeNull();
    // 判定可关闭 (注入 home: null), 供不需要该维度的调用方使用
    expect(
      classifyTarget(`${HOME}/.hidden-app/node_modules`, { home: null }).kind,
    ).toBe('project');
  });

  test('默认排除名单逐项判为疑似 (值域守卫: 名单项被误删时本条即响)', () => {
    // 判定与扫描面的默认名单同源 (INSTALL_TREE_SEGMENTS 取自同一常量): 名单增删而不更新
    // 判定时由本条拦住; 断言理由取容器名本身, 保证走的是「指认最具体一级」的名单分支
    for (const name of DEFAULT_EXCLUDE) {
      expect(suspectReason(`${HOME}/${name}/node_modules`)).toBe(
        `位于 ${name} 安装树目录`,
      );
    }
  });
});

describe('classify: 项目依赖 (不得误判)', () => {
  test('工作区内的项目依赖判为 project', () => {
    expect(suspectReason(`${HOME}/lab/dotAI/node_modules`)).toBeNull();
    expect(
      suspectReason(`${HOME}/self/development/sweep-node-modules/node_modules`),
    ).toBeNull();
    expect(
      suspectReason('/Users/iyowei/dev/ws/packages/web-ui/node_modules'),
    ).toBeNull();
  });

  test('家目录本体自身的 node_modules 判为项目 (家目录本身即可是一个工作区)', () => {
    expect(suspectReason(`${HOME}/node_modules`)).toBeNull();
  });

  test('项目名形近但不成词时不误判 (npm 前缀不等于私有根)', () => {
    expect(suspectReason(`${HOME}/dev/npm-utils/node_modules`)).toBeNull();
    expect(suspectReason(`${HOME}/dev/my-lib/node_modules`)).toBeNull();
  });

  test('登记在案的保守误判面: monorepo 里名为 lib / extensions 的包也判安装树', () => {
    // 保守取向的已知代价: 两者都是安装树的容器形态, 判成项目反而会漏放真安装树;
    // 代价是用户需要 --force 才能清理 (见 deletion-guard.md「语义闸」的误判面登记)
    expect(
      suspectReason(`${HOME}/mono/packages/lib/node_modules`),
    ).not.toBeNull();
    expect(
      suspectReason(`${HOME}/dev/vscode-ext-dev/extensions/node_modules`),
    ).not.toBeNull();
  });
});

describe('classify: 平台风格', () => {
  test('win32: 反斜杠分隔符与大小写折叠后同样命中', () => {
    expect(
      suspectReason('C:\\Users\\me\\.NPM\\_npx\\abc123\\node_modules', {
        style: WIN32_STYLE,
        home: null,
      }),
    ).toBe('位于 .NPM 安装树目录');
    expect(
      suspectReason('C:\\Users\\me\\dev\\app\\node_modules', {
        style: WIN32_STYLE,
        home: null,
      }),
    ).toBeNull();
  });

  test('posix: 大小写不折叠 (但保守方向下大写作同样判安装树)', () => {
    // 折叠与否都判安装树: 大小写变体的误判落在安全侧 (多要一次 --force), 少一种平台分支
    expect(
      suspectReason(`${HOME}/.NPM/node_modules`, { style: POSIX_STYLE }),
    ).not.toBeNull();
  });

  test('win32: 跨盘目标不落入家目录下的隐藏目录判定', () => {
    expect(
      suspectReason('D:\\apps\\.hidden\\node_modules', {
        style: WIN32_STYLE,
        home: 'C:\\Users\\me',
      }),
    ).toBeNull();
  });

  test('Windows 盘根与单级路径不误判 (无祖先级)', () => {
    expect(
      suspectReason('C:\\node_modules', { style: WIN32_STYLE, home: null }),
    ).toBeNull();
  });
});
