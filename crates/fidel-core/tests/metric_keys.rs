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
