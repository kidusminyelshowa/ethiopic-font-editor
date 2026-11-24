//! Default alterations and order rules from Hornus section 3.1, and a starter
//! Ge'ez project built from them.

use std::collections::BTreeMap;

use crate::alteration::{Alteration, Placement, Region, Verb};
use crate::base::Base;
use crate::ethiopic::{default_built_on, default_form, Form, GEEZ_FAMILIES};
use crate::fidel::{Family, Fidel, FidelState};
use crate::geometry::Vec2;
use crate::order::{Order, OrderRule};
use crate::parts::Part;
use crate::project::{Metrics, Project, ZONE_CRICK, ZONE_SHORT_LEG, ZONE_STRETCH};

pub const STROKE_MIDDLE_RIGHT: &str = "stroke.middle-right";
pub const STROKE_BOTTOM_RIGHT: &str = "stroke.bottom-right";
pub const SHORTEN_LEFT_LEG: &str = "shorten.left-leg";
pub const SHORTEN_LEFT_LEGS: &str = "shorten.left-legs";
pub const STRETCH_STEM: &str = "stretch.stem";
pub const HEAD_STROKE: &str = "stroke.head-left";
pub const LEG_RIGHT: &str = "stroke.leg-right";
pub const RING_ON_BAR: &str = "loop.on-bar";
pub const LOOP_BOTTOM_RIGHT: &str = "loop.bottom-right";
pub const CRICK_FIRST_STROKE: &str = "crick.first-stroke";
pub const TICK_ON_TOP: &str = "stroke.top-tick";
pub const FOOT_FLICK: &str = "crick.foot";
pub const LOOP_BOTTOM_LEFT: &str = "loop.bottom-left";
pub const LOOP_TOP_RIGHT: &str = "loop.top-right";
pub const SHORTEN_RIGHT_LEG: &str = "shorten.right-leg";
pub const SHORTEN_RIGHT_LEGS: &str = "shorten.right-legs";
pub const LABIAL_MARK: &str = "mark.labial";
pub const OA_MARK: &str = "mark.oa";
pub const CAP_TOP: &str = "cap.top";
pub const SHOE_BOTTOM: &str = "shoe.bottom";
pub const TICK_TOP_RIGHT: &str = "stroke.tick-top-right";

/// What each derived row adds to its source row's base (see
/// [`crate::charset::ROW_SOURCE`]): ሸ ቸ ኘ ዠ ጨ take a cap, ቨ ጀ ዸ a foot,
/// ቐ ኸ ጘ a tick.
pub fn derived_adds(row: &str) -> Option<&'static str> {
    Some(match row {
        "sha" | "ca" | "nya" | "zha" | "cha" => CAP_TOP,
        "va" | "ja" | "dda" => SHOE_BOTTOM,
        "qha" | "kxa" | "gga" => TICK_TOP_RIGHT,
        _ => return None,
    })
}

fn alteration(id: &str, name: &str, verb: Verb, region: Region, parts: &[Part]) -> Alteration {
    Alteration {
        id: id.into(),
        name: name.into(),
        verb,
        placement: Placement { anchor: None, region, parts: parts.to_vec(), offset: Vec2::ZERO },
        contours: Vec::new(),
        forked_from: None,
        zone: None,
        amount: None,
        all_but_one: false,
    }
}

fn on_zone(mut a: Alteration, zone: &str) -> Alteration {
    a.zone = Some(zone.into());
    a
}

fn all_but_one(mut a: Alteration) -> Alteration {
    a.all_but_one = true;
    a
}

/// The alterations behind every order form, undrawn. The designer draws each
/// additive one once; the deforms work on the base's own strokes.
pub fn hornus_alterations() -> Vec<Alteration> {
    use Part::*;
    let legs = [Leg, Stem, Diagonal];
    let shorten =
        |id, name, region| on_zone(alteration(id, name, Verb::Shorten, region, &legs), ZONE_SHORT_LEG);
    vec![
        alteration(STROKE_MIDDLE_RIGHT, "2nd-order stroke", Verb::Stroke, Region::MiddleRight, &legs),
        alteration(STROKE_BOTTOM_RIGHT, "3rd-order stroke", Verb::Stroke, Region::BottomRight, &legs),
        shorten(SHORTEN_LEFT_LEG, "Short left leg", Region::BottomLeft),
        all_but_one(shorten(SHORTEN_LEFT_LEGS, "Short left and middle legs", Region::BottomLeft)),
        on_zone(
            alteration(STRETCH_STEM, "Stem sweeps left", Verb::Stretch, Region::BottomLeft, &[Stem, Leg]),
            ZONE_STRETCH,
        ),
        alteration(HEAD_STROKE, "Head turns down", Verb::Stroke, Region::TopLeft, &[Branch, Stem, Leg]),
        alteration(LEG_RIGHT, "Leg on the right", Verb::Stroke, Region::BottomRight, &[Bowl, Leg, Stem]),
        alteration(RING_ON_BAR, "Ring on a short bar", Verb::Loop, Region::MiddleRight, &legs),
        alteration(LOOP_BOTTOM_RIGHT, "5th-order ring", Verb::Loop, Region::BottomRight, &legs),
        alteration(CRICK_FIRST_STROKE, "First stroke cricks", Verb::Crick, Region::TopLeft, &legs),
        alteration(TICK_ON_TOP, "Tick on top", Verb::Stroke, Region::TopLeft, &[Stem, Leg, Branch]),
        on_zone(
            alteration(FOOT_FLICK, "Foot flicks left", Verb::Crick, Region::BottomLeft, &legs),
            ZONE_CRICK,
        ),
        alteration(LOOP_BOTTOM_LEFT, "Ring at the foot", Verb::Loop, Region::BottomLeft, &legs),
        alteration(LOOP_TOP_RIGHT, "Ring on top", Verb::Loop, Region::TopRight, &[Stem, Leg, Arm]),
        shorten(SHORTEN_RIGHT_LEG, "Short right leg", Region::BottomRight),
        all_but_one(shorten(SHORTEN_RIGHT_LEGS, "Short middle and right legs", Region::BottomRight)),
    ]
}

/// The marks of the labialized and -oa forms, undrawn. Added when a project
/// takes on a set that has them.
pub fn extra_alterations() -> Vec<Alteration> {
    use Part::*;
    vec![
        alteration(LABIAL_MARK, "Labial mark (-wa)", Verb::Stroke, Region::TopRight, &[Leg, Stem, Diagonal]),
        alteration(OA_MARK, "-oa mark", Verb::Loop, Region::TopRight, &[Leg, Stem, Diagonal]),
        alteration(CAP_TOP, "Cap (ሸ ቸ ኘ ዠ ጨ)", Verb::Cap, Region::TopLeft, &[]),
        alteration(SHOE_BOTTOM, "Foot (ቨ ጀ)", Verb::Shoe, Region::BottomLeft, &[Leg, Stem]),
        alteration(TICK_TOP_RIGHT, "Tick (ቐ ኸ ጘ)", Verb::Stroke, Region::TopRight, &[]),
    ]
}

/// Rules for the labialized and -oa orders. Each starts from the fidel it is
/// built on (see [`crate::coverage`]) and adds the labial mark, plus the
/// vowel mark of its own order where the parent does not carry it.
pub fn extra_order_rules() -> Vec<OrderRule> {
    let one = |ids: &[&str]| ids.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let rule = |order, ids: &[&str]| OrderRule { order, variants: vec![one(ids)], names: Vec::new() };
    vec![
        rule(Order::Wa, &[LABIAL_MARK]),
        rule(Order::Wi, &[LABIAL_MARK, STROKE_BOTTOM_RIGHT]),
        rule(Order::Waa, &[LABIAL_MARK]),
        rule(Order::Wee, &[LABIAL_MARK, LOOP_BOTTOM_RIGHT]),
        rule(Order::We, &[LABIAL_MARK]),
        rule(Order::Oa, &[OA_MARK]),
    ]
}

/// The forms of each order, from the reference fonts (Noto Sans and Serif
/// Ethiopic, Abyssinica SIL). Each family picks one ([`DEFAULT_FORMS`]); the
/// first is the default.
pub fn hornus_order_rules() -> Vec<OrderRule> {
    let rule = |order, forms: &[(&str, &[&str])]| OrderRule {
        order,
        variants: forms.iter().map(|(_, ids)| ids.iter().map(|s| s.to_string()).collect()).collect(),
        names: forms.iter().map(|(n, _)| n.to_string()).collect(),
    };
    vec![
        rule(Order::Giiz, &[("Base", &[])]),
        rule(Order::Kaib, &[("Stroke at the right", &[STROKE_MIDDLE_RIGHT])]),
        rule(Order::Salis, &[("Stroke at the foot", &[STROKE_BOTTOM_RIGHT])]),
        rule(
            Order::Rabi,
            &[
                ("Short left leg", &[SHORTEN_LEFT_LEG]),
                ("Stem sweeps left", &[STRETCH_STEM]),
                ("Short left and middle legs", &[SHORTEN_LEFT_LEGS]),
                ("Head turns down", &[HEAD_STROKE]),
                ("Leg on the right", &[LEG_RIGHT]),
            ],
        ),
        rule(Order::Hamis, &[("Ring at the foot", &[LOOP_BOTTOM_RIGHT])]),
        rule(
            Order::Sadis,
            &[
                ("First stroke cricks", &[CRICK_FIRST_STROKE]),
                ("Tick on top", &[TICK_ON_TOP]),
                ("Foot flicks left", &[FOOT_FLICK]),
                ("Ring at the foot", &[LOOP_BOTTOM_LEFT]),
            ],
        ),
        rule(
            Order::Sabi,
            &[
                ("Short right leg", &[SHORTEN_RIGHT_LEG]),
                ("Ring on top", &[LOOP_TOP_RIGHT]),
                ("Short middle and right legs", &[SHORTEN_RIGHT_LEGS]),
                ("Ring on a short bar", &[RING_ON_BAR]),
            ],
        ),
    ]
}

/// What File > New makes: the Ge'ez families plus everything Amharic is
/// written with.
pub fn starter_project(metrics: Metrics) -> Project {
    let mut p = geez_project(metrics);
    p.set_coverage([], [crate::charset::Language::Amharic]);
    p
}

/// A new project with the 26 Ge'ez families, empty bases, Hornus's rules and
/// the forms each family uses and the "built on" links.
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
            attach_offsets: BTreeMap::new(),
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
        apply_default_forms(&mut family);
        p.families.insert(f.id.into(), family);
    }
    p
}

/// Give a family the forms the reference fonts use (see
/// [`crate::ethiopic::DEFAULT_FORMS`]): the variant of each order rule, and
/// "Draw it" for the fidel no rule makes. Only Linked fidel are touched.
pub fn apply_default_forms(family: &mut Family) {
    let row = family.id.clone();
    for (order, fidel) in family.fidels.iter_mut() {
        match default_form(&row, *order) {
            Form::Variant(0) => {}
            Form::Variant(v) => {
                family.rule_variants.entry(*order).or_insert(v);
            }
            Form::Draw => {
                if fidel.state == FidelState::Linked {
                    fidel.state = FidelState::Detached { contours: Vec::new() };
                }
            }
        }
    }
}
