## v1.1.1

### Fixed
- 修复模块安装脚本在实机上报 error code 1 的问题
- 移除安装阶段的 checksum 强制校验，避免设备端兼容性问题
- 移除对 webroot 目录的权限设置，由 KernelSU 自动管理
- 移除 set -eu，使用更保守的错误处理
- module.description 改为中文
- Release workflow 增加 Android NDK 安装
