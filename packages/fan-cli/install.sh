#!/bin/sh
set -eu

TOOL='fan'
INSTALLER_URL="https://raw.githubusercontent.com/iyowei/clis/main/install.sh"
_custom_installer=0
if [ -n "${FAN_INSTALLER_URL:-}" ]; then
  INSTALLER_URL="$FAN_INSTALLER_URL"
  _custom_installer=1
fi

_prev=''
_want_help=0
for _arg in "$@"; do
  case "$_prev" in
    --installer-url)
      [ -n "$_arg" ] || { printf '错误: --installer-url 需要参数值\n' >&2; exit 1; }
      INSTALLER_URL="$_arg"
      _custom_installer=1
      _prev=''
      continue
      ;;
    --tool)
      case "$_arg" in
        fan|fan-cli|@iyowei/fan-cli) ;;
        *)
          printf '错误: 当前是 %s 专属安装脚本, 不能指定其他工具 (%s); 如需安装其他工具请使用根安装脚本\n' "$TOOL" "$_arg" >&2
          exit 1
          ;;
      esac
      _prev=''
      continue
      ;;
  esac
  case "$_arg" in
    -h|--help) _want_help=1 ;;
    --installer-url|--tool) _prev="$_arg" ;;
    --installer-url=*)
      INSTALLER_URL="${_arg#--installer-url=}"
      [ -n "$INSTALLER_URL" ] || { printf '错误: --installer-url 需要参数值\n' >&2; exit 1; }
      _custom_installer=1
      ;;
    --tool=*)
      _tval="${_arg#--tool=}"
      case "$_tval" in
        fan|fan-cli|@iyowei/fan-cli) ;;
        *)
          printf '错误: 当前是 %s 专属安装脚本, 不能指定其他工具 (%s); 如需安装其他工具请使用根安装脚本\n' "$TOOL" "$_tval" >&2
          exit 1
          ;;
      esac
      ;;
  esac
done
if [ -n "$_prev" ]; then
  printf '错误: %s 需要参数值\n' "$_prev" >&2
  exit 1
fi

case "$INSTALLER_URL" in
  http://*|https://*) ;;
  *)
    printf '错误: 非法的安装脚本 URL (仅支持 http/https): %s\n' "$INSTALLER_URL" >&2
    exit 1
    ;;
esac
case "$INSTALLER_URL" in
  *[[:space:]]*|*\"*|*\'*)
    printf '错误: 非法的安装脚本 URL (禁止包含引号或空白): %s\n' "$INSTALLER_URL" >&2
    exit 1
    ;;
esac

if [ "$_custom_installer" -eq 0 ] && [ -f "$0" ]; then
  _dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  if [ -f "$_dir/../../install.sh" ]; then
    export CLIS_INVOKED_BY_WRAPPER=1
    exec sh "$_dir/../../install.sh" --tool "$TOOL" "$@"
  fi
fi

if [ "$_want_help" -eq 0 ]; then
  printf '→ 正在获取 %s 主安装脚本 (%s)...\n' "$TOOL" "$INSTALLER_URL"
fi

_tmp=$(mktemp "${TMPDIR:-/tmp}/clis-${TOOL}.XXXXXX")
trap 'rm -f "$_tmp"' EXIT INT TERM
if command -v curl >/dev/null 2>&1; then
  if curl --proto '=http,https' --proto-redir '=http,https' --version >/dev/null 2>&1; then
    curl -fsSL --proto '=http,https' --proto-redir '=http,https' --connect-timeout 15 --max-time 60 "$INSTALLER_URL" -o "$_tmp" || {
      printf '错误: 下载安装脚本失败 (%s)，可传 --installer-url <url> 或设 FAN_INSTALLER_URL 自定义地址\n' "$INSTALLER_URL" >&2
      exit 1
    }
  else
    curl -fsSL --connect-timeout 15 --max-time 60 "$INSTALLER_URL" -o "$_tmp" || {
      printf '错误: 下载安装脚本失败 (%s)，可传 --installer-url <url> 或设 FAN_INSTALLER_URL 自定义地址\n' "$INSTALLER_URL" >&2
      exit 1
    }
  fi
elif command -v wget >/dev/null 2>&1; then
  wget -q -T 60 -O "$_tmp" "$INSTALLER_URL" || {
    printf '错误: 下载安装脚本失败 (%s)，可传 --installer-url <url> 或设 FAN_INSTALLER_URL 自定义地址\n' "$INSTALLER_URL" >&2
    exit 1
  }
else
  printf '错误: 需要 curl 或 wget 来下载安装器\n' >&2
  exit 1
fi

if ! head -n 1 "$_tmp" 2>/dev/null | grep -q '^#!/bin/sh'; then
  printf '错误: %s 返回内容不是有效的安装脚本，请检查地址或 FAN_INSTALLER_URL 设置\n' "$INSTALLER_URL" >&2
  exit 1
fi

_rc=0
CLIS_INVOKED_BY_WRAPPER=1 sh "$_tmp" --tool "$TOOL" "$@" || _rc=$?
exit "$_rc"
