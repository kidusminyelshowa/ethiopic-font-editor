//! Opening existing fonts for reference and migration: OpenType and
//! TrueType (also inside WOFF), UFO, and a designspace with its UFO masters.
//!
//! A new project always starts from the fidel model, so an import fills it:
//! each Ge'ez base letter's outline goes to its base, symbols to symbols,
//! and every other fidel goes behind its drawing as a background to
//! rebuild from. Or everything goes to backgrounds only.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use fidel_core::designspace::Axis;
use fidel_core::geometry::{Contour, Point, PointKind, Vec2};
use fidel_core::kerning::KernPair;
use fidel_core::order::Order;
use fidel_core::{DrawingTarget, Project};
use quick_xml::events::Event;
use serde::Serialize;
use skrifa::instance::{LocationRef, Size};
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::{FontRef, MetadataProvider};

#[derive(Debug, Clone, Default)]
pub struct ImportedGlyph {
    pub contours: Vec<Contour>,
    pub advance: f64,
    pub anchors: BTreeMap<String, Vec2>,
}

#[derive(Debug, Clone, Default)]
pub struct ImportedFont {
    pub upm: f64,
    pub glyphs: BTreeMap<char, ImportedGlyph>,
    pub kerning: Vec<(char, char, f64)>,
}

/// A source of a designspace: where it sits and what it draws.
#[derive(Debug, Clone)]
pub struct ImportedSource {
    pub name: String,
    /// Design units by axis tag.
    pub location: BTreeMap<String, f64>,
    pub font: ImportedFont,
}

#[derive(Debug, Clone, Default)]
pub struct Imported {
    pub axes: Vec<Axis>,
    /// The first is the default.
    pub sources: Vec<ImportedSource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    /// Bases and symbols take the outlines; other fidels get backgrounds.
    Drawings,
    /// Every glyph goes behind its drawing; nothing drawn changes.
    Backgrounds,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ImportReport {
    pub drawn: usize,
    pub backgrounds: usize,
    pub kept: usize,
    pub unused: usize,
    pub kerning: usize,
    pub masters: usize,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ---------- Outlines ----------

/// Builds cubic contours from pen calls, quadratics raised to cubics.
#[derive(Default)]
struct Pen {
    out: Vec<Contour>,
    pts: Vec<Point>,
    start: Vec2,
    last: Vec2,
}

impl Pen {
    fn id(&self) -> u32 {
        self.pts.len() as u32
    }
    fn on(&mut self, kind: PointKind, p: Vec2) {
        let id = self.id();
        self.pts.push(Point { id, pos: p, kind, smooth: false });
        self.last = p;
    }
    fn off(&mut self, p: Vec2) {
        let id = self.id();
        self.pts.push(Point { id, pos: p, kind: PointKind::OffCurve, smooth: false });
    }
    fn finish(&mut self) {
        if self.pts.len() > 1 {
            // The closing segment ends on the start point: drop the repeat,
            // and a curve's handles stay at the end of the list.
            let n = self.pts.len();
            if self.pts[n - 1].pos == self.start && self.pts[n - 1].kind != PointKind::OffCurve {
                let closing = self.pts.pop().expect("not empty");
                self.pts[0].kind = closing.kind;
            }
            if self.pts.len() >= 2 {
                for (i, p) in self.pts.iter_mut().enumerate() {
                    p.id = i as u32;
                }
                let id = self.out.len() as u32;
                self.out.push(Contour::new(id, None, std::mem::take(&mut self.pts)));
            }
        }
        self.pts.clear();
    }
}

impl OutlinePen for Pen {
    fn move_to(&mut self, x: f32, y: f32) {
        self.finish();
        let p = Vec2::new(x.into(), y.into());
        self.start = p;
        self.on(PointKind::Line, p);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.on(PointKind::Line, Vec2::new(x.into(), y.into()));
    }
    fn quad_to(&mut self, cx: f32, cy: f32, x: f32, y: f32) {
        let (p0, q, p1) = (self.last, Vec2::new(cx.into(), cy.into()), Vec2::new(x.into(), y.into()));
        self.off(p0 + (q - p0) * (2.0 / 3.0));
        self.off(p1 + (q - p1) * (2.0 / 3.0));
        self.on(PointKind::Curve, p1);
    }
    fn curve_to(&mut self, c0x: f32, c0y: f32, c1x: f32, c1y: f32, x: f32, y: f32) {
        self.off(Vec2::new(c0x.into(), c0y.into()));
        self.off(Vec2::new(c1x.into(), c1y.into()));
        self.on(PointKind::Curve, Vec2::new(x.into(), y.into()));
    }
    fn close(&mut self) {
        self.finish();
    }
}

// ---------- OpenType, TrueType, WOFF ----------

/// WOFF 1.0 unwrapped to the plain font inside.
fn unwoff(data: &[u8]) -> Result<Vec<u8>, String> {
    let be16 = |o: usize| u16::from_be_bytes([data[o], data[o + 1]]);
    let be32 = |o: usize| u32::from_be_bytes([data[o], data[o + 1], data[o + 2], data[o + 3]]);
    if data.len() < 44 {
        return Err("This WOFF file is cut short".into());
    }
    let flavor = be32(4);
    let n = be16(12) as usize;
    let mut tables = Vec::new();
    for i in 0..n {
        let o = 44 + i * 20;
        if o + 20 > data.len() {
            return Err("This WOFF file is cut short".into());
        }
        let (tag, off, comp, orig) =
            (be32(o), be32(o + 4) as usize, be32(o + 8) as usize, be32(o + 12) as usize);
        let raw = data.get(off..off + comp).ok_or("This WOFF file is cut short")?;
        let bytes = if comp < orig {
            miniz_oxide::inflate::decompress_to_vec_zlib(raw).map_err(|_| "A WOFF table would not unpack")?
        } else {
            raw.to_vec()
        };
        tables.push((tag, bytes));
    }
    let mut out = Vec::new();
    out.extend(flavor.to_be_bytes());
    out.extend((n as u16).to_be_bytes());
    out.extend([0u8; 6]);
    let mut offset = 12 + 16 * n;
    let mut body = Vec::new();
    for (tag, bytes) in &tables {
        out.extend(tag.to_be_bytes());
        out.extend(0u32.to_be_bytes());
        out.extend((offset as u32).to_be_bytes());
        out.extend((bytes.len() as u32).to_be_bytes());
        body.extend(bytes);
        while body.len() % 4 != 0 {
            body.push(0);
        }
        offset = 12 + 16 * n + body.len();
    }
    out.extend(body);
    Ok(out)
}

/// The outlines and widths of a compiled font, by character.
pub fn read_binary(data: &[u8]) -> Result<ImportedFont, String> {
    let owned;
    let data = match data.get(..4) {
        Some(b"wOFF") => {
            owned = unwoff(data)?;
            &owned[..]
        }
        Some(b"wOF2") => return Err("WOFF2 is not read yet: open the TTF or OTF it was made from".into()),
        _ => data,
    };
    let font = FontRef::new(data).map_err(|e| format!("Not a font this can read ({e})"))?;
    let upm = font.metrics(Size::unscaled(), LocationRef::default()).units_per_em as f64;
    let outlines = font.outline_glyphs();
    let widths = font.glyph_metrics(Size::unscaled(), LocationRef::default());
    let mut glyphs = BTreeMap::new();
    for (cp, gid) in font.charmap().mappings() {
        let Some(c) = char::from_u32(cp) else { continue };
        let mut pen = Pen::default();
        if let Some(g) = outlines.get(gid) {
            let _ = g.draw(DrawSettings::unhinted(Size::unscaled(), LocationRef::default()), &mut pen);
        }
        pen.finish();
        let advance = widths.advance_width(gid).unwrap_or(0.0) as f64;
        glyphs.insert(c, ImportedGlyph { contours: pen.out, advance, anchors: BTreeMap::new() });
    }
    Ok(ImportedFont { upm, glyphs, kerning: Vec::new() })
}

// ---------- UFO ----------

fn plist_dict(path: &Path) -> Option<plist::Dictionary> {
    plist::Value::from_file(path).ok()?.into_dictionary()
}

struct Glif {
    unicodes: Vec<char>,
    advance: f64,
    /// Points per contour: (x, y, type, smooth).
    contours: Vec<Vec<(f64, f64, String, bool)>>,
    /// Base glyph name and its offset (scale ignored).
    components: Vec<(String, f64, f64)>,
    anchors: BTreeMap<String, Vec2>,
}

fn read_glif(text: &str) -> Result<Glif, String> {
    let mut r = quick_xml::Reader::from_str(text);
    let mut g = Glif {
        unicodes: Vec::new(),
        advance: 0.0,
        contours: Vec::new(),
        components: Vec::new(),
        anchors: BTreeMap::new(),
    };
    loop {
        let ev = r.read_event().map_err(err)?;
        let (e, empty) = match &ev {
            Event::Start(e) => (e, false),
            Event::Empty(e) => (e, true),
            Event::Eof => break,
            _ => continue,
        };
        let _ = empty;
        let attr = |k: &str| -> Option<String> {
            e.attributes().flatten().find(|a| a.key.as_ref() == k).map(|a| {
                a.value
                    .replace("&amp;", "&")
                    .replace("&lt;", "<")
                    .replace("&gt;", ">")
                    .replace("&quot;", "\"")
            })
        };
        let num = |k: &str| attr(k).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
        match e.name().as_ref() {
            "advance" => g.advance = num("width"),
            "unicode" => {
                if let Some(c) =
                    attr("hex").and_then(|h| u32::from_str_radix(&h, 16).ok()).and_then(char::from_u32)
                {
                    g.unicodes.push(c);
                }
            }
            "contour" => g.contours.push(Vec::new()),
            "point" => {
                if let Some(c) = g.contours.last_mut() {
                    c.push((
                        num("x"),
                        num("y"),
                        attr("type").unwrap_or_default(),
                        attr("smooth").as_deref() == Some("yes"),
                    ));
                }
            }
            "component" => {
                if let Some(base) = attr("base") {
                    g.components.push((base, num("xOffset"), num("yOffset")));
                }
            }
            "anchor" => {
                if let Some(n) = attr("name") {
                    g.anchors.insert(n, Vec2::new(num("x"), num("y")));
                }
            }
            _ => {}
        }
    }
    Ok(g)
}

/// A UFO contour's points as a cubic contour.
fn ufo_contour(pts: &[(f64, f64, String, bool)], id: u32) -> Option<Contour> {
    let open = pts.first().is_some_and(|p| p.2 == "move");
    let k = pts.iter().position(|p| !p.2.is_empty())?;
    let mut pts = pts.to_vec();
    if !open {
        pts.rotate_left(k + 1);
    }
    // For a closed contour the list now ends on an on-curve point, and the
    // first segment starts there.
    let mut pen = Pen::default();
    let start = if open { &pts[0] } else { pts.last()? };
    pen.move_to(start.0 as f32, start.1 as f32);
    let body: &[(f64, f64, String, bool)] = if open { &pts[1..] } else { &pts[..] };
    let mut offs: Vec<Vec2> = Vec::new();
    for p in body {
        let v = Vec2::new(p.0, p.1);
        match p.2.as_str() {
            "" | "offcurve" => offs.push(v),
            "curve" => {
                match offs.len() {
                    0 => pen.line_to(v.x as f32, v.y as f32),
                    1 => pen.quad_to(offs[0].x as f32, offs[0].y as f32, v.x as f32, v.y as f32),
                    _ => {
                        let (a, b) = (offs[offs.len() - 2], offs[offs.len() - 1]);
                        pen.curve_to(a.x as f32, a.y as f32, b.x as f32, b.y as f32, v.x as f32, v.y as f32)
                    }
                }
                offs.clear();
            }
            "qcurve" => {
                // Implied on-curve points halfway between handles.
                for w in 0..offs.len() {
                    let q = offs[w];
                    let end = if w + 1 < offs.len() { (q + offs[w + 1]) * 0.5 } else { v };
                    pen.quad_to(q.x as f32, q.y as f32, end.x as f32, end.y as f32);
                }
                if offs.is_empty() {
                    pen.line_to(v.x as f32, v.y as f32);
                }
                offs.clear();
            }
            _ => {
                pen.line_to(v.x as f32, v.y as f32);
                offs.clear();
            }
        }
    }
    pen.finish();
    let mut c = pen.out.pop()?;
    for (p, src) in c
        .points
        .iter_mut()
        .filter(|p| p.kind != PointKind::OffCurve)
        .zip(body.iter().filter(|p| !p.2.is_empty() && p.2 != "offcurve"))
    {
        p.smooth = src.3;
    }
    c.id = id;
    c.open = open;
    Some(c)
}

/// One UFO's glyphs, kerning and size.
pub fn read_ufo(dir: &Path) -> Result<ImportedFont, String> {
    let info = plist_dict(&dir.join("fontinfo.plist"));
    let upm = info
        .as_ref()
        .and_then(|d| d.get("unitsPerEm"))
        .and_then(|v| v.as_real().or(v.as_signed_integer().map(|i| i as f64)))
        .unwrap_or(1000.0);
    let glyph_dir = dir.join("glyphs");
    let contents =
        plist_dict(&glyph_dir.join("contents.plist")).ok_or("This UFO has no glyphs/contents.plist")?;
    let mut glifs: BTreeMap<String, Glif> = BTreeMap::new();
    for (name, file) in &contents {
        let Some(file) = file.as_string() else { continue };
        let text = std::fs::read_to_string(glyph_dir.join(file)).map_err(err)?;
        glifs.insert(name.clone(), read_glif(&text).map_err(|e| format!("{file}: {e}"))?);
    }
    fn outline(name: &str, glifs: &BTreeMap<String, Glif>, depth: usize) -> Vec<Contour> {
        let Some(g) = glifs.get(name) else { return Vec::new() };
        let mut out: Vec<Contour> = Vec::new();
        for c in &g.contours {
            if let Some(c) = ufo_contour(c, out.len() as u32) {
                out.push(c);
            }
        }
        if depth < 8 {
            for (base, dx, dy) in &g.components {
                for mut c in outline(base, glifs, depth + 1) {
                    c.translate(Vec2::new(*dx, *dy));
                    c.id = out.len() as u32;
                    out.push(c);
                }
            }
        }
        out
    }
    let mut glyphs = BTreeMap::new();
    let mut char_of: BTreeMap<&str, char> = BTreeMap::new();
    for (name, g) in &glifs {
        for &c in &g.unicodes {
            char_of.entry(name.as_str()).or_insert(c);
            glyphs.insert(
                c,
                ImportedGlyph {
                    contours: outline(name, &glifs, 0),
                    advance: g.advance,
                    anchors: g.anchors.clone(),
                },
            );
        }
    }
    // Kerning: groups become their members, glyph by glyph.
    let groups = plist_dict(&dir.join("groups.plist")).unwrap_or_default();
    let members = |n: &str| -> Vec<char> {
        match groups.get(n).and_then(|v| v.as_array()) {
            Some(list) => {
                list.iter().filter_map(|m| m.as_string()).filter_map(|m| char_of.get(m).copied()).collect()
            }
            None => char_of.get(n).copied().into_iter().collect(),
        }
    };
    let mut kerning = Vec::new();
    if let Some(k) = plist_dict(&dir.join("kerning.plist")) {
        for (l, row) in &k {
            let Some(row) = row.as_dictionary() else { continue };
            for (r, v) in row {
                let v = v.as_real().or(v.as_signed_integer().map(|i| i as f64)).unwrap_or(0.0);
                for a in members(l) {
                    for b in members(r) {
                        kerning.push((a, b, v));
                    }
                }
            }
        }
    }
    Ok(ImportedFont { upm, glyphs, kerning })
}

/// A designspace: its axes, and each source UFO.
pub fn read_designspace(path: &Path) -> Result<Imported, String> {
    let text = std::fs::read_to_string(path).map_err(err)?;
    let base = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut r = quick_xml::Reader::from_str(&text);
    let mut axes: Vec<Axis> = Vec::new();
    let mut sources: Vec<(String, PathBuf, BTreeMap<String, f64>)> = Vec::new();
    let mut in_source = false;
    loop {
        let ev = r.read_event().map_err(err)?;
        let e = match &ev {
            Event::Start(e) | Event::Empty(e) => e,
            Event::End(e) if e.name().as_ref() == "source" => {
                in_source = false;
                continue;
            }
            Event::Eof => break,
            _ => continue,
        };
        let attr = |k: &str| -> Option<String> {
            e.attributes().flatten().find(|a| a.key.as_ref() == k).map(|a| {
                a.value
                    .replace("&amp;", "&")
                    .replace("&lt;", "<")
                    .replace("&gt;", ">")
                    .replace("&quot;", "\"")
            })
        };
        let num = |k: &str| attr(k).and_then(|v| v.parse::<f64>().ok());
        match e.name().as_ref() {
            "axis" => axes.push(Axis {
                tag: attr("tag").unwrap_or_default(),
                name: attr("name").unwrap_or_default(),
                min: num("minimum").unwrap_or(0.0),
                default: num("default").unwrap_or(0.0),
                max: num("maximum").unwrap_or(0.0),
                map: Vec::new(),
            }),
            "source" => {
                in_source = matches!(ev, Event::Start(_));
                let file = attr("filename").unwrap_or_default();
                let name = attr("stylename").or_else(|| attr("name")).unwrap_or_else(|| file.clone());
                sources.push((name, base.join(file), BTreeMap::new()));
            }
            "dimension" if in_source => {
                if let (Some(n), Some(v), Some(s)) = (attr("name"), num("xvalue"), sources.last_mut()) {
                    // Locations name axes by name; keep them by tag.
                    let tag = axes.iter().find(|a| a.name == n).map(|a| a.tag.clone()).unwrap_or(n);
                    s.2.insert(tag, v);
                }
            }
            _ => {}
        }
    }
    let mut out = Imported { axes: axes.clone(), sources: Vec::new() };
    for (name, file, location) in sources {
        let font = read_ufo(&file)?;
        out.sources.push(ImportedSource { name, location, font });
    }
    // The source at every axis's default leads.
    let at_default = |s: &ImportedSource| {
        axes.iter().all(|a| s.location.get(&a.tag).copied().unwrap_or(a.default) == a.default)
    };
    if let Some(i) = out.sources.iter().position(at_default) {
        out.sources.swap(0, i);
    }
    Ok(out)
}

/// Any supported file: a font file, a `.ufo` folder or a `.designspace`.
pub fn read_any(path: &Path) -> Result<Imported, String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "designspace" => read_designspace(path),
        "ufo" => Ok(single(read_ufo(path)?)),
        "glyphs" | "glyphspackage" | "vfj" | "vfc" => {
            Err("Glyphs and FontLab files are not read yet: export a UFO or OTF from them and open that"
                .into())
        }
        _ => Ok(single(read_binary(&std::fs::read(path).map_err(err)?)?)),
    }
}

fn single(font: ImportedFont) -> Imported {
    Imported {
        axes: Vec::new(),
        sources: vec![ImportedSource { name: String::new(), location: BTreeMap::new(), font }],
    }
}

// ---------- Into the project ----------

fn scaled(g: &ImportedGlyph, k: f64) -> ImportedGlyph {
    let mut g = g.clone();
    for c in &mut g.contours {
        for p in &mut c.points {
            p.pos = p.pos * k;
        }
    }
    g.advance *= k;
    for a in g.anchors.values_mut() {
        *a = *a * k;
    }
    g
}

/// Fill the master being edited from one font.
fn apply_font(p: &mut Project, font: &ImportedFont, mode: ImportMode, report: &mut ImportReport) {
    let k = f64::from(p.metrics.units_per_em) / font.upm.max(1.0);
    for (&c, g) in &font.glyphs {
        if g.contours.is_empty() {
            continue;
        }
        let g = scaled(g, k);
        let symbol = p.symbols.values().find(|s| s.codepoint == c).map(|s| s.id.clone());
        let fidel = p.families.values().find_map(|f| {
            f.fidels
                .iter()
                .find(|(_, fi)| fi.codepoint == Some(c))
                .map(|(o, _)| (f.id.clone(), f.base.clone(), *o))
        });
        let target = match (&symbol, &fidel) {
            (Some(id), _) => DrawingTarget::Symbol(id.clone()),
            (None, Some((_, base, Order::Giiz))) => DrawingTarget::Base(base.clone()),
            (None, Some((fam, _, o))) => DrawingTarget::fidel(fam, *o),
            _ => {
                report.unused += 1;
                continue;
            }
        };
        let drawable = matches!(target, DrawingTarget::Symbol(_) | DrawingTarget::Base(_));
        if mode == ImportMode::Drawings && drawable {
            if p.drawing(&target).map(|d| !d.is_empty()).unwrap_or(false) {
                report.kept += 1;
                continue;
            }
            let _ = p.set_drawing(&target, g.contours.clone());
            match &target {
                DrawingTarget::Base(id) => {
                    if let Some(b) = p.bases.get_mut(id) {
                        b.advance_width = g.advance;
                        if b.anchors.is_empty() {
                            b.anchors = g.anchors.clone();
                        }
                    }
                }
                DrawingTarget::Symbol(id) => {
                    if let Some(s) = p.symbols.get_mut(id) {
                        s.advance_width = g.advance;
                        if s.anchors.is_empty() {
                            s.anchors = g.anchors.clone();
                        }
                    }
                }
                _ => {}
            }
            report.drawn += 1;
        } else {
            let key = match &target {
                DrawingTarget::Symbol(id) => format!("symbol:{id}"),
                DrawingTarget::Base(id) => format!("base:{id}"),
                DrawingTarget::Fidel(id) => format!("fidel:{id}"),
                _ => continue,
            };
            p.backgrounds.insert(key, g.contours);
            report.backgrounds += 1;
        }
    }
    if mode == ImportMode::Drawings {
        let has = |c: char| p.glyph_shape(c).is_some();
        let pairs: Vec<KernPair> = font
            .kerning
            .iter()
            .filter(|(a, b, v)| *v != 0.0 && has(*a) && has(*b))
            .filter(|(a, b, _)| {
                !p.kerning.pairs.iter().any(|k| k.left == a.to_string() && k.right == b.to_string())
            })
            .map(|(a, b, v)| KernPair {
                left: a.to_string(),
                right: b.to_string(),
                value: (v * k).round() as i32,
            })
            .collect();
        report.kerning += pairs.len();
        p.kerning.pairs.extend(pairs);
    }
}

/// Put an import into the project: its axes and masters too, when the
/// project has none yet.
pub fn apply(p: &mut Project, imported: &Imported, mode: ImportMode) -> ImportReport {
    let mut report = ImportReport::default();
    let Some(first) = imported.sources.first() else { return report };
    let with_masters =
        imported.sources.len() > 1 && p.design.masters.is_empty() && mode == ImportMode::Drawings;
    if with_masters {
        for a in &imported.axes {
            let _ = p.set_axis(None, a.clone());
        }
    }
    apply_font(p, &first.font, mode, &mut report);
    if with_masters {
        for s in &imported.sources[1..] {
            let i = p.add_master(if s.name.is_empty() { "Master" } else { &s.name }, s.location.clone());
            let back = p.design.active;
            if p.switch_master(i).is_ok() {
                // A new master starts as a copy: the import replaces it.
                let mut r = ImportReport::default();
                clear_imported(p, &s.font);
                apply_font(p, &s.font, mode, &mut r);
                let _ = p.switch_master(back);
                report.masters += 1;
            }
        }
    }
    p.after_edit();
    report
}

/// Empty the drawings an import will fill, so they take the new outlines.
fn clear_imported(p: &mut Project, font: &ImportedFont) {
    for &c in font.glyphs.keys() {
        if let Some(s) = p.symbols.values_mut().find(|s| s.codepoint == c) {
            s.contours.clear();
            continue;
        }
        let base = p
            .families
            .values()
            .find(|f| f.fidels.get(&Order::Giiz).and_then(|fi| fi.codepoint) == Some(c))
            .map(|f| f.base.clone());
        if let Some(b) = base.and_then(|b| p.bases.get_mut(&b)) {
            b.contours.clear();
        }
    }
}
