//! The seven orders (vocalised forms) of a fidel family.

use serde::{Deserialize, Serialize};

use crate::alteration::AlterationId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Order {
    /// 1st order: the base itself.
    Giiz,
    Kaib,
    Salis,
    Rabi,
    Hamis,
    Sadis,
    Sabi,
    /// Labialized -wa form: the 8th order (ሏ) or the first labiovelar (ቈ).
    Wa,
    /// Labiovelar -wi (ቊ).
    Wi,
    /// Labiovelar -waa (ቋ).
    Waa,
    /// Labiovelar -wee (ቌ).
    Wee,
    /// Labiovelar -we (ቍ).
    We,
    /// The -oa form (ሇ, ቇ, ⶀ).
    Oa,
}

impl Order {
    /// The seven vowel orders: the columns of the Fidel Grid.
    pub const ALL: [Order; 7] =
        [Order::Giiz, Order::Kaib, Order::Salis, Order::Rabi, Order::Hamis, Order::Sadis, Order::Sabi];

    /// Labialized and -oa forms, which only some families have.
    pub const EXTRA: [Order; 6] = [Order::Wa, Order::Wi, Order::Waa, Order::Wee, Order::We, Order::Oa];

    /// One of the seven vowel orders, not a labialized form.
    pub fn is_main(self) -> bool {
        (self as u8) < 7
    }

    /// 1 to 7.
    pub fn number(self) -> u8 {
        self as u8 + 1
    }

    pub fn from_number(n: u8) -> Option<Order> {
        Order::ALL.get(usize::from(n).checked_sub(1)?).copied()
    }

    /// Traditional name in Ge'ez script (ግዕዝ … ሳብዕ), as used for the Fidel
    /// Grid column headers. The labialized forms keep their Latin labels.
    pub fn name(self) -> &'static str {
        match self {
            Order::Giiz => "ግዕዝ",
            Order::Kaib => "ካብዕ",
            Order::Salis => "ሳልስ",
            Order::Rabi => "ራብዕ",
            Order::Hamis => "ሐምስ",
            Order::Sadis => "ሳድስ",
            Order::Sabi => "ሳብዕ",
            Order::Wa => "-wa",
            Order::Wi => "-wi",
            Order::Waa => "-waa",
            Order::Wee => "-wee",
            Order::We => "-we",
            Order::Oa => "-oa",
        }
    }
}

/// Which alterations build an order from its base. An order has several
/// forms, and which one a family uses depends on the shape of its base: the
/// 4th order shortens the left leg of ላ but sweeps the stem of ታ. Variant 0
/// is the default; each family picks its own. Drawing a fidel by hand is
/// the one form outside this list (see [`crate::FidelState::Detached`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrderRule {
    pub order: Order,
    pub variants: Vec<Vec<AlterationId>>,
    /// A short name per variant ("Short left leg"), shown where a family
    /// picks its form. Missing names fall back to the alteration names.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub names: Vec<String>,
}

impl OrderRule {
    pub fn variant(&self, index: usize) -> Option<&[AlterationId]> {
        self.variants.get(index).map(Vec::as_slice)
    }

    pub fn name(&self, index: usize) -> Option<&str> {
        self.names.get(index).map(String::as_str).filter(|n| !n.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbering_round_trips() {
        for o in Order::ALL {
            assert_eq!(Order::from_number(o.number()), Some(o));
        }
        assert_eq!(Order::from_number(0), None);
        assert_eq!(Order::from_number(8), None);
        assert_eq!(Order::Hamis.number(), 5);
    }
}
