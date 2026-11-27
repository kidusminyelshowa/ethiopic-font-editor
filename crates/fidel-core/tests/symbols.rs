//! Numerals and punctuation can hold components: ፩ to ፼ share their frame.

use fidel_core::defaults::starter_project;
use fidel_core::{ComponentKind, ComponentRef, Contour, DrawingTarget, Metrics, Vec2};

#[test]
fn a_numeral_frame_is_drawn_once_and_placed_on_each_numeral() {
    let mut p = starter_project(Metrics::default());
    let frame = p.add_component("Numeral frame", ComponentKind::Corner);
    let bars = vec![
        Contour::rect(0, None, Vec2::new(0.0, 0.0), Vec2::new(400.0, 40.0)),
        Contour::rect(1, None, Vec2::new(0.0, 560.0), Vec2::new(400.0, 600.0)),
    ];
    p.set_drawing(&DrawingTarget::Component(frame.clone()), bars).unwrap();
    for id in ["uni1369", "uni136A"] {
        p.set_symbol_components(id, vec![ComponentRef::new(0, frame.clone(), Vec2::new(50.0, 0.0))]).unwrap();
    }
    assert_eq!(p.symbol_outline("uni1369").len(), 2);
    assert_eq!(p.symbol_outline("uni1369")[0].bounds().unwrap().min.x, 50.0);

    // Redrawing the frame reaches every numeral, and the font has them.
    p.set_drawing(
        &DrawingTarget::Component(frame.clone()),
        vec![Contour::rect(0, None, Vec2::new(0.0, 0.0), Vec2::new(420.0, 40.0))],
    )
    .unwrap();
    assert_eq!(p.symbol_outline("uni136A")[0].bounds().unwrap().max.x, 470.0);

    // Removing the component removes its placements.
    p.remove_component(&frame).unwrap();
    assert!(p.symbols["uni1369"].components.is_empty());
    assert!(p.set_symbol_components("uni1369", vec![ComponentRef::new(0, "nope", Vec2::ZERO)]).is_err());
}
