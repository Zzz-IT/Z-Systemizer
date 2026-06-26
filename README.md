# Z Systemizer

Z Systemizer 是一个面向 KernelSU 环境的 system/app 管理模块。它通过 KernelSU WebUI 和 Rust CLI 协同工作，将用户选择的已安装应用复制到模块目录中的 `system/app` 文件树，并在重启后由 KernelSU 模块覆盖机制让系统按 `/system/app` 路径扫描。

本项目当前明确只支持 `system/app`，不支持 `priv-app`，也不提供 Android APK 界面。

## 功能特性

- 使用 KernelSU WebUI 管理应用，不需要安装额外 APK
- 使用 Rust CLI 执行系统化、取消系统化、状态查询和诊断
- 列出已安装应用，支持应用名 / 包名搜索
- 支持 split APK，会复制 `pm path <package>` 返回的所有 APK 文件
- 使用持久状态文件记录系统化意图，避免只依赖目录扫描
- 使用 `state/apks` 保存 APK 缓存，重启修复时不依赖 `pm`
- 支持 `pending_add`、`active`、`pending_remove` 状态
- 支持撤销待系统化和重启前撤销待移除
- 开机阶段通过 `post-fs-data.sh` 执行轻量一致性修复
- 运行阶段通过 `service.sh` 刷新派生配置
- 动态更新模块 `module.prop` 的 `description=` 字段
- 为已系统化 / 待系统化应用生成 AOSP 省电白名单 sysconfig 辅助配置
- WebUI 使用实色卡片、淡阴影层次、图标懒加载和自然进入动画

## 当前限制

- 仅支持 `system/app`
- 不支持 `priv-app`
- 不写入真实 `/system` 分区
- 不打包 APK，也不包含 Android 原生 APK UI
- 不修改 vendor、ROM 电池策略数据库或厂商私有后台配置
- 不 hook `system_server`
- 不运行常驻保活服务
- AOSP 省电白名单只是一种辅助策略，不保证绕过厂商 ROM 的额外后台管控
- 当前仅提供 `arm64-v8a` Rust CLI 二进制安装路径

## 工作原理

```text
KernelSU WebUI (webroot/)
    ↓
kernelsu-alt / KernelSU exec API
    ↓
Rust systemizer CLI
    ↓
/data/adb/modules/ksu-systemizer/state/systemizer-state.json
/data/adb/modules/ksu-systemizer/state/apks/<package>/
/data/adb/modules/ksu-systemizer/system/app/<package>/
    ↓
重启后由 KernelSU 模块覆盖机制暴露为 /system/app/<package>/
    ↓
PackageManager 在开机扫描阶段识别为系统路径应用
```

Z Systemizer 不会在用户点击开关时直接修改真实 `/system` 分区。开关操作只是更新模块目录下的文件树和状态文件；真正被系统识别为 `/system/app` 路径应用，需要重启后在系统扫描阶段生效。

## 状态模型

从 v1.1.4 起，模块使用 JSON 状态文件作为系统化意图的唯一权威来源：

```text
/data/adb/modules/ksu-systemizer/state/systemizer-state.json
```

相关目录：

```text
/data/adb/modules/ksu-systemizer/
├── state/
│   ├── systemizer-state.json
│   └── apks/
│       └── <package>/
│           ├── base.apk
│           └── split_*.apk
└── system/
    └── app/
        └── <package>/
            ├── base.apk
            └── split_*.apk
```

状态含义：

| 状态 | 含义 |
| --- | --- |
| `pending_add` | 已写入模块 `system/app`，等待下次开机扫描后生效 |
| `active` | 已完成系统化状态落定 |
| `pending_remove` | 已从模块 `system/app` 移除，等待下次开机后完成移除 |

## 开机与派生配置

模块包含三个脚本：

| 脚本 | 作用 |
| --- | --- |
| `customize.sh` | 安装阶段初始化目录、安装 CLI、迁移新版状态文件并执行安装阶段一致性检查 |
| `post-fs-data.sh` | 开机早期执行轻量 `reconcile --phase post-fs-data`，修复或落定状态 |
| `service.sh` | 系统启动后延迟执行 `refresh-derived`，刷新模块描述和 AOSP 辅助配置 |

动态派生配置包括：

```text
/data/adb/modules/ksu-systemizer/module.prop
/data/adb/modules/ksu-systemizer/system/etc/sysconfig/z-systemizer-aosp-keepalive.xml
```

`module.prop` 的 `description=` 会根据当前状态生成，例如：

```text
Z Systemizer：已系统化 1 个，待系统化 2 个，待移除 0 个；待处理项需重启生效。
```

注意：模块会自动修改 `module.prop` 文件，但 KernelSU 管理器外层模块列表可能会缓存模块信息，不一定在 WebUI 内实时刷新显示。可通过退出模块列表、重新进入 KernelSU 管理器或执行诊断确认文件是否已经同步。

## AOSP 保活辅助说明

Z Systemizer 会根据 `active` 和 `pending_add` 状态生成：

```text
/data/adb/modules/ksu-systemizer/system/etc/sysconfig/z-systemizer-aosp-keepalive.xml
```

该文件会写入 AOSP 支持的 sysconfig 标签：

```xml
<allow-in-power-save package="com.example.app" />
<allow-in-power-save-except-idle package="com.example.app" />
```

这是一种 AOSP 省电策略白名单辅助，用于减少原生 Android 省电模式对相关应用后台行为的限制。它不是常驻服务，不保证防止 LMK 杀进程，也不保证绕过 MIUI、ColorOS、OriginOS 等厂商 ROM 的额外后台管理策略。

## Rust CLI

可用命令：

```sh
systemizer diagnose
systemizer list-user-apps
systemizer list-systemized
systemizer status <package>
systemizer systemize <package> app [--dry-run]
systemizer unsystemize <package>
systemizer state-json
systemizer reconcile --phase <install|post-fs-data|manual>
systemizer refresh-derived
```

兼容命令：

```sh
systemizer refresh-description
```

`refresh-description` 目前作为兼容别名存在，推荐使用 `refresh-derived`。

## 诊断

可以通过以下命令查看模块状态：

```sh
su -c '/data/adb/modules/ksu-systemizer/bin/systemizer diagnose'
```

常见诊断字段：

| 字段 | 含义 |
| --- | --- |
| `state_apps` | 状态文件中记录的应用数量 |
| `state_active` | 已落定为 active 的数量 |
| `state_pending_add` | 等待系统化生效的数量 |
| `state_pending_remove` | 等待移除生效的数量 |
| `cache_missing_count` | 状态中存在但 APK 缓存缺失的数量 |
| `system_app_missing_count` | 状态中存在但 `system/app` 目录缺失的数量 |
| `keepalive_sysconfig_exists` | AOSP 辅助 sysconfig 是否存在 |
| `keepalive_packages` | 当前应写入保活辅助配置的包数量 |
| `module_prop_description_synced` | `module.prop` 文案是否与当前状态一致 |

也可以直接查看模块描述文件：

```sh
su -c 'cat /data/adb/modules/ksu-systemizer/module.prop'
```

## 安装与使用

1. 从 Releases 页面下载 `Z-Systemizer-v1.1.6.zip`
2. 在 KernelSU 管理器中刷入该模块
3. 打开 KernelSU 模块列表
4. 点进 `Z Systemizer` 模块
5. 使用内置 WebUI 管理应用
6. 对应用执行系统化或移除后，根据提示重启设备

不需要安装 APK。

## 旧版升级说明

从较旧版本升级时，模块会尝试迁移新版状态文件、APK 缓存和 `system/app` 文件树。迁移目标包括：

```text
state/systemizer-state.json
state/systemizer-state.json.bak
state/apks/
system/app/
```

不会迁移旧版 `module.prop`。如果旧版升级后出现模块描述未同步、状态显示异常或派生配置未更新，可尝试：

```sh
su -c '/data/adb/modules/ksu-systemizer/bin/systemizer refresh-derived'
su -c '/data/adb/modules/ksu-systemizer/bin/systemizer diagnose'
```

如果旧版升级路径仍然异常，完全卸载旧模块后重新安装当前版本可以获得干净状态。

## 构建说明

### 构建 Rust CLI

```sh
rustup target add aarch64-linux-android
cargo install cargo-ndk
cd cli
cargo ndk -t arm64-v8a build --release
```

### 构建 WebUI

```sh
cd webui
npm ci
npm run build
```

构建产物会输出到模块 `webroot` 使用的静态资源目录。

### 打包 KernelSU 模块

```sh
mkdir -p module-template/bin/arm64-v8a
cp cli/target/aarch64-linux-android/release/systemizer module-template/bin/arm64-v8a/systemizer
cd module-template
zip -r ../out/Z-Systemizer-v1.1.6.zip .
```

发布包应只包含 KernelSU 模块文件，不应包含 APK、`node_modules` 或 `system/priv-app`。

## 安全说明

本项目只管理模块目录下的文件，不直接修改真实系统分区。主要写入位置：

```text
/data/adb/modules/ksu-systemizer/state/
/data/adb/modules/ksu-systemizer/system/app/
/data/adb/modules/ksu-systemizer/system/etc/sysconfig/
/data/adb/modules/ksu-systemizer/module.prop
```

所有系统化变更都依赖 KernelSU 模块覆盖机制和下次开机扫描生效。

## 目录结构

```text
.
├── cli/                    # Rust CLI
├── webui/                  # KernelSU WebUI 源码
├── module-template/        # KernelSU 模块模板
│   ├── bin/                # CLI 二进制安装目录
│   ├── checksums/          # 校验相关文件目录
│   ├── state/              # 安装后状态目录
│   ├── system/             # 模块 system 覆盖目录
│   │   ├── app/            # system/app 应用目录
│   │   └── etc/sysconfig/  # AOSP 辅助 sysconfig 目录
│   ├── webroot/            # WebUI 静态文件
│   ├── customize.sh        # 安装脚本
│   ├── post-fs-data.sh     # 开机早期一致性脚本
│   ├── service.sh          # 开机后派生配置刷新脚本
│   └── module.prop         # KernelSU 模块元数据
├── docs/                   # 文档
└── .github/workflows/      # CI/CD
```
