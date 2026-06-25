#!/system/bin/sh

MODDIR="${MODPATH:-${0%/*}}"
ABI="${ARCH:-$(getprop ro.product.cpu.abi)}"
OLD_MODDIR="/data/adb/modules/ksu-systemizer"

ui_print "- Z Systemizer v1.1.4"
ui_print "- 初始化模块目录"

mkdir -p "$MODDIR/bin" || abort "创建 bin 失败"
mkdir -p "$MODDIR/system/app" || abort "创建 system/app 失败"
mkdir -p "$MODDIR/state" || abort "创建 state 失败"
mkdir -p "$MODDIR/state/apks" || abort "创建 state/apks 失败"
mkdir -p "$MODDIR/checksums" || abort "创建 checksums 失败"

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

[ -f "$CLI_SRC" ] || abort "缺少 Rust CLI: bin/$SYSTEMIZER_ABI/systemizer"
[ -f "$WEB_ENTRY" ] || abort "缺少 WebUI 入口: webroot/index.html"

cp "$CLI_SRC" "$CLI_DST" || abort "安装 systemizer 二进制失败"
chmod 0755 "$CLI_DST"

if [ "$MODDIR" != "$OLD_MODDIR" ] && [ -f "$OLD_MODDIR/state/systemizer-state.json" ]; then
  ui_print "- 迁移状态文件"
  cp "$OLD_MODDIR/state/systemizer-state.json" "$MODDIR/state/systemizer-state.json" \
    || abort "迁移状态文件失败"

  if [ -d "$OLD_MODDIR/state/apks" ]; then
    ui_print "- 迁移 APK 缓存"
    cp -r "$OLD_MODDIR/state/apks/"* "$MODDIR/state/apks/" 2>/dev/null || true
  fi

  if [ -d "$OLD_MODDIR/system/app" ]; then
    ui_print "- 迁移 system/app 文件树"
    cp -r "$OLD_MODDIR/system/app/"* "$MODDIR/system/app/" 2>/dev/null || true
  fi
else
  ui_print "- 未发现新版状态文件，跳过历史迁移"
fi

SYSTEMIZER_MODDIR="$MODDIR" "$CLI_DST" reconcile --phase install \
  || abort "状态一致性检查失败"

set_perm_recursive "$MODDIR/bin" 0 0 0755 0755
set_perm_recursive "$MODDIR/system" 0 0 0755 0644
set_perm_recursive "$MODDIR/state" 0 0 0755 0644
set_perm_recursive "$MODDIR/checksums" 0 0 0755 0644
set_perm "$CLI_DST" 0 0 0755
if [ -f "$MODDIR/post-fs-data.sh" ]; then
  set_perm "$MODDIR/post-fs-data.sh" 0 0 0755
fi

ui_print "- 安装完成"
ui_print "- 已启用状态文件与开机前一致性检查"
