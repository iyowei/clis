# Kubernetes 单副本节点部署手册

> **状态**: 已定稿 (Accepted)
> **日期**: 2026-11-18
> **决策者**: 沈委
> **父文档**: [生成器与科学公式详解](generator-and-formulas.md)

## 修订记录

| 日期       | 修订                                                          |
| ---------- | ------------------------------------------------------------- |
| 2026-11-18 | 初稿: K8s 单副本 StatefulSet + 内嵌自包含 Helm Chart 交付规范 |
| 2026-11-19 | 补记: 迁入 `clis` 集合仓, 统一命令为 `codd`                   |

> 需抵御节点故障与零停机切换请改用 [Kubernetes 三副本高可用手册](kubernetes-replica-set.md) (`replicaCount=3`, 1 主 2 从 `PSS`); 纯主机容器部署见 [Podman 单副本装配手册](podman-single.md)。

## 一、用生成器产出可移植 K8s 部署包 (推荐)

通用 Helm Chart 位于 [`packages/codd/template/helm/`](../../template/helm)。在 `deploy.json` 配置 `mode: "k8s-single"` 与目标 `hardware`, 生成器自动将等额内存 `requests/limits`、`cacheSizeGB`、`maxIncomingConnections`、`oplogSizeMB` 与优雅停机窗口写入 `dist/<release>-k8s/values.generated.yaml` (零密码明文), 并将完整 `chart/` 子目录、`create-secret.sh` 与 `deploy.sh` 打包在一起:

```json
{
  "mode": "k8s-single",
  "name": "app",
  "hardware": {
    "cpuCores": 2,
    "memoryGb": 4,
    "diskGb": 50,
    "workload": "balanced"
  },
  "port": 27117,
  "apps": [
    { "db": "app", "user": "app" },
    { "db": "billing", "user": "billu" }
  ],
  "k8s": { "namespace": "data", "serviceType": "ClusterIP" }
}
```

```shell
# [本地开发机] 1) 生成内嵌 chart/ 的可移植部署包
codd deploy.json

# [K8s 管控机] 2) 直接执行或将 dist/mongo-app-<fp>-k8s/ 拷到管控跳板机执行
bash dist/mongo-app-<fp>-k8s/deploy.sh
```

完整连接串保存在**本地开发机** `.codd-state/k8s-single-<name>.credentials.txt` (`0600`)。

## 二、[K8s 管控机] 手工预建 Secret + 直调 Helm Chart

在已配置集群 `kubeconfig` 与 `helm` 的 **K8s 管控机** 执行:

```shell
kubectl cluster-info && helm version --short && kubectl get storageclass
NS=data
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -
ROOT_PWD="$(openssl rand -hex 12)"
APP_PWD="$(openssl rand -hex 12)"
BAK_PWD="$(openssl rand -hex 12)"
KEY_B64="$(openssl rand -base64 756 | tr -d '\n')"

kubectl -n "$NS" create secret generic mongo-app-auth \
  --from-literal=root-password="$ROOT_PWD" \
  --from-literal=app-password="$APP_PWD" \
  --from-literal=backup-password="$BAK_PWD" \
  --from-literal=extra-apps="" \
  --from-literal=mongodb-keyfile="$KEY_B64" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install mongo-app ./chart \
  --namespace data \
  --set replicaCount=1 \
  --set auth.existingSecret=mongo-app-auth \
  --set service.type=ClusterIP \
  --set config.net.port=27117 \
  --set service.port=27117
```

## 三、[K8s 管控机] 验收、集群内连接串与 PVC 在线扩盘

```shell
REL=mongo-app   # 若由生成器默认生成则为 mongo-app-<fp>
kubectl -n data get pods,jobs,pvc -l app.kubernetes.io/instance="$REL"

APP_PWD="$(kubectl -n data get secret "${REL}-auth" -o jsonpath='{.data.app-password}' | base64 -d)"
kubectl -n data exec "${REL}-0" -c mongo -- mongosh \
  "mongodb://app:${APP_PWD}@127.0.0.1:27117/app?authSource=app&directConnection=true" \
  --quiet --eval 'print("primary:", db.hello().isWritablePrimary); db.__k8s_smoke.insertOne({ok: true}); db.__k8s_smoke.drop();'
```

- **同集群业务连接串**: `mongodb://<USER>:<PWD>@<REL>.data.svc.cluster.local:27117/<DB>?authSource=<DB>&directConnection=true`
- **在线扩盘** (`StorageClass` 须支持 `allowVolumeExpansion: true`):

  ```shell
  kubectl -n data patch pvc "data-${REL}-0" -p '{"spec":{"resources":{"requests":{"storage":"64Gi"}}}}'
  ```
