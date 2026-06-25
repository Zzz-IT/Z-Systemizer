# Changelog

## v1.0.1

### Added
- KernelSU module now embeds the signed manager APK under `system/app`
- Users only need to flash the module zip; manual APK installation is no longer required
- Added SHA-256 checksums for module payload files
- Added signed release APK build pipeline

### Changed
- Release artifact is now a self-contained KernelSU module zip
- Manager APK is installed systemlessly as a system app after reboot
- Upgraded build stack to AGP 9.2.1, Kotlin 2.4.0, Gradle 9.6.0

## v1.0.0

### Features
- System app 转换工具（system/app-only）
- 支持用户应用列表获取
- 支持应用搜索
- 已处理应用自动置顶
- system/app 锁保护（Unlock → Remove）
- Rust CLI 完整控制链路

### Security
- 禁用 priv-app
- 不修改 /system 分区
- 不修改 vendor / ROM 策略
- 不 hook system_server
- 不运行常驻服务

### Improvements
- Root 执行 IO 线程隔离
- CLI 输出结构优化
- split APK 支持

### Build
- Android + Rust + KSU module unified build pipeline (CI ready)
