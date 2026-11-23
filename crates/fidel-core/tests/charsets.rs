//! Character sets: a project grows to cover more of the Ethiopic repertoire
//! without losing work when a set is turned off.

use fidel_core::charset::{self, CharSet};
use fidel_core::defaults::geez_project;
use fidel_core::*;

fn drawn_sa() -> Project {
    let mut p = geez_project(Metrics::default());
    p.bases.get_mut("sa").unwrap().contours =
        vec![Contour::rect(0, Some(Part::Stem), Vec2::new(50.0, 0.0), Vec2::new(110.0, 700.0))];
    p
}

#[test]
fn a_new_project_is_geez_only() {
    let p = geez_project(Metrics::default());
    assert_eq!(p.charsets(), [CharSet::Geez].into());
    assert!(p.in_charset('ሀ'));
    assert!(!p.in_charset('ሸ'));
    assert!(p.symbols.is_empty());
}

#[test]
fn turning_on_sets_creates_what_they_need() {
    let mut p = drawn_sa();
    p.set_charsets(CharSet::ALL);
    let fidel_count: usize = p.families.values().map(|f| f.fidels.len()).sum();
    let symbol_count = charset::entries().filter(|e| matches!(e.slot, charset::Slot::Symbol { .. })).count();
    assert_eq!(fidel_count + p.symbols.len(), charset::entries().count());
    assert_eq!(p.symbols.len(), symbol_count);
    assert_eq!(p.symbols["uni1362"].name, "Full stop");

    // ሸ starts from the drawn ሰ.
    assert_eq!(p.bases["sha"].contours, p.bases["sa"].contours);
    assert_eq!(p.fidel("sha", Order::Giiz).unwrap().codepoint, Some('ሸ'));
    // Sebatbeit and Gurage rows share the plain row's base.
    assert_eq!(p.families["sebatbeit-m"].base, "ma");
    assert_eq!(p.families["gurage-k"].base, "ka");
    assert!(!p.bases.contains_key("sebatbeit-m"));

    // Labialized forms are built on the order they are drawn from.
    let on = |fam: &str, o: Order| p.fidel(fam, o).unwrap().built_on;
    assert_eq!(on("la", Order::Wa), Some(Order::Rabi)); // ሏ from ላ
    assert_eq!(on("qa", Order::Wa), Some(Order::Giiz)); // ቈ from ቀ
    assert_eq!(on("qa", Order::Waa), Some(Order::Rabi)); // ቋ from ቃ
    assert_eq!(on("ha", Order::Oa), Some(Order::Sabi)); // ሇ from ሆ
    assert_eq!(on("sebatbeit-m", Order::Wa), None);
    assert_eq!(p.effective_alterations("la", Order::Wa).unwrap(), vec![defaults::LABIAL_MARK.to_string()]);

    // Every fidel resolves.
    for (id, fam) in &p.families {
        for o in fam.fidels.keys() {
            p.resolve(id, *o).unwrap();
        }
    }
}

#[test]
fn turning_a_set_off_keeps_the_work() {
    let mut p = drawn_sa();
    p.set_charsets([CharSet::Geez, CharSet::EthiopicLetters]);
    p.nudge(
        "sha",
        Order::Hamis,
        NudgeTarget::Point { source: Source::Base, contour: 0, point: 0 },
        Vec2::new(4.0, 0.0),
    )
    .unwrap();
    p.set_charsets([CharSet::Geez]);
    assert!(!p.in_charset('ሸ'));
    assert!(!p.fidel_in_charset("sha", Order::Giiz));
    p.set_charsets([CharSet::Geez, CharSet::EthiopicLetters]);
    assert_eq!(p.fidel("sha", Order::Hamis).unwrap().state.kind(), StateKind::Adjusted);
}

#[test]
fn sets_and_symbols_survive_save_and_open() {
    let mut p = drawn_sa();
    p.set_charsets([CharSet::Geez, CharSet::EthiopicMarks, CharSet::ExtendedB]);
    p.set_drawing(
        &DrawingTarget::Symbol("uni1361".into()),
        vec![Contour::rect(0, None, Vec2::new(0.0, 0.0), Vec2::new(80.0, 80.0))],
    )
    .unwrap();
    let dir = std::env::temp_dir().join(format!("charsets-{}.kid", std::process::id()));
    kid::save(&p, &dir).unwrap();
    let back = kid::open(&dir).unwrap();
    std::fs::remove_file(&dir).ok();
    assert_eq!(back.charsets(), p.charsets());
    assert_eq!(back.symbols, p.symbols);
    assert_eq!(back.families["gurage-hh"], p.families["gurage-hh"]);
}
