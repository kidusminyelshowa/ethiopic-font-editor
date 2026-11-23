//! Character sets: which parts of Unicode's Ethiopic repertoire a project
//! covers. The table holds every assigned character in the five Ethiopic
//! blocks, sorted into the sets a designer picks from.

use serde::{Deserialize, Serialize};

use crate::order::Order;

mod table;

/// A pickable slice of the Ethiopic repertoire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CharSet {
    /// The 26 classical families, seven orders each (182).
    Geez,
    /// Rows added for Amharic, Tigrinya and others in the main block (ሸ ቐ ቨ ቸ ኘ ኸ ዠ ጀ ጘ ጨ).
    EthiopicLetters,
    /// The -wa, -oa and labiovelar forms of the main block (ሏ ቈ ቋ ሇ …).
    EthiopicLabialized,
    /// Punctuation, numerals and combining marks (፡ ። ፩ ፲ …).
    EthiopicMarks,
    /// Ethiopic Supplement, U+1380 to U+1399: Sebatbeit forms and tonal marks.
    Supplement,
    /// Ethiopic Extended, U+2D80 to U+2DDF: Me'en, Blin, Sebatbeit.
    Extended,
    /// Ethiopic Extended-A, U+AB00 to U+AB2F: Gamo-Gofa-Dawro, Basketo, Gumuz.
    ExtendedA,
    /// Ethiopic Extended-B, U+1E7E0 to U+1E7FF: Gurage.
    ExtendedB,
}

impl CharSet {
    pub const ALL: [CharSet; 8] = [
        CharSet::Geez,
        CharSet::EthiopicLetters,
        CharSet::EthiopicLabialized,
        CharSet::EthiopicMarks,
        CharSet::Supplement,
        CharSet::Extended,
        CharSet::ExtendedA,
        CharSet::ExtendedB,
    ];

    pub fn name(self) -> &'static str {
        match self {
            CharSet::Geez => "Ge'ez",
            CharSet::EthiopicLetters => "Added letters",
            CharSet::EthiopicLabialized => "Labialized forms",
            CharSet::EthiopicMarks => "Punctuation and numerals",
            CharSet::Supplement => "Ethiopic Supplement",
            CharSet::Extended => "Ethiopic Extended",
            CharSet::ExtendedA => "Ethiopic Extended-A",
            CharSet::ExtendedB => "Ethiopic Extended-B",
        }
    }

    /// The Unicode range the set is drawn from.
    pub fn range(self) -> &'static str {
        match self {
            CharSet::Geez | CharSet::EthiopicLetters | CharSet::EthiopicLabialized => "U+1200–U+135A",
            CharSet::EthiopicMarks => "U+135D–U+137C",
            CharSet::Supplement => "U+1380–U+1399",
            CharSet::Extended => "U+2D80–U+2DDE",
            CharSet::ExtendedA => "U+AB01–U+AB2E",
            CharSet::ExtendedB => "U+1E7E0–U+1E7FE",
        }
    }

    /// Number of characters in the set.
    pub fn count(self) -> usize {
        entries().filter(|e| e.set == self).count()
    }
}

/// One character of the table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    pub cp: char,
    pub set: CharSet,
    pub slot: Slot,
}

/// Where a character lives in the project.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    /// An order of a fidel family.
    Fidel { family: &'static str, name: &'static str, order: Order },
    /// A standalone glyph: punctuation, a numeral or a combining mark.
    Symbol { name: &'static str },
}

pub fn entries() -> impl Iterator<Item = &'static Entry> {
    table::ETHIOPIC.iter()
}

pub fn entry(c: char) -> Option<&'static Entry> {
    table::ETHIOPIC.binary_search_by_key(&c, |e| e.cp).ok().map(|i| &table::ETHIOPIC[i])
}

pub fn set_of(c: char) -> Option<CharSet> {
    entry(c).map(|e| e.set)
}

/// The glyph id used for a symbol: `uni1361`.
pub fn symbol_id(c: char) -> String {
    format!("uni{:04X}", c as u32)
}

/// For a row whose Unicode name carries a dialect prefix (`sebatbeit-m`,
/// `gurage-k`), the plain row it shares its base with (`ma`, `ka`).
pub fn shared_base(family: &str) -> Option<String> {
    let rest = family.strip_prefix("sebatbeit-").or_else(|| family.strip_prefix("gurage-"))?;
    Some(format!("{rest}a"))
}

/// Rows that were made by modifying a Ge'ez row (ሸ from ሰ, ጀ from ደ …). A
/// new base starts as a copy of that row's base when it has been drawn.
pub const ROW_SOURCE: &[(&str, &str)] = &[
    ("sha", "sa"),
    ("qha", "qa"),
    ("va", "ba"),
    ("ca", "ta"),
    ("nya", "na"),
    ("kxa", "ka"),
    ("zha", "za"),
    ("dda", "da"),
    ("ja", "da"),
    ("gga", "ga"),
    ("cha", "tha"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_sorted_and_complete() {
        let all: Vec<_> = entries().collect();
        assert!(all.windows(2).all(|w| w[0].cp < w[1].cp));
        assert_eq!(all.len(), 523);
        assert_eq!(CharSet::Geez.count(), 182);
        assert_eq!(set_of('ሸ'), Some(CharSet::EthiopicLetters));
        assert_eq!(set_of('ሏ'), Some(CharSet::EthiopicLabialized));
        assert_eq!(set_of('።'), Some(CharSet::EthiopicMarks));
        assert_eq!(set_of('a'), None);
        let geez: Vec<_> = entries().filter(|e| e.set == CharSet::Geez).collect();
        assert!(geez.iter().all(|e| matches!(e.slot, Slot::Fidel { order, .. } if order.is_main())));
    }

    #[test]
    fn prefixed_rows_share_the_plain_base() {
        assert_eq!(shared_base("sebatbeit-m").as_deref(), Some("ma"));
        assert_eq!(shared_base("gurage-hh").as_deref(), Some("hha"));
        assert_eq!(shared_base("sha"), None);
    }
}
