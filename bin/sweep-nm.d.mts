/**
 * bin/sweep-nm.mjs 的类型投影: 分发入口是纯 JS (node 直跑, 不进 tsc 编译面), 此声明只为让
 * src/launcher.runtime-resolution.test.ts 能带类型地 import 其中的两个导出。
 * 签名与实现须同步; 实现本体与语义说明见 bin/sweep-nm.mjs。
 */
export declare const resolveWin32Executable: (
  name: string,
  pathEnv: string,
  fileProbe: (candidate: string) => boolean,
) => string | null;

export declare const pickRuntime: (options?: {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  fileProbe?: (candidate: string) => boolean;
  probe?: (command: string) => boolean;
}) => string | null;
