# {{SCOPE}}/{{NAME}}

<!-- 模板骨架: 示例包的可编程 API 是一个 greet 占位实现; 换成自己的领域逻辑后, 同步本节与包内文档。 -->

The programmable API package of this collection: replace the example implementation with your own domain logic. The command-line surface lives in the sibling CLI package ([{{SCOPE}}/{{NAME}}-cli]({{REPO_URL}}/blob/main/packages/{{NAME}}-cli/README.md)).

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
# Typecheck and test (inside the package directory)
bun run typecheck && bun run test

# Bundle release artifacts (dist/) and run the pre-release gate (requires a clean git tree)
bun run build && bun run verify:release
```

## Documentation

- [Repository docs]({{REPO_URL}}/blob/main/docs/README.md): repository-level governance, designs, and development guide; create `docs/` inside this package on demand once package-specific designs or ADRs exist.
