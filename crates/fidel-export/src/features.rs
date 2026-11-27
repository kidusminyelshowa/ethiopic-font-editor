//! Compiling the project's feature file into GSUB, GPOS and GDEF.

use fea_rs::compile::{NopFeatureProvider, NopVariationInfo, Opts};
use fea_rs::{DiagnosticSet, GlyphMap};
use fidel_core::features::{glyph_name, FeaSource};
use fidel_core::Project;
use serde::Serialize;
use write_fonts::read::{FontRef, TableProvider};
use write_fonts::types::Tag;

/// One problem in the feature code.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FeatureMessage {
    /// Line and column in the hand-written code (from 1); None when it is in
    /// the generated part.
    pub line: Option<usize>,
    pub column: Option<usize>,
    pub message: String,
    pub error: bool,
}

/// Compiled layout tables, as bytes by tag.
pub struct Layout {
    pub tables: Vec<(Tag, Vec<u8>)>,
    pub warnings: Vec<FeatureMessage>,
    /// Names the features point at (stylistic set names), by name ID.
    pub names: Vec<(u16, String)>,
    /// Features the font has, in order.
    pub tags: Vec<String>,
}

fn messages(src: &FeaSource, set: &DiagnosticSet) -> Vec<FeatureMessage> {
    set.diagnostics()
        .iter()
        .map(|d| {
            let span = d.span();
            let pos = src.code_position(span.start);
            let what = src.text.get(span.clone()).unwrap_or("").trim();
            let mut message = d.text().to_string();
            if !what.is_empty() && what.len() <= 40 && !what.contains('\n') {
                message = format!("{message}: {what}");
            }
            if let Some(first) = message.get(..1) {
                message = first.to_uppercase() + &message[1..];
            }
            FeatureMessage { line: pos.map(|p| p.0), column: pos.map(|p| p.1), message, error: d.is_error() }
        })
        .collect()
}

/// The names of the glyphs a font of these characters has, in glyph order:
/// .notdef, space, then one per character.
pub fn glyph_order(chars: &[char]) -> Vec<String> {
    let mut names = vec![".notdef".to_string(), "space".to_string()];
    names.extend(chars.iter().filter(|&&c| c != ' ').map(|&c| glyph_name(c)));
    names
}

/// Compile the project's features against a glyph order. Names the
/// features need take IDs from `first_name_id`.
pub fn compile(
    project: &Project,
    names: &[String],
    first_name_id: u16,
) -> Result<Layout, Vec<FeatureMessage>> {
    let has = |c: char| {
        let n = glyph_name(c);
        names.contains(&n)
    };
    let src = project.feature_source(&has);
    let fail = |message: String| vec![FeatureMessage { line: None, column: None, message, error: true }];
    let glyph_map = GlyphMap::new(names.iter().map(String::as_str)).map_err(|e| fail(e.to_string()))?;
    let (tree, parse) = fea_rs::parse::parse_string(src.text.clone());
    if parse.has_errors() {
        return Err(messages(&src, &parse));
    }
    // The compiler expects code that validates.
    let checked = fea_rs::compile::validate::<NopVariationInfo>(&tree, &glyph_map, None);
    if checked.has_errors() {
        return Err(messages(&src, &checked));
    }
    let run = std::panic::catch_unwind(|| {
        fea_rs::compile::compile::<NopVariationInfo, NopFeatureProvider>(
            &tree,
            &glyph_map,
            None,
            None,
            Opts::new(),
        )
    })
    .map_err(|_| fail("the feature compiler stopped on this code".into()))?;
    let (mut compilation, warnings) = run.map_err(|e| messages(&src, &e))?;
    compilation.remap_name_ids(first_name_id);
    let bytes = compilation.to_binary(&glyph_map).map_err(|e| fail(e.to_string()))?;
    let font = FontRef::new(&bytes).map_err(|e| fail(e.to_string()))?;
    let mut feature_names = Vec::new();
    if let Ok(name) = font.name() {
        for r in name.name_record() {
            let id = r.name_id().to_u16();
            if r.platform_id() == 3 && id >= first_name_id {
                if let Ok(s) = r.string(name.string_data()) {
                    feature_names.push((id, s.chars().collect::<String>()));
                }
            }
        }
    }
    let mut tables = Vec::new();
    for tag in [b"GDEF", b"GSUB", b"GPOS"] {
        let tag = Tag::new(tag);
        if let Some(data) = font.table_data(tag) {
            tables.push((tag, data.as_bytes().to_vec()));
        }
    }
    let mut all = messages(&src, &parse);
    all.extend(messages(&src, &checked));
    all.extend(messages(&src, &warnings));
    Ok(Layout {
        tables,
        warnings: all,
        names: feature_names,
        tags: fidel_core::features::feature_tags(&src.text),
    })
}

/// The project's features checked against what it would export.
pub fn check(project: &Project) -> Result<Layout, Vec<FeatureMessage>> {
    compile(project, &glyph_order(&crate::exported_chars(project)), 256)
}
