//! Kerning pairs, classes and exceptions.

use fidel_core::kerning::{KernError, KernSide, KernSource, Kerning};

fn sample() -> Kerning {
    let mut k = Kerning::default();
    k.set_class(KernSide::Left, "ha", &['ሀ', 'ሁ', 'ሂ'], None).unwrap();
    k.set_class(KernSide::Right, "la", &['ለ', 'ሉ'], None).unwrap();
    k.set_pair("@ha", "@la", Some(-40)).unwrap();
    k
}

#[test]
fn class_pairs_cover_members() {
    let k = sample();
    assert_eq!(k.value('ሁ', 'ሉ'), Some((-40, KernSource::Pair)));
    assert_eq!(k.value('ሉ', 'ሁ'), None);
}

#[test]
fn glyph_pairs_override_classes_as_exceptions() {
    let mut k = sample();
    k.set_pair("ሂ", "@la", Some(-10)).unwrap();
    k.set_pair("@ha", "ሉ", Some(-20)).unwrap();
    k.set_pair("ሀ", "ለ", Some(0)).unwrap();
    assert_eq!(k.value('ሀ', 'ለ'), Some((0, KernSource::Exception)));
    assert_eq!(k.value('ሂ', 'ሉ'), Some((-10, KernSource::Exception)), "left glyph exception wins");
    assert_eq!(k.value('ሁ', 'ሉ'), Some((-20, KernSource::Exception)));
    assert_eq!(k.value('ሁ', 'ለ'), Some((-40, KernSource::Pair)));
    // Without a class pair under it, a glyph pair is a plain pair.
    k.set_pair("ሀ", "ሀ", Some(15)).unwrap();
    assert_eq!(k.value('ሀ', 'ሀ'), Some((15, KernSource::Pair)));
}

#[test]
fn a_glyph_is_in_one_class_per_side() {
    let mut k = sample();
    k.set_class(KernSide::Left, "hu", &['ሁ'], None).unwrap();
    assert_eq!(k.class_of(KernSide::Left, 'ሁ'), Some("hu"));
    assert_eq!(k.left_classes["ha"], vec!['ሀ', 'ሂ']);
    // Moving the last members out removes the class and its pairs.
    k.set_class(KernSide::Right, "all", &['ለ', 'ሉ'], None).unwrap();
    assert!(!k.right_classes.contains_key("la"));
    assert!(k.pairs.is_empty());
}

#[test]
fn renaming_keeps_pairs_and_removing_drops_them() {
    let mut k = sample();
    k.set_class(KernSide::Left, "ha", &['ሀ', 'ሁ', 'ሂ'], Some("round")).unwrap();
    assert_eq!(k.pair("@round", "@la"), Some(-40));
    assert_eq!(k.set_class(KernSide::Right, "la", &['ለ'], Some("la")).map(|_| ()), Ok(()));
    assert_eq!(
        k.set_class(KernSide::Left, "x", &['ሀ'], Some("round")),
        Err(KernError::NameTaken("round".into()))
    );
    k.set_class(KernSide::Left, "round", &[], None).unwrap();
    assert!(k.pairs.is_empty());
    assert_eq!(k.set_pair("@nope", "ለ", Some(1)), Err(KernError::NoClass("nope".into())));
    assert_eq!(k.set_pair("ab", "ለ", Some(1)), Err(KernError::BadKey("ab".into())));
}

#[test]
fn flatten_orders_specific_pairs_first() {
    let mut k = sample();
    k.set_pair("ሂ", "@la", Some(-10)).unwrap();
    k.set_pair("ሂ", "ለ", Some(-5)).unwrap();
    let (glyphs, classes) = k.flatten();
    assert_eq!(glyphs, vec![('ሂ', 'ለ', -5), ('ሂ', 'ሉ', -10)]);
    assert_eq!(classes.len(), 1);
    assert_eq!(classes[0].2, -40);
}
