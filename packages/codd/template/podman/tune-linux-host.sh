#!/bin/sh
# MongoDB 9.0 (Google per-CPU TCMalloc + WiredTiger) 内核检查与一键持久化调优脚本
# 适用范围:
#   - Linux 宿主机: 直接巡检或以 sudo 写入宿主机透明大页 (THP)、sysctl 与 systemd 开机服务
#   - macOS 宿主机: 容器运行在 podman machine 拉起的 Linux 虚拟机内核之上, 脚本自动通过
#                   podman machine ssh 进入该 Linux 虚拟机完成巡检或持久化调优 (无需宿主机 sudo)
# 用法:
#   sh ./tune-linux-host.sh --check [容器名] [.env路径]   # 只读巡检 (Linux 宿主机或 macOS Podman VM)
#   sudo sh ./tune-linux-host.sh --apply                  # Linux 宿主机立即生效并写入开机持久化
#   sh ./tune-linux-host.sh --apply                       # macOS 自动进入 Podman Linux VM 生效并持久化

set -eu

MODE="${1:---check}"
CONTAINER="${2:-}"
ENV_FILE="${3:-}"

read_active_bracket() {
  sed -n 's/.*\[\([^]]*\)\].*/\1/p' "$1" 2>/dev/null || cat "$1" 2>/dev/null || echo "unknown"
}

check_kernel_view() {
  if [ "$(uname -s)" = "Linux" ]; then
    thp_en="$(read_active_bracket /sys/kernel/mm/transparent_hugepage/enabled)"
    thp_df="$(read_active_bracket /sys/kernel/mm/transparent_hugepage/defrag)"
    ptes="$(cat /sys/kernel/mm/transparent_hugepage/khugepaged/max_ptes_none 2>/dev/null || echo unknown)"
    swap="$(cat /proc/sys/vm/swappiness 2>/dev/null || echo unknown)"
    maps="$(cat /proc/sys/vm/max_map_count 2>/dev/null || echo unknown)"
  elif command -v podman >/dev/null 2>&1; then
    echo ">>> 当前为 macOS 宿主机, 正在读取 Podman Linux VM 内核参数..."
    vm_out="$(podman machine ssh '
      en=$(sed -n "s/.*\[\([^]]*\)\].*/\1/p" /sys/kernel/mm/transparent_hugepage/enabled 2>/dev/null || echo unknown)
      df=$(sed -n "s/.*\[\([^]]*\)\].*/\1/p" /sys/kernel/mm/transparent_hugepage/defrag 2>/dev/null || echo unknown)
      pt=$(cat /sys/kernel/mm/transparent_hugepage/khugepaged/max_ptes_none 2>/dev/null || echo unknown)
      sw=$(cat /proc/sys/vm/swappiness 2>/dev/null || echo unknown)
      mp=$(cat /proc/sys/vm/max_map_count 2>/dev/null || echo unknown)
      printf "%s|%s|%s|%s|%s\n" "$en" "$df" "$pt" "$sw" "$mp"
    ' 2>/dev/null || echo 'unknown|unknown|unknown|unknown|unknown')"
    thp_en="$(printf '%s' "$vm_out" | cut -d'|' -f1)"
    thp_df="$(printf '%s' "$vm_out" | cut -d'|' -f2)"
    ptes="$(printf '%s' "$vm_out" | cut -d'|' -f3)"
    swap="$(printf '%s' "$vm_out" | cut -d'|' -f4)"
    maps="$(printf '%s' "$vm_out" | cut -d'|' -f5)"
  else
    echo "错误: 未检测到 Linux 内核或可用的 podman machine"
    exit 1
  fi

  echo "=== MongoDB 9.0 (tcmalloc-google) 内核性能基线巡检 ==="
  printf "  %-48s 当前: %-16s 推荐: %s\n" "transparent_hugepage/enabled" "$thp_en" "always"
  printf "  %-48s 当前: %-16s 推荐: %s\n" "transparent_hugepage/defrag" "$thp_df" "defer+madvise"
  printf "  %-48s 当前: %-16s 推荐: %s\n" "khugepaged/max_ptes_none" "$ptes" "0"
  printf "  %-48s 当前: %-16s 推荐: %s\n" "vm.swappiness" "$swap" "1"
  printf "  %-48s 当前: %-16s 推荐: %s\n" "vm.max_map_count" "$maps" ">= 262144"

  if [ -n "$CONTAINER" ] && [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
    if podman container exists "$CONTAINER" 2>/dev/null; then
      set -a
      # shellcheck disable=SC1090
      . "$ENV_FILE"
      set +a
      echo "=== 容器运行态 ulimit 与 MongoDB startupWarnings ==="
      podman exec "$CONTAINER" bash -c 'printf "  ulimit -n (nofile): %s | ulimit -u (nproc): %s | GLIBC_TUNABLES=%s\n" "$(ulimit -n)" "$(ulimit -u)" "${GLIBC_TUNABLES:-unset}"' 2>/dev/null || true
      MONGO_PORT="${MONGO_PORT:-27117}" \
      podman exec \
        -e MONGO_INITDB_ROOT_USERNAME \
        -e MONGO_INITDB_ROOT_PASSWORD \
        -e MONGO_PORT \
        "$CONTAINER" mongosh --nodb --quiet --eval '
          const uri = "mongodb://" + encodeURIComponent(process.env.MONGO_INITDB_ROOT_USERNAME || "") + ":" + encodeURIComponent(process.env.MONGO_INITDB_ROOT_PASSWORD || "") + "@127.0.0.1:" + process.env.MONGO_PORT + "/admin?authSource=admin&directConnection=true";
          const admin = new Mongo(uri).getDB("admin");
          const w = admin.adminCommand({ getLog: "startupWarnings" }).log || [];
          print("  startupWarnings 数量: " + w.length);
          w.forEach((line) => print("    - " + line));
        ' 2>/dev/null || true
    fi
  fi
}

apply_linux_core() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "错误: Linux 宿主机请使用 sudo sh ./tune-linux-host.sh --apply (或 make tune-host) 以 root 权限执行"
    exit 1
  fi

  if [ -f /sys/kernel/mm/transparent_hugepage/enabled ]; then
    echo always > /sys/kernel/mm/transparent_hugepage/enabled
  fi
  if [ -f /sys/kernel/mm/transparent_hugepage/defrag ]; then
    echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag
  fi
  if [ -f /sys/kernel/mm/transparent_hugepage/khugepaged/max_ptes_none ]; then
    echo 0 > /sys/kernel/mm/transparent_hugepage/khugepaged/max_ptes_none
  fi

  cur_maps="$(cat /proc/sys/vm/max_map_count 2>/dev/null || echo 0)"
  case "$cur_maps" in
    ''|*[!0-9]*) cur_maps=0 ;;
  esac

  mkdir -p /etc/sysctl.d
  {
    echo "# MongoDB 9.0 Production Kernel Tuning (Managed by Codd)"
    echo "vm.swappiness = 1"
    if [ "$cur_maps" -gt 262144 ]; then
      echo "# 当前系统 vm.max_map_count ($cur_maps) 已高于 262144, 保留原值不降配"
    else
      echo "vm.max_map_count = 262144"
    fi
  } > /etc/sysctl.d/99-codd-mongodb.conf
  if [ "$cur_maps" -gt 262144 ]; then
    echo ">>> 当前 vm.max_map_count=$cur_maps 已高于 262144, 保留系统原值不降配。"
  fi
  sysctl --system >/dev/null

  if [ -d /etc/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    cat <<'EOF' > /etc/systemd/system/codd-mongodb-thp.service
[Unit]
Description=Configure Transparent Huge Pages for MongoDB 9.0 per-CPU TCMalloc
DefaultDependencies=no
After=sysinit.target local-fs.target
Before=podman.service docker.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c '[ -f /sys/kernel/mm/transparent_hugepage/enabled ] && echo always > /sys/kernel/mm/transparent_hugepage/enabled || true; [ -f /sys/kernel/mm/transparent_hugepage/defrag ] && echo defer+madvise > /sys/kernel/mm/transparent_hugepage/defrag || true; [ -f /sys/kernel/mm/transparent_hugepage/khugepaged/max_ptes_none ] && echo 0 > /sys/kernel/mm/transparent_hugepage/khugepaged/max_ptes_none || true'

[Install]
WantedBy=basic.target
EOF
    systemctl daemon-reload
    systemctl enable codd-mongodb-thp.service >/dev/null 2>&1 || true
  fi
}

apply_tuning() {
  os_name="$(uname -s)"
  if [ "$os_name" = "Linux" ]; then
    apply_linux_core
    echo ">>> Linux 宿主机 MongoDB 9.0 内核参数调优已立即生效并完成持久化。"
    check_kernel_view
  elif [ "$os_name" = "Darwin" ]; then
    if [ "$(id -u)" -eq 0 ]; then
      echo "错误: macOS 下 Podman Linux 虚拟机归属当前普通用户, 请勿加 sudo, 直接执行: sh ./tune-linux-host.sh --apply (或 make tune-host)"
      exit 1
    fi
    if ! command -v podman >/dev/null 2>&1; then
      echo "错误: 未找到 podman, 请先执行 brew install podman"
      exit 1
    fi
    if ! podman machine ssh 'true' >/dev/null 2>&1; then
      echo "错误: Podman Linux 虚拟机尚未运行, 请先执行 podman machine start"
      exit 1
    fi
    echo ">>> 当前为 macOS 宿主机, 正在进入 Podman Linux 虚拟机写入 THP / sysctl / systemd 持久化调优..."
    podman machine ssh 'sudo sh -s -- --apply-linux-core' < "$0"
    echo ">>> macOS Podman Linux 虚拟机内核调优已立即生效并完成持久化 (重启 podman machine 后自动保持)。"
    check_kernel_view
  else
    echo "错误: 不支持的操作系统 $os_name"
    exit 1
  fi
}

case "$MODE" in
  --check)
    check_kernel_view
    ;;
  --apply)
    apply_tuning
    ;;
  --apply-linux-core)
    apply_linux_core
    ;;
  *)
    echo "用法: sh ./tune-linux-host.sh [--check | --apply] [容器名] [.env路径]"
    exit 1
    ;;
esac
