//! The .kid file: the native project format.
//!
//! A .kid file is a zip package of readable, pretty-printed JSON, one file per
//! object, so that versions diff cleanly and a damaged file is still
//! recoverable by hand:
//!
//! ```text
//! project.json                  format version, metrics, order rules
//! bases/<base id>.json          one base: outlines, part tags, anchors
//! families/<family id>.json     one family: its base, rule variants, fidel states and nudges
//! alterations/<id>.json         one alteration: drawn parts and placement rule
//! symbols/<id>.json             one punctuation mark, numeral or combining mark
//! components/<id>.json          one leaf, cap or corner, drawn once
//! ```
//!
//! `project.json` also lists the character sets the project covers. Files
//! from before sets existed open as Ge'ez only.
//!
//! Multiple masters will add a `masters/<name>/` level later; version 1 holds
//! a single master. Entries are written in sorted order with a fixed
//! timestamp, so saving the same project twice gives identical bytes.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Seek, Write};
use std::path::Path;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use thiserror::Error;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipArchive, ZipWriter};

use crate::charset::{CharSet, Language};
use crate::order::{Order, OrderRule};
use crate::project::{Metrics, Project};

pub const FORMAT: &str = "kid";
pub const VERSION: u32 = 1;
pub const EXTENSION: &str = "kid";

#[derive(Debug, Error)]
pub enum KidError {
    #[error("could not read or write the file: {0}")]
    Io(#[from] std::io::Error),
    #[error("the file is not a valid .kid package: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("{file} is not valid: {source}")]
    Json { file: String, source: serde_json::Error },
    #[error("this is not a .kid file (project.json is missing or has another format)")]
    NotKid,
    #[error("this file was made by a newer version of the editor (format {0}); update the app to open it")]
    TooNew(u32),
    #[error("{file} holds `{found}`, but its name says `{expected}`")]
    IdMismatch { file: String, expected: String, found: String },
    #[error("the id `{0}` cannot be used as a file name")]
    BadId(String),
}

#[derive(Debug, Serialize, Deserialize)]
struct Manifest {
    format: String,
    version: u32,
    metrics: Metrics,
    order_rules: BTreeMap<Order, OrderRule>,
    #[serde(default = "geez_only")]
    charsets: BTreeSet<CharSet>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    languages: BTreeSet<Language>,
    #[serde(default)]
    info: crate::project::FontInfo,
}

fn geez_only() -> BTreeSet<CharSet> {
    BTreeSet::from([CharSet::Geez])
}

/// Write `project` as a .kid package.
pub fn write<W: Write + Seek>(project: &Project, writer: W) -> Result<(), KidError> {
    let mut entries: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let manifest = Manifest {
        format: FORMAT.into(),
        version: VERSION,
        metrics: project.metrics.clone(),
        order_rules: project.order_rules.clone(),
        charsets: project.charsets.clone(),
        languages: project.languages.clone(),
        info: project.info.clone(),
    };
    entries.insert("project.json".into(), to_json("project.json", &manifest)?);
    for (id, base) in &project.bases {
        let name = entry("bases", id)?;
        entries.insert(name.clone(), to_json(&name, base)?);
    }
    for (id, family) in &project.families {
        let name = entry("families", id)?;
        entries.insert(name.clone(), to_json(&name, family)?);
    }
    for (id, alt) in &project.alterations {
        let name = entry("alterations", id)?;
        entries.insert(name.clone(), to_json(&name, alt)?);
    }
    for (id, sym) in &project.symbols {
        let name = entry("symbols", id)?;
        entries.insert(name.clone(), to_json(&name, sym)?);
    }
    for (id, comp) in &project.components {
        let name = entry("components", id)?;
        entries.insert(name.clone(), to_json(&name, comp)?);
    }
    if !project.guides.is_empty() {
        entries.insert("guides.json".into(), to_json("guides.json", &project.guides)?);
    }
    if !project.backgrounds.is_empty() {
        entries.insert("backgrounds.json".into(), to_json("backgrounds.json", &project.backgrounds)?);
    }
    if !project.organize.is_empty() {
        entries.insert("organize.json".into(), to_json("organize.json", &project.organize)?);
    }

    let mut zip = ZipWriter::new(writer);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .last_modified_time(DateTime::default())
        .unix_permissions(0o644);
    for (name, bytes) in entries {
        zip.start_file(name, options)?;
        zip.write_all(&bytes)?;
    }
    zip.finish()?;
    Ok(())
}

/// Read a .kid package.
pub fn read<R: Read + Seek>(reader: R) -> Result<Project, KidError> {
    let mut zip = ZipArchive::new(reader)?;
    let manifest: Manifest = match read_entry(&mut zip, "project.json") {
        Ok(m) => m,
        Err(KidError::Zip(zip::result::ZipError::FileNotFound)) => return Err(KidError::NotKid),
        Err(e) => return Err(e),
    };
    if manifest.format != FORMAT {
        return Err(KidError::NotKid);
    }
    if manifest.version > VERSION {
        return Err(KidError::TooNew(manifest.version));
    }

    let mut project = Project {
        metrics: manifest.metrics,
        order_rules: manifest.order_rules,
        charsets: manifest.charsets,
        languages: manifest.languages,
        info: manifest.info,
        ..Default::default()
    };
    let names: Vec<String> = zip.file_names().map(|n| n.map(|s| s.into_owned())).collect::<Result<_, _>>()?;
    if names.iter().any(|n| n == "guides.json") {
        project.guides = read_entry(&mut zip, "guides.json")?;
    }
    if names.iter().any(|n| n == "backgrounds.json") {
        project.backgrounds = read_entry(&mut zip, "backgrounds.json")?;
    }
    if names.iter().any(|n| n == "organize.json") {
        project.organize = read_entry(&mut zip, "organize.json")?;
    }
    for name in names {
        let Some((dir, id)) = name.strip_suffix(".json").and_then(|n| n.split_once('/')) else {
            continue;
        };
        if id.contains('/') {
            continue;
        }
        match dir {
            "bases" => {
                let base: crate::base::Base = read_entry(&mut zip, &name)?;
                check_id(&name, id, &base.id)?;
                project.bases.insert(base.id.clone(), base);
            }
            "families" => {
                let family: crate::fidel::Family = read_entry(&mut zip, &name)?;
                check_id(&name, id, &family.id)?;
                project.families.insert(family.id.clone(), family);
            }
            "alterations" => {
                let alt: crate::alteration::Alteration = read_entry(&mut zip, &name)?;
                check_id(&name, id, &alt.id)?;
                project.alterations.insert(alt.id.clone(), alt);
            }
            "symbols" => {
                let sym: crate::project::Symbol = read_entry(&mut zip, &name)?;
                check_id(&name, id, &sym.id)?;
                project.symbols.insert(sym.id.clone(), sym);
            }
            "components" => {
                let comp: crate::component::Component = read_entry(&mut zip, &name)?;
                check_id(&name, id, &comp.id)?;
                project.components.insert(comp.id.clone(), comp);
            }
            // Unknown folders are left alone, for files from later versions.
            _ => {}
        }
    }
    project.refresh_derived();
    Ok(project)
}

/// Save to a path. Writes to a temporary file first and then renames it, so a
/// failed save never leaves a half-written project behind.
pub fn save(project: &Project, path: &Path) -> Result<(), KidError> {
    // Build the whole package in memory first, so a bad id fails before the
    // disk is touched.
    let mut bytes = std::io::Cursor::new(Vec::new());
    write(project, &mut bytes)?;
    let tmp = path.with_extension("kid.saving");
    let result = std::fs::write(&tmp, bytes.get_ref()).and_then(|_| std::fs::rename(&tmp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(result?)
}

pub fn open(path: &Path) -> Result<Project, KidError> {
    read(std::io::BufReader::new(std::fs::File::open(path)?))
}

fn entry(dir: &str, id: &str) -> Result<String, KidError> {
    let ok = !id.is_empty()
        && id != "."
        && id != ".."
        && !id
            .chars()
            .any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control());
    if !ok {
        return Err(KidError::BadId(id.into()));
    }
    Ok(format!("{dir}/{id}.json"))
}

fn check_id(file: &str, expected: &str, found: &str) -> Result<(), KidError> {
    if expected != found {
        return Err(KidError::IdMismatch {
            file: file.into(),
            expected: expected.into(),
            found: found.into(),
        });
    }
    Ok(())
}

fn to_json<T: Serialize>(file: &str, value: &T) -> Result<Vec<u8>, KidError> {
    let mut bytes =
        serde_json::to_vec_pretty(value).map_err(|source| KidError::Json { file: file.into(), source })?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn read_entry<R: Read + Seek, T: DeserializeOwned>(
    zip: &mut ZipArchive<R>,
    name: &str,
) -> Result<T, KidError> {
    let mut f = zip.by_name(name)?;
    let mut text = String::new();
    f.read_to_string(&mut text)?;
    serde_json::from_str(&text).map_err(|source| KidError::Json { file: name.into(), source })
}
