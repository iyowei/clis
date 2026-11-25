/**
 * codd 交互式向导 Kubernetes 命名空间与存储类采集步骤 (中英双语)。
 */
import {
  DNS_LABEL_RE,
  DNS_SUBDOMAIN_RE,
  type DeployManifest,
  type DeployMode,
} from '@iyowei/codd';

import { ct } from './i18n.ts';
import { askText } from './ui/index.ts';

export const collectK8sConfig = async (
  mode: DeployMode,
): Promise<NonNullable<DeployManifest['k8s']>> => {
  const namespace = await askText({
    label: ct(
      '部署到 Kubernetes 的哪个命名空间 (Namespace)?',
      'Target Kubernetes Namespace?',
    ),
    summaryLabel: ct('K8s 命名空间', 'K8s Namespace'),
    hint: ct(
      '相当于 K8s 里的项目隔离文件夹, 如果集群里还没有这个名字会自动创建, 一般直接回车用 data 即可',
      'Created automatically if absent; press Enter to use default namespace "data"',
    ),
    defaultVal: 'data',
    validate: (v) =>
      DNS_LABEL_RE.test(v) && v.length <= 63
        ? null
        : ct(
            '命名空间须为合规 DNS 标签 (小写字母、数字与中间短横线, <= 63 字符, 例如 data 或 prod-db)',
            'Namespace must be a valid DNS label (lowercase alphanumeric and hyphens, <= 63 chars)',
          ),
  });
  const storageClass = await askText({
    label: ct(
      '指定云盘存储类型 StorageClass (选填, 不清楚请直接回车)',
      'Kubernetes StorageClass (optional, press Enter for cluster default)',
    ),
    summaryLabel: ct('存储类 StorageClass', 'StorageClass'),
    hint: ct(
      '直接按回车留空就会自动使用你们 K8s 集群里设好的默认持久化云盘',
      'Leave blank to use your cluster default StorageClass',
    ),
    placeholder: ct(
      '留空使用集群默认云盘, 直接按 Enter',
      'Press Enter for cluster default StorageClass',
    ),
    defaultVal: '',
    emptySummary: ct('自动使用集群默认存储类', 'Cluster default StorageClass'),
    validate: (v) => {
      if (!v) return null;
      return DNS_SUBDOMAIN_RE.test(v) && v.length <= 253
        ? null
        : ct(
            'StorageClass 须为合规 Kubernetes 资源名 (小写字母、数字、点或连字符)',
            'StorageClass must be a valid Kubernetes subdomain (lowercase alphanumeric, ., or -)',
          );
    },
  });
  return {
    namespace,
    ...(storageClass ? { storageClass } : {}),
    podAntiAffinity: mode === 'k8s-rs' ? 'hard' : 'soft',
  };
};
