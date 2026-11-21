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

parse_mem_limit_mb() {
  raw="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    *g)
      num="${raw%g}"
      case "$num" in ''|*[!0-9]*) echo "" ;; *) echo $((num * 1024)) ;; esac
      ;;
    *m)
      num="${raw%m}"
      case "$num" in ''|*[!0-9]*) echo "" ;; *) echo "$num" ;; esac
      ;;
    *) echo "" ;;
  esac
}

check_kernel_view() {
  vm_mem_mb=""
  if [ "$(uname -s)" = "Linux" ]; then
    thp_en="$(read_active_bracket /sys/kernel/mm/transparent_hugepage/enabled)"
    thp_df="$(read_active_bracket /sys/kernel/mm/transparent_hugepage/defrag)"
    ptes="$(cat /sys/kernel/mm/transparent_hugepage/khugepaged/max_ptes_none 2>/dev/null || echo unknown)"
    swap="$(cat /proc/sys/vm/swappiness 2>/dev/null || echo unknown)"
    maps="$(cat /proc/sys/vm/max_map_count 2>/dev/null || echo unknown)"
    overcommit="$(cat /proc/sys/vm/overcommit_memory 2>/dev/null || echo unknown)"
    cg_swap="$(cat /proc/sys/vm/force_cgroup_v2_swappiness 2>/dev/null || echo unsupported)"
    zone_reclaim="$(cat /proc/sys/vm/zone_reclaim_mode 2>/dev/null || echo unsupported)"
  elif command -v podman >/dev/null 2>&1; then
    echo ">>> 当前为 macOS 宿主机, 正在读取 Podman Linux VM 内核参数..."
    vm_out="$(podman machine ssh '
      en=$(sed -n "s/.*\[\([^]]*\)\].*/\1/p" /sys/kernel/mm/transparent_hugepage/enabled 2>/dev/null || echo unknown)
      df=$(sed -n "s/.*\[\([^]]*\)\].*/\1/p" /sys/kernel/mm/transparent_hugepage/defrag 2>/dev/null || echo unknown)
      pt=$(cat /sys/kernel/mm/transparent_hugepage/khugepaged/max_ptes_none 2>/dev/null || echo unknown)
      sw=$(cat /proc/sys/vm/swappiness 2>/dev/null || echo unknown)
      mp=$(cat /proc/sys/vm/max_map_count 2>/dev/null || echo unknown)
      oc=$(cat /proc/sys/vm/overcommit_memory 2>/dev/null || echo unknown)
      cg=$(cat /proc/sys/vm/force_cgroup_v2_swappiness 2>/dev/null || echo unsupported)
      zr=$(cat /proc/sys/vm/zone_reclaim_mode 2>/dev/null || echo unsupported)
      mt=$(awk "/MemTotal:/ {printf \"%d\", \$2/1024}" /proc/meminfo 2>/dev/null || echo "")
      printf "%s|%s|%s|%s|%s|%s|%s|%s|%s\n" "$en" "$df" "$pt" "$sw" "$mp" "$oc" "$cg" "$zr" "$mt"
    ' 2>/dev/null || echo 'unknown|unknown|unknown|unknown|unknown|unknown|unsupported|unsupported|')"
    thp_en="$(printf '%s' "$vm_out" | cut -d'|' -f1)"
    thp_df="$(printf '%s' "$vm_out" | cut -d'|' -f2)"
    ptes="$(printf '%s' "$vm_out" | cut -d'|' -f3)"
    swap="$(printf '%s' "$vm_out" | cut -d'|' -f4)"
    maps="$(printf '%s' "$vm_out" | cut -d'|' -f5)"
    overcommit="$(printf '%s' "$vm_out" | cut -d'|' -f6)"
    cg_swap="$(printf '%s' "$vm_out" | cut -d'|' -f7)"
    zone_reclaim="$(printf '%s' "$vm_out" | cut -d'|' -f8)"
    vm_mem_mb="$(printf '%s' "$vm_out" | cut -d'|' -f9)"
  else
    echo "错误: 未检测到 Linux 内核或可用的 podman machine"
    exit 1
  fi

  echo "=== MongoDB 9.0 (tcmalloc-google) 内核性能基线巡检 ==="
  printf "  %-48s 当前: %-16s 推荐: %s\n" "transparent_hugepage/enabled" "$thp_en" "always"
  printf "  %-48s 当前: %-16s 推荐: %s\n" "transparent_hugepage/defrag" "$thp_df" "defer+madvise"
  printf "  %-48s 当前: %-16s 推荐: %s\n" "khugepaged/max_ptes_none" "$ptes" "0"
  printf "  %-48s 当前: %-16s 推荐: %s\n" "vm.swappiness" "$swap" "1"
  printf "  %-48s 当前: %-16s 推荐: %s\n" "vm.overcommit_memory" "$overcommit" "1"
  printf "  %-48s 当前: %-16s 推荐: %s\n" "vm.max_map_count" "$maps" ">= 262144"
  if [ "$cg_swap" != "unsupported" ]; then
    printf "  %-48s 当前: %-16s 推荐: %s\n" "vm.force_cgroup_v2_swappiness" "$cg_swap" "1"
  fi
  if [ "$zone_reclaim" != "unsupported" ]; then
    printf "  %-48s 当前: %-16s 推荐: %s\n" "vm.zone_reclaim_mode" "$zone_reclaim" "0"
  fi

  if [ "$(uname -s)" = "Linux" ]; then
    if [ "$(id -u)" -ne 0 ]; then
      host_hn="$(ulimit -Hn 2>/dev/null || echo 0)"
      case "$host_hn" in
        unlimited) ;;
        ''|*[!0-9]*) ;;
        *)
          if [ "$host_hn" -lt 65536 ]; then
            echo "  [警告] 当前普通用户 ulimit -Hn=$host_hn (< 65536), rootless Podman 将因 RLIMIT_NOFILE 受限而拒启或报句柄不足, 请调高 /etc/security/limits.conf 或 systemd DefaultLimitNOFILE"
          fi
          ;;
      esac
      if command -v loginctl >/dev/null 2>&1; then
        linger_state="$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo unknown)"
        if [ "$linger_state" = "no" ]; then
          echo "  [提示] 当前用户 Linger=no: Podman 无后台守护进程, 如需宿主机重启后自启容器请执行 sudo loginctl enable-linger $(id -un) 并配置 systemd/Quadlet"
        fi
      fi
    fi
    if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet tuned 2>/dev/null; then
      echo "  [提示] 检测到宿主机 tuned 服务正在运行, 若重启后 THP 或 vm.swappiness 被回写, 请在当前 active tuned profile 中显式对齐上述值"
    fi
  elif [ -n "$vm_mem_mb" ]; then
    printf "  %-48s 当前: %s MiB\n" "Podman Linux VM 物理内存" "$vm_mem_mb"
    mem_env="$ENV_FILE"
    if [ -z "$mem_env" ] && [ -f ./.env ]; then
      mem_env="./.env"
    fi
    if [ -n "$mem_env" ] && [ -f "$mem_env" ]; then
      req_mem_raw="$(awk -F= '/^MEMORY_LIMIT=/{print $2; exit}' "$mem_env" 2>/dev/null || true)"
      req_mem_mb="$(parse_mem_limit_mb "$req_mem_raw")"
      if [ -n "$req_mem_mb" ] && [ "$vm_mem_mb" -lt "$req_mem_mb" ]; then
        echo "  [警告] macOS Podman VM 可用物理内存 (${vm_mem_mb} MiB) 低于容器 MEMORY_LIMIT (${req_mem_raw}), 极易导致整个 VM 内核 OOM, 请执行: podman machine stop && podman machine set --memory $((req_mem_mb + 1024)) && podman machine start"
      fi
    fi
  fi

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
    echo "vm.overcommit_memory = 1"
    if [ -f /proc/sys/vm/force_cgroup_v2_swappiness ]; then
      echo "vm.force_cgroup_v2_swappiness = 1"
    fi
    if [ -f /proc/sys/vm/zone_reclaim_mode ]; then
      echo "vm.zone_reclaim_mode = 0"
    fi
    if [ "$cur_maps" -gt 262144 ]; then
      echo "# 当前系统 vm.max_map_count ($cur_maps) 已高于 262144, 保留原值不降配"
    else
      echo "vm.max_map_count = 262144"
    fi
  } > /etc/sysctl.d/99-codd-mongodb.conf
  if [ "$cur_maps" -gt 262144 ]; then
    echo ">>> 当前 vm.max_map_count=$cur_maps 已高于 262144, 保留系统原值不降配。"
  fi
  sysctl -p /etc/sysctl.d/99-codd-mongodb.conf >/dev/null

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
