# Changelog

## v1.2.6

### Changed
- **保活与系统化合并为一条命令**：`keepalive <pkg> on` 对已系统化应用一步完成「保活生效 + 当场摘除 `system/app` 目录 + 标记 `pending_remove`」，WebUI 不再连发两条命令，消除中途失败留下的不一致中间态。
- **统计口径统一为物理事实**：叠加态（已保活 + 待移除系统化）同时计入「已处理」与「待重启」，`module.prop` 描述与 WebUI 概览读数完全一致。
- **`priv-app` 彻底下线**：`validate_target` 仅接受 `app`；`reconcile` 将历史 `priv-app` 记录迁移为纯保活或清除，不再生成空的 `system/priv-app` 目录。

### Fixed
- 修复 WebUI 读取 `state-json` 失败时静默退化为空状态、把已系统化/已保活应用全显示成「未处理」的问题；现在读取失败会明确报错并保留上次列表。
- 修复 WebUI 为取保活集合重复执行一次 `state-json`、两次读取之间状态被改写就拼出脏视图的问题（改为单次读取派生）。
- 修复快速甩动下拉刷新后松手可能丢失刷新（`touchend` 取消了尚未执行的动画帧，读到旧位移）。
- 修复连续点两次开关时第二次确认框被静默当作「取消」、动作凭空丢失的问题（改为排队）。
- 修复图标「重新加载」后上一轮超时定时器仍在计时、新加载的图标直接变灰的问题。
- 修复「关于」在读取模块信息失败时显示硬编码版本号的问题。
- 修复 `diagnose` 的 `deviceidle` 白名单比对（改为整列精确匹配，避免子串误判）及残留 `priv-app` 检查项。
- 状态写入新增 `systemizer-state.lock` 互斥，避免 WebUI 与开机 `reconcile` 并发写坏状态文件；目录替换改为原子 rename 并带回滚。
- 修复 `module.prop` 与 sysconfig XML 先 rename 后改权限导致的可读性窗口。
- 版本号提升至 `v1.2.6`（`versionCode=126`）。

## v1.2.5

### Added
- **WebUI 模块化重构**：前端拆分为 `types` / `stateMachine` / `api` / `icons` / `dialogs` / `main` 六个高内聚模块，`state.ts` 保留兼容垫片。
- **纯函数状态机**：实际态与意图态的双维度流转抽离为无 DOM 依赖的纯函数，并新增 36 项 `node --test` 单元测试。
- **FLIP 过渡动画**：分类切换与开关重排改用 FLIP，列表改为节点复用差分更新，长列表不再卡顿。
- **双开 / 多用户去重**：`getApps()` 按包名去重，避免卡片互相覆盖与概览计数翻倍。
- **离线预览**：新增 `npm run preview:mock` 与 `webui/preview` 模拟数据。

### Changed
- 模块 `description` 文案统一为「已处理 N 个（系统化 X 个，保活 Y 个；待系统化 A 个，待移除 B 个，需重启生效）」，与 README、WebUI 概览口径一致。
- 版本号提升至 `v1.2.5`（`versionCode=125`）。

### Fixed
- 修复 WebUI 源码相对导入缺少 `.ts` 后缀、导致单元测试无法运行的问题。

## v1.2.0

### Added
- **底层架构**：实现运行时内核状态同步 (Fail-Soft)，变更状态现自动同步至 `deviceidle` 白名单与 `standby bucket`。
- **构建防线**：强化 AOSP Sysconfig 规则生成，严密放行保活标签。
- **深度诊断**：`diagnose` 指令现支持展示内核休眠桶与白名单真实状态对比。

### Fixed
- **UI/UX 质感**：重做前端动画组件，新增平滑顶部展开及过滤收缩过渡效果。
- **细节打磨**：去除触控高亮蓝框、去除应用二次高危弹窗，增加下拉回弹，消除 UI 阻塞。
- **状态固化**：记住用户“仅看系统化”配置并修复相关刷新异常跳动问题。
- **关于界面**：在 WebUI “关于”菜单中新增了 GitHub 仓库的直达链接。
## v1.1.5

### Fixed
- 优化了 WebUI 界面在刷新失败时的状态展示，避免同时显示旧列表与空状态错误提示
- 优化了图标加载策略，防止超时图标在稍后成功加载时被忽略，并防止重复的 IntersectionObserver 观察与重复加载
- 将菜单文案从“清除图标缓存”修正为“重新加载图标”
- 修复了 Busy Switch 状态下使用透明度的问题，实现完全的不透明交互状态
- 优化了下拉菜单项的背景底色

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
