//! Letter morphology (Hornus fig. 5). Contours are tagged with a part so that
//! placement rules, tools and later AI passes can target "all legs" or "all rings".

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Part {
    /// Vertical stroke joining the top and bottom lines.
    Stem,
    /// Vertical stroke free at the bottom, linked at the top.
    Leg,
    /// Vertical stroke free at the top, linked at the bottom.
    Arm,
    /// Horizontal stroke crossing the letter.
    Bar,
    /// Short horizontal stroke linking the body to a leaf or ring.
    Branch,
    /// Terminal extension marking a bar or branch.
    Leaf,
    /// Circular extension linked to a bar or stem.
    Ring,
    /// Closed counter that is part of the base letter.
    Bowl,
    /// Slanted stroke, top to bottom.
    Diagonal,
    /// Short vertical stroke joined to the top of the body.
    Neck,
    /// Discontinued part of a stem.
    Break,
}

impl Part {
    pub const ALL: [Part; 11] = [
        Part::Stem,
        Part::Leg,
        Part::Arm,
        Part::Bar,
        Part::Branch,
        Part::Leaf,
        Part::Ring,
        Part::Bowl,
        Part::Diagonal,
        Part::Neck,
        Part::Break,
    ];
}
