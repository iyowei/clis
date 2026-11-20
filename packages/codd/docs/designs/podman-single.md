# Podman 单副本节点装配手册

> **状态**: 已定稿 (Accepted)
> **日期**: 2026-11-18
> **决策者**: 沈委
> **父文档**: [生成器与科学公式详解](generator-and-formulas.md)

## 修订记录

| 日期       | 修订                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------- |
| 2026-11-18 | 初稿: 单副本 `rs0` + `27117` 跨平台装配流程、macOS Podman VM 内核持久化调优与远程直连方案 |
| 2026-11-19 | 补记: 迁入 `clis` 集合仓, 统一命令为 `codd`                                               |
| 2026-11-20 | 对齐空库备份校验 (`0` 字节拦截 + `verifyGzip`) 与 `make drill` 实体集合校验说明           |

> **双端操作分工**: **[本地开发机]** 只负责运行 `codd wizard` / `codd [deploy.json]` 生成带唯一指纹的 `dist/` 部署包并通过 `rsync` 推上服务器; **[目标服务器]** 免装 `codd`、免装 Bun 与 MongoDB, 只需接收该目录并运行 `make` 命令完成内核调优、容器启动与备份 (`make check-env` 会自动以 `0700` 权限创建带指纹的备份目录)。同机多业务请在清单 `apps` 列多个库 (见 [ADR 0017](../adrs/0017-single-replica-set-multi-db-isolation.md)); 跨 3 台物理机高可用见 [Podman 三物理节点高可用手册](podman-replica-set.md)。

## 一、[目标服务器] 核对环境与目标端口空闲

SSH 登录到**目标服务器**执行以下检查:

```shell
podman --version && podman-compose --version && make --version && openssl version && podman info >/dev/null
```

未自定义 `port` / `hostPort` 时默认监听 `27117`; 若自定义了端口, 请将下方命令中的 `PORT=27117` 改为你的实际端口号:

- **Linux** (MongoDB 9.0 采用 Google per-CPU TCMalloc, 开启 THP `always` + `defer+madvise` 可清零启动告警并降低内存页分配延迟):

  ```shell
  # Debian / Ubuntu:  sudo apt update && sudo apt install -y podman podman-compose make openssl
  # RHEL / Fedora:    sudo dnf install -y podman podman-compose make openssl
  PORT=27117  # 未自定义时默认为 27117; 若自定义了端口请改为实际端口号
  ss -lntp | grep ":${PORT}\b" || echo "${PORT} 空闲"
  ```

- **macOS** (Podman 在 macOS 上通过 `podman machine` 拉起轻量级 Linux 虚拟机承载容器, MongoDB 读取的内核参数来自该 Linux 虚拟机而非 macOS 自身):

  ```shell
  brew install podman podman-compose
  podman machine list                 # 需处于 running 状态; 首次运行 podman machine init && podman machine start
  PORT=27117                          # 未自定义时默认为 27117; 若自定义了端口请改为实际端口号
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN || echo "${PORT} 空闲"
  ```

  > 若通过 `ssh host "命令"` 远程免交互运维 macOS, 请确认 `export PATH="/opt/homebrew/bin:$PATH"` 已写入目标机 `~/.zshenv`。

## 二、[本地开发机] 生成带指纹的部署包并推送上机

在**本地开发机**任意工作目录终端执行:

```shell
# [本地开发机] 运行交互式向导 (推荐), 或准备 deploy-<环境>.json 后运行 codd deploy-<环境>.json
codd wizard

# [本地开发机] 在远程服务器准备父目录并上传安装包
ssh user@target-host 'mkdir -p ~/srv/stacks ~/srv/logs'
rsync -av dist/mongo-app-<fp>/ user@target-host:~/srv/stacks/mongo-app-<fp>/
```

## 三、[目标服务器] 内核调优、启动数据库与基线巡检

SSH 登录到**目标服务器**执行:

```shell
cd ~/srv/stacks/mongo-app-<fp>

# 一键开启 THP 与 vm.swappiness=1 并写入开机持久化 (Linux 调优宿主机内核; macOS 自动进入 Podman Linux VM 调优)
make tune-host
make check-env

make up          # 启动 mongo 并自动运行一次性 mongo-init (完成后以 exit=0 退出)
make status      # 主容器需处于 healthy (/dev/tcp 探针, 零 V8 内存尖峰)
make check-perf  # 核验 THP / ulimit / GLIBC_TUNABLES 及 startupWarnings 是否为 0
```

## 四、[目标服务器] 五步全链路验收 (主节点 + 备份 + 零污染演练)

继续在**目标服务器**部署目录内执行:

```shell
set -a && . ./.env && set +a
C="${STACK_PREFIX}-${FINGERPRINT}"
ROOT_AUTH="${MONGO_INITDB_ROOT_USERNAME}:${MONGO_INITDB_ROOT_PASSWORD}"
APP_AUTH="${MONGO_APP_USER}:${MONGO_APP_PASSWORD}"
HOST_QS="127.0.0.1:${MONGO_PORT:-27117}"

# 1) 确认副本集 PRIMARY 身份与版本
podman exec "$C" mongosh \
  "mongodb://${ROOT_AUTH}@${HOST_QS}/admin?authSource=admin&directConnection=true" \
  --quiet --eval 'printjson({primary: db.hello().isWritablePrimary, state: rs.status().members[0].stateStr, version: db.version()})'

# 2) 用业务账号写入 1 条临时探测文档 (make backup 仅拒 0 字节并做 verifyGzip 完整解压校验, 但空库在 make drill 会报无实体集合)
APP_URI="mongodb://${APP_AUTH}@${HOST_QS}/${MONGO_APP_DATABASE}?authSource=${MONGO_APP_DATABASE}&directConnection=true"
podman exec "$C" mongosh "$APP_URI" --quiet --eval '
  db.__deploy_smoke.insertOne({ok: true, at: new Date()});
  print("count:", db.__deploy_smoke.countDocuments({}));
'

# 3) 首次全库备份 + 4) 容器内独立沙箱恢复演练 (对线上库零写入、零 oplog 污染)
make backup && make drill

# 5) 清理探测集合
podman exec "$C" mongosh "$APP_URI" --quiet --eval 'db.__deploy_smoke.drop()'
```

## 五、业务接入与每日自动备份

### 1. 连接串 (完整凭据已存放在开发机 `.codd-state/single-<name>.credentials.txt`)

- **同桥接网络业务容器** (挂 external 网络 `${STACK_PREFIX}-${FINGERPRINT}-net`): `mongodb://<USER>:<PWD>@mongo:<PORT>/<DB>?authSource=<DB>`
- **宿主机本机进程** (`bindIp` 默认 `127.0.0.1`): `mongodb://<USER>:<PWD>@127.0.0.1:<HOST_PORT>/<DB>?authSource=<DB>&directConnection=true`
- **异地通过 WireGuard / 组网远程连接 (免手敲终端隧道的两种方式)**:
  1. **只用 MongoDB Compass 看库** (保持 `bindIp="127.0.0.1"`): 在 Compass 展开 `Advanced Connection Options -> Proxy/SSH -> SSH with Identity File`, 填服务器内网/WireGuard IP、登录用户名与本机私钥并存书签, 主连接仍填 `127.0.0.1:<HOST_PORT>`, 无需在终端挂 `ssh -L` 进程。
  2. **本地写代码跑服务 + Compass 都要免隧道直连** (仅限家庭路由器 NAT 后内网主机或已配云安全组白名单的主机): 将清单中 `nodes[0].bindIp` 设为 `"0.0.0.0"` 重新生成并 `make up`, 即可在家用局域网 IP、在外用 WireGuard IP、在服务器本机用 `127.0.0.1` 三路直连。

### 2. [目标服务器] 每日 `03:30` 自动备份

- **Linux (`crontab -e`)**:

  ```cron
  30 3 * * * cd "$HOME/srv/stacks/mongo-app-<fp>" && make backup >> "$HOME/srv/logs/mongo-backup-<fp>.log" 2>&1
  ```

- **macOS (`LaunchAgent`, 直接加载随包产出的唯一指纹 `.plist`)**:

  ```shell
  set -a && . ./.env && set +a
  PLIST="com.codd.mongo-backup-${FINGERPRINT}.plist"
  mkdir -p "$HOME/srv/logs" "$HOME/Library/LaunchAgents"
  cp "$PLIST" "$HOME/Library/LaunchAgents/"
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$PLIST"
  ```

> 日常增库、轮换口令 (`--rotate`)、硬件升配重算与恢复演练见 [通用日常运维与灾备手册](operations-and-recovery.md)。
