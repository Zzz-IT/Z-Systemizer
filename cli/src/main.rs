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

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
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

            if bak.exists() {
                let bak_data = fs::read_to_string(&bak)
                    .map_err(|e| format!("failed to read state backup: {}", e))?;

                serde_json::from_str(&bak_data).map_err(|backup_err| {
                    format!(
                        "failed to parse state json: {}; backup also failed: {}",
                        primary_err, backup_err
                    )
                })
            } else {
                Err(format!("failed to parse state json: {}", primary_err))
            }
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
        let _ = fs::copy(&path, &bak);
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

fn sync_dir(src: &Path, dst: &Path) -> Result<(), String> {
    let _ = fs::remove_dir_all(dst);
    create_dir(dst)?;

    if !src.is_dir() {
        return Err(format!("src is not a directory: {}", src.display()));
    }

    for entry in fs::read_dir(src).map_err(|e| format!("read_dir src failed: {}", e))? {
        let entry = entry.map_err(|e| format!("read entry failed: {}", e))?;
        let ty = entry
            .file_type()
            .map_err(|e| format!("file_type failed: {}", e))?;
        if ty.is_file() {
            let filename = entry.file_name();
            let src_file = src.join(&filename);
            let dst_file = dst.join(&filename);
            fs::copy(&src_file, &dst_file).map_err(|e| format!("copy failed: {}", e))?;
            set_file_perm(&dst_file, 0o644)?;
        }
    }

    let _ = Command::new("chcon")
        .args([
            "-R",
            "u:object_r:system_file:s0",
            dst.to_string_lossy().as_ref(),
        ])
        .status();

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
        if record.status == AppStatus::PendingRemove && pkg_apks_dir.is_dir() {
            sync_dir(&pkg_apks_dir, &app_dir)?;

            record.status = AppStatus::Active;
            record.updated_at = current_time();
            record.pending_boot_id = None;

            write_state_atomic(&mut state)?;
            update_description(&state);

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

    sync_dir(&pkg_apks_dir, &app_dir)?;

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
    update_description(&state);

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
        update_description(&state);
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

                        sync_dir(&pkg_apks_dir, &app_dir)?;
                        repairs += 1;
                        changed = true;
                    } else if phase == "manual" || phase == "install" {
                        keys_to_remove.push(pkg.clone());
                        changed = true;
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

                                sync_dir(&pkg_apks_dir, &app_dir)?;
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
                    sync_dir(&pkg_apks_dir, &app_dir)?;
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

    if phase != "post-fs-data" {
        update_description(&state);
        println!("reconcile phase={} completed.", phase);
    }

    Ok(())
}

fn diagnose() -> Result<(), String> {
    let state = read_state()?;
    let root = moddir();
    println!("moddir={}", root.display());
    println!("moddir_exists={}", root.is_dir());
    println!(
        "system_app_dir_exists={}",
        root.join("system").join(SYSTEM_TARGET).is_dir()
    );
    println!("state_file_exists={}", state_file_path().is_file());
    println!("state_schema_version={}", state.schema_version);
    println!("state_apps={}", state.apps.len());
    println!(
        "state_active={}",
        state
            .apps
            .values()
            .filter(|r| r.status == AppStatus::Active)
            .count()
    );
    println!(
        "state_pending_add={}",
        state
            .apps
            .values()
            .filter(|r| r.status == AppStatus::PendingAdd)
            .count()
    );
    println!(
        "state_pending_remove={}",
        state
            .apps
            .values()
            .filter(|r| r.status == AppStatus::PendingRemove)
            .count()
    );
    Ok(())
}

fn update_description(state: &StateFile) {
    let count = state
        .apps
        .values()
        .filter(|r| r.status == AppStatus::Active || r.status == AppStatus::PendingAdd)
        .count();
    let desc = format!(
        "Z Systemizer: {} app(s) staged under system/app. Reboot required after changes.",
        count
    );
    let _ = Command::new("ksud")
        .args(["module", "config", "set", "override.description", &desc])
        .status();
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

fn usage() {
    eprintln!("usage:");
    eprintln!("  systemizer diagnose");
    eprintln!("  systemizer list-user-apps");
    eprintln!("  systemizer list-systemized");
    eprintln!("  systemizer status <package>");
    eprintln!("  systemizer systemize <package> app [--dry-run]");
    eprintln!("  systemizer unsystemize <package>");
    eprintln!("  systemizer state-json");
    eprintln!("  systemizer reconcile --phase <install|post-fs-data|manual>");
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
        "reconcile" => {
            if args.len() < 4 || args[2] != "--phase" {
                return Err("usage: reconcile --phase <install|post-fs-data|manual>".into());
            }
            reconcile(&args[3])
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
