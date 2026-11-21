/**
 * 发布凭据闸门单测: 纯函数层 (远端 URL 派生 / npm trust 输出解析 / 登记对账 / OIDC 环境判定 /
 * 预检核对面过滤 / ID 白名单 / Linux PTY 转义)。
 */
import { describe, expect, test } from 'bun:test';

import type { WorkspacePackage } from './lib/workspace.ts';
import {
  classifyOidcEnv,
  deriveRepoFromRemoteUrl,
  diffTrust,
  evaluateTrustEntries,
  filterPublishable,
  isValidTrustId,
  parseTrustListEntries,
  parseTrustListOutput,
  ptyWrapArgs,
} from './npm-trust-guard.ts';

/** 终端控制符经 fromCharCode 构造: 防源码里的转义序列在落盘时被求值成真实不可见字符 */
const ESC = String.fromCharCode(27);
const green = (text: string): string => `${ESC}[32m${text}${ESC}[39m`;

describe('deriveRepoFromRemoteUrl', () => {
  test('SSH 形态', () => {
    expect(deriveRepoFromRemoteUrl('git@github.com:iyowei/clis.git')).toBe(
      'iyowei/clis',
    );
  });

  test('HTTPS 形态 (带与不带 .git 后缀)', () => {
    expect(deriveRepoFromRemoteUrl('https://github.com/iyowei/clis.git')).toBe(
      'iyowei/clis',
    );
    expect(deriveRepoFromRemoteUrl('https://github.com/iyowei/clis')).toBe(
      'iyowei/clis',
    );
  });

  test('非 GitHub 远端与空串返回 null', () => {
    expect(deriveRepoFromRemoteUrl('git@gitlab.com:foo/bar.git')).toBeNull();
    expect(deriveRepoFromRemoteUrl('')).toBeNull();
  });
});

describe('parseTrustListOutput', () => {
  test('解析实测形态 (键值行, 值带 ANSI 着色)', () => {
    const raw = [
      `type: ${green('github')}`,
      `id: ${green('625b8bc6-f738-4aac-9a92-70ba2f01ce80')}`,
      `file: ${green('release.yml')}`,
      `repository: ${green('iyowei/clis')}`,
      `environment: ${green('release')}`,
      'permissions: publish, stage publish',
    ].join('\n');
    expect(parseTrustListOutput(raw)).toEqual({
      type: 'github',
      id: '625b8bc6-f738-4aac-9a92-70ba2f01ce80',
      file: 'release.yml',
      repository: 'iyowei/clis',
      environment: 'release',
    });
  });

  test('混入认证提示等噪音行不影响解析; 缺行字段落成 null', () => {
    const raw = [
      'npm notice npm tokens that bypass 2FA are being restricted',
      'Authenticate your account at:',
      'https://www.npmjs.com/auth/cli/xxx',
      'Press ENTER to open in the browser...',
      '',
      'type: github',
      'repository: iyowei/clis',
      'file: release.yml',
    ].join('\n');
    expect(parseTrustListOutput(raw)).toEqual({
      type: 'github',
      id: null,
      file: 'release.yml',
      repository: 'iyowei/clis',
      environment: null,
    });
  });

  test('未见 repository 行视为形状不符 (解析不出可信条目)', () => {
    expect(parseTrustListOutput('npm error code EOTP\n')).toBeNull();
    expect(parseTrustListOutput('')).toBeNull();
  });

  test('spinner 的 CSI 光标控制序列 (非 m 结尾) 不残留进键值行', () => {
    const csi = (tail: string): string => `${ESC}[1G${ESC}[0K${tail}`;
    const raw = `${csi('type: github')}\r\n${csi('repository: iyowei/clis')}\r\n${csi('file: release.yml')}\r\n`;
    expect(parseTrustListOutput(raw)).toEqual({
      type: 'github',
      id: null,
      file: 'release.yml',
      repository: 'iyowei/clis',
      environment: null,
    });
  });

  test('script pty 的 ^D + 退格开场与 CRLF 行尾不影响解析', () => {
    const raw =
      [
        `${String.fromCharCode(4, 8, 8)}type: github`,
        'repository: iyowei/clis',
        'file: release.yml',
      ].join('\r\n') + '\r\n';
    expect(parseTrustListOutput(raw)).toEqual({
      type: 'github',
      id: null,
      file: 'release.yml',
      repository: 'iyowei/clis',
      environment: null,
    });
  });

  test('多条登记按段独立解析, 字段不串味', () => {
    const raw = [
      'type: github',
      'id: id-1',
      'repository: iyowei/old',
      'file: old.yml',
      '',
      'type: github',
      'id: id-2',
      'repository: iyowei/clis',
      'file: release.yml',
      'environment: release',
    ].join('\n');
    expect(parseTrustListEntries(raw)).toEqual([
      {
        type: 'github',
        id: 'id-1',
        file: 'old.yml',
        repository: 'iyowei/old',
        environment: null,
      },
      {
        type: 'github',
        id: 'id-2',
        file: 'release.yml',
        repository: 'iyowei/clis',
        environment: 'release',
      },
    ]);
  });
});

describe('isValidTrustId', () => {
  test('UUID 与常规标识符通过, 含 Shell 元字符或空白拒绝', () => {
    expect(isValidTrustId('625b8bc6-f738-4aac-9a92-70ba2f01ce80')).toBe(true);
    expect(isValidTrustId('id; rm -rf /')).toBe(false);
    expect(isValidTrustId('$(whoami)')).toBe(false);
    expect(isValidTrustId('')).toBe(false);
  });
});

describe('diffTrust', () => {
  const expected = {
    repository: 'iyowei/clis',
    file: 'release.yml',
    environment: 'release',
  };

  test('全一致返回空列表', () => {
    expect(
      diffTrust(
        {
          type: 'github',
          id: 'x',
          file: 'release.yml',
          repository: 'iyowei/clis',
          environment: 'release',
        },
        expected,
      ),
    ).toEqual([]);
  });

  test('repository 失配逐条列出 (改名事故的典型形态)', () => {
    const problems = diffTrust(
      {
        type: 'github',
        id: 'x',
        file: 'release.yml',
        repository: 'iyowei/legacy-repo',
        environment: 'release',
      },
      expected,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('iyowei/legacy-repo');
    expect(problems[0]).toContain('iyowei/clis');
  });

  test('file 与 environment 失配一并列出 (缺失值有占位)', () => {
    const problems = diffTrust(
      {
        type: 'github',
        id: 'x',
        file: 'publish.yml',
        repository: 'iyowei/clis',
        environment: null,
      },
      expected,
    );
    expect(problems).toHaveLength(2);
    expect(problems[1]).toContain('(未设置)');
  });

  test('evaluateTrustEntries 全量核对多条登记: 混入过时旧条目或重复条目均判未对齐', () => {
    const good = {
      type: 'github',
      id: 'id-ok',
      file: 'release.yml',
      repository: 'iyowei/clis',
      environment: 'release',
    };
    const stale = {
      type: 'github',
      id: 'id-old',
      file: 'old.yml',
      repository: 'iyowei/legacy',
      environment: null,
    };
    expect(evaluateTrustEntries([good], expected).aligned).toBe(true);
    const mixed = evaluateTrustEntries([good, stale], expected);
    expect(mixed.aligned).toBe(false);
    expect(mixed.matching).toHaveLength(1);
    expect(mixed.mismatched).toHaveLength(1);
    expect(mixed.mismatched[0]!.entry.id).toBe('id-old');
    expect(evaluateTrustEntries([good, good], expected).aligned).toBe(false);
  });
});

describe('classifyOidcEnv', () => {
  test('Actions 环境且 OIDC 变量齐备 → ready', () => {
    expect(
      classifyOidcEnv({
        GITHUB_ACTIONS: 'true',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.test/oidc',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token',
      }),
    ).toBe('ready');
  });

  test('Actions 环境缺 OIDC 变量 → missing-permission (工作流漏配 id-token)', () => {
    expect(classifyOidcEnv({ GITHUB_ACTIONS: 'true' })).toBe(
      'missing-permission',
    );
  });

  test('本地环境 → not-ci', () => {
    expect(classifyOidcEnv({})).toBe('not-ci');
  });
});

describe('ptyWrapArgs', () => {
  test('darwin 用 script -q /dev/null 包裹', () => {
    expect(ptyWrapArgs('darwin', 'npm', ['trust', 'list', '@x/y'])).toEqual({
      command: 'script',
      args: ['-q', '/dev/null', 'npm', 'trust', 'list', '@x/y'],
    });
  });

  test('linux 用 script -qec 命令串 (安全字符集保洁净)', () => {
    expect(
      ptyWrapArgs('linux', 'npm', ['trust', 'github', '--repo', 'iyowei/clis']),
    ).toEqual({
      command: 'script',
      args: ['-qec', 'npm trust github --repo iyowei/clis', '/dev/null'],
    });
  });

  test('linux 对含 Shell 元字符的参数做严格单引号转义防注入', () => {
    expect(
      ptyWrapArgs('linux', 'npm', ['trust', 'revoke', '--id=$(pwn);echo hi']),
    ).toEqual({
      command: 'script',
      args: ['-qec', "npm trust revoke '--id=$(pwn);echo hi'", '/dev/null'],
    });
  });

  test('win32 无 script, 降级直跑原命令', () => {
    expect(ptyWrapArgs('win32', 'npm.cmd', ['trust', 'list'])).toEqual({
      command: 'npm.cmd',
      args: ['trust', 'list'],
    });
  });
});

describe('filterPublishable', () => {
  const pkg = (name: string, isPrivate = false): WorkspacePackage => ({
    name,
    dir: `packages/${name}`,
    manifest: isPrivate ? { name, private: true } : { name },
  });

  test('private 包被排除, 非 private 包保留', () => {
    const packages = [
      pkg('@x/api'),
      pkg('@x/cli'),
      pkg('@x/private-lib', true),
    ];
    expect(filterPublishable(packages).map((item) => item.name)).toEqual([
      '@x/api',
      '@x/cli',
    ]);
  });

  test('private 字段缺失或非 true 均视为可发布, 不误伤', () => {
    const packages: WorkspacePackage[] = [
      pkg('@x/api'),
      {
        name: '@x/flag',
        dir: 'packages/flag',
        manifest: { name: '@x/flag', private: false },
      },
    ];
    expect(filterPublishable(packages).map((item) => item.name)).toEqual([
      '@x/api',
      '@x/flag',
    ]);
  });
});
