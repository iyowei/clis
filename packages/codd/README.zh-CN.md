# codd

[![CI](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/ci.yml)

[English](README.md) | **中文**

模板化 MongoDB 9.0 高性能部署装配 CLI (`@iyowei/codd`), 面向 Podman (Linux / macOS) 与 Kubernetes (Helm): 根据服务器 CPU、内存、硬盘与读写特征确定性推导缓存、连接数、oplog、全链路压缩与系统句柄上限, 一键导出干净、自包含且 100% 零命名冲突的上线部署包。

## 要求

- **双运行时**: 有 bun 走 bun, 没有就用 node (`>= 22.18.0`, 下限见本包 `engines` 声明)。
- 零第三方运行时依赖 (只用运行时内置能力)。
- 兼容 `npm`、`bun`、`pnpm`、`yarn` 安装与运行, 支持 macOS、Linux 与 Windows。

## 安装

### ① 免安装 (试用或偶尔用)

```shell
# 机器上有 bun
bunx @iyowei/codd wizard

# 机器上有 node
npx @iyowei/codd wizard
```

### ② 包管理器全局安装 (常用推荐)

```shell
npm install -g @iyowei/codd
bun add -g @iyowei/codd
pnpm add -g @iyowei/codd
yarn global add @iyowei/codd
```

### ③ 从源码 (本机开发调用)

```shell
cd "<克隆位置>/clis"
bun install && bun run build
chmod +x packages/codd/bin/codd
ln -sf "$PWD/packages/codd/bin/codd" ~/.local/bin/codd
```

## 使用

```shell
# 打开 4 步交互式配置向导 (新手推荐)
codd wizard

# 按默认 ./deploy.json 或任意指定 JSON 清单生成部署包 (支持同目录并存多套环境配置)
codd
codd deploy-prod.json

# 仅校验配置并预览公式推导结果, 不写入任何文件
codd deploy-prod.json --dry-run

# 仅轮换业务库与备份账号密码 (FINGERPRINT、root 与 keyFile 保持不变)
codd deploy-prod.json --rotate

# 在当前目录导出 deploy.schema.json 与 2C2G 参考清单
codd --init-schema
```

## 选项

| 命令 / 旗标                      | 说明                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `codd wizard` / `-i`, `--wizard` | 打开交互式向导, 一步步引导生成配置清单与部署安装包                                                  |
| `codd [配置文件.json]`           | 按指定 JSON 清单生成部署包 (不传默认读取 `./deploy.json`)                                           |
| `-c`, `--config <文件路径>`      | 显式指定 JSON 配置文件路径 (与位置参数等效)                                                         |
| `-o`, `--out <输出目录>`         | 指定部署安装包的导出目录 (默认 `./dist`)                                                            |
| `--rotate`                       | 仅轮换业务库与备份账号密码 (`FINGERPRINT`、`root` 与 `keyFile` 保持不变, 线上执行 `make init` 生效) |
| `--rotate-all`                   | 轮换包含 `root` 与 `keyFile` 在内的全部密钥 (仅限全新部署前使用)                                    |
| `--new-fingerprint`              | 生成全新的 12 位实例唯一指纹 (同台服务器并行部署新实例时使用)                                       |
| `--dry-run`                      | 仅校验配置并预览公式推导结果, 不写入任何文件                                                        |
| `--init-schema`                  | 将 `deploy.schema.json` 与 `deploy-2c2g.json` 参考模板导出到当前目录                                |
| `-v`, `--version`                | 打印当前版本号 (`1.0.0`)                                                                            |
| `-h`, `--help`                   | 打印帮助说明                                                                                        |

## 生成物

- **`./dist/<前缀>-<实例名>-<指纹>/`**: 剔除一切文档与测试的纯净运行包, 可直接 `rsync` 推至目标 Linux/macOS 服务器执行 `make tune-host && make up`, 或在 K8s 管控机执行内嵌 `chart/` 的 `deploy.sh`。
- **`./.codd-state/`**: 权限 `0700` 的本机状态锁目录 (自动内建 `.gitignore` 防误提交入库), 持久化锁定唯一指纹、高强度口令与开箱即用的数据库连接串 (`*.credentials.txt`)。

## 开发

环境准备、常用命令、双运行时验证与提交钩子, 见 [开发指南](../../docs/development.md)。

## 文档

- [工程技术文档总索引](../../docs/README.md)
- [codd 产品文档入口](../../docs/codd/README.md)
- [包级文档入口](docs/README.md)
