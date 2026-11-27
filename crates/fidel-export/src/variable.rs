//! Variable fonts and static instances from a project with masters.
//!
//! Every master is resolved on its own; a glyph whose resolved outlines
//! match point for point in all masters varies, the rest stay as drawn in
//! the default master and are reported. Cubics are turned into quadratics
//! for all masters at once, so the quadratics match too.

use std::collections::BTreeMap;

use fidel_core::designspace::{Instance, Model};
use fidel_core::geometry::{Contour, PointKind, Vec2};
use fidel_core::{DrawingTarget, Project};
use kurbo::{BezPath, CubicBez, Point};
use write_fonts::tables::avar::{Avar, AxisValueMap, SegmentMaps};
use write_fonts::tables::fvar::{AxisInstanceArrays, Fvar, InstanceRecord, VariationAxisRecord};
use write_fonts::tables::glyf::{Glyph, SimpleGlyph};
use write_fonts::tables::gvar::{GlyphDelta, GlyphDeltas, GlyphVariations, Gvar, Tent};
use write_fonts::tables::stat::{AxisRecord, AxisValue, AxisValueTableFlags, Stat};
use write_fonts::types::{F2Dot14, Fixed, GlyphId, NameId, Tag};
use write_fonts::{BuilderError, FontBuilder};

use super::{
    build, collect_items, fixed_glyphs, glyph_name, simple_glyph, to_u16, ExportError, ExportOptions,
    ExportedFont, GlyphOut, CURVE_ACCURACY,
};

/// Outlines and widths by character.
type Items = BTreeMap<char, (Vec<Contour>, f64)>;

/// Each master's points of one glyph, phantom points last.
type MasterPoints = Vec<Vec<(f64, f64)>>;

/// The tables a variable font adds, and the names they point at.
pub(crate) struct VarTables {
    pub names: Vec<(u16, String)>,
    fvar: Fvar,
    gvar: Gvar,
    avar: Option<Avar>,
    stat: Stat,
}

impl VarTables {
    pub(crate) fn add_to(self, font: &mut FontBuilder) -> Result<(), BuilderError> {
        font.add_table(&self.fvar)?.add_table(&self.gvar)?.add_table(&self.stat)?;
        if let Some(avar) = &self.avar {
            font.add_table(avar)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct VariableFont {
    pub bytes: Vec<u8>,
    pub exported: Vec<char>,
    pub skipped: Vec<char>,
    /// Glyphs whose masters do not match, kept as in the default master.
    pub fixed: Vec<char>,
}

/// One static font at an instance's location, named after it.
pub fn export_instance(
    project: &Project,
    instance: &Instance,
    options: &ExportOptions,
) -> Result<ExportedFont, ExportError> {
    let at = project.instance_at(&instance.location).map_err(|e| ExportError::Design(e.to_string()))?;
    let mut options = options.clone();
    options.style_name = instance.name.clone();
    super::export(&at, &options)
}

/// A variable font over all masters, with the instances as named instances.
pub fn export_variable(project: &Project, options: &ExportOptions) -> Result<VariableFont, ExportError> {
    let family = options.family_name.trim();
    if family.is_empty() {
        return Err(ExportError::NoFamilyName);
    }
    let design = &project.design;
    if design.masters.len() < 2 || design.axes.is_empty() {
        return Err(ExportError::Design("A variable font needs an axis and two masters".into()));
    }
    let (model, _) = project.model().map_err(|e| ExportError::Design(e.to_string()))?;
    let def = design
        .default_master()
        .ok_or_else(|| ExportError::Design("No master sits at the default location".into()))?;
    if model.order.first() != Some(&def) {
        return Err(ExportError::Design("No master sits at the default location".into()));
    }
    let masters: Vec<Project> = (0..design.masters.len()).map(|i| project.master_project(i)).collect();
    let per_master: Vec<BTreeMap<char, (Vec<Contour>, f64)>> =
        masters.iter().map(|p| collect_items(p).into_iter().map(|(c, o, a)| (c, (o, a))).collect()).collect();
    let base = &masters[def];
    let master_locs: Vec<Vec<f64>> = design.masters.iter().map(|m| design.master_location(m)).collect();
    let braces = brace_items(project);

    let mut glyphs = fixed_glyphs(base);
    // Each glyph's points per master, and which model they vary by: the
    // masters', or one that also has the glyph's brace layers.
    let mut models: Vec<Model> = vec![model];
    let mut variations: Vec<Option<(MasterPoints, usize)>> = vec![None; glyphs.len()];
    let (mut exported, mut skipped, mut fixed) = (Vec::new(), Vec::new(), Vec::new());
    for (ch, outline, advance) in collect_items(base) {
        let closed =
            |o: &[Contour]| o.iter().filter(|c| !c.open && c.points.len() >= 2).cloned().collect::<Vec<_>>();
        let contours = closed(&outline);
        if contours.is_empty() {
            skipped.push(ch);
            continue;
        }
        let name = glyph_name(ch);
        let mut sets: Option<Vec<(Vec<Contour>, f64)>> =
            per_master.iter().map(|m| m.get(&ch).map(|(o, a)| (closed(o), *a))).collect();
        let mut model_at = 0;
        let mine: Vec<&(Vec<f64>, Items)> =
            braces.iter().filter(|(_, items)| items.contains_key(&ch)).collect();
        if let (Some(list), false) = (sets.as_mut(), mine.is_empty()) {
            let mut locs = master_locs.clone();
            for (loc, items) in &mine {
                let (o, a) = &items[&ch];
                list.push((closed(o), *a));
                locs.push(loc.clone());
            }
            match Model::new(&locs) {
                Ok(m) => {
                    models.push(m);
                    model_at = models.len() - 1;
                }
                Err(_) => list.truncate(master_locs.len()),
            }
        }
        let varied = sets.as_ref().and_then(|sets| {
            let paths = lockstep(&sets.iter().map(|(c, _)| c.as_slice()).collect::<Vec<_>>())?;
            let built = SimpleGlyph::interpolatable_glyphs_from_bezpaths(&paths).ok()?;
            // Each master's points, then the four phantom points.
            let pts: Vec<Vec<(f64, f64)>> = built
                .iter()
                .zip(sets)
                .map(|(g, (_, adv))| {
                    let mut v: Vec<(f64, f64)> = g
                        .contours
                        .iter()
                        .flat_map(|c| c.iter().map(|p| (f64::from(p.x), f64::from(p.y))))
                        .collect();
                    v.extend([(0.0, 0.0), (adv.round(), 0.0), (0.0, 0.0), (0.0, 0.0)]);
                    v
                })
                .collect();
            let n = pts[0].len();
            pts.iter().all(|p| p.len() == n).then_some((built, pts))
        });
        let (glyph, var) = match varied {
            Some((mut built, pts)) => {
                let mut g = built.swap_remove(def);
                g.overlaps = contours.len() > 1;
                (Glyph::Simple(g), Some((pts, model_at)))
            }
            None => {
                fixed.push(ch);
                let refs: Vec<&Contour> = contours.iter().collect();
                let g = simple_glyph(&refs)
                    .map_err(|reason| ExportError::BadOutline { glyph: format!("{ch} ({name})"), reason })?;
                (g, None)
            }
        };
        glyphs.push(GlyphOut { name, codepoint: Some(ch), advance: to_u16(advance), glyph });
        variations.push(var);
        exported.push(ch);
    }
    if exported.is_empty() {
        return Err(ExportError::NothingDrawn);
    }

    // gvar: one tuple per master other than the default, in model order.
    let axis_count = design.axes.len() as u16;
    let mut gvars = Vec::new();
    for (gid, var) in variations.iter().enumerate() {
        let mut deltas_out = Vec::new();
        if let Some((pts, at)) = var {
            let model = &models[*at];
            let flat: Vec<Vec<f64>> =
                pts.iter().map(|p| p.iter().flat_map(|&(x, y)| [x, y]).collect()).collect();
            let deltas = model.deltas(&flat);
            for (k, d) in deltas.iter().enumerate().skip(1) {
                let ds: Vec<GlyphDelta> = d
                    .chunks(2)
                    .map(|xy| GlyphDelta::required(xy[0].round() as i16, xy[1].round() as i16))
                    .collect();
                if ds.iter().all(|g| g.x == 0 && g.y == 0) {
                    continue;
                }
                let tents = model.supports[k]
                    .iter()
                    .map(|&(lo, peak, hi)| {
                        Tent::new(
                            F2Dot14::from_f32(peak as f32),
                            Some((F2Dot14::from_f32(lo as f32), F2Dot14::from_f32(hi as f32))),
                        )
                    })
                    .collect();
                deltas_out.push(GlyphDeltas::new(tents, ds));
            }
        }
        gvars.push(GlyphVariations::new(GlyphId::new(gid as u32), deltas_out));
    }
    let gvar = Gvar::new(gvars, axis_count).map_err(|e| ExportError::Write(e.to_string()))?;

    // Names: axes from 256, then the instances.
    let mut names: Vec<(u16, String)> = Vec::new();
    let mut next = 256u16;
    let mut axis_names = Vec::new();
    for a in &design.axes {
        names.push((next, a.name.clone()));
        axis_names.push(next);
        next += 1;
    }
    let mut instance_names = Vec::new();
    for i in &design.instances {
        names.push((next, i.name.clone()));
        instance_names.push(next);
        next += 1;
    }

    let axes: Vec<VariationAxisRecord> = design
        .axes
        .iter()
        .zip(&axis_names)
        .map(|(a, &n)| {
            VariationAxisRecord::new(
                Tag::new_checked(a.tag.as_bytes()).unwrap_or(Tag::new(b"wght")),
                Fixed::from_f64(a.min),
                Fixed::from_f64(a.default),
                Fixed::from_f64(a.max),
                0,
                NameId::new(n),
            )
        })
        .collect();
    let instances: Vec<InstanceRecord> = design
        .instances
        .iter()
        .zip(&instance_names)
        .map(|(i, &n)| InstanceRecord {
            subfamily_name_id: NameId::new(n),
            flags: 0,
            coordinates: design
                .axes
                .iter()
                .map(|a| {
                    Fixed::from_f64(i.location.get(&a.tag).copied().unwrap_or(a.default).clamp(a.min, a.max))
                })
                .collect(),
            post_script_name_id: None,
        })
        .collect();
    let fvar = Fvar::new(AxisInstanceArrays::new(axes, instances));

    // avar, when an axis map bends the slider.
    let avar = design.axes.iter().any(|a| !a.map.is_empty()).then(|| {
        Avar::new(
            design
                .axes
                .iter()
                .map(|a| {
                    let mut pts: Vec<(f64, f64)> = vec![(-1.0, -1.0), (0.0, 0.0), (1.0, 1.0)];
                    for &[u, _] in &a.map {
                        if u > a.min && u < a.max && u != a.default {
                            pts.push((a.normalize_user(u), a.normalize_design(a.to_design(u))));
                        }
                    }
                    pts.sort_by(|x, y| x.0.total_cmp(&y.0));
                    pts.dedup_by(|x, y| x.0 == y.0);
                    let f = |v: f64| F2Dot14::from_f32(v.clamp(-1.0, 1.0) as f32);
                    SegmentMaps::new(pts.into_iter().map(|(a, b)| AxisValueMap::new(f(a), f(b))).collect())
                })
                .collect(),
        )
    });

    // STAT: each axis, and a value for every instance that sits on one axis.
    let mut values = Vec::new();
    for (ai, a) in design.axes.iter().enumerate() {
        let mut seen: Vec<f64> = Vec::new();
        for (i, &n) in design.instances.iter().zip(&instance_names) {
            let v = i.location.get(&a.tag).copied().unwrap_or(a.default);
            let others_default = design
                .axes
                .iter()
                .filter(|b| b.tag != a.tag)
                .all(|b| i.location.get(&b.tag).copied().unwrap_or(b.default) == b.default);
            if !others_default || seen.contains(&v) {
                continue;
            }
            seen.push(v);
            let flags = if v == a.default {
                AxisValueTableFlags::ELIDABLE_AXIS_VALUE_NAME
            } else {
                AxisValueTableFlags::empty()
            };
            values.push(AxisValue::format_1(ai as u16, flags, NameId::new(n), Fixed::from_f64(v)));
        }
    }
    let mut design_axes: Vec<AxisRecord> = design
        .axes
        .iter()
        .zip(&axis_names)
        .enumerate()
        .map(|(i, (a, &n))| {
            AxisRecord::new(
                Tag::new_checked(a.tag.as_bytes()).unwrap_or(Tag::new(b"wght")),
                NameId::new(n),
                i as u16,
            )
        })
        .collect();
    // The ital axis links this font with its roman or italic partner, so
    // apps pair them in one family even though neither varies along it.
    if !design.axes.iter().any(|a| a.tag == "ital") {
        let ai = design_axes.len() as u16;
        let italic = base.metrics.italic_angle != 0.0;
        names.push((next, "Italic".into()));
        design_axes.push(AxisRecord::new(Tag::new(b"ital"), NameId::new(next), ai));
        next += 1;
        names.push((next, if italic { "Italic" } else { "Roman" }.into()));
        values.push(if italic {
            AxisValue::format_1(ai, AxisValueTableFlags::empty(), NameId::new(next), Fixed::ONE)
        } else {
            AxisValue::format_3(
                ai,
                AxisValueTableFlags::ELIDABLE_AXIS_VALUE_NAME,
                NameId::new(next),
                Fixed::ZERO,
                Fixed::ONE,
            )
        });
    }
    let stat = Stat {
        design_axes: design_axes.into(),
        offset_to_axis_values: Some(values.into_iter().map(Into::into).collect::<Vec<_>>()).into(),
        elided_fallback_name_id: Some(NameId::new(2)),
    };

    let var = VarTables { names, fvar, gvar, avar, stat };
    let bytes = build(base, options, family, &glyphs, Some(var))?;
    Ok(VariableFont { bytes, exported, skipped, fixed })
}

/// Each brace layer's location, and the glyphs it changes there.
fn brace_items(project: &Project) -> Vec<(Vec<f64>, Items)> {
    let items =
        |p: &Project| -> Items { collect_items(p).into_iter().map(|(c, o, a)| (c, (o, a))).collect() };
    project
        .design
        .braces
        .iter()
        .filter_map(|b| {
            let loc = project.brace_location(b);
            let plain = project.instance_at_loc(loc.clone(), false).ok()?;
            let mut with = plain.clone();
            with.set_drawing(&b.of, b.contours.clone()).ok()?;
            match &b.of {
                DrawingTarget::Base(id) => with.bases.get_mut(id)?.advance_width = b.advance_width,
                DrawingTarget::Symbol(id) => with.symbols.get_mut(id)?.advance_width = b.advance_width,
                _ => return None,
            }
            with.after_edit();
            let before = items(&plain);
            let changed: Items = items(&with).into_iter().filter(|(c, v)| before.get(c) != Some(v)).collect();
            Some((loc, changed))
        })
        .collect()
}

/// Quadratic paths for the same glyph in every master, point for point, or
/// `None` when the outlines do not match.
fn lockstep(sets: &[&[Contour]]) -> Option<Vec<BezPath>> {
    let n = sets[0].len();
    if sets.iter().any(|s| s.len() != n) {
        return None;
    }
    let mut paths = vec![BezPath::new(); sets.len()];
    let p = |v: Vec2| Point::new(v.x, v.y);
    for ci in 0..n {
        let cs: Vec<&Contour> = sets.iter().map(|s| &s[ci]).collect();
        let k = cs[0].points.len();
        let same = cs.iter().all(|c| {
            c.points.len() == k
                && c.points
                    .iter()
                    .zip(&cs[0].points)
                    .all(|(a, b)| (a.kind == PointKind::OffCurve) == (b.kind == PointKind::OffCurve))
        });
        if !same {
            return None;
        }
        let start = cs[0].points.iter().position(|q| q.kind != PointKind::OffCurve)?;
        let mut current: Vec<Point> = cs.iter().map(|c| p(c.points[start].pos)).collect();
        for (path, &c) in paths.iter_mut().zip(&current) {
            path.move_to(c);
        }
        let mut handles: Vec<Vec<Point>> = vec![Vec::new(); cs.len()];
        for i in 1..=k {
            let idx = (start + i) % k;
            let kind = cs[0].points[idx].kind;
            if kind == PointKind::OffCurve {
                for (h, c) in handles.iter_mut().zip(&cs) {
                    h.push(p(c.points[idx].pos));
                }
                continue;
            }
            let ends: Vec<Point> = cs.iter().map(|c| p(c.points[idx].pos)).collect();
            match handles[0].len() {
                2 => {
                    let cubics: Vec<CubicBez> = (0..cs.len())
                        .map(|m| CubicBez::new(current[m], handles[m][0], handles[m][1], ends[m]))
                        .collect();
                    let splines = kurbo::cubics_to_quadratic_splines(&cubics, CURVE_ACCURACY)?;
                    for (path, s) in paths.iter_mut().zip(&splines) {
                        for q in s.to_quads() {
                            path.quad_to(q.p1, q.p2);
                        }
                    }
                }
                0 => {
                    // The closing segment back to the start is implied.
                    if i < k && (0..cs.len()).any(|m| ends[m] != current[m]) {
                        for (path, &e) in paths.iter_mut().zip(&ends) {
                            path.line_to(e);
                        }
                    }
                }
                _ => return None,
            }
            current = ends;
            for h in &mut handles {
                h.clear();
            }
        }
        for path in &mut paths {
            path.close_path();
        }
    }
    Some(paths)
}
