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
