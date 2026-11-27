//! Character sets: which parts of Unicode's Ethiopic repertoire a project
//! covers. The table holds every assigned character in the five Ethiopic
//! blocks, sorted into the sets a designer picks from.

use serde::{Deserialize, Serialize};

use crate::order::Order;

mod latin;
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
    /// Basic Latin letters, figures and punctuation, with the combining
    /// accents accented letters are built from.
    Latin,
    /// Latin-1 Supplement, U+00A0 to U+00FF: Western European accents.
    LatinSupplement,
    /// Latin Extended-A, U+0100 to U+017F: Central European and others.
    LatinExtendedA,
}

impl CharSet {
    pub const ALL: [CharSet; 11] = [
        CharSet::Geez,
        CharSet::EthiopicLetters,
        CharSet::EthiopicLabialized,
        CharSet::EthiopicMarks,
        CharSet::Supplement,
        CharSet::Extended,
        CharSet::ExtendedA,
        CharSet::ExtendedB,
        CharSet::Latin,
        CharSet::LatinSupplement,
        CharSet::LatinExtendedA,
    ];

    pub fn is_latin(self) -> bool {
        matches!(self, CharSet::Latin | CharSet::LatinSupplement | CharSet::LatinExtendedA)
    }

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
            CharSet::Latin => "Basic Latin",
            CharSet::LatinSupplement => "Latin-1 Supplement",
            CharSet::LatinExtendedA => "Latin Extended-A",
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
            CharSet::Latin => "U+0021–U+007E and accents",
            CharSet::LatinSupplement => "U+00A0–U+00FF",
            CharSet::LatinExtendedA => "U+0100–U+017F",
        }
    }

    /// Number of characters in the set.
    pub fn count(self) -> usize {
        entries().filter(|e| e.set == self).count()
    }
}

/// A language preset: the letters, labialized forms and punctuation a
/// language is written with, drawn from several Unicode sets at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Language {
    Amharic,
    Tigrinya,
    Gurage,
}

/// The rows of the main Ethiopic block used for Amharic: the 26 Ge'ez rows
/// and ሸ ቨ ቸ ኘ ኸ ዠ ጀ ጨ.
const AMHARIC_ROWS: &[&str] = &[
    "ha",
    "la",
    "hha",
    "ma",
    "sza",
    "ra",
    "sa",
    "sha",
    "qa",
    "ba",
    "va",
    "ta",
    "ca",
    "xa",
    "na",
    "nya",
    "glottal-a",
    "ka",
    "kxa",
    "wa",
    "pharyngeal-a",
    "za",
    "zha",
    "ya",
    "da",
    "ja",
    "ga",
    "tha",
    "cha",
    "pha",
    "tsa",
    "tza",
    "fa",
    "pa",
];

impl Language {
    pub const ALL: [Language; 3] = [Language::Amharic, Language::Tigrinya, Language::Gurage];

    pub fn name(self) -> &'static str {
        match self {
            Language::Amharic => "Amharic",
            Language::Tigrinya => "Tigrinya",
            Language::Gurage => "Gurage",
        }
    }

    /// Whether the language uses this character.
    pub fn contains(self, c: char) -> bool {
        let Some(e) = entry(c) else { return false };
        let main_block = (c as u32) < 0x1380;
        match (self, e.slot) {
            (_, Slot::Symbol { .. }) if e.set == CharSet::EthiopicMarks => {
                // Punctuation and numerals; the combining marks are for Gurage.
                self == Language::Gurage || (c as u32) >= 0x1360
            }
            (Language::Gurage, _)
                if matches!(e.set, CharSet::Supplement | CharSet::Extended | CharSet::ExtendedB) =>
            {
                true
            }
            (_, Slot::Symbol { .. }) => false,
            (lang, Slot::Fidel { family, order, .. }) => {
                let row = AMHARIC_ROWS.contains(&family)
                    || (lang == Language::Tigrinya && family == "qha")
                    || (lang == Language::Gurage && family == "gga");
                main_block && row && order != Order::Oa
            }
        }
    }

    pub fn count(self) -> usize {
        entries().filter(|e| self.contains(e.cp)).count()
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

/// Every character, by codepoint: Latin, then Ethiopic.
pub fn entries() -> impl Iterator<Item = &'static Entry> {
    latin::LATIN.iter().chain(table::ETHIOPIC.iter())
}

pub fn entry(c: char) -> Option<&'static Entry> {
    let find = |t: &'static [Entry]| t.binary_search_by_key(&c, |e| e.cp).ok().map(|i| &t[i]);
    find(latin::LATIN).or_else(|| find(table::ETHIOPIC))
}

/// The base letter and accents an accented letter is built from: À is A
/// and a combining grave.
pub fn recipe(c: char) -> Option<(char, &'static [char])> {
    latin::RECIPES.binary_search_by_key(&c, |r| r.0).ok().map(|i| (latin::RECIPES[i].1, latin::RECIPES[i].2))
}

/// Accents that sit below the letter, or on its right foot (ogonek).
pub fn accent_below(c: char) -> bool {
    matches!(c, '\u{0326}' | '\u{0327}' | '\u{0328}')
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
        assert_eq!(all.len(), 523 + 333);
        assert_eq!(CharSet::Geez.count(), 182);
        assert_eq!(set_of('ሸ'), Some(CharSet::EthiopicLetters));
        assert_eq!(set_of('ሏ'), Some(CharSet::EthiopicLabialized));
        assert_eq!(set_of('።'), Some(CharSet::EthiopicMarks));
        assert_eq!(set_of('a'), Some(CharSet::Latin));
        assert_eq!(set_of('À'), Some(CharSet::LatinSupplement));
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
