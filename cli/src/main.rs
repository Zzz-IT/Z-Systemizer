use std::env;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{exit, Command};

const DEFAULT_MODDIR: &str = "/data/adb/modules/ksu-systemizer";
const SYSTEM_TARGET: &str = "app";

fn moddir() -> PathBuf {
    env::var("SYSTEMIZER_MODDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(DEFAULT_MODDIR))
}

fn is_valid_pkg(pkg: &str) -> bool {
    !pkg.is_empty()
        && pkg.len() <= 255
        && pkg.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
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
        _ => Err("only system/app is supported; priv-app is intentionally disabled".to_string()),
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
    fs::create_dir_all(path).map_err(|e| format!("mkdir failed for {}: {}", path.display(), e))?;
    set_file_perm(path, 0o755)
}

fn copy_apks(pkg: &str, target: &str, dry_run: bool) -> Result<(), String> {
    let pkg = safe_pkg(pkg)?;
    let target = validate_target(target)?;
    let apks = pm_path(&pkg)?;
    let root = moddir();
    let target_root = root.join("system").join(target);
    let final_dir = target_root.join(&pkg);
    let tmp_dir = target_root.join(format!(".{}.tmp", pkg));

    if dry_run {
        println!("dry_run=true");
        println!("package={}", pkg);
        println!("target={}", target);
        println!("destination={}", final_dir.display());
        for apk in &apks {
            println!("apk={}", apk.display());
        }
        return Ok(());
    }

    create_dir(&target_root)?;

    let _ = fs::remove_dir_all(&tmp_dir);
    create_dir(&tmp_dir)?;

    for apk in apks {
        if !apk.is_file() {
            let _ = fs::remove_dir_all(&tmp_dir);
            return Err(format!("apk is not a file: {}", apk.display()));
        }

        let filename = apk
            .file_name()
            .ok_or_else(|| format!("bad apk path: {}", apk.display()))?;
        let dst = tmp_dir.join(filename);
        fs::copy(&apk, &dst).map_err(|e| format!("copy {} failed: {}", apk.display(), e))?;
        set_file_perm(&dst, 0o644)?;
    }

    let app_dir = root.join("system").join(SYSTEM_TARGET).join(&pkg);
    let _ = fs::remove_dir_all(&app_dir);

    fs::rename(&tmp_dir, &final_dir)
        .map_err(|e| format!("rename {} -> {} failed: {}", tmp_dir.display(), final_dir.display(), e))?;

    let _ = Command::new("chcon")
        .args(["-R", "u:object_r:system_file:s0", final_dir.to_string_lossy().as_ref()])
        .status();

    update_description();
    println!("ok=true");
    println!("package={}", pkg);
    println!("target={}", target);
    println!("reboot_required=true");
    Ok(())
}

fn unsystemize(pkg: &str) -> Result<(), String> {
    let pkg = safe_pkg(pkg)?;
    let root = moddir();
    let app_dir = root.join("system").join(SYSTEM_TARGET).join(&pkg);
    let _ = fs::remove_dir_all(&app_dir);

    update_description();
    println!("ok=true");
    println!("package={}", pkg);
    println!("removed=true");
    println!("reboot_required=true");
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

fn list_dirs(base: &Path, target: &str) -> Vec<(String, String)> {
    let mut rows = Vec::new();
    if let Ok(entries) = fs::read_dir(base.join(target)) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Some(name) = entry.file_name().to_str() {
                    if is_valid_pkg(name) {
                        rows.push((name.to_string(), target.to_string()));
                    }
                }
            }
        }
    }
    rows
}

fn list_systemized() {
    let root = moddir().join("system");
    let mut rows = list_dirs(&root, SYSTEM_TARGET);
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    for (pkg, target) in rows {
        println!("{} {}", pkg, target);
    }
}

fn status(pkg: &str) -> Result<(), String> {
    let pkg = safe_pkg(pkg)?;
    let root = moddir();
    if root.join("system").join(SYSTEM_TARGET).join(&pkg).is_dir() {
        println!("app");
    } else {
        println!("none");
    }
    Ok(())
}

fn systemized_count() -> usize {
    let root = moddir().join("system");
    list_dirs(&root, SYSTEM_TARGET).len()
}

fn update_description() {
    let count = systemized_count();
    let desc = format!(
        "Z Systemizer: {} app(s) staged under system/app. Reboot required after changes.",
        count
    );
    let _ = Command::new("ksud")
        .args(["module", "config", "set", "override.description", &desc])
        .status();
}

fn diagnose() {
    let root = moddir();
    println!("moddir={}", root.display());
    println!("moddir_exists={}", root.is_dir());
    println!("system_app_dir_exists={}", root.join("system").join(SYSTEM_TARGET).is_dir());
    println!("priv_app_supported=false");
    println!("systemized_count={}", systemized_count());
    println!(
        "meta_overlayfs_detected={}",
        Path::new("/data/adb/modules/meta-overlayfs/module.prop").is_file()
            || Path::new("/data/adb/modules_update/meta-overlayfs/module.prop").is_file()
    );
}

fn usage() {
    eprintln!("usage:");
    eprintln!("  systemizer diagnose");
    eprintln!("  systemizer list-user-apps");
    eprintln!("  systemizer list-systemized");
    eprintln!("  systemizer status <package>");
    eprintln!("  systemizer systemize <package> app [--dry-run]");
    eprintln!("  systemizer unsystemize <package>");
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        usage();
        return Err("missing command".into());
    }

    match args[1].as_str() {
        "diagnose" => {
            diagnose();
            Ok(())
        }
        "list-user-apps" => list_user_apps(),
        "list-systemized" => {
            list_systemized();
            Ok(())
        }
        "status" => {
            if args.len() < 3 {
                return Err("missing package".into());
            }
            status(&args[2])
        }
        "systemize" => {
            if args.len() < 4 {
                return Err("usage: systemize <package> app [--dry-run]".into());
            }
            let dry_run = args.iter().any(|arg| arg == "--dry-run");
            copy_apks(&args[2], &args[3], dry_run)
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
