//! Automatic spacing and kerning by white area, and corpus counts.

use fidel_core::defaults::starter_project;
use fidel_core::spacing::frequencies;
use fidel_core::{Contour, DrawingTarget, Metrics, Vec2};

fn rect(id: u32, x0: i32, y0: i32, x1: i32, y1: i32) -> Contour {
    Contour::rect(id, None, Vec2::new(x0.into(), y0.into()), Vec2::new(x1.into(), y1.into()))
}

fn sides(p: &fidel_core::Project, base: &str) -> (f64, f64) {
    let b = &p.bases[base];
    let bb = fidel_core::geometry::bounds_of(&b.contours).unwrap();
    (bb.min.x, b.advance_width - bb.max.x)
}

#[test]
fn counts_letters_and_pairs() {
    let (l, p) = frequencies("ሀለ ሀለ ለ። ሀ", &|c| c != '።');
    assert_eq!(l[0], ('ሀ', 3));
    assert_eq!(p[0], ("ሀለ".to_string(), 2));
    assert_eq!(p.len(), 1);
}

#[test]
fn spaces_to_match_the_reference() {
    let mut p = starter_project(Metrics::default());
    // ሀ: two stems, an open middle, spaced by hand with 60 each side.
    p.set_drawing(
        &DrawingTarget::Base("ha".into()),
        vec![rect(0, 60, 0, 130, 700), rect(1, 400, 0, 470, 700)],
    )
    .unwrap();
    p.bases.get_mut("ha").unwrap().advance_width = 530.0;
    // ለ: one stem, badly spaced.
    p.set_drawing(&DrawingTarget::Base("la".into()), vec![rect(0, 10, 0, 80, 700)]).unwrap();
    p.bases.get_mut("la").unwrap().advance_width = 300.0;
    assert!(p.auto_space(None).unwrap() >= 1);
    // Straight sides both: same sidebearings as ሀ.
    assert_eq!(sides(&p, "la"), (60.0, 60.0));
    assert_eq!(sides(&p, "ha"), (60.0, 60.0));

    // An open side (a bar at the top only) gets less sidebearing: its
    // white already reaches in.
    p.set_drawing(
        &DrawingTarget::Base("la".into()),
        vec![rect(0, 10, 0, 80, 700), rect(1, 80, 620, 300, 700)],
    )
    .unwrap();
    p.auto_space(None).unwrap();
    let (l, r) = sides(&p, "la");
    assert_eq!(l, 60.0);
    assert!(r < 0.0 + 60.0 && r > -60.0, "right side {r}");
}

#[test]
fn kerns_pairs_that_stand_out() {
    let mut p = starter_project(Metrics::default());
    p.set_drawing(
        &DrawingTarget::Base("ha".into()),
        vec![rect(0, 60, 0, 130, 700), rect(1, 400, 0, 470, 700)],
    )
    .unwrap();
    p.bases.get_mut("ha").unwrap().advance_width = 530.0;
    // ለ with a bar overhanging its width: ለሀ comes too close.
    p.set_drawing(
        &DrawingTarget::Base("la".into()),
        vec![rect(0, 60, 0, 130, 700), rect(1, 130, 620, 400, 700)],
    )
    .unwrap();
    p.bases.get_mut("la").unwrap().advance_width = 360.0;
    p.read_corpus("ሀሀ ሀሀ ሀሀ ለሀ ሀለ");
    let props = p.propose_kerning();
    let la_ha = props.iter().find(|k| k.left == 'ለ' && k.right == 'ሀ').expect("ለሀ is kerned");
    assert_eq!(la_ha.value, 60);
    assert!(!props.iter().any(|k| k.left == 'ሀ'), "{props:?}");
    // Pairs kerned by hand stay.
    p.kerning.set_pair("ለ", "ሀ", Some(5)).unwrap();
    assert_eq!(p.apply_kerning(&props), 0);
    assert_eq!(p.kerning.pair("ለ", "ሀ"), Some(5));
}
