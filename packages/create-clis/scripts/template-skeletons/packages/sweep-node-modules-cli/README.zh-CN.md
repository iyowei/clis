# {{SCOPE}}/{{NAME}}-cli

<!-- 模板骨架: 示例命令是 {{BIN_NAME}} --name <名字>; 换成自己的命令后, 同步本节与包内文档。 -->

本集合仓的命令行工具: API 包 ([{{SCOPE}}/{{NAME}}](../{{NAME}}/README.zh-CN.md)) 的薄壳, 领域逻辑在 API 包里。

## 安装

```shell
npm install -g {{SCOPE}}/{{NAME}}-cli
```

## 用法

```shell
# 打印一句问候 (示例)
{{BIN_NAME}} --name world

# 查看命令帮助
{{BIN_NAME}} --help
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
