use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{exit, id, Command};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_MODDIR: &str = "/data/adb/modules/ksu-systemizer";
const SYSTEM_TARGET: &str = "app";

#[derive(Clone, Copy)]
enum ApplyMode {
    WebUi,
    Install,
    Manual,
    PostFsData,
}

const KEEPALIVE_TAGS: &[&str] = &["allow-in-power-save", "allow-in-power-save-except-idle"];

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

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
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
            schema_version: 1,
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

    match serde_json::from_str(&data) {
        Ok(state) => Ok(state),
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
        SYSTEM_TARGET => Ok(SYSTEM_TARGET),
        _ => Err("only system/app is supported".to_string()),
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

fn set_file_perm(path: &Path, mode: u32) -> Result<(), String> {
    let mut perm = fs::metadata(path)
        .map_err(|e| format!("metadata failed for {}: {}", path.display(), e))?
        .permissions();
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

    let mut state = read_state()?;

    let root = moddir();
    let apks_dir = root.join("state").join("apks");
    create_dir(&apks_dir)?;

    let pkg_apks_dir = apks_dir.join(&pkg);
    let target_root = root.join("system").join(target);
    create_dir(&target_root)?;

    let app_dir = target_root.join(&pkg);

    if let Some(record) = state.apps.get_mut(&pkg) {
        if record.status == AppStatus::Active {
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
    });

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
        let app_dir = root.join("system").join(SYSTEM_TARGET).join(&pkg);
        let pkg_apks_dir = root.join("state").join("apks").join(&pkg);

        match record.status {
            AppStatus::PendingAdd => {
                let _ = fs::remove_dir_all(&app_dir);
                let _ = fs::remove_dir_all(&pkg_apks_dir);
                state.apps.remove(&pkg);
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
    let target_root = root.join("system").join(SYSTEM_TARGET);
    let apks_root = root.join("state").join("apks");

    create_dir(&target_root)?;
    create_dir(&apks_root)?;

    let mut keys_to_remove = Vec::new();
    let mut changed = false;
    let mut repairs = 0usize;

    let apply_context = phase != "post-fs-data";

    for (pkg, record) in state.apps.iter_mut() {
        let app_dir = target_root.join(pkg);
        let pkg_apks_dir = apks_root.join(pkg);

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
                        // install / post-fs-data 缓存缺失时保留 active 记录
                        // diagnose 负责提示 cache_missing / system_app_missing
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
                                // 缓存缺失，不能落定 active
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

                        keys_to_remove.push(pkg.clone());
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

fn expected_keepalive_packages(state: &StateFile) -> Vec<String> {
    let mut packages: Vec<String> = state
        .apps
        .values()
        .filter(|r| r.status == AppStatus::Active || r.status == AppStatus::PendingAdd)
        .map(|r| r.package.clone())
        .collect();

    packages.sort();
    packages.dedup();
    packages
}

fn expected_keepalive_entries(state: &StateFile) -> BTreeSet<KeepaliveEntry> {
    let mut entries = BTreeSet::new();

    for record in state.apps.values() {
        if record.status == AppStatus::Active || record.status == AppStatus::PendingAdd {
            for tag in KEEPALIVE_TAGS {
                entries.insert((tag.to_string(), record.package.clone()));
            }
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
    let state = read_state()?;
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

    let system_root = root.join("system").join(SYSTEM_TARGET);
    let apks_root = root.join("state").join("apks");

    let expected_description = build_description(&state);
    let actual_description = read_module_prop_description().unwrap_or_default();
    let desc_synced = actual_description == expected_description;

    let keepalive_actual = read_keepalive_entries();
    let keepalive_expected = expected_keepalive_entries(&state);
    let keepalive_synced = keepalive_expected == keepalive_actual;

    let mut file_integrity = true;
    let mut cache_integrity = true;

    for (pkg, record) in &state.apps {
        println!("app_package={}", pkg);
        println!("  target={}", record.target);
        println!("  status={:?}", record.status);

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
                }
                if !state_apks_exists {
                    cache_integrity = false;
                }
            }
            AppStatus::PendingRemove => {
                if system_app_exists {
                    file_integrity = false;
                }
            }
        }
    }

    println!("derived_description_synced={}", desc_synced);
    println!("derived_keepalive_synced={}", keepalive_synced);
    println!("derived_file_integrity={}", file_integrity);
    println!("derived_cache_integrity={}", cache_integrity);

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
    let active = state
        .apps
        .values()
        .filter(|r| r.status == AppStatus::Active)
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

    if pending_add == 0 && pending_remove == 0 {
        format!("Z Systemizer：已系统化 {} 个应用。", active)
    } else {
        format!(
            "Z Systemizer：已系统化 {} 个，待系统化 {} 个，待移除 {} 个；待处理项需重启生效。",
            active, pending_add, pending_remove
        )
    }
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

    let packages = expected_keepalive_packages(state);
    let path = keepalive_sysconfig_path();

    if packages.is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(());
    }

    let mut xml = String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<config>\n");

    for pkg in packages {
        let pkg = xml_escape(&pkg);

        xml.push_str(&format!(
            "    <allow-in-power-save package=\"{}\" />\n",
            pkg
        ));
        xml.push_str(&format!(
            "    <allow-in-power-save-except-idle package=\"{}\" />\n",
            pkg
        ));
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

    for record in state.apps.values() {
        if record.status == AppStatus::PendingRemove {
            if let Err(e) = sync_runtime_deviceidle_for_pkg(&record.package, false) {
                eprintln!("warn=deviceidle_remove_failed");
                eprintln!("deviceidle_package={}", record.package);
                eprintln!("deviceidle_error={}", e);
            }
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
        sync_standby_buckets(state);
    }
}

fn refresh_derived() -> Result<(), String> {
    let state = read_state()?;
    after_state_changed(&state, ApplyMode::Manual);
    println!("ok=true");
    Ok(())
}

fn list_systemized() -> Result<(), String> {
    let state = read_state()?;

    for (pkg, record) in state.apps {
        match record.status {
            AppStatus::Active | AppStatus::PendingAdd => {
                println!("{} app", pkg);
            }
            AppStatus::PendingRemove => {}
        }
    }

    Ok(())
}

fn status(pkg: &str) -> Result<(), String> {
    let pkg = safe_pkg(pkg)?;
    let state = read_state()?;

    match state.apps.get(&pkg).map(|r| &r.status) {
        Some(AppStatus::Active) => println!("active"),
        Some(AppStatus::PendingAdd) => println!("pending_add"),
        Some(AppStatus::PendingRemove) => println!("pending_remove"),
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
    let system_root = root.join("system").join(SYSTEM_TARGET);
    let apks_root = root.join("state").join("apks");

    let expected_description = build_description(&state);
    let actual_description = read_module_prop_description().unwrap_or_default();
    let desc_synced = actual_description == expected_description;

    let keepalive_actual = read_keepalive_entries();
    let keepalive_expected = expected_keepalive_entries(&state);
    let keepalive_synced = keepalive_expected == keepalive_actual;

    let mut file_integrity = true;
    let mut cache_integrity = true;
    for (pkg, record) in &state.apps {
        let app_dir = system_root.join(pkg);
        let apk_dir = apks_root.join(pkg);

        match record.status {
            AppStatus::Active | AppStatus::PendingAdd => {
                if !app_dir.is_dir() {
                    file_integrity = false;
                    println!("file_system_app_missing={}", pkg);
                }
                if !apk_dir.is_dir() {
                    cache_integrity = false;
                    println!("cache_missing_package={}", pkg);
                }
            }
            AppStatus::PendingRemove => {
                if app_dir.is_dir() {
                    file_integrity = false;
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
            let state = read_state()?;
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
