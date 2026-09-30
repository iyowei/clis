# {{SCOPE}}/{{NAME}}

<!-- 模板骨架: 示例包的可编程 API 是一个 greet 占位实现; 换成自己的领域逻辑后, 同步本节与包内文档。 -->

本集合仓的可编程 API 包: 示例实现换成自己的领域逻辑即可; 命令行面在同级 CLI 包 ([{{SCOPE}}/{{NAME}}-cli](../{{NAME}}-cli/README.zh-CN.md))。

## 安装

```shell
bun add {{SCOPE}}/{{NAME}}
```

## 用法

```ts
import { greet } from '{{SCOPE}}/{{NAME}}';

console.log(greet({ who: 'world' })); // Hello, world!
```

## 开发

```shell
# 类型检查与测试 (在包目录内)
bun run typecheck && bun run test

# 打包发布产物 (dist/) 并跑发布自证闸门 (自证要求干净工作树)
bun run build && bun run verify:release
```

## 文档

- [包级文档入口](docs/README.md): 包内设计与包级 ADR 的登记入口。
