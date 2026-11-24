//! Test install: put the current font where the system finds it, replacing
//! the copy installed last time, so it can be tried in Word or a browser.

use std::path::{Path, PathBuf};

/// The start of every test copy's file name, so the next install can find
/// and replace it.
pub fn file_stem(family: &str) -> String {
    let s: String = family.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let s = s.trim_matches('-');
    format!("{}-HoheTest", if s.is_empty() { "Font" } else { s })
}

/// The folder that holds fonts installed for this user.
fn fonts_dir() -> Result<PathBuf, String> {
    let var = |k: &str| std::env::var_os(k).map(PathBuf::from).ok_or_else(|| format!("{k} is not set"));
    if cfg!(target_os = "windows") {
        Ok(var("LOCALAPPDATA")?.join("Microsoft").join("Windows").join("Fonts"))
    } else if cfg!(target_os = "macos") {
        Ok(var("HOME")?.join("Library").join("Fonts"))
    } else {
        Ok(var("HOME")?.join(".local").join("share").join("fonts"))
    }
}

/// Earlier test copies in `dir`; the ones still in use are left for the
/// system to clean up later.
fn remove_old(dir: &Path, stem: &str, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with(stem) && name.ends_with(".ttf") && p != keep {
            let _ = std::fs::remove_file(&p);
        }
    }
}

/// Install `bytes` as the test copy of `family`; returns where it went.
pub fn install(bytes: &[u8], family: &str, serial: i64) -> Result<PathBuf, String> {
    let dir = fonts_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = file_stem(family);
    // A new file name each time: Windows keeps a font it has loaded locked.
    let path = dir.join(format!("{stem}-{serial}.ttf"));
    std::fs::write(&path, bytes).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    register(family, &path)?;
    remove_old(&dir, &stem, &path);
    Ok(path)
}

#[cfg(target_os = "windows")]
fn register(family: &str, path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let status = std::process::Command::new("reg")
        .args(["add", r"HKCU\Software\Microsoft\Windows NT\CurrentVersion\Fonts", "/v"])
        .arg(format!("{family} (Hohe test) (TrueType)"))
        .args(["/t", "REG_SZ", "/d"])
        .arg(path)
        .arg("/f")
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Windows did not accept the font.".into())
    }
}

#[cfg(not(target_os = "windows"))]
fn register(_family: &str, _path: &Path) -> Result<(), String> {
    // macOS and Linux pick up fonts from the folder itself.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_copies_are_named_after_the_family() {
        assert_eq!(file_stem("Abyssinica Sans"), "Abyssinica-Sans-HoheTest");
        assert_eq!(file_stem("ሀ"), "Font-HoheTest");
    }

    #[test]
    fn older_copies_are_replaced() {
        let dir = std::env::temp_dir().join(format!("hohe-install-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stem = file_stem("Test");
        let old = dir.join(format!("{stem}-1.ttf"));
        let other = dir.join("Other.ttf");
        std::fs::write(&old, b"x").unwrap();
        std::fs::write(&other, b"x").unwrap();
        let new = dir.join(format!("{stem}-2.ttf"));
        std::fs::write(&new, b"y").unwrap();
        remove_old(&dir, &stem, &new);
        assert!(!old.exists() && new.exists() && other.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
