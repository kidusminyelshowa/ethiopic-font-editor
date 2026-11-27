//! Opening fonts: a compiled font and a UFO fill a new project.

use fidel_core::defaults::geez_project;
use fidel_core::*;
use fidel_export::import::{apply, read_any, read_binary, ImportMode};
use fidel_export::{export, ExportOptions};

fn drawn() -> Project {
    let mut p = geez_project(Metrics::default());
    let b = p.bases.get_mut("ha").unwrap();
    b.advance_width = 640.0;
    b.contours = vec![Contour::rect(0, None, Vec2::new(60.0, 0.0), Vec2::new(140.0, 700.0))];
    p
}

#[test]
fn a_compiled_font_fills_bases_and_backgrounds() {
    let font = export(&drawn(), &ExportOptions::new("Round Trip")).unwrap();
    let imported = read_binary(&font.bytes).unwrap();
    assert!(imported.glyphs.contains_key(&'ሀ'));
    let mut p = geez_project(Metrics::default());
    let path = std::env::temp_dir().join("hohe-import-test.otf");
    std::fs::write(&path, &font.bytes).unwrap();
    let r = apply(&mut p, &read_any(&path).unwrap(), ImportMode::Drawings);
    assert!(r.drawn >= 1, "{r:?}");
    let ha = &p.bases["ha"];
    assert_eq!(ha.advance_width, 640.0);
    let b = ha.contours[0].bounds().unwrap();
    assert_eq!((b.min.x, b.max.y), (60.0, 700.0));
    // Other orders come in behind their drawings.
    assert!(r.backgrounds >= 1 && p.backgrounds.keys().any(|k| k.starts_with("fidel:")), "{r:?}");
}

#[test]
fn a_ufo_brings_outlines_components_and_kerning() {
    let dir = std::env::temp_dir().join("hohe-import-test.ufo");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("glyphs")).unwrap();
    let w = |f: &str, s: &str| std::fs::write(dir.join(f), s).unwrap();
    let plist = |body: &str| {
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\">{body}</plist>")
    };
    w("fontinfo.plist", &plist("<dict><key>unitsPerEm</key><integer>2000</integer></dict>"));
    w("glyphs/contents.plist", &plist("<dict><key>uni1200</key><string>uni1200.glif</string><key>uni1208</key><string>uni1208.glif</string><key>stem</key><string>stem.glif</string></dict>"));
    w("glyphs/stem.glif", "<glyph name=\"stem\" format=\"2\"><outline><contour><point x=\"0\" y=\"0\" type=\"line\"/><point x=\"100\" y=\"0\" type=\"line\"/><point x=\"100\" y=\"1400\" type=\"line\"/><point x=\"0\" y=\"1400\" type=\"line\"/></contour></outline></glyph>");
    w("glyphs/uni1200.glif", "<glyph name=\"uni1200\" format=\"2\"><advance width=\"1200\"/><unicode hex=\"1200\"/><outline><component base=\"stem\" xOffset=\"200\"/><contour><point x=\"400\" y=\"0\" type=\"curve\"/><point x=\"500\" y=\"0\"/><point x=\"600\" y=\"100\"/><point x=\"600\" y=\"200\" type=\"curve\"/><point x=\"400\" y=\"200\" type=\"line\"/></contour></outline><anchor name=\"top\" x=\"300\" y=\"1400\"/></glyph>");
    w("glyphs/uni1208.glif", "<glyph name=\"uni1208\" format=\"2\"><advance width=\"1000\"/><unicode hex=\"1208\"/><outline><component base=\"stem\"/></outline></glyph>");
    w(
        "kerning.plist",
        &plist("<dict><key>uni1200</key><dict><key>uni1208</key><integer>-40</integer></dict></dict>"),
    );
    let mut p = geez_project(Metrics::default());
    let r = apply(&mut p, &read_any(&dir).unwrap(), ImportMode::Drawings);
    assert_eq!(r.drawn, 2, "{r:?}");
    let ha = &p.bases["ha"];
    // Scaled from 2000 units to 1000.
    assert_eq!(ha.advance_width, 600.0);
    assert_eq!(ha.contours.len(), 2);
    assert_eq!(ha.contours[0].points.iter().filter(|p| p.kind == PointKind::OffCurve).count(), 2);
    assert_eq!(ha.anchors["top"], Vec2::new(150.0, 700.0));
    assert!(p.kerning.pairs.iter().any(|k| k.left == "ሀ" && k.right == "ለ" && k.value == -20));
}

#[test]
fn ufo_and_designspace_round_trip() {
    let mut p = drawn();
    p.set_axis(
        None,
        designspace::Axis {
            tag: "wght".into(),
            name: "Weight".into(),
            min: 400.0,
            default: 400.0,
            max: 700.0,
            map: vec![],
        },
    )
    .unwrap();
    let bold = p.add_master("Bold", [("wght".to_string(), 700.0)].into());
    p.switch_master(bold).unwrap();
    p.bases.get_mut("ha").unwrap().contours =
        vec![Contour::rect(0, None, Vec2::new(60.0, 0.0), Vec2::new(240.0, 700.0))];
    p.switch_master(0).unwrap();
    let dir = std::env::temp_dir().join("hohe-ds-test");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let files = fidel_export::ufo::write_designspace(&p, &dir.join("Test.designspace"), "Test").unwrap();
    assert_eq!(files.len(), 3, "{files:?}");
    let mut q = geez_project(Metrics::default());
    let r = apply(&mut q, &read_any(&dir.join("Test.designspace")).unwrap(), ImportMode::Drawings);
    assert_eq!(r.masters, 1, "{r:?}");
    assert_eq!(q.design.masters.len(), 2);
    let bold = q.master_project(1);
    assert_eq!(bold.bases["ha"].contours[0].bounds().unwrap().max.x, 240.0);
    assert_eq!(q.bases["ha"].contours[0].bounds().unwrap().max.x, 140.0);
}
