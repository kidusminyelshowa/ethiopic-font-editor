//! OpenType features: what the model generates (language systems, kerning
//! and its classes) and the code a designer writes by hand, joined into one
//! feature file.
//!
//! Hand-written code may name a glyph by its character: `sub ሀ by ሀ.ss01;`
//! is read as `sub uni1200 by uni1200.ss01;`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::kerning::KernSide;
use crate::project::Project;

/// Script and language tag pairs the font declares, with a readable name.
pub const LANGUAGES: [(&str, &str, &str); 7] = [
    ("ethi", "dflt", "Ethiopic"),
    ("ethi", "AMH", "Amharic"),
    ("ethi", "TGY", "Tigrinya"),
    ("ethi", "GEZ", "Ge'ez"),
    ("ethi", "TGR", "Tigre"),
    ("latn", "dflt", "Latin"),
    ("latn", "ENG", "English"),
];

fn default_languages() -> Vec<String> {
    ["ethi/dflt", "ethi/AMH", "ethi/TGY", "ethi/GEZ", "latn/dflt"].map(String::from).to_vec()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Features {
    /// Hand-written feature code.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub code: String,
    /// Glyph classes by name: characters or glyph names.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub classes: BTreeMap<String, Vec<String>>,
    /// Language systems, as `script/language`.
    #[serde(default = "default_languages")]
    pub languages: Vec<String>,
    /// Names of stylistic sets, by feature tag (`ss01`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub set_names: BTreeMap<String, String>,
}

impl Default for Features {
    fn default() -> Self {
        Features {
            code: String::new(),
            classes: BTreeMap::new(),
            languages: default_languages(),
            set_names: BTreeMap::new(),
        }
    }
}

impl Features {
    pub fn is_default(&self) -> bool {
        *self == Features::default()
    }
}

/// AGL-style production name: uni1200, or u1F600 past the BMP.
pub fn glyph_name(c: char) -> String {
    match c {
        ' ' => "space".into(),
        _ => {
            let cp = c as u32;
            if cp <= 0xFFFF {
                format!("uni{cp:04X}")
            } else {
                format!("u{cp:05X}")
            }
        }
    }
}

/// A name the feature syntax accepts: letters, digits, `.`, `_` and `-`.
pub fn fea_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect();
    match s.chars().next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => s,
        _ => format!("_{s}"),
    }
}

/// The feature-file name of a kerning class.
pub fn kern_class_name(side: KernSide, name: &str) -> String {
    let p = match side {
        KernSide::Left => "L",
        KernSide::Right => "R",
    };
    format!("{p}.{}", fea_name(name))
}

/// Characters in code become glyph names. Comments and strings are kept.
pub fn names_for_characters(code: &str) -> String {
    let mut out = String::with_capacity(code.len());
    let mut chars = code.chars().peekable();
    let (mut comment, mut string) = (false, false);
    while let Some(c) = chars.next() {
        match c {
            '\n' => comment = false,
            '#' if !string => comment = true,
            '"' if !comment => string = !string,
            _ => {}
        }
        if comment || string || c.is_ascii() || c.is_whitespace() {
            out.push(c);
            continue;
        }
        out.push_str(&glyph_name(c));
        if chars.peek().is_some_and(|n| !n.is_ascii() && !n.is_whitespace()) {
            out.push(' ');
        }
    }
    out
}

/// A class member: a single character, or a glyph name.
fn member_name(m: &str) -> String {
    let mut cs = m.chars();
    match (cs.next(), cs.next()) {
        (Some(c), None) if !c.is_ascii() => glyph_name(c),
        _ => names_for_characters(m),
    }
}

/// The joined feature file.
#[derive(Debug, Clone, PartialEq)]
pub struct FeaSource {
    pub text: String,
    /// Byte offset where the hand-written code starts.
    pub code_start: usize,
    /// Line (from 0) where the hand-written code starts.
    pub code_line: usize,
}

impl FeaSource {
    /// A byte offset as a line and column in the hand-written code (both
    /// from 1), or None when it falls in the generated part.
    pub fn code_position(&self, offset: usize) -> Option<(usize, usize)> {
        if offset < self.code_start {
            return None;
        }
        let before = &self.text[self.code_start..offset.min(self.text.len())];
        let line = before.matches('\n').count() + 1;
        let col = before.rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1;
        Some((line, col))
    }
}

/// Insert `featureNames` into stylistic sets that have a name and none
/// written. Stays on the same line, so line numbers hold.
fn name_sets(code: &str, names: &BTreeMap<String, String>) -> String {
    let mut code = code.to_string();
    for (tag, name) in names {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let head = format!("feature {tag}");
        let Some(at) = code.find(&head) else { continue };
        let Some(brace) = code[at..].find('{').map(|b| at + b) else { continue };
        let end = code[brace..].find(&format!("}} {tag}")).map_or(code.len(), |e| brace + e);
        if code[brace..end].contains("featureNames") {
            continue;
        }
        let escaped = name.replace('\\', "\\\\").replace('"', "\\\"");
        code.insert_str(brace + 1, &format!(" featureNames {{ name \"{escaped}\"; }};"));
    }
    code
}

impl Project {
    /// The whole feature file: language systems, classes, kerning, then
    /// the hand-written code. `has` says which characters are in the font;
    /// classes and pairs drop the rest.
    pub fn feature_source(&self, has: &dyn Fn(char) -> bool) -> FeaSource {
        let f = &self.features;
        let mut t = String::from("# Generated from the project\nlanguagesystem DFLT dflt;\n");
        let known = |s: &str| LANGUAGES.iter().any(|(sc, l, _)| format!("{sc}/{l}") == s);
        let mut langs: Vec<&String> = f.languages.iter().filter(|s| known(s)).collect();
        // A script's default comes first.
        langs.sort_by_key(|s| {
            let (sc, l) = s.split_once('/').unwrap_or(("", ""));
            (sc != "ethi", sc.to_string(), l != "dflt")
        });
        let mut scripts: Vec<&str> = Vec::new();
        for s in &langs {
            let (sc, l) = s.split_once('/').unwrap_or(("", ""));
            if l != "dflt" && !scripts.contains(&sc) {
                t.push_str(&format!("languagesystem {sc} dflt;\n"));
            }
            scripts.push(sc);
            t.push_str(&format!("languagesystem {sc} {l};\n"));
        }

        let list = |chars: &[char]| -> Vec<String> {
            chars.iter().filter(|&&c| has(c)).map(|&c| glyph_name(c)).collect()
        };
        let mut live: Vec<String> = Vec::new();
        for side in [KernSide::Left, KernSide::Right] {
            for (name, members) in self.kerning.classes(side) {
                let names = list(members);
                if names.is_empty() {
                    continue;
                }
                t.push_str(&format!("@{} = [{}];\n", kern_class_name(side, name), names.join(" ")));
                live.push(format!("{side:?}/{name}"));
            }
        }
        for (name, members) in &f.classes {
            let names: Vec<String> = members
                .iter()
                .filter(|m| {
                    let mut cs = m.chars();
                    match (cs.next(), cs.next()) {
                        (Some(c), None) if !c.is_ascii() => has(c),
                        _ => !m.trim().is_empty(),
                    }
                })
                .map(|m| member_name(m))
                .collect();
            t.push_str(&format!("@{} = [{}];\n", fea_name(name), names.join(" ")));
        }

        let side_name = |s: &str, side: KernSide| -> Option<String> {
            match s.strip_prefix('@') {
                Some(n) => {
                    live.contains(&format!("{side:?}/{n}")).then(|| format!("@{}", kern_class_name(side, n)))
                }
                None => {
                    let c = s.chars().next()?;
                    has(c).then(|| glyph_name(c))
                }
            }
        };
        let mut kern = String::new();
        let (glyph_pairs, _) = self.kerning.flatten();
        for (l, r, v) in glyph_pairs {
            if has(l) && has(r) {
                kern.push_str(&format!("  pos {} {} {v};\n", glyph_name(l), glyph_name(r)));
            }
        }
        for p in &self.kerning.pairs {
            if !(p.left.starts_with('@') && p.right.starts_with('@')) {
                continue;
            }
            if let (Some(l), Some(r)) =
                (side_name(&p.left, KernSide::Left), side_name(&p.right, KernSide::Right))
            {
                kern.push_str(&format!("  pos {l} {r} {};\n", p.value));
            }
        }
        if !kern.is_empty() {
            t.push_str(&format!("feature kern {{\n{kern}}} kern;\n"));
        }

        t.push_str("# Your code\n");
        let code_start = t.len();
        let code_line = t.matches('\n').count();
        t.push_str(&names_for_characters(&name_sets(&f.code, &f.set_names)));
        t.push('\n');
        FeaSource { text: t, code_start, code_line }
    }
}

/// The feature tags a feature file defines, in order.
pub fn feature_tags(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("");
        let mut words = line.split_whitespace();
        while let Some(w) = words.next() {
            if w == "feature" {
                if let Some(tag) = words.next() {
                    let tag = tag.trim_end_matches('{').trim_end_matches(';');
                    if tag.len() == 4
                        && tag.chars().all(|c| c.is_ascii_alphanumeric())
                        && !out.iter().any(|t| t == tag)
                    {
                        out.push(tag.to_string());
                    }
                }
            }
        }
    }
    out
}
