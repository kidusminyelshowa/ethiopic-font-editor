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
}

impl Order {
    pub const ALL: [Order; 7] =
        [Order::Giiz, Order::Kaib, Order::Salis, Order::Rabi, Order::Hamis, Order::Sadis, Order::Sabi];

    /// 1 to 7.
    pub fn number(self) -> u8 {
        self as u8 + 1
    }

    pub fn from_number(n: u8) -> Option<Order> {
        Order::ALL.get(usize::from(n).checked_sub(1)?).copied()
    }

    /// Traditional name, as used for the Fidel Grid column headers.
    pub fn name(self) -> &'static str {
        match self {
            Order::Giiz => "Gi'iz",
            Order::Kaib => "Ka'ib",
            Order::Salis => "Salis",
            Order::Rabi => "Rabi'",
            Order::Hamis => "Hamis",
            Order::Sadis => "Sadis",
            Order::Sabi => "Sab'i",
        }
    }
}

/// Which alterations build an order from its base. An order can have several
/// variants (Hornus: the 4th order shortens the left leg *or* stretches the
/// stem); variant 0 is the default and a family can pick another.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrderRule {
    pub order: Order,
    pub variants: Vec<Vec<AlterationId>>,
}

impl OrderRule {
    pub fn variant(&self, index: usize) -> Option<&[AlterationId]> {
        self.variants.get(index).map(Vec::as_slice)
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
