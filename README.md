# KSU Systemizer Starter

Kotlin + Rust + KernelSU metamodule based starter project.

## Goal

Convert selected user applications into systemless system apps by copying all APK splits into:

```text
/data/adb/modules/ksu-systemizer/system/app/<package>/
```

After reboot, a compatible KernelSU metamodule such as `meta-overlayfs` mounts the module `system/` tree over `/system`, so Android scans the app as `/system/app/<package>/...`.

## Safety policy

This starter intentionally does **not**:

- modify the real `/system` partition;
- edit HyperOS / ColorOS / vendor battery databases;
- hook `system_server`;
- run a persistent keep-alive daemon;
- generate `privapp-permissions` automatically;
- default to `priv-app`.

## Components

- `app/`: Kotlin Android manager UI.
- `cli/`: Rust `systemizer` command-line executor.
- `module-template/`: KernelSU module template.
- `scripts/package.sh`: helper packaging script.

## Build

Install Rust Android tooling:

```bash
cargo install cargo-ndk
rustup target add aarch64-linux-android
```

Build module and manager:

```bash
./scripts/package.sh
```

Outputs:

```text
out/KSU-Systemizer-v0.1.0.zip
out/ksu-systemizer-manager.apk
```

## Install

1. Install a KernelSU metamodule, for example `meta-overlayfs`.
2. Flash `out/KSU-Systemizer-v0.1.0.zip` in KernelSU Manager.
3. Install `out/ksu-systemizer-manager.apk` as a normal app.
4. Open the app, select a package, choose `system/app`, and convert.
5. Reboot.

## CLI examples

```sh
su -c /data/adb/modules/ksu-systemizer/bin/systemizer diagnose
su -c /data/adb/modules/ksu-systemizer/bin/systemizer list-systemized
su -c "/data/adb/modules/ksu-systemizer/bin/systemizer systemize com.example.app --target app"
su -c "/data/adb/modules/ksu-systemizer/bin/systemizer unsystemize com.example.app"
```
