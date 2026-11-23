//! Growing a project to cover more of the Ethiopic repertoire.
//!
//! Picking a character set never deletes anything: turning a set off hides its
//! glyphs and leaves them out of the export, and turning it back on brings the
//! work back. Turning a set on creates whatever it needs that the project does
//! not have yet: families and their bases, the labialized orders, and symbols.

use std::collections::{BTreeMap, BTreeSet};

use crate::base::Base;
use crate::charset::{self, CharSet, Entry, Slot};
use crate::defaults;
use crate::fidel::{Family, Fidel, FidelState};
use crate::order::Order;
use crate::project::{Project, Symbol};

impl Project {
    /// The sets this project covers. An empty list means Ge'ez only.
    pub fn charsets(&self) -> BTreeSet<CharSet> {
        if self.charsets.is_empty() {
            BTreeSet::from([CharSet::Geez])
        } else {
            self.charsets.clone()
        }
    }

    /// Whether a character belongs to a set the project covers. Characters
    /// outside the Ethiopic table always count as covered.
    pub fn in_charset(&self, c: char) -> bool {
        match charset::set_of(c) {
            Some(set) => self.charsets().contains(&set),
            None => true,
        }
    }

    /// Whether this fidel is shown and exported.
    pub fn fidel_in_charset(&self, family: &str, order: Order) -> bool {
        self.fidel(family, order).ok().and_then(|f| f.codepoint).is_none_or(|c| self.in_charset(c))
    }

    /// Cover exactly these sets. Creates what is missing; never deletes.
    pub fn set_charsets(&mut self, sets: impl IntoIterator<Item = CharSet>) {
        let sets: BTreeSet<CharSet> = sets.into_iter().collect();
        let wanted: Vec<&Entry> = charset::entries().filter(|e| sets.contains(&e.set)).collect();
        if wanted.iter().any(|e| matches!(e.slot, Slot::Fidel { order, .. } if !order.is_main())) {
            self.ensure_extra_rules();
        }
        for e in &wanted {
            match e.slot {
                Slot::Fidel { family, name, order } => self.ensure_fidel(e.cp, family, name, order),
                Slot::Symbol { name } => {
                    let id = charset::symbol_id(e.cp);
                    let advance = f64::from(self.metrics.units_per_em) * 0.4;
                    self.symbols.entry(id.clone()).or_insert_with(|| Symbol {
                        id,
                        codepoint: e.cp,
                        name: sentence_case(name),
                        advance_width: advance,
                        contours: Vec::new(),
                    });
                }
            }
        }
        // Link new labialized forms to the order they are drawn from.
        for e in &wanted {
            if let Slot::Fidel { family, order, .. } = e.slot {
                if !order.is_main() {
                    self.default_extra_link(family, order);
                }
            }
        }
        self.charsets = sets;
    }

    fn ensure_extra_rules(&mut self) {
        for alt in defaults::extra_alterations() {
            self.alterations.entry(alt.id.clone()).or_insert(alt);
        }
        for rule in defaults::extra_order_rules() {
            self.order_rules.entry(rule.order).or_insert(rule);
        }
    }

    fn ensure_fidel(&mut self, cp: char, family: &str, name: &str, order: Order) {
        if !self.families.contains_key(family) {
            let base = charset::shared_base(family).unwrap_or_else(|| family.to_string());
            if !self.bases.contains_key(&base) {
                let mut b = Base::new(base.clone(), name, 600.0);
                let source = charset::ROW_SOURCE.iter().find(|(row, _)| *row == base);
                if let Some(src) = source.and_then(|(_, src)| self.bases.get(*src)) {
                    b.advance_width = src.advance_width;
                    b.contours = src.contours.clone();
                    b.anchors = src.anchors.clone();
                }
                self.bases.insert(base.clone(), b);
            }
            let group = self.families.values().find(|f| f.base == base).and_then(|f| f.group);
            self.families.insert(
                family.into(),
                Family {
                    id: family.into(),
                    name: name.into(),
                    base,
                    group,
                    rule_variants: BTreeMap::new(),
                    fidels: BTreeMap::new(),
                },
            );
        }
        let fam = self.families.get_mut(family).expect("just ensured");
        fam.fidels.entry(order).or_insert_with(|| Fidel {
            codepoint: Some(cp),
            state: FidelState::Linked,
            alteration_overrides: BTreeMap::new(),
            built_on: None,
        });
    }

    /// ሏ is drawn from ላ, ቈ ቊ ቌ from ቀ, ቋ from ቃ, ሇ from ሎ.
    fn default_extra_link(&mut self, family: &str, order: Order) {
        let Some(fam) = self.families.get(family) else { return };
        let Some(fidel) = fam.fidels.get(&order) else { return };
        if fidel.built_on.is_some() || fidel.state != FidelState::Linked {
            return;
        }
        let labiovelar = fam.fidels.contains_key(&Order::Waa);
        let parent = match order {
            Order::Wa if labiovelar => Order::Giiz,
            Order::Wa | Order::Waa => Order::Rabi,
            Order::Wi | Order::Wee => Order::Giiz,
            Order::We => Order::Sadis,
            Order::Oa => Order::Sabi,
            _ => return,
        };
        if fam.fidels.contains_key(&parent) {
            let _ = self.set_built_on(family, order, Some(parent));
        }
    }
}

/// "Section Mark" → "Section mark".
fn sentence_case(name: &str) -> String {
    let lower = name.to_lowercase();
    let mut chars = lower.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}
