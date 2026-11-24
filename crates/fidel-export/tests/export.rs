//! Export the M1 scenario and read the font back with skrifa.

use fidel_core::defaults::{geez_project, LOOP_BOTTOM_RIGHT};
use fidel_core::*;
use fidel_export::{export, glyph_name, ExportError, ExportOptions, CURVE_ACCURACY};
use skrifa::instance::{LocationRef, Size};
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::raw::TableProvider;
use skrifa::{FontRef, MetadataProvider};

/// A ring of four cubic quarter-arcs around (cx, cy).
fn circle(id: ContourId, part: Part, cx: f64, cy: f64, r: f64) -> Contour {
    let k = r * 0.552_284_75;
    let pts = vec![
        Point::curve(0, cx + r, cy),
        Point::off(1, cx + r, cy + k),
        Point::off(2, cx + k, cy + r),
        Point::curve(3, cx, cy + r),
        Point::off(4, cx - k, cy + r),
        Point::off(5, cx - r, cy + k),
        Point::curve(6, cx - r, cy),
        Point::off(7, cx - r, cy - k),
        Point::off(8, cx - k, cy - r),
        Point::curve(9, cx, cy - r),
        Point::off(10, cx + k, cy - r),
        Point::off(11, cx + r, cy - k),
    ];
    Contour::new(id, Some(part), pts)
}

/// Only Hoy and Lawi are drawn; the loop is a circle.
fn project() -> Project {
    let mut p = geez_project(Metrics::default());
    for id in ["ha", "la"] {
        let base = p.bases.get_mut(id).unwrap();
        base.advance_width = 600.0;
        base.contours = vec![
            Contour::rect(0, Some(Part::Stem), Vec2::new(60.0, 0.0), Vec2::new(140.0, 700.0)),
            Contour::rect(1, Some(Part::Leg), Vec2::new(440.0, 0.0), Vec2::new(520.0, 640.0)),
        ];
    }
    p.alterations.get_mut(LOOP_BOTTOM_RIGHT).unwrap().contours =
        vec![circle(0, Part::Ring, 40.0, -40.0, 40.0)];
    p
}

#[derive(Default)]
struct Bounds {
    min: (f32, f32),
    max: (f32, f32),
    points: usize,
    curves: usize,
}

impl Bounds {
    fn add(&mut self, x: f32, y: f32) {
        if self.points == 0 {
            self.min = (x, y);
            self.max = (x, y);
        }
        self.min = (self.min.0.min(x), self.min.1.min(y));
        self.max = (self.max.0.max(x), self.max.1.max(y));
        self.points += 1;
    }
}

impl OutlinePen for Bounds {
    fn move_to(&mut self, x: f32, y: f32) {
        self.add(x, y)
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.add(x, y)
    }
    fn quad_to(&mut self, _: f32, _: f32, x: f32, y: f32) {
        self.curves += 1;
        self.add(x, y)
    }
    fn curve_to(&mut self, _: f32, _: f32, _: f32, _: f32, x: f32, y: f32) {
        self.curves += 1;
        self.add(x, y)
    }
    fn close(&mut self) {}
}

fn outline(font: &FontRef, c: char) -> Bounds {
    let gid = font.charmap().map(c).unwrap_or_else(|| panic!("{c} not mapped"));
    let glyph = font.outline_glyphs().get(gid).unwrap();
    let mut b = Bounds::default();
    glyph.draw(DrawSettings::unhinted(Size::unscaled(), LocationRef::default()), &mut b).unwrap();
    b
}

#[test]
fn exports_drawn_fidel_and_skips_the_rest() {
    let p = project();
    let font = export(&p, &ExportOptions::new("Test Geez")).unwrap();
    // Hoy and Lawi: every order except ሩ, which is drawn by hand.
    assert!(font.exported.contains(&'ሀ') && font.exported.contains(&'ሄ') && font.exported.contains(&'ሌ'));
    assert!(!font.exported.contains(&'ሩ'));
    assert!(font.skipped.contains(&'መ') && font.skipped.contains(&'ሩ'));

    // Set FIDEL_EXPORT_DUMP=path to inspect the font with other tools.
    if let Ok(path) = std::env::var("FIDEL_EXPORT_DUMP") {
        std::fs::write(path, &font.bytes).unwrap();
    }
    let f = FontRef::new(&font.bytes).unwrap();
    assert_eq!(f.head().unwrap().units_per_em(), 1000);
    assert_eq!(f.charmap().map('መ'), None, "undrawn fidel fall back to another font");
    assert!(f.charmap().map(' ').is_some());
    let names = f.localized_strings(skrifa::string::StringId::FAMILY_NAME).english_or_first().unwrap();
    assert_eq!(names.to_string(), "Test Geez");
    let ps = f.localized_strings(skrifa::string::StringId::POSTSCRIPT_NAME).english_or_first().unwrap();
    assert_eq!(ps.to_string(), "TestGeez-Regular");
}

#[test]
fn outlines_match_the_model() {
    let p = project();
    let font = export(&p, &ExportOptions::new("Test Geez")).unwrap();
    let f = FontRef::new(&font.bytes).unwrap();

    let ha = outline(&f, 'ሀ');
    assert_eq!((ha.min, ha.max), ((60.0, 0.0), (520.0, 700.0)));
    assert_eq!(ha.curves, 0);

    // ሄ carries the loop at the bottom of the leg (x = 480), dipping below
    // the baseline. The cubic circle comes out as quadratics within tolerance.
    let he = outline(&f, 'ሄ');
    let resolved = p.resolve("ha", Order::Hamis).unwrap();
    let model_min_y = resolved
        .contours
        .iter()
        .flat_map(|c| c.contour.points.iter())
        .map(|pt| pt.pos.y)
        .fold(f64::INFINITY, f64::min);
    assert!(he.curves > 0);
    assert!(
        (f64::from(he.min.1) - model_min_y).abs() <= CURVE_ACCURACY + 0.5,
        "{} vs {}",
        he.min.1,
        model_min_y
    );

    let gid = f.charmap().map('ሄ').unwrap();
    let advance = f.glyph_metrics(Size::unscaled(), LocationRef::default()).advance_width(gid).unwrap();
    assert_eq!(f64::from(advance), resolved.advance_width.round());
}

#[test]
fn glyph_names_and_errors() {
    assert_eq!(glyph_name('ሀ'), "uni1200");
    let empty = geez_project(Metrics::default());
    assert!(matches!(export(&empty, &ExportOptions::new("X")), Err(ExportError::NothingDrawn)));
    assert!(matches!(export(&project(), &ExportOptions::new("  ")), Err(ExportError::NoFamilyName)));
}

#[test]
fn export_is_deterministic() {
    let p = project();
    let a = export(&p, &ExportOptions::new("Test Geez")).unwrap();
    let b = export(&p, &ExportOptions::new("Test Geez")).unwrap();
    assert_eq!(a.bytes, b.bytes);
}

#[test]
fn exports_only_the_chosen_character_sets() {
    let mut p = project();
    p.set_charsets([CharSet::Geez, CharSet::EthiopicLabialized, CharSet::EthiopicMarks]);
    p.alterations.get_mut(defaults::LABIAL_MARK).unwrap().contours =
        vec![Contour::rect(0, None, Vec2::new(0.0, -10.0), Vec2::new(80.0, 10.0))];
    p.set_drawing(
        &DrawingTarget::Symbol("uni1362".into()),
        vec![Contour::rect(0, None, Vec2::new(50.0, 0.0), Vec2::new(150.0, 100.0))],
    )
    .unwrap();
    let font = export(&p, &ExportOptions::new("Test Sets")).unwrap();
    assert!(font.exported.contains(&'ሏ'), "the -wa form of Lawi, built on ላ");
    assert!(font.exported.contains(&'።'));
    let f = FontRef::new(&font.bytes).unwrap();
    assert!(f.charmap().map('ሏ').is_some() && f.charmap().map('።').is_some());

    // Off again: the work stays in the project but leaves the font.
    p.set_charsets([CharSet::Geez]);
    let font = export(&p, &ExportOptions::new("Test Sets")).unwrap();
    assert!(!font.exported.contains(&'ሏ') && !font.exported.contains(&'።'));
    assert!(!p.symbols["uni1362"].contours.is_empty());
}

/// The kern value a shaper would apply between two glyphs: the first
/// subtable of the lookup that holds the pair.
fn kern(font: &FontRef, l: char, r: char) -> Option<i16> {
    use skrifa::raw::tables::gpos::{PairPos, PositionLookup};
    let cmap = font.charmap();
    let (g1, g2) = (cmap.map(l)?, cmap.map(r)?);
    let (h1, h2) = (skrifa::GlyphId16::try_from(g1).ok()?, skrifa::GlyphId16::try_from(g2).ok()?);
    let gpos = font.gpos().ok()?;
    let lookups = gpos.lookup_list().ok()?;
    let lookup = lookups.lookups().get(0).ok()?;
    let PositionLookup::Pair(lookup) = lookup else { return None };
    let subs = lookup.subtables();
    for sub in subs.iter() {
        match sub.ok()? {
            PairPos::Format1(t) => {
                let Some(i) = t.coverage().ok()?.get(g1) else { continue };
                let set = t.pair_sets().get(i as usize).ok()?;
                if let Some(rec) =
                    set.pair_value_records().iter().filter_map(Result::ok).find(|p| p.second_glyph() == h2)
                {
                    return rec.value_record1().x_advance();
                }
            }
            PairPos::Format2(t) => {
                if t.coverage().ok()?.get(g1).is_none() {
                    continue;
                }
                let c1 = t.class_def1().ok()?.get(h1);
                let c2 = t.class_def2().ok()?.get(h2);
                let rec = t.class1_records().get(c1 as usize).ok()?;
                let v = rec.class2_records().get(c2 as usize).ok()?.value_record1().x_advance();
                if v.is_some() {
                    return v;
                }
            }
            _ => {}
        }
    }
    None
}

#[test]
fn kerning_is_written_with_exceptions_first() {
    use fidel_core::kerning::KernSide;
    let mut p = project();
    let k = &mut p.kerning;
    k.set_class(KernSide::Left, "ha", &['ሀ', 'ሁ'], None).unwrap();
    k.set_class(KernSide::Right, "la", &['ለ', 'ሉ'], None).unwrap();
    k.set_pair("@ha", "@la", Some(-40)).unwrap();
    k.set_pair("ሁ", "ሉ", Some(12)).unwrap();
    k.set_pair("ለ", "ሀ", Some(-7)).unwrap();
    let font = export(&p, &ExportOptions::new("Test Geez")).unwrap();
    let font = FontRef::new(&font.bytes).unwrap();
    assert_eq!(kern(&font, 'ሀ', 'ለ'), Some(-40));
    assert_eq!(kern(&font, 'ሁ', 'ለ'), Some(-40));
    assert_eq!(kern(&font, 'ሁ', 'ሉ'), Some(12));
    assert_eq!(kern(&font, 'ለ', 'ሀ'), Some(-7));
    assert_eq!(kern(&font, 'ሉ', 'ሀ'), None);
}

#[test]
fn no_kerning_no_gpos() {
    let font = export(&project(), &ExportOptions::new("Test Geez")).unwrap();
    assert!(FontRef::new(&font.bytes).unwrap().gpos().is_err());
}
