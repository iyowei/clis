#!/bin/sh
set -eu

# clis 统一 POSIX 一键安装器 (macOS / Linux)
# 自动探测系统 bun / node (>= 22.18.0); 未满足时默认下载安装隔离私有 Bun 运行时。

DEFAULT_REGISTRY="https://registry.npmjs.org"
DEFAULT_INSTALLER_URL="https://raw.githubusercontent.com/iyowei/clis/main/install.sh"

TOOL_ARG="${CLIS_TOOL:-}"
POSITIONAL_TOOL_SEEN=0
EXPLICIT_VERSION=""
EXPLICIT_INSTALLER_URL=""
EXPLICIT_BUN_URL=""
EXPLICIT_REGISTRY=""
FROM_TARBALL=""
EXPLICIT_NO_PATH=""
UNINSTALL=0
ASSUME_YES=0

say() {
  printf '%s\n' "$*"
}

warn() {
  printf '警告: %s\n' "$*" >&2
}

die() {
  printf '错误: %s\n' "$*" >&2
  exit 1
}

print_help() {
  cat <<'EOF'
clis 统一一键安装脚本 (macOS / Linux)

用法:
  install.sh [工具名] [选项]
  curl -fsSL https://raw.githubusercontent.com/iyowei/clis/main/install.sh | sh -s -- codd

支持工具:
  codd         @iyowei/codd-cli      全栈开发环境自动编排器 (Podman / K8s / Helm / MongoDB)
  create-clis  create-clis           生成标准化 TypeScript + Bun CLI 仓库
  sweep        @iyowei/sweep-cli     通用多技术栈工作区清理器
  fan          @iyowei/fan-cli       macOS 风扇查看与手动控制器 (仅 macOS)

选项:
  --tool <name>             要安装的 CLI 工具名 (也可直接作为首参数, 如 install.sh codd)
  --version <ver>           指定目标 CLI 的版本或标签 (默认: latest)
  --installer-url <url>     自定义主安装脚本本身的完整下载地址 (包入口脚本拉取主脚本时使用)
  --bun-url <url>           自定义私有 Bun 运行时下载地址 (支持 .zip 完整直链 / Release 目录 / {file} 模板)
  --registry <url>          自定义 npm 软件源地址, 用于下载目标 CLI 及依赖 (默认: https://registry.npmjs.org)
  --from-tarball <path|url> 跳过 npm 源, 直接从本地 .tgz 文件或下载直链安装目标 CLI 压缩包 (如 npm pack 产物)
  --no-path                 跳过 PATH 配置引导提示
  --uninstall               卸载指定工具 (所有工具全部卸载后自动清理私有 Bun)
  -y, --yes                 非交互自动确认
  -h, --help                显示此帮助信息

环境变量 (支持 <TOOL> 为 CODD / CREATE_CLIS / SWEEP / FAN, 亦兼容共享 CLIS_* / NPM_CONFIG_REGISTRY):
  <TOOL>_INSTALLER_URL / <TOOL>_BUN_URL / <TOOL>_REGISTRY / NPM_CONFIG_REGISTRY /
  <TOOL>_VERSION / <TOOL>_INSTALL_HOME / <TOOL>_BIN_DIR / <TOOL>_NO_MODIFY_PATH
EOF
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h|--help)
        print_help
        exit 0
        ;;
      --tool)
        [ "$#" -ge 2 ] || die "--tool 需要参数值"
        TOOL_ARG="$2"
        shift 2
        ;;
      --tool=*)
        TOOL_ARG="${1#--tool=}"
        shift
        ;;
      --version)
        [ "$#" -ge 2 ] || die "--version 需要参数值"
        EXPLICIT_VERSION="$2"
        shift 2
        ;;
      --version=*)
        EXPLICIT_VERSION="${1#--version=}"
        shift
        ;;
      --installer-url)
        [ "$#" -ge 2 ] || die "--installer-url 需要参数值"
        EXPLICIT_INSTALLER_URL="$2"
        shift 2
        ;;
      --installer-url=*)
        EXPLICIT_INSTALLER_URL="${1#--installer-url=}"
        shift
        ;;
      --bun-url)
        [ "$#" -ge 2 ] || die "--bun-url 需要参数值"
        EXPLICIT_BUN_URL="$2"
        shift 2
        ;;
      --bun-url=*)
        EXPLICIT_BUN_URL="${1#--bun-url=}"
        shift
        ;;
      --registry)
        [ "$#" -ge 2 ] || die "--registry 需要参数值"
        EXPLICIT_REGISTRY="$2"
        shift 2
        ;;
      --registry=*)
        EXPLICIT_REGISTRY="${1#--registry=}"
        shift
        ;;
      --from-tarball)
        [ "$#" -ge 2 ] || die "--from-tarball 需要参数值"
        FROM_TARBALL="$2"
        shift 2
        ;;
      --from-tarball=*)
        FROM_TARBALL="${1#--from-tarball=}"
        shift
        ;;
      --no-path)
        EXPLICIT_NO_PATH="1"
        shift
        ;;
      --uninstall)
        UNINSTALL=1
        shift
        ;;
      -y|--yes)
        ASSUME_YES=1
        shift
        ;;
      --)
        shift
        break
        ;;
      -*)
        die "未知选项: $1 (传 --help 查看帮助)"
        ;;
      *)
        if [ -z "$TOOL_ARG" ]; then
          TOOL_ARG="$1"
          POSITIONAL_TOOL_SEEN=1
          shift
        elif [ "$POSITIONAL_TOOL_SEEN" -eq 0 ] && [ "$1" = "$TOOL_ARG" ]; then
          POSITIONAL_TOOL_SEEN=1
          shift
        else
          die "多余或冲突的位置参数: $1 (已指定工具 $TOOL_ARG; 传 --help 查看帮助)"
        fi
        ;;
    esac
  done
}

prompt_tool_if_needed() {
  [ -n "$TOOL_ARG" ] && return 0

  if [ -z "${CI:-}" ] && [ -z "${CLIS_NON_INTERACTIVE:-}" ] && [ "$ASSUME_YES" -eq 0 ]; then
    if [ -t 0 ]; then
      printf '\n请选择要安装的 CLI 工具:\n'
      printf '  1) fan          (macOS 风扇、温度与功耗控制)\n'
      printf '  2) codd         (全栈开发环境编排器)\n'
      printf '  3) create-clis  (monorepo 包脚手架生成)\n'
      printf '  4) sweep        (多技术栈磁盘清理器)\n'
      printf '输入序号 [1-4]: '
      read -r _choice || true
    elif [ -r /dev/tty ]; then
      printf '\n请选择要安装的 CLI 工具:\n' >/dev/tty
      printf '  1) fan          (macOS 风扇、温度与功耗控制)\n' >/dev/tty
      printf '  2) codd         (全栈开发环境编排器)\n' >/dev/tty
      printf '  3) create-clis  (monorepo 包脚手架生成)\n' >/dev/tty
      printf '  4) sweep        (多技术栈磁盘清理器)\n' >/dev/tty
      printf '输入序号 [1-4]: ' >/dev/tty
      read -r _choice </dev/tty || true
    else
      _choice=""
    fi

    case "${_choice:-}" in
      1|fan) TOOL_ARG="fan" ;;
      2|codd) TOOL_ARG="codd" ;;
      3|create-clis) TOOL_ARG="create-clis" ;;
      4|sweep) TOOL_ARG="sweep" ;;
      "") ;;
      *) die "无效选择: $_choice" ;;
    esac
  fi

  if [ -z "$TOOL_ARG" ]; then
    _hint_url="${EXPLICIT_INSTALLER_URL:-${CLIS_INSTALLER_URL:-$DEFAULT_INSTALLER_URL}}"
    die "未指定工具名称。请传 --tool <fan|codd|create-clis|sweep>，例如:
  curl -fsSL ${_hint_url} | sh -s -- --tool codd"
  fi
}

resolve_tool_spec() {
  case "$TOOL_ARG" in
    fan|fan-cli|@iyowei/fan-cli)
      TOOL_KEY="fan"
      TOOL_PREFIX="FAN"
      PKG_NAME="@iyowei/fan-cli"
      BIN_NAME="fan"
      ENTRY_FILE="fan.mjs"
      DIST_FILE="cli.js"
      ONLY_OS="darwin"
      ;;
    codd|codd-cli|@iyowei/codd-cli)
      TOOL_KEY="codd"
      TOOL_PREFIX="CODD"
      PKG_NAME="@iyowei/codd-cli"
      BIN_NAME="codd"
      ENTRY_FILE="codd.mjs"
      DIST_FILE="cli.js"
      ONLY_OS="all"
      ;;
    create-clis)
      TOOL_KEY="create-clis"
      TOOL_PREFIX="CREATE_CLIS"
      PKG_NAME="create-clis"
      BIN_NAME="create-clis"
      ENTRY_FILE="create-clis.mjs"
      DIST_FILE="create-clis.js"
      ONLY_OS="all"
      ;;
    sweep|sweep-cli|@iyowei/sweep-cli)
      TOOL_KEY="sweep"
      TOOL_PREFIX="SWEEP"
      PKG_NAME="@iyowei/sweep-cli"
      BIN_NAME="sweep"
      ENTRY_FILE="sweep.mjs"
      DIST_FILE="cli.js"
      ONLY_OS="all"
      ;;
    *)
      die "不支持的工具: $TOOL_ARG (可选: fan, codd, create-clis, sweep)"
      ;;
  esac
}

get_tool_env() {
  _suffix="$1"
  case "${TOOL_KEY}:${_suffix}" in
    fan:INSTALLER_URL)           printf '%s' "${FAN_INSTALLER_URL:-${CLIS_INSTALLER_URL:-}}" ;;
    codd:INSTALLER_URL)          printf '%s' "${CODD_INSTALLER_URL:-${CLIS_INSTALLER_URL:-}}" ;;
    create-clis:INSTALLER_URL)   printf '%s' "${CREATE_CLIS_INSTALLER_URL:-${CLIS_INSTALLER_URL:-}}" ;;
    sweep:INSTALLER_URL)         printf '%s' "${SWEEP_INSTALLER_URL:-${CLIS_INSTALLER_URL:-}}" ;;
    fan:BUN_URL)                 printf '%s' "${FAN_BUN_URL:-${CLIS_BUN_URL:-}}" ;;
    codd:BUN_URL)                printf '%s' "${CODD_BUN_URL:-${CLIS_BUN_URL:-}}" ;;
    create-clis:BUN_URL)         printf '%s' "${CREATE_CLIS_BUN_URL:-${CLIS_BUN_URL:-}}" ;;
    sweep:BUN_URL)               printf '%s' "${SWEEP_BUN_URL:-${CLIS_BUN_URL:-}}" ;;
    fan:BUN_VERSION)             printf '%s' "${FAN_BUN_VERSION:-${CLIS_BUN_VERSION:-}}" ;;
    codd:BUN_VERSION)            printf '%s' "${CODD_BUN_VERSION:-${CLIS_BUN_VERSION:-}}" ;;
    create-clis:BUN_VERSION)     printf '%s' "${CREATE_CLIS_BUN_VERSION:-${CLIS_BUN_VERSION:-}}" ;;
    sweep:BUN_VERSION)           printf '%s' "${SWEEP_BUN_VERSION:-${CLIS_BUN_VERSION:-}}" ;;
    fan:REGISTRY)                printf '%s' "${FAN_REGISTRY:-${CLIS_REGISTRY:-${NPM_CONFIG_REGISTRY:-}}}" ;;
    codd:REGISTRY)               printf '%s' "${CODD_REGISTRY:-${CLIS_REGISTRY:-${NPM_CONFIG_REGISTRY:-}}}" ;;
    create-clis:REGISTRY)        printf '%s' "${CREATE_CLIS_REGISTRY:-${CLIS_REGISTRY:-${NPM_CONFIG_REGISTRY:-}}}" ;;
    sweep:REGISTRY)              printf '%s' "${SWEEP_REGISTRY:-${CLIS_REGISTRY:-${NPM_CONFIG_REGISTRY:-}}}" ;;
    fan:VERSION)                 printf '%s' "${FAN_VERSION:-${CLIS_VERSION:-}}" ;;
    codd:VERSION)                printf '%s' "${CODD_VERSION:-${CLIS_VERSION:-}}" ;;
    create-clis:VERSION)         printf '%s' "${CREATE_CLIS_VERSION:-${CLIS_VERSION:-}}" ;;
    sweep:VERSION)               printf '%s' "${SWEEP_VERSION:-${CLIS_VERSION:-}}" ;;
    fan:INSTALL_HOME)            printf '%s' "${FAN_INSTALL_HOME:-${CLIS_INSTALL_HOME:-}}" ;;
    codd:INSTALL_HOME)           printf '%s' "${CODD_INSTALL_HOME:-${CLIS_INSTALL_HOME:-}}" ;;
    create-clis:INSTALL_HOME)    printf '%s' "${CREATE_CLIS_INSTALL_HOME:-${CLIS_INSTALL_HOME:-}}" ;;
    sweep:INSTALL_HOME)          printf '%s' "${SWEEP_INSTALL_HOME:-${CLIS_INSTALL_HOME:-}}" ;;
    fan:BIN_DIR)                 printf '%s' "${FAN_BIN_DIR:-${CLIS_BIN_DIR:-}}" ;;
    codd:BIN_DIR)                printf '%s' "${CODD_BIN_DIR:-${CLIS_BIN_DIR:-}}" ;;
    create-clis:BIN_DIR)         printf '%s' "${CREATE_CLIS_BIN_DIR:-${CLIS_BIN_DIR:-}}" ;;
    sweep:BIN_DIR)               printf '%s' "${SWEEP_BIN_DIR:-${CLIS_BIN_DIR:-}}" ;;
    fan:NO_MODIFY_PATH)          printf '%s' "${FAN_NO_MODIFY_PATH:-${CLIS_NO_MODIFY_PATH:-}}" ;;
    codd:NO_MODIFY_PATH)         printf '%s' "${CODD_NO_MODIFY_PATH:-${CLIS_NO_MODIFY_PATH:-}}" ;;
    create-clis:NO_MODIFY_PATH)  printf '%s' "${CREATE_CLIS_NO_MODIFY_PATH:-${CLIS_NO_MODIFY_PATH:-}}" ;;
    sweep:NO_MODIFY_PATH)        printf '%s' "${SWEEP_NO_MODIFY_PATH:-${CLIS_NO_MODIFY_PATH:-}}" ;;
  esac
}

detect_host_os() {
  _raw_os=$(uname -s 2>/dev/null || printf 'unknown')
  case "$_raw_os" in
    Darwin) HOST_OS="darwin" ;;
    Linux) HOST_OS="linux" ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      _ps1_url="https://raw.githubusercontent.com/iyowei/clis/main/install.ps1"
      _cur_installer="${EXPLICIT_INSTALLER_URL:-$(get_tool_env INSTALLER_URL)}"
      case "$_cur_installer" in
        */install.sh) _ps1_url="${_cur_installer%/install.sh}/install.ps1" ;;
      esac
      die "检测到 Windows 环境; 请改用 PowerShell 一键安装脚本:
  irm ${_ps1_url} | iex"
      ;;
    *)
      die "暂不支持当前操作系统: $_raw_os (支持 macOS / Linux / Windows PowerShell)"
      ;;
  esac

  if [ "$ONLY_OS" != "all" ] && [ "$HOST_OS" != "$ONLY_OS" ]; then
    die "$PKG_NAME ($BIN_NAME) 仅支持 macOS (需访问 AppleSMC 传感器与风扇硬件接口), 当前系统 $_raw_os 不可用。"
  fi
}

validate_http_url() {
  _flag_name="$1"
  _url_val="$2"
  case "$_url_val" in
    http://*|https://*) ;;
    *) die "非法的 ${_flag_name} 地址 (仅支持 http/https): $_url_val" ;;
  esac
  case "$_url_val" in
    *[[:space:]]*|*\"*|*\'*)
      die "非法的 ${_flag_name} 地址 (禁止包含引号或空白): $_url_val"
      ;;
  esac
}

replace_file_token() {
  _tpl="$1"
  _rep="$2"
  _out=""
  while :; do
    case "$_tpl" in
      *"{file}"*)
        _out="${_out}${_tpl%%\{file\}*}${_rep}"
        _tpl="${_tpl#*\{file\}}"
        ;;
      *)
        _out="${_out}${_tpl}"
        break
        ;;
    esac
  done
  printf '%s\n' "$_out"
}

validate_inputs() {
  if [ "$UNINSTALL" -eq 1 ]; then
    if [ -n "$EXPLICIT_VERSION" ] || [ -n "$FROM_TARBALL" ] || [ -n "$EXPLICIT_BUN_URL" ] || [ -n "$EXPLICIT_REGISTRY" ]; then
      die "参数冲突: --uninstall 仅用于卸载, 不能与 --version / --from-tarball / --bun-url / --registry 同时使用"
    fi
    return 0
  fi

  _env_ver=$(get_tool_env VERSION)
  if [ -n "$FROM_TARBALL" ]; then
    if [ -n "$EXPLICIT_VERSION" ]; then
      die "参数冲突: --from-tarball 与 --version 不能同时指定 (压缩包内版本已由 package.json 决定)"
    fi
    if [ -n "$_env_ver" ]; then
      warn "已指定 --from-tarball, 将以压缩包内版本为准, 忽略环境变量 ${TOOL_PREFIX}_VERSION=${_env_ver}"
    fi
    TARGET_VERSION="tarball"
  else
    TARGET_VERSION="${EXPLICIT_VERSION:-${_env_ver:-latest}}"
    case "$TARGET_VERSION" in
      ""|*[!A-Za-z0-9._+-]*)
        die "非法的版本号或 dist-tag: $TARGET_VERSION"
        ;;
    esac
  fi

  _env_installer=$(get_tool_env INSTALLER_URL)
  INSTALLER_URL="${EXPLICIT_INSTALLER_URL:-${_env_installer:-$DEFAULT_INSTALLER_URL}}"
  validate_http_url "--installer-url" "$INSTALLER_URL"
  if [ -n "$EXPLICIT_INSTALLER_URL" ] && [ "${CLIS_INVOKED_BY_WRAPPER:-0}" != "1" ]; then
    warn "当前已在主安装脚本内运行, --installer-url ($INSTALLER_URL) 仅在通过包入口脚本拉取主脚本时生效"
  fi

  _env_bun=$(get_tool_env BUN_URL)
  BUN_URL="${EXPLICIT_BUN_URL:-$_env_bun}"
  [ -n "$BUN_URL" ] && validate_http_url "--bun-url" "$BUN_URL"

  BUN_VERSION="$(get_tool_env BUN_VERSION)"

  USER_REGISTRY="${EXPLICIT_REGISTRY:-$(get_tool_env REGISTRY)}"
  RAW_REGISTRY="${USER_REGISTRY:-$DEFAULT_REGISTRY}"
  RAW_REGISTRY="${RAW_REGISTRY%/}"
  validate_http_url "--registry" "$RAW_REGISTRY"
  case "$RAW_REGISTRY" in
    *@*|*\?*|*\#*)
      die "非法的 registry 地址 (禁止包含凭据或查询串): $RAW_REGISTRY"
      ;;
  esac

  DATA_DIR="$(get_tool_env INSTALL_HOME)"
  BIN_DIR="$(get_tool_env BIN_DIR)"
  NO_PATH="${EXPLICIT_NO_PATH:-$(get_tool_env NO_MODIFY_PATH)}"
  [ -z "$NO_PATH" ] && NO_PATH=0

  FROM_TARBALL_IS_URL=0
  if [ -n "$FROM_TARBALL" ]; then
    case "$FROM_TARBALL" in
      http://*|https://*)
        validate_http_url "--from-tarball" "$FROM_TARBALL"
        FROM_TARBALL_IS_URL=1
        case "$FROM_TARBALL" in
          http://127.0.0.1*|http://localhost*|http://\[::1\]*) ;;
          http://*)
            warn "正在通过非加密 HTTP 下载远程压缩包且无注册表完整性摘要, 请确认网络链路可信: $FROM_TARBALL"
            ;;
        esac
        ;;
      *)
        [ -f "$FROM_TARBALL" ] || die "指定的本地 tarball 不存在: $FROM_TARBALL"
        ;;
    esac
  fi
}

to_abs_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s\n' "$PWD/$1" ;;
  esac
}

resolve_dirs() {
  [ -n "${HOME:-}" ] || die "环境变量 HOME 未设置"
  if [ "$UNINSTALL" -eq 1 ]; then
    DATA_DIR="$(get_tool_env INSTALL_HOME)"
    BIN_DIR="$(get_tool_env BIN_DIR)"
    NO_PATH=0
  fi
  if [ -z "$DATA_DIR" ]; then
    DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/clis"
  fi
  if [ -z "$BIN_DIR" ]; then
    BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
  fi
  DATA_DIR=$(to_abs_path "$DATA_DIR")
  BIN_DIR=$(to_abs_path "$BIN_DIR")
  _nl=$(printf '\n_')
  _nl="${_nl%_}"
  _cr=$(printf '\r')
  case "${DATA_DIR}${BIN_DIR}" in
    *"$_nl"*|*"$_cr"*)
      die "安装目录或命令目录路径禁止包含换行符"
      ;;
  esac
  if [ "$UNINSTALL" -eq 0 ]; then
    mkdir -p "$DATA_DIR" "$BIN_DIR"
    DATA_DIR=$(cd "$DATA_DIR" && pwd -P)
    BIN_DIR=$(cd "$BIN_DIR" && pwd -P)
  fi
  case "$NO_PATH" in
    1|true|TRUE|yes|YES) NO_PATH=1 ;;
    *) NO_PATH=0 ;;
  esac
  RUNTIME_DIR="$DATA_DIR/runtime"
  APPS_DIR="$DATA_DIR/apps"
  APP_DIR="$APPS_DIR/$BIN_NAME"
  BIN_PATH="$BIN_DIR/$BIN_NAME"
}

check_downloader() {
  CURL_PROTO_OK=0
  if command -v curl >/dev/null 2>&1; then
    DL_TOOL="curl"
    if curl --proto '=http,https' --proto-redir '=http,https' --version >/dev/null 2>&1; then
      CURL_PROTO_OK=1
    fi
  elif command -v wget >/dev/null 2>&1; then
    DL_TOOL="wget"
  else
    DL_TOOL=""
  fi
}

# 将带 HTTP 状态码的下载封装为 (out_file) -> 返回状态码文件, 限制仅允许 http/https 重定向防跨协议探测
http_download_with_status() {
  _url="$1"
  _out="$2"
  _status_file="$3"
  _accept="${4:-application/octet-stream}"
  _conn_timeout="${5:-15}"
  _max_time="${6:-180}"

  [ -n "$DL_TOOL" ] || die "未找到 curl 或 wget, 无法执行网络下载"

  if [ "$DL_TOOL" = "curl" ]; then
    if [ "${CURL_PROTO_OK:-0}" -eq 1 ]; then
      _code=$(curl -sS -L --proto '=http,https' --proto-redir '=http,https' --connect-timeout "$_conn_timeout" --max-time "$_max_time" -H "Accept: $_accept" -o "$_out" -w '%{http_code}' "$_url" 2>"${_out}.err" || true)
    else
      _code=$(curl -sS -L --connect-timeout "$_conn_timeout" --max-time "$_max_time" -H "Accept: $_accept" -o "$_out" -w '%{http_code}' "$_url" 2>"${_out}.err" || true)
    fi
    printf '%s' "$_code" > "$_status_file"
    case "$_code" in
      2[0-9][0-9]) return 0 ;;
      *) return 1 ;;
    esac
  else
    _hdr_file="${_out}.hdr"
    if wget -q -T "$_max_time" -S --header="Accept: $_accept" -O "$_out" "$_url" 2>"$_hdr_file"; then
      printf '200' > "$_status_file"
      return 0
    fi
    _code=$(sed -n 's/^[[:space:]]*HTTP\/[0-9.]*[[:space:]]\([0-9][0-9][0-9]\).*/\1/p' "$_hdr_file" | tail -n 1 || true)
    printf '%s' "${_code:-000}" > "$_status_file"
    return 1
  fi
}

find_abs_exec() {
  _name="$1"
  _old_ifs="$IFS"
  IFS=':'
  for _dir in ${PATH:-}; do
    case "$_dir" in
      /*)
        _cand="$_dir/$_name"
        if [ -f "$_cand" ] && [ -x "$_cand" ]; then
          IFS="$_old_ifs"
          printf '%s\n' "$_cand"
          return 0
        fi
        ;;
    esac
  done
  IFS="$_old_ifs"
  return 1
}

is_node_supported() {
  "$1" -e "var p=process.versions.node.split('.');var a=parseInt(p[0],10),b=parseInt(p[1],10);process.exit((a>22||(a===22&&b>=18))?0:1)" >/dev/null 2>&1
}

detect_existing_runtime() {
  HOST_BUN=""
  HOST_NODE=""
  HOST_NPM=""
  PRIVATE_BUN=""
  ACTIVE_JS_RUNTIME=""
  ACTIVE_RUNTIME_KIND=""
  _skipped_node=""

  _old_ifs="$IFS"
  IFS=':'
  for _dir in ${PATH:-}; do
    case "$_dir" in
      /*)
        if [ -z "$HOST_BUN" ] && [ -f "$_dir/bun" ] && [ -x "$_dir/bun" ]; then
          if "$_dir/bun" --version >/dev/null 2>&1; then
            HOST_BUN="$_dir/bun"
          fi
        fi
        if [ -z "$HOST_NODE" ] && [ -f "$_dir/node" ] && [ -x "$_dir/node" ]; then
          if is_node_supported "$_dir/node"; then
            HOST_NODE="$_dir/node"
          elif [ -z "$_skipped_node" ]; then
            _nver=$("$_dir/node" -v 2>/dev/null || printf 'unknown')
            _skipped_node="$_dir/node ($_nver)"
          fi
        fi
        if [ -z "$HOST_NPM" ] && [ -f "$_dir/npm" ] && [ -x "$_dir/npm" ]; then
          HOST_NPM="$_dir/npm"
        fi
        ;;
    esac
  done
  IFS="$_old_ifs"

  if [ -f "$RUNTIME_DIR/bun" ] && [ -x "$RUNTIME_DIR/bun" ]; then
    if "$RUNTIME_DIR/bun" --version >/dev/null 2>&1; then
      PRIVATE_BUN="$RUNTIME_DIR/bun"
    fi
  fi

  if [ -n "$HOST_BUN" ]; then
    ACTIVE_JS_RUNTIME="$HOST_BUN"
    ACTIVE_RUNTIME_KIND="system-bun"
    say "✓ 检测到系统 Bun: $HOST_BUN ($("$HOST_BUN" --version 2>/dev/null || true))"
  elif [ -n "$HOST_NODE" ]; then
    ACTIVE_JS_RUNTIME="$HOST_NODE"
    ACTIVE_RUNTIME_KIND="system-node"
    say "✓ 检测到系统 Node: $HOST_NODE ($("$HOST_NODE" --version 2>/dev/null || true))"
  else
    if [ -n "$_skipped_node" ]; then
      say "ℹ 检测到系统 Node 低于最低要求 (>= 22.18.0), 已跳过: $_skipped_node"
    fi
    if [ -n "$PRIVATE_BUN" ]; then
      ACTIVE_JS_RUNTIME="$PRIVATE_BUN"
      ACTIVE_RUNTIME_KIND="private-bun"
      say "✓ 检测到已安装的私有隔离 Bun: $PRIVATE_BUN ($("$PRIVATE_BUN" --version 2>/dev/null || true))"
    fi
  fi

  if [ -n "$ACTIVE_JS_RUNTIME" ] && [ -n "$EXPLICIT_BUN_URL" ]; then
    warn "已检测到可用运行时 ($ACTIVE_JS_RUNTIME), 跳过私有 Bun 下载, 未使用 --bun-url ($BUN_URL)"
  fi
}

select_bun_zip_target() {
  _arch=$(uname -m 2>/dev/null || printf 'unknown')
  if [ "$HOST_OS" = "darwin" ]; then
    if [ "$_arch" = "arm64" ] || [ "$_arch" = "aarch64" ]; then
      printf 'bun-darwin-aarch64.zip'
      return 0
    fi
    if [ "$_arch" = "x86_64" ]; then
      # Apple Silicon 上以 Rosetta 跑 x86_64 shell 时仍优先 arm64 原生包
      if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || printf 0)" = "1" ]; then
        printf 'bun-darwin-aarch64.zip'
        return 0
      fi
      if sysctl -n hw.optional.avx2_0 2>/dev/null | grep -q '^1$' || \
         sysctl -n machdep.cpu.leaf7_features 2>/dev/null | grep -qiw 'AVX2'; then
        printf 'bun-darwin-x64.zip'
      else
        printf 'bun-darwin-x64-baseline.zip'
      fi
      return 0
    fi
    die "不支持的 macOS 架构: $_arch"
  fi

  # Linux glibc vs musl + AVX2 baseline 探测
  _libc=""
  if ldd --version 2>&1 | grep -qi musl || ls /lib/ld-musl-* >/dev/null 2>&1; then
    _libc="-musl"
  fi
  case "$_arch" in
    aarch64|arm64)
      printf 'bun-linux-aarch64%s.zip' "$_libc"
      ;;
    x86_64|amd64)
      if [ -r /proc/cpuinfo ] && grep -qiw 'avx2' /proc/cpuinfo; then
        printf 'bun-linux-x64%s.zip' "$_libc"
      else
        printf 'bun-linux-x64%s-baseline.zip' "$_libc"
      fi
      ;;
    *)
      die "不支持的 Linux 架构: $_arch (Bun 官方预编译仅覆盖 x64 / arm64)"
      ;;
  esac
}

compute_sha256_file() {
  _file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$_file" | awk '{print tolower($1)}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$_file" | awk '{print tolower($1)}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$_file" | awk '{print tolower($NF)}'
  else
    die "系统缺少 shasum / sha256sum / openssl, 无法校验私有 Bun 下载包完整性"
  fi
}

extract_zip_file() {
  _zip="$1"
  _dest="$2"
  mkdir -p "$_dest"
  if command -v unzip >/dev/null 2>&1; then
    if _entries=$(unzip -Z1 "$_zip" 2>/dev/null); then
      _old_ifs="$IFS"
      IFS='
'
      for _entry in $_entries; do
        case "$_entry" in
          /*|\\*|..|../*|*/../*|*/..|*"\\.."*|*"..\\"*)
            IFS="$_old_ifs"
            die "拒绝不安全的 Bun 压缩包路径条目: $_entry"
            ;;
        esac
      done
      IFS="$_old_ifs"
    fi
    unzip -q -o "$_zip" -d "$_dest"
  elif [ "$HOST_OS" = "darwin" ] && command -v ditto >/dev/null 2>&1; then
    ditto -x -k "$_zip" "$_dest"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c '
import os, sys, zipfile
zpath, dest = sys.argv[1], os.path.realpath(sys.argv[2])
prefix = dest if dest.endswith(os.sep) else dest + os.sep
with zipfile.ZipFile(zpath) as zf:
    for info in zf.infolist():
        name = info.filename.replace("\\", "/")
        if name.startswith("/") or ".." in [p for p in name.split("/") if p]:
            raise RuntimeError("Unsafe zip path: " + info.filename)
        mode = (info.external_attr >> 16) & 0o170000
        if mode == 0o120000:
            raise RuntimeError("Refusing symlink in zip: " + info.filename)
        target = os.path.realpath(os.path.join(dest, name))
        if target != dest and not target.startswith(prefix):
            raise RuntimeError("Zip-Slip blocked: " + info.filename)
    zf.extractall(dest)
' "$_zip" "$_dest"
  elif command -v tar >/dev/null 2>&1; then
    tar -xf "$_zip" -C "$_dest"
  else
    die "系统缺少 unzip / ditto / python3 / tar, 无法解压 $_zip"
  fi
  _found_link=$(find "$_dest" -type l 2>/dev/null | head -n 1 || true)
  if [ -n "$_found_link" ]; then
    rm -rf "$_dest"
    die "Bun 压缩包包含不安全的符号链接条目, 已拒绝安装"
  fi
}

parse_shasum_entry() {
  _file="$1"
  _target="$2"
  awk -v target="$_target" '
    $0 ~ /^[0-9a-fA-F]{64}[[:space:]]+/ {
      name = $2
      sub(/^\.\//, "", name)
      if (name == target) { print tolower($1); exit }
    }
  ' "$_file"
}

resolve_bun_pair_from_url() {
  _spec_url="$1"
  _default_zip="$2"
  case "$_spec_url" in
    *"{file}"*)
      _resolved_zip_name="$_default_zip"
      _zip_url=$(replace_file_token "$_spec_url" "$_resolved_zip_name")
      _sum_url=$(replace_file_token "$_spec_url" "SHASUMS256.txt")
      ;;
    *)
      _no_frag="${_spec_url%%#*}"
      _no_query="${_no_frag%%\?*}"
      case "$_no_query" in
        *.zip|*.ZIP)
          _zip_url="$_spec_url"
          _resolved_zip_name="${_no_query##*/}"
          _sum_url="${_no_query%/*}/SHASUMS256.txt"
          ;;
        *)
          _base="${_spec_url%/}"
          _resolved_zip_name="$_default_zip"
          _zip_url="${_base}/${_resolved_zip_name}"
          _sum_url="${_base}/SHASUMS256.txt"
          ;;
      esac
      ;;
  esac
  case "$_resolved_zip_name" in
    ""|.|..|*[!A-Za-z0-9._-]*)
      die "非法的 Bun 压缩包文件名: $_resolved_zip_name"
      ;;
  esac
}

ensure_private_bun_installed() {
  if [ -n "$PRIVATE_BUN" ] && [ -x "$PRIVATE_BUN" ]; then
    return 0
  fi
  check_downloader
  [ -n "$DL_TOOL" ] || die "未检测到系统 Bun / Node (>= 22.18.0), 且缺少 curl / wget 无法下载私有 Bun"

  _zip_name=$(select_bun_zip_target)
  _bun_tmp="$TMP_ROOT/bun-dl"
  mkdir -p "$_bun_tmp"

  say "→ 正在下载私有隔离 Bun 运行时 (${_zip_name})..."
  _expected_sha=""
  _zip_url=""
  _sum_url=""
  _sum_code="unknown"

  if [ -n "$BUN_URL" ]; then
    resolve_bun_pair_from_url "$BUN_URL" "$_zip_name"
    _zip_name="$_resolved_zip_name"
  else
    if [ -n "$BUN_VERSION" ]; then
      _base="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION#v}"
    else
      _base="https://github.com/oven-sh/bun/releases/latest/download"
    fi
    _zip_url="${_base}/${_zip_name}"
    _sum_url="${_base}/SHASUMS256.txt"
  fi

  say "→ 正在下载私有隔离 Bun 校验清单 (${_sum_url})..."
  if ! http_download_with_status "$_sum_url" "$_bun_tmp/SHASUMS256.txt" "$_bun_tmp/sum.code" "text/plain" 15 30; then
    _sum_code=$(cat "$_bun_tmp/sum.code" 2>/dev/null || printf unknown)
    if [ -z "$BUN_URL" ]; then
      warn "若无法直连 github.com，可传 --bun-url <url> 或设 ${TOOL_PREFIX}_BUN_URL 自定义完整下载地址"
    fi
    die "下载 Bun 校验清单 SHASUMS256.txt 失败 (HTTP $_sum_code): $_sum_url"
  fi

  _expected_sha=$(parse_shasum_entry "$_bun_tmp/SHASUMS256.txt" "$_zip_name")
  [ -n "$_expected_sha" ] || die "SHASUMS256.txt 中未找到 $_zip_name 的校验摘要"

  say "→ 正在下载私有隔离 Bun (${_zip_name}): $_zip_url..."
  http_download_with_status "$_zip_url" "$_bun_tmp/$_zip_name" "$_bun_tmp/zip.code" "application/octet-stream" 15 180 || \
    die "下载 $_zip_name 失败 (HTTP $(cat "$_bun_tmp/zip.code" 2>/dev/null || printf unknown)): $_zip_url"

  _actual_sha=$(compute_sha256_file "$_bun_tmp/$_zip_name")
  if [ "$_actual_sha" != "$_expected_sha" ]; then
    die "私有 Bun 下载包 SHA-256 校验失败 (期望: $_expected_sha, 实际: $_actual_sha)"
  fi

  say "✓ Bun SHA-256 校验通过, 正在解压..."
  extract_zip_file "$_bun_tmp/$_zip_name" "$_bun_tmp/unpacked"
  _found_bin=$(find "$_bun_tmp/unpacked" -type f -name bun | head -n 1 || true)
  [ -n "$_found_bin" ] || die "解压 $_zip_name 后未找到 bun 可执行文件"

  mkdir -p "$RUNTIME_DIR"
  _tmp_bun_bin=$(mktemp "$RUNTIME_DIR/bun.tmp.XXXXXX")
  cp "$_found_bin" "$_tmp_bun_bin"
  chmod 0755 "$_tmp_bun_bin"
  mv -f "$_tmp_bun_bin" "$RUNTIME_DIR/bun"

  "$RUNTIME_DIR/bun" --version >/dev/null 2>&1 || die "新安装的私有 Bun 无法正常启动: $RUNTIME_DIR/bun"
  PRIVATE_BUN="$RUNTIME_DIR/bun"
  ACTIVE_JS_RUNTIME="$PRIVATE_BUN"
  ACTIVE_RUNTIME_KIND="private-bun"
  say "✓ 私有隔离 Bun 已就绪 (未改动全局 PATH): $PRIVATE_BUN ($("$PRIVATE_BUN" --version 2>/dev/null || true))"
}

run_metadata_inspector_js() {
  _meta_file="$1"
  _mode="$2"
  "$ACTIVE_JS_RUNTIME" -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const mode = process.argv[2];
if (mode === "meta") {
  const tar = data && data.dist && data.dist.tarball;
  const integrity = (data && data.dist && data.dist.integrity) || "";
  const shasum = (data && data.dist && data.dist.shasum) || "";
  const version = data && data.version;
  if (typeof version !== "string" || typeof tar !== "string" || (!integrity && !shasum)) {
    console.error("Invalid npm package metadata response");
    process.exit(2);
  }
  console.log(version + "\n" + tar + "\n" + integrity + "\n" + shasum);
}
' "$_meta_file" "$_mode"
}

verify_and_extract_tarball_js() {
  _tgz="$1"
  _dest="$2"
  _integrity="$3"
  _shasum="$4"
  _expected_pkg="$5"
  _entry_file="$6"
  _dist_file="$7"

  "$ACTIVE_JS_RUNTIME" -e '
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const MAX_TGZ_BYTES = 64 * 1024 * 1024;
const MAX_TAR_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 20000;

const [tgzPath, destDir, integrity, shasum, expectedPkg, entryFile, distFile] = process.argv.slice(1);
const st = fs.statSync(tgzPath);
if (st.size > MAX_TGZ_BYTES) {
  console.error("压缩包体积超出 64 MiB 安全上限 (" + st.size + " bytes)");
  process.exit(3);
}
const bytes = fs.readFileSync(tgzPath);

if (integrity || shasum) {
  let verified = false;
  if (integrity) {
    for (const token of integrity.split(/\s+/).filter(Boolean)) {
      const idx = token.indexOf("-");
      if (idx <= 0) continue;
      const algo = token.slice(0, idx).toLowerCase();
      if (algo !== "sha512" && algo !== "sha256") continue;
      const exp = Buffer.from(token.slice(idx + 1), "base64");
      const act = crypto.createHash(algo).update(bytes).digest();
      if (exp.length > 0 && exp.length === act.length && crypto.timingSafeEqual(exp, act)) {
        verified = true;
        break;
      }
      console.error("Tarball " + algo + " 完整性校验失败");
      process.exit(3);
    }
  }
  if (!verified && shasum) {
    const exp = Buffer.from(shasum, "hex");
    const act = crypto.createHash("sha1").update(bytes).digest();
    if (exp.length === act.length && crypto.timingSafeEqual(exp, act)) {
      verified = true;
    } else {
      console.error("Tarball shasum 校验失败");
      process.exit(3);
    }
  }
  if (!verified) {
    console.error("缺少可验证的完整性摘要, 已拒绝解包");
    process.exit(3);
  }
}

const tar = zlib.gunzipSync(bytes, { maxOutputLength: MAX_TAR_BYTES });
const readStr = (b, s, l) => {
  let e = s;
  const m = Math.min(b.length, s + l);
  while (e < m && b[e] !== 0) e += 1;
  return Buffer.from(b.subarray(s, e)).toString("utf8");
};
const readNum = (b, s, l) => {
  const first = b[s] || 0;
  if (first >= 128) {
    let v = first - 128;
    for (let i = 1; i < l; i += 1) v = v * 256 + (b[s + i] || 0);
    return v;
  }
  const raw = readStr(b, s, l).trim();
  if (!raw) return 0;
  const p = Number.parseInt(raw, 8);
  if (!Number.isFinite(p) || p < 0) throw new Error("Invalid octal: " + raw);
  return p;
};
const checksumOk = (h) => {
  const exp = readNum(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += (i >= 148 && i < 156) ? 0x20 : (h[i] || 0);
  return sum === exp;
};
const parsePax = (d) => {
  const out = {};
  const txt = Buffer.from(d).toString("utf8");
  let c = 0;
  while (c < txt.length) {
    const sp = txt.indexOf(" ", c);
    if (sp <= c) break;
    const len = Number.parseInt(txt.slice(c, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = txt.slice(sp + 1, c + len);
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1).replace(/\n$/, "");
    c += len;
  }
  return out;
};
const cleanRel = (raw) => {
  if (raw.includes("\0")) throw new Error("NUL byte in tar path");
  const norm = raw.replaceAll("\\", "/").replace(/^\.\//, "");
  if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)) throw new Error("Unsafe absolute path: " + raw);
  const segs = norm.split("/").filter((x) => x !== "" && x !== ".");
  if (segs.includes("..")) throw new Error("Unsafe traversal path: " + raw);
  if (segs.length <= 1) return null;
  return segs.slice(1).join("/") || null;
};

fs.mkdirSync(destDir, { recursive: true });
const absRoot = path.resolve(destDir);
const rootPrefix = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
let off = 0, pax = null, longName = null, entryCount = 0, totalWritten = 0;
while (off + 512 <= tar.length) {
  const hdr = tar.subarray(off, off + 512);
  let zero = true;
  for (let i = 0; i < 512; i += 1) { if (hdr[i] !== 0) { zero = false; break; } }
  if (zero) break;
  if (!checksumOk(hdr)) throw new Error("Corrupt tar header at " + off);
  const tb = hdr[156] || 0;
  const tf = tb === 0 ? "0" : String.fromCharCode(tb);
  const mode = readNum(hdr, 100, 8);
  let size = readNum(hdr, 124, 12);
  const base = readStr(hdr, 0, 100);
  const prefix = readStr(hdr, 345, 155);
  let name = prefix ? prefix + "/" + base : base;
  const isMeta = tf === "x" || tf === "g" || tf === "L" || tf === "K";
  if (!isMeta && pax && typeof pax.size === "string") {
    const ps = Number.parseInt(pax.size, 10);
    if (Number.isFinite(ps) && ps >= 0) size = ps;
  }
  off += 512;
  if (off + size > tar.length) throw new Error("Truncated tar payload");
  const data = tar.subarray(off, off + size);
  off += Math.ceil(size / 512) * 512;
  if (tf === "x") { pax = parsePax(data); continue; }
  if (tf === "g" || tf === "K") continue;
  if (tf === "L") { longName = Buffer.from(data).toString("utf8").replace(/\0+$/, ""); continue; }
  if (pax) { if (pax.path) name = pax.path; pax = null; }
  if (longName !== null) { name = longName; longName = null; }
  if (name === "pax_global_header") continue;
  if (tf !== "0" && tf !== "5") throw new Error("Unsafe tar entry type: " + tf + " (" + name + ")");
  const rel = cleanRel(name);
  if (!rel) continue;
  entryCount += 1;
  if (entryCount > MAX_ENTRIES) throw new Error("Archive entry count exceeds safety limit");
  const target = path.resolve(absRoot, rel);
  if (!target.startsWith(rootPrefix)) throw new Error("Zip-Slip blocked: " + rel);
  if (tf === "5") {
    fs.mkdirSync(target, { recursive: true });
    continue;
  }
  totalWritten += data.byteLength;
  if (totalWritten > MAX_TAR_BYTES) throw new Error("Archive extracted size exceeds safety limit");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  const perm = mode % 512;
  const hasX = (Math.floor(perm / 64) % 2 === 1) || (Math.floor(perm / 8) % 2 === 1) || (perm % 2 === 1);
  fs.chmodSync(target, hasX ? 0o755 : 0o644);
}

const pkgPath = path.join(absRoot, "package.json");
if (!fs.existsSync(pkgPath)) throw new Error("压缩包缺少 package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
if (pkg.name !== expectedPkg) {
  throw new Error("包名不匹配: 期望 " + expectedPkg + ", 实际为 " + String(pkg.name));
}
const distTarget = path.join(absRoot, "dist", distFile);
if (
  !fs.existsSync(path.join(absRoot, "bin", entryFile)) ||
  !fs.existsSync(path.join(absRoot, "bin", "bunfig.toml")) ||
  !fs.existsSync(distTarget)
) {
  throw new Error("压缩包结构不完整 (缺少 bin/" + entryFile + ", bin/bunfig.toml 或 dist/" + distFile + ")");
}
const manifestPath = path.join(absRoot, "dist", "manifest.json");
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.cliSha256 !== "string") {
    throw new Error("产物清单 dist/manifest.json 格式无效");
  }
  const actualCliSha = crypto.createHash("sha256").update(fs.readFileSync(distTarget)).digest("hex");
  if (actualCliSha !== manifest.cliSha256) {
    throw new Error("产物 dist/" + distFile + " SHA-256 与 dist/manifest.json 不符");
  }
}
const hasDeps = pkg.dependencies && typeof pkg.dependencies === "object" && Object.keys(pkg.dependencies).length > 0;
console.log((pkg.version || "0.0.0") + "\n" + (hasDeps ? "1" : "0"));
' "$_tgz" "$_dest" "$_integrity" "$_shasum" "$_expected_pkg" "$_entry_file" "$_dist_file"
}

write_marker_file() {
  _marker_file="$1"
  _ver="$2"
  "$ACTIVE_JS_RUNTIME" -e '
const fs = require("node:fs");
const [out, tool, packageName, dataDir, appDir, runtimeDir, binPath, version] = process.argv.slice(1);
const marker = {
  schemaVersion: 1,
  method: "script",
  tool,
  packageName,
  dataDir,
  appDir,
  runtimeDir,
  binPath,
  version,
  updatedAt: new Date().toISOString(),
};
fs.writeFileSync(out, JSON.stringify(marker, null, 2) + "\n", "utf8");
' "$_marker_file" "$TOOL_KEY" "$PKG_NAME" "$DATA_DIR" "$APP_DIR" "$RUNTIME_DIR" "$BIN_PATH" "$_ver"
}

sh_single_quote() {
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
}

write_posix_shim() {
  mkdir -p "$BIN_DIR"
  _q_app=$(sh_single_quote "$APP_DIR")
  _q_runtime=$(sh_single_quote "$RUNTIME_DIR")
  _q_entry=$(sh_single_quote "$ENTRY_FILE")
  _q_bin=$(sh_single_quote "$BIN_NAME")
  _shim_tmp="$BIN_PATH.tmp.$$"

  cat > "$_shim_tmp" <<EOF
#!/bin/sh
set -eu

APP_DIR='${_q_app}'
RUNTIME_DIR='${_q_runtime}'
ENTRY="\$APP_DIR/bin/${_q_entry}"
BUNFIG="\$APP_DIR/bin/bunfig.toml"
PRIVATE_BUN="\$RUNTIME_DIR/bun"
BIN_NAME='${_q_bin}'

find_abs_bin() {
  _name="\$1"
  _old_ifs="\$IFS"
  IFS=':'
  for _dir in \${PATH:-}; do
    case "\$_dir" in
      /*)
        _cand="\$_dir/\$_name"
        if [ -f "\$_cand" ] && [ -x "\$_cand" ]; then
          IFS="\$_old_ifs"
          printf '%s\n' "\$_cand"
          return 0
        fi
        ;;
    esac
  done
  IFS="\$_old_ifs"
  return 1
}

if [ ! -f "\$ENTRY" ]; then
  printf '%s\n' "\$BIN_NAME: 找不到 CLI 入口 (\$ENTRY), 请重新运行安装脚本。" >&2
  exit 1
fi

if [ ! -f "\$BUNFIG" ]; then
  printf '%s\n' "\$BIN_NAME: 缺少隔离配置 (\$BUNFIG), 为防外部 bunfig.toml 劫持已拒绝执行。" >&2
  exit 1
fi

if _sys_bun=\$(find_abs_bin bun); then
  if "\$_sys_bun" --version >/dev/null 2>&1; then
    export CLIS_BUN_ISOLATED=1
    exec "\$_sys_bun" "--config=\$BUNFIG" --no-env-file "\$ENTRY" "\$@"
  fi
fi

if _sys_node=\$(find_abs_bin node); then
  if "\$_sys_node" -e "var p=process.versions.node.split('.');var a=parseInt(p[0],10),b=parseInt(p[1],10);process.exit((a>22||(a===22&&b>=18))?0:1)" >/dev/null 2>&1; then
    exec "\$_sys_node" "\$ENTRY" "\$@"
  fi
fi

if [ -f "\$PRIVATE_BUN" ] && [ -x "\$PRIVATE_BUN" ] && "\$PRIVATE_BUN" --version >/dev/null 2>&1; then
  export CLIS_BUN_ISOLATED=1
  exec "\$PRIVATE_BUN" "--config=\$BUNFIG" --no-env-file "\$ENTRY" "\$@"
fi

printf '%s\n' "\$BIN_NAME: 未找到可用的 bun 或 node (>= 22.18.0), 隔离 Bun (\$PRIVATE_BUN) 亦不可用; 请重新运行安装脚本修复。" >&2
exit 1
EOF

  chmod 0755 "$_shim_tmp"
  mv -f "$_shim_tmp" "$BIN_PATH"
}

perform_uninstall() {
  _removed=0
  if [ -e "$BIN_PATH" ] || [ -L "$BIN_PATH" ]; then
    rm -f "$BIN_PATH"
    say "✓ 已删除命令入口: $BIN_PATH"
    _removed=1
  fi
  if [ -d "$APP_DIR" ]; then
    rm -rf "$APP_DIR"
    say "✓ 已删除应用目录: $APP_DIR"
    _removed=1
  fi

  # 仅当隔离区无其余 CLI 工具时同步回收共享私有 Bun 运行时
  if [ -d "$APPS_DIR" ]; then
    _remaining=$(find "$APPS_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1 || true)
    if [ -z "$_remaining" ]; then
      rmdir "$APPS_DIR" 2>/dev/null || true
      if [ -d "$RUNTIME_DIR" ]; then
        rm -rf "$RUNTIME_DIR"
        say "✓ 已回收不再使用的私有隔离 Bun 运行时: $RUNTIME_DIR"
      fi
      rmdir "$DATA_DIR" 2>/dev/null || true
    fi
  elif [ -d "$RUNTIME_DIR" ]; then
    rm -rf "$RUNTIME_DIR"
    rmdir "$DATA_DIR" 2>/dev/null || true
  fi

  if [ "$_removed" -eq 0 ]; then
    say "$BIN_NAME 尚未通过一键脚本安装在 $APP_DIR / $BIN_PATH"
  else
    say "完成: $PKG_NAME ($BIN_NAME) 已卸载。"
  fi
}

check_path_guidance() {
  [ "$NO_PATH" -eq 1 ] && return 0
  _in_path=0
  _old_ifs="$IFS"
  IFS=':'
  for _d in ${PATH:-}; do
    [ "${_d%/}" = "${BIN_DIR%/}" ] && _in_path=1 && break
  done
  IFS="$_old_ifs"

  if [ "$_in_path" -eq 0 ]; then
    _q_bin_dir=$(sh_single_quote "$BIN_DIR")
    say ""
    say "注意: $BIN_DIR 尚未加入 PATH。请将以下行添加到你的 shell 配置文件:"
    case "${SHELL:-}" in
      */fish)
        say "  fish_add_path '${_q_bin_dir}'"
        ;;
      */zsh)
        say "  printf '\\nexport PATH=%s:\$PATH\\n' '${_q_bin_dir}' >> ~/.zshrc && . ~/.zshrc"
        ;;
      *)
        say "  printf '\\nexport PATH=%s:\$PATH\\n' '${_q_bin_dir}' >> ~/.bashrc && . ~/.bashrc"
        ;;
    esac
  fi
}

main() {
  parse_args "$@"
  prompt_tool_if_needed
  resolve_tool_spec
  detect_host_os
  validate_inputs
  resolve_dirs

  if [ "$UNINSTALL" -eq 1 ]; then
    perform_uninstall
    exit 0
  fi

  TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/clis-install.XXXXXX")
  trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

  say "准备安装 $PKG_NAME ($BIN_NAME)..."
  detect_existing_runtime

  if [ -z "$ACTIVE_JS_RUNTIME" ]; then
    ensure_private_bun_installed
  fi

  _pkg_integrity=""
  _pkg_shasum=""
  if [ -n "$FROM_TARBALL" ]; then
    if [ "$FROM_TARBALL_IS_URL" -eq 1 ]; then
      check_downloader
      [ -n "$DL_TOOL" ] || die "缺少 curl 或 wget, 无法下载 tarball: $FROM_TARBALL"
      say "→ 正在从自定义直链下载压缩包: $FROM_TARBALL..."
      http_download_with_status "$FROM_TARBALL" "$TMP_ROOT/pkg.tgz" "$TMP_ROOT/tar.code" "application/octet-stream" || \
        die "下载自定义 tarball 失败 (HTTP $(cat "$TMP_ROOT/tar.code" 2>/dev/null || printf unknown)): $FROM_TARBALL"
      _tgz_file="$TMP_ROOT/pkg.tgz"
    else
      _tgz_file="$FROM_TARBALL"
      say "→ 使用本地离线压缩包: $_tgz_file"
    fi
  else
    check_downloader
    [ -n "$DL_TOOL" ] || die "缺少 curl 或 wget, 无法访问包注册表 $RAW_REGISTRY"
    _encoded_pkg=$(printf '%s' "$PKG_NAME" | sed 's|/|%2F|g')
    _meta_url="${RAW_REGISTRY}/${_encoded_pkg}/${TARGET_VERSION}"
    say "→ 正在查询包注册表: $RAW_REGISTRY ($PKG_NAME@$TARGET_VERSION)..."
    if ! http_download_with_status "$_meta_url" "$TMP_ROOT/meta.json" "$TMP_ROOT/meta.code" "application/vnd.npm.install-v1+json, application/json" 15 30; then
      _http_code=$(cat "$TMP_ROOT/meta.code" 2>/dev/null || printf '000')
      if [ "$_http_code" = "404" ]; then
        die "$PKG_NAME ($TARGET_VERSION) 在 $RAW_REGISTRY 尚未公开发布 (HTTP 404)。若使用私有源或自定义压缩包, 可传 --registry <url> 或 --from-tarball <path|url>。"
      elif [ "$_http_code" = "401" ] || [ "$_http_code" = "403" ]; then
        die "访问 $RAW_REGISTRY 鉴权失败 (HTTP $_http_code)"
      else
        die "查询包元数据失败 (HTTP $_http_code): $_meta_url (如需切换源可传 --registry <url> 或设 ${TOOL_PREFIX}_REGISTRY / NPM_CONFIG_REGISTRY)"
      fi
    fi

    _meta_parsed=$(run_metadata_inspector_js "$TMP_ROOT/meta.json" meta)
    _resolved_ver=$(printf '%s\n' "$_meta_parsed" | sed -n '1p')
    _tar_url=$(printf '%s\n' "$_meta_parsed" | sed -n '2p')
    _pkg_integrity=$(printf '%s\n' "$_meta_parsed" | sed -n '3p')
    _pkg_shasum=$(printf '%s\n' "$_meta_parsed" | sed -n '4p')
    validate_http_url "dist.tarball" "$_tar_url"

    say "→ 正在下载 ${PKG_NAME}@${_resolved_ver}..."
    http_download_with_status "$_tar_url" "$TMP_ROOT/pkg.tgz" "$TMP_ROOT/tar.code" "application/octet-stream" || \
      die "下载安装包失败 (HTTP $(cat "$TMP_ROOT/tar.code" 2>/dev/null || printf unknown)): $_tar_url"
    _tgz_file="$TMP_ROOT/pkg.tgz"
  fi

  mkdir -p "$APPS_DIR"
  _staging_dir=$(mktemp -d "$APPS_DIR/.staging-${BIN_NAME}.XXXXXX")
  _backup_dir="$APPS_DIR/.backup-${BIN_NAME}.$$.$(date +%s 2>/dev/null || printf 0)"
  rm -rf "$_backup_dir"

  _extract_info=$(verify_and_extract_tarball_js "$_tgz_file" "$_staging_dir" "$_pkg_integrity" "$_pkg_shasum" "$PKG_NAME" "$ENTRY_FILE" "$DIST_FILE") || {
    rm -rf "$_staging_dir"
    die "校验或解包 $PKG_NAME 失败"
  }
  _pkg_ver=$(printf '%s\n' "$_extract_info" | sed -n '1p')
  _has_deps=$(printf '%s\n' "$_extract_info" | sed -n '2p')

  if [ -n "$FROM_TARBALL" ] && [ -n "$EXPLICIT_REGISTRY" ]; then
    if [ "$_has_deps" = "1" ]; then
      say "→ 已指定 --from-tarball, 本次 --registry ($RAW_REGISTRY) 仅用于安装运行时依赖"
    else
      warn "注意: 已指定 --from-tarball 且 $PKG_NAME 无运行时依赖, --registry ($RAW_REGISTRY) 未被使用"
    fi
  fi

  if [ "$_has_deps" = "1" ]; then
    say "→ 正在补装运行时依赖 (ignore-scripts)..."
    _dep_installer=""
    if [ -n "$HOST_BUN" ]; then
      _dep_installer="$HOST_BUN"
      _dep_kind="bun"
    elif [ -n "$PRIVATE_BUN" ]; then
      _dep_installer="$PRIVATE_BUN"
      _dep_kind="bun"
    elif [ -n "$HOST_NPM" ]; then
      _dep_installer="$HOST_NPM"
      _dep_kind="npm"
    else
      ensure_private_bun_installed
      _dep_installer="$PRIVATE_BUN"
      _dep_kind="bun"
    fi

    if [ "$_dep_kind" = "bun" ]; then
      if [ -n "$USER_REGISTRY" ]; then
        (cd "$_staging_dir" && "$_dep_installer" install --production --ignore-scripts --no-save --no-cache "--registry=$RAW_REGISTRY") || {
          rm -rf "$_staging_dir"
          die "使用 Bun 安装运行时依赖失败"
        }
      else
        (cd "$_staging_dir" && "$_dep_installer" install --production --ignore-scripts --no-save --no-cache) || {
          rm -rf "$_staging_dir"
          die "使用 Bun 安装运行时依赖失败"
        }
      fi
    else
      if [ -n "$USER_REGISTRY" ]; then
        (cd "$_staging_dir" && "$_dep_installer" install --omit=dev --ignore-scripts --no-audit --no-fund "--registry=$RAW_REGISTRY") || {
          rm -rf "$_staging_dir"
          die "使用 npm 安装运行时依赖失败"
        }
      else
        (cd "$_staging_dir" && "$_dep_installer" install --omit=dev --ignore-scripts --no-audit --no-fund) || {
          rm -rf "$_staging_dir"
          die "使用 npm 安装运行时依赖失败"
        }
      fi
    fi
  fi

  write_marker_file "$_staging_dir/.clis-install.json" "$_pkg_ver"

  if [ -d "$APP_DIR" ]; then
    mv "$APP_DIR" "$_backup_dir"
  fi
  if ! mv "$_staging_dir" "$APP_DIR"; then
    if [ -d "$_backup_dir" ]; then
      mv "$_backup_dir" "$APP_DIR" || true
    fi
    rm -rf "$_staging_dir"
    die "切换安装目录失败: $APP_DIR"
  fi
  rm -rf "$_backup_dir"

  write_posix_shim

  say ""
  say "✓ 已完成安装: $PKG_NAME@$_pkg_ver"
  say "  入口命令: $BIN_PATH"
  say "  安装目录: $APP_DIR"
  if [ "$ACTIVE_RUNTIME_KIND" = "private-bun" ]; then
    say "  运行引擎: 隔离私有 Bun ($PRIVATE_BUN)"
  else
    say "  运行引擎: 系统 $ACTIVE_RUNTIME_KIND ($ACTIVE_JS_RUNTIME)"
  fi
  say "  后续升级: $BIN_NAME update"
  if [ "$TOOL_KEY" = "fan" ] && [ "$HOST_OS" = "darwin" ]; then
    say "  macOS 提示: 首次读取 AppleSMC 硬件传感器需系统 Xcode Command Line Tools 的 /usr/bin/python3 支持。"
  fi
  check_path_guidance
}

main "$@"
