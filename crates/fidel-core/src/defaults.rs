//! Default alterations and order rules from Hornus section 3.1, and a starter
//! Ge'ez project built from them.

use std::collections::BTreeMap;

use crate::alteration::{Alteration, Placement, Region, Verb};
use crate::base::Base;
use crate::ethiopic::{default_built_on, default_irregular_note, GEEZ_FAMILIES};
use crate::fidel::{Family, Fidel, FidelState, IrregularForm};
use crate::geometry::Vec2;
use crate::order::{Order, OrderRule};
use crate::parts::Part;
use crate::project::{Metrics, Project};

pub const STROKE_MIDDLE_RIGHT: &str = "stroke.middle-right";
pub const STROKE_BOTTOM_RIGHT: &str = "stroke.bottom-right";
pub const SHORTEN_LEFT_LEG: &str = "shorten.left-leg";
pub const STRETCH_STEM: &str = "stretch.stem";
pub const LOOP_BOTTOM_RIGHT: &str = "loop.bottom-right";
pub const CRICK_FIRST_STROKE: &str = "crick.first-stroke";
pub const LOOP_TOP_RIGHT: &str = "loop.top-right";
pub const SHORTEN_RIGHT_LEG: &str = "shorten.right-leg";
pub const LABIAL_MARK: &str = "mark.labial";
pub const OA_MARK: &str = "mark.oa";

fn alteration(id: &str, name: &str, verb: Verb, region: Region, parts: &[Part]) -> Alteration {
    Alteration {
        id: id.into(),
        name: name.into(),
        verb,
        placement: Placement { anchor: None, region, parts: parts.to_vec(), offset: Vec2::ZERO },
        contours: Vec::new(),
        forked_from: None,
    }
}

/// Hornus's alterations, undrawn. The designer draws each additive one once.
pub fn hornus_alterations() -> Vec<Alteration> {
    use Part::*;
    let legs = [Leg, Stem, Diagonal];
    vec![
        alteration(
            STROKE_MIDDLE_RIGHT,
            "2nd-order stroke, middle right",
            Verb::Stroke,
            Region::MiddleRight,
            &legs,
        ),
        alteration(
            STROKE_BOTTOM_RIGHT,
            "3rd-order stroke, bottom right",
            Verb::Stroke,
            Region::BottomRight,
            &legs,
        ),
        alteration(
            SHORTEN_LEFT_LEG,
            "4th-order shortened left leg",
            Verb::Shorten,
            Region::BottomLeft,
            &[Leg],
        ),
        alteration(STRETCH_STEM, "4th-order stretched stem", Verb::Stretch, Region::BottomRight, &[Stem]),
        alteration(LOOP_BOTTOM_RIGHT, "5th-order loop, bottom right", Verb::Loop, Region::BottomRight, &legs),
        alteration(CRICK_FIRST_STROKE, "6th-order crick", Verb::Crick, Region::BottomLeft, &legs),
        alteration(
            LOOP_TOP_RIGHT,
            "7th-order loop, top right",
            Verb::Loop,
            Region::TopRight,
            &[Stem, Leg, Arm],
        ),
        alteration(
            SHORTEN_RIGHT_LEG,
            "7th-order shortened right leg",
            Verb::Shorten,
            Region::BottomRight,
            &[Leg],
        ),
    ]
}

/// The marks of the labialized and -oa forms, undrawn. Added when a project
/// takes on a set that has them.
pub fn extra_alterations() -> Vec<Alteration> {
    use Part::*;
    vec![
        alteration(LABIAL_MARK, "Labial mark (-wa)", Verb::Stroke, Region::TopRight, &[Leg, Stem, Diagonal]),
        alteration(OA_MARK, "-oa mark", Verb::Loop, Region::TopRight, &[Leg, Stem, Diagonal]),
    ]
}

/// Rules for the labialized and -oa orders. Each starts from the fidel it is
/// built on (see [`crate::coverage`]) and adds the labial mark, plus the
/// vowel mark of its own order where the parent does not carry it.
pub fn extra_order_rules() -> Vec<OrderRule> {
    let one = |ids: &[&str]| ids.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let rule = |order, ids: &[&str]| OrderRule { order, variants: vec![one(ids)] };
    vec![
        rule(Order::Wa, &[LABIAL_MARK]),
        rule(Order::Wi, &[LABIAL_MARK, STROKE_BOTTOM_RIGHT]),
        rule(Order::Waa, &[LABIAL_MARK]),
        rule(Order::Wee, &[LABIAL_MARK, LOOP_BOTTOM_RIGHT]),
        rule(Order::We, &[LABIAL_MARK]),
        rule(Order::Oa, &[OA_MARK]),
    ]
}

/// Default order rules (Hornus 3.1): 2nd = middle-right stroke, 3rd =
/// bottom-right stroke, 4th = shortened left leg or stretched stem, 5th =
/// bottom-right loop, 6th = crick, 7th = top-right loop or shortened right leg.
pub fn hornus_order_rules() -> Vec<OrderRule> {
    let one = |ids: &[&str]| ids.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let rule = |order, variants: Vec<Vec<String>>| OrderRule { order, variants };
    vec![
        rule(Order::Giiz, vec![vec![]]),
        rule(Order::Kaib, vec![one(&[STROKE_MIDDLE_RIGHT])]),
        rule(Order::Salis, vec![one(&[STROKE_BOTTOM_RIGHT])]),
        rule(Order::Rabi, vec![one(&[SHORTEN_LEFT_LEG]), one(&[STRETCH_STEM])]),
        rule(Order::Hamis, vec![one(&[LOOP_BOTTOM_RIGHT])]),
        rule(Order::Sadis, vec![one(&[CRICK_FIRST_STROKE])]),
        rule(Order::Sabi, vec![one(&[LOOP_TOP_RIGHT]), one(&[SHORTEN_RIGHT_LEG])]),
    ]
}

/// A new project with the 26 Ge'ez families, empty bases, Hornus's rules and
/// the built-in irregular flags and "built on" links. Every fidel starts
/// Linked unless pre-flagged.
pub fn geez_project(metrics: Metrics) -> Project {
    let mut p = Project { metrics, ..Default::default() };
    p.charsets.insert(crate::charset::CharSet::Geez);
    for alt in hornus_alterations() {
        p.alterations.insert(alt.id.clone(), alt);
    }
    for rule in hornus_order_rules() {
        p.order_rules.insert(rule.order, rule);
    }
    for f in GEEZ_FAMILIES {
        p.bases.insert(f.id.into(), Base::new(f.id, f.name, 600.0));
        let mut family = Family {
            id: f.id.into(),
            name: f.name.into(),
            base: f.id.into(),
            group: Some(f.group),
            rule_variants: BTreeMap::new(),
            fidels: BTreeMap::new(),
        };
        for order in Order::ALL {
            let c = f.codepoint(order);
            family.fidels.insert(
                order,
                Fidel {
                    codepoint: Some(c),
                    state: FidelState::Linked,
                    alteration_overrides: BTreeMap::new(),
                    built_on: default_built_on(c).map(|parent| {
                        Order::ALL.into_iter().find(|o| f.codepoint(*o) == parent).expect("same family")
                    }),
                },
            );
        }
        p.families.insert(f.id.into(), family);
        for order in Order::ALL {
            let c = f.codepoint(order);
            if let Some(note) = default_irregular_note(c) {
                let alterations = p.effective_alterations(f.id, order).unwrap_or_default();
                p.families.get_mut(f.id).unwrap().fidels.get_mut(&order).unwrap().state =
                    FidelState::Irregular {
                        form: IrregularForm::Recipe { alterations, nudges: Vec::new() },
                        note: Some(note.into()),
                    };
            }
        }
    }
    p
}
