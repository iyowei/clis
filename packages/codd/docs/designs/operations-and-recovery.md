# MongoDB 通用日常运维、扩容与灾备手册

> **状态**: 已定稿 (Accepted)
> **日期**: 2026-11-18
> **决策者**: 沈委
> **父文档**: [生成器与科学公式详解](generator-and-formulas.md)

## 修订记录

| 日期       | 修订                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------- |
| 2026-11-18 | 初稿: 日常运维巡检、渐进增库、口令轮换、升配重算、容器内沙箱演练与安全恢复流程                |
| 2026-11-19 | 补记: 迁入 `clis` 集合仓, 统一命令为 `codd`                                                   |
| 2026-11-20 | 对齐 `make drill` Unix Domain Socket 沙箱、`make tools` / `make tools-rebuild` 与空库演练说明 |

> 适用于通过 `codd` ([`@iyowei/codd-cli`](../../../codd-cli/README.zh-CN.md) / [`@iyowei/codd`](../../README.zh-CN.md)) 基于 [`packages/codd/template/`](../../template) 渲染部署的所有单副本、跨机副本集与 Kubernetes 实例。文中 `<STACK_PREFIX>` 默认为 `mongo`。

## 一、[目标服务器] 常用命令速查

所有 `make` 命令均需 SSH 登录到**目标服务器**, 在带唯一指纹的部署目录 (`~/srv/stacks/mongo-<name>-<fp>/`) 内执行:

```shell
make help          # 查看全部命令列表
make tune-host     # 一键开启并持久化内核 THP / swappiness 调优 (Linux 宿主机或 macOS Podman VM)
make status        # 查看主容器健康状态与当前资源占用
make check-perf    # 巡检内核 THP / swappiness / ulimit 与 MongoDB startupWarnings
make logs          # 实时查看容器日志 (Ctrl+C 退出)
make stats         # 持续查看实时 CPU / 内存占用
make shell         # 以 root 身份进入 mongosh 交互终端
make init          # 幂等重跑副本集与全业务库账号初始化 (切主后亦可自动发现当前 PRIMARY)
make tools         # 按需构建 mongo-tools 工具镜像 (备份、恢复、演练依赖它, 已存在则跳过)
make tools-rebuild # 强制无缓存重建 mongo-tools 工具镜像 (升级 MongoDB 或 Bun 依赖后执行)
make down          # 停止并移除容器 (数据卷和密钥卷完全保留)
make up            # 启动或配置变更后重建容器 (自动核验并确保 0700 备份目录就绪)
```

`Makefile` 刻意不提供一键删卷目标, 避免误删数据。确需销毁整套数据与密钥卷时, 先 `make down`, 再手动执行 `podman volume rm <STACK_PREFIX>-<FINGERPRINT>-data <STACK_PREFIX>-<FINGERPRINT>-key`。

## 二、业务接入、新增业务库与密码轮换

| 参数               | 值                                              | 说明                                                                                                                |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 主机 / 端口        | `mongo` / `27117` (可改)                        | 单网络容器内使用服务名 `mongo:${MONGO_PORT}`; 宿主机访问使用 `127.0.0.1:${MONGO_HOST_PORT}`                         |
| 数据库             | 主库或 `MONGO_EXTRA_APPS` 中的 `<库名>`         | 按业务划分的独立数据库                                                                                              |
| `authSource`       | 与该业务库名一致                                | 每个业务账号仅创建在各自库名下, 漏传或写错会鉴权失败                                                                |
| `directConnection` | `true` (单机宿主机时); 3 节点高可用**禁止**附带 | 宿主机单机访问防重定向容器短名 `mongo`; 3 节点 HA 必须省略以便驱动自动切主                                          |
| `compressors`      | 可选 `zlib` (零依赖) 或 `zstd` (需装原生包)     | 服务端已启用 `net.compression.compressors: snappy,zstd,zlib`; 默认连接串不附带以兼容 Compass 与零依赖驱动, 按需追加 |

### 1. 同实例新增业务库或轮换密码

1. **[本地开发机] 新增业务库**: 在本地 `deploy.json` 的 `apps` 数组追加 `{ "db": "<新库>", "user": "<新账号>" }`, 执行 `codd deploy.json` (`.codd-state/` 会自动锁定原有 `FINGERPRINT`、交付目录名、原库密码、`root` 与 `keyFile`, 仅给新库生成随机密码)。
2. **[本地开发机] 轮换业务与备份密码**: 执行 `codd deploy.json --rotate` (`root` 与 `keyFile` 不变)。
3. **[本地开发机推送 -> 目标服务器生效]**: 在本地开发机将 `dist/` 更新后的节点目录 `rsync -av` 推送到服务器; 随后 SSH 登录**目标服务器**进入部署目录执行 `make check-env && make init` 即幂等生效。
4. **[目标服务器] 新库演练验收**: 空库虽可通过 `make backup` (仅拒 `0` 字节并做 `verifyGzip` 完整解压校验), 但 `make drill` 要求恢复后至少存在 1 个实体集合; 新库写入首批集合前若需全链路验收, 先向新库插入至少 1 条文档再跑 `make backup && make drill`。

### 2. 同机多实例零冲突并存与共网接入

生成器已将 `FINGERPRINT` 自动嵌入部署栈目录、服务器端 `BACKUP_DIR`、容器名、数据卷、密钥卷、网络与 `.plist`, 只需将第二个实例的 `port` (或 `hostPort`) 错开即可在同一台服务器无冲突运行。若单个业务容器需同时挂载多个不同实例的隔离网络, 在 `deploy.json` 设置 `"multiNetAlias": true` 重跑 `codd deploy.json`, 线上执行 `make init`, 并将连接串主机名改用 `<STACK_PREFIX>-<FINGERPRINT>:<MONGO_PORT>`。

## 三、监控信号与按公式重算升配

Compose 里的 `MEMORY_LIMIT`、`CPU_LIMIT` 都是上限而不是预分配。出现以下任一真实信号时, 提高本地 `deploy.json` 中 `hardware` 后重跑 `codd deploy.json`, 再 `rsync` 上机跑 `make up` 热重建即可 (数据卷原地保留):

| 信号              | 查看方式                                                                                   | 动作                                                     |
| ----------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| 容器被 OOM 杀     | `podman inspect <STACK_PREFIX>-<FINGERPRINT> --format '{{.State.OOMKilled}}'` 为 `true`    | 调高 `hardware.memoryGb` 并重算部署                      |
| 内核 THP 告警未消 | `make check-perf` 显示 `startupWarnings` 大于 `0`                                          | 执行 `make tune-host` 后 `podman restart` 主容器         |
| 缓存吃紧          | `make shell` 中查看 `db.serverStatus().wiredTiger.cache['bytes read into cache']` 持续增长 | 调高 `hardware.memoryGb` 让 `WT_CACHE_GB` 按公式同步上移 |
| 慢查询变多        | `make logs` 中超过 `100ms` 的慢操作日志持续出现                                            | 先排查缺失索引; 索引充足仍慢再升配 CPU / 内存            |
| 内存长期贴上限    | `make stats` 内存占用长期超过 `MEMORY_LIMIT` 的 `80%`                                      | 上调 `hardware.memoryGb` 后重跑 `make up`                |

### 升级版本与存储扩容

- **升级 MongoDB 版本**: 调整 `imageTag` 并 `rsync` 到目标机后执行 `make up && make tools-rebuild` (强制 `--no-cache` 无缓存重建工具镜像, 避免命中旧层缓存)。
- **macOS Podman 虚拟机扩盘** (只可调大不可缩小):

  ```shell
  podman machine stop && podman machine set --disk-size 64 && podman machine start
  podman machine ssh "df -h"
  ```

## 四、备份策略、零污染沙箱演练与真实恢复

- **从节点优先热备 (`make backup`)**: 使用仅有 `admin.backup` 只读权限的专用账号, 多节点副本集下自动路由至 `SECONDARY` 从节点读取 (`secondaryPreferred`), 并按核数动态设置 `--numParallelCollections`。
- **零污染隔离演练 (`make drill`)**: 在 `mongo-tools` 临时容器内创建 `0700` 私有目录, 通过 Unix Domain Socket (`--bind_ip <sockPath>`, 零 TCP 端口占用与暴露, `0.25GB` 缓存上限) 拉起独立沙箱 `mongod` 导入备份归档, 再通过只读 `backup` 账号对比线上各实体集合索引数量, 对线上生产库写入量为 0。
- **按库独立留存**: 每库每日保留 `KEEP_DAILY=7` 份; 周日额外抄写进 `BACKUP_DIR/weekly/` 每库保留 `KEEP_WEEKLY=4` 份。

```shell
make backup                          # 自动遍历主库 + MONGO_EXTRA_APPS 逐库备份
make drill                           # 在容器内独立沙箱演练全部已配置业务库最新归档
make drill FILE=mongo-orders-...gz   # 指定单个归档演练
```

### [目标服务器] 紧急真实恢复 (`make restore`)

> `restore` 使用 `--drop`, 会先删除对应业务库内同名集合再导入, 并根据文件名自动限定 `--nsInclude=<库名>.*`, 不波及同实例其它库。操作前务必先 `make drill FILE=<文件名>`; 周备份需先复制到 `BACKUP_DIR` 根目录。

```shell
set -a && . ./.env && set +a
ls -lh "$BACKUP_DIR"
make restore FILE=mongo-app-20261118_033000.archive.gz CONFIRM=yes
```

## 五、[目标服务器] 迁移旧实例数据卷到新指纹

更换 `FINGERPRINT` 时, 在**目标服务器**上必须将 `-data` 与 `-key` 两个命名卷成对迁移:

```shell
podman volume export <旧data卷名> | podman volume import <STACK_PREFIX>-<新FINGERPRINT>-data -
podman volume export <旧key卷名>  | podman volume import <STACK_PREFIX>-<新FINGERPRINT>-key -
make up
```
