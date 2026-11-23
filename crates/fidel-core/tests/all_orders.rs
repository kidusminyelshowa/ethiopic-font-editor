//! M2: the deforming orders, rule variants per family, Pa-height zones and
//! components.

use fidel_core::defaults::{geez_project, SHORTEN_LEFT_LEG, SHORTEN_RIGHT_LEG, STRETCH_STEM};
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
fn tawe_stretches_its_stem_instead() {
    let p = project();
    assert_eq!(p.families["ta"].rule_variants.get(&Order::Rabi), Some(&1));
    assert_eq!(p.effective_alterations("ta", Order::Rabi).unwrap(), vec![STRETCH_STEM.to_string()]);
    assert_eq!(p.effective_alterations("la", Order::Rabi).unwrap(), vec![SHORTEN_LEFT_LEG.to_string()]);
    let r = p.resolve("ta", Order::Rabi).unwrap();
    // The right-hand stroke reaching the bottom leans out to the right.
    assert!(stroke(&r, 1).max.x > 460.0);
    assert!(r.advance_width > 560.0);
}

#[test]
fn seventh_order_variant_shortens_the_right_leg() {
    let mut p = project();
    let r = p.resolve("la", Order::Sabi).unwrap();
    assert_eq!(stroke(&r, 1).min.y, 0.0);

    p.set_rule_variant("la", Order::Sabi, 1).unwrap();
    assert_eq!(p.effective_alterations("la", Order::Sabi).unwrap(), vec![SHORTEN_RIGHT_LEG.to_string()]);
    let r = p.resolve("la", Order::Sabi).unwrap();
    assert_eq!(stroke(&r, 1).min.y, p.metrics.zone_y("short-leg").unwrap());
    assert_eq!(stroke(&r, 0).min.y, 0.0);

    assert!(p.set_rule_variant("la", Order::Sabi, 2).is_err());
    p.set_rule_variant("la", Order::Sabi, 0).unwrap();
    assert!(!p.families["la"].rule_variants.contains_key(&Order::Sabi));
}

#[test]
fn sixth_order_crick_amount_is_editable() {
    let mut p = project();
    let r = p.resolve("la", Order::Sadis).unwrap();
    let default_dx = 50.0 - stroke(&r, 0).min.x;
    assert!(default_dx > 0.0);
    p.set_deform(defaults::CRICK_FIRST_STROKE, Some("crick".into()), Some(100.0)).unwrap();
    let r = p.resolve("la", Order::Sadis).unwrap();
    assert_eq!(stroke(&r, 0).min.x, -50.0);
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
