# Z-Systemizer v1.2.6

> 适用于 KernelSU / Magisk。刷入 `Z-Systemizer-v1.2.6.zip` 后重启，在模块 WebUI 中管理应用。

### 保活与系统化语义修正
- **一条命令完成迁移**：`keepalive <pkg> on` 对已系统化应用一步完成「保活生效 + 当场摘除 `system/app` 目录 + 标记待移除」，WebUI 不再连发两条命令，中途失败不会再留下半系统化半保活的中间态。
- **统计口径统一为物理事实**：叠加态（已保活 + 待移除系统化）同时计入「已处理」与「待重启」，`module.prop` 描述与 WebUI 概览读数完全一致。
- **`priv-app` 彻底下线**：`validate_target` 仅接受 `app`，历史 `priv-app` 记录在 `reconcile` 中迁移为纯保活或清除，不再生成空的 `system/priv-app` 目录。

### WebUI 重构（含 v1.2.5 内容）
- **模块化拆分**：前端拆为 `types` / `stateMachine` / `api` / `icons` / `dialogs` / `main`，实际态与意图态的双维度流转抽离为无 DOM 依赖的纯函数，配套 36 项 `node --test` 单元测试。
- **FLIP 过渡与差分更新**：分类切换、开关重排改用 FLIP，列表节点复用差分更新，长列表不再卡顿。
- **双开 / 多用户去重**：`getApps()` 按包名去重，卡片不再互相覆盖，概览计数不再翻倍。
- **离线预览**：新增 `npm run preview:mock`，用模拟数据在浏览器里调试界面。

### 修复
- 读取 `state-json` 失败时不再静默退化为空状态、把已系统化 / 已保活应用全显示成「未处理」；现在明确报错并保留上次列表。
- 保活集合改为单次 `state-json` 派生，消除两次读取之间状态被改写导致的脏视图。
- 快速甩动下拉刷新后松手不再丢失刷新（`touchend` 曾取消尚未执行的动画帧）。
- 连续点两次开关时第二次确认框不再被当作「取消」而静默丢动作（改为排队）。
- 图标「重新加载」后上一轮超时定时器不再残留、新图标不会直接变灰。
- 「关于」在读取模块信息失败时不再显示硬编码版本号。
- `diagnose` 的 `deviceidle` 白名单比对改为整列精确匹配，避免子串误判；移除残留的 `priv-app` 检查项。
- 状态写入新增 `systemizer-state.lock` 互斥（30s 超时、60s 判陈旧），避免 WebUI 与开机 `reconcile` 并发写坏状态文件；目录替换改为原子 rename 并带回滚。
- 修复 `module.prop` 与 sysconfig XML 先 rename 后改权限导致的可读性窗口。

### 升级说明
- 覆盖刷入即可，状态文件、APK 缓存与 `system/app` 文件树自动沿用。
- 本版仅提供 `arm64-v8a`。
