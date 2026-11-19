/**
 * SemVer 比较与安全输入白名单单元测试。
 */
import { describe, expect, test } from 'bun:test';

import {
  compareSemver,
  isNewerVersion,
  isValidPackageName,
  isValidRegistryUrl,
  isValidTargetSpec,
  parseSemver,
} from './semver.ts';

describe('parseSemver / compareSemver / isNewerVersion', () => {
  test('解析标准 SemVer 与可选 v 前缀、预发布段、build metadata', () => {
    expect(parseSemver('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
    expect(parseSemver('v2.0.0-rc.1+build.42')).toEqual({
      major: 2,
      minor: 0,
      patch: 0,
      prerelease: ['rc', '1'],
    });
    expect(parseSemver('not-a-version')).toBeNull();
    expect(parseSemver('1.2')).toBeNull();
  });

  test('遵循 SemVer 2.0.0 优先级比较主/次/补丁与预发布版本', () => {
    expect(compareSemver('0.3.0', '0.4.0')).toBe(-1);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.2.0', '1.1.9')).toBe(1);
    expect(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1);
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0+abc', '1.0.0+def')).toBe(0);
    expect(compareSemver('bad', '1.0.0')).toBeNull();
  });

  test('isNewerVersion 仅在合法且严格高于当前版本时返回 true', () => {
    expect(isNewerVersion('0.3.0', '0.3.1')).toBe(true);
    expect(isNewerVersion('0.3.0', '0.3.0')).toBe(false);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(false);
    expect(isNewerVersion('unknown', '1.0.0')).toBe(false);
  });
});

describe('安全白名单校验', () => {
  test('包名白名单拦截空白、命令分隔符与路径穿越', () => {
    expect(isValidPackageName('@iyowei/sweep-node-modules-cli')).toBe(true);
    expect(isValidPackageName('create-clis')).toBe(true);
    expect(isValidPackageName('bad; rm -rf /')).toBe(false);
    expect(isValidPackageName('../evil')).toBe(false);
    expect(isValidPackageName('@Scope/Upper')).toBe(false);
  });

  test('目标版本/tag 白名单拦截 shell 元字符', () => {
    expect(isValidTargetSpec('latest')).toBe(true);
    expect(isValidTargetSpec('1.2.3-beta.1')).toBe(true);
    expect(isValidTargetSpec('1.0.0 && whoami')).toBe(false);
    expect(isValidTargetSpec('$(id)')).toBe(false);
  });

  test('registry URL 仅放行干净的 http(s) 地址', () => {
    expect(isValidRegistryUrl('https://registry.npmjs.org')).toBe(true);
    expect(isValidRegistryUrl('https://registry.npmmirror.com/')).toBe(true);
    expect(isValidRegistryUrl('http://127.0.0.1:4873')).toBe(true);
    expect(isValidRegistryUrl('file:///etc/passwd')).toBe(false);
    expect(isValidRegistryUrl('https://a.com;whoami')).toBe(false);
    expect(isValidRegistryUrl('https://a.com/foo\nbar')).toBe(false);
  });
});
