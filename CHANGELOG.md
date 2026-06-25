# Changelog

## v1.1.4

### Added
- 新增 `state/systemizer-state.json` 持久状态文件作为系统化意图唯一权威来源 (SSOT)
- 新增 `state/apks` 独立 APK 缓存机制，摆脱重启时对 `pm` 的依赖
- 新增 `post-fs-data.sh` 开机前一致性校验 (Reconcile)，彻底杜绝目录损坏导致的开机还原
- 增加 `systemizer state-json` 和 `systemizer reconcile` 命令
- WebUI 增加独立诊断报告弹窗，自动计算置顶排队优先级

### Fixed
- 彻底解决后续版本升级丢失系统化列表的问题
- 修复刷新后启用项不自动置顶的问题
- 解决极端断电或升级可能导致的配置、UI 状态与物理文件树不同步问题

### Notes
- 从 v1.1.4 开始，后续升级会自动迁移 JSON 状态、APK 缓存和 system/app 文件树。v1.1.4 升级脚本不会自动吸收早于此版本的旧版悬空系统化应用。
## v1.1.3

### Fixed
- 修复 `app.systemized` 状态突变导致的一系列 UI 计数错误与逻辑不一致问题
- 彻底隔离 UI `pending` 状态与底层磁盘状态，保证严格遵循用户操作意图
- 优化 `refresh` 操作，不再覆盖前端进行中的 pending 状态

## v1.1.2

### Changed
- 完全重构 WebUI 架构，迁移至 Vite + TypeScript + SCSS 现代构建体系
- 采用全新的 Miuix 风格独立胶囊开关交互，废弃复选框和“应用更改”保存逻辑
- 优化了前端渲染性能，引入防抖(Debounce)和卡片级局部 DOM 刷新，避免全量重绘导致的 UI 阻塞

### Added
- 新增“更多”下拉菜单，集成“仅显示已系统化”、“诊断信息”和“关于”选项
- UI 交互增加各种 Miuix 风格的平滑过渡动画和锁定期视觉反馈

### Fixed
- 修复 Rust CLI 中临时目录硬编码导致的潜在并发覆盖文件损坏问题 (采用 PID 隔离)
- 修复 WebUI 操作弹窗时，应用状态未被及时锁定导致的重复点击漏洞

## v1.1.1

### Fixed
- 修复模块安装脚本在实机上报 error code 1 的问题
- 移除安装阶段的 checksum 强制校验，避免设备端兼容性问题
- 移除对 webroot 目录的权限设置，由 KernelSU 自动管理
- 移除 set -eu，使用更保守的错误处理
- module.description 改为中文
- Release workflow 增加 Android NDK 安装

## v1.1.0

### Changed
- Removed Android APK manager UI
- Replaced APK UI with KernelSU WebUI
- Removed AGP/Kotlin/Compose/Miuix build chain
- Release no longer requires Android SDK or APK signing

### Added
- WebUI manager under `webroot/`
- WebUI actions for Refresh, SYS, Unlock, Remove, and Diagnose
- Offline WebUI assets
- Release package verification to ensure no APK or priv-app path is included

### Notes
- Only `system/app` is supported
- `priv-app` remains intentionally unsupported
- Reboot is required after systemizing or unsystemizing apps

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
- System app conversion tool (system/app-only)
- User app listing
- App search
- Processed app auto-sort
- system/app lock protection (Unlock → Remove)
- Rust CLI full control chain

### Security
- Disabled priv-app
- No /system partition modification
- No vendor / ROM policy modification
- No system_server hook
- No resident service

### Improvements
- Root execution IO thread isolation
- CLI output structure optimization
- Split APK support

### Build
- Android + Rust + KSU module unified build pipeline (CI ready)
