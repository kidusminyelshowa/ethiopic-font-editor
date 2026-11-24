//! Feature code compiled into the font.

use fidel_core::defaults::geez_project;
use fidel_core::*;
use fidel_export::{export, features, ExportError, ExportOptions};
use skrifa::raw::TableProvider;
use skrifa::{FontRef, MetadataProvider};

fn project() -> Project {
    let mut p = geez_project(Metrics::default());
    for id in ["ha", "la"] {
        let base = p.bases.get_mut(id).unwrap();
        base.advance_width = 600.0;
        base.contours =
            vec![Contour::rect(0, Some(Part::Stem), Vec2::new(60.0, 0.0), Vec2::new(140.0, 700.0))];
    }
    p
}

fn tags(list: impl Iterator<Item = String>) -> Vec<String> {
    list.collect()
}

#[test]
fn hand_written_features_and_set_names_reach_the_font() {
    let mut p = project();
    p.features.code = "# swap\nfeature ss01 {\n  sub ሀ by ለ;\n} ss01;\n".into();
    p.features.set_names.insert("ss01".into(), "Lawi for Hoy".into());
    p.features.classes.insert("pair".into(), vec!["ሀ".into(), "uni1208".into()]);
    let font = export(&p, &ExportOptions::new("Test Geez")).unwrap();
    let font = FontRef::new(&font.bytes).unwrap();
    let gsub = font.gsub().unwrap();
    let list = gsub.feature_list().unwrap();
    let names = tags(list.feature_records().iter().map(|r| r.feature_tag().to_string()));
    assert!(names.contains(&"ss01".to_string()));
    // The set's name is in the name table.
    let n: Vec<String> =
        font.localized_strings(skrifa::string::StringId::new(256)).map(|s| s.to_string()).collect();
    assert_eq!(n.first().map(String::as_str), Some("Lawi for Hoy"));
    // Amharic is declared under ethi.
    let scripts = gsub.script_list().unwrap();
    let ethi = scripts.script_records().iter().find(|r| r.script_tag() == skrifa::Tag::new(b"ethi")).unwrap();
    let ethi = ethi.script(scripts.offset_data()).unwrap();
    let langs = tags(ethi.lang_sys_records().iter().map(|r| r.lang_sys_tag().to_string()));
    assert!(langs.iter().any(|l| l.trim() == "AMH"), "{langs:?}");
}

#[test]
fn errors_point_at_the_hand_written_line() {
    let mut p = project();
    p.features.code = "feature liga {\n  sub ሀ by nosuchglyph;\n} liga;\n".into();
    let errs = match features::check(&p) {
        Err(e) => e,
        Ok(_) => panic!("should not compile"),
    };
    let e = errs.iter().find(|e| e.error).unwrap();
    assert_eq!(e.line, Some(2), "{errs:?}");
    assert!(matches!(export(&p, &ExportOptions::new("Test Geez")), Err(ExportError::Features(_))));
}

#[test]
fn characters_become_glyph_names() {
    use fidel_core::features::{feature_tags, names_for_characters};
    assert_eq!(names_for_characters("sub ሀ by ሀ.ss01; # ሀ"), "sub uni1200 by uni1200.ss01; # ሀ");
    assert_eq!(names_for_characters("[ሀለ]"), "[uni1200 uni1208]");
    assert_eq!(feature_tags("feature kern {\n} kern;\nfeature ss02{ } ss02;"), vec!["kern", "ss02"]);
}

#[test]
fn anchors_become_mark_positioning_and_built_letters_export() {
    use fidel_core::charset::CharSet;
    let mut p = project();
    p.set_charsets([CharSet::Geez, CharSet::Latin, CharSet::LatinSupplement]);
    let sym = |p: &mut Project, c: char| p.symbols.values_mut().find(|s| s.codepoint == c).unwrap().clone();
    let (a, grave) = (sym(&mut p, 'A').id, sym(&mut p, '\u{0300}').id);
    let s = p.symbols.get_mut(&a).unwrap();
    s.contours = vec![Contour::rect(0, None, Vec2::new(0.0, 0.0), Vec2::new(500.0, 700.0))];
    s.anchors.insert("top".into(), Vec2::new(250.0, 700.0));
    let g = p.symbols.get_mut(&grave).unwrap();
    g.contours = vec![Contour::rect(0, None, Vec2::new(0.0, 0.0), Vec2::new(100.0, 100.0))];
    g.anchors.insert("_top".into(), Vec2::new(50.0, 0.0));
    let font = export(&p, &ExportOptions::new("Test Latin")).unwrap();
    assert!(font.exported.contains(&'À'));
    let font = FontRef::new(&font.bytes).unwrap();
    let gpos = font.gpos().unwrap();
    let names =
        tags(gpos.feature_list().unwrap().feature_records().iter().map(|r| r.feature_tag().to_string()));
    assert!(names.contains(&"mark".to_string()), "{names:?}");
    let gdef = font.gdef().unwrap();
    let classes = gdef.glyph_class_def().unwrap().unwrap();
    let mark_gid = font.charmap().map('\u{0300}').unwrap();
    assert_eq!(classes.get(skrifa::GlyphId16::try_from(mark_gid).unwrap()), 3);
}
