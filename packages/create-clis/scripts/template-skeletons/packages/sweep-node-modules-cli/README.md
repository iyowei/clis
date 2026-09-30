# {{SCOPE}}/{{NAME}}-cli

<!-- 模板骨架: 示例命令是 {{BIN_NAME}} --name <名字>; 换成自己的命令后, 同步本节与包内文档。 -->

The command-line tool of this collection: a thin shell over the API package ([{{SCOPE}}/{{NAME}}](../{{NAME}}/README.md)), where the domain logic lives.

## Install

```shell
npm install -g {{SCOPE}}/{{NAME}}-cli
```

## Usage

```shell
# 打印一句问候 (示例)
{{BIN_NAME}} --name world

# 查看命令帮助
{{BIN_NAME}} --help
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
