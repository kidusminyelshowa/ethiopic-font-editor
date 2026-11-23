//! The M1 scenario at the model level: draw the 5th-order loop once, see it on
//! all 26 Ge'ez bases, change it, and check that Linked fidel follow while
//! Adjusted ones keep their nudges and Detached ones stay put.

use fidel_core::defaults::{geez_project, LOOP_BOTTOM_RIGHT};
use fidel_core::*;

/// Give every base a stem on the left and a leg on the right, at slightly
/// different widths so each family is distinct.
fn draw_placeholder_bases(p: &mut Project) {
    for (i, base) in p.bases.values_mut().enumerate() {
        let w = 400.0 + 10.0 * i as f64;
        base.advance_width = w + 100.0;
        base.contours = vec![
            Contour::rect(0, Some(Part::Stem), Vec2::new(50.0, 0.0), Vec2::new(110.0, 700.0)),
            Contour::rect(1, Some(Part::Leg), Vec2::new(w - 60.0, 0.0), Vec2::new(w, 640.0)),
            Contour::rect(2, Some(Part::Bar), Vec2::new(50.0, 640.0), Vec2::new(w, 700.0)),
        ];
    }
}

/// A square stand-in for the ring, drawn around the origin (the attach point).
fn loop_contours(size: f64) -> Vec<Contour> {
    vec![Contour::rect(0, Some(Part::Ring), Vec2::new(0.0, -size), Vec2::new(size, 0.0))]
}

fn project() -> Project {
    let mut p = geez_project(Metrics::default());
    draw_placeholder_bases(&mut p);
    p.alterations.get_mut(LOOP_BOTTOM_RIGHT).unwrap().contours = loop_contours(80.0);
    p
}

fn loop_box(r: &ResolvedFidel) -> Rect {
    let src = Source::Alteration(LOOP_BOTTOM_RIGHT.into());
    let b = r.from_source(&src).next().and_then(Contour::bounds).expect("loop placed");
    b
}

#[test]
fn loop_lands_on_every_base() {
    let p = project();
    let fifth = p.resolve_order(Order::Hamis);
    assert_eq!(fifth.len(), 26);
    let text: String = fifth.iter().filter_map(|r| r.codepoint).collect();
    assert_eq!(text.chars().count(), 26);
    assert!(text.contains('ሄ') && text.contains('ሌ') && text.contains('ፔ'));

    for r in &fifth {
        assert_eq!(r.state, StateKind::Linked, "{}", r.family);
        assert!(r.diagnostics.is_empty(), "{}: {:?}", r.family, r.diagnostics);
        let base = &p.bases[&p.families[&r.family].base];
        // The leg as this fidel has it: ሄ ሜ ... are built on a 4th order
        // whose leg is shortened.
        let leg = r.from_source(&Source::Base).find(|c| c.id == 1).and_then(Contour::bounds).unwrap();
        let b = loop_box(r);
        // Attached at the middle of the leg's bottom end.
        assert_eq!(b.min.x, (leg.min.x + leg.max.x) / 2.0, "{}", r.family);
        assert_eq!(b.max.y, leg.min.y);
        // Advance grows to keep the base's right sidebearing.
        assert!(r.advance_width >= base.advance_width);
    }
}

#[test]
fn editing_the_loop_updates_linked_and_keeps_nudges() {
    let mut p = project();

    // Adjust ሌ: move one point of the loop.
    let target =
        NudgeTarget::Point { source: Source::Alteration(LOOP_BOTTOM_RIGHT.into()), contour: 0, point: 2 };
    p.nudge("la", Order::Hamis, target.clone(), Vec2::new(15.0, 5.0)).unwrap();
    p.nudge("la", Order::Hamis, target, Vec2::new(5.0, 0.0)).unwrap();
    // Shift the whole loop on ሜ.
    p.nudge(
        "ma",
        Order::Hamis,
        NudgeTarget::Placement { alteration: LOOP_BOTTOM_RIGHT.into() },
        Vec2::new(-10.0, 0.0),
    )
    .unwrap();
    // Redraw ሄ by hand.
    p.detach("ha", Order::Hamis).unwrap();

    assert_eq!(p.fidel("la", Order::Hamis).unwrap().state.kind(), StateKind::Adjusted);
    assert_eq!(p.fidel("la", Order::Hamis).unwrap().state.nudges().len(), 1, "nudges on one point merge");
    let detached_before = p.resolve("ha", Order::Hamis).unwrap();

    // Preview before committing.
    let impacts = p.impacts(&Change::Alteration(LOOP_BOTTOM_RIGHT.into()));
    let effect = |fam: &str| impacts.iter().find(|i| i.family == fam).map(|i| i.effect);
    assert_eq!(effect("la"), Some(Effect::RegeneratesKeepingNudges));
    assert_eq!(effect("ma"), Some(Effect::RegeneratesKeepingNudges));
    assert_eq!(effect("ha"), Some(Effect::Untouched), "detached fidel are listed but will not change");
    assert_eq!(effect("ba"), Some(Effect::Regenerates));
    assert_eq!(impacts.len(), 26);
    assert!(impacts.iter().all(|i| i.order == Order::Hamis));

    // Change the loop: bigger ring.
    p.alterations.get_mut(LOOP_BOTTOM_RIGHT).unwrap().contours = loop_contours(120.0);

    // Linked follow the new drawing.
    let be = p.resolve("ba", Order::Hamis).unwrap();
    let b = loop_box(&be);
    assert_eq!(b.max.x - b.min.x, 120.0);

    // Adjusted keeps its nudge on the new geometry: point 2 is the top-right corner.
    let le = p.resolve("la", Order::Hamis).unwrap();
    let src = Source::Alteration(LOOP_BOTTOM_RIGHT.into());
    let ring = le.from_source(&src).next().unwrap();
    let plain = be.from_source(&src).next().unwrap();
    let leg_offset = |r: &ResolvedFidel| loop_box(r).min.x;
    let p2 = ring.points.iter().find(|pt| pt.id == 2).unwrap().pos;
    let p2_plain = plain.points.iter().find(|pt| pt.id == 2).unwrap().pos;
    assert_eq!(p2.x - leg_offset(&le), p2_plain.x - leg_offset(&be) + 20.0);
    assert_eq!(p2.y, p2_plain.y + 5.0);
    assert!(le.diagnostics.is_empty());

    // Placement nudge survives too.
    let me = p.resolve("ma", Order::Hamis).unwrap();
    let base = &p.bases["ma"].contours[1].bounds().unwrap();
    assert_eq!(loop_box(&me).min.x, (base.min.x + base.max.x) / 2.0 - 10.0);

    // Detached is untouched.
    assert_eq!(p.resolve("ha", Order::Hamis).unwrap(), detached_before);
}

#[test]
fn orphaned_nudges_are_kept_and_reported() {
    let mut p = project();
    let target =
        NudgeTarget::Point { source: Source::Alteration(LOOP_BOTTOM_RIGHT.into()), contour: 0, point: 3 };
    p.nudge("ra", Order::Hamis, target.clone(), Vec2::new(1.0, 1.0)).unwrap();
    // Redraw the loop with fewer points.
    let ring = &mut p.alterations.get_mut(LOOP_BOTTOM_RIGHT).unwrap().contours[0];
    ring.points.truncate(3);
    let r = p.resolve("ra", Order::Hamis).unwrap();
    assert_eq!(r.diagnostics, vec![Diagnostic::OrphanedNudge { target }]);
    assert_eq!(r.state, StateKind::Adjusted);
}

#[test]
fn ru_is_drawn_by_hand_and_starts_from_the_rule() {
    let mut p = project();
    let ru = p.fidel("ra", Order::Kaib).unwrap();
    assert_eq!(ru.codepoint, Some('ሩ'));
    assert_eq!(ru.state.kind(), StateKind::Detached);
    assert_eq!(StateKind::Detached.badge(), Badge::Solid);
    // Nothing drawn yet: it shows the generated form, and still follows
    // the base.
    let r = p.resolve("ra", Order::Kaib).unwrap();
    assert!(r.diagnostics.contains(&Diagnostic::NotYetDrawn));
    assert!(r.from_source(&Source::Base).count() > 0);
    let impacts = p.impacts(&Change::Base("ra".into()));
    assert!(impacts.iter().all(|i| i.effect == Effect::Regenerates));
    // Drawing it starts from that outline, and from then on it stays put.
    p.draw_by_hand("ra", Order::Kaib).unwrap();
    let FidelState::Detached { contours } = &p.fidel("ra", Order::Kaib).unwrap().state else { panic!() };
    assert!(!contours.is_empty());
    let impacts = p.impacts(&Change::Base("ra".into()));
    assert!(impacts.iter().any(|i| i.order == Order::Kaib && i.effect == Effect::Untouched));
}

#[test]
fn undrawn_and_deforming_alterations_are_reported_not_fatal() {
    let p = geez_project(Metrics::default());
    let r = p.resolve("ha", Order::Hamis).unwrap();
    assert!(r.diagnostics.contains(&Diagnostic::BaseNotDrawn));
    assert!(r.diagnostics.contains(&Diagnostic::AlterationNotDrawn { alteration: LOOP_BOTTOM_RIGHT.into() }));

    let mut p = project();
    let r = p.resolve("sa", Order::Sadis).unwrap();
    assert!(r.diagnostics.is_empty(), "{:?}", r.diagnostics);
    // ስ: the first stroke cricks out to the left.
    let stem = r.from_source(&Source::Base).find(|c| c.id == 0).and_then(Contour::bounds).unwrap();
    assert!(stem.min.x < 50.0);

    // Bend is the one verb not built yet; it is reported, not fatal.
    p.alterations.get_mut(defaults::CRICK_FIRST_STROKE).unwrap().verb = Verb::Bend;
    let r = p.resolve("sa", Order::Sadis).unwrap();
    assert!(matches!(r.diagnostics[..], [Diagnostic::DeformNotApplied { verb: Verb::Bend, .. }]));
}

#[test]
fn picking_a_form_relinks_and_draw_it_bakes() {
    let mut p = project();
    let t = NudgeTarget::Placement { alteration: LOOP_BOTTOM_RIGHT.into() };
    p.nudge("sa", Order::Hamis, t, Vec2::new(3.0, 0.0)).unwrap();
    p.set_form("sa", Order::Hamis, Form::Draw).unwrap();
    assert_eq!(p.fidel("sa", Order::Hamis).unwrap().state.kind(), StateKind::Detached);
    let err = p.nudge("sa", Order::Hamis, NudgeTarget::Placement { alteration: "x".into() }, Vec2::ZERO);
    assert_eq!(err, Err(ModelError::NotGenerated(StateKind::Detached)));
    p.set_form("sa", Order::Hamis, Form::Variant(0)).unwrap();
    assert_eq!(p.fidel("sa", Order::Hamis).unwrap().state, FidelState::Linked);
}

#[test]
fn family_can_pick_another_rule_variant() {
    let mut p = project();
    p.families.get_mut("ta").unwrap().rule_variants.insert(Order::Rabi, 1);
    assert_eq!(p.effective_alterations("ta", Order::Rabi).unwrap(), vec!["stretch.stem".to_string()]);
    assert_eq!(p.effective_alterations("la", Order::Rabi).unwrap(), vec!["shorten.left-leg".to_string()]);
}

#[test]
fn project_round_trips_through_json() {
    let mut p = project();
    p.nudge(
        "la",
        Order::Hamis,
        NudgeTarget::Placement { alteration: LOOP_BOTTOM_RIGHT.into() },
        Vec2::new(1.0, 2.0),
    )
    .unwrap();
    p.detach("ha", Order::Sabi).unwrap();
    let json = serde_json::to_string(&p).unwrap();
    let back: Project = serde_json::from_str(&json).unwrap();
    assert_eq!(back, p);
    // Readable keys, for clean diffs later.
    assert!(json.contains("\"hamis\"") && json.contains("\"state\":\"adjusted\""));
}

#[test]
fn set_drawing_updates_dependents_and_rejects_bad_contours() {
    let mut p = project();
    let target = DrawingTarget::Alteration(LOOP_BOTTOM_RIGHT.into());
    p.set_drawing(&target, loop_contours(50.0)).unwrap();
    let b = loop_box(&p.resolve("ba", Order::Hamis).unwrap());
    assert_eq!(b.max.x - b.min.x, 50.0);

    let bad = vec![Contour::new(0, None, vec![Point::off(0, 0.0, 0.0), Point::curve(1, 1.0, 1.0)])];
    assert!(matches!(p.set_drawing(&target, bad), Err(ModelError::InvalidContour { contour: 0, .. })));
    let dup = [loop_contours(10.0), loop_contours(20.0)].concat();
    assert_eq!(p.set_drawing(&target, dup), Err(ModelError::DuplicateContourId(0)));
    assert!(p.set_drawing(&DrawingTarget::Base("nope".into()), vec![]).is_err());
    // Rejected writes leave the drawing as it was.
    assert_eq!(p.drawing(&target).unwrap(), loop_contours(50.0).as_slice());
}

#[test]
fn scoped_edit_changes_only_the_fidel_in_scope() {
    let mut p = project();
    // Nudge ሌ first: the nudge must follow it onto its own copy.
    let target =
        NudgeTarget::Point { source: Source::Alteration(LOOP_BOTTOM_RIGHT.into()), contour: 0, point: 2 };
    p.nudge("la", Order::Hamis, target, Vec2::new(10.0, 0.0)).unwrap();
    let le_before = p.resolve("la", Order::Hamis).unwrap();

    let copy = p
        .fork_alteration(LOOP_BOTTOM_RIGHT, &Scope::Fidel { family: "la".into(), order: Order::Hamis })
        .unwrap();
    assert_eq!(copy, "loop.bottom-right~la-hamis");
    assert_eq!(p.alterations[&copy].forked_from.as_deref(), Some(LOOP_BOTTOM_RIGHT));
    assert_eq!(p.users_of(&copy), vec![("la".to_string(), Order::Hamis)]);
    assert_eq!(p.users_of(LOOP_BOTTOM_RIGHT).len(), 25);

    // Same outline right after the split, nudge included, and no orphans.
    let le = p.resolve("la", Order::Hamis).unwrap();
    let outline = |r: &ResolvedFidel| r.contours.iter().map(|c| c.contour.clone()).collect::<Vec<_>>();
    assert_eq!(outline(&le), outline(&le_before));
    assert!(le.diagnostics.is_empty(), "{:?}", le.diagnostics);

    // Editing the copy changes ሌ only; editing the shared loop changes the rest only.
    p.set_drawing(&DrawingTarget::Alteration(copy.clone()), loop_contours(150.0)).unwrap();
    p.set_drawing(&DrawingTarget::Alteration(LOOP_BOTTOM_RIGHT.into()), loop_contours(100.0)).unwrap();
    let width = |r: &ResolvedFidel, src: &str| {
        let b = r.from_source(&Source::Alteration(src.into())).next().and_then(Contour::bounds).unwrap();
        b.max.x - b.min.x
    };
    // 150 wide, plus the 10-unit nudge on its corner.
    assert_eq!(width(&p.resolve("la", Order::Hamis).unwrap(), &copy), 160.0);
    assert_eq!(width(&p.resolve("ba", Order::Hamis).unwrap(), LOOP_BOTTOM_RIGHT), 100.0);

    // Rejoin: back on the shared loop, nudge kept, copy gone.
    assert_eq!(p.rejoin_alteration(&copy).unwrap(), LOOP_BOTTOM_RIGHT);
    assert!(!p.alterations.contains_key(&copy));
    assert_eq!(p.users_of(LOOP_BOTTOM_RIGHT).len(), 26);
    let le = p.resolve("la", Order::Hamis).unwrap();
    assert!(le.diagnostics.is_empty());
    assert_eq!(le.state, StateKind::Adjusted);
    assert!(p.fidel("la", Order::Hamis).unwrap().alteration_overrides.is_empty());
}

#[test]
fn family_and_order_scopes() {
    let mut p = project();
    let fam = p.fork_alteration(LOOP_BOTTOM_RIGHT, &Scope::Family { family: "ma".into() }).unwrap();
    assert_eq!(p.users_of(&fam), vec![("ma".to_string(), Order::Hamis)]);
    assert!(p.alterations[&fam].name.contains("May family only"), "{}", p.alterations[&fam].name);

    // A copy of a copy rejoins the original shared alteration.
    let one = p.fork_alteration(&fam, &Scope::Fidel { family: "ma".into(), order: Order::Hamis }).unwrap();
    assert_eq!(p.alterations[&one].forked_from.as_deref(), Some(LOOP_BOTTOM_RIGHT));

    // Order scope covers every remaining user in that order.
    let ord = p.fork_alteration(LOOP_BOTTOM_RIGHT, &Scope::Order { order: Order::Hamis }).unwrap();
    assert_eq!(p.users_of(&ord).len(), 25);
    assert!(p.users_of(LOOP_BOTTOM_RIGHT).is_empty());

    // Nothing in scope is an error, and Everywhere is a no-op.
    assert!(matches!(
        p.fork_alteration(LOOP_BOTTOM_RIGHT, &Scope::Order { order: Order::Kaib }),
        Err(ModelError::NotUsedInScope(_))
    ));
    assert_eq!(p.fork_alteration(LOOP_BOTTOM_RIGHT, &Scope::Everywhere).unwrap(), LOOP_BOTTOM_RIGHT);
    assert!(matches!(p.rejoin_alteration(LOOP_BOTTOM_RIGHT), Err(ModelError::NotAFork(_))));
}

#[test]
fn forks_survive_save_and_open() {
    let mut p = project();
    let copy = p
        .fork_alteration(LOOP_BOTTOM_RIGHT, &Scope::Fidel { family: "la".into(), order: Order::Hamis })
        .unwrap();
    let mut buf = std::io::Cursor::new(Vec::new());
    kid::write(&p, &mut buf).unwrap();
    buf.set_position(0);
    let back = kid::read(buf).unwrap();
    assert_eq!(back.users_of(&copy), vec![("la".to_string(), Order::Hamis)]);
    assert_eq!(back, p);
}

#[test]
fn moving_points_on_a_generated_fidel_adds_nudges_and_keeps_it_generated() {
    let mut p = project();
    let mut outline = p.generated_outline("la", Order::Hamis).unwrap();
    let before = outline[0].points[0].pos;
    outline[0].points[0].pos = before + Vec2::new(12.0, -4.0);
    p.set_drawing(&DrawingTarget::fidel("la", Order::Hamis), outline.clone()).unwrap();
    assert_eq!(p.fidel("la", Order::Hamis).unwrap().state.kind(), StateKind::Adjusted);
    let after = p.generated_outline("la", Order::Hamis).unwrap();
    assert_eq!(after[0].points[0].pos, before + Vec2::new(12.0, -4.0));

    // Adding a point is not a nudge: the fidel has to be drawn by hand for that.
    let mut grown = after.clone();
    let extra = grown[0].points[0].clone();
    grown[0].points.push(Point { id: 999, ..extra });
    assert!(matches!(
        p.set_drawing(&DrawingTarget::fidel("la", Order::Hamis), grown),
        Err(ModelError::OutlineChanged)
    ));
    assert_eq!(p.generated_outline("la", Order::Hamis).unwrap(), after);
}
