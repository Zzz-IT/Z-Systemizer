# Z Systemizer

Z Systemizer 是一个面向 KernelSU 环境的 system/app 管理工具。它通过 Android 管理端、Rust 命令行执行层和 KernelSU 模块模板协同工作，将用户选择的已安装应用复制到模块目录中的 `system/app` 树下，并在重启后交由兼容的系统覆盖模块生效。

本项目当前明确只支持 `system/app`，不支持 `priv-app`。

## 功能特性

- 列出已安装的用户应用。
- 搜索应用包名。
- 已处理应用自动置顶。
- 将指定应用复制到模块目录的 `system/app/<package>/`。
- 支持 split APK：会复制 `pm path` 返回的所有 APK 文件。
- 支持取消处理，删除模块目录中的对应应用目录。
- 已处理应用带锁保护：需要先 `Unlock`，再 `Remove`，避免误删。
- 操作完成后在界面显示结果，并提示需要重启。
- Rust CLI 提供诊断、状态查询、用户应用列表和已处理列表。

## 当前限制

Z Systemizer 当前有意保持较窄的能力边界：

- 仅支持 `system/app`。
- 不支持 `priv-app`。
- 不写入真实 `/system` 分区。
- 不修改 vendor、ROM 电池策略数据库或厂商私有配置。
- 不 hook `system_server`。
- 不运行常驻保活服务。
- 当前仅提供 `arm64-v8a` Rust CLI 二进制安装路径。

## 工作原理

模块目录结构如下：

```text
/data/adb/modules/ksu-systemizer/
├── bin/
│   ├── arm64-v8a/systemizer
│   └── systemizer
├── state/
└── system/
    └── app/
        └── <package>/
            ├── base.apk
            └── split_*.apk
```

执行流程：

```text
MIUIX Compose UI
    ↓
SystemizerClient.kt
    ↓
RootCommand.kt 使用 su 执行
    ↓
Rust systemizer CLI
    ↓
/data/adb/modules/ksu-systemizer/system/app/<package>/
    ↓
重启后由兼容的 KernelSU 覆盖模块接管
```

## Android 管理端

Android 管理端位于 `app/`，主要代码在：

```text
app/src/main/java/dev/zzz/systemizer/
├── MainActivity.kt
├── RootCommand.kt
└── SystemizerClient.kt
```

界面能力：

- 顶部状态卡片显示当前操作结果。
- 搜索框按包名过滤应用。
- 已处理应用自动排在列表顶部。
- 未处理应用显示 `SYS` 按钮。
- 已处理应用显示 `Unlock`，解锁后显示 `Remove`。
- root 操作在 IO 线程执行，完成后回到主线程更新 UI。

## Rust CLI

Rust 执行层位于 `cli/`。

可用命令：

```sh
systemizer diagnose
systemizer list-user-apps
systemizer list-systemized
systemizer status <package>
systemizer systemize <package> app [--dry-run]
systemizer unsystemize <package>
```

示例：

```sh
su -c /data/adb/modules/ksu-systemizer/bin/systemizer diagnose
su -c /data/adb/modules/ksu-systemizer/bin/systemizer list-user-apps
su -c /data/adb/modules/ksu-systemizer/bin/systemizer list-systemized
su -c /data/adb/modules/ksu-systemizer/bin/systemizer status com.example.app
su -c "/data/adb/modules/ksu-systemizer/bin/systemizer systemize com.example.app app"
su -c "/data/adb/modules/ksu-systemizer/bin/systemizer unsystemize com.example.app"
```

`priv-app` 会被拒绝：

```sh
systemizer systemize com.example.app priv-app
# error=only system/app is supported; priv-app is intentionally disabled
```

## KernelSU 模块模板

模块模板位于 `module-template/`。

安装脚本会：

- 创建 `system/app`、`bin`、`state` 目录。
- 检测 ABI。
- 将 `bin/arm64-v8a/systemizer` 复制为 `bin/systemizer`。
- 设置模块目录和 CLI 权限。
- 明确提示仅支持 `system/app`。

## 构建说明

### 1. 构建 Android 管理端

当前仓库没有提交 Gradle Wrapper。可以使用 Android Studio 打开项目，或使用本机 Gradle：

```sh
gradle :app:assembleDebug
```

输出通常位于：

```text
app/build/outputs/apk/debug/app-debug.apk
```

### 2. 构建 Rust CLI

安装 Android Rust 目标：

```sh
rustup target add aarch64-linux-android
cargo install cargo-ndk
```

构建 arm64 二进制：

```sh
cd cli
cargo ndk -t arm64-v8a build --release
```

将输出文件复制到模块模板：

```sh
mkdir -p ../module-template/bin/arm64-v8a
cp target/aarch64-linux-android/release/systemizer ../module-template/bin/arm64-v8a/systemizer
```

### 3. 打包 KernelSU 模块

```sh
mkdir -p out
cd module-template
zip -r ../out/Z-Systemizer-v0.1.0.zip .
```

## 安装与使用

1. 确认设备已安装 KernelSU。
2. 安装兼容的系统覆盖模块，例如 meta-overlayfs 一类模块。
3. 刷入 `Z-Systemizer-v0.1.0.zip`。
4. 安装 Android 管理端 APK。
5. 打开 Z Systemizer，点击 `Refresh`。
6. 搜索或选择目标应用，点击 `SYS`。
7. 重启设备后生效。
8. 如需移除，点击该应用的 `Unlock`，再点击 `Remove`，然后重启。

## 状态说明

界面中的状态含义：

- `not processed`：未写入模块 `system/app`。
- `system/app locked`：已写入模块 `system/app`，移除前需要先解锁。
- `Done: ... Reboot required.`：操作完成，需要重启后由系统重新扫描。

## 安全说明

本项目只管理模块目录下的文件，不直接修改真实系统分区。所有变更都位于：

```text
/data/adb/modules/ksu-systemizer/system/app/
```

如果设备无法正常识别应用状态，请先执行：

```sh
su -c /data/adb/modules/ksu-systemizer/bin/systemizer diagnose
```

## 目录结构

```text
.
├── app/                 # Android 管理端
├── cli/                 # Rust CLI
├── module-template/     # KernelSU 模块模板
├── docs/                # 文档
├── build.gradle         # 根 Gradle 配置
└── settings.gradle      # Gradle settings
```

## 当前状态

Z Systemizer 当前是 system/app-only 版本，适合继续补充自动 CI、Release 打包脚本、签名配置和更完整的错误提示。