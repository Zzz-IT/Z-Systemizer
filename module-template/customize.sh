#!/system/bin/sh

MODDIR=${0%/*}

ui_print "- Z Systemizer module"
ui_print "- Initializing module structure"

mkdir -p "$MODDIR/system/app"
mkdir -p "$MODDIR/system/priv-app"
mkdir -p "$MODDIR/bin"
mkdir -p "$MODDIR/state"

set_perm_recursive "$MODDIR" 0 0 0755 0644
set_perm_recursive "$MODDIR/bin" 0 0 0755 0755
set_perm_recursive "$MODDIR/system" 0 0 0755 0644

ui_print "- Ready"
