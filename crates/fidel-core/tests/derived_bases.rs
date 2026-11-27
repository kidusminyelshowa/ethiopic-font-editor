//! Bases made from another row's base: ሸ is ሰ with a cap.

use fidel_core::defaults::{starter_project, CAP_TOP};
use fidel_core::{Contour, DrawingTarget, Metrics, Part, Vec2};

fn stem(id: u32, x: f64) -> Contour {
    Contour::rect(id, Some(Part::Stem), Vec2::new(x, 0.0), Vec2::new(x + 60.0, 700.0))
}

#[test]
fn a_capped_base_follows_its_source() {
    let mut p = starter_project(Metrics::default());
    let sha = p.bases["sha"].derived.clone().expect("ሸ is derived");
    assert_eq!(sha.from, "sa");
    assert_eq!(sha.adds, vec![CAP_TOP.to_string()]);

    p.set_drawing(&DrawingTarget::Base("sa".into()), vec![stem(0, 50.0), stem(1, 250.0)]).unwrap();
    assert_eq!(p.bases["sha"].contours.len(), 2, "a copy of ሰ until the cap is drawn");

    // The cap is drawn once, from the top left corner.
    let cap = Contour::rect(0, None, Vec2::new(0.0, 0.0), Vec2::new(260.0, 40.0));
    p.set_drawing(&DrawingTarget::Alteration(CAP_TOP.into()), vec![cap]).unwrap();
    let b = &p.bases["sha"];
    assert_eq!(b.contours.len(), 3);
    let top = b.contours[2].bounds().unwrap();
    // On the top of the leftmost stroke.
    assert_eq!((top.min.x, top.min.y), (80.0, 700.0));
    // Contour ids stay unique.
    let mut ids: Vec<u32> = b.contours.iter().map(|c| c.id).collect();
    ids.dedup();
    assert_eq!(ids.len(), 3);

    // Editing ሰ reaches ሸ, and every fidel built from it.
    p.set_drawing(&DrawingTarget::Base("sa".into()), vec![stem(0, 50.0), stem(1, 300.0)]).unwrap();
    assert_eq!(p.bases["sha"].contours[1].bounds().unwrap().min.x, 300.0);
    assert!(p.resolve("sha", fidel_core::Order::Kaib).unwrap().contours.len() >= 3);
    let reach = p.impacts(&fidel_core::Change::Base("sa".into()));
    assert!(reach.iter().any(|i| i.family == "sha"));
    let reach = p.impacts(&fidel_core::Change::Alteration(CAP_TOP.into()));
    assert!(reach.iter().any(|i| i.family == "sha") && !reach.iter().any(|i| i.family == "ja"));

    // Drawing on ሸ itself makes it its own; following again rebuilds it.
    let mut own = p.bases["sha"].contours.clone();
    own[0].translate(Vec2::new(5.0, 0.0));
    p.set_drawing(&DrawingTarget::Base("sha".into()), own).unwrap();
    assert!(!p.bases["sha"].follows());
    p.set_drawing(&DrawingTarget::Base("sa".into()), vec![stem(0, 50.0)]).unwrap();
    assert_eq!(p.bases["sha"].contours.len(), 3, "its own drawing is kept");
    p.set_base_follows("sha", true).unwrap();
    assert_eq!(p.bases["sha"].contours.len(), 2);
}

#[test]
fn derived_bases_survive_a_save() {
    let p = starter_project(Metrics::default());
    let mut bytes = std::io::Cursor::new(Vec::new());
    fidel_core::kid::write(&p, &mut bytes).unwrap();
    let back = fidel_core::kid::read(std::io::Cursor::new(bytes.into_inner())).unwrap();
    assert_eq!(back.bases["ja"].derived, p.bases["ja"].derived);
}
