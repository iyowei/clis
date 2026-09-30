# 生成器契约 (Scaffold Contract)

> 文档类型: 仓库级设计
> 适用对象: 本仓维护者与 AI Agent
> 前置: [生成器包](scaffold-package.md)与[模板快照机制](scaffold-template-snapshot.md); 档位见[装置分档](capability-tiers.md)

## 命令形态

```
<runtime> create clis [dir] [flags]
```

- `npm create clis` / `pnpm create clis` / `bun create clis` / `bunx create-clis` 均可 (create 约定的三种分发入口, 已核验各自官方文档);
- `dir` 缺省为当前目录下以项目名命名的子目录; 目标目录已存在且非空即拒绝 (**不做覆盖**, 无 `--force` 逃生口: 覆盖已有目录的风险远大于其便利)。

## 变量

生成器采集五变量, 与快照词汇表一一对应:

| 变量     | 问询 / 旗标         | 缺省与校验                                           |
| -------- | ------------------- | ---------------------------------------------------- |
| 项目名   | 位置参数或 `--name` | 无缺省; 校验 kebab-case 且目录可用                   |
| scope    | `--scope`           | 缺省无 scope (裸包名)                                |
| bin 名   | `--bin`             | 缺省由项目名派生 (`<name>` 的短形态); 校验命令行可用 |
| owner    | `--owner`           | 缺省取 git 全局 `user.name`                          |
| 仓库地址 | `--repo`            | 缺省 `https://github.com/<owner>/<name>`             |

## 档位

`--tier core|standard|full` (缺省 `standard`)。含义与裁剪面见[装置分档](capability-tiers.md)。

## 流程 (时序)

1. **采集**: 无旗标时交互问答 (readline 直问直答, 零交互库依赖, 与本仓初始化向导同风格); 有旗标时零交互; 两者都先做合法性校验;
2. **复制与裁剪**: 取模板快照 → 按档裁剪装置;
3. **代入**: 变量替换 (词汇表全形态);
4. **收尾**: 视旗标执行 `git init` (缺省执行) 与依赖安装 (缺省执行, `--no-install` 关闭);
5. **自检**: 生成物再扫一遍变量零残留 (快照端已保证模板侧干净, 这里是代入完整性的第二道);
6. **交付**: 打印 next steps (进入目录 → `bun run ci` 验证绿 → 从[集合仓定位](collection-positioning.md)读起改造)。

## 旗标汇总

`--name` `--scope` `--bin` `--owner` `--repo` `--tier` `--no-git` `--no-install` `--yes` (全默认零交互)。

经 `npm create` 调用时, 旗标以 `--` 分隔传递 (`npm create clis -- --name x`), 属 npm 生态既有行为, 生成器无需感知。

## 失败处理

- 校验失败 / 目录冲突 / 复制或代入异常: 打印原因并以非零退出, 已产生的半成品目录如实指出 (不静默清理, 用户可自行查看);
- 生成器自身崩溃: 与既有 CLI 包同款的崩溃诊断纪律 (stderr 诊断 + 非零退出)。

## 修订记录

| 日期       | 修订                                         |
| ---------- | -------------------------------------------- |
| 2026-09-30 | 初稿: 命令形态、五变量、档位、流程与失败处理 |
