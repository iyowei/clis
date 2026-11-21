# Kubernetes 三副本高可用部署手册

> **状态**: 已定稿 (Accepted)
> **日期**: 2026-11-18
> **决策者**: 沈委
> **父文档**: [生成器与科学公式详解](generator-and-formulas.md)

## 修订记录

| 日期       | 修订                                                                    |
| ---------- | ----------------------------------------------------------------------- |
| 2026-11-18 | 初稿: K8s 3 副本硬反亲和 StatefulSet、Headless DNS 与全凭据 Secret 隔离 |
| 2026-11-19 | 补记: 迁入 `clis` 集合仓, 统一命令为 `codd`                             |

> 轻量单副本测试见 [Kubernetes 单副本部署手册](kubernetes-single.md); 纯主机 3 物理节点部署见 [Podman 三物理节点高可用手册](podman-replica-set.md) 与 [可视化看板](../BOARD.html)。

## 一、三副本稳定与高性能机制

1. **仅 `-0` 号 Pod 运行 `bootstrap-root` + 智能跳过重复 `chown`**: [statefulset.yaml](../../template/helm/templates/statefulset.yaml) 自动匹配 `*-0` 且仅在 `/data/db/WiredTiger.wt` 为空时预建 `root`; `-1` 与 `-2` 保持空白数据盘借助共享 `keyfile` 完成 Initial Sync; `fix-keyfile-permissions` 仅在目录属主非 `999:999` 时执行修正, 避免重启时递归遍历海量 `.wt` 数据文件。
2. **零开销内核级 TCP 三层探针 + 等额内存防驱逐**: 配备 `startupProbe`、`livenessProbe` 与 `readinessProbe` (`tcpSocket`), 容器内零进程 fork 与零内存尖峰; `requests.memory == limits.memory` 防止节点内存压力下被高优先级驱逐。注意 `tcpSocket` 无法感知副本集 `STARTUP2` 初始同步阶段, 业务连接串必须写全 3 节点 Headless FQDN + `replicaSet=` 走拓扑发现, 不要用单 Service 做从节点只读负载均衡; 生产节点宿主机同样建议按 MongoDB 8.0/9.0 开启 THP 与 `nofile >= 64000`。
3. **双 Service + Headless DNS + 全凭据 Secret 隔离**: [service.yaml](../../template/helm/templates/service.yaml) 创建 `<release>-headless` (`publishNotReadyAddresses: true`); 主业务库与全部 `extraApps` 口令统一收敛进 Kubernetes `Secret` (`extra-apps` 键), `values.generated.yaml` 零明文泄露。

## 二、用生成器产出可移植部署包 (推荐)

```json
{
  "mode": "k8s-rs",
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
  "k8s": { "namespace": "data", "podAntiAffinity": "hard" }
}
```

```shell
# [本地开发机] 1) 生成内嵌 chart/ 的可移植部署包
codd deploy.json

# [K8s 管控机] 2) 直接执行或整包复制到管控跳板机运行
bash dist/mongo-ha-<fp>-k8s/deploy.sh
```

## 三、[K8s 管控机] 手工直调 Helm Chart

```shell
kubectl get nodes -o wide && kubectl get storageclass
NS=data
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -
ROOT_PWD="$(openssl rand -hex 12)"
APP_PWD="$(openssl rand -hex 12)"
BAK_PWD="$(openssl rand -hex 12)"
KEY_B64="$(openssl rand -base64 756 | tr -d '\n')"

kubectl -n "$NS" create secret generic mongo-ha-auth \
  --from-literal=root-password="$ROOT_PWD" \
  --from-literal=app-password="$APP_PWD" \
  --from-literal=backup-password="$BAK_PWD" \
  --from-literal=extra-apps="" \
  --from-literal=mongodb-keyfile="$KEY_B64" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install mongo-ha ./chart \
  --namespace data \
  --set replicaCount=3 \
  --set auth.existingSecret=mongo-ha-auth \
  --set config.net.port=27117 \
  --set service.port=27117 \
  --set podAntiAffinityPreset.type=hard \
  --set resources.limits.cpu=4 \
  --set resources.limits.memory=4Gi \
  --set resources.requests.memory=4Gi \
  --set config.storage.wiredTiger.engineConfig.cacheSizeGB=1.5
```

## 四、[K8s 管控机] 验收、自动切主连接串与无感维护

```shell
REL=mongo-ha   # 若由生成器默认生成则为 mongo-ha-<fp>
kubectl -n data get pods,pvc,jobs -l app.kubernetes.io/instance="$REL" -o wide
kubectl -n data logs -l app.kubernetes.io/instance="$REL",app.kubernetes.io/component=init --tail=50

ROOT_PWD="$(kubectl -n data get secret "${REL}-auth" -o jsonpath='{.data.root-password}' | base64 -d)"
kubectl -n data exec "${REL}-0" -c mongo -- mongosh \
  "mongodb://root:${ROOT_PWD}@127.0.0.1:27117/admin?authSource=admin&directConnection=true" \
  --quiet --eval 'printjson(rs.status().members.map((m) => ({name: m.name, state: m.stateStr, health: m.health}))); rs.printSecondaryReplicationInfo();'
```

- **集群内高可用连接串** (**禁止**附带 `directConnection=true`, 写全 3 节点 Headless FQDN):

  ```text
  mongodb://<USER>:<PWD>@<REL>-0.<REL>-headless.data.svc.cluster.local:27117,<REL>-1.<REL>-headless.data.svc.cluster.local:27117,<REL>-2.<REL>-headless.data.svc.cluster.local:27117/<DB>?replicaSet=rs0&authSource=<DB>
  ```

- **礼貌切主与三 PVC 等大扩盘**:

  ```shell
  REL=mongo-ha
  ROOT_PWD="$(kubectl -n data get secret "${REL}-auth" -o jsonpath='{.data.root-password}' | base64 -d)"
  kubectl -n data exec "${REL}-0" -c mongo -- mongosh \
    "mongodb://root:${ROOT_PWD}@127.0.0.1:27117/admin?authSource=admin&directConnection=true" \
    --quiet --eval 'rs.stepDown(60)'

  for i in 0 1 2; do
    kubectl -n data patch pvc "data-${REL}-${i}" -p '{"spec":{"resources":{"requests":{"storage":"64Gi"}}}}'
  done
  ```
