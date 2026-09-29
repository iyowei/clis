/**
 * 合成工作区生成器: 为扫描 / 体积 / 安全闸的测试与基准提供确定的目录树。
 * 全部生成在系统临时目录下; 调用方经返回的 cleanup() 清理。
 * 返回的 root 取 realpath 归一形态: macOS 的临时目录拼写 (/var/folders/...) 含系统符号链接
 * (/var → /private/var), 而删除侧的根锚点检查要求信任根为真实路径形态
 * (见 docs/designs/deletion-guard.md「校验不变量」⑤), 未归一会让所有删除用例假性拒绝。
 */
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ProjectSpec {
  /** 项目目录相对路径 (相对工作区根) */
  dir: string;
  /** node_modules 内散文件数 (默认 2) */
  files?: number;
  /** 每个文件字节数 (默认 256) */
  bytesPerFile?: number;
  /** 在 node_modules 内部再嵌一层 node_modules (剪枝用例) */
  nested?: boolean;
  /** 生成 .git 目录并在其中埋诱饵 node_modules (跳过 .git 的用例) */
  git?: boolean;
}

export interface WorkspaceSpec {
  projects: ProjectSpec[];
  /** 目录符号链接: at -> to (均为工作区根相对路径) */
  symlinks?: { at: string; to: string }[];
  /** 不可读目录 (chmod 000, 空目录) */
  unreadable?: string[];
}

export interface Workspace {
  root: string;
  cleanup(): Promise<void>;
}

const filler = (n: number) => 'x'.repeat(n);

/** 清理重试上限: 竞态与挂载占用都是瞬态, 给足重试轮次后再降级 */
const CLEANUP_ATTEMPTS = 3;

/** 重试退避基数 (毫秒): 给仍在飞的并发删除留出落定时间 */
const CLEANUP_RETRY_DELAY_MS = 50;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** 只探存在性, 不抛 */
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/**
 * 自愈式删除临时目录: 至多 CLEANUP_ATTEMPTS 轮「rm + 复查现场」, 仍未删净降级为警告 (不抛)。
 * 判据只能是「现场是否还在」, 不能只看错误码: Bun 的 fs.rm 在并发删除下会中途返回, 既不报错
 * 也不删净 (静默半途而废); 挂载点仍活跃时则抛 EBUSY (force 不忽略 EBUSY)。故每轮 rm 后一律
 * 以 lstat 复核, 残留即重试, 上限内未清干净转人工: 清理失败绝不抛断调用方的收尾链。
 * @returns 是否已确认删净 (false 表示已降级为警告, 现场留待人工清理)
 */
export async function removeDirResilient(root: string): Promise<boolean> {
  let lastCode = '';
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(CLEANUP_RETRY_DELAY_MS * attempt);
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      lastCode = (error as { code?: string } | null)?.code ?? String(error);
    }
    if (!(await exists(root))) return true;
  }
  const detail = lastCode === '' ? '' : ` (末次错误: ${lastCode})`;
  process.stderr.write(
    `[Warning] 临时目录未能删净${detail}, 请人工清理: ${root}\n`,
  );
  return false;
}

export async function makeWorkspace(spec: WorkspaceSpec): Promise<Workspace> {
  const rawRoot = await mkdtemp(join(tmpdir(), 'sweep-lab-'));
  // 归一理由见文件头; 建树与返回统一用归一后的形态, 两者必须同一坐标系
  const root = await realpath(rawRoot);

  for (const project of spec.projects) {
    const nodeModules = join(root, project.dir, 'node_modules');
    await mkdir(nodeModules, { recursive: true });
    const files = project.files ?? 2;
    const bytes = project.bytesPerFile ?? 256;
    for (let i = 0; i < files; i += 1) {
      await writeFile(join(nodeModules, `pkg-${i}.js`), filler(bytes));
    }
    if (project.nested) {
      const inner = join(nodeModules, 'dep', 'node_modules');
      await mkdir(inner, { recursive: true });
      await writeFile(join(inner, 'inner.js'), filler(64));
    }
    if (project.git) {
      const bait = join(root, project.dir, '.git', 'x', 'node_modules');
      await mkdir(bait, { recursive: true });
      await writeFile(join(bait, 'bait.js'), filler(64));
    }
  }

  for (const link of spec.symlinks ?? []) {
    await symlink(join(root, link.to), join(root, link.at));
  }

  for (const dir of spec.unreadable ?? []) {
    await mkdir(join(root, dir), { recursive: true });
    await chmod(join(root, dir), 0o000);
  }

  return {
    root,
    async cleanup() {
      for (const dir of spec.unreadable ?? []) {
        await chmod(join(root, dir), 0o700).catch(() => {});
      }
      // 失败已降级为警告 (见 removeDirResilient), 调用方的收尾链不被抛断
      await removeDirResilient(root);
    },
  };
}

/**
 * 建大扇出目录树 (fanout 个子目录, 每个含一层 inner 与文件): 为「rm 递归期间内部条目消失」
 * 的竞态探针拉长删除时间窗口 (delete.ts 双运行时语义分叉兜底的行为用例)。
 */
export async function makeWideTree(
  root: string,
  fanout: number,
): Promise<void> {
  await mkdir(root, { recursive: true });
  const jobs: Promise<unknown>[] = [];
  for (let i = 0; i < fanout; i += 1) {
    const dir = join(root, `c${String(i).padStart(4, '0')}`);
    jobs.push(
      mkdir(join(dir, 'inner'), { recursive: true }).then(() =>
        writeFile(join(dir, 'inner', 'payload.js'), filler(64)),
      ),
    );
  }
  await Promise.all(jobs);
}

/**
 * 竞态跑者: 后台持续删除树内的直接子项 (恒保留 ≥ 2 个, 绝不删根), 返回停止函数。
 * 与并行的 fs.rm 竞争, 构造「递归途中内部条目消失」的时序缝 (同上, 竞态探针专用)。
 * 停止函数返回 Promise, resolve 时循环已退出且其 in-flight rm 已落定: 调用方必须 await,
 * 不等就进入后续清理, 那次在飞的删除会与清理 rm 并发, Bun 的 rm 遇并发静默半途而废,
 * 把整个工作区以残骸形态留在临时目录。
 */
export function startChildRacer(tree: string): () => Promise<void> {
  let running = true;
  const racer = (async () => {
    while (running) {
      let names: string[];
      try {
        names = await readdir(tree);
      } catch {
        return; // 树已消失 (rm 成功): 竞态自然结束
      }
      if (names.length <= 2) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        continue;
      }
      const victim = names[Math.floor(Math.random() * names.length)];
      if (victim === undefined) continue;
      await rm(join(tree, victim), { recursive: true, force: true }).catch(
        () => {},
      );
    }
  })();
  return async () => {
    running = false;
    await racer;
  };
}
