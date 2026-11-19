# 生成器、输入清单与科学计算公式详解

> **状态**: 已定稿 (Accepted)
> **日期**: 2026-11-18
> **决策者**: 沈委
> **标签**: [架构, 公式引擎]
> **影响范围**: [packages/codd/, docs/codd/]

## 修订记录

| 日期       | 修订                                                               |
| ---------- | ------------------------------------------------------------------ |
| 2026-11-18 | 初稿: 沉淀硬件推导公式、`deploy.json` 字段契约与 12 位指纹隔离规范 |
| 2026-11-19 | 补记: 迁入 `clis` 集合仓, 统一为独立 `codd` CLI 与工作目录解耦模型 |

## 一、设计准则

[`packages/codd/template/`](../../../packages/codd/template) 维护唯一参数化模板源, 构建期封装进 `packages/codd/assets/template/`; 用户工作目录 `dist/` 只输出目标环境运行所需的部署文件 (不带入文档、测试或无用平台文件), 且全部宿主级目录、备份路径、容器、卷、网络与定时任务均自动嵌入 12 位唯一指纹码, 保证同机多实例 100% 零命名冲突。每次生成均经严格渲染器检验全部 `{{TOKEN}}`, 确保零遗漏替换。详见 [ADR 0014](../../../packages/codd/docs/adrs/0014-fingerprint-resource-isolation.md) 与 [ADR 0018](../../../packages/codd/docs/adrs/0018-profile-engine-separation-and-bundle-generator.md)。

## 二、科学资源与高性能计算公式

用户输入硬件配额 `hardware: { cpuCores, memoryGb, diskGb, workload, expectedAppConnections }` 后, [formulas.ts](../../../packages/codd/src/formulas.ts) 按如下确定性公式自动计算全套容器、Kubernetes 与 MongoDB 9.0 参数:

| 参数                           | 计算公式与工程依据                                                                                                                                                                                                                                                                                         | 典型示例 (`2C/2G/32G` -> `4C/8G/100G` -> `8C/16G/250G`)      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `WT_CACHE_GB`                  | `<=8G`: `max(0.25, floorQuarter(0.5 x (memoryGb - 1)))`; `>8G`: `floorQuarter(0.55 x (memoryGb - 1))` (小机留足连接与排序余量, 大机多释放 5% 物理内存提升热缓存命中)                                                                                                                                       | `0.5 GB` -> `3.5 GB` -> `8.25 GB`                            |
| `MEMORY_RESERVATION`           | `memoryGb <= 2 ? min(memoryGb, 1) : max(1, floorQuarter(0.5 x memoryGb))` (Podman 软保护线)                                                                                                                                                                                                                | `1g` -> `4g` -> `8g`                                         |
| `K8s requests / limits`        | CPU: `<= 2 ? cpuCores : 0.5 x cpuCores`; RAM: `requests.memory == limits.memory == memoryGb` (防止节点内存吃紧时 Kubelet OOM Killer 优先驱逐有状态数据库 Pod)                                                                                                                                              | `2C/2Gi` -> `2C/8Gi` -> `4C/16Gi`                            |
| `maxIncomingConnections`       | `clamp(floor50((memoryGb - wtCacheGb) x 80), 100, 5000)` (非缓存内存按 25% 预算约 3.2MB/连接承载安全上限; 传 `expectedAppConnections` 时自动上浮 1.25x 并在超载时告警)                                                                                                                                     | `100` -> `350` -> `600`                                      |
| `oplogSizeMB`                  | `clamp(round10(diskGb x 1024 x ratio), 990, 51200)` (`balanced`: `3%`, `write-heavy`: `8%`, `read-heavy`: `2%`; 保底 WiredTiger 官方最小下限 `990MB`, 封顶 `50GB`)                                                                                                                                         | `990 MB` -> `3070 MB` -> `7680 MB`                           |
| `压缩与协议加速`               | 集合块压缩 `cpuCores >= 2 ? zstd : snappy`; 固定开启 `journalCompressor: snappy`、索引前缀压缩 `prefixCompression: true`、网络与复制协议压缩 `snappy,zstd`                                                                                                                                                 | `zstd + snappy,zstd`                                         |
| `ulimit / 停机窗口 / 备份并发` | `nofile = nproc = clamp(maxConns x 4, 65536, 262144)` (MongoDB 官方要求生产 `nofile` 与 `nproc >= 64000` 方可免除启动告警, 故取 `2^16 = 65536` 保底, 超大并发时按 `连接数 x 4` 动态放大); 优雅停机 `clamp(memoryGb x 8, 30, 300)s` (防大缓存刷盘被强杀); 备份并发集合数 `clamp(floor(cpuCores / 2), 1, 8)` | `65536 / 30s / 1` -> `65536 / 64s / 2` -> `65536 / 128s / 4` |

> 资源配额、缓存、连接上限、`oplogSizeMB` 与块压缩均由 `hardware` 公式严格锁定, 禁止在清单中手写 `overrides` 覆盖; 只需调高 `hardware` 并重跑 `codd` 即可联动升配。

## 三、用户输入清单 (`deploy.json`) 与 CLI 用法

包内内置 2C2G 起步预设 [deploy-2c2g.json](../../../packages/codd/template/schema/deploy-2c2g.json) 与完整字段校验规范 [deploy.schema.json](../../../packages/codd/template/schema/deploy.schema.json) (可通过 `codd --init-schema` 一键导出到任意工作目录)。以下命令均在 **[本地开发机]** 任意目录执行:

```shell
codd wizard                           # 交互式配置向导 (支持保存为 deploy-<name>.json)
codd                                  # 默认读取 ./deploy.json 生成部署包进 ./dist
codd deploy-prod.json                 # 直接传入任意 JSON 清单生成 (支持同目录并存多份配置)
codd deploy.ha.json --dry-run         # 仅核验指定清单与公式推导结果, 不写文件
codd deploy-prod.json --rotate        # 安全轮换业务/备份密码 (FINGERPRINT、root 与 keyFile 保持不变)
codd --rotate-all                     # 轮换全部秘密含 root 与 keyFile (仅用于全新实例)
codd --new-fingerprint                # 重生成 FINGERPRINT (创建全新独立目录、卷与网络命名)
codd --init-schema                    # 导出 deploy.schema.json 与 deploy-2c2g.json 到当前目录
```

### 清单全量支持字段

> `fingerprint` 与资源配额全权由生成器自动计算并锁存进 `.codd-state/`, 清单禁止手写 `fingerprint` 或 `overrides`, 发现即报错拒收。

| 字段                       | 必填          | 默认行为                                                                                                              | 说明                                                                                                                                                                                 |
| -------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `$schema`                  | 否            | 留空不影响运行 (同目录有 schema 时推荐填 `"./deploy.schema.json"`)                                                    | 绑定编辑器 JSON Schema 智能提示与强类型校验                                                                                                                                          |
| `mode`                     | 是            | 无                                                                                                                    | `single` \| `replica-set` \| `k8s-single` \| `k8s-rs`                                                                                                                                |
| `name`                     | 是            | 无                                                                                                                    | 实例逻辑名 (`^[a-z0-9-]+$`, <= 32 字符), 与 `fingerprint` 共同组成无冲突目录名                                                                                                       |
| `stackPrefix`              | 否            | `"mongo"`                                                                                                             | 容器、网络、卷与目录命名前缀 (`<stackPrefix>-<name>-<fingerprint>`)                                                                                                                  |
| `hardware`                 | 否            | `2C / 2G / 32G / balanced` (并输出提示警告)                                                                           | `{ cpuCores, memoryGb, diskGb, workload?, expectedAppConnections? }`                                                                                                                 |
| `port` / `hostPort`        | 否            | `port=27117`; `hostPort` 等于 `port`                                                                                  | 端口 `1024-65535`; `hostPort` 供同机多实例错开; `replica-set` 或 `networkMode=host` 要求 `hostPort == port`                                                                          |
| `networkMode`              | 否            | `"bridge"`                                                                                                            | 仅 Linux Podman 有效: `"bridge"` (隔离桥接网) 或 `"host"` (裸金属零 NAT 网络栈; macOS 节点禁用)                                                                                      |
| `imageName` / `imageTag`   | 否            | `"mongo"` / `"9.0.8"`                                                                                                 | MongoDB 镜像名与统一版本标签 (`mongo`、`mongo-init`、`mongo-tools` 共用)                                                                                                             |
| `bunImage` / `tz`          | 否            | `"oven/bun:1-slim"` / `"Asia/Shanghai"`                                                                               | `mongo-tools` 所嵌 Bun 源镜像与容器时区                                                                                                                                              |
| `rsName`                   | 否            | `"rs0"`                                                                                                               | MongoDB 副本集名称                                                                                                                                                                   |
| `multiNetAlias`            | 否            | `false` (默认宣告 `mongo:<port>`)                                                                                     | 仅 `single` + `bridge`: 业务容器跨多隔离网时设为 `true`, 成员改用 `<stackPrefix>-<fingerprint>:<port>`                                                                               |
| `keepDaily` / `keepWeekly` | 否            | `7` / `4`                                                                                                             | 各业务库独立的每日备份保留份数与周日长期归档保留份数                                                                                                                                 |
| `apps`                     | 是            | 无 (至少 1 项)                                                                                                        | `[{ db, user, password? }]`; 第 1 项主库, 余项进 `extraApps`; 省去 `password` 则首次随机 24 位并锁存                                                                                 |
| `auth`                     | 否            | `"root"` / `"backup"` + 自动随机并锁存                                                                                | `{ rootUsername?, rootPassword?, backupUsername?, backupPassword?, keyFile?, existingSecret? }`                                                                                      |
| `nodes`                    | Podman 必填   | K8s 忽略; Podman 必须填                                                                                               | `single` 1 项 / `replica-set` 3 项: `os` 与 `backupDir` 必填 (`backupDir` 为服务器端备份路径, 自动幂等附带 `<fingerprint>` 子目录防冲突, 服务器 `make check-env` 自动以 `0700` 创建) |
| `k8s`                      | 否 (K8s 生效) | `namespace="data"`, `releaseName="<prefix>-<name>-<fp>"`, `ClusterIP`, 默认 StorageClass, `k8s-rs` 默认 `hard` 反亲和 | `{ namespace?, releaseName?, storageClass?, serviceType?, nodePort?, podAntiAffinity?, existingSecret? }`                                                                            |

## 四、零命名冲突保证与 `dist/` 生成物

- **全链路指纹隔离**: 无论用户输入备份根目录 (如 `/Users/ops/srv/backups`) 还是带实例名的路径 (如 `/Users/ops/srv/backups/mongo-hola`), 生成器均幂等归一为 `/Users/ops/srv/backups/mongo-hola-<fingerprint>` (3 节点模式还会附加 `-node1..3`)。连同 `dist/mongo-hola-<fingerprint>/`、服务器栈目录 `~/srv/stacks/mongo-hola-<fingerprint>/`、容器名、数据/密钥命名卷、桥接网络、macOS `.plist` 与日志路径, 同一台主机并行部署多个同名逻辑实例也 100% 互不覆盖。
- **Podman 单副本 (`mode: "single"`)**: `dist/<stackPrefix>-<name>-<fingerprint>/` 内含 `.env` (`0600`)、`podman-compose.yml`、`mongod.conf`、`Makefile`、`tune-linux-host.sh` (`0755`)、`Dockerfile`、`.dockerignore`、`init.js`、`package.json`、`bun.lock`、`bunfig.toml`、4 个 `.ts` 运行时脚本, 以及 macOS 节点的 `com.codd.mongo-backup-<fingerprint>.plist`。
- **Podman 3 物理节点 (`mode: "replica-set"`)**: `dist/` 下生成 **3 个各自独立的节点目录** (`...-node1/`、`...-node2/`、`...-node3/`), 共享指纹、`MONGO_KEYFILE`、三服务全覆盖的 `RS_PEER_1/2` 与完全对等的硬件配额。
- **Kubernetes (`k8s-single` / `k8s-rs`)**: `dist/<release>-k8s/` 内含自包含的 `chart/` 目录、`values.generated.yaml` (零密码明文, `extra-apps` 全部收纳进 K8s `Secret`)、`create-secret.sh` (`0700`) 与可跨机独立执行的 `deploy.sh` (`0700`)。
- **状态锁与凭据 (`.codd-state/`)**: 首次随机生成的 `FINGERPRINT`、密码与 `keyFile` 写入本地 `.codd-state/<mode>-<name>.state.json` (`0600`), 重跑稳定复用; 完整连接串写在 `.codd-state/<mode>-<name>.credentials.txt` (`0600`, 自动内建 `.gitignore` 保护, 永不传上服务器)。
