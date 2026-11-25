/**
 * 非全局受管安装来源 (`source` / `ephemeral` / `local-project`) 的安全指引分支 (中英双语)。
 */
import { type Locale, t } from '@iyowei/cli-i18n';

import { type InstallOrigin } from './detect.ts';
import { type FetchVersionResult } from './registry.ts';
import { compareSemver } from './semver.ts';
import { type UpdateSpinner } from './spinner.ts';
import { type UpdateUi, createUpdateUi, extractRegistryHost } from './ui.ts';
import {
  type PackageMetaRef,
  type UpdateIORef,
  describeOrigin,
  ephemeralHintCommand,
  localProjectHintCommand,
  sanitize,
} from './update-helpers.ts';

export async function handleNonGlobalOrigin(ctx: {
  meta: PackageMetaRef;
  origin: Extract<
    InstallOrigin,
    { kind: 'source' | 'ephemeral' | 'local-project' }
  >;
  hasExplicitRegistry: boolean;
  io: UpdateIORef;
  ui?: UpdateUi;
  spinner?: UpdateSpinner;
  fetchVersion: (registry: string) => Promise<FetchVersionResult>;
  registry: string;
  locale?: Locale;
}): Promise<number> {
  const locale = ctx.locale ?? 'zh';
  const { meta, origin, hasExplicitRegistry, io, fetchVersion, registry } = ctx;
  const ui = ctx.ui ?? createUpdateUi({ stdout: false, stderr: false }, locale);
  io.out(
    ui.kv(
      t(locale, '当前版本', 'Current'),
      `${meta.name}@${meta.version}`,
      'bold',
    ),
  );
  io.out(
    ui.kv(t(locale, '安装方式', 'Origin'), describeOrigin(origin, locale)),
  );

  if (meta.isPrivate !== true || hasExplicitRegistry) {
    ctx.spinner?.start(
      t(locale, '正在检查最新版本', 'Checking latest version'),
      extractRegistryHost(registry),
    );
    let remote: FetchVersionResult;
    try {
      remote = await fetchVersion(registry);
    } finally {
      ctx.spinner?.stop();
    }
    if (remote.ok) {
      const cmp = compareSemver(meta.version, remote.version);
      let status: string;
      if (cmp === -1) {
        status = t(
          locale,
          `发现新版本 ${remote.version} (源: ${remote.registry})`,
          `Update available: ${remote.version} (${remote.registry})`,
        );
      } else if (cmp === null) {
        status = t(
          locale,
          `远端版本为 ${remote.version} (无法按 SemVer 比较, 源: ${remote.registry})`,
          `Remote version ${remote.version} (non-standard SemVer, ${remote.registry})`,
        );
      } else {
        status = t(
          locale,
          `远端最新版为 ${remote.version} (源: ${remote.registry})`,
          `Latest is ${remote.version} (${remote.registry})`,
        );
      }
      io.out(
        ui.kv(
          t(locale, '版本检查', 'Latest'),
          status,
          cmp === -1 ? 'cyan' : 'plain',
        ),
      );
    } else if (remote.code !== 'not-found') {
      io.out(
        ui.kv(
          t(locale, '版本检查', 'Latest'),
          t(
            locale,
            `暂未获取远端版本 (${sanitize(remote.message)})`,
            `Could not check remote version (${sanitize(remote.message)})`,
          ),
          'dim',
        ),
      );
    }
  }

  const updateLabel = t(locale, '更新方式', 'How to Update');
  if (origin.kind === 'source') {
    io.out(
      ui.kv(
        updateLabel,
        t(
          locale,
          '当前运行在本地源码工作树, 不通过包管理器覆盖。',
          'Running from local source checkout; skipped package manager install.',
        ),
      ),
    );
    io.out(
      ui.hint(
        t(
          locale,
          '  请在仓库根目录运行: git pull && bun install && bun run build',
          '  Update in repository root: git pull && bun install && bun run build',
        ),
      ),
    );
    io.out(
      ui.hint(
        t(
          locale,
          '  若要通过包管理器安装全局发布版, 可显式指定 --pm <bun|npm|pnpm|yarn|volta>',
          '  To install a global published copy instead, pass --pm <bun|npm|pnpm|yarn|volta>',
        ),
      ),
    );
    return 0;
  }

  if (origin.kind === 'ephemeral') {
    io.out(
      ui.kv(
        updateLabel,
        t(
          locale,
          `当前经 ${origin.runner} 临时运行, 无需原地升级。`,
          `Executed temporarily via ${origin.runner}; no in-place upgrade needed.`,
        ),
      ),
    );
    io.out(
      ui.hint(
        t(
          locale,
          `  下次获取最新版请运行: ${sanitize(ephemeralHintCommand(origin.runner, meta.name))}`,
          `  Run the latest release anytime with: ${sanitize(ephemeralHintCommand(origin.runner, meta.name))}`,
        ),
      ),
    );
    io.out(
      ui.hint(
        t(
          locale,
          '  若希望改为全局安装, 可运行带 --pm <bun|npm|pnpm|yarn|volta> 的 update 或直接全局安装',
          '  To install globally, pass --pm <bun|npm|pnpm|yarn|volta>',
        ),
      ),
    );
    return 0;
  }

  io.out(
    ui.kv(
      updateLabel,
      t(
        locale,
        `当前作为项目本地依赖运行 (${sanitize(origin.projectDir)}), 为避免静默改写项目锁文件, 不自动覆盖。`,
        `Running as a project dependency (${sanitize(origin.projectDir)}); skipped to avoid mutating lockfiles.`,
      ),
    ),
  );
  io.out(
    ui.hint(
      t(
        locale,
        `  请在项目目录执行: ${sanitize(localProjectHintCommand(origin.suggestedPm, meta.name))}`,
        `  Upgrade inside the project directory: ${sanitize(localProjectHintCommand(origin.suggestedPm, meta.name))}`,
      ),
    ),
  );
  return 0;
}
