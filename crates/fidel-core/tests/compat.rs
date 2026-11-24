//! Matching masters: contour order, direction and start points.

use std::collections::BTreeMap;

use fidel_core::compat::{difference, match_contours};
use fidel_core::defaults::geez_project;
use fidel_core::designspace::Axis;
use fidel_core::*;

fn rect(id: u32, x0: f64, x1: f64) -> Contour {
    Contour::rect(id, None, Vec2::new(x0, 0.0), Vec2::new(x1, 700.0))
}

#[test]
fn reorders_reverses_and_restarts() {
    let reference = vec![rect(0, 0.0, 100.0), rect(1, 300.0, 400.0)];
    // Swapped, the second reversed and starting at another corner.
    let mut b = rect(1, 280.0, 420.0);
    fidel_core::component::reverse(&mut b);
    b.points.rotate_left(2);
    let other = vec![b, rect(0, -10.0, 110.0)];
    let fixed = match_contours(&reference, &other);
    assert_eq!(fixed[0].points[0].pos, Vec2::new(-10.0, 0.0));
    assert_eq!(difference(&reference, &fixed), None);
    // Same corner first, same direction.
    let start = |c: &Contour| (c.points[0].pos.x - 280.0 < 1.0, c.points[0].pos.y);
    assert_eq!(start(&fixed[1]).1, reference[1].points[0].pos.y);
    let dir = |c: &Contour| c.points[1].pos - c.points[0].pos;
    let (a, r) = (dir(&fixed[1]), dir(&reference[1]));
    assert!(a.x.signum() == r.x.signum() && a.y.signum() == r.y.signum());
}

#[test]
fn explains_what_differs() {
    let a = vec![rect(0, 0.0, 100.0)];
    assert_eq!(difference(&a, &[]).unwrap(), "0 contours, the default master has 1");
    let mut b = rect(0, 0.0, 100.0);
    b.points.pop();
    assert!(difference(&a, &[b]).unwrap().contains("3 points"));
}

#[test]
fn match_masters_fixes_every_master() {
    let mut p = geez_project(Metrics::default());
    p.set_axis(
        None,
        Axis {
            tag: "wght".into(),
            name: "Weight".into(),
            min: 400.0,
            default: 400.0,
            max: 700.0,
            map: vec![],
        },
    )
    .unwrap();
    p.bases.get_mut("ha").unwrap().contours = vec![rect(0, 0.0, 100.0), rect(1, 300.0, 400.0)];
    let bold = p.add_master("Bold", BTreeMap::from([("wght".to_string(), 700.0)]));
    p.switch_master(bold).unwrap();
    p.bases.get_mut("ha").unwrap().contours = vec![rect(1, 290.0, 420.0), rect(0, 0.0, 150.0)];
    p.switch_master(0).unwrap();
    let target = DrawingTarget::Base("ha".into());
    assert!(p.master_drawings(&target).unwrap().iter().all(|m| m.problem.is_none()));
    assert_eq!(p.match_masters(&target).unwrap(), 1);
    let bold_ha = &p.master_project(bold).bases["ha"].contours;
    assert_eq!(bold_ha[0].points[0].pos.x, 0.0);
    assert_eq!(p.design.active, 0);
}
