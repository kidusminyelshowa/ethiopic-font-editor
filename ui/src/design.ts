// The design space on the UI side: axis presets, names for new masters and
// instances, and the axis map as text.

import type { Axis, DesignData, InstanceInfo, MasterInfo } from "./api";

/** Registered axes, with their usual ranges. */
export const AXIS_PRESETS: Axis[] = [
  { tag: "wght", name: "Weight", min: 100, default: 400, max: 900 },
  { tag: "wdth", name: "Width", min: 75, default: 100, max: 125 },
  { tag: "opsz", name: "Optical size", min: 8, default: 12, max: 72 },
  { tag: "slnt", name: "Slant", min: -12, default: 0, max: 0 },
  { tag: "ital", name: "Italic", min: 0, default: 0, max: 1 },
];

/** The next axis to add: the first preset the project lacks, or a custom one. */
export function nextAxis(axes: Axis[]): Axis {
  const have = new Set(axes.map((a) => a.tag));
  const preset = AXIS_PRESETS.find((p) => !have.has(p.tag));
  if (preset) return { ...preset };
  let n = 1;
  while (have.has(`XX${String(n).padStart(2, "0")}`)) n++;
  return { tag: `XX${String(n).padStart(2, "0")}`, name: `Axis ${n}`, min: 0, default: 0, max: 100 };
}

const WEIGHTS: [number, string][] = [
  [100, "Thin"],
  [200, "ExtraLight"],
  [300, "Light"],
  [400, "Regular"],
  [500, "Medium"],
  [600, "SemiBold"],
  [700, "Bold"],
  [800, "ExtraBold"],
  [900, "Black"],
];
const WIDTHS: [number, string][] = [
  [50, "UltraCondensed"],
  [62.5, "ExtraCondensed"],
  [75, "Condensed"],
  [87.5, "SemiCondensed"],
  [100, ""],
  [112.5, "SemiExpanded"],
  [125, "Expanded"],
  [150, "ExtraExpanded"],
  [200, "UltraExpanded"],
];

function nearest(table: [number, string][], v: number): string {
  let best = table[0];
  for (const t of table) if (Math.abs(t[0] - v) < Math.abs(best[0] - v)) best = t;
  return best[1];
}

/** A style name for a location: "Bold", "Condensed Light", "Regular". */
export function styleName(axes: Axis[], loc: Record<string, number>): string {
  const parts: string[] = [];
  for (const a of axes) {
    const v = loc[a.tag] ?? a.default;
    if (a.tag === "wdth") {
      const w = nearest(WIDTHS, v);
      if (w) parts.unshift(w);
    } else if (a.tag === "wght") {
      const w = nearest(WEIGHTS, v);
      if (w !== "Regular") parts.push(w);
    } else if ((a.tag === "ital" && v >= 0.5) || (a.tag === "slnt" && v !== 0)) {
      parts.push("Italic");
    } else if (v !== a.default) {
      parts.push(`${a.name} ${Math.round(v * 100) / 100}`);
    }
  }
  return parts.join(" ") || "Regular";
}

/** User units to design units through an axis map, as the core does. */
export function toDesign(a: Axis, user: number): number {
  const m = a.map ?? [];
  if (!m.length) return user;
  if (user <= m[0][0]) return m[0][1] + (user - m[0][0]);
  for (let i = 1; i < m.length; i++) {
    const [x0, y0] = m[i - 1];
    const [x1, y1] = m[i];
    if (user <= x1) return x1 === x0 ? y1 : y0 + ((user - x0) * (y1 - y0)) / (x1 - x0);
  }
  const [xl, yl] = m[m.length - 1];
  return yl + (user - xl);
}

/** Design units back to user units (the map's inverse), for showing masters on a slider. */
export function toUser(a: Axis, design: number): number {
  const m = a.map ?? [];
  if (!m.length) return design;
  return toDesign({ ...a, map: m.map(([u, d]) => [d, u] as [number, number]).sort((x, y) => x[0] - y[0]) }, design);
}

/** A location for a new master: the axis end no master is at yet. */
export function nextMasterLocation(d: DesignData): Record<string, number> {
  const taken = (loc: Record<string, number>) =>
    d.masters.some((m) => d.axes.every((a) => (m.location[a.tag] ?? toDesign(a, a.default)) === (loc[a.tag] ?? toDesign(a, a.default))));
  const base: Record<string, number> = Object.fromEntries(d.axes.map((a) => [a.tag, toDesign(a, a.default)]));
  for (const a of d.axes) {
    for (const end of [a.max, a.min]) {
      if (end === a.default) continue;
      const loc = { ...base, [a.tag]: toDesign(a, end) };
      if (!taken(loc) || !d.masters.length) return loc;
    }
  }
  // Every axis end is taken: the far corner.
  return Object.fromEntries(d.axes.map((a) => [a.tag, toDesign(a, a.max)]));
}

/** One instance per master, in user units, named for where it sits. */
export function instancesFromMasters(d: DesignData): InstanceInfo[] {
  const out: InstanceInfo[] = [];
  for (const m of d.masters) {
    const loc: Record<string, number> = Object.fromEntries(d.axes.map((a) => [a.tag, toUser(a, m.location[a.tag] ?? toDesign(a, a.default))]));
    const name = styleName(d.axes, loc);
    if (!out.some((i) => i.name === name)) out.push({ name, location: loc, export: true });
  }
  return out;
}

/** "100>100, 400>380" to map pairs, sorted; null when the text is not a map. */
export function parseMap(text: string): [number, number][] | null {
  const t = text.trim();
  if (!t) return [];
  const pairs: [number, number][] = [];
  for (const part of t.split(/[,;\n]+/)) {
    const m = part.trim().match(/^(-?\d+(?:\.\d+)?)\s*(?:>|=|:|→)\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    pairs.push([Number(m[1]), Number(m[2])]);
  }
  return pairs.sort((a, b) => a[0] - b[0]);
}

export function formatMap(map: [number, number][] | undefined): string {
  return (map ?? []).map(([u, d]) => `${u}>${d}`).join(", ");
}

/** The master's name, or where it sits. */
export function masterLabel(d: DesignData, m: MasterInfo): string {
  return m.name || styleName(d.axes, m.location);
}
