/**
 * Registry 解析 (~/.npmrc & ~/.bunfig.toml 含 scoped 覆盖) 与远端版本查询单测。
 */
import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_REGISTRY,
  fetchLatestVersion,
  parseRegistryFromBunfig,
  parseRegistryFromNpmrc,
  resolveRegistry,
} from './registry.ts';

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

describe('fetchLatestVersion 远端查询', () => {
  test('正常响应提取 version 并正确编码 scoped 包名', async () => {
    let seenUrl = '';
    const mockFetch = async (input: string | URL) => {
      seenUrl = String(input);
      return new Response(
        JSON.stringify({
          name: '@iyowei/sweep-node-modules-cli',
          version: '0.4.0',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };

    const res = await fetchLatestVersion({
      packageName: '@iyowei/sweep-node-modules-cli',
      registry: 'https://registry.npmmirror.com/',
      fetchFn: mockFetch,
    });
    expect(seenUrl).toBe(
      'https://registry.npmmirror.com/%40iyowei%2Fsweep-node-modules-cli/latest',
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
});
