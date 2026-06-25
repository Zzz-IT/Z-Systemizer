#!/system/bin/sh
set -eu

MODDIR="${MODPATH:-${0%/*}}"
ABI="${ARCH:-$(getprop ro.product.cpu.abi)}"

ui_print "- Z Systemizer"
ui_print "- Installing module-contained manager APK"
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
MANAGER_APK="$MODDIR/system/app/ZSystemizerManager/ZSystemizerManager.apk"

if [ ! -f "$CLI_SRC" ]; then
  abort "Missing Rust CLI: bin/$SYSTEMIZER_ABI/systemizer"
fi

if [ ! -f "$MANAGER_APK" ]; then
  abort "Missing manager APK: system/app/ZSystemizerManager/ZSystemizerManager.apk"
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
set_perm_recursive "$MODDIR/checksums" 0 0 0755 0644

set_perm "$CLI_DST" 0 0 0755
set_perm "$MANAGER_APK" 0 0 0644

ui_print "- Installed CLI for $SYSTEMIZER_ABI"
ui_print "- Manager APK is embedded as system/app"
ui_print "- Manual APK installation is not required"
ui_print "- Only system/app is supported"
ui_print "- Reboot is required"
