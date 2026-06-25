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
