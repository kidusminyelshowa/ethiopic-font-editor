//! Save a project as .kid and open it again without loss.

use std::io::{Cursor, Read, Write};

use fidel_core::defaults::{geez_project, LOOP_BOTTOM_RIGHT};
use fidel_core::kid::{self, KidError};
use fidel_core::*;

fn sample() -> Project {
    let mut p = geez_project(Metrics::default());
    p.set_drawing(
        &DrawingTarget::Base("ha".into()),
        vec![
            Contour::rect(0, Some(Part::Leg), Vec2::new(50.0, 0.0), Vec2::new(110.0, 700.0)),
            Contour::rect(1, Some(Part::Leg), Vec2::new(400.0, 0.0), Vec2::new(460.0, 700.0)),
        ],
    )
    .unwrap();
    p.set_drawing(
        &DrawingTarget::Alteration(LOOP_BOTTOM_RIGHT.into()),
        vec![Contour::rect(0, Some(Part::Ring), Vec2::new(0.0, -80.0), Vec2::new(80.0, 0.0))],
    )
    .unwrap();
    p.bases.get_mut("ha").unwrap().anchors.insert("loop5".into(), Vec2::new(430.0, 0.0));
    p.nudge(
        "ha",
        Order::Hamis,
        NudgeTarget::Placement { alteration: LOOP_BOTTOM_RIGHT.into() },
        Vec2::new(5.0, 3.0),
    )
    .unwrap();
    p.detach("ha", Order::Sabi).unwrap();
    p.draw_by_hand("ha", Order::Salis).unwrap();
    p.families.get_mut("ta").unwrap().rule_variants.insert(Order::Rabi, 1);
    p.metrics.pa_top = 720.0;
    let guide = |id, angle| fidel_core::guides::Guide {
        id,
        x: 100.0,
        y: 350.0,
        angle,
        name: "stem".into(),
        locked: id == 2,
        color: Some("#c2442a".into()),
    };
    p.guides.set("base:ha", vec![guide(1, 90.0)], vec![guide(2, 0.0)]);
    p.backgrounds
        .insert("base:ha".into(), vec![Contour::rect(0, None, Vec2::new(0.0, 0.0), Vec2::new(60.0, 700.0))]);
    p.organize.set_mark(
        "fidel:ha/kaib",
        fidel_core::organize::GlyphMark {
            color: Some(fidel_core::organize::MarkColor::Orange),
            tags: vec!["review".into()],
            note: "Loop too tight".into(),
        },
    );
    p.organize.set_filters(vec![fidel_core::organize::SmartFilter {
        name: "To review".into(),
        query: String::new(),
        rules: vec!["tag:review".into()],
    }]);
    p.kerning.set_class(fidel_core::kerning::KernSide::Left, "ha", &['ሀ', 'ሁ'], None).unwrap();
    p.kerning.set_pair("@ha", "ለ", Some(-30)).unwrap();
    p.set_axis(
        None,
        fidel_core::designspace::Axis {
            tag: "wght".into(),
            name: "Weight".into(),
            min: 400.0,
            default: 400.0,
            max: 700.0,
            map: vec![],
        },
    )
    .unwrap();
    p.add_master("Bold", std::collections::BTreeMap::from([("wght".to_string(), 700.0)]));
    p
}

fn to_bytes(p: &Project) -> Vec<u8> {
    let mut c = Cursor::new(Vec::new());
    kid::write(p, &mut c).unwrap();
    c.into_inner()
}

#[test]
fn round_trips_without_loss() {
    let p = sample();
    let back = kid::read(Cursor::new(to_bytes(&p))).unwrap();
    assert_eq!(back, p);
    // And the reopened project still resolves the same way.
    assert_eq!(back.resolve("ha", Order::Hamis).unwrap(), p.resolve("ha", Order::Hamis).unwrap());
}

#[test]
fn saving_twice_gives_identical_bytes() {
    let p = sample();
    assert_eq!(to_bytes(&p), to_bytes(&p));
}

#[test]
fn package_is_readable_json_one_file_per_object() {
    let bytes = to_bytes(&sample());
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let names: Vec<String> = zip.file_names().map(|n| n.unwrap().into_owned()).collect();
    assert!(names.contains(&"project.json".to_string()));
    assert!(names.contains(&"bases/ha.json".to_string()));
    assert!(names.contains(&"families/ha.json".to_string()));
    assert!(names.contains(&"alterations/loop.bottom-right.json".to_string()));
    assert_eq!(names.iter().filter(|n| n.starts_with("families/")).count(), 26);

    let mut text = String::new();
    zip.by_name("families/ha.json").unwrap().read_to_string(&mut text).unwrap();
    assert!(text.contains("\n  \"id\": \"ha\""), "pretty-printed: {text}");
    assert!(text.contains("\"state\": \"adjusted\""));
    assert!(text.ends_with('\n'));
}

#[test]
fn rejects_files_from_newer_versions_and_other_zips() {
    let mut c = Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut c);
        z.start_file("project.json", zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(br#"{"format":"kid","version":99,"metrics":{"units_per_em":1000,"pa_top":700,"pa_bottom":0},"order_rules":{}}"#)
            .unwrap();
        z.finish().unwrap();
    }
    assert!(matches!(kid::read(Cursor::new(c.into_inner())), Err(KidError::TooNew(99))));

    let mut c = Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut c);
        z.start_file("readme.txt", zip::write::SimpleFileOptions::default()).unwrap();
        z.finish().unwrap();
    }
    assert!(matches!(kid::read(Cursor::new(c.into_inner())), Err(KidError::NotKid)));

    assert!(matches!(kid::read(Cursor::new(b"not a zip".to_vec())), Err(KidError::Zip(_))));
}

#[test]
fn ids_that_are_not_file_names_are_refused() {
    let mut p = sample();
    let mut alt = p.alterations[LOOP_BOTTOM_RIGHT].clone();
    alt.id = "../escape".into();
    p.alterations.insert(alt.id.clone(), alt);
    let err = kid::write(&p, Cursor::new(Vec::new())).unwrap_err();
    assert!(matches!(err, KidError::BadId(id) if id == "../escape"));
}

#[test]
fn save_and_open_on_disk() {
    let dir = std::env::temp_dir().join(format!("kid-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("Test.kid");
    let p = sample();
    kid::save(&p, &path).unwrap();
    assert!(!path.with_extension("kid.saving").exists());
    assert_eq!(kid::open(&path).unwrap(), p);
    std::fs::remove_dir_all(dir).unwrap();
}
