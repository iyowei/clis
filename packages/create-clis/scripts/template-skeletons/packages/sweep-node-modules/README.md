# {{SCOPE}}/{{NAME}}

<!-- 模板骨架: 示例包的可编程 API 是一个 greet 占位实现; 换成自己的领域逻辑后, 同步本节与包内文档。 -->

The programmable API package of this collection: replace the example implementation with your own domain logic. The command-line surface lives in the sibling CLI package ([{{SCOPE}}/{{NAME}}-cli](../{{NAME}}-cli/README.md)).

## Install

```shell
bun add {{SCOPE}}/{{NAME}}
```

## Usage

```ts
import { greet } from '{{SCOPE}}/{{NAME}}';

console.log(greet({ who: 'world' })); // Hello, world!
```

## Development

```shell
# 类型检查与测试 (在包目录内)
bun run typecheck && bun run test

# 打包发布产物 (dist/) 并跑发布自证闸门 (自证要求干净工作树)
bun run build && bun run verify:release
```

## Documentation

- [Package docs](docs/README.md): the package-level entry (designs and ADRs).
