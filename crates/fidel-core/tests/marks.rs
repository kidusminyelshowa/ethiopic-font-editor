//! Anchors, accented letters built from parts, and the mark features.

use fidel_core::charset::CharSet;
use fidel_core::defaults::geez_project;
use fidel_core::features::glyph_name;
use fidel_core::*;

fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<Contour> {
    vec![Contour::rect(0, None, Vec2::new(x0, y0), Vec2::new(x1, y1))]
}

fn sym(p: &mut Project, c: char) -> &mut project::Symbol {
    p.symbols.values_mut().find(|s| s.codepoint == c).unwrap()
}

/// Latin on, A drawn 0..500 by 0..700 with a top anchor, grave and acute
/// 100 square with `_top` and `top`.
fn latin() -> Project {
    let mut p = geez_project(Metrics::default());
    p.set_charsets([CharSet::Geez, CharSet::Latin, CharSet::LatinSupplement]);
    let a = sym(&mut p, 'A');
    a.contours = rect(0.0, 0.0, 500.0, 700.0);
    a.advance_width = 560.0;
    a.anchors.insert("top".into(), Vec2::new(250.0, 700.0));
    for m in ['\u{0300}', '\u{0301}'] {
        let g = sym(&mut p, m);
        g.contours = rect(0.0, 0.0, 100.0, 100.0);
        g.anchors.insert("_top".into(), Vec2::new(50.0, -20.0));
        g.anchors.insert("top".into(), Vec2::new(50.0, 100.0));
    }
    p
}

fn bounds(cs: &[Contour]) -> (Vec2, Vec2) {
    let b: Vec<_> = cs.iter().filter_map(|c| c.bounds()).collect();
    let lo =
        b.iter().fold(Vec2::new(f64::MAX, f64::MAX), |a, r| Vec2::new(a.x.min(r.min.x), a.y.min(r.min.y)));
    let hi =
        b.iter().fold(Vec2::new(f64::MIN, f64::MIN), |a, r| Vec2::new(a.x.max(r.max.x), a.y.max(r.max.y)));
    (lo, hi)
}

#[test]
fn latin_sets_bring_accented_letters_built_from_parts() {
    let p = latin();
    let agrave = p.symbols.values().find(|s| s.codepoint == 'À').unwrap();
    assert_eq!(agrave.built_from, vec!['A', '\u{0300}']);
    // Ç takes a cedilla below.
    let c = p.symbols.values().find(|s| s.codepoint == 'Ç').unwrap();
    assert_eq!(c.built_from, vec!['C', '\u{0327}']);
}

#[test]
fn accents_meet_the_letter_at_their_anchors_and_stack() {
    let p = latin();
    let g = p.glyph_shape('À').unwrap();
    assert_eq!(g.advance, 560.0);
    assert_eq!(g.contours.len(), 2);
    let accent = g.contours[1].bounds().unwrap();
    assert_eq!((accent.min.x, accent.min.y), (200.0, 720.0));
    assert_eq!(g.anchors["top"], Vec2::new(250.0, 820.0));
    // A second accent sits on the first.
    let two = p.compose('A', &['\u{0300}', '\u{0301}']).unwrap();
    assert_eq!(two.contours[2].bounds().unwrap().min.y, 840.0);
    // The grid and the export see the built outline.
    let id = p.symbols.values().find(|s| s.codepoint == 'À').unwrap().id.clone();
    assert_eq!(p.symbol_outline(&id).len(), 2);
    assert_eq!(p.symbol_advance(&id), 560.0);
}

#[test]
fn accents_without_anchors_sit_centred_above() {
    let mut p = latin();
    sym(&mut p, 'A').anchors.clear();
    sym(&mut p, '\u{0300}').anchors.clear();
    let g = p.glyph_shape('À').unwrap();
    let (lo, hi) = bounds(&g.contours[1..]);
    assert_eq!((lo.x + hi.x) / 2.0, 250.0);
    assert!(lo.y > 700.0);
}

#[test]
fn dotless_i_carries_accents_when_drawn() {
    let mut p = latin();
    p.set_charsets([CharSet::Geez, CharSet::Latin, CharSet::LatinSupplement, CharSet::LatinExtendedA]);
    sym(&mut p, 'i').contours = vec![
        Contour::rect(0, None, Vec2::new(0.0, 0.0), Vec2::new(80.0, 500.0)),
        Contour::rect(1, None, Vec2::new(0.0, 600.0), Vec2::new(80.0, 680.0)),
    ];
    sym(&mut p, 'ı').contours = rect(0.0, 0.0, 80.0, 500.0);
    // í: the dotless i and an acute, no dot.
    assert_eq!(p.glyph_shape('í').unwrap().contours.len(), 2);
}

#[test]
fn decomposing_keeps_the_outline() {
    let mut p = latin();
    let id = p.symbols.values().find(|s| s.codepoint == 'À').unwrap().id.clone();
    let before = p.symbol_outline(&id);
    p.decompose_symbol(&id).unwrap();
    assert!(p.symbols[&id].built_from.is_empty());
    assert_eq!(p.symbol_outline(&id), before);
}

#[test]
fn anchors_make_mark_and_mkmk_features() {
    let p = latin();
    let fea = p.mark_features(&['A', '\u{0300}', '\u{0301}']);
    assert!(fea.contains(&format!("markClass {} <anchor 50 -20> @MC_top;", glyph_name('\u{0300}'))));
    assert!(fea.contains(&format!("pos base {} <anchor 250 700> mark @MC_top;", glyph_name('A'))));
    assert!(fea.contains("feature mkmk"));
    // Nothing anchored, nothing written.
    assert_eq!(geez_project(Metrics::default()).mark_features(&['ሀ']), "");
}
