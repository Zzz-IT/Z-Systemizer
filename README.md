# Z Systemizer

Z Systemizer 是一个面向 KernelSU 环境的 system/app 管理工具。它通过 KernelSU WebUI 和 Rust CLI 协同工作，将用户选择的已安装应用复制到模块目录中的 `system/app` 树下，并在重启后交由兼容的系统覆盖模块生效。

本项目当前明确只支持 `system/app`，不支持 `priv-app`。

## 功能特性

- KernelSU WebUI 管理界面
- 列出已安装的用户应用
- 搜索应用包名
- 已处理应用自动置顶
- 将指定应用复制到模块目录的 `system/app/<package>/`
- 支持 split APK：会复制 `pm path` 返回的所有 APK 文件
- 支持取消处理，删除模块目录中的对应应用目录
- 已处理应用带锁保护：需要先 `Unlock`，再 `Remove`，避免误删
- Rust CLI 提供诊断、状态查询、用户应用列表和已处理列表

## 当前限制

- 仅支持 `system/app`
- 不支持 `priv-app`
- 不写入真实 `/system` 分区
- 不修改 vendor、ROM 电池策略数据库或厂商私有配置
- 不 hook `system_server`
- 不运行常驻保活服务
- 当前仅提供 `arm64-v8a` Rust CLI 二进制安装路径

## 工作原理

```text
KernelSU WebUI (webroot/)
    ↓
KernelSU exec API
    ↓
Rust systemizer CLI
    ↓
/data/adb/modules/ksu-systemizer/system/app/<package>/
    ↓
重启后由兼容的 KernelSU 覆盖模块接管
```

## Rust CLI

可用命令：

```sh
systemizer diagnose
systemizer list-user-apps
systemizer list-systemized
systemizer status <package>
systemizer systemize <package> app [--dry-run]
systemizer unsystemize <package>
```

## 安装与使用

1. 下载 `Z-Systemizer-v1.1.0.zip`
2. 在 KernelSU 管理器中刷入该模块
3. 打开 KernelSU 模块列表
4. 点进 `Z Systemizer` 模块
5. 使用内置 WebUI 管理应用

不需要安装 APK。

## 构建说明

### 构建 Rust CLI

```sh
rustup target add aarch64-linux-android
cargo install cargo-ndk
cd cli
cargo ndk -t arm64-v8a build --release
```

### 打包 KernelSU 模块

```sh
mkdir -p module-template/bin/arm64-v8a
cp cli/target/aarch64-linux-android/release/systemizer module-template/bin/arm64-v8a/systemizer
cd module-template
zip -r ../out/Z-Systemizer-v1.1.0.zip .
```

## 安全说明

本项目只管理模块目录下的文件，不直接修改真实系统分区。所有变更都位于：

```text
/data/adb/modules/ksu-systemizer/system/app/
```

## 目录结构

```text
.
├── cli/                 # Rust CLI
├── module-template/     # KernelSU 模块模板
│   ├── webroot/         # WebUI 文件
│   ├── bin/             # CLI 二进制
│   └── system/app/      # system/app 目录
├── docs/                # 文档
└── .github/workflows/   # CI/CD
```
