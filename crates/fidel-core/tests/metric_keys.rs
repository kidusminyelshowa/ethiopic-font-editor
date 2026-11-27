//! Sidebearings and widths that follow other glyphs.

use fidel_core::defaults::starter_project;
use fidel_core::metric_keys::MetricKeys;
use fidel_core::{Contour, DrawingTarget, Metrics, Part, Vec2};

fn stem(x0: f64, x1: f64) -> Vec<Contour> {
    vec![Contour::rect(0, Some(Part::Stem), Vec2::new(x0, 0.0), Vec2::new(x1, 700.0))]
}

fn keys(left: Option<&str>, right: Option<&str>, width: Option<&str>) -> MetricKeys {
    MetricKeys { left: left.map(Into::into), right: right.map(Into::into), width: width.map(Into::into) }
}

#[test]
fn sidebearings_follow_another_glyph() {
    let mut p = starter_project(Metrics::default());
    p.set_drawing(&DrawingTarget::Base("ha".into()), stem(60.0, 500.0)).unwrap();
    p.bases.get_mut("ha").unwrap().advance_width = 580.0; // RSB 80
    p.set_drawing(&DrawingTarget::Base("la".into()), stem(100.0, 400.0)).unwrap();

    p.set_metric_keys(&DrawingTarget::Base("la".into()), keys(Some("=ሀ"), Some("=ሀ+10"), None)).unwrap();
    let la = &p.bases["la"];
    let b = la.contours[0].bounds().unwrap();
    assert_eq!(b.min.x, 60.0);
    assert_eq!(la.advance_width - b.max.x, 90.0);

    // Changing ሀ moves ለ with it.
    p.set_drawing(&DrawingTarget::Base("ha".into()), stem(40.0, 480.0)).unwrap();
    assert_eq!(p.bases["la"].contours[0].bounds().unwrap().min.x, 40.0);

    // The opposite side, a fixed width, and a key that names nothing.
    p.set_metric_keys(&DrawingTarget::Base("la".into()), keys(Some("=|ሀ"), None, Some("=600"))).unwrap();
    let la = &p.bases["la"];
    assert_eq!(la.contours[0].bounds().unwrap().min.x, 100.0); // ሀ's RSB: 580 - 480
    assert_eq!(la.advance_width, 600.0);
    let errors = {
        p.bases.get_mut("la").unwrap().metric_keys = keys(Some("=ꙮ"), None, None);
        p.apply_metric_keys()
    };
    assert_eq!(errors.len(), 1);
}

#[test]
fn numerals_take_a_fixed_width() {
    let mut p = starter_project(Metrics::default());
    p.set_drawing(&DrawingTarget::Symbol("uni1369".into()), stem(50.0, 350.0)).unwrap();
    p.set_metric_keys(&DrawingTarget::Symbol("uni1369".into()), keys(None, None, Some("600"))).unwrap();
    assert_eq!(p.symbols["uni1369"].advance_width, 600.0);
    // Keys only go on bases and symbols.
    assert!(p.set_metric_keys(&DrawingTarget::Alteration("mark.oa".into()), MetricKeys::default()).is_err());
}

#[test]
fn metrics_copy_to_every_master() {
    let mut p = starter_project(Metrics::default());
    let t = DrawingTarget::Base("ha".into());
    p.set_drawing(&t, stem(60.0, 500.0)).unwrap();
    p.bases.get_mut("ha").unwrap().advance_width = 580.0;
    p.add_master("Bold", Default::default());
    p.switch_master(1).unwrap();
    p.set_drawing(&t, stem(100.0, 600.0)).unwrap();
    p.bases.get_mut("ha").unwrap().advance_width = 900.0;
    p.switch_master(0).unwrap();
    assert_eq!(p.copy_metrics_to_masters(&t).unwrap(), 1);
    let bold = p.master_project(1);
    let b = bold.bases["ha"].contours[0].bounds().unwrap();
    assert_eq!(b.min.x, 60.0);
    assert_eq!(bold.bases["ha"].advance_width - b.max.x, 80.0);
    // The stem keeps its own width in the bold master.
    assert_eq!(b.max.x - b.min.x, 500.0);
}

#[test]
fn kerning_copies_to_every_master() {
    let mut p = starter_project(Metrics::default());
    p.add_master("Bold", Default::default());
    p.kerning.set_pair("ሀ", "ለ", Some(-30)).unwrap();
    assert!(p.master_project(1).kerning.pairs.is_empty());
    assert_eq!(p.copy_kerning_to_masters(), 1);
    assert_eq!(p.master_project(1).kerning.pair("ሀ", "ለ"), Some(-30));
}

#[test]
fn italic_sidebearings_follow_the_slant() {
    let lean = 10f64.to_radians().tan();
    // A stem slanted by the italic angle, 50 from the slanted origin line.
    let mut stem = Contour::rect(900, None, Vec2::new(50.0, 0.0), Vec2::new(150.0, 700.0));
    for pt in &mut stem.points {
        pt.pos.x += pt.pos.y * lean;
    }
    let (lsb, rsb, _) = fidel_core::metric_keys::measure(&[stem], 300.0, 10.0).unwrap();
    assert!((lsb - 50.0).abs() < 1e-6 && (rsb - 150.0).abs() < 1e-6, "{lsb} {rsb}");
}
