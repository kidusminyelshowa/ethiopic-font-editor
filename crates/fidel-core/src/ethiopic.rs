//! Script data: the 26 Ge'ez families, their Unicode layout, Hornus's shape
//! groups, and which form of each order every family uses.

use serde::{Deserialize, Serialize};

use crate::order::Order;

/// Hornus fig. 60. Used as default spacing groups and as the unit of design
/// consistency.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShapeGroup {
    OpenCounter,
    ClosedCounter,
    StemBased,
    DiagonalBased,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GeezFamily {
    /// Stable id, from the Unicode syllable name (`ETHIOPIC SYLLABLE HA` → `ha`).
    pub id: &'static str,
    /// Traditional letter name. Spellings vary; the UI lets the designer rename.
    pub name: &'static str,
    /// Codepoint of the 1st order. In the Ethiopic block each family occupies
    /// eight consecutive codepoints: orders 1 to 7, then a labialised or
    /// extra form.
    pub first: u32,
    pub group: ShapeGroup,
}

impl GeezFamily {
    pub fn codepoint(&self, order: Order) -> char {
        char::from_u32(self.first + u32::from(order.number() - 1))
            .expect("Ethiopic block codepoints are valid chars")
    }
}

macro_rules! fam {
    ($id:literal, $name:literal, $first:literal, $group:ident) => {
        GeezFamily { id: $id, name: $name, first: $first, group: ShapeGroup::$group }
    };
}

/// The 26 Ge'ez bases in traditional (halehame) order.
pub const GEEZ_FAMILIES: [GeezFamily; 26] = [
    fam!("ha", "Hoy", 0x1200, OpenCounter),
    fam!("la", "Lawi", 0x1208, DiagonalBased),
    fam!("hha", "Hawt", 0x1210, OpenCounter),
    fam!("ma", "May", 0x1218, ClosedCounter),
    fam!("sza", "Sawt", 0x1220, OpenCounter),
    fam!("ra", "Re's", 0x1228, DiagonalBased),
    fam!("sa", "Sat", 0x1230, OpenCounter),
    fam!("qa", "Qaf", 0x1240, ClosedCounter),
    fam!("ba", "Bet", 0x1260, OpenCounter),
    fam!("ta", "Tawe", 0x1270, StemBased),
    fam!("xa", "Harm", 0x1280, StemBased),
    fam!("na", "Nahas", 0x1290, StemBased),
    fam!("glottal-a", "Alf", 0x12A0, DiagonalBased),
    fam!("ka", "Kaf", 0x12A8, OpenCounter),
    fam!("wa", "Wawe", 0x12C8, ClosedCounter),
    fam!("pharyngeal-a", "Ayn", 0x12D0, ClosedCounter),
    fam!("za", "Zay", 0x12D8, StemBased),
    fam!("ya", "Yaman", 0x12E8, DiagonalBased),
    fam!("da", "Dant", 0x12F0, DiagonalBased),
    fam!("ga", "Gaml", 0x1308, DiagonalBased),
    fam!("tha", "Tayt", 0x1320, OpenCounter),
    fam!("pha", "Payt", 0x1330, DiagonalBased),
    fam!("tsa", "Saday", 0x1338, DiagonalBased),
    fam!("tza", "Sappa", 0x1340, ClosedCounter),
    fam!("fa", "Af", 0x1348, DiagonalBased),
    fam!("pa", "Psa", 0x1350, StemBased),
];

/// Built-in "built on" links: fidel drawn from another order of their family
/// rather than from the bare base. From the derivation map of Noto Sans,
/// Noto Serif and Abyssinica SIL: in the families whose 4th order changes the
/// body (ሃ ማ ሣ ዋ ዓ ፃ), the 3rd and 5th orders add their mark to the 4th, and
/// ዱ ዲ add theirs to ዳ.
pub const DEFAULT_BUILT_ON: &[(char, char)] = &[
    ('ሂ', 'ሃ'),
    ('ሄ', 'ሃ'),
    ('ሚ', 'ማ'),
    ('ሜ', 'ማ'),
    ('ሢ', 'ሣ'),
    ('ሤ', 'ሣ'),
    ('ዊ', 'ዋ'),
    ('ዌ', 'ዋ'),
    ('ዒ', 'ዓ'),
    ('ዔ', 'ዓ'),
    ('ዱ', 'ዳ'),
    ('ዲ', 'ዳ'),
    ('ፂ', 'ፃ'),
    ('ፄ', 'ፃ'),
];

/// How a family forms one order: a form from the order's list (see
/// [`crate::defaults::hornus_order_rules`]), or drawn by hand.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Form {
    Variant(usize),
    Draw,
}

use Form::{Draw, Variant};

/// Which form each family uses, by order, read off Noto Sans Ethiopic, Noto
/// Serif Ethiopic and Abyssinica SIL. Families not listed for an order use
/// its first form. The Extended rows follow their parent row.
pub const DEFAULT_FORMS: &[(Order, Form, &[&str])] = &[
    // ሩ ፉ: the 2nd-order stroke takes a shape of its own.
    (Order::Kaib, Draw, &["ra", "fa"]),
    // ራብዕ: 0 short left leg (the default), 1 stem sweeps left, 2 short left
    // and middle legs, 3 head turns down, 4 a leg on the right (ሃ ማ ሣ ዋ ዓ ፃ).
    (Order::Rabi, Variant(1), &["qa", "qha", "ta", "ca", "xa", "ga", "gga", "pa", "ya", "cca", "qya", "gya"]),
    (Order::Rabi, Variant(2), &["hha", "tha", "cha", "ccha", "cchha", "hhya"]),
    (Order::Rabi, Variant(3), &["na", "nya"]),
    (Order::Rabi, Variant(4), &["ha", "ma", "sza", "wa", "pharyngeal-a", "tza"]),
    (Order::Rabi, Draw, &["ra", "fa"]),
    // ሳድስ: 0 first stroke cricks, 1 tick on top, 2 foot flicks left, 3 ring
    // at the foot.
    (
        Order::Sadis,
        Variant(1),
        &[
            "hha",
            "qa",
            "qha",
            "ta",
            "ca",
            "pharyngeal-a",
            "da",
            "dda",
            "ja",
            "pha",
            "tsa",
            "tza",
            "cca",
            "qya",
            "ddha",
        ],
    ),
    (Order::Sadis, Variant(2), &["ba", "va", "bba"]),
    (Order::Sadis, Variant(3), &["la"]),
    (
        Order::Sadis,
        Draw,
        &[
            "ma", "sza", "ra", "xa", "na", "nya", "wa", "ya", "ga", "gga", "fa", "pa", "tha", "cha", "ccha",
            "cchha", "hhya", "gya",
        ],
    ),
    // ሳብዕ: 0 short right leg (the default), 1 ring on top, 2 short middle
    // and right legs, 3 a ring on a short bar (ሎ).
    (Order::Sabi, Variant(1), &["ha", "ra", "qa", "qha", "ta", "ca", "xa", "na", "nya", "gga", "cca", "qya"]),
    (Order::Sabi, Variant(2), &["hha", "tha", "cha", "ccha", "cchha", "hhya"]),
    (Order::Sabi, Variant(3), &["la"]),
    (Order::Sabi, Draw, &["ma", "sza", "wa", "pharyngeal-a", "tza", "fa", "pa", "ya", "ga", "gya"]),
];

/// The form `family` uses for `order` by default.
pub fn default_form(family: &str, order: Order) -> Form {
    DEFAULT_FORMS
        .iter()
        .find(|(o, _, fams)| *o == order && fams.contains(&family))
        .map_or(Variant(0), |(_, f, _)| *f)
}

/// The fidel `c` is built on by default, if any.
pub fn default_built_on(c: char) -> Option<char> {
    DEFAULT_BUILT_ON.iter().find(|(ch, _)| *ch == c).map(|(_, parent)| *parent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn twenty_six_unique_families_in_four_groups() {
        let ids: HashSet<_> = GEEZ_FAMILIES.iter().map(|f| f.id).collect();
        assert_eq!(ids.len(), 26);
        let count = |g| GEEZ_FAMILIES.iter().filter(|f| f.group == g).count();
        assert_eq!(count(ShapeGroup::OpenCounter), 7);
        assert_eq!(count(ShapeGroup::ClosedCounter), 5);
        assert_eq!(count(ShapeGroup::StemBased), 5);
        assert_eq!(count(ShapeGroup::DiagonalBased), 9);
    }

    #[test]
    fn codepoints_match_the_chart() {
        let ha = &GEEZ_FAMILIES[0];
        let row: String = Order::ALL.iter().map(|o| ha.codepoint(*o)).collect();
        assert_eq!(row, "ሀሁሂሃሄህሆ");
        let fifth: String = GEEZ_FAMILIES.iter().map(|f| f.codepoint(Order::Hamis)).collect();
        assert_eq!(fifth, "ሄሌሔሜሤሬሴቄቤቴኄኔኤኬዌዔዜዬዴጌጤጴጼፄፌፔ");
    }

    #[test]
    fn default_built_on_stays_inside_one_family() {
        for (c, parent) in DEFAULT_BUILT_ON {
            let fam = GEEZ_FAMILIES.iter().find(|f| Order::ALL.iter().any(|o| f.codepoint(*o) == *c));
            let fam = fam.unwrap_or_else(|| panic!("{c} not in the grid"));
            assert!(Order::ALL.iter().any(|o| fam.codepoint(*o) == *parent), "{c} on {parent}");
            assert!(default_built_on(*parent).is_none(), "{parent} is itself built on something");
        }
    }

    #[test]
    fn default_forms_name_each_family_once_per_order() {
        for order in Order::ALL {
            let mut seen = HashSet::new();
            for (_, _, fams) in DEFAULT_FORMS.iter().filter(|(o, _, _)| *o == order) {
                for f in *fams {
                    assert!(seen.insert(*f), "{f} twice in {order:?}");
                }
            }
        }
        assert_eq!(default_form("la", Order::Rabi), Form::Variant(0));
        assert_eq!(default_form("ta", Order::Rabi), Form::Variant(1));
        assert_eq!(default_form("ma", Order::Sabi), Form::Draw);
        assert_eq!(default_form("ma", Order::Rabi), Form::Variant(4));
    }
}
