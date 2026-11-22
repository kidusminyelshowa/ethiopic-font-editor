//! "Built on" links: ሚ and ሜ start from ማ instead of the bare base, so a
//! change to ማ reaches them.

use fidel_core::defaults::{geez_project, LOOP_BOTTOM_RIGHT, STROKE_BOTTOM_RIGHT};
use fidel_core::*;

fn project() -> Project {
    let mut p = geez_project(Metrics::default());
    for base in p.bases.values_mut() {
        base.advance_width = 500.0;
        base.contours = vec![
            Contour::rect(0, Some(Part::Stem), Vec2::new(50.0, 0.0), Vec2::new(110.0, 700.0)),
            Contour::rect(1, Some(Part::Leg), Vec2::new(340.0, 0.0), Vec2::new(400.0, 640.0)),
        ];
    }
    p.alterations.get_mut(LOOP_BOTTOM_RIGHT).unwrap().contours =
        vec![Contour::rect(0, Some(Part::Ring), Vec2::new(0.0, -80.0), Vec2::new(80.0, 0.0))];
    p.alterations.get_mut(STROKE_BOTTOM_RIGHT).unwrap().contours =
        vec![Contour::rect(0, None, Vec2::new(0.0, -10.0), Vec2::new(60.0, 10.0))];
    p
}

/// ማ redrawn by hand: the leg dropped lower and further right.
fn redraw_ma_fourth(p: &mut Project) {
    p.detach("ma", Order::Rabi).unwrap();
    let FidelState::Detached { contours } =
        &mut p.families.get_mut("ma").unwrap().fidels.get_mut(&Order::Rabi).unwrap().state
    else {
        unreachable!()
    };
    contours[1] = Contour::rect(1, Some(Part::Leg), Vec2::new(380.0, -120.0), Vec2::new(440.0, 640.0));
}

fn ring(r: &ResolvedFidel) -> Rect {
    r.from_source(&Source::Alteration(LOOP_BOTTOM_RIGHT.into())).next().and_then(Contour::bounds).unwrap()
}

#[test]
fn defaults_follow_the_derivation_map() {
    let p = geez_project(Metrics::default());
    let on = |fam: &str, o: Order| p.fidel(fam, o).unwrap().built_on;
    for fam in ["ha", "ma", "sza", "wa", "pharyngeal-a", "tza"] {
        assert_eq!(on(fam, Order::Salis), Some(Order::Rabi), "{fam}");
        assert_eq!(on(fam, Order::Hamis), Some(Order::Rabi), "{fam}");
        assert_eq!(on(fam, Order::Kaib), None, "{fam}");
    }
    assert_eq!(on("da", Order::Kaib), Some(Order::Rabi));
    assert_eq!(on("la", Order::Hamis), None);
    assert_eq!(p.built_on_by("ma", Order::Rabi), vec![Order::Salis, Order::Hamis]);
}

#[test]
fn a_change_to_the_fourth_order_reaches_the_fifth() {
    let mut p = project();
    let before = p.resolve("ma", Order::Hamis).unwrap();
    // Untouched ማ is just the base, so ሜ looks as it did before links existed.
    assert_eq!(ring(&before).min, Vec2::new(370.0, -80.0));
    assert!(before.diagnostics.iter().all(|d| !matches!(d, Diagnostic::BuiltOnCycle { .. })));

    redraw_ma_fourth(&mut p);
    let me = p.resolve("ma", Order::Hamis).unwrap();
    // ሜ carries ማ's new leg, and the loop moved to its new bottom end.
    assert!(me.contours.iter().any(|c| c.contour.bounds().unwrap().min == Vec2::new(380.0, -120.0)));
    assert_eq!(ring(&me).min, Vec2::new(410.0, -200.0));
    assert!(me.advance_width >= before.advance_width);
    assert_eq!(me.state, StateKind::Linked);

    // ሙ is not built on ማ and keeps the base's leg.
    let ml = p.resolve("la", Order::Hamis).unwrap();
    assert_eq!(ring(&ml).min, Vec2::new(370.0, -80.0));
}

#[test]
fn nudges_on_the_child_sit_on_top_of_the_parent() {
    let mut p = project();
    p.nudge(
        "ha",
        Order::Rabi,
        NudgeTarget::Point { source: Source::Base, contour: 1, point: 0 },
        Vec2::new(0.0, -30.0),
    )
    .unwrap();
    p.nudge(
        "ha",
        Order::Hamis,
        NudgeTarget::Point { source: Source::Base, contour: 1, point: 0 },
        Vec2::new(5.0, 0.0),
    )
    .unwrap();
    let he = p.resolve("ha", Order::Hamis).unwrap();
    let leg = he.from_source(&Source::Base).find(|c| c.id == 1).unwrap();
    let base_pt = p.bases["ha"].contours[1].points[0].pos;
    assert_eq!(leg.points[0].pos, base_pt + Vec2::new(5.0, -30.0));
}

#[test]
fn impacts_reach_fidel_built_on_the_changed_one() {
    let mut p = project();
    // ሄ does not use the 4th-order deform itself, but ሃ does and ሄ is built on ሃ.
    let shorten = Change::Alteration(defaults::SHORTEN_LEFT_LEG.into());
    let hit: Vec<_> = p.impacts(&shorten).into_iter().filter(|i| i.family == "ha").map(|i| i.order).collect();
    assert_eq!(hit, vec![Order::Salis, Order::Rabi, Order::Hamis]);

    p.set_built_on("ha", Order::Hamis, None).unwrap();
    let hit: Vec<_> = p.impacts(&shorten).into_iter().filter(|i| i.family == "ha").map(|i| i.order).collect();
    assert_eq!(hit, vec![Order::Salis, Order::Rabi]);
}

#[test]
fn loops_are_refused_and_survive_if_forced() {
    let mut p = project();
    assert_eq!(
        p.set_built_on("ma", Order::Rabi, Some(Order::Hamis)),
        Err(ModelError::BuiltOnCycle(Order::Hamis))
    );
    assert_eq!(
        p.set_built_on("ma", Order::Rabi, Some(Order::Rabi)),
        Err(ModelError::BuiltOnCycle(Order::Rabi))
    );
    p.set_built_on("ma", Order::Sabi, Some(Order::Hamis)).unwrap();
    assert_eq!(p.fidel("ma", Order::Sabi).unwrap().built_on, Some(Order::Hamis));

    // A loop written into a file by hand still resolves, from the base.
    p.families.get_mut("ma").unwrap().fidels.get_mut(&Order::Rabi).unwrap().built_on = Some(Order::Hamis);
    let r = p.resolve("ma", Order::Hamis).unwrap();
    assert!(
        r.diagnostics.iter().any(|d| matches!(d, Diagnostic::BuiltOnCycle { .. })),
        "{:?}",
        r.diagnostics
    );
    assert!(!r.contours.is_empty());
    assert!(!p.impacts(&Change::Base("ma".into())).is_empty());
}

#[test]
fn links_survive_save_and_open() {
    let mut p = project();
    p.set_built_on("la", Order::Sabi, Some(Order::Rabi)).unwrap();
    let dir = std::env::temp_dir().join(format!("built-on-{}.kid", std::process::id()));
    kid::save(&p, &dir).unwrap();
    let back = kid::open(&dir).unwrap();
    std::fs::remove_dir_all(&dir).ok();
    assert_eq!(back.fidel("la", Order::Sabi).unwrap().built_on, Some(Order::Rabi));
    assert_eq!(back.fidel("ma", Order::Hamis).unwrap().built_on, Some(Order::Rabi));
}
