//! Parts with their own axes: states, per-placement settings, and axes tied
//! to the font's.

use std::collections::BTreeMap;

use fidel_core::defaults::geez_project;
use fidel_core::designspace::Axis;
use fidel_core::fidel::Source;
use fidel_core::*;

fn square(size: f64) -> Vec<Contour> {
    vec![Contour::rect(0, None, Vec2::ZERO, Vec2::new(size, size))]
}

fn size_axis(follows: Option<&str>) -> PartAxis {
    PartAxis { name: "Size".into(), min: 0.0, default: 0.0, max: 100.0, follows: follows.map(String::from) }
}

fn values(v: f64) -> PartValues {
    BTreeMap::from([("Size".to_string(), v)])
}

/// ሀ with a 40-unit leaf placed at the origin; the leaf grows to 80 at Size 100.
fn project(follows: Option<&str>, at: f64) -> (Project, String) {
    let mut p = geez_project(Metrics::default());
    let id = p.add_component("Leaf", ComponentKind::Leaf);
    p.components.get_mut(&id).unwrap().lands_on.clear();
    p.set_drawing(&DrawingTarget::Component(id.clone()), square(40.0)).unwrap();
    p.set_part_axes(&id, vec![size_axis(follows)]).unwrap();
    let n = p.add_part_state(&id, values(100.0)).unwrap();
    p.set_drawing(&DrawingTarget::Component(format!("{id}#{n}")), square(80.0)).unwrap();
    let mut r = ComponentRef::new(0, id.clone(), Vec2::ZERO);
    r.values = values(at);
    p.bases.get_mut("ha").unwrap().components = vec![r];
    (p, id)
}

fn leaf_width(p: &Project) -> f64 {
    let r = p.resolve("ha", Order::Giiz).unwrap();
    let b = r.from_source(&Source::Component(0)).next().unwrap().bounds().unwrap();
    b.max.x - b.min.x
}

#[test]
fn a_placement_sits_between_states() {
    let (p, _) = project(None, 50.0);
    assert!((leaf_width(&p) - 60.0).abs() < 1e-6);
    let (p, _) = project(None, 0.0);
    assert!((leaf_width(&p) - 40.0).abs() < 1e-6);
    // Past the range is held at the end.
    let (p, _) = project(None, 150.0);
    assert!((leaf_width(&p) - 80.0).abs() < 1e-6);
}

#[test]
fn a_state_that_does_not_match_is_left_out() {
    let (mut p, id) = project(None, 100.0);
    let mut odd = square(80.0);
    odd.push(Contour::rect(1, None, Vec2::ZERO, Vec2::new(5.0, 5.0)));
    p.set_drawing(&DrawingTarget::Component(format!("{id}#1")), odd).unwrap();
    assert!(p.part_view(&id).unwrap().states[0].problem.is_some());
    assert!((leaf_width(&p) - 40.0).abs() < 1e-6);
}

#[test]
fn an_axis_tied_to_weight_follows_the_font() {
    let (mut p, _) = project(Some("wght"), 0.0);
    p.set_axis(
        None,
        Axis {
            tag: "wght".into(),
            name: "Weight".into(),
            min: 400.0,
            default: 400.0,
            max: 900.0,
            map: vec![],
        },
    )
    .unwrap();
    let bold = p.add_master("Bold", BTreeMap::from([("wght".to_string(), 900.0)]));
    // The hand-set value is ignored once tied.
    assert!((leaf_width(&p) - 40.0).abs() < 1e-6);
    assert!((leaf_width(&p.master_project(bold)) - 80.0).abs() < 1e-6);
    let mid = p.instance_at(&BTreeMap::from([("wght".to_string(), 650.0)])).unwrap();
    assert!((leaf_width(&mid) - 60.0).abs() < 1e-6);
}

#[test]
fn states_are_kept_per_master_and_axes_clean_up() {
    let (mut p, id) = project(None, 50.0);
    p.set_axis(
        None,
        Axis {
            tag: "wght".into(),
            name: "Weight".into(),
            min: 400.0,
            default: 400.0,
            max: 900.0,
            map: vec![],
        },
    )
    .unwrap();
    let bold = p.add_master("Bold", BTreeMap::from([("wght".to_string(), 900.0)]));
    p.switch_master(bold).unwrap();
    p.set_drawing(&DrawingTarget::Component(format!("{id}#1")), square(120.0)).unwrap();
    // A second state reaches the other master too.
    p.add_part_state(&id, values(50.0)).unwrap();
    p.switch_master(0).unwrap();
    assert_eq!(p.components[&id].states.len(), 2);
    assert_eq!(p.components[&id].states[0].contours, square(80.0));
    p.switch_master(bold).unwrap();
    assert_eq!(p.components[&id].states[0].contours, square(120.0));
    p.remove_part_state(&id, 1).unwrap();
    p.switch_master(0).unwrap();
    assert_eq!(p.components[&id].states.len(), 1);
    // Dropping the axis drops its states and settings.
    p.set_part_axes(&id, vec![]).unwrap();
    assert!(p.components[&id].states.is_empty());
    assert!(p.bases["ha"].components[0].values.is_empty());
    assert!(p.set_part_axes(&id, vec![PartAxis { min: 10.0, ..size_axis(None) }]).is_err());
}
