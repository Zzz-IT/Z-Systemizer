#!/system/bin/sh
set -eu

MODDIR="${MODPATH:-${0%/*}}"
ABI="${ARCH:-$(getprop ro.product.cpu.abi)}"

ui_print "- Z Systemizer v1.1.0"
ui_print "- KernelSU WebUI edition"
ui_print "- Preparing system/app-only layout"

mkdir -p "$MODDIR/system/app"
mkdir -p "$MODDIR/bin"
mkdir -p "$MODDIR/state"
mkdir -p "$MODDIR/checksums"

case "$ABI" in
  arm64-v8a|arm64|aarch64)
    SYSTEMIZER_ABI="arm64-v8a"
    ;;
  *)
    abort "Unsupported ABI: $ABI. Z Systemizer currently ships arm64-v8a binary only."
    ;;
esac

CLI_SRC="$MODDIR/bin/$SYSTEMIZER_ABI/systemizer"
CLI_DST="$MODDIR/bin/systemizer"
WEB_ENTRY="$MODDIR/webroot/index.html"

if [ ! -f "$CLI_SRC" ]; then
  abort "Missing Rust CLI: bin/$SYSTEMIZER_ABI/systemizer"
fi

if [ ! -f "$WEB_ENTRY" ]; then
  abort "Missing WebUI entry: webroot/index.html"
fi

cp "$CLI_SRC" "$CLI_DST" || abort "Failed to install systemizer binary"

if command -v sha256sum >/dev/null 2>&1; then
  if [ -f "$MODDIR/checksums/SHA256SUMS" ]; then
    ui_print "- Verifying checksums"
    (
      cd "$MODDIR"
      sha256sum -c checksums/SHA256SUMS
    ) || abort "Checksum verification failed"
  fi
fi

set_perm_recursive "$MODDIR" 0 0 0755 0644
set_perm_recursive "$MODDIR/bin" 0 0 0755 0755
set_perm_recursive "$MODDIR/system" 0 0 0755 0644
set_perm_recursive "$MODDIR/state" 0 0 0755 0644
set_perm_recursive "$MODDIR/checksums" 0 0 0755 0644
set_perm "$CLI_DST" 0 0 0755

ui_print "- Installed CLI for $SYSTEMIZER_ABI"
ui_print "- WebUI is available in KernelSU manager"
ui_print "- Only system/app is supported"
ui_print "- Reboot is required after systemizing apps"
