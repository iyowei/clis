/**
 * `@iyowei/wake` 纯函数原语单元测试: MAC 归一化、102 字节魔术包、算术广播计算与安全校验。
 */
import { describe, expect, test } from 'bun:test';

import {
  buildMagicPacket,
  computeBroadcastIpv4,
  normalizeMac,
  normalizeMacList,
  parseIpv4NetmaskOctets,
  parseIpv4Octets,
  sameIpv4Subnet,
  validateBroadcastIpv4,
  validatePort,
  validateSafeHost,
  validateSafeRelay,
  validateTargetName,
} from './magic.ts';

describe('MAC 与魔术包原语', () => {
  test('支持冒号、横杠、Cisco 点分与无分隔 MAC 并去重归一化', () => {
    expect(normalizeMac('00:11:22:33:44:55')).toBe('00:11:22:33:44:55');
    expect(normalizeMac('AA-BB-CC-DD-EE-FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('0011.2233.4455')).toBe('00:11:22:33:44:55');
    expect(normalizeMac('aabbccddeeff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(
      normalizeMacList([
        '00-11-22-33-44-55',
        '00:11:22:33:44:55',
        'aa:bb:cc:dd:ee:ff',
      ]),
    ).toEqual(['00:11:22:33:44:55', 'aa:bb:cc:dd:ee:ff']);
  });

  test('非法 MAC 抛 WakeError', () => {
    expect(() => normalizeMac('')).toThrow();
    expect(() => normalizeMac('00:11:22:33:44')).toThrow();
    expect(() => normalizeMac('zz:11:22:33:44:55')).toThrow();
    expect(() => normalizeMacList([])).toThrow();
  });

  test('生成精确 102 字节标准魔术包 (6xFF + 16xMAC)', () => {
    const packet = buildMagicPacket('00-11-22-33-44-55');
    expect(packet.byteLength).toBe(102);
    for (let i = 0; i < 6; i += 1) {
      expect(packet[i]).toBe(0xff);
    }
    const expected = [0x00, 0x11, 0x22, 0x33, 0x44, 0x55];
    for (let rep = 0; rep < 16; rep += 1) {
      const start = 6 + rep * 6;
      expect(Array.from(packet.slice(start, start + 6))).toEqual(expected);
    }
  });
});

describe('算术 IPv4 子网与输入边界校验', () => {
  test('算术定向广播计算覆盖 /24 /23 /25 /16 掩码且零位运算', () => {
    expect(computeBroadcastIpv4('192.0.2.10', '255.255.255.0')).toBe(
      '192.0.2.255',
    );
    expect(computeBroadcastIpv4('198.51.100.130', '255.255.255.128')).toBe(
      '198.51.100.255',
    );
    expect(computeBroadcastIpv4('198.51.100.10', '255.255.255.128')).toBe(
      '198.51.100.127',
    );
    expect(computeBroadcastIpv4('10.20.4.5', '255.255.254.0')).toBe(
      '10.20.5.255',
    );
    expect(computeBroadcastIpv4('172.16.3.9', '255.255.0.0')).toBe(
      '172.16.255.255',
    );
    expect(computeBroadcastIpv4('bad', '255.255.255.0')).toBeNull();
    expect(parseIpv4NetmaskOctets('255.0.255.0')).toBeNull();
    expect(parseIpv4Octets('01.2.3.4')).toBeNull();
  });

  test('子网同域判定精确区分边界', () => {
    expect(sameIpv4Subnet('192.0.2.10', '192.0.2.50', '255.255.255.0')).toBe(
      true,
    );
    expect(
      sameIpv4Subnet('198.51.100.10', '198.51.100.140', '255.255.255.128'),
    ).toBe(false);
  });

  test('安全校验阻断前导短横线与 shell 元字符注入', () => {
    expect(validateTargetName('workstation-1')).toBe('workstation-1');
    expect(() => validateTargetName('-bad')).toThrow();
    expect(validateSafeHost('192.0.2.10')).toBe('192.0.2.10');
    expect(() => validateSafeHost('-oProxyCommand=id')).toThrow();
    expect(() => validateSafeHost('host;rm -rf')).toThrow();
    expect(validateSafeRelay('ops@bastion-a')).toBe('ops@bastion-a');
    expect(() => validateSafeRelay('bastion && id')).toThrow();
    expect(validateBroadcastIpv4('192.0.2.255')).toBe('192.0.2.255');
    expect(() => validateBroadcastIpv4('not-ip')).toThrow();
    expect(validatePort('22')).toBe(22);
    expect(() => validatePort('70000')).toThrow();
  });
});
