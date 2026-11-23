/**
 * Registry 解析 (~/.npmrc & ~/.bunfig.toml 含 scoped 覆盖) 与远端版本查询单测。
 */
import { describe, expect, test } from 'bun:test';

import { parseGlobalDirFromBunfig, stripTomlComment } from './config-parse.ts';
import {
  DEFAULT_REGISTRY,
  type ProbeGlobalRootsOptions,
  type ResolveRegistryAuthInput,
  type UpgradePlanExecutor,
  fetchLatestVersion,
  parseRegistryFromBunfig,
  parseRegistryFromNpmrc,
  resolveRegistry,
  resolveRegistryAuthToken,
} from './index.ts';

describe('~/.npmrc 与 ~/.bunfig.toml 解析', () => {
  test('~/.npmrc 优先匹配 scoped registry, 否则取全局 registry', () => {
    const npmrc = [
      '# 全局镜像',
      'registry=https://registry.npmmirror.com/',
      '@iyowei:registry=https://npm.internal.example.com/',
    ].join('\n');
    expect(parseRegistryFromNpmrc(npmrc, '@iyowei/codd-cli')).toBe(
      'https://npm.internal.example.com/',
    );
    expect(parseRegistryFromNpmrc(npmrc, 'create-clis')).toBe(
      'https://registry.npmmirror.com/',
    );
  });

  test('~/.bunfig.toml 正确解析 [install] 与 [install.scopes]', () => {
    const bunfig = [
      '[install]',
      'registry = "https://registry.npmmirror.com"',
      '[install.scopes]',
      '"@iyowei" = { url = "https://scoped.example.com" }',
    ].join('\n');
    expect(parseRegistryFromBunfig(bunfig, '@iyowei/codd-cli')).toBe(
      'https://scoped.example.com',
    );
    expect(parseRegistryFromBunfig(bunfig, 'create-clis')).toBe(
      'https://registry.npmmirror.com',
    );
  });

  test('resolveRegistry 优先级: flag > env > 用户家目录配置 > 官方源', () => {
    const files: Record<string, string> = {
      '/home/u/.bunfig.toml':
        '[install]\nregistry = "https://bun-mirror.example.com"',
      '/home/u/.npmrc': 'registry=https://npm-mirror.example.com',
    };
    const readText = (p: string): string | null =>
      files[p.replaceAll('\\', '/')] ?? null;

    expect(
      resolveRegistry({
        packageName: 'create-clis',
        flagRegistry: 'https://flag.example.com/',
        pm: 'bun',
        env: { npm_config_registry: 'https://env.example.com' },
        homeDir: '/home/u',
        readText,
      }),
    ).toBe('https://flag.example.com');

    expect(
      resolveRegistry({
        packageName: 'create-clis',
        pm: 'bun',
        env: { npm_config_registry: 'https://env.example.com/' },
        homeDir: '/home/u',
        readText,
      }),
    ).toBe('https://env.example.com');

    // NPM_CONFIG_REGISTRY 为空串或纯空白时自动回退到小写 npm_config_registry
    expect(
      resolveRegistry({
        packageName: 'create-clis',
        pm: 'npm',
        env: {
          NPM_CONFIG_REGISTRY: '',
          npm_config_registry: 'https://lower-env.example.com/',
        },
        homeDir: '/home/u',
        readText,
      }),
    ).toBe('https://lower-env.example.com');
    expect(
      resolveRegistry({
        packageName: 'create-clis',
        pm: 'npm',
        env: {
          NPM_CONFIG_REGISTRY: '   ',
          npm_config_registry: 'https://lower-trim.example.com/',
        },
        homeDir: '/home/u',
        readText,
      }),
    ).toBe('https://lower-trim.example.com');

    // 验证公开入口 index.ts 完整导出扩展类型与鉴权解析函数
    const _typeCheck: [
      ProbeGlobalRootsOptions,
      UpgradePlanExecutor,
      ResolveRegistryAuthInput,
    ] = [
      { homeDir: '/home/u' },
      () => ({ status: 0 }),
      { packageName: 'create-clis', registry: DEFAULT_REGISTRY },
    ];
    expect(_typeCheck.length).toBe(3);

    expect(
      resolveRegistry({
        packageName: 'create-clis',
        pm: 'bun',
        env: {},
        homeDir: '/home/u',
        readText,
      }),
    ).toBe('https://bun-mirror.example.com');

    expect(
      resolveRegistry({
        packageName: 'create-clis',
        pm: 'npm',
        env: {},
        homeDir: '/home/u',
        readText,
      }),
    ).toBe('https://npm-mirror.example.com');

    expect(
      resolveRegistry({
        packageName: 'create-clis',
        env: {},
        homeDir: '/home/empty',
        readText: () => null,
      }),
    ).toBe(DEFAULT_REGISTRY);
  });
});

describe('查源一致、bunfig 语法增强与私有源鉴权', () => {
  test('查源与装源一致: 明确非 Bun 管理器绝不回退读取 ~/.bunfig.toml', () => {
    const onlyBunfig: Record<string, string> = {
      '/home/u/.bunfig.toml':
        '[install]\nregistry = "https://bun-mirror.example.com"',
    };
    const readText = (p: string): string | null =>
      onlyBunfig[p.replaceAll('\\', '/')] ?? null;

    for (const pm of ['npm', 'pnpm', 'yarn', 'volta'] as const) {
      expect(
        resolveRegistry({
          packageName: 'create-clis',
          pm,
          env: {},
          homeDir: '/home/u',
          readText,
        }),
      ).toBe(DEFAULT_REGISTRY);
    }

    // 仅 bun 或未定 pm 时才读 ~/.bunfig.toml
    expect(
      resolveRegistry({
        packageName: 'create-clis',
        pm: 'bun',
        env: {},
        homeDir: '/home/u',
        readText,
      }),
    ).toBe('https://bun-mirror.example.com');
    expect(
      resolveRegistry({
        packageName: 'create-clis',
        env: {},
        homeDir: '/home/u',
        readText,
      }),
    ).toBe('https://bun-mirror.example.com');
  });

  test('~/.bunfig.toml 支持引号感知注释、[install.registry]、[install.scopes."@scope"] 与内联表', () => {
    expect(stripTomlComment('url = "https://a.com/#ok" # 行尾注释')).toBe(
      'url = "https://a.com/#ok"',
    );

    const inlineAndSubtable = [
      '[install]',
      'registry = { url = "https://inline.example.com/", token = "$GLOB_TOK" } # 全局源',
      'globalDir = "~/.custom-bun/global" # 自定义全局目录',
      '',
      '[install.scopes."@iyowei"]',
      'url = "https://subtable.example.com" # scope 子表',
      'token = "$SCOPE_TOK"',
    ].join('\n');
    expect(parseRegistryFromBunfig(inlineAndSubtable, '@iyowei/codd-cli')).toBe(
      'https://subtable.example.com',
    );
    expect(parseRegistryFromBunfig(inlineAndSubtable, 'create-clis')).toBe(
      'https://inline.example.com/',
    );
    expect(parseGlobalDirFromBunfig(inlineAndSubtable)).toBe(
      '~/.custom-bun/global',
    );

    const registrySubtable = [
      '[install.registry]',
      'url = "https://reg-subtable.example.com" # 注释',
      'token = "$REG_TOK"',
    ].join('\n');
    expect(parseRegistryFromBunfig(registrySubtable, 'create-clis')).toBe(
      'https://reg-subtable.example.com',
    );
  });

  test('resolveRegistryAuthToken 同源 host/path 精确匹配与环境变量展开, 绝不跨源外泄', () => {
    const files: Record<string, string> = {
      '/home/u/.npmrc': [
        '//npm.pkg.github.com/:_authToken=${GH_TOKEN}',
        '//artifactory.corp.com/api/npm/team/:_authToken="corp-secret"',
      ].join('\n'),
      '/home/u/.bunfig.toml': [
        '[install]',
        'registry = { url = "https://bun-priv.example.com/npm/", token = "$BUN_TOK" }',
        '[install.scopes."@iyowei"]',
        'url = "https://scoped-priv.example.com"',
        'token = "$SCOPED_TOK"',
      ].join('\n'),
    };
    const readText = (p: string): string | null =>
      files[p.replaceAll('\\', '/')] ?? null;

    // ~/.npmrc 命中同 host/path 且正确展开 ${ENV}
    expect(
      resolveRegistryAuthToken({
        packageName: '@iyowei/codd-cli',
        registry: 'https://npm.pkg.github.com',
        pm: 'npm',
        env: { GH_TOKEN: 'ghp_test_secret_123' },
        homeDir: '/home/u',
        readText,
      }),
    ).toBe('ghp_test_secret_123');

    // 环境变量缺失时不回退字面量 ${GH_TOKEN}
    expect(
      resolveRegistryAuthToken({
        packageName: '@iyowei/codd-cli',
        registry: 'https://npm.pkg.github.com',
        pm: 'npm',
        env: {},
        homeDir: '/home/u',
        readText,
      }),
    ).toBeUndefined();

    // 同 host 但不同 path 绝不匹配
    expect(
      resolveRegistryAuthToken({
        packageName: '@iyowei/codd-cli',
        registry: 'https://artifactory.corp.com/api/npm/other',
        pm: 'npm',
        env: {},
        homeDir: '/home/u',
        readText,
      }),
    ).toBeUndefined();
    expect(
      resolveRegistryAuthToken({
        packageName: '@iyowei/codd-cli',
        registry: 'https://artifactory.corp.com/api/npm/team/',
        pm: 'npm',
        env: {},
        homeDir: '/home/u',
        readText,
      }),
    ).toBe('corp-secret');

    // ~/.bunfig.toml 同源匹配 $ENV, 且 npm 不会读 bunfig token
    expect(
      resolveRegistryAuthToken({
        packageName: '@iyowei/codd-cli',
        registry: 'https://scoped-priv.example.com',
        pm: 'bun',
        env: { SCOPED_TOK: 'bun_tok_xyz' },
        homeDir: '/home/u',
        readText,
      }),
    ).toBe('bun_tok_xyz');
    expect(
      resolveRegistryAuthToken({
        packageName: '@iyowei/codd-cli',
        registry: 'https://scoped-priv.example.com',
        pm: 'npm',
        env: { SCOPED_TOK: 'bun_tok_xyz' },
        homeDir: '/home/u',
        readText,
      }),
    ).toBeUndefined();

    // 降级为 http:// 不发送 https:// 配置的 token
    expect(
      resolveRegistryAuthToken({
        packageName: '@iyowei/codd-cli',
        registry: 'http://scoped-priv.example.com',
        pm: 'bun',
        env: { SCOPED_TOK: 'bun_tok_xyz' },
        homeDir: '/home/u',
        readText,
      }),
    ).toBeUndefined();
  });
});

describe('fetchLatestVersion 远端查询', () => {
  test('正常响应提取 version 并正确编码 scoped 包名', async () => {
    let seenUrl = '';
    const mockFetch = async (input: string | URL) => {
      seenUrl = String(input);
      return new Response(
        JSON.stringify({
          name: '@iyowei/sweep-cli',
          version: '0.4.0',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    const res = await fetchLatestVersion({
      packageName: '@iyowei/sweep-cli',
      registry: 'https://registry.npmmirror.com/',
      fetchFn: mockFetch,
    });
    expect(seenUrl).toBe(
      'https://registry.npmmirror.com/%40iyowei%2Fsweep-cli/latest',
    );
    expect(res).toEqual({
      ok: true,
      version: '0.4.0',
      registry: 'https://registry.npmmirror.com',
    });
  });

  test('404 未发布、5xx 错误、断网与损坏响应分别返回精确错误码', async () => {
    const res404 = await fetchLatestVersion({
      packageName: '@iyowei/codd-cli',
      registry: DEFAULT_REGISTRY,
      fetchFn: async () => new Response('Not Found', { status: 404 }),
    });
    expect(res404.ok).toBe(false);
    if (!res404.ok) expect(res404.code).toBe('not-found');

    const res500 = await fetchLatestVersion({
      packageName: 'create-clis',
      registry: DEFAULT_REGISTRY,
      fetchFn: async () => new Response('Boom', { status: 503 }),
    });
    expect(res500.ok).toBe(false);
    if (!res500.ok) expect(res500.code).toBe('http');

    const resNet = await fetchLatestVersion({
      packageName: 'create-clis',
      registry: DEFAULT_REGISTRY,
      fetchFn: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(resNet.ok).toBe(false);
    if (!resNet.ok) expect(resNet.code).toBe('network');

    const resBad = await fetchLatestVersion({
      packageName: 'create-clis',
      registry: DEFAULT_REGISTRY,
      fetchFn: async () =>
        new Response(JSON.stringify({ version: '1.0.0; rm -rf /' }), {
          status: 200,
        }),
    });
    expect(resBad.ok).toBe(false);
    if (!resBad.ok) expect(resBad.code).toBe('invalid-response');
  });

  test('注入 Authorization Bearer 头、401/403 归类 auth 且错误消息严禁回显 token', async () => {
    const secret = 'tok_super_secret_987654';
    let seenAuth: string | undefined;

    const okRes = await fetchLatestVersion({
      packageName: '@iyowei/codd-cli',
      registry: 'https://npm.pkg.github.com',
      authToken: secret,
      fetchFn: async (_url, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        seenAuth = headers?.authorization;
        return new Response(JSON.stringify({ version: '1.2.3' }), {
          status: 200,
        });
      },
    });
    expect(okRes).toEqual({
      ok: true,
      version: '1.2.3',
      registry: 'https://npm.pkg.github.com',
    });
    expect(seenAuth).toBe(`Bearer ${secret}`);

    for (const status of [401, 403]) {
      const authRes = await fetchLatestVersion({
        packageName: '@iyowei/codd-cli',
        registry: 'https://npm.pkg.github.com',
        authToken: secret,
        fetchFn: async () => new Response('Unauthorized', { status }),
      });
      expect(authRes.ok).toBe(false);
      if (!authRes.ok) {
        expect(authRes.code).toBe('auth');
        expect(authRes.status).toBe(status);
        expect(authRes.message).not.toContain(secret);
      }
    }

    const netRes = await fetchLatestVersion({
      packageName: '@iyowei/codd-cli',
      registry: 'https://npm.pkg.github.com',
      authToken: secret,
      fetchFn: async () => {
        throw new Error(`request failed with token ${secret}`);
      },
    });
    expect(netRes.ok).toBe(false);
    if (!netRes.ok) {
      expect(netRes.code).toBe('network');
      expect(netRes.message).not.toContain(secret);
      expect(netRes.message).toContain('[REDACTED]');
    }
  });
});
