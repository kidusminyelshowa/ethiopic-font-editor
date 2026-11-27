//! Saving the project as UFO 3, and a designspace with one UFO per master,
//! for other font editors and build tools.

use std::fmt::Write as _;
use std::path::Path;

use fidel_core::geometry::{Contour, PointKind};
use fidel_core::Project;

use super::{collect_items, glyph_name};

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn plist(body: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n{body}</plist>\n"
    )
}

fn num(v: f64) -> String {
    let r = (v * 1000.0).round() / 1000.0;
    if r.fract() == 0.0 {
        format!("{}", r as i64)
    } else {
        format!("{r}")
    }
}

/// A file name for a glyph that differs from others even on systems that
/// ignore letter case: capitals get an underscore after them.
fn file_name(name: &str) -> String {
    let mut s = String::new();
    for c in name.chars() {
        s.push(c);
        if c.is_ascii_uppercase() {
            s.push('_');
        }
    }
    format!("{s}.glif")
}

fn glif(
    name: &str,
    unicode: Option<char>,
    advance: f64,
    contours: &[Contour],
    anchors: &[(String, f64, f64)],
) -> String {
    let mut t =
        format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<glyph name=\"{}\" format=\"2\">\n", esc(name));
    let _ = writeln!(t, "  <advance width=\"{}\"/>", num(advance));
    if let Some(c) = unicode {
        let _ = writeln!(t, "  <unicode hex=\"{:04X}\"/>", c as u32);
    }
    for (n, x, y) in anchors {
        let _ = writeln!(t, "  <anchor name=\"{}\" x=\"{}\" y=\"{}\"/>", esc(n), num(*x), num(*y));
    }
    t.push_str("  <outline>\n");
    for c in contours.iter().filter(|c| c.points.len() >= 2) {
        t.push_str("    <contour>\n");
        for (i, p) in c.points.iter().enumerate() {
            let kind = match p.kind {
                _ if c.open && i == 0 => " type=\"move\"",
                PointKind::Line => " type=\"line\"",
                PointKind::Curve => " type=\"curve\"",
                PointKind::OffCurve => "",
            };
            let smooth = if p.smooth && p.kind != PointKind::OffCurve { " smooth=\"yes\"" } else { "" };
            let _ = writeln!(t, "      <point x=\"{}\" y=\"{}\"{kind}{smooth}/>", num(p.pos.x), num(p.pos.y));
        }
        t.push_str("    </contour>\n");
    }
    t.push_str("  </outline>\n</glyph>\n");
    t
}

/// The feature code without the kern feature, which kerning.plist holds.
fn features_without_kern(text: &str) -> String {
    match (text.find("feature kern {"), text.find("} kern;")) {
        (Some(a), Some(b)) if b > a => format!("{}{}", &text[..a], &text[b + "} kern;".len()..]),
        _ => text.to_string(),
    }
}

/// Write the master being edited as a UFO folder at `dir`.
pub fn write_ufo(p: &Project, dir: &Path, family: &str, style: &str) -> Result<usize, String> {
    let e = |e: std::io::Error| e.to_string();
    if dir.exists() {
        std::fs::remove_dir_all(dir).map_err(e)?;
    }
    std::fs::create_dir_all(dir.join("glyphs")).map_err(e)?;
    let w = |f: &str, s: String| std::fs::write(dir.join(f), s).map_err(|e| e.to_string());
    let m = &p.metrics;
    w("metainfo.plist", plist("<dict>\n  <key>creator</key><string>Hohe</string>\n  <key>formatVersion</key><integer>3</integer>\n</dict>\n"))?;
    w(
        "fontinfo.plist",
        plist(&format!(
            "<dict>\n  <key>familyName</key><string>{}</string>\n  <key>styleName</key><string>{}</string>\n  <key>unitsPerEm</key><integer>{}</integer>\n  <key>ascender</key><integer>{}</integer>\n  <key>descender</key><integer>{}</integer>\n  <key>italicAngle</key><real>{}</real>\n</dict>\n",
            esc(family),
            esc(style),
            m.units_per_em,
            (f64::from(m.units_per_em) * 0.8).round(),
            -(f64::from(m.units_per_em) * 0.2).round(),
            -m.italic_angle
        )),
    )?;
    w(
        "layercontents.plist",
        plist("<array>\n  <array><string>public.default</string><string>glyphs</string></array>\n</array>\n"),
    )?;

    let mut contents = String::from("<dict>\n");
    let mut order = String::from("<dict>\n  <key>public.glyphOrder</key>\n  <array>\n");
    let mut add = |name: &str, text: String| -> Result<(), String> {
        let file = file_name(name);
        std::fs::write(dir.join("glyphs").join(&file), text).map_err(|e| e.to_string())?;
        let _ = writeln!(contents, "  <key>{}</key><string>{}</string>", esc(name), esc(&file));
        let _ = writeln!(order, "    <string>{}</string>", esc(name));
        Ok(())
    };
    let mut count = 0;
    let mut chars = Vec::new();
    for (c, outline, advance) in collect_items(p) {
        let anchors: Vec<(String, f64, f64)> =
            p.glyph_anchors(c).into_iter().map(|(n, v)| (n, v.x, v.y)).collect();
        let name = glyph_name(c);
        add(&name, glif(&name, Some(c), advance, &outline, &anchors))?;
        chars.push(c);
        count += 1;
    }
    for a in p.alternates.values().filter(|a| chars.contains(&a.of)) {
        let anchors: Vec<(String, f64, f64)> = a.anchors.iter().map(|(n, v)| (n.clone(), v.x, v.y)).collect();
        add(&a.glyph_name(), glif(&a.glyph_name(), None, a.advance_width, &a.contours, &anchors))?;
        count += 1;
    }
    contents.push_str("</dict>\n");
    order.push_str("  </array>\n</dict>\n");
    std::fs::write(dir.join("glyphs/contents.plist"), plist(&contents)).map_err(e)?;
    w("lib.plist", plist(&order))?;

    // Kerning, every pair spelled out glyph by glyph.
    let (glyph_pairs, class_pairs) = p.kerning.flatten();
    let mut rows: std::collections::BTreeMap<char, Vec<(char, i32)>> = Default::default();
    let mut put = |l: char, r: char, v: i32| {
        if chars.contains(&l) && chars.contains(&r) {
            let row = rows.entry(l).or_default();
            if !row.iter().any(|x| x.0 == r) {
                row.push((r, v));
            }
        }
    };
    for (l, r, v) in glyph_pairs {
        put(l, r, v);
    }
    for (ls, rs, v) in class_pairs {
        for &l in ls {
            for &r in rs {
                put(l, r, v);
            }
        }
    }
    if !rows.is_empty() {
        let mut k = String::from("<dict>\n");
        for (l, row) in rows {
            let _ = writeln!(k, "  <key>{}</key>\n  <dict>", glyph_name(l));
            for (r, v) in row {
                let _ = writeln!(k, "    <key>{}</key><integer>{v}</integer>", glyph_name(r));
            }
            k.push_str("  </dict>\n");
        }
        k.push_str("</dict>\n");
        w("kerning.plist", plist(&k))?;
    }
    let has = |c: char| chars.contains(&c);
    w("features.fea", features_without_kern(&p.feature_source(&has).text))?;
    Ok(count)
}

/// Write every master as a UFO beside a designspace at `path`; with one
/// master, just the UFO. Returns the files written.
pub fn write_designspace(p: &Project, path: &Path, family: &str) -> Result<Vec<String>, String> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Font");
    let d = &p.design;
    if d.masters.len() < 2 {
        let ufo = dir.join(format!("{stem}.ufo"));
        write_ufo(p, &ufo, family, &p.info.style_name)?;
        return Ok(vec![ufo.display().to_string()]);
    }
    let mut out = Vec::new();
    let mut xml =
        String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<designspace format=\"5.0\">\n  <axes>\n");
    for a in &d.axes {
        let _ = writeln!(
            xml,
            "    <axis tag=\"{}\" name=\"{}\" minimum=\"{}\" default=\"{}\" maximum=\"{}\"/>",
            esc(&a.tag),
            esc(&a.name),
            num(a.min),
            num(a.default),
            num(a.max)
        );
    }
    xml.push_str("  </axes>\n  <sources>\n");
    for (i, m) in d.masters.iter().enumerate() {
        let name = format!("{stem}-{}.ufo", m.name.replace(['/', '\\', ' '], ""));
        let mp = p.master_project(i);
        write_ufo(&mp, &dir.join(&name), family, &m.name)?;
        out.push(dir.join(&name).display().to_string());
        let _ = writeln!(
            xml,
            "    <source filename=\"{}\" name=\"{}\" familyname=\"{}\" stylename=\"{}\">\n      <location>",
            esc(&name),
            esc(&m.name),
            esc(family),
            esc(&m.name)
        );
        for a in &d.axes {
            let v = m.location.get(&a.tag).copied().unwrap_or_else(|| a.to_design(a.default));
            let _ = writeln!(xml, "        <dimension name=\"{}\" xvalue=\"{}\"/>", esc(&a.name), num(v));
        }
        xml.push_str("      </location>\n    </source>\n");
    }
    xml.push_str("  </sources>\n  <instances>\n");
    for inst in &d.instances {
        let _ = writeln!(
            xml,
            "    <instance name=\"{}\" familyname=\"{}\" stylename=\"{}\">\n      <location>",
            esc(&inst.name),
            esc(family),
            esc(&inst.name)
        );
        for a in &d.axes {
            let v = a.to_design(inst.location.get(&a.tag).copied().unwrap_or(a.default));
            let _ = writeln!(xml, "        <dimension name=\"{}\" xvalue=\"{}\"/>", esc(&a.name), num(v));
        }
        xml.push_str("      </location>\n    </instance>\n");
    }
    xml.push_str("  </instances>\n</designspace>\n");
    std::fs::write(path, xml).map_err(|e| e.to_string())?;
    out.insert(0, path.display().to_string());
    Ok(out)
}
