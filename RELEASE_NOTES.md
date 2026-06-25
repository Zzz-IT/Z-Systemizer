## v1.1.3

### Fixed
- 修复 `app.systemized` 状态突变导致的一系列 UI 计数错误与逻辑不一致问题
- 彻底隔离 UI `pending` 状态与底层磁盘状态，保证严格遵循用户操作意图
- 优化 `refresh` 操作，不再覆盖前端进行中的 pending 状态
