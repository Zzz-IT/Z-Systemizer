#!/system/bin/sh

MODDIR="${0%/*}"
CLI="$MODDIR/bin/systemizer"

[ -x "$CLI" ] || exit 0

# 等系统服务基本可用，避免过早调用 ksud
sleep 10

SYSTEMIZER_MODDIR="$MODDIR" "$CLI" refresh-derived >/dev/null 2>&1

exit 0
