//! Masters, the variation model and instances.

use std::collections::BTreeMap;

use fidel_core::defaults::geez_project;
use fidel_core::designspace::{Axis, Model};
use fidel_core::*;

fn wght() -> Axis {
    Axis { tag: "wght".into(), name: "Weight".into(), min: 100.0, default: 400.0, max: 900.0, map: vec![] }
}

fn loc(v: f64) -> BTreeMap<String, f64> {
    BTreeMap::from([("wght".to_string(), v)])
}

fn stem(x1: f64) -> Vec<Contour> {
    vec![Contour::rect(0, Some(Part::Stem), Vec2::new(60.0, 0.0), Vec2::new(x1, 700.0))]
}

/// Light (100), Regular (400, default) and Bold (900) with a stem 20, 70 and 170 wide.
fn three_masters() -> Project {
    let mut p = geez_project(Metrics::default());
    p.set_axis(None, wght()).unwrap();
    p.bases.get_mut("ha").unwrap().contours = stem(130.0);
    let bold = p.add_master("Bold", loc(900.0));
    let light = p.add_master("Light", loc(100.0));
    p.switch_master(bold).unwrap();
    p.bases.get_mut("ha").unwrap().contours = stem(230.0);
    p.bases.get_mut("ha").unwrap().advance_width = 700.0;
    p.switch_master(light).unwrap();
    p.bases.get_mut("ha").unwrap().contours = stem(80.0);
    p.switch_master(0).unwrap();
    p
}

fn right_edge(p: &Project) -> f64 {
    p.bases["ha"].contours[0].points.iter().map(|q| q.pos.x).fold(f64::MIN, f64::max)
}

#[test]
fn one_axis_model_is_piecewise_linear() {
    let m = Model::new(&[vec![0.0], vec![1.0], vec![-1.0]]).unwrap();
    let vals = vec![vec![10.0], vec![30.0], vec![0.0]];
    assert_eq!(m.interpolate(&vals, &[0.5]), vec![20.0]);
    assert_eq!(m.interpolate(&vals, &[-0.5]), vec![5.0]);
    // Past the masters, extrapolate.
    assert_eq!(m.interpolate(&vals, &[1.5]), vec![40.0]);
    assert!(Model::new(&[vec![1.0]]).is_err());
}

#[test]
fn two_axis_corner_master() {
    // Default, wght max, wdth max and the corner: bilinear inside.
    let locs = vec![vec![0.0, 0.0], vec![1.0, 0.0], vec![0.0, 1.0], vec![1.0, 1.0]];
    let m = Model::new(&locs).unwrap();
    let vals = vec![vec![0.0], vec![10.0], vec![20.0], vec![50.0]];
    let at = m.interpolate(&vals, &[0.5, 0.5]);
    // Bilinear: 0.25*(0+10+20+50) = 20.
    assert!((at[0] - 20.0).abs() < 1e-9, "{at:?}");
    for (l, v) in locs.iter().zip(&vals) {
        assert!((m.interpolate(&vals, l)[0] - v[0]).abs() < 1e-9);
    }
}

#[test]
fn switching_masters_swaps_drawings() {
    let p = three_masters();
    assert_eq!(p.design.masters.len(), 3);
    assert_eq!(right_edge(&p), 130.0);
    assert_eq!(right_edge(&p.master_project(1)), 230.0);
    assert_eq!(p.master_project(1).bases["ha"].advance_width, 700.0);
    assert_eq!(right_edge(&p.master_project(2)), 80.0);
    // Structure is shared.
    assert_eq!(p.master_project(2).families.len(), p.families.len());
}

#[test]
fn instances_interpolate_and_extrapolate() {
    let p = three_masters();
    assert_eq!(right_edge(&p.instance_at(&loc(650.0)).unwrap()), 180.0);
    assert_eq!(p.instance_at(&loc(650.0)).unwrap().bases["ha"].advance_width, 650.0);
    assert_eq!(right_edge(&p.instance_at(&loc(250.0)).unwrap()), 105.0);
    // Point ids stay whole numbers.
    let i = p.instance_at(&loc(700.0)).unwrap();
    assert_eq!(i.bases["ha"].contours[0].points[2].id, p.bases["ha"].contours[0].points[2].id);
}

#[test]
fn axis_map_bends_the_slider() {
    let mut p = three_masters();
    let mut a = wght();
    // User 400..900 maps onto design 400..900, but user 700 is design 500.
    a.map = vec![[100.0, 100.0], [400.0, 400.0], [700.0, 500.0], [900.0, 900.0]];
    p.set_axis(Some("wght"), a).unwrap();
    // Design 500 is a fifth of the way to bold: 130 + 0.2 * 100.
    assert!((right_edge(&p.instance_at(&loc(700.0)).unwrap()) - 150.0).abs() < 1e-6);
}

#[test]
fn incompatible_drawings_are_reported_and_keep_the_default() {
    let mut p = three_masters();
    p.switch_master(1).unwrap();
    p.bases.get_mut("ha").unwrap().contours.push(Contour::rect(
        1,
        None,
        Vec2::new(0.0, 0.0),
        Vec2::new(10.0, 10.0),
    ));
    p.switch_master(0).unwrap();
    let bad = p.compatibility();
    assert_eq!(bad.len(), 1);
    assert_eq!(bad[0].drawing, "base:ha");
    assert_eq!(bad[0].masters, vec!["Bold".to_string()]);
    let i = p.instance_at(&loc(900.0)).unwrap();
    assert_eq!(i.bases["ha"].contours.len(), 1);
    assert_eq!(right_edge(&i), 130.0);
}

#[test]
fn removing_masters_back_to_one() {
    let mut p = three_masters();
    p.switch_master(1).unwrap();
    p.remove_master(1).unwrap();
    assert_eq!(p.design.masters.len(), 2);
    assert_eq!(right_edge(&p), 130.0);
    p.remove_master(1).unwrap();
    assert!(p.design.masters.is_empty());
    assert_eq!(right_edge(&p), 130.0);
}
