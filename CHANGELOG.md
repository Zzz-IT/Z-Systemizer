# Changelog

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
