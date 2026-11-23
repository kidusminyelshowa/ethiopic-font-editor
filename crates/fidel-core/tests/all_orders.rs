//! M2: the deforming orders, rule variants per family, Pa-height zones and
//! components.

use fidel_core::defaults::{
    geez_project, LOOP_TOP_RIGHT, RING_ON_BAR, SHORTEN_LEFT_LEG, SHORTEN_RIGHT_LEG, STRETCH_STEM,
};
use fidel_core::*;

/// Every base: a stem on the left, a leg on the right, a bar on top.
fn project() -> Project {
    let mut p = geez_project(Metrics::default());
    for base in p.bases.values_mut() {
        base.advance_width = 560.0;
        base.contours = vec![
            Contour::rect(0, Some(Part::Stem), Vec2::new(50.0, 0.0), Vec2::new(110.0, 700.0)),
            Contour::rect(1, Some(Part::Leg), Vec2::new(400.0, 0.0), Vec2::new(460.0, 700.0)),
            Contour::rect(2, Some(Part::Bar), Vec2::new(50.0, 640.0), Vec2::new(460.0, 700.0)),
        ];
    }
    p
}

fn stroke(r: &ResolvedFidel, id: u32) -> Rect {
    r.from_source(&Source::Base).find(|c| c.id == id).and_then(Contour::bounds).unwrap()
}

#[test]
fn fourth_order_shortens_the_left_leg_onto_its_zone() {
    let mut p = project();
    // A base with two legs: the left one is shortened.
    p.bases.get_mut("la").unwrap().contours[0].part = Some(Part::Leg);
    let r = p.resolve("la", Order::Rabi).unwrap();
    assert!(r.diagnostics.is_empty(), "{:?}", r.diagnostics);
    let y = p.metrics.zone_y("short-leg").unwrap();
    assert_eq!(stroke(&r, 0).min.y, y);
    assert_eq!(stroke(&r, 1).min.y, 0.0);

    // Moving the zone moves every shortened leg with it.
    p.metrics.set_zone("short-leg", None, 350.0);
    let r = p.resolve("la", Order::Rabi).unwrap();
    assert!((stroke(&r, 0).min.y - 350.0).abs() < 1e-9);
}

#[test]
fn tawe_sweeps_its_stem_left_instead() {
    let p = project();
    assert_eq!(p.families["ta"].rule_variants.get(&Order::Rabi), Some(&1));
    assert_eq!(p.effective_alterations("ta", Order::Rabi).unwrap(), vec![STRETCH_STEM.to_string()]);
    assert_eq!(p.effective_alterations("la", Order::Rabi).unwrap(), vec![SHORTEN_LEFT_LEG.to_string()]);
    let r = p.resolve("ta", Order::Rabi).unwrap();
    // The stroke reaching the bottom on the left sweeps out to the left and
    // under the baseline.
    assert!(stroke(&r, 0).min.x < 50.0);
    assert!(stroke(&r, 0).min.y < 0.0);
}

#[test]
fn seventh_order_shortens_the_right_leg_or_rings_the_top() {
    let mut p = project();
    // ሶ: the right leg ends on the zone, the left one stays.
    let r = p.resolve("sa", Order::Sabi).unwrap();
    assert_eq!(p.effective_alterations("sa", Order::Sabi).unwrap(), vec![SHORTEN_RIGHT_LEG.to_string()]);
    assert!((stroke(&r, 1).min.y - p.metrics.zone_y("short-leg").unwrap()).abs() < 1e-9);
    assert_eq!(stroke(&r, 0).min.y, 0.0);
    // ቶ and ሆ get a ring instead; ሎ a ring on a short bar.
    assert_eq!(p.effective_alterations("ta", Order::Sabi).unwrap(), vec![LOOP_TOP_RIGHT.to_string()]);
    assert_eq!(p.effective_alterations("ha", Order::Sabi).unwrap(), vec![LOOP_TOP_RIGHT.to_string()]);
    assert_eq!(p.effective_alterations("la", Order::Sabi).unwrap(), vec![RING_ON_BAR.to_string()]);
    // ሞ is drawn by hand.
    assert_eq!(p.fidel("ma", Order::Sabi).unwrap().state.kind(), StateKind::Detached);

    p.set_rule_variant("sa", Order::Sabi, 1).unwrap();
    assert_eq!(p.effective_alterations("sa", Order::Sabi).unwrap(), vec![LOOP_TOP_RIGHT.to_string()]);
    assert!(p.set_rule_variant("sa", Order::Sabi, 9).is_err());
    p.set_rule_variant("sa", Order::Sabi, 0).unwrap();
    assert!(!p.families["sa"].rule_variants.contains_key(&Order::Sabi));
}

#[test]
fn hawt_shortens_every_leg_but_one() {
    let mut p = project();
    // ሐ: a third leg in the middle.
    let base = p.bases.get_mut("hha").unwrap();
    base.contours.push(Contour::rect(3, Some(Part::Leg), Vec2::new(230.0, 0.0), Vec2::new(290.0, 700.0)));
    let y = p.metrics.zone_y("short-leg").unwrap();
    let r = p.resolve("hha", Order::Rabi).unwrap();
    assert!((stroke(&r, 0).min.y - y).abs() < 1e-9);
    assert!((stroke(&r, 3).min.y - y).abs() < 1e-9);
    assert_eq!(stroke(&r, 1).min.y, 0.0);
    let r = p.resolve("hha", Order::Sabi).unwrap();
    assert_eq!(stroke(&r, 0).min.y, 0.0);
    assert!((stroke(&r, 3).min.y - y).abs() < 1e-9);
    assert!((stroke(&r, 1).min.y - y).abs() < 1e-9);
}

#[test]
fn a_family_moves_its_own_short_leg() {
    let mut p = project();
    let y = p.metrics.zone_y("short-leg").unwrap();
    p.set_attach_offset("sa", SHORTEN_LEFT_LEG, Vec2::new(0.0, 40.0)).unwrap();
    let r = p.resolve("sa", Order::Rabi).unwrap();
    assert!((stroke(&r, 0).min.y - (y + 40.0)).abs() < 1e-9);
    // Other families keep the shared height.
    let r = p.resolve("ba", Order::Rabi).unwrap();
    assert!((stroke(&r, 0).min.y - y).abs() < 1e-9);
}

#[test]
fn sixth_order_forms() {
    let mut p = project();
    // ብ: the foot flicks left; its throw is editable.
    let r = p.resolve("ba", Order::Sadis).unwrap();
    assert!(stroke(&r, 0).min.x < 50.0);
    p.set_deform(defaults::FOOT_FLICK, Some("crick".into()), Some(100.0)).unwrap();
    let r = p.resolve("ba", Order::Sadis).unwrap();
    assert_eq!(stroke(&r, 0).min.x, -50.0);
    // ስ: the first stroke cricks at the top, its foot stays.
    let r = p.resolve("sa", Order::Sadis).unwrap();
    assert!(stroke(&r, 0).min.x < 50.0);
    // ል: a ring at the foot.
    assert_eq!(
        p.effective_alterations("la", Order::Sadis).unwrap(),
        vec![defaults::LOOP_BOTTOM_LEFT.to_string()]
    );
}

#[test]
fn leaves_land_on_bar_ends_and_follow_them() {
    let mut p = project();
    let leaf = p.add_component("Leaf", ComponentKind::Leaf);
    p.set_drawing(
        &DrawingTarget::Component(leaf.clone()),
        vec![Contour::rect(0, Some(Part::Leaf), Vec2::new(-20.0, -40.0), Vec2::new(0.0, 0.0))],
    )
    .unwrap();
    let leaves = |r: &ResolvedFidel| {
        r.contours
            .iter()
            .filter(|c| matches!(c.source, Source::Leaf(_)))
            .filter_map(|c| c.contour.bounds())
            .collect::<Vec<_>>()
    };
    // Every base has a bar: a leaf on each end, none on the legs.
    let r = p.resolve("ta", Order::Giiz).unwrap();
    let l = leaves(&r);
    assert_eq!(l.len(), 2);
    assert!(l.iter().any(|b| b.max.x == 460.0 && b.max.y == 700.0));
    assert!(l.iter().any(|b| b.min.x == 50.0 && b.max.y == 700.0));
    // Built on another order, the leaves are not doubled.
    assert_eq!(leaves(&p.resolve("ha", Order::Salis).unwrap()).len(), 2);
    // One end switched off.
    p.components.get_mut(&leaf).unwrap().off.insert("ta/2:l".into());
    assert_eq!(leaves(&p.resolve("ta", Order::Giiz).unwrap()).len(), 1);
}

#[test]
fn old_irregular_fidel_load_as_drawn_or_generated() {
    let drawn: FidelState =
        serde_json::from_str(r#"{"state":"irregular","form":{"form":"drawn","contours":[]},"note":"x"}"#)
            .unwrap();
    assert_eq!(drawn, FidelState::Detached { contours: vec![] });
    let recipe: FidelState =
        serde_json::from_str(r#"{"state":"irregular","form":{"form":"recipe","alterations":["a"]}}"#)
            .unwrap();
    assert_eq!(recipe, FidelState::Linked);
}

#[test]
fn components_are_placed_on_bases_and_follow_deforms() {
    let mut p = project();
    let leaf = p.add_component("Leaf", ComponentKind::Leaf);
    assert_eq!(leaf, "leaf");
    assert_eq!(p.add_component("Leaf", ComponentKind::Leaf), "leaf-2");
    p.set_drawing(
        &DrawingTarget::Component(leaf.clone()),
        vec![Contour::rect(0, Some(Part::Leaf), Vec2::new(-30.0, 0.0), Vec2::new(30.0, 20.0))],
    )
    .unwrap();

    // A foot on the left stroke, and a flipped one on the bar's end.
    let mut foot = ComponentRef::new(0, leaf.clone(), Vec2::new(80.0, 0.0));
    foot.flip_y = true;
    foot.on = Some(0);
    let end = ComponentRef::new(1, leaf.clone(), Vec2::new(460.0, 670.0));
    p.bases.get_mut("la").unwrap().contours[0].part = Some(Part::Leg);
    p.set_base_components("la", vec![foot, end]).unwrap();

    let r = p.resolve("la", Order::Giiz).unwrap();
    let placed: Vec<Rect> = r.from_source(&Source::Component(0)).filter_map(Contour::bounds).collect();
    assert_eq!(placed, vec![Rect { min: Vec2::new(50.0, -20.0), max: Vec2::new(110.0, 0.0) }]);
    assert_eq!(r.from_source(&Source::Component(1)).count(), 1);

    // The 4th order shortens the left leg; its foot rides up with it.
    let r = p.resolve("la", Order::Rabi).unwrap();
    let y = p.metrics.zone_y("short-leg").unwrap();
    let foot = r.from_source(&Source::Component(0)).next().and_then(Contour::bounds).unwrap();
    assert_eq!(foot.max.y, y);
    // The bar's leaf stays put.
    let end = r.from_source(&Source::Component(1)).next().and_then(Contour::bounds).unwrap();
    assert_eq!(end.min.y, 670.0);

    // Unknown components and clashing ids are refused; removing a component
    // removes its placements.
    assert!(p.set_base_components("la", vec![ComponentRef::new(0, "nope", Vec2::ZERO)]).is_err());
    let twice =
        vec![ComponentRef::new(0, leaf.clone(), Vec2::ZERO), ComponentRef::new(0, leaf.clone(), Vec2::ZERO)];
    assert!(p.set_base_components("la", twice).is_err());
    p.remove_component(&leaf).unwrap();
    assert!(p.bases["la"].components.is_empty());
}

#[test]
fn zones_and_components_survive_a_save() {
    let mut p = project();
    p.metrics.set_zone("crick", None, 140.0);
    p.metrics.set_zone("loop-top", Some("Loop top"), 600.0);
    let leaf = p.add_component("Cap", ComponentKind::Cap);
    p.set_base_components("ha", vec![ComponentRef::new(3, leaf, Vec2::new(1.0, 2.0))]).unwrap();
    p.set_rule_variant("ha", Order::Sabi, 1).unwrap();
    let mut bytes = std::io::Cursor::new(Vec::new());
    kid::write(&p, &mut bytes).unwrap();
    bytes.set_position(0);
    let back = kid::read(bytes).unwrap();
    assert_eq!(back, p);
    assert!((back.metrics.zone_y("crick").unwrap() - 140.0).abs() < 1e-9);
    assert_eq!(back.metrics.zones().len(), 4);

    // A project saved before zones existed still loads, with the defaults.
    let old: Metrics = serde_json::from_str(r#"{"units_per_em":1000,"pa_top":700,"pa_bottom":0}"#).unwrap();
    assert_eq!(old.zones().len(), 3);
}
