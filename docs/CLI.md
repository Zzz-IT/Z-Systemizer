# Systemizer CLI

Rust backend for KSU Systemizer.

## Commands

### systemize
```
systemizer systemize <package> <app|priv-app>
```

Copies all APK splits from:
```
pm path <package>
```
into:
```
/data/adb/modules/ksu-systemizer/system/<app|priv-app>/<package>/
```

### unsystemize
```
systemizer unsystemize <package>
```

Removes systemless system app.

## Design rules

- No modification of real /system partition
- Only writes inside module directory
- No daemon / background service
- Safe path validation required

## Output

- Prints OK / ERR to stdout
