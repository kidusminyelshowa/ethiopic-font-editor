//! Components placed on one fidel, on top of its generated or drawn outline.

use fidel_core::defaults::geez_project;
use fidel_core::fidel::Source;
use fidel_core::*;

fn setup() -> (Project, String) {
    let mut p = geez_project(Metrics::default());
    p.set_drawing(
        &DrawingTarget::Base("ha".into()),
        vec![Contour::rect(0, None, Vec2::new(60.0, 0.0), Vec2::new(130.0, 700.0))],
    )
    .unwrap();
    let id = p.add_component("Dot", ComponentKind::Leaf);
    p.components.get_mut(&id).unwrap().lands_on.clear();
    p.set_drawing(
        &DrawingTarget::Component(id.clone()),
        vec![Contour::rect(0, None, Vec2::ZERO, Vec2::new(20.0, 20.0))],
    )
    .unwrap();
    (p, id)
}

#[test]
fn a_placement_on_one_fidel_stays_on_it() {
    let (mut p, id) = setup();
    let before = p.generated_outline("ha", Order::Kaib).unwrap();
    p.set_fidel_components(
        "ha",
        Order::Kaib,
        vec![ComponentRef::new(0, id.clone(), Vec2::new(300.0, 300.0))],
    )
    .unwrap();
    let r = p.resolve("ha", Order::Kaib).unwrap();
    assert_eq!(r.from_source(&Source::Placed(0)).count(), 1);
    // Not part of the editable outline, and not on the other orders.
    assert_eq!(p.generated_outline("ha", Order::Kaib).unwrap().len(), before.len());
    assert_eq!(p.resolve("ha", Order::Salis).unwrap().from_source(&Source::Placed(0)).count(), 0);
    // Drawn by hand, it keeps its placements as placements.
    p.detach("ha", Order::Kaib).unwrap();
    let r = p.resolve("ha", Order::Kaib).unwrap();
    assert_eq!(r.from_source(&Source::Placed(0)).count(), 1);
    assert_eq!(r.contours.len(), before.len() + 1);
    // Removing the component removes the placement.
    p.remove_component(&id).unwrap();
    assert!(p.fidel("ha", Order::Kaib).unwrap().components.is_empty());
}
