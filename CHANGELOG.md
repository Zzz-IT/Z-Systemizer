# Changelog

## v1.0.0

### ✨ Features
- System app 转换工具（system/app-only）
- 支持用户应用列表获取
- 支持应用搜索
- 已处理应用自动置顶
- system/app 锁保护（Unlock → Remove）
- Rust CLI 完整控制链路

### 🔒 Security
- 禁用 priv-app
- 不修改 /system 分区
- 不修改 vendor / ROM 策略
- 不 hook system_server
- 不运行常驻服务

### ⚙️ Improvements
- Root 执行 IO 线程隔离
- CLI 输出结构优化
- split APK 支持

### 📦 Build
- Android + Rust + KSU module unified build pipeline (CI ready)
