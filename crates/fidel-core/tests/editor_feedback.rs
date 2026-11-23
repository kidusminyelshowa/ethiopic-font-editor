//! Per-family attach points, language presets, and editing detached fidel.

use fidel_core::defaults::{geez_project, starter_project, LOOP_BOTTOM_RIGHT};
use fidel_core::*;

fn project() -> Project {
    let mut p = geez_project(Metrics::default());
    for base in p.bases.values_mut() {
        base.contours = vec![
            Contour::rect(0, Some(Part::Stem), Vec2::new(50.0, 0.0), Vec2::new(110.0, 700.0)),
            Contour::rect(1, Some(Part::Leg), Vec2::new(340.0, 0.0), Vec2::new(400.0, 640.0)),
        ];
    }
    p.alterations.get_mut(LOOP_BOTTOM_RIGHT).unwrap().contours =
        vec![Contour::rect(0, Some(Part::Ring), Vec2::new(-40.0, -80.0), Vec2::new(40.0, 0.0))];
    p
}

fn ring(p: &Project, family: &str) -> Rect {
    let r = p.resolve(family, Order::Hamis).unwrap();
    let b = r.from_source(&Source::Alteration(LOOP_BOTTOM_RIGHT.into())).next().and_then(Contour::bounds);
    b.unwrap()
}

#[test]
fn an_attach_offset_moves_the_mark_on_one_family_only() {
    let mut p = project();
    let before = ring(&p, "la");
    // ሄ is built on ሃ, whose shortened leg lifts the loop; only the offset matters here.
    let before_ha = ring(&p, "ha");
    p.set_attach_offset("la", LOOP_BOTTOM_RIGHT, Vec2::new(12.0, -30.0)).unwrap();
    assert_eq!(ring(&p, "la").min, before.min + Vec2::new(12.0, -30.0));
    assert_eq!(ring(&p, "ha").min, before_ha.min);
    assert_eq!(p.auto_attach_point("la", LOOP_BOTTOM_RIGHT), Some(Vec2::new(370.0, 0.0)));

    // A scoped copy follows the family's offset.
    let copy = p.fork_alteration(LOOP_BOTTOM_RIGHT, &Scope::Family { family: "la".into() }).unwrap();
    assert_eq!(p.attach_offset("la", &copy), Vec2::new(12.0, -30.0));

    // Back to zero goes back to the automatic point, and survives a save.
    p.set_attach_offset("la", LOOP_BOTTOM_RIGHT, Vec2::ZERO).unwrap();
    assert!(p.families["la"].attach_offsets.is_empty());
}

#[test]
fn ma_second_order_is_not_irregular() {
    let p = geez_project(Metrics::default());
    assert_eq!(p.fidel("ma", Order::Kaib).unwrap().state.kind(), StateKind::Linked);
    assert_eq!(p.fidel("ra", Order::Kaib).unwrap().state.kind(), StateKind::Irregular);
}

#[test]
fn language_presets() {
    let p = starter_project(Metrics::default());
    assert_eq!(p.languages, [Language::Amharic].into());
    for c in ['ሀ', 'ሸ', 'ጨ', 'ሏ', 'ቈ', 'ቋ', 'ኳ', '።', '፩'] {
        assert!(p.in_charset(c), "Amharic has {c}");
    }
    for c in ['ቐ', 'ሇ', 'ⶀ', 'ጘ', '\u{135F}'] {
        assert!(!p.in_charset(c), "Amharic does not have {c}");
    }
    assert!(Language::Tigrinya.contains('ቐ') && Language::Tigrinya.contains('ቘ'));
    assert!(Language::Gurage.contains('ጘ') && Language::Gurage.contains('\u{1E7E0}'));
    assert!(p.families.contains_key("cha"));
    assert!(!p.families.contains_key("qha"));
}

#[test]
fn a_detached_fidel_is_edited_by_component() {
    let mut p = project();
    p.detach("la", Order::Hamis).unwrap();
    let target = DrawingTarget::fidel("la", Order::Hamis);
    assert_eq!(target, DrawingTarget::Fidel("la/hamis".into()));
    let contours = p.drawing(&target).unwrap().to_vec();
    let names: Vec<_> = contours.iter().map(|c| c.name.clone().unwrap()).collect();
    assert_eq!(names, ["Stem", "Leg", "5th-order loop, bottom right"]);

    // Move only the loop.
    let mut edited = contours.clone();
    edited[2].translate(Vec2::new(0.0, -20.0));
    p.set_drawing(&target, edited).unwrap();
    let r = p.resolve("la", Order::Hamis).unwrap();
    assert_eq!(r.contours[2].contour.bounds().unwrap().min.y, -100.0);
    assert_eq!(r.contours[1].contour.bounds().unwrap().min.y, 0.0);

    // A generated fidel has no drawing of its own.
    assert!(matches!(
        p.drawing(&DrawingTarget::fidel("ha", Order::Hamis)),
        Err(ModelError::NotDrawnByHand(..))
    ));
}
