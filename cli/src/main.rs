use std::env;
use std::fs;
use std::path::Path;
use std::process::Command;

const MODDIR: &str = "/data/adb/modules/ksu-systemizer";

fn is_valid_pkg(pkg: &str) -> bool {
    if pkg.is_empty() {
        return false;
    }
    pkg.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
}

fn run_pm_path(pkg: &str) -> Vec<String> {
    let out = Command::new("pm")
        .arg("path")
        .arg(pkg)
        .output();

    if let Ok(o) = out {
        let s = String::from_utf8_lossy(&o.stdout);
        return s.lines()
            .map(|l| l.trim().replace("package:", ""))
            .filter(|l| !l.is_empty())
            .collect();
    }

    vec![]
}

fn safe_dir(pkg: &str) -> String {
    pkg.replace('/', "_")
}

fn systemize(pkg: &str, target: &str) -> Result<(), String> {
    if !is_valid_pkg(pkg) {
        return Err("invalid package".into());
    }

    let apks = run_pm_path(pkg);
    if apks.is_empty() {
        return Err("no apk paths found".into());
    }

    let base = format!("{}/system/{}", MODDIR, target);
    let dst = format!("{}/{}", base, safe_dir(pkg));

    let _ = fs::create_dir_all(&dst);

    for apk in apks {
        if !apk.ends_with(".apk") {
            continue;
        }

        let name = Path::new(&apk)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();

        let to = format!("{}/{}", dst, name);

        fs::copy(&apk, &to)
            .map_err(|e| format!("copy failed: {}", e))?;
    }

    Ok(())
}

fn unsystemize(pkg: &str) -> Result<(), String> {
    let dir1 = format!("{}/system/app/{}", MODDIR, safe_dir(pkg));
    let dir2 = format!("{}/system/priv-app/{}", MODDIR, safe_dir(pkg));

    let _ = fs::remove_dir_all(&dir1);
    let _ = fs::remove_dir_all(&dir2);

    Ok(())
}

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        eprintln!("systemizer <systemize|unsystemize> ...");
        return;
    }

    match args[1].as_str() {
        "systemize" => {
            if args.len() < 4 {
                eprintln!("usage: systemize <pkg> <app|priv-app>");
                return;
            }

            match systemize(&args[2], &args[3]) {
                Ok(_) => println!("OK"),
                Err(e) => eprintln!("ERR: {}", e),
            }
        }
        "unsystemize" => {
            if args.len() < 3 {
                eprintln!("usage: unsystemize <pkg>");
                return;
            }

            match unsystemize(&args[2]) {
                Ok(_) => println!("OK"),
                Err(e) => eprintln!("ERR: {}", e),
            }
        }
        _ => {
            eprintln!("unknown command");
        }
    }
}
