# {{SCOPE}}/{{NAME}}-cli

<!-- 模板骨架: 示例命令是 {{BIN_NAME}} --name <名字>; 换成自己的命令后, 同步本节与包内文档。 -->

The command-line tool of this collection: a thin shell over the API package ([{{SCOPE}}/{{NAME}}]({{REPO_URL}}/blob/main/packages/{{NAME}}/README.md)), where the domain logic lives.

## Install

```shell
npm install -g {{SCOPE}}/{{NAME}}-cli
```

## Usage

```shell
# Print a greeting (example)
{{BIN_NAME}} --name world

# Print CLI version (also -V)
{{BIN_NAME}} --version

# Show CLI help (also -h)
{{BIN_NAME}} --help
```

## Development

```shell
# Typecheck and test (inside the package directory)
bun run typecheck && bun run test

# Bundle release artifacts (dist/) and run the pre-release gate (requires a clean git tree)
bun run build && bun run verify:release
```

## Documentation

- [Repository docs]({{REPO_URL}}/blob/main/docs/README.md): repository-level governance, designs, and development guide; create `docs/` inside this package on demand once package-specific CLI surface designs exist.
