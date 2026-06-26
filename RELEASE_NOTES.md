## v1.1.6

### Changed
- `api.ts` 改用 `refresh-derived` 替代 `refresh-description`
- 卡片展开高度从 104px 调整为 160px
- 首屏图标预热时间从 650ms 调整为 900ms

### Fixed
- 修复 CI 中 `.hidden` / `.empty-state` grep 转义错误
- 移除不确定的 `allow-in-data-usage-save` sysconfig 标签，仅保留 AOSP 明确支持的标签
- 增强 `diagnose` 命令输出 module.prop description 同步状态
- 重置图标时清理 `img.onload` / `img.onerror` 避免旧处理器干扰
- cargo fmt 格式修复

### Added
- CI 增加 `allow-in-data-usage-save` 禁用检查
- CI 增加 WebUI 使用 `refresh-derived` 检查
- `diagnose` 新增 `module_prop_description_synced` 字段
