## v1.1.6

### Fixed
- 修复 CI 中 WebUI grep 转义问题
- 移除不确定的 `allow-in-data-usage-save` sysconfig 标签
- 增强 `diagnose` 输出 module.prop description 同步状态
- WebUI 改用 `refresh-derived` 命令
- 调整卡片展开高度 160px，避免长名称裁剪
- 首屏图标预热时间调整为 900ms
- 重置图标时清理 img onload/onerror 避免旧处理器干扰
- cargo fmt 格式修复
