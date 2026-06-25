#!/system/bin/sh

MODDIR="${MODPATH:-${0%/*}}"
ABI="${ARCH:-$(getprop ro.product.cpu.abi)}"

ui_print "- Z Systemizer v1.1.1"
ui_print "- KernelSU WebUI 管理模块"
ui_print "- 准备 system/app 目录结构"

mkdir -p "$MODDIR/system/app" || abort "Failed to create system/app"
mkdir -p "$MODDIR/bin" || abort "Failed to create bin"
mkdir -p "$MODDIR/state" || abort "Failed to create state"
mkdir -p "$MODDIR/checksums" || abort "Failed to create checksums"

case "$ABI" in
  arm64-v8a|arm64|aarch64)
    SYSTEMIZER_ABI="arm64-v8a"
    ;;
  *)
    abort "不支持的 ABI: $ABI。Z Systemizer 仅提供 arm64-v8a 二进制。"
    ;;
esac

CLI_SRC="$MODDIR/bin/$SYSTEMIZER_ABI/systemizer"
CLI_DST="$MODDIR/bin/systemizer"
WEB_ENTRY="$MODDIR/webroot/index.html"

if [ ! -f "$CLI_SRC" ]; then
  abort "缺少 Rust CLI: bin/$SYSTEMIZER_ABI/systemizer"
fi

if [ ! -f "$WEB_ENTRY" ]; then
  abort "缺少 WebUI 入口: webroot/index.html"
fi

cp "$CLI_SRC" "$CLI_DST" || abort "安装 systemizer 二进制失败"

set_perm_recursive "$MODDIR/bin" 0 0 0755 0755
set_perm_recursive "$MODDIR/system" 0 0 0755 0644
set_perm_recursive "$MODDIR/state" 0 0 0755 0644
set_perm_recursive "$MODDIR/checksums" 0 0 0755 0644
set_perm "$CLI_DST" 0 0 0755

ui_print "- 已安装 CLI ($SYSTEMIZER_ABI)"
ui_print "- WebUI 可在 KernelSU 管理器中使用"
ui_print "- 仅支持 system/app"
ui_print "- 操作后需要重启"
