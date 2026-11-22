//! Scoped edits: change an alteration for one fidel, one family or one order
//! instead of everywhere.
//!
//! A scoped edit makes a copy of the alteration (a fork) and points only the
//! fidel in scope at the copy. Their nudges move to the copy too, so nothing
//! is lost. Rejoining points them back at the shared alteration and deletes
//! the copy.

use serde::{Deserialize, Serialize};

use crate::alteration::AlterationId;
use crate::fidel::{FamilyId, FidelState, IrregularForm, Nudge, NudgeTarget, Source};
use crate::order::Order;
use crate::project::{ModelError, Project};

/// Which fidel an edit to an alteration applies to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", tag = "kind")]
pub enum Scope {
    /// The shared alteration: every fidel that uses it.
    Everywhere,
    /// Every fidel of one order that uses it.
    Order { order: Order },
    /// Every fidel of one family that uses it.
    Family { family: FamilyId },
    /// One fidel.
    Fidel { family: FamilyId, order: Order },
}

impl Scope {
    fn contains(&self, family: &str, order: Order) -> bool {
        match self {
            Scope::Everywhere => true,
            Scope::Order { order: o } => *o == order,
            Scope::Family { family: f } => f == family,
            Scope::Fidel { family: f, order: o } => f == family && *o == order,
        }
    }

    fn id_suffix(&self) -> String {
        match self {
            Scope::Everywhere => String::new(),
            Scope::Order { order } => format!("{order:?}").to_lowercase(),
            Scope::Family { family } => family.clone(),
            Scope::Fidel { family, order } => format!("{family}-{}", format!("{order:?}").to_lowercase()),
        }
    }
}

impl Project {
    /// Every (family, order) whose fidel is built with this alteration.
    pub fn users_of(&self, alteration: &str) -> Vec<(FamilyId, Order)> {
        let mut out = Vec::new();
        for (fam, family) in &self.families {
            for order in family.fidels.keys() {
                let uses = self
                    .effective_alterations(fam, *order)
                    .map(|a| a.iter().any(|id| id == alteration))
                    .unwrap_or(false);
                if uses {
                    out.push((fam.clone(), *order));
                }
            }
        }
        out
    }

    /// Give the fidel in `scope` their own copy of `alteration` and return the
    /// copy's id. With [`Scope::Everywhere`] nothing changes and the same id
    /// comes back.
    pub fn fork_alteration(&mut self, alteration: &str, scope: &Scope) -> Result<AlterationId, ModelError> {
        let original = self
            .alterations
            .get(alteration)
            .ok_or_else(|| ModelError::UnknownAlteration(alteration.into()))?;
        if *scope == Scope::Everywhere {
            return Ok(original.id.clone());
        }
        let targets: Vec<_> =
            self.users_of(alteration).into_iter().filter(|(f, o)| scope.contains(f, *o)).collect();
        if targets.is_empty() {
            return Err(ModelError::NotUsedInScope(alteration.into()));
        }

        let base_id = format!("{alteration}~{}", scope.id_suffix());
        let mut id = base_id.clone();
        let mut n = 2;
        while self.alterations.contains_key(&id) {
            id = format!("{base_id}-{n}");
            n += 1;
        }
        let mut copy = original.clone();
        copy.id = id.clone();
        copy.name = format!("{} ({})", original.name, self.scope_label(scope));
        // A copy of a copy still rejoins the shared alteration it came from.
        copy.forked_from = Some(original.forked_from.clone().unwrap_or_else(|| original.id.clone()));
        self.alterations.insert(id.clone(), copy);

        for (family, order) in targets {
            self.swap_alteration(&family, order, alteration, &id)?;
        }
        Ok(id)
    }

    /// Point every fidel that uses the copy `fork` back at the alteration it
    /// was copied from, and delete the copy. Returns the shared alteration's id.
    pub fn rejoin_alteration(&mut self, fork: &str) -> Result<AlterationId, ModelError> {
        let alt = self.alterations.get(fork).ok_or_else(|| ModelError::UnknownAlteration(fork.into()))?;
        let shared = alt.forked_from.clone().ok_or_else(|| ModelError::NotAFork(fork.into()))?;
        if !self.alterations.contains_key(&shared) {
            return Err(ModelError::UnknownAlteration(shared));
        }
        for (family, order) in self.users_of(fork) {
            self.swap_alteration(&family, order, fork, &shared)?;
        }
        self.alterations.remove(fork);
        Ok(shared)
    }

    /// Replace `from` with `to` in what one fidel is built from, and carry
    /// its nudges over.
    fn swap_alteration(
        &mut self,
        family: &str,
        order: Order,
        from: &str,
        to: &str,
    ) -> Result<(), ModelError> {
        let rule = self.rule_alterations(family, order);
        let fidel = self.fidel_mut(family, order)?;
        match &mut fidel.state {
            FidelState::Irregular { form: IrregularForm::Recipe { alterations, .. }, .. } => {
                for a in alterations.iter_mut().filter(|a| *a == from) {
                    *a = to.to_string();
                }
            }
            _ => {
                // Which rule alteration currently resolves to `from`?
                let key = fidel
                    .alteration_overrides
                    .iter()
                    .find(|(_, v)| *v == from)
                    .map(|(k, _)| k.clone())
                    .or_else(|| rule.iter().find(|r| *r == from).cloned());
                if let Some(key) = key {
                    if key == to {
                        fidel.alteration_overrides.remove(&key);
                    } else {
                        fidel.alteration_overrides.insert(key, to.to_string());
                    }
                }
            }
        }
        if let Some(nudges) = nudges_mut(&mut fidel.state) {
            for n in nudges {
                retarget(n, from, to);
            }
        }
        Ok(())
    }

    fn scope_label(&self, scope: &Scope) -> String {
        let cp = |f: &str, o: Order| {
            self.fidel(f, o).ok().and_then(|x| x.codepoint).map(String::from).unwrap_or_else(|| f.to_string())
        };
        match scope {
            Scope::Everywhere => "everywhere".into(),
            Scope::Order { order } => format!("{} only", order.name()),
            Scope::Family { family } => {
                format!(
                    "{} family only",
                    self.families.get(family).map(|f| f.name.as_str()).unwrap_or(family)
                )
            }
            Scope::Fidel { family, order } => format!("{} only", cp(family, *order)),
        }
    }
}

fn nudges_mut(state: &mut FidelState) -> Option<&mut Vec<Nudge>> {
    match state {
        FidelState::Adjusted { nudges } => Some(nudges),
        FidelState::Irregular { form: IrregularForm::Recipe { nudges, .. }, .. } => Some(nudges),
        _ => None,
    }
}

fn retarget(n: &mut Nudge, from: &str, to: &str) {
    match &mut n.target {
        NudgeTarget::Point { source: Source::Alteration(a), .. }
        | NudgeTarget::Placement { alteration: a }
            if a == from =>
        {
            *a = to.to_string();
        }
        _ => {}
    }
}
