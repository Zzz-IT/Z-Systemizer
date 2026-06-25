#!/system/bin/sh

MODDIR="${MODPATH:-${0%/*}}"
ABI="${ARCH:-$(getprop ro.product.cpu.abi)}"

ui_print "- Z Systemizer module"
ui_print "- Preparing module layout"

mkdir -p "$MODDIR/system/app"
mkdir -p "$MODDIR/system/priv-app"
mkdir -p "$MODDIR/bin"
mkdir -p "$MODDIR/state"

case "$ABI" in
  arm64-v8a|arm64|aarch64)
    SYSTEMIZER_ABI="arm64-v8a"
    ;;
  *)
    abort "Unsupported ABI: $ABI. Z Systemizer currently ships arm64-v8a binary only."
    ;;
esac

if [ ! -f "$MODDIR/bin/$SYSTEMIZER_ABI/systemizer" ]; then
  abort "Missing Rust CLI: bin/$SYSTEMIZER_ABI/systemizer"
fi

cp "$MODDIR/bin/$SYSTEMIZER_ABI/systemizer" "$MODDIR/bin/systemizer" || abort "Failed to install systemizer binary"

set_perm_recursive "$MODDIR" 0 0 0755 0644
set_perm_recursive "$MODDIR/bin" 0 0 0755 0755
set_perm_recursive "$MODDIR/system" 0 0 0755 0644
set_perm "$MODDIR/bin/systemizer" 0 0 0755

ui_print "- Installed CLI for $SYSTEMIZER_ABI"
ui_print "- Reboot is required after systemizing apps"
