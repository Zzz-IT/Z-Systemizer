#!/system/bin/sh

MODDIR="${0%/*}"
CLI="$MODDIR/bin/systemizer"

[ -x "$CLI" ] || exit 0

SYSTEMIZER_MODDIR="$MODDIR" "$CLI" reconcile --phase post-fs-data >/dev/null 2>&1

exit 0
