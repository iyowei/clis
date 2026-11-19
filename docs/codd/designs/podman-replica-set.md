# Podman 三物理节点高可用副本集部署手册

> **状态**: 已定稿 (Accepted)
> **日期**: 2026-11-18
> **决策者**: 沈委
> **父文档**: [生成器与科学公式详解](generator-and-formulas.md)

## 修订记录

| 日期       | 修订                                                            |
| ---------- | --------------------------------------------------------------- |
| 2026-11-18 | 初稿: 3 物理节点 PSS 高可用编排、对称节点包导出与从节点热备机制 |
| 2026-11-19 | 补记: 迁入 `clis` 集合仓, 统一命令为 `codd`                     |

> **多节点生成器保障**: 3 台独立服务器共用同一套 [`packages/codd/template/podman/`](../../../packages/codd/template/podman) 编排源码。在开发机用 `mode: "replica-set"` 运行 `codd` 后, `dist/` 下直接生成 3 个带唯一指纹的独立目录 (`...-node1/`、`...-node2/`、`...-node3/`), 自动共享 `FINGERPRINT`、`756B` `MONGO_KEYFILE`、对称 `RS_PEER_1/2` 与全量 `RS_MEMBERS`。若只有 1 台服务器, 请改用 [Podman 单副本装配手册](podman-single.md) 通过 `apps[]` 多库隔离 (见 [ADR 0017](../../../packages/codd/docs/adrs/0017-single-replica-set-multi-db-isolation.md))。

## 一、[3 台目标服务器] 前置网络与防火墙要求

- 三机通过内网或 WireGuard / Tailscale 互联 (示例 `10.8.0.11`、`10.8.0.12`、`10.8.0.13`)。Linux 纯裸金属追求极致零 NAT 延迟时可在清单增配 `"networkMode": "host"`。
- 禁止向公网放开数据库端口 (默认 `27117`, 自定义 `port` 时替换为实际端口号); 防火墙仅向三节点私网 IP 与内网业务网段放行该 TCP 端口:
  - **Linux**: `ufw allow from 10.8.0.0/24 to any port 27117 proto tcp` 或 `firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="10.8.0.0/24" port protocol="tcp" port="27117" accept'`
  - **macOS**: 在系统设置防火墙放行 Podman `gvproxy` / `podman` 入站流量; 非交互 SSH 需将 `/opt/homebrew/bin` 写入 `~/.zshenv`。

## 二、[本地开发机] 生成 3 个节点目录并分别推送

在**本地开发机**准备 `deploy.ha.json`:

```json
{
  "mode": "replica-set",
  "name": "ha",
  "hardware": {
    "cpuCores": 4,
    "memoryGb": 8,
    "diskGb": 100,
    "workload": "balanced"
  },
  "port": 27117,
  "apps": [
    { "db": "app", "user": "app" },
    { "db": "billing", "user": "billu" }
  ],
  "nodes": [
    {
      "name": "node1",
      "os": "linux",
      "bindIp": "10.8.0.11",
      "sshTarget": "ops@10.8.0.11",
      "backupDir": "/home/ops/srv/backups"
    },
    {
      "name": "node2",
      "os": "linux",
      "bindIp": "10.8.0.12",
      "sshTarget": "ops@10.8.0.12",
      "backupDir": "/home/ops/srv/backups"
    },
    {
      "name": "node3",
      "os": "macos",
      "bindIp": "10.8.0.13",
      "sshTarget": "ops@10.8.0.13",
      "backupDir": "/Users/ops/srv/backups"
    }
  ]
}
```

生成并推送至 3 台目标服务器:

```shell
codd deploy.ha.json

rsync -av dist/mongo-ha-<fp>-node1/ ops@10.8.0.11:~/srv/stacks/mongo-ha-<fp>-node1/
rsync -av dist/mongo-ha-<fp>-node2/ ops@10.8.0.12:~/srv/stacks/mongo-ha-<fp>-node2/
rsync -av dist/mongo-ha-<fp>-node3/ ops@10.8.0.13:~/srv/stacks/mongo-ha-<fp>-node3/
```

## 三、[从服务器 `node2` 与 `node3`] 先启动 2 台从节点

分别 SSH 登录到 **从服务器 `node2`** 与 **从服务器 `node3`**, 在空白数据盘下启动, 自动写入共享 `keyfile` 并静候主节点下发同步:

```shell
cd ~/srv/stacks/mongo-ha-<fp>-node2   # 在 node3 上进入 mongo-ha-<fp>-node3
make tune-host && make check-env && make up && make status
```

## 四、[主服务器 `node1`] 启动主引导节点与集群验收

SSH 登录到 **主服务器 `node1`** 执行:

```shell
cd ~/srv/stacks/mongo-ha-<fp>-node1
make tune-host && make check-env && make up && make logs
```

`node1` 的 `mongo-init` 会等从机就绪后自动发起 3 成员 `rs.initiate` (`node1` 优先级 `2`, `node2` 与 `node3` 优先级 `1`), 并一次完成全部业务隔离库与 `backup` 账号建权。随后校验成员状态与复制延迟:

```shell
cd ~/srv/stacks/mongo-ha-<fp>-node1 && set -a && . ./.env && set +a
C="${STACK_PREFIX}-${FINGERPRINT}"
URI="mongodb://${MONGO_INITDB_ROOT_USERNAME}:${MONGO_INITDB_ROOT_PASSWORD}@127.0.0.1:${MONGO_PORT:-27117}/admin?authSource=admin&directConnection=true"

podman exec "$C" mongosh "$URI" --quiet --eval '
  printjson(rs.status().members.map((m) => ({name: m.name, state: m.stateStr, health: m.health})));
  rs.printSecondaryReplicationInfo();
'
```

- **业务高可用连接串** (写全 3 节点且**禁止**附带 `directConnection=true`):

  ```text
  mongodb://<USER>:<PWD>@node1:27117,node2:27117,node3:27117/<DB>?replicaSet=rs0&authSource=<DB>&compressors=zstd
  ```

- **从节点热备与礼貌切主**: `make backup` 自动优先从 `SECONDARY` 节点读取数据; 不停服重启时先逐台重启从机, 轮到主机前执行 `podman exec "$C" mongosh "$URI" --quiet --eval 'rs.stepDown(60)'` 让主后再维护。
