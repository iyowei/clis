/**
 * 示例包入口 (模板骨架): 展示最小可用的可编程 API 形状 —— 具名导出 + 参数对象 + 文档注释。
 *
 * 生成后的项目应把它替换为自己的领域实现 (并同步包 README 与包级文档)。
 * 注意: 模板内的代码标识符避开与占位词汇同名的插值形态, 防生成期变量替换误伤。
 */

/** 问候选项 */
export interface GreetOptions {
  /** 要问候的名字 */
  who: string;
}

/** 生成一句问候语 (示例实现, 无外部依赖) */
export const greet = ({ who }: GreetOptions): string => `Hello, ${who}!`;
