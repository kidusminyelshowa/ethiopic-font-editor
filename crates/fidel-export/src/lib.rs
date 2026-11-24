//! Flattens a fidel project into an installable font.
//!
//! Every fidel that resolves to at least one contour becomes a glyph mapped to
//! its codepoint. Undrawn fidel are left out, so the operating system falls
//! back to another font for them instead of showing empty boxes.
//!
//! Outlines are written as TrueType (`glyf`) quadratics: the cubic contours
//! from the editor are converted within [`CURVE_ACCURACY`] font units. This is
//! the same conversion fontmake and fontc make for TTF output.

use fidel_core::geometry::{Contour, PointKind, Vec2};
use fidel_core::{Order, Project};
use kurbo::{BezPath, CubicBez, Point};
use write_fonts::read::collections::IntSet;
use write_fonts::tables::cmap::Cmap;
use write_fonts::tables::glyf::{Bbox, GlyfLocaBuilder, Glyph, SimpleGlyph};
use write_fonts::tables::gpos::builders::{PairPosBuilder, ValueRecordBuilder};
use write_fonts::tables::gpos::{Gpos, PositionLookup, PositionLookupList};
use write_fonts::tables::head::{Flags, Head, MacStyle};
use write_fonts::tables::hhea::Hhea;
use write_fonts::tables::hmtx::{Hmtx, LongMetric};
use write_fonts::tables::layout::builders::{Builder, LookupBuilder};
use write_fonts::tables::layout::{
    Feature, FeatureList, FeatureRecord, LangSys, LookupFlag, Script, ScriptList, ScriptRecord,
};
use write_fonts::tables::loca::LocaFormat;
use write_fonts::tables::maxp::Maxp;
use write_fonts::tables::name::{Name, NameRecord};
use write_fonts::tables::os2::{Os2, SelectionFlags};
use write_fonts::tables::post::Post;
use write_fonts::tables::variations::ivs_builder::VariationStoreBuilder;
use write_fonts::types::{FWord, Fixed, GlyphId, GlyphId16, LongDateTime, NameId, Tag, UfWord};
use write_fonts::{FontBuilder, OffsetMarker};

mod variable;
pub use variable::{export_instance, export_variable, VariableFont};

/// Largest distance, in font units, between a cubic and its quadratic stand-in.
pub const CURVE_ACCURACY: f64 = 0.5;

/// Seconds between 1904-01-01 (the OpenType epoch) and 1970-01-01.
const EPOCH_1904_TO_1970: i64 = 2_082_844_800;

#[derive(Debug, Clone)]
pub struct ExportOptions {
    /// Family name shown in font menus.
    pub family_name: String,
    /// Style name, e.g. "Regular".
    pub style_name: String,
    /// Font version, shown as "Version 1.000".
    pub version: f64,
    /// Creation time in seconds since 1970. Changing it between test exports
    /// helps operating systems notice a reinstalled font.
    pub timestamp: i64,
    /// Written as the font's designer (name ID 9) when not empty.
    pub designer: String,
}

impl ExportOptions {
    pub fn new(family_name: impl Into<String>) -> Self {
        Self {
            family_name: family_name.into(),
            style_name: "Regular".into(),
            version: 1.0,
            timestamp: 0,
            designer: String::new(),
        }
    }
}

/// The font file and what went into it.
#[derive(Debug, Clone)]
pub struct ExportedFont {
    pub bytes: Vec<u8>,
    /// Fidel that were drawn and exported.
    pub exported: Vec<char>,
    /// Fidel left out because nothing is drawn for them yet.
    pub skipped: Vec<char>,
}

#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error("nothing is drawn yet, so there is nothing to export")]
    NothingDrawn,
    #[error("the family name is empty")]
    NoFamilyName,
    #[error("the outline of {glyph} could not be converted: {reason}")]
    BadOutline { glyph: String, reason: String },
    #[error("too many glyphs for one font")]
    TooManyGlyphs,
    #[error("could not write the font: {0}")]
    Write(String),
    #[error("{0}")]
    Design(String),
}

struct GlyphOut {
    name: String,
    codepoint: Option<char>,
    advance: u16,
    glyph: Glyph,
}

pub fn export(project: &Project, options: &ExportOptions) -> Result<ExportedFont, ExportError> {
    let family = options.family_name.trim();
    if family.is_empty() {
        return Err(ExportError::NoFamilyName);
    }
    let mut glyphs = fixed_glyphs(project);
    let mut exported = Vec::new();
    let mut skipped = Vec::new();

    for (ch, outline, advance) in collect_items(project) {
        // Open paths are working lines, not part of the glyph.
        let contours: Vec<&Contour> = outline.iter().filter(|c| !c.open && c.points.len() >= 2).collect();
        if contours.is_empty() {
            skipped.push(ch);
            continue;
        }
        let name = glyph_name(ch);
        let glyph = simple_glyph(&contours)
            .map_err(|reason| ExportError::BadOutline { glyph: format!("{ch} ({name})"), reason })?;
        glyphs.push(GlyphOut { name, codepoint: Some(ch), advance: to_u16(advance), glyph });
        exported.push(ch);
    }
    if exported.is_empty() {
        return Err(ExportError::NothingDrawn);
    }
    let bytes = build(project, options, family, &glyphs, None)?;
    Ok(ExportedFont { bytes, exported, skipped })
}

/// The first two glyphs of every font: .notdef and the space.
fn fixed_glyphs(project: &Project) -> Vec<GlyphOut> {
    let upm = project.metrics.units_per_em;
    vec![
        notdef(f64::from(upm)),
        GlyphOut {
            name: "space".into(),
            codepoint: Some(' '),
            advance: project.info.space_advance(upm).round() as u16,
            glyph: Glyph::Empty,
        },
    ]
}

/// Every fidel and symbol in the project's character sets, by codepoint,
/// with its outline and advance.
fn collect_items(project: &Project) -> Vec<(char, Vec<Contour>, f64)> {
    let mut items: Vec<(char, Vec<Contour>, f64)> = Order::ALL
        .iter()
        .chain(Order::EXTRA.iter())
        .flat_map(|&o| project.resolve_order(o))
        .filter_map(|f| {
            let ch = f.codepoint?;
            Some((ch, f.contours.into_iter().map(|c| c.contour).collect(), f.advance_width))
        })
        .chain(
            project.symbols.values().map(|s| (s.codepoint, project.symbol_outline(&s.id), s.advance_width)),
        )
        .filter(|(ch, ..)| project.in_charset(*ch))
        .collect();
    items.sort_by_key(|(ch, ..)| *ch);
    items.dedup_by_key(|(ch, ..)| *ch);
    items
}

fn build(
    project: &Project,
    options: &ExportOptions,
    family: &str,
    glyphs: &[GlyphOut],
    var: Option<variable::VarTables>,
) -> Result<Vec<u8>, ExportError> {
    let write_err = |e: &dyn std::fmt::Display| ExportError::Write(e.to_string());
    let metrics = &project.metrics;
    let upm = metrics.units_per_em;
    let upm_f = f64::from(upm);
    let num_glyphs = u16::try_from(glyphs.len()).map_err(|_| ExportError::TooManyGlyphs)?;

    // glyf + loca, and the numbers other tables need.
    let mut builder = GlyfLocaBuilder::new();
    let mut font_box: Option<Bbox> = None;
    let mut h_metrics = Vec::new();
    let (mut max_points, mut max_contours) = (0u16, 0u16);
    let (mut min_lsb, mut min_rsb, mut max_extent) = (i16::MAX, i16::MAX, i16::MIN);
    let mut advance_max = 0u16;
    for g in glyphs {
        builder.add_glyph(&g.glyph).map_err(|e| write_err(&e))?;
        advance_max = advance_max.max(g.advance);
        let lsb = match &g.glyph {
            Glyph::Simple(s) => {
                let b = s.bbox;
                font_box = Some(match font_box {
                    None => b,
                    Some(f) => Bbox {
                        x_min: f.x_min.min(b.x_min),
                        y_min: f.y_min.min(b.y_min),
                        x_max: f.x_max.max(b.x_max),
                        y_max: f.y_max.max(b.y_max),
                    },
                });
                let points: usize = s.contours.iter().map(|c| c.len()).sum();
                max_points = max_points.max(points as u16);
                max_contours = max_contours.max(s.contours.len() as u16);
                min_lsb = min_lsb.min(b.x_min);
                min_rsb = min_rsb.min((i32::from(g.advance) - i32::from(b.x_max)) as i16);
                max_extent = max_extent.max(b.x_max);
                b.x_min
            }
            _ => 0,
        };
        h_metrics.push(LongMetric::new(g.advance, lsb));
    }
    let (glyf, loca, loca_format) = builder.build();
    let font_box = font_box.unwrap_or_default();

    // Vertical metrics: room for the tallest and deepest outline, and at
    // least the usual 80/20 split of the em.
    let ascender = font_box.y_max.max((upm_f * 0.8).round() as i16);
    let descender = font_box.y_min.min(-(upm_f * 0.2).round() as i16);
    let line_gap = (upm_f * 0.2).round() as i16;
    let pa_top = to_i16(metrics.pa_top);

    let time = LongDateTime::new(options.timestamp + EPOCH_1904_TO_1970);
    let head = Head::new(
        Fixed::from_f64(options.version),
        0,
        Flags::BASELINE_AT_Y_0 | Flags::LSB_AT_X_0,
        upm,
        time,
        time,
        font_box.x_min,
        font_box.y_min,
        font_box.x_max,
        font_box.y_max,
        MacStyle::empty(),
        8,
        match loca_format {
            LocaFormat::Short => 0,
            LocaFormat::Long => 1,
        },
    );

    let hhea = Hhea::new(
        FWord::new(ascender),
        FWord::new(descender),
        FWord::new(line_gap),
        UfWord::new(advance_max),
        FWord::new(if min_lsb == i16::MAX { 0 } else { min_lsb }),
        FWord::new(if min_rsb == i16::MAX { 0 } else { min_rsb }),
        FWord::new(if max_extent == i16::MIN { 0 } else { max_extent }),
        1,
        0,
        0,
        num_glyphs,
    );

    let maxp = Maxp {
        num_glyphs,
        max_points: Some(max_points),
        max_contours: Some(max_contours),
        max_composite_points: Some(0),
        max_composite_contours: Some(0),
        max_zones: Some(1),
        max_twilight_points: Some(0),
        max_storage: Some(0),
        max_function_defs: Some(0),
        max_instruction_defs: Some(0),
        max_stack_elements: Some(0),
        max_size_of_instructions: Some(0),
        max_component_elements: Some(0),
        max_component_depth: Some(0),
    };

    let hmtx = Hmtx::new(h_metrics, Vec::new());

    let mappings: Vec<(char, GlyphId)> = glyphs
        .iter()
        .enumerate()
        .filter_map(|(i, g)| g.codepoint.map(|c| (c, GlyphId::new(i as u32))))
        .collect();
    let first_char = mappings.iter().map(|(c, _)| *c as u32).min().unwrap_or(0x20);
    let last_char = mappings.iter().map(|(c, _)| *c as u32).max().unwrap_or(0x20);
    let gpos = kern_table(project, &mappings);
    let cmap = Cmap::from_mappings(mappings).map_err(|e| write_err(&e))?;

    let avg_width = {
        let drawn: Vec<u32> = glyphs.iter().filter(|g| g.advance > 0).map(|g| u32::from(g.advance)).collect();
        (drawn.iter().sum::<u32>() / drawn.len().max(1) as u32) as i16
    };
    let os2 = Os2 {
        x_avg_char_width: avg_width,
        us_weight_class: 400,
        us_width_class: 5,
        fs_type: 0,
        y_subscript_x_size: (upm_f * 0.65).round() as i16,
        y_subscript_y_size: (upm_f * 0.6).round() as i16,
        y_subscript_y_offset: (upm_f * 0.075).round() as i16,
        y_superscript_x_size: (upm_f * 0.65).round() as i16,
        y_superscript_y_size: (upm_f * 0.6).round() as i16,
        y_superscript_y_offset: (upm_f * 0.35).round() as i16,
        y_strikeout_size: (upm_f * 0.05).round() as i16,
        y_strikeout_position: (f64::from(pa_top) * 0.5).round() as i16,
        // Basic Latin (bit 0, for the space) and Ethiopic (bit 75).
        ul_unicode_range_1: 1,
        ul_unicode_range_3: 1 << (75 - 64),
        ach_vend_id: Tag::new(b"NONE"),
        fs_selection: SelectionFlags::REGULAR | SelectionFlags::USE_TYPO_METRICS,
        us_first_char_index: first_char.min(0xFFFF) as u16,
        us_last_char_index: last_char.min(0xFFFF) as u16,
        s_typo_ascender: ascender,
        s_typo_descender: descender,
        s_typo_line_gap: line_gap,
        us_win_ascent: ascender.max(0) as u16,
        us_win_descent: descender.unsigned_abs(),
        ul_code_page_range_1: Some(1),
        ul_code_page_range_2: Some(0),
        sx_height: Some(pa_top),
        s_cap_height: Some(pa_top),
        us_default_char: Some(0),
        us_break_char: Some(0x20),
        us_max_context: Some(0),
        ..Default::default()
    };

    let style = options.style_name.trim();
    let style = if style.is_empty() { "Regular" } else { style };
    let full = if style == "Regular" { family.to_string() } else { format!("{family} {style}") };
    let ps_name = postscript_name(family, style);
    let version = format!("Version {:.3}", options.version);
    let mut records: Vec<(u16, String)> = vec![
        (1, family.to_string()),
        (2, style.to_string()),
        (3, format!("{version};NONE;{ps_name};{}", options.timestamp)),
        (4, full),
        (5, version),
        (6, ps_name),
    ];
    if !options.designer.trim().is_empty() {
        records.push((9, options.designer.trim().to_string()));
    }
    if let Some(v) = &var {
        records.extend(v.names.iter().cloned());
    }
    records.sort_by_key(|(id, _)| *id);
    let name = Name::new(
        records
            .into_iter()
            .map(|(id, s)| NameRecord::new(3, 1, 0x409, NameId::new(id), OffsetMarker::new(s)))
            .collect(),
    );

    let mut post = Post::new_v2(glyphs.iter().map(|g| g.name.as_str()));
    post.underline_position = FWord::new(-(upm_f * 0.1).round() as i16);
    post.underline_thickness = FWord::new((upm_f * 0.05).round() as i16);

    let mut font = FontBuilder::new();
    font.add_table(&head)
        .and_then(|f| f.add_table(&hhea))
        .and_then(|f| f.add_table(&maxp))
        .and_then(|f| f.add_table(&os2))
        .and_then(|f| f.add_table(&hmtx))
        .and_then(|f| f.add_table(&cmap))
        .and_then(|f| f.add_table(&name))
        .and_then(|f| f.add_table(&post))
        .and_then(|f| f.add_table(&loca))
        .and_then(|f| f.add_table(&glyf))
        .map_err(|e| write_err(&e))?;
    if let Some(gpos) = &gpos {
        font.add_table(gpos).map_err(|e| write_err(&e))?;
    }
    if let Some(v) = var {
        v.add_to(&mut font).map_err(|e| write_err(&e))?;
    }
    Ok(font.build())
}

/// The `kern` feature: glyph pairs (exceptions included) first, then class
/// pairs, in one lookup, so a glyph pair wins over its class pair. Pairs whose
/// glyphs are not exported are left out. `None` when nothing is kerned.
fn kern_table(project: &Project, mappings: &[(char, GlyphId)]) -> Option<Gpos> {
    let gid =
        |c: char| mappings.iter().find(|(m, _)| *m == c).and_then(|(_, g)| GlyphId16::try_from(*g).ok());
    let advance =
        |v: i32| ValueRecordBuilder::new().with_x_advance(v.clamp(i16::MIN.into(), i16::MAX.into()) as i16);
    let (glyph_pairs, class_pairs) = project.kerning.flatten();
    let mut pairs = PairPosBuilder::default();
    for (l, r, v) in glyph_pairs {
        if let (Some(l), Some(r)) = (gid(l), gid(r)) {
            pairs.insert_pair(l, advance(v), r, ValueRecordBuilder::new());
        }
    }
    for (l, r, v) in class_pairs {
        let set = |m: &[char]| m.iter().filter_map(|&c| gid(c)).collect::<IntSet<GlyphId16>>();
        let (l, r) = (set(l), set(r));
        if !l.is_empty() && !r.is_empty() {
            pairs.insert_classes(l, advance(v), r, ValueRecordBuilder::new());
        }
    }
    if pairs.is_empty() {
        return None;
    }
    let lookup = LookupBuilder::new_with_lookups(LookupFlag::empty(), None, vec![pairs]);
    let lookup = lookup.build(&mut VariationStoreBuilder::new(0));
    let lang = || Script::new(Some(LangSys::new(vec![0])), Vec::new());
    let scripts = ScriptList::new(vec![
        ScriptRecord::new(Tag::new(b"DFLT"), lang()),
        ScriptRecord::new(Tag::new(b"ethi"), lang()),
    ]);
    let features = FeatureList::new(vec![FeatureRecord::new(Tag::new(b"kern"), Feature::new(None, vec![0]))]);
    Some(Gpos::new(scripts, features, PositionLookupList::new(vec![PositionLookup::Pair(lookup)])))
}

/// A box with a hole: the usual .notdef.
fn notdef(upm: f64) -> GlyphOut {
    let w = (upm * 0.5).round();
    let h = (upm * 0.7).round();
    let m = (upm * 0.05).round();
    let s = (upm * 0.05).round();
    let mut path = BezPath::new();
    rect(&mut path, m, 0.0, w - m, h, true);
    rect(&mut path, m + s, s, w - m - s, h - s, false);
    let glyph = SimpleGlyph::from_bezpath(&path).map(Glyph::Simple).unwrap_or(Glyph::Empty);
    GlyphOut { name: ".notdef".into(), codepoint: None, advance: w as u16, glyph }
}

fn rect(path: &mut BezPath, x0: f64, y0: f64, x1: f64, y1: f64, clockwise: bool) {
    let corners = if clockwise {
        [(x0, y0), (x0, y1), (x1, y1), (x1, y0)]
    } else {
        [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    };
    path.move_to(corners[0]);
    for c in &corners[1..] {
        path.line_to(*c);
    }
    path.close_path();
}

fn simple_glyph(contours: &[&Contour]) -> Result<Glyph, String> {
    let mut path = BezPath::new();
    for c in contours {
        append_quadratic(&mut path, c)?;
    }
    if path.elements().is_empty() {
        return Ok(Glyph::Empty);
    }
    let mut glyph = SimpleGlyph::from_bezpath(&path).map_err(|e| format!("{e:?}"))?;
    // Alterations are drawn as separate contours that overlap the base, so
    // tell renderers not to treat the overlap as an error.
    glyph.overlaps = contours.len() > 1;
    Ok(Glyph::Simple(glyph))
}

/// Append one closed contour, turning cubic segments into quadratics.
fn append_quadratic(path: &mut BezPath, contour: &Contour) -> Result<(), String> {
    let pts = &contour.points;
    let n = pts.len();
    let start = pts.iter().position(|p| p.kind != PointKind::OffCurve).ok_or("no on-curve point")?;
    let p = |v: Vec2| Point::new(v.x, v.y);
    let mut current = p(pts[start].pos);
    path.move_to(current);
    let mut handles: Vec<Point> = Vec::new();
    for i in 1..=n {
        let pt = &pts[(start + i) % n];
        match pt.kind {
            PointKind::OffCurve => handles.push(p(pt.pos)),
            PointKind::Curve if handles.len() == 2 => {
                let end = p(pt.pos);
                let cubic = CubicBez::new(current, handles[0], handles[1], end);
                for quad in to_quadratics(cubic) {
                    path.quad_to(quad.p1, quad.p2);
                }
                current = end;
                handles.clear();
            }
            _ => {
                if !handles.is_empty() {
                    return Err("handles before a line point".into());
                }
                let end = p(pt.pos);
                // The closing segment back to the start is implied.
                if i < n && end != current {
                    path.line_to(end);
                }
                current = end;
            }
        }
    }
    path.close_path();
    Ok(())
}

fn to_quadratics(cubic: CubicBez) -> Vec<kurbo::QuadBez> {
    // A straight cubic (handles on the line) needs no curve at all.
    if let Some(spline) = kurbo::cubics_to_quadratic_splines(&[cubic], CURVE_ACCURACY) {
        if let Some(s) = spline.first() {
            return s.to_quads().collect();
        }
    }
    cubic.to_quads(CURVE_ACCURACY).map(|(_, _, q)| q).collect()
}

/// AGL-style name: uni1200.
pub fn glyph_name(c: char) -> String {
    let cp = c as u32;
    if cp <= 0xFFFF {
        format!("uni{cp:04X}")
    } else {
        format!("u{cp:05X}")
    }
}

fn postscript_name(family: &str, style: &str) -> String {
    let clean = |s: &str| -> String {
        s.chars().filter(|c| c.is_ascii_graphic() && !"[](){}<>/%".contains(*c)).collect()
    };
    let mut name = format!("{}-{}", clean(family), clean(style));
    if name.starts_with('-') {
        name.insert_str(0, "Untitled");
    }
    name.truncate(63);
    name
}

fn to_u16(v: f64) -> u16 {
    v.round().clamp(0.0, f64::from(u16::MAX)) as u16
}

fn to_i16(v: f64) -> i16 {
    v.round().clamp(f64::from(i16::MIN), f64::from(i16::MAX)) as i16
}
