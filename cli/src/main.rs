use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{exit, id, Command};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

const DEFAULT_MODDIR: &str = "/data/adb/modules/ksu-systemizer";
const TARGET_APP: &str = "app";
const TARGET_PRIV: &str = "priv-app";
const TARGET_KEEPALIVE: &str = "keepalive";

#[derive(Clone, Copy)]
enum ApplyMode {
    WebUi,
    Install,
    Manual,
    PostFsData,
}

// 只写 allow-in-power-save。
// AOSP 中 mPowerSaveWhitelistAppsExceptIdle 是 mPowerSaveWhitelistApps 的超集，
// 写入 allow-in-power-save（完全豁免）已隐含 except-idle 的豁免效果，
// 同时写两个标签是冗余的。
const KEEPALIVE_TAGS: &[&str] = &["allow-in-power-save"];

type KeepaliveEntry = (String, String);

fn moddir() -> PathBuf {
    env::var("SYSTEMIZER_MODDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(DEFAULT_MODDIR))
}

fn current_time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn get_boot_id() -> String {
    fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown_boot_id".to_string())
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum AppStatus {
    Active,
    PendingAdd,
    PendingRemove,
}

#[derive(Serialize, Deserialize, Clone)]
struct AppRecord {
    package: String,
    target: String,
    status: AppStatus,
    #[serde(rename = "createdAt")]
    created_at: u64,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
    #[serde(rename = "pendingBootId")]
    pending_boot_id: Option<String>,
    #[serde(default, rename = "keepaliveOnly")]
    keepalive_only: bool,
}

#[derive(Serialize, Deserialize, Clone)]
struct StateFile {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    #[serde(rename = "moduleId")]
    module_id: String,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
    #[serde(rename = "bootId")]
    boot_id: String,
    apps: BTreeMap<String, AppRecord>,
}

impl Default for StateFile {
    fn default() -> Self {
        Self {
            schema_version: 2,
            module_id: "ksu-systemizer".to_string(),
            updated_at: current_time(),
            boot_id: get_boot_id(),
            apps: BTreeMap::new(),
        }
    }
}

fn state_file_path() -> PathBuf {
    moddir().join("state").join("systemizer-state.json")
}

fn module_prop_path() -> PathBuf {
    moddir().join("module.prop")
}

fn sysconfig_dir() -> PathBuf {
    moddir().join("system").join("etc").join("sysconfig")
}

fn keepalive_sysconfig_path() -> PathBuf {
    sysconfig_dir().join("z-systemizer-aosp-keepalive.xml")
}

fn read_state() -> Result<StateFile, String> {
    let path = state_file_path();

    if !path.exists() {
        return Ok(StateFile::default());
    }

    let data =
        fs::read_to_string(&path).map_err(|e| format!("failed to read state file: {}", e))?;

    match serde_json::from_str::<StateFile>(&data) {
        Ok(mut state) => {
            // 向后兼容：旧 schema v1 没有 keepaliveOnly 字段
            if state.schema_version < 2 {
                state.schema_version = 2;
                for record in state.apps.values_mut() {
                    if record.keepalive_only {
                        record.target = TARGET_KEEPALIVE.to_string();
                    }
                }
            }
            Ok(state)
        }
        Err(primary_err) => {
            let bak = path.with_extension("json.bak");

            if !bak.exists() {
                return Err(format!("failed to parse state json: {}", primary_err));
            }

            let bak_data = fs::read_to_string(&bak)
                .map_err(|e| format!("failed to read state backup: {}", e))?;

            let state: StateFile = serde_json::from_str(&bak_data).map_err(|backup_err| {
                format!(
                    "failed to parse state json: {}; backup also failed: {}",
                    primary_err, backup_err
                )
            })?;

            let _ = fs::write(&path, bak_data);
            let _ = set_file_perm(&path, 0o644);

            Ok(state)
        }
    }
}

fn write_state_atomic(state: &mut StateFile) -> Result<(), String> {
    state.updated_at = current_time();

    let path = state_file_path();
    let tmp = path.with_extension(format!("json.{}.tmp", id()));
    let bak = path.with_extension("json.bak");

    let state_dir = path.parent().unwrap();
    if !state_dir.exists() {
        create_dir(state_dir)?;
    }

    if path.exists() {
        if let Ok(data) = fs::read_to_string(&path) {
            if serde_json::from_str::<StateFile>(&data).is_ok() {
                let _ = fs::copy(&path, &bak);
                let _ = set_file_perm(&bak, 0o644);
            }
        }
    }

    let data =
        serde_json::to_vec_pretty(state).map_err(|e| format!("serialize state failed: {}", e))?;

    fs::write(&tmp, data).map_err(|e| format!("write state tmp failed: {}", e))?;

    fs::rename(&tmp, &path).map_err(|e| format!("rename state tmp failed: {}", e))?;

    set_file_perm(&path, 0o644)?;

    Ok(())
}

fn is_valid_pkg(pkg: &str) -> bool {
    !pkg.is_empty()
        && pkg.len() <= 255
        && pkg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
        && !pkg.starts_with('.')
        && !pkg.ends_with('.')
        && !pkg.contains("..")
}

fn safe_pkg(pkg: &str) -> Result<String, String> {
    if is_valid_pkg(pkg) {
        Ok(pkg.to_string())
    } else {
        Err(format!("invalid package name: {}", pkg))
    }
}

fn validate_target(target: &str) -> Result<&str, String> {
    match target {
        TARGET_APP => Ok(TARGET_APP),
        TARGET_KEEPALIVE => Ok(TARGET_KEEPALIVE),
        // priv-app 目录已不再使用（README 同样声明不支持），
        // 入口一并关闭，避免 CLI 仍能写入本模块不会挂载的 /system/priv-app。
        _ => Err("only system/app and keepalive are supported".to_string()),
    }
}

fn run_command(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run {}: {}", program, e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

fn pm_path(pkg: &str) -> Result<Vec<PathBuf>, String> {
    let out = run_command("pm", &["path", pkg])?;
    let apks: Vec<PathBuf> = out
        .lines()
        .map(str::trim)
        .filter_map(|line| line.strip_prefix("package:"))
        .filter(|path| path.ends_with(".apk"))
        .map(PathBuf::from)
        .collect();

    if apks.is_empty() {
        Err(format!("no apk paths found for {}", pkg))
    } else {
        Ok(apks)
    }
}

// `pm path` 的结果是否落在 system 分区。
// 只接受 .../system/app/... 与 .../system/priv-app/... 两种形态；
// 用 windows(2) 滑动匹配，因此 /system/system/app/... 这类叠加式挂载点同样命中。
fn is_system_apk_path(path: &Path) -> bool {
    let comps: Vec<&str> = path
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();

    comps
        .windows(2)
        .any(|w| w[0] == "system" && (w[1] == "app" || w[1] == "priv-app"))
}

// 返回 Some(true) = PackageManager 认为该包已在 system 分区；
// Some(false) = 已安装但不在 system（或压根没装）；
// None = 探测不可用（pm 不存在 / 执行失败 / 非零退出），调用方必须原样保留待处理状态。
// 这里的 None 语义是刻意设计的：绝不能把「探测失败」当成「已移除」，
// 否则一次受限的 shell 上下文就会把排队中的记录整条删掉。
fn pm_reports_system_apk(pkg: &str) -> Option<bool> {
    let output = Command::new("pm").args(["path", pkg]).output().ok()?;
    if !output.status.success() {
        return None;
    }

    let out = String::from_utf8_lossy(&output.stdout);
    let mut system = false;
    for line in out.lines() {
        let line = line.trim();
        if let Some(p) = line.strip_prefix("package:") {
            if p.ends_with(".apk") && is_system_apk_path(Path::new(p)) {
                system = true;
            }
        }
    }

    Some(system)
}

// 非 unix 平台下 `mode` 与 `mut` 不会被使用，用 cfg_attr 抑制告警，
// 避免在 CI (-D warnings) 下失败；unix 平台行为保持不变。
#[cfg_attr(not(unix), allow(unused_variables, unused_mut))]
fn set_file_perm(path: &Path, mode: u32) -> Result<(), String> {
    let mut perm = fs::metadata(path)
        .map_err(|e| format!("metadata failed for {}: {}", path.display(), e))?
        .permissions();

    #[cfg(unix)]
    perm.set_mode(mode);

    fs::set_permissions(path, perm)
        .map_err(|e| format!("chmod failed for {}: {}", path.display(), e))
}

fn create_dir(path: &Path) -> Result<(), String> {
    if !path.exists() {
        fs::create_dir_all(path)
            .map_err(|e| format!("mkdir failed for {}: {}", path.display(), e))?;
    }
    set_file_perm(path, 0o755)
}

fn sync_dir(src: &Path, dst: &Path, apply_context: bool) -> Result<(), String> {
    if !src.is_dir() {
        return Err(format!("src is not a directory: {}", src.display()));
    }

    let parent = dst.parent().ok_or_else(|| "bad dst".to_string())?;
    create_dir(parent)?;

    let tmp = parent.join(format!(
        ".{}.{}.tmp",
        dst.file_name().unwrap().to_string_lossy(),
        id()
    ));

    let _ = fs::remove_dir_all(&tmp);
    create_dir(&tmp)?;

    for entry in fs::read_dir(src).map_err(|e| format!("read_dir src failed: {}", e))? {
        let entry = entry.map_err(|e| format!("read entry failed: {}", e))?;
        let ty = entry
            .file_type()
            .map_err(|e| format!("file_type failed: {}", e))?;
        if ty.is_file() {
            let filename = entry.file_name();
            let src_file = src.join(&filename);
            let dst_file = tmp.join(&filename);
            fs::copy(&src_file, &dst_file).map_err(|e| format!("copy failed: {}", e))?;
            set_file_perm(&dst_file, 0o644)?;
        }
    }

    let _ = fs::remove_dir_all(dst);
    fs::rename(&tmp, dst).map_err(|e| format!("rename tmp to dst failed: {}", e))?;

    set_file_perm(dst, 0o755)?;

    if apply_context {
        let _ = Command::new("chcon")
            .args([
                "-R",
                "u:object_r:system_file:s0",
                dst.to_string_lossy().as_ref(),
            ])
            .status();
    }

    Ok(())
}

fn systemize(pkg: &str, target: &str, dry_run: bool) -> Result<(), String> {
    let pkg = safe_pkg(pkg)?;
    let target = validate_target(target)?;

    if dry_run {
        println!("dry_run=true\npackage={}\ntarget={}", pkg, target);
        return Ok(());
    }

    if target == TARGET_PRIV {
        println!("warning=priv-app");
    }

    let mut state = read_state()?;

    let root = moddir();
    let apks_dir = root.join("state").join("apks");
    create_dir(&apks_dir)?;

    let pkg_apks_dir = apks_dir.join(&pkg);
    let target_root = root.join("system").join(target);
    create_dir(&target_root)?;

    let app_dir = target_root.join(&pkg);

    if let Some(record) = state.apps.get_mut(&pkg) {
        if record.status == AppStatus::Active && record.target == target && !record.keepalive_only {
            if app_dir.is_dir() {
                println!(
                    "ok=true\npackage={}\ntarget={}\nalready_active=true\nreboot_required=false",
                    pkg, target
                );
                return Ok(());
            }

            if pkg_apks_dir.is_dir() {
                sync_dir(&pkg_apks_dir, &app_dir, true)?;

                record.updated_at = current_time();
                record.pending_boot_id = None;

                write_state_atomic(&mut state)?;
                after_state_changed(&state, ApplyMode::WebUi);

                println!(
                    "ok=true\npackage={}\ntarget={}\nrepaired=true\nreboot_required=false",
                    pkg, target
                );

                return Ok(());
            }
        }

        if record.status == AppStatus::PendingRemove && pkg_apks_dir.is_dir() {
            sync_dir(&pkg_apks_dir, &app_dir, true)?;

            record.status = AppStatus::Active;
            record.target = target.to_string();
            record.keepalive_only = false;
            record.updated_at = current_time();
            record.pending_boot_id = None;

            write_state_atomic(&mut state)?;
            after_state_changed(&state, ApplyMode::WebUi);

            println!(
                "ok=true\npackage={}\ntarget={}\nrestored=true\nreboot_required=false",
                pkg, target
            );

            return Ok(());
        }
    }

    let tmp_apks_dir = apks_dir.join(format!(".{}.{}.tmp", pkg, id()));
    let apks = pm_path(&pkg)?;

    let _ = fs::remove_dir_all(&tmp_apks_dir);
    create_dir(&tmp_apks_dir)?;

    for apk in apks {
        if !apk.is_file() {
            let _ = fs::remove_dir_all(&tmp_apks_dir);
            return Err(format!("apk is not a file: {}", apk.display()));
        }

        let filename = apk
            .file_name()
            .ok_or_else(|| format!("bad apk path: {}", apk.display()))?;

        let dst = tmp_apks_dir.join(filename);
        fs::copy(&apk, &dst).map_err(|e| format!("copy {} failed: {}", apk.display(), e))?;
        set_file_perm(&dst, 0o644)?;
    }

    let _ = fs::remove_dir_all(&pkg_apks_dir);
    fs::rename(&tmp_apks_dir, &pkg_apks_dir)
        .map_err(|e| format!("rename to state/apks/pkg failed: {}", e))?;

    sync_dir(&pkg_apks_dir, &app_dir, true)?;

    let now = current_time();
    let record = state.apps.entry(pkg.clone()).or_insert_with(|| AppRecord {
        package: pkg.clone(),
        target: target.to_string(),
        status: AppStatus::PendingAdd,
        created_at: now,
        updated_at: now,
        pending_boot_id: Some(get_boot_id()),
        keepalive_only: false,
    });

    record.target = target.to_string();
    record.keepalive_only = false;
    record.status = AppStatus::PendingAdd;
    record.updated_at = now;
    record.pending_boot_id = Some(get_boot_id());

    write_state_atomic(&mut state)?;
    after_state_changed(&state, ApplyMode::WebUi);

    println!(
        "ok=true\npackage={}\ntarget={}\nreboot_required=true",
        pkg, target
    );

    Ok(())
}

fn unsystemize(pkg: &str) -> Result<(), String> {
    let pkg = safe_pkg(pkg)?;
    let mut state = read_state()?;

    if let Some(record) = state.apps.get_mut(&pkg) {
        let root = moddir();
        let target_root = root.join("system").join(&record.target);
        let app_dir = target_root.join(&pkg);
        let pkg_apks_dir = root.join("state").join("apks").join(&pkg);

        // 纯保活记录不落盘任何文件，unsystemize 对它只应关闭保活语义，
        // 绝不能标记 pending_remove（那会凭空制造一个不存在的「待移除」任务，
        // 让待重启计数 +1 且永远无法结束）。
        if record.keepalive_only && record.target == TARGET_KEEPALIVE {
            state.apps.remove(&pkg);
            write_state_atomic(&mut state)?;
            after_state_changed(&state, ApplyMode::WebUi);
            println!(
                "ok=true\npackage={}\nremoved=true\nreboot_required=false",
                pkg
            );
            return Ok(());
        }

        match record.status {
            AppStatus::PendingAdd => {
                let _ = fs::remove_dir_all(&app_dir);
                let _ = fs::remove_dir_all(&pkg_apks_dir);

                // 叠加态保护：keepalive_only 记录只是「待系统化」的纯保活白名单，
                // 删掉它等于把用户刚开的保活开关也一并抹除（刷新后开关弹回）。
                // 这里退回纯保活形态，而不是整条记录删除。
                if record.keepalive_only {
                    record.target = TARGET_KEEPALIVE.to_string();
                    record.status = AppStatus::Active;
                    record.pending_boot_id = None;
                    record.updated_at = current_time();
                } else {
                    state.apps.remove(&pkg);
                }
            }
            AppStatus::Active | AppStatus::PendingRemove => {
                let _ = fs::remove_dir_all(&app_dir);
                record.status = AppStatus::PendingRemove;
                record.updated_at = current_time();
                record.pending_boot_id = Some(get_boot_id());
            }
        }

        write_state_atomic(&mut state)?;
        after_state_changed(&state, ApplyMode::WebUi);
        println!(
            "ok=true\npackage={}\nremoved=true\nreboot_required=true",
            pkg
        );
    } else {
        println!("ok=true\npackage={}\nremoved=false", pkg);
    }

    Ok(())
}

fn set_keepalive_only(pkg: &str, enabled: bool) -> Result<(), String> {
    let pkg = safe_pkg(pkg)?;
    let mut state = read_state()?;

    if enabled {
        let root = moddir();
        let app_dir = root.join("system").join(TARGET_APP).join(&pkg);
        let priv_dir = root.join("system").join(TARGET_PRIV).join(&pkg);

        let now = current_time();

        // 判定「原本是否已系统化」：只有已生效在 system/app|priv-app 的记录，
        // 开保活才构成「转为仅保活」的叠加态；普通应用直接就是纯保活。
        let was_systemized = state
            .apps
            .get(&pkg)
            .map(|r| {
                !r.keepalive_only && r.status == AppStatus::Active && r.target != TARGET_KEEPALIVE
            })
            .unwrap_or(false);

        // 已系统化 → 物理目录此刻就要摘掉，重启后 overlay 不再挂载该应用。
        // 普通应用 → 本来就是 /data/app，无需触碰文件系统。
        if was_systemized {
            let _ = fs::remove_dir_all(&app_dir);
            let _ = fs::remove_dir_all(&priv_dir);
            // 保留 APK 缓存，方便用户切回
        }

        let record = state.apps.entry(pkg.clone()).or_insert_with(|| AppRecord {
            package: pkg.clone(),
            target: TARGET_KEEPALIVE.to_string(),
            status: AppStatus::Active,
            created_at: now,
            updated_at: now,
            pending_boot_id: None,
            keepalive_only: true,
        });

        record.keepalive_only = true;
        record.updated_at = now;

        if was_systemized {
            // 叠加态：保活即时生效（keepalive_only=true），
            // 同时保留「重启后把该应用移出系统分区」的意图。
            // target 必须留在原类别（app/priv-app），否则 reconcile 找不到待清理目录。
            record.status = AppStatus::PendingRemove;
            record.pending_boot_id = Some(get_boot_id());
        } else if record.target != TARGET_KEEPALIVE {
            // 兜底：非纯保活目标且未系统化（如缓存残留），归一为纯保活。
            record.target = TARGET_KEEPALIVE.to_string();
            record.status = AppStatus::Active;
            record.pending_boot_id = None;
        }

        let reboot_required = record.status == AppStatus::PendingRemove;

        write_state_atomic(&mut state)?;
        after_state_changed(&state, ApplyMode::WebUi);

        println!(
            "ok=true\npackage={}\nkeepalive_only=true\nreboot_required={}",
            pkg, reboot_required
        );
    } else {
        let mut changed = false;

        if let Some(record) = state.apps.get_mut(&pkg) {
            if record.keepalive_only {
                record.keepalive_only = false;
                record.updated_at = current_time();

                // 只有「纯保活」才允许连同记录一起删除：它不落盘任何文件，
                // 删除等同于关闭保活。
                // 若记录还带着 PendingRemove（叠加态回退），
                // 删除会把排队中的 system/app 清理任务一并吞掉，
                // 待重启计数凭空 -1，必须保留。
                if record.status != AppStatus::PendingRemove {
                    state.apps.remove(&pkg);
                }
                changed = true;
            }
        }

        if changed {
            write_state_atomic(&mut state)?;
            after_state_changed(&state, ApplyMode::WebUi);
        }

        println!(
            "ok=true\npackage={}\nkeepalive_only=false\nreboot_required=false",
            pkg
        );
    }

    Ok(())
}

fn list_user_apps() -> Result<(), String> {
    let out = run_command("pm", &["list", "packages", "-3"])?;
    for line in out.lines() {
        if let Some(pkg) = line.trim().strip_prefix("package:") {
            println!("{}", pkg);
        }
    }
    Ok(())
}

const MAX_POST_FS_REPAIRS: usize = 3;

fn validate_phase(phase: &str) -> Result<&str, String> {
    match phase {
        "install" | "post-fs-data" | "manual" => Ok(phase),
        _ => Err(format!("invalid reconcile phase: {}", phase)),
    }
}

fn reconcile(phase: &str) -> Result<(), String> {
    let mut state = read_state()?;
    let boot_id = get_boot_id();

    let root = moddir();
    let apks_root = root.join("state").join("apks");

    create_dir(&root.join("system").join(TARGET_APP))?;
    create_dir(&root.join("system").join(TARGET_PRIV))?;
    create_dir(&apks_root)?;

    let mut keys_to_remove = Vec::new();
    let mut changed = false;
    let mut repairs = 0usize;

    let apply_context = phase != "post-fs-data";

    for (pkg, record) in state.apps.iter_mut() {
        let target_root = root.join("system").join(&record.target);
        let app_dir = target_root.join(pkg);
        let pkg_apks_dir = apks_root.join(pkg);

        // 纯保活的「待系统化」转正：与文件系统路由解耦，独立判定。
        // 纯保活不落盘任何文件，所以只要跨过一次开机就直接转正，
        // 不必等文件系统对账（它本来就没有系统目录）。
        if record.keepalive_only
            && record.status == AppStatus::PendingAdd
            && phase == "post-fs-data"
            && record.pending_boot_id.as_deref() != Some(&boot_id)
        {
            record.status = AppStatus::Active;
            record.updated_at = current_time();
            record.pending_boot_id = None;
            changed = true;
        }

        // 文件系统路由：只有「纯保活」需要跳过对账。
        // 叠加态（keepalive_only=true 但 target 仍是 app/priv-app）必须放行，
        // 让它跌入 PendingRemove 分支完成 system/<target>/<pkg> 的物理清理。
        if record.keepalive_only && record.target == TARGET_KEEPALIVE {
            continue;
        }

        match record.status {
            AppStatus::Active => {
                if !app_dir.is_dir() {
                    if pkg_apks_dir.is_dir() {
                        if phase == "post-fs-data" && repairs >= MAX_POST_FS_REPAIRS {
                            continue;
                        }

                        sync_dir(&pkg_apks_dir, &app_dir, apply_context)?;
                        repairs += 1;
                        changed = true;
                    } else if phase == "manual" {
                        keys_to_remove.push(pkg.clone());
                        changed = true;
                    } else {
                        continue;
                    }
                }
            }

            AppStatus::PendingAdd => {
                if phase == "post-fs-data" {
                    if record.pending_boot_id.as_deref() != Some(&boot_id) {
                        if !app_dir.is_dir() {
                            if pkg_apks_dir.is_dir() {
                                if repairs >= MAX_POST_FS_REPAIRS {
                                    continue;
                                }

                                sync_dir(&pkg_apks_dir, &app_dir, apply_context)?;
                                repairs += 1;
                            } else {
                                continue;
                            }
                        }

                        record.status = AppStatus::Active;
                        record.updated_at = current_time();
                        record.pending_boot_id = None;
                        changed = true;
                    }
                } else if !app_dir.is_dir() && pkg_apks_dir.is_dir() {
                    sync_dir(&pkg_apks_dir, &app_dir, apply_context)?;
                    changed = true;
                }
            }

            AppStatus::PendingRemove => {
                if phase == "post-fs-data" {
                    if record.pending_boot_id.as_deref() != Some(&boot_id) {
                        let _ = fs::remove_dir_all(&app_dir);
                        let _ = fs::remove_dir_all(&pkg_apks_dir);

                        // 叠加态收尾：系统目录已清理完毕，
                        // 记录必须保留并蜕变为「纯保活」——
                        // 若直接 push 进 keys_to_remove，
                        // 用户刚开的保活开关会在开机后被一并注销。
                        if record.keepalive_only {
                            record.target = TARGET_KEEPALIVE.to_string();
                            record.status = AppStatus::Active;
                            record.pending_boot_id = None;
                            record.updated_at = current_time();
                        } else {
                            keys_to_remove.push(pkg.clone());
                        }
                        changed = true;
                    } else {
                        if app_dir.is_dir() {
                            let _ = fs::remove_dir_all(&app_dir);
                            changed = true;
                        }
                    }
                } else {
                    if app_dir.is_dir() {
                        let _ = fs::remove_dir_all(&app_dir);
                        changed = true;
                    }
                }
            }
        }
    }

    for pkg in keys_to_remove {
        state.apps.remove(&pkg);
    }

    if changed || state.boot_id != boot_id {
        state.boot_id = boot_id;
        write_state_atomic(&mut state)?;
    }

    let mode = match phase {
        "manual" => ApplyMode::Manual,
        "install" => ApplyMode::Install,
        _ => ApplyMode::PostFsData,
    };
    if phase != "post-fs-data" {
        after_state_changed(&state, mode);
        println!("reconcile phase={} completed.", phase);
    }

    Ok(())
}

use std::collections::BTreeSet;

// 需要运行时保活（deviceidle / appops / standby bucket）的包。
// 覆盖：所有非 pending_remove 的记录。
fn expected_keepalive_packages(state: &StateFile) -> Vec<String> {
    let mut packages: Vec<String> = state
        .apps
        .values()
        // PendingRemove 通常意味着「正在被移除，应解除保活」。
        // 但叠加态（keepalive_only=true 且 PendingRemove）是「移出系统分区、
        // 但用户明确要求继续保活」，保活意图必须继续成立，否则用户刚打开的
        // 开关会在同一次 after_state_changed 里被下面的解除循环立刻撤销。
        .filter(|r| r.status != AppStatus::PendingRemove || r.keepalive_only)
        .map(|r| r.package.clone())
        .collect();

    packages.sort();
    packages.dedup();
    packages
}

// 需要在 deviceidle / appops 上「解除保活」的包。
//
// 与 expected_keepalive_packages 严格互补：只有真正在移除、且用户没有要求
// 保活的记录才解除。叠加态记录虽排队等待移出系统分区，但保活意图依然有效。
fn keepalive_teardown_packages(state: &StateFile) -> Vec<String> {
    let mut packages: Vec<String> = state
        .apps
        .values()
        .filter(|r| r.status == AppStatus::PendingRemove && !r.keepalive_only)
        .map(|r| r.package.clone())
        .collect();

    packages.sort();
    packages.dedup();
    packages
}

// 需要写入 AOSP sysconfig 的包。
//
// 重要：sysconfig 的 allow-in-power-save 由 DeviceIdleController 在开机时解析，
// 解析时用 pm.getApplicationInfo(pkg, MATCH_SYSTEM_ONLY)，即「只匹配系统应用」。
// keepaliveOnly 的包仍安装在 /data/app（不是系统应用），写入 sysconfig 会在
// 开机解析时被静默跳过，属于死条目。因此这里只收录真正已系统化
// （target=app|priv-app 且 active|pending_add）的包。
fn expected_sysconfig_packages(state: &StateFile) -> Vec<String> {
    let mut packages: Vec<String> = state
        .apps
        .values()
        .filter(|r| {
            !r.keepalive_only
                && (r.status == AppStatus::Active || r.status == AppStatus::PendingAdd)
        })
        .map(|r| r.package.clone())
        .collect();

    packages.sort();
    packages.dedup();
    packages
}

fn expected_keepalive_entries(state: &StateFile) -> BTreeSet<KeepaliveEntry> {
    let mut entries = BTreeSet::new();

    for pkg in expected_sysconfig_packages(state) {
        for tag in KEEPALIVE_TAGS {
            entries.insert((tag.to_string(), pkg.clone()));
        }
    }

    entries
}

fn read_keepalive_entries() -> BTreeSet<KeepaliveEntry> {
    let mut entries = BTreeSet::new();
    let path = keepalive_sysconfig_path();

    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return entries,
    };

    for line in content.lines() {
        let line = line.trim();

        for tag in KEEPALIVE_TAGS {
            let needle = format!("<{} package=\"", tag);
            if let Some(pos) = line.find(&needle) {
                let start = pos + needle.len();
                if let Some(end) = line[start..].find('"') {
                    let pkg = line[start..start + end].to_string();
                    entries.insert((tag.to_string(), pkg));
                }
            }
        }
    }

    entries
}

fn diagnose() -> Result<(), String> {
    let mut state = read_state()?;
    // 先落定待处理项，让诊断输出反映物理现状而非上次开机的残留
    if settle_pending_via_pm(&mut state) {
        write_state_atomic(&mut state)?;
    }
    let root = moddir();

    println!("module_dir={}", root.display());
    println!("boot_id={}", get_boot_id());
    println!("schema_version={}", state.schema_version);
    println!("apps_count={}", state.apps.len());

    let mut has_pending = false;
    for record in state.apps.values() {
        if record.status == AppStatus::PendingAdd || record.status == AppStatus::PendingRemove {
            has_pending = true;
            break;
        }
    }
    println!("reboot_required={}", has_pending);

    let apks_root = root.join("state").join("apks");

    let expected_description = build_description(&state);
    let actual_description = read_module_prop_description().unwrap_or_default();
    let desc_synced = actual_description == expected_description;

    let keepalive_actual = read_keepalive_entries();
    let keepalive_expected = expected_keepalive_entries(&state);
    let keepalive_synced = keepalive_expected == keepalive_actual;

    let mut file_integrity = true;
    let mut cache_integrity = true;
    let mut priv_file_integrity = true;
    let mut priv_cache_integrity = true;

    let mut state_keepalive_only = 0usize;
    let mut priv_app_missing_count = 0usize;
    let mut priv_cache_missing_count = 0usize;

    for (pkg, record) in &state.apps {
        if record.keepalive_only {
            state_keepalive_only += 1;
        }

        println!("app_package={}", pkg);
        println!("  target={}", record.target);
        println!("  status={:?}", record.status);
        println!("  keepalive_only={}", record.keepalive_only);

        if record.keepalive_only {
            let state_apks_dir = apks_root.join(pkg);
            let state_apks_exists = state_apks_dir.is_dir();
            println!("  state_apks_exists={}", state_apks_exists);
            continue;
        }

        let system_root = root.join("system").join(&record.target);
        let system_app_dir = system_root.join(pkg);
        let system_app_exists = system_app_dir.is_dir();
        println!("  system_app_exists={}", system_app_exists);

        let state_apks_dir = apks_root.join(pkg);
        let state_apks_exists = state_apks_dir.is_dir();
        println!("  state_apks_exists={}", state_apks_exists);

        match record.status {
            AppStatus::Active | AppStatus::PendingAdd => {
                if !system_app_exists {
                    file_integrity = false;
                    if record.target == TARGET_PRIV {
                        priv_file_integrity = false;
                        priv_app_missing_count += 1;
                    }
                }
                if !state_apks_exists {
                    cache_integrity = false;
                    if record.target == TARGET_PRIV {
                        priv_cache_integrity = false;
                        priv_cache_missing_count += 1;
                    }
                }
            }
            AppStatus::PendingRemove => {
                if system_app_exists {
                    file_integrity = false;
                    if record.target == TARGET_PRIV {
                        priv_file_integrity = false;
                    }
                }
            }
        }
    }

    println!("state_keepalive_only={}", state_keepalive_only);
    println!("priv_app_missing_count={}", priv_app_missing_count);
    println!("priv_cache_missing_count={}", priv_cache_missing_count);

    println!("derived_description_synced={}", desc_synced);
    println!("derived_keepalive_synced={}", keepalive_synced);
    println!("derived_file_integrity={}", file_integrity);
    println!("derived_cache_integrity={}", cache_integrity);
    println!("derived_priv_file_integrity={}", priv_file_integrity);
    println!("derived_priv_cache_integrity={}", priv_cache_integrity);

    println!("keepalive_expected_entries={}", keepalive_expected.len());
    println!("keepalive_actual_entries={}", keepalive_actual.len());

    for (tag, pkg) in keepalive_expected.difference(&keepalive_actual) {
        println!("keepalive_missing_entry={}:{}", tag, pkg);
    }
    for (tag, pkg) in keepalive_actual.difference(&keepalive_expected) {
        println!("keepalive_extra_entry={}:{}", tag, pkg);
    }

    println!("deviceidle_runtime_checked=true");
    let deviceidle_output = Command::new("cmd")
        .args(["deviceidle", "whitelist"])
        .output();

    let deviceidle_whitelist = if let Ok(out) = deviceidle_output {
        if out.status.success() {
            String::from_utf8_lossy(&out.stdout).to_string()
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    let expected_pkgs = expected_keepalive_packages(&state);
    for pkg in &expected_pkgs {
        let contains = deviceidle_whitelist.contains(pkg);
        println!("deviceidle_runtime_contains_package={}:{}", pkg, contains);
        if !contains {
            println!("deviceidle_runtime_missing_package={}", pkg);
        }
    }

    println!("appops_runtime_checked=true");
    for pkg in &expected_pkgs {
        match get_appops_run_any_in_background(pkg) {
            Some(val) => println!("appops_run_any_in_background_package={}:{}", pkg, val),
            None => println!("appops_run_any_in_background_unknown_package={}", pkg),
        }
    }

    println!("standby_bucket_checked=true");
    for pkg in &expected_pkgs {
        let output = Command::new("am")
            .args(["get-standby-bucket", pkg])
            .output();
        if let Ok(out) = output {
            if out.status.success() {
                let val = String::from_utf8_lossy(&out.stdout).trim().to_string();
                println!("standby_bucket_package={}", pkg);
                println!("standby_bucket_value={}", val);
            }
        }
    }

    Ok(())
}

fn build_description(state: &StateFile) -> String {
    let active_app = state
        .apps
        .values()
        .filter(|r| r.status == AppStatus::Active && !r.keepalive_only && r.target == TARGET_APP)
        .count();

    let keepalive_only = state
        .apps
        .values()
        .filter(|r| r.keepalive_only && r.status != AppStatus::PendingRemove)
        .count();

    let pending_add = state
        .apps
        .values()
        .filter(|r| r.status == AppStatus::PendingAdd)
        .count();

    let pending_remove = state
        .apps
        .values()
        .filter(|r| r.status == AppStatus::PendingRemove)
        .count();

    // 已处理 = 已系统化 + 已保活（与 WebUI 概览「已处理 / 待重启」两栏口径一致）
    let processed = active_app + keepalive_only;
    let pending = pending_add + pending_remove;

    if processed == 0 {
        if pending == 0 {
            return "Z Systemizer：暂未处理任何应用。".to_string();
        }
        return format!(
            "Z Systemizer：待系统化 {} 个，待移除 {} 个，需重启生效。",
            pending_add, pending_remove
        );
    }

    let mut text = format!(
        "Z Systemizer：已处理 {} 个（系统化 {} 个",
        processed, active_app
    );
    if keepalive_only > 0 {
        text.push_str(&format!("，保活 {} 个", keepalive_only));
    }
    if pending > 0 {
        text.push_str(&format!(
            "；待系统化 {} 个，待移除 {} 个，需重启生效）。",
            pending_add, pending_remove
        ));
    } else {
        text.push_str("）。");
    }
    text
}

fn update_module_prop_description(desc: &str) -> Result<(), String> {
    let path = module_prop_path();

    if !path.exists() {
        return Err(format!("module.prop does not exist at {}", path.display()));
    }

    let content =
        fs::read_to_string(&path).map_err(|e| format!("failed to read module.prop: {}", e))?;

    let mut found = false;
    let mut lines = Vec::new();

    for line in content.lines() {
        if line.starts_with("description=") {
            lines.push(format!("description={}", desc));
            found = true;
        } else {
            lines.push(line.to_string());
        }
    }

    if !found {
        lines.push(format!("description={}", desc));
    }

    let tmp = path.with_extension(format!("prop.{}.tmp", id()));
    let next = format!("{}\n", lines.join("\n"));

    fs::write(&tmp, next).map_err(|e| format!("failed to write module.prop tmp: {}", e))?;

    fs::rename(&tmp, &path).map_err(|e| format!("failed to replace module.prop: {}", e))?;

    set_file_perm(&path, 0o644)?;

    Ok(())
}

fn update_description(state: &StateFile) {
    let desc = build_description(state);

    if let Err(e) = update_module_prop_description(&desc) {
        eprintln!("warn=failed_to_update_module_prop_description");
        eprintln!("description_error={}", e);
    }
}

fn read_module_prop_description() -> Option<String> {
    let content = fs::read_to_string(module_prop_path()).ok()?;

    for line in content.lines() {
        if let Some(desc) = line.strip_prefix("description=") {
            return Some(desc.to_string());
        }
    }

    None
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn update_aosp_keepalive_sysconfig(state: &StateFile) -> Result<(), String> {
    let dir = sysconfig_dir();
    create_dir(&dir)?;

    let packages = expected_sysconfig_packages(state);
    let path = keepalive_sysconfig_path();

    if packages.is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(());
    }

    let mut xml = String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<config>\n");

    for pkg in packages {
        let pkg = xml_escape(&pkg);

        for tag in KEEPALIVE_TAGS {
            xml.push_str(&format!("    <{} package=\"{}\" />\n", tag, pkg));
        }
    }

    xml.push_str("</config>\n");

    let tmp = path.with_extension(format!("xml.{}.tmp", id()));
    fs::write(&tmp, xml).map_err(|e| format!("failed to write keepalive sysconfig tmp: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("failed to replace keepalive sysconfig: {}", e))?;

    set_file_perm(&path, 0o644)?;

    Ok(())
}

fn sync_runtime_deviceidle_for_pkg(pkg: &str, enabled: bool) -> Result<(), String> {
    let op = if enabled {
        format!("+{}", pkg)
    } else {
        format!("-{}", pkg)
    };

    let output = Command::new("cmd")
        .args(["deviceidle", "whitelist", op.as_str()])
        .output()
        .map_err(|e| format!("deviceidle command failed: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

fn sync_runtime_deviceidle(state: &StateFile) {
    for pkg in expected_keepalive_packages(state) {
        if let Err(e) = sync_runtime_deviceidle_for_pkg(&pkg, true) {
            eprintln!("warn=deviceidle_add_failed");
            eprintln!("deviceidle_package={}", pkg);
            eprintln!("deviceidle_error={}", e);
        }
    }

    // 解除保活的集合与上面的添加集合严格互补，叠加态不会被误解除。
    for pkg in keepalive_teardown_packages(state) {
        if let Err(e) = sync_runtime_deviceidle_for_pkg(&pkg, false) {
            eprintln!("warn=deviceidle_remove_failed");
            eprintln!("deviceidle_package={}", pkg);
            eprintln!("deviceidle_error={}", e);
        }
    }
}

fn set_standby_bucket_active(pkg: &str) -> Result<(), String> {
    let output = Command::new("am")
        .args(["set-standby-bucket", pkg, "active"])
        .output()
        .map_err(|e| format!("am set-standby-bucket failed: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

// RUN_ANY_IN_BACKGROUND 是 Android 9+ 判定「应用是否被后台限制」的主 appops 开关，
// 也是唯一能对抗「用户在设置里手动把应用设为受限」的手段。
// 它不要求应用是系统应用，且会持久化，因此对 keepaliveOnly 同样有效。
//
// 注意：解除时必须使用 default（恢复系统默认），不能使用 ignore ——
// ignore 等于由本模块主动对该应用施加后台限制，比不处理更糟。
fn set_appops_run_any_in_background(pkg: &str, mode: &str) -> Result<(), String> {
    let output = Command::new("cmd")
        .args(["appops", "set", pkg, "RUN_ANY_IN_BACKGROUND", mode])
        .output()
        .map_err(|e| format!("appops command failed: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

fn get_appops_run_any_in_background(pkg: &str) -> Option<String> {
    let output = Command::new("cmd")
        .args(["appops", "get", pkg, "RUN_ANY_IN_BACKGROUND"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    // 输出形如：RUN_ANY_IN_BACKGROUND: allow
    text.lines()
        .find(|line| line.contains("RUN_ANY_IN_BACKGROUND"))
        .and_then(|line| line.split_once(':'))
        .map(|(_, v)| v.trim().to_string())
}

fn sync_appops(state: &StateFile) {
    // 需要保活的包：解除后台限制
    for pkg in expected_keepalive_packages(state) {
        if let Err(e) = set_appops_run_any_in_background(&pkg, "allow") {
            eprintln!("warn=appops_allow_failed");
            eprintln!("appops_package={}", pkg);
            eprintln!("appops_error={}", e);
        }
    }

    // 待移除且未要求保活的：恢复系统默认，不主动施加限制。
    // 叠加态（keepalive_only=true）必须排除，否则会撤销用户刚打开的保活。
    for pkg in keepalive_teardown_packages(state) {
        if let Err(e) = set_appops_run_any_in_background(&pkg, "default") {
            eprintln!("warn=appops_reset_failed");
            eprintln!("appops_package={}", pkg);
            eprintln!("appops_error={}", e);
        }
    }
}

fn sync_standby_buckets(state: &StateFile) {
    for pkg in expected_keepalive_packages(state) {
        if let Err(e) = set_standby_bucket_active(&pkg) {
            eprintln!("warn=standby_bucket_failed");
            eprintln!("standby_bucket_package={}", pkg);
            eprintln!("standby_bucket_error={}", e);
        }
    }
}

fn after_state_changed(state: &StateFile, mode: ApplyMode) {
    update_description(state);

    if let Err(e) = update_aosp_keepalive_sysconfig(state) {
        eprintln!("warn=failed_to_update_aosp_keepalive_sysconfig");
        eprintln!("keepalive_error={}", e);
    }

    if matches!(mode, ApplyMode::WebUi | ApplyMode::Manual) {
        sync_runtime_deviceidle(state);
        sync_appops(state);
        sync_standby_buckets(state);
    }
}

// 软重启（zygote 重启 / crash 恢复）不改变 boot_id，post-fs-data 的 reconcile 永远不跑，
// pending_add 会一直卡在「未处理 待系统化」。这里直接问 PackageManager 当前物理位置来落定。
//
// 只在用户主动触发的入口（state-json / diagnose / refresh-derived）各调一次：
// 不轮询、不加定时任务。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SettleAction {
    // 维持原状（含「探测不可用」这一档 —— 绝不因探测失败而改动记录）
    Keep,
    // pending_add 已生效：转正为 Active，清空 pending_boot_id
    PromoteToActive,
    // 叠加态收尾：物理上已不在 system 分区，蜕变为纯保活
    CollapseToKeepalive,
    // 普通待移除已物理完成：注销记录
    Drop,
}

fn settle_action(status: AppStatus, keepalive_only: bool, pm_system: Option<bool>) -> SettleAction {
    let pm_system = match pm_system {
        Some(v) => v,
        // 探测不可用 = 不知道物理现状 = 什么都不做。
        // 把「探测失败」当成「已移除」会在受限 shell 上下文里凭空删掉用户排队中的任务。
        None => return SettleAction::Keep,
    };

    match status {
        AppStatus::Active => SettleAction::Keep,
        AppStatus::PendingAdd => {
            if pm_system {
                SettleAction::PromoteToActive
            } else {
                SettleAction::Keep
            }
        }
        AppStatus::PendingRemove => {
            if pm_system {
                SettleAction::Keep
            } else if keepalive_only {
                SettleAction::CollapseToKeepalive
            } else {
                SettleAction::Drop
            }
        }
    }
}

// 返回是否改动了 state；调用方据此决定写盘 + 刷新派生状态。
fn settle_pending_via_pm(state: &mut StateFile) -> bool {
    let mut changed = false;
    let mut dropped = Vec::new();

    for (pkg, record) in state.apps.iter_mut() {
        let action = settle_action(
            record.status,
            record.keepalive_only,
            pm_reports_system_apk(pkg),
        );

        match action {
            SettleAction::Keep => {}
            SettleAction::PromoteToActive => {
                record.status = AppStatus::Active;
                record.pending_boot_id = None;
                record.updated_at = current_time();
                changed = true;
            }
            SettleAction::CollapseToKeepalive => {
                record.target = TARGET_KEEPALIVE.to_string();
                record.status = AppStatus::Active;
                record.pending_boot_id = None;
                record.updated_at = current_time();
                changed = true;
            }
            SettleAction::Drop => {
                dropped.push(pkg.clone());
                changed = true;
            }
        }
    }

    for pkg in dropped {
        state.apps.remove(&pkg);
    }

    changed
}

fn refresh_derived() -> Result<(), String> {
    let mut state = read_state()?;
    if settle_pending_via_pm(&mut state) {
        write_state_atomic(&mut state)?;
    }
    after_state_changed(&state, ApplyMode::Manual);
    println!("ok=true");
    Ok(())
}

fn list_systemized() -> Result<(), String> {
    let state = read_state()?;

    for (pkg, record) in state.apps {
        match record.status {
            AppStatus::Active | AppStatus::PendingAdd => {
                println!("{} {}", pkg, record.target);
            }
            AppStatus::PendingRemove => {}
        }
    }

    Ok(())
}

fn status(pkg: &str) -> Result<(), String> {
    let pkg = safe_pkg(pkg)?;
    let state = read_state()?;

    match state.apps.get(&pkg).map(|r| (&r.status, &r.target)) {
        Some((AppStatus::Active, target)) => println!("active\ntarget={}", target),
        Some((AppStatus::PendingAdd, target)) => println!("pending_add\ntarget={}", target),
        Some((AppStatus::PendingRemove, target)) => println!("pending_remove\ntarget={}", target),
        None => println!("none"),
    }

    Ok(())
}

fn risk_json(pkg: &str) -> Result<(), String> {
    let pkg = safe_pkg(pkg)?;

    let mut is_xposed = false;
    let mut reasons = Vec::new();

    let targets = [
        "assets/xposed_init",
        "META-INF/xposed/java_init.list",
        "META-INF/xposed/native_init.list",
        "META-INF/xposed/module.prop",
        "META-INF/xposed/scope.list",
    ];

    if let Ok(apks) = pm_path(&pkg) {
        for apk in apks {
            if let Ok(out) = run_command("unzip", &["-l", apk.to_string_lossy().as_ref()]) {
                for target in &targets {
                    if out.lines().any(|line| line.trim().ends_with(target)) {
                        is_xposed = true;
                        reasons.push(format!("Detected {}", target));
                    }
                }
            }
        }
    }

    #[derive(Serialize)]
    struct RiskResponse {
        package: String,
        #[serde(rename = "xposedModule")]
        xposed_module: bool,
        #[serde(rename = "riskLevel")]
        risk_level: String,
        reasons: Vec<String>,
        #[serde(rename = "blockedByDefault")]
        blocked_by_default: bool,
    }

    let response = RiskResponse {
        package: pkg,
        xposed_module: is_xposed,
        risk_level: if is_xposed {
            "high".to_string()
        } else {
            "none".to_string()
        },
        reasons,
        blocked_by_default: is_xposed,
    };

    println!("{}", serde_json::to_string(&response).unwrap());
    Ok(())
}

fn module_info_json() -> Result<(), String> {
    let path = module_prop_path();
    if !path.exists() {
        return Err(format!("module.prop does not exist at {}", path.display()));
    }

    let content =
        fs::read_to_string(&path).map_err(|e| format!("failed to read module.prop: {}", e))?;

    let mut map = BTreeMap::new();
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('#') || !line.contains('=') {
            continue;
        }
        let parts: Vec<&str> = line.splitn(2, '=').collect();
        if parts.len() == 2 {
            map.insert(parts[0].trim().to_string(), parts[1].trim().to_string());
        }
    }

    println!("{}", serde_json::to_string_pretty(&map).unwrap());
    Ok(())
}

fn verify_derived() -> Result<(), String> {
    let state = read_state()?;
    let root = moddir();
    let apks_root = root.join("state").join("apks");

    let expected_description = build_description(&state);
    let actual_description = read_module_prop_description().unwrap_or_default();
    let desc_synced = actual_description == expected_description;

    let keepalive_actual = read_keepalive_entries();
    let keepalive_expected = expected_keepalive_entries(&state);
    let keepalive_synced = keepalive_expected == keepalive_actual;

    let mut file_integrity = true;
    let mut cache_integrity = true;
    let mut priv_file_integrity = true;
    let mut priv_cache_integrity = true;

    for (pkg, record) in &state.apps {
        if record.keepalive_only {
            let apk_dir = apks_root.join(pkg);
            if !apk_dir.is_dir() {
                cache_integrity = false;
                println!("cache_missing_package={}", pkg);
            }
            continue;
        }

        let system_root = root.join("system").join(&record.target);
        let app_dir = system_root.join(pkg);
        let apk_dir = apks_root.join(pkg);

        match record.status {
            AppStatus::Active | AppStatus::PendingAdd => {
                if !app_dir.is_dir() {
                    file_integrity = false;
                    if record.target == TARGET_PRIV {
                        priv_file_integrity = false;
                    }
                    println!("file_system_app_missing={}", pkg);
                }
                if !apk_dir.is_dir() {
                    cache_integrity = false;
                    if record.target == TARGET_PRIV {
                        priv_cache_integrity = false;
                    }
                    println!("cache_missing_package={}", pkg);
                }
            }
            AppStatus::PendingRemove => {
                if app_dir.is_dir() {
                    file_integrity = false;
                    if record.target == TARGET_PRIV {
                        priv_file_integrity = false;
                    }
                    println!("file_pending_remove_system_app_exists={}", pkg);
                }
            }
        }
    }

    println!("description_synced={}", desc_synced);
    println!("keepalive_synced={}", keepalive_synced);
    println!("keepalive_expected_entries={}", keepalive_expected.len());
    println!("keepalive_actual_entries={}", keepalive_actual.len());
    println!("file_integrity={}", file_integrity);
    println!("cache_integrity={}", cache_integrity);
    println!("priv_file_integrity={}", priv_file_integrity);
    println!("priv_cache_integrity={}", priv_cache_integrity);

    Ok(())
}

fn usage() {
    eprintln!("usage:");
    eprintln!("  systemizer diagnose");
    eprintln!("  systemizer list-user-apps");
    eprintln!("  systemizer list-systemized");
    eprintln!("  systemizer status <package>");
    eprintln!("  systemizer systemize <package> app [--dry-run]");
    eprintln!("  systemizer unsystemize <package>");
    eprintln!("  systemizer keepalive <package> on|off");
    eprintln!("  systemizer state-json");
    eprintln!("  systemizer risk-json <package>");
    eprintln!("  systemizer module-info-json");
    eprintln!("  systemizer verify-derived");
    eprintln!("  systemizer reconcile --phase <install|post-fs-data|manual>");
    eprintln!("  systemizer refresh-derived");
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        usage();
        return Err("missing command".into());
    }

    match args[1].as_str() {
        "diagnose" => diagnose(),
        "list-user-apps" => list_user_apps(),
        "list-systemized" => list_systemized(),
        "status" => {
            if args.len() < 3 {
                return Err("missing package".into());
            }
            status(&args[2])
        }
        "state-json" => {
            let mut state = read_state()?;
            // WebUI 每次拉状态前落定一次软重启的待处理项（幂等，不轮询）
            if settle_pending_via_pm(&mut state) {
                write_state_atomic(&mut state)?;
            }
            println!("{}", serde_json::to_string_pretty(&state).unwrap());
            Ok(())
        }
        "risk-json" => {
            if args.len() < 3 {
                return Err("missing package".into());
            }
            risk_json(&args[2])
        }
        "module-info-json" => module_info_json(),
        "verify-derived" => verify_derived(),
        "reconcile" => {
            if args.len() < 4 || args[2] != "--phase" {
                return Err("usage: reconcile --phase <install|post-fs-data|manual>".into());
            }
            let phase = validate_phase(&args[3])?;
            reconcile(phase)
        }
        "systemize" => {
            if args.len() < 4 {
                return Err("usage: systemize <package> app [--dry-run]".into());
            }
            let dry_run = args.iter().any(|arg| arg == "--dry-run");
            systemize(&args[2], &args[3], dry_run)
        }
        "unsystemize" => {
            if args.len() < 3 {
                return Err("missing package".into());
            }
            unsystemize(&args[2])
        }
        "keepalive" => {
            if args.len() < 4 {
                return Err("usage: keepalive <package> on|off".into());
            }
            match args[3].as_str() {
                "on" => set_keepalive_only(&args[2], true),
                "off" => set_keepalive_only(&args[2], false),
                _ => Err("usage: keepalive <package> on|off".into()),
            }
        }
        "refresh-description" => refresh_derived(),
        "refresh-derived" => refresh_derived(),
        _ => {
            usage();
            Err(format!("unknown command: {}", args[1]))
        }
    }
}

fn main() {
    if let Err(err) = run() {
        eprintln!("error={}", err);
        exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::{Mutex, OnceLock};

    // 所有测试共用 SYSTEMIZER_MODDIR 环境变量且并行执行，
    // 不串行化会互相删除对方的临时目录。
    fn test_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn lock_test() -> std::sync::MutexGuard<'static, ()> {
        match test_lock().lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    // SYSTEMIZER_MODDIR 是进程级全局变量，而 cargo test 默认多线程并行跑测试。
    // 只要有两个测试同时改动它，moddir() 就会在「检查目录存在」与「写入文件」
    // 之间被换掉，表现为随机复现的 os error 3（系统找不到指定的路径）。
    // 因此这里强制所有会碰 moddir 的测试串行执行，并把 guard 存进线程本地，
    // 让它在整个测试体（含 teardown）期间一直持有。
    thread_local! {
        static HELD_GUARD: std::cell::RefCell<Option<std::sync::MutexGuard<'static, ()>>> =
            const { std::cell::RefCell::new(None) };
    }

    fn setup_mock_moddir() -> PathBuf {
        let guard = lock_test();
        HELD_GUARD.with(|slot| {
            *slot.borrow_mut() = Some(guard);
        });

        let dir = std::env::temp_dir().join(format!("systemizer-test-{}", id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        env::set_var("SYSTEMIZER_MODDIR", &dir);
        dir
    }

    fn release_mock_moddir_lock() {
        HELD_GUARD.with(|slot| {
            *slot.borrow_mut() = None;
        });
    }

    fn teardown_mock_moddir(dir: PathBuf) {
        let _ = fs::remove_dir_all(dir);
        // 测试体结束才释放锁，保证整个测试期间 moddir 不被别的线程改写。
        release_mock_moddir_lock();
    }

    // 测试辅助：直接构造一条 state 记录 + APK 缓存 + 目标目录。
    // 不走 systemize 的通用路径，因为那条路径需要真实 `pm` 命令（Windows 上不存在）。
    fn seed_record(
        pkg: &str,
        target: &str,
        status: AppStatus,
        pending: bool,
        keepalive_only: bool,
        with_target_dir: bool,
    ) -> PathBuf {
        let root = moddir();

        let apks = root.join("state").join("apks").join(pkg);
        fs::create_dir_all(&apks).unwrap();
        fs::write(apks.join("base.apk"), b"apk").unwrap();

        if with_target_dir {
            let d = root.join("system").join(target).join(pkg);
            fs::create_dir_all(&d).unwrap();
        }

        let mut state = read_state().unwrap();
        let now = current_time();
        state.apps.insert(
            pkg.to_string(),
            AppRecord {
                package: pkg.to_string(),
                target: target.to_string(),
                status,
                created_at: now,
                updated_at: now,
                pending_boot_id: if pending { Some(get_boot_id()) } else { None },
                keepalive_only,
            },
        );
        write_state_atomic(&mut state).unwrap();

        root
    }

    #[test]
    fn test_validate_target_accepts_app_and_keepalive() {
        assert!(validate_target("app").is_ok());
        // priv-app 入口已移除
        assert!(validate_target("priv-app").is_err());
        assert!(validate_target("keepalive").is_ok());
        assert!(validate_target("vendor").is_err());
        assert!(validate_target("product").is_err());
    }

    #[test]
    fn test_state_schema_v2_defaults() {
        let state = StateFile::default();
        assert_eq!(state.schema_version, 2);
        assert!(state.apps.is_empty());
    }

    #[test]
    fn test_old_schema_v1_migration() {
        let dir = setup_mock_moddir();
        let state_dir = dir.join("state");
        fs::create_dir_all(&state_dir).unwrap();

        let v1_json = r#"{
            "schemaVersion": 1,
            "moduleId": "ksu-systemizer",
            "updatedAt": 0,
            "bootId": "test-boot",
            "apps": {
                "com.example.app": {
                    "package": "com.example.app",
                    "target": "app",
                    "status": "active",
                    "createdAt": 1000,
                    "updatedAt": 1000,
                    "pendingBootId": null
                }
            }
        }"#;

        fs::write(state_dir.join("systemizer-state.json"), v1_json).unwrap();

        let state = read_state().unwrap();
        assert_eq!(state.schema_version, 2);
        assert_eq!(state.apps["com.example.app"].keepalive_only, false);
        assert_eq!(state.apps["com.example.app"].target, "app");

        teardown_mock_moddir(dir);
    }

    #[test]
    fn test_build_description_with_keepalive() {
        let mut state = StateFile::default();
        let now = current_time();

        state.apps.insert(
            "com.app1".to_string(),
            AppRecord {
                package: "com.app1".to_string(),
                target: "app".to_string(),
                status: AppStatus::Active,
                created_at: now,
                updated_at: now,
                pending_boot_id: None,
                keepalive_only: false,
            },
        );

        state.apps.insert(
            "com.keepalive1".to_string(),
            AppRecord {
                package: "com.keepalive1".to_string(),
                target: "keepalive".to_string(),
                status: AppStatus::Active,
                created_at: now,
                updated_at: now,
                pending_boot_id: None,
                keepalive_only: true,
            },
        );

        let desc = build_description(&state);
        assert!(desc.contains("仅保活 1 个"));
        assert!(!desc.contains("priv-app"));
    }

    #[test]
    fn test_expected_keepalive_packages_includes_keepalive_only() {
        let mut state = StateFile::default();
        let now = current_time();

        state.apps.insert(
            "com.keepalive1".to_string(),
            AppRecord {
                package: "com.keepalive1".to_string(),
                target: "keepalive".to_string(),
                status: AppStatus::Active,
                created_at: now,
                updated_at: now,
                pending_boot_id: None,
                keepalive_only: true,
            },
        );

        let pkgs = expected_keepalive_packages(&state);
        assert!(pkgs.contains(&"com.keepalive1".to_string()));
    }

    #[test]
    fn test_expected_sysconfig_packages_excludes_keepalive_only() {
        let mut state = StateFile::default();
        let now = current_time();

        let mk = |pkg: &str, target: &str, ko: bool, status: AppStatus| AppRecord {
            package: pkg.to_string(),
            target: target.to_string(),
            status,
            created_at: now,
            updated_at: now,
            pending_boot_id: None,
            keepalive_only: ko,
        };

        // 真正系统化的 app：应写入 sysconfig
        state.apps.insert(
            "com.sysapp".to_string(),
            mk("com.sysapp", "app", false, AppStatus::Active),
        );
        // 真正系统化的 priv-app：应写入 sysconfig
        state.apps.insert(
            "com.privapp".to_string(),
            mk("com.privapp", "priv-app", false, AppStatus::PendingAdd),
        );
        // keepaliveOnly（仍在 /data/app）：不应写入 sysconfig
        state.apps.insert(
            "com.keepalive1".to_string(),
            mk("com.keepalive1", "keepalive", true, AppStatus::Active),
        );

        let syscfg = expected_sysconfig_packages(&state);
        assert!(syscfg.contains(&"com.sysapp".to_string()));
        assert!(syscfg.contains(&"com.privapp".to_string()));
        assert!(
            !syscfg.contains(&"com.keepalive1".to_string()),
            "keepaliveOnly 不是系统应用，写入 sysconfig 会在开机解析时被跳过"
        );

        // 运行时保活仍应包含 keepaliveOnly
        let runtime = expected_keepalive_packages(&state);
        assert!(runtime.contains(&"com.keepalive1".to_string()));

        // entries 应只来自 sysconfig 集合：2 个包 × 1 个标签 = 2 条
        let entries = expected_keepalive_entries(&state);
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn test_keepalive_tags_is_single_tag() {
        // allow-in-power-save 已隐含 except-idle，不应再双写
        assert_eq!(KEEPALIVE_TAGS.len(), 1);
        assert_eq!(KEEPALIVE_TAGS[0], "allow-in-power-save");
    }

    // =========================================================================
    // 以下为「已系统化应用开启仅保活」叠加态链路的回归测试。
    // 覆盖 unsystemize / set_keepalive_only(true|false) / reconcile 四处联动。
    // =========================================================================

    #[test]
    fn test_keepalive_on_systemized_enters_overlay_state() {
        let dir = setup_mock_moddir();

        // 已生效的系统化应用（system/app 下有目录）
        seed_record(
            "com.example.app",
            "app",
            AppStatus::Active,
            false,
            false,
            true,
        );
        let app_dir = dir.join("system").join("app").join("com.example.app");
        assert!(app_dir.is_dir());

        set_keepalive_only("com.example.app", true).unwrap();

        let state = read_state().unwrap();
        let r = &state.apps["com.example.app"];

        assert!(r.keepalive_only, "保活开关必须打开");
        assert_eq!(
            r.status,
            AppStatus::PendingRemove,
            "已系统化应用开保活必须进入叠加态（待移除），而不是 PendingAdd"
        );
        assert_eq!(
            r.target, "app",
            "叠加态必须保留原类别，否则 reconcile 找不到待清理目录"
        );
        assert!(r.pending_boot_id.is_some(), "叠加态需要重启完成物理移除");
        assert!(
            !app_dir.is_dir(),
            "保活即时生效，system/app 目录此刻就应摘除"
        );

        teardown_mock_moddir(dir);
    }

    #[test]
    fn test_keepalive_on_plain_app_is_immediate_no_reboot() {
        let dir = setup_mock_moddir();

        set_keepalive_only("com.plain.app", true).unwrap();

        let state = read_state().unwrap();
        let r = &state.apps["com.plain.app"];

        assert!(r.keepalive_only);
        assert_eq!(r.status, AppStatus::Active, "普通应用开保活即时生效");
        assert_eq!(r.target, TARGET_KEEPALIVE);
        assert_eq!(r.pending_boot_id, None, "普通应用开保活不应产生待重启项");

        let pending = state
            .apps
            .values()
            .filter(|r| r.status == AppStatus::PendingAdd || r.status == AppStatus::PendingRemove)
            .count();
        assert_eq!(pending, 0, "开仅保活不应制造待重启项");

        teardown_mock_moddir(dir);
    }

    #[test]
    fn test_unsystemize_pure_keepalive_does_not_create_pending_remove() {
        let dir = setup_mock_moddir();

        // 纯保活记录（target=keepalive, status=Active），未系统化任何东西
        set_keepalive_only("com.keepalive1", true).unwrap();
        assert!(read_state().unwrap().apps.contains_key("com.keepalive1"));

        unsystemize("com.keepalive1").unwrap();

        let state = read_state().unwrap();

        // 关键回归：绝不能把一个纯保活记录标成 PendingRemove。
        // 那样的记录没有任何物理目录可清，reconcile 的 PendingRemove 分支
        // 却会为它走一遍「跨开机清理」，凭空制造一个永远结束不了的待重启项。
        assert!(
            state
                .apps
                .values()
                .all(|r| r.status != AppStatus::PendingRemove),
            "unsystemize 不得为未系统化的保活记录制造待移除任务"
        );

        // 纯保活不落盘任何文件，撤销它就等于关闭保活：记录直接消失。
        assert!(
            !state.apps.contains_key("com.keepalive1"),
            "未系统化的纯保活记录撤销后不应残留"
        );

        teardown_mock_moddir(dir);
    }

    #[test]
    fn test_unsystemize_overlay_after_keepalive_on_stays_pending_remove() {
        let dir = setup_mock_moddir();

        // 复刻 WebUI doKeepaliveFromSystemized 的两步调用序列：
        //   setKeepalive(pkg, true) -> unsystemize(pkg)
        // 第一步已把记录推进叠加态，第二步必须保持叠加态不倒退、不注销。
        seed_record(
            "com.example.app",
            "app",
            AppStatus::Active,
            false,
            false,
            true,
        );

        set_keepalive_only("com.example.app", true).unwrap();
        unsystemize("com.example.app").unwrap();

        let state = read_state().unwrap();
        let r = state
            .apps
            .get("com.example.app")
            .expect("叠加态记录不得被随后的 unsystemize 注销");
        assert!(r.keepalive_only, "保活开关必须保留");
        assert_eq!(
            r.status,
            AppStatus::PendingRemove,
            "第二步必须保持叠加态，重启后才移出系统分区"
        );
        assert_eq!(r.target, "app", "必须保留原类别以便 reconcile 清理");
        assert!(r.pending_boot_id.is_some());

        teardown_mock_moddir(dir);
    }

    #[test]
    fn test_keepalive_off_preserves_pending_remove() {
        let dir = setup_mock_moddir();

        // 叠加态：保活开 + 待移除
        seed_record(
            "com.example.app",
            "app",
            AppStatus::PendingRemove,
            true,
            true,
            true,
        );

        set_keepalive_only("com.example.app", false).unwrap();

        let state = read_state().unwrap();
        let r = state
            .apps
            .get("com.example.app")
            .expect("关闭保活不得吞掉待移除意图");
        assert!(!r.keepalive_only, "保活开关应已关闭");
        assert_eq!(
            r.status,
            AppStatus::PendingRemove,
            "待移除意图必须保留，待重启计数不得凭空 -1"
        );
        assert!(r.pending_boot_id.is_some());

        teardown_mock_moddir(dir);
    }

    #[test]
    fn test_keepalive_off_pure_deletes_record() {
        let dir = setup_mock_moddir();

        set_keepalive_only("com.keepalive1", true).unwrap();
        set_keepalive_only("com.keepalive1", false).unwrap();

        let state = read_state().unwrap();
        assert!(
            !state.apps.contains_key("com.keepalive1"),
            "纯保活不落盘任何文件，关闭应直接删除记录"
        );

        teardown_mock_moddir(dir);
    }

    #[test]
    fn test_reconcile_collapses_overlay_into_pure_keepalive() {
        let dir = setup_mock_moddir();

        // 叠加态 + 上一次开机的 pending_boot_id，模拟「重启后」
        seed_record(
            "com.example.app",
            "app",
            AppStatus::PendingRemove,
            true,
            true,
            true,
        );
        // 把 pending_boot_id 改成一个已过去的 boot id，触发跨开机分支
        {
            let mut state = read_state().unwrap();
            state
                .apps
                .get_mut("com.example.app")
                .unwrap()
                .pending_boot_id = Some("boot-before-reboot".to_string());
            write_state_atomic(&mut state).unwrap();
        }

        let app_dir = dir.join("system").join("app").join("com.example.app");
        assert!(app_dir.is_dir());

        reconcile("post-fs-data").unwrap();

        let state = read_state().unwrap();
        let r = state
            .apps
            .get("com.example.app")
            .expect("叠加态清理完物理目录后记录必须保留为纯保活，不得注销");

        assert!(r.keepalive_only, "保活开关必须保留");
        assert_eq!(r.status, AppStatus::Active, "应蜕变为纯保活 Active");
        assert_eq!(r.target, TARGET_KEEPALIVE, "目标应归一为 keepalive");
        assert_eq!(r.pending_boot_id, None);
        assert!(!app_dir.is_dir(), "system/app 目录必须被清掉");

        teardown_mock_moddir(dir);
    }

    #[test]
    fn test_reconcile_deletes_plain_pending_remove() {
        let dir = setup_mock_moddir();

        // 普通待移除（非保活）：跨开机后记录应被彻底注销
        seed_record(
            "com.plain.app",
            "app",
            AppStatus::PendingRemove,
            true,
            false,
            true,
        );
        {
            let mut state = read_state().unwrap();
            state.apps.get_mut("com.plain.app").unwrap().pending_boot_id =
                Some("boot-before-reboot".to_string());
            write_state_atomic(&mut state).unwrap();
        }

        reconcile("post-fs-data").unwrap();

        let state = read_state().unwrap();
        assert!(
            !state.apps.contains_key("com.plain.app"),
            "非保活的待移除记录应被注销"
        );

        teardown_mock_moddir(dir);
    }

    #[test]
    fn test_overlay_keeps_keepalive_live_until_reboot() {
        let dir = setup_mock_moddir();

        // 已系统化应用开启仅保活 → 叠加态
        seed_record(
            "com.example.app",
            "app",
            AppStatus::Active,
            false,
            false,
            true,
        );
        set_keepalive_only("com.example.app", true).unwrap();

        let state = read_state().unwrap();
        let r = &state.apps["com.example.app"];
        assert_eq!(r.status, AppStatus::PendingRemove);
        assert!(r.keepalive_only);

        // 关键回归：叠加态必须仍然在保活集合里。
        // 否则 after_state_changed 会在开启保活的同一次调用中，
        // 立刻用下面的解除循环把 deviceidle/appops 保活撤销掉，
        // 用户看到的开关是开的、实际保活却失效，直到下次重启才恢复。
        assert!(
            expected_keepalive_packages(&state).contains(&"com.example.app".to_string()),
            "叠加态必须保持保活，不能因为 PendingRemove 被剔除"
        );

        // 且绝不能被解除循环命中（两个集合必须严格互补）
        assert!(
            !keepalive_teardown_packages(&state).contains(&"com.example.app".to_string()),
            "叠加态不得被解除保活"
        );

        // 但它在 AOSP sysconfig 里必须缺席：sysconfig 的 allow-in-power-save
        // 在开机时用 MATCH_SYSTEM_ONLY 解析，而这个包重启后就移出系统分区了。
        assert!(
            !expected_sysconfig_packages(&state).contains(&"com.example.app".to_string()),
            "keepalive_only 的包不应写入 sysconfig"
        );

        teardown_mock_moddir(dir);
    }

    #[test]
    fn test_plain_pending_remove_is_torn_down() {
        let dir = setup_mock_moddir();

        // 普通待移除（用户明确要系统化，未要求保活）
        seed_record(
            "com.plain.app",
            "app",
            AppStatus::PendingRemove,
            true,
            false,
            true,
        );

        let state = read_state().unwrap();

        // 反向断言：真正的移除必须解除保活，不能被上面的修复误伤
        assert!(
            !expected_keepalive_packages(&state).contains(&"com.plain.app".to_string()),
            "正在移除的包不应继续保活"
        );
        assert!(
            keepalive_teardown_packages(&state).contains(&"com.plain.app".to_string()),
            "正在移除的包必须被解除保活"
        );

        teardown_mock_moddir(dir);
    }

    #[test]
    fn test_is_system_apk_path_matches_system_partitions() {
        assert!(is_system_apk_path(Path::new("/system/app/Foo/base.apk")));
        assert!(is_system_apk_path(Path::new(
            "/system/priv-app/Foo/base.apk"
        )));
        // 叠加式挂载点：/system/system/app/... 也必须命中
        assert!(is_system_apk_path(Path::new(
            "/system/system/app/Foo/base.apk"
        )));

        assert!(!is_system_apk_path(Path::new("/data/app/Foo-abc/base.apk")));
        assert!(!is_system_apk_path(Path::new(
            "/system/framework/framework.apk"
        )));
        assert!(!is_system_apk_path(Path::new("/vendor/app/Foo/base.apk")));
    }

    #[test]
    fn test_settle_action_keeps_everything_on_probe_failure() {
        // 探测不可用（pm 缺失 / 非零退出）：三种状态一律维持原状。
        // 这是本机制最重要的安全不变量 —— 探测失败绝不能被当成「已移除」。
        assert_eq!(
            settle_action(AppStatus::PendingAdd, false, None),
            SettleAction::Keep
        );
        assert_eq!(
            settle_action(AppStatus::PendingRemove, false, None),
            SettleAction::Keep
        );
        assert_eq!(
            settle_action(AppStatus::PendingRemove, true, None),
            SettleAction::Keep
        );
        assert_eq!(
            settle_action(AppStatus::Active, false, None),
            SettleAction::Keep
        );
    }

    #[test]
    fn test_settle_action_pending_add_promotes_only_when_pm_sees_system() {
        assert_eq!(
            settle_action(AppStatus::PendingAdd, false, Some(true)),
            SettleAction::PromoteToActive
        );
        // 还没真正落到 system 分区 → 继续等，不能凭空注销
        assert_eq!(
            settle_action(AppStatus::PendingAdd, false, Some(false)),
            SettleAction::Keep
        );
        assert_eq!(
            settle_action(AppStatus::Active, false, Some(true)),
            SettleAction::Keep,
            "已生效记录不该被重复处理"
        );
    }

    #[test]
    fn test_settle_action_pending_remove_splits_overlay_from_plain() {
        // 叠加态：物理已不在 system → 蜕变为纯保活，绝不能注销（那会吞掉用户的保活开关）
        assert_eq!(
            settle_action(AppStatus::PendingRemove, true, Some(false)),
            SettleAction::CollapseToKeepalive
        );
        // 普通待移除：物理已移除 → 注销
        assert_eq!(
            settle_action(AppStatus::PendingRemove, false, Some(false)),
            SettleAction::Drop
        );
        // 物理仍在 system（overlay 尚未卸载）→ 继续等重启
        assert_eq!(
            settle_action(AppStatus::PendingRemove, false, Some(true)),
            SettleAction::Keep
        );
        assert_eq!(
            settle_action(AppStatus::PendingRemove, true, Some(true)),
            SettleAction::Keep
        );
    }
}
