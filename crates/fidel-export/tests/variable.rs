//! Variable fonts and instances from a project with masters.

use std::collections::BTreeMap;

use fidel_core::defaults::geez_project;
use fidel_core::designspace::{Axis, Instance};
use fidel_core::*;
use fidel_export::{export_instance, export_variable, ExportOptions};
use skrifa::instance::{LocationRef, Size};
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::raw::TableProvider;
use skrifa::{FontRef, MetadataProvider};

fn loc(v: f64) -> BTreeMap<String, f64> {
    BTreeMap::from([("wght".to_string(), v)])
}

/// A stem with a curved bowl, so the quadratics have to match too.
fn ha(stem: f64, bowl: f64) -> Vec<Contour> {
    let k = 0.552_284_75;
    let (cx, cy, r) = (300.0, 350.0, bowl);
    let bowl = Contour::new(
        1,
        None,
        vec![
            Point::curve(0, cx + r, cy),
            Point::off(1, cx + r, cy + r * k),
            Point::off(2, cx + r * k, cy + r),
            Point::curve(3, cx, cy + r),
            Point::off(4, cx - r * k, cy + r),
            Point::off(5, cx - r, cy + r * k),
            Point::curve(6, cx - r, cy),
            Point::off(7, cx - r, cy - r * k),
            Point::off(8, cx - r * k, cy - r),
            Point::curve(9, cx, cy - r),
            Point::off(10, cx + r * k, cy - r),
            Point::off(11, cx + r, cy - r * k),
        ],
    );
    vec![Contour::rect(0, Some(Part::Stem), Vec2::new(60.0, 0.0), Vec2::new(60.0 + stem, 700.0)), bowl]
}

fn project() -> Project {
    let mut p = geez_project(Metrics::default());
    p.set_axis(
        None,
        Axis {
            tag: "wght".into(),
            name: "Weight".into(),
            min: 400.0,
            default: 400.0,
            max: 700.0,
            map: vec![],
        },
    )
    .unwrap();
    p.bases.get_mut("ha").unwrap().contours = ha(70.0, 100.0);
    p.bases.get_mut("ha").unwrap().advance_width = 600.0;
    let bold = p.add_master("Bold", loc(700.0));
    p.switch_master(bold).unwrap();
    p.bases.get_mut("ha").unwrap().contours = ha(170.0, 160.0);
    p.bases.get_mut("ha").unwrap().advance_width = 700.0;
    p.switch_master(0).unwrap();
    p.design.instances = vec![
        Instance { name: "Regular".into(), location: loc(400.0), export: true },
        Instance { name: "Bold".into(), location: loc(700.0), export: true },
    ];
    p
}

#[derive(Default)]
struct Max(f32, f32);
impl OutlinePen for Max {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0 = self.0.max(x);
        self.1 = self.1.max(y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.move_to(x, y)
    }
    fn quad_to(&mut self, _: f32, _: f32, x: f32, y: f32) {
        self.move_to(x, y)
    }
    fn curve_to(&mut self, _: f32, _: f32, _: f32, _: f32, x: f32, y: f32) {
        self.move_to(x, y)
    }
    fn close(&mut self) {}
}

fn max_at(font: &FontRef, c: char, wght: f32) -> (f32, f32) {
    let gid = font.charmap().map(c).unwrap();
    let location = font.axes().location([("wght", wght)]);
    let mut m = Max::default();
    font.outline_glyphs()
        .get(gid)
        .unwrap()
        .draw(DrawSettings::unhinted(Size::unscaled(), LocationRef::from(&location)), &mut m)
        .unwrap();
    (m.0, m.1)
}

#[test]
fn variable_font_varies_between_masters() {
    let v = export_variable(&project(), &ExportOptions::new("Test Geez")).unwrap();
    assert!(v.fixed.is_empty(), "{:?}", v.fixed);
    let font = FontRef::new(&v.bytes).unwrap();
    let axes: Vec<_> =
        font.axes().iter().map(|a| (a.tag().to_string(), a.min_value(), a.max_value())).collect();
    assert_eq!(axes, vec![("wght".to_string(), 400.0, 700.0)]);
    assert_eq!(font.named_instances().iter().count(), 2);
    // ሀ is the base itself: the bowl's right edge goes 400 → 460.
    for (w, want) in [(400.0, 400.0), (700.0, 460.0), (550.0, 430.0)] {
        let (right, _) = max_at(&font, 'ሀ', w);
        assert!((right - want).abs() < 1.0, "{w}: {right}");
    }
    assert!(font.stat().is_ok());
}

#[test]
fn mismatched_glyphs_stay_fixed() {
    let mut p = project();
    p.switch_master(1).unwrap();
    p.bases.get_mut("ha").unwrap().contours.pop();
    p.switch_master(0).unwrap();
    let v = export_variable(&p, &ExportOptions::new("Test Geez")).unwrap();
    assert!(v.fixed.contains(&'ሀ'));
    let font = FontRef::new(&v.bytes).unwrap();
    assert_eq!(max_at(&font, 'ሀ', 700.0), max_at(&font, 'ሀ', 400.0));
}

#[test]
fn static_instance_is_interpolated() {
    let p = project();
    let i = Instance { name: "Semibold".into(), location: loc(550.0), export: true };
    let f = export_instance(&p, &i, &ExportOptions::new("Test Geez")).unwrap();
    let font = FontRef::new(&f.bytes).unwrap();
    let (right, _) = max_at(&font, 'ሀ', 0.0);
    assert!((right - 430.0).abs() < 1.0, "{right}");
    let names: Vec<String> =
        font.localized_strings(skrifa::string::StringId::SUBFAMILY_NAME).map(|s| s.to_string()).collect();
    assert_eq!(names, vec!["Semibold".to_string()]);
}

/// Writes the variable font for outside tools (`FIDEL_VF_OUT=path`).
#[test]
fn write_for_inspection() {
    if let Ok(path) = std::env::var("FIDEL_VF_OUT") {
        let v = export_variable(&project(), &ExportOptions::new("Test Geez")).unwrap();
        std::fs::write(path, v.bytes).unwrap();
    }
}

#[test]
fn stat_links_roman_and_italic() {
    let ital = |font: &FontRef| {
        let stat = font.stat().unwrap();
        let axes = stat.design_axes().unwrap();
        let i =
            axes.iter().position(|a| a.axis_tag() == skrifa::Tag::new(b"ital")).expect("an ital axis") as u16;
        let values = stat.offset_to_axis_values().unwrap().unwrap();
        values
            .axis_values()
            .iter()
            .flatten()
            .find_map(|v| match v {
                skrifa::raw::tables::stat::AxisValue::Format1(v) if v.axis_index() == i => {
                    Some((1, v.value().to_f64()))
                }
                skrifa::raw::tables::stat::AxisValue::Format3(v) if v.axis_index() == i => {
                    Some((3, v.linked_value().to_f64()))
                }
                _ => None,
            })
            .expect("an ital value")
    };
    let roman = export_variable(&project(), &ExportOptions::new("Test Geez")).unwrap();
    assert_eq!(ital(&FontRef::new(&roman.bytes).unwrap()), (3, 1.0));
    let mut p = project();
    p.metrics.italic_angle = 10.0;
    for l in p.design.masters.iter_mut().filter_map(|m| m.layer.as_mut()) {
        l.italic_angle = 10.0;
    }
    let italic = export_variable(&p, &ExportOptions::new("Test Geez")).unwrap();
    assert_eq!(ital(&FontRef::new(&italic.bytes).unwrap()), (1, 1.0));
}

#[test]
fn brace_layer_shapes_the_middle() {
    let mut p = project();
    let id = p.add_brace(DrawingTarget::Base("ha".into()), &loc(550.0)).unwrap();
    // It starts as the interpolation: the bowl's radius halfway, 130.
    let start = p.drawing(&DrawingTarget::Brace(id.clone())).unwrap().to_vec();
    assert_eq!(start[1].points[0].pos.x, 430.0);
    p.set_drawing(&DrawingTarget::Brace(id), ha(120.0, 200.0)).unwrap();
    // The instance there is the brace, and halfway to it in between.
    let mid = p.instance_at(&loc(550.0)).unwrap();
    assert_eq!(mid.bases["ha"].contours[1].points[0].pos.x, 500.0);
    let v = export_variable(&p, &ExportOptions::new("Test Geez")).unwrap();
    assert!(v.fixed.is_empty(), "{:?}", v.fixed);
    let font = FontRef::new(&v.bytes).unwrap();
    for (w, want) in [(400.0, 400.0), (550.0, 500.0), (700.0, 460.0)] {
        let (right, _) = max_at(&font, 'ሀ', w);
        assert!((right - want).abs() < 1.0, "{w}: {right}");
    }
}
