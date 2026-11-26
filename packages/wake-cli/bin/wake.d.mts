/**
 * bin/wake.mjs 的类型投影: 供 `src/launcher.runtime-resolution.test.ts` 带类型地导入测试。
 */
export declare const isSupportedNodeVersion: (rawVersion: unknown) => boolean;

export declare const resolveWin32Executables: (
  name: string,
  pathEnv: string,
  fileProbe: (candidate: string) => boolean,
) => string[];

export declare const resolvePosixExecutables: (
  name: string,
  pathEnv: string,
  fileProbe: (candidate: string) => boolean,
) => string[];

export declare const pickRuntime: (options?: {
  platform?: NodeJS.Platform;
  pathEnv?: string;
  fileProbe?: (candidate: string) => boolean;
  probe?: (command: string) => boolean;
  names?: readonly string[];
}) => string | null;

export declare const isEntry: (
  entryArg?: string,
  selfUrl?: string,
  platform?: NodeJS.Platform,
) => boolean;
