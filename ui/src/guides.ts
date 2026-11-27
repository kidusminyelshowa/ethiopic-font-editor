// Guides, rulers and the measuring line: the geometry behind them, kept
// apart from the editor so it can be tested on its own.

import type { Contour, Vec2 } from "./geometry";
import { segments } from "./pathops";

export interface Guide {
  id: number;
  x: number;
  y: number;
  /** Degrees counter-clockwise from horizontal: 0 is horizontal, 90 vertical. */
  angle: number;
  name?: string;
  locked?: boolean;
  color?: string | null;
}

/** Unit direction of a guide, in font units (y up). */
export function guideDir(g: Guide): Vec2 {
  const a = (g.angle * Math.PI) / 180;
  return { x: Math.cos(a), y: Math.sin(a) };
}

/** Distance from a point to a guide's line, in font units. */
export function distanceToGuide(g: Guide, p: Vec2): number {
  const d = guideDir(g);
  return Math.abs(d.x * (p.y - g.y) - d.y * (p.x - g.x));
}

/** The point on a guide closest to `p`. */
export function projectOnGuide(g: Guide, p: Vec2): Vec2 {
  const d = guideDir(g);
  const t = (p.x - g.x) * d.x + (p.y - g.y) * d.y;
  return { x: g.x + t * d.x, y: g.y + t * d.y };
}

export const isHorizontal = (g: Guide) => Math.abs(Math.sin((g.angle * Math.PI) / 180)) < 1e-9;
export const isVertical = (g: Guide) => Math.abs(Math.cos((g.angle * Math.PI) / 180)) < 1e-9;

/**
 * The part of a line through `p` along `d` that lies inside the rectangle
 * [0, w] × [0, h] (screen space), or null when it misses it.
 */
export function clipLine(p: Vec2, d: Vec2, w: number, h: number): [Vec2, Vec2] | null {
  let lo = -Infinity;
  let hi = Infinity;
  for (const [pv, dv, max] of [
    [p.x, d.x, w],
    [p.y, d.y, h],
  ] as const) {
    if (Math.abs(dv) < 1e-12) {
      if (pv < 0 || pv > max) return null;
      continue;
    }
    const a = (0 - pv) / dv;
    const b = (max - pv) / dv;
    lo = Math.max(lo, Math.min(a, b));
    hi = Math.min(hi, Math.max(a, b));
  }
  if (lo > hi) return null;
  return [
    { x: p.x + lo * d.x, y: p.y + lo * d.y },
    { x: p.x + hi * d.x, y: p.y + hi * d.y },
  ];
}

/**
 * Ruler marks between `from` and `to` (font units) at a zoom of `scale`
 * pixels per unit: labelled major marks at least `minGap` pixels apart, and
 * minor ones between them.
 */
export function rulerTicks(from: number, to: number, scale: number, minGap = 60): { major: number[]; minor: number[]; step: number } {
  const raw = minGap / Math.max(scale, 1e-9);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const sub = step / (String(step / pow).startsWith("2") ? 4 : 5);
  const major: number[] = [];
  const minor: number[] = [];
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  for (let v = Math.ceil(lo / sub) * sub; v <= hi; v += sub) {
    const r = Math.round(v / sub) * sub;
    const onMajor = Math.abs(r / step - Math.round(r / step)) < 1e-6;
    (onMajor ? major : minor).push(Number(r.toFixed(6)));
  }
  return { major, minor, step };
}

export interface Crossing {
  at: Vec2;
  /** Position along the measuring line, 0 at its start and 1 at its end. */
  t: number;
}

/**
 * Where the line from `a` to `b` crosses the contours, in order along it.
 * Curves are followed closely enough for stem and counter widths to read
 * true to a tenth of a unit.
 */
export function crossings(contours: Contour[], a: Vec2, b: Vec2): Crossing[] {
  const out: Crossing[] = [];
  const d = { x: b.x - a.x, y: b.y - a.y };
  const len2 = d.x * d.x + d.y * d.y;
  if (len2 < 1e-12) return out;
  const hitSeg = (p: Vec2, q: Vec2): { t: number; u: number } | null => {
    const e = { x: q.x - p.x, y: q.y - p.y };
    const den = d.x * e.y - d.y * e.x;
    if (Math.abs(den) < 1e-12) return null;
    const w = { x: p.x - a.x, y: p.y - a.y };
    const t = (w.x * e.y - w.y * e.x) / den;
    const u = (w.x * d.y - w.y * d.x) / den;
    if (t < 0 || t > 1 || u < 0 || u >= 1) return null;
    return { t, u };
  };
  for (const c of contours) {
    if (c.hidden) continue;
    for (const s of segments(c)) {
      if (s.pts.length === 2) {
        const h = hitSeg(s.pts[0], s.pts[1]);
        if (h) out.push({ t: h.t, at: { x: a.x + h.t * d.x, y: a.y + h.t * d.y } });
        continue;
      }
      const N = 64;
      let prev = s.pts[0];
      for (let i = 1; i <= N; i++) {
        const cur = cubicAt(s.pts, i / N);
        const h = hitSeg(prev, cur);
        if (h) {
          // Narrow it down on the curve itself.
          let lo = (i - 1) / N;
          let hi = i / N;
          const side = (p: Vec2) => d.x * (p.y - a.y) - d.y * (p.x - a.x);
          const sLo = Math.sign(side(cubicAt(s.pts, lo)));
          for (let k = 0; k < 30; k++) {
            const mid = (lo + hi) / 2;
            if (Math.sign(side(cubicAt(s.pts, mid))) === sLo) lo = mid;
            else hi = mid;
          }
          const p = cubicAt(s.pts, (lo + hi) / 2);
          const t = ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / len2;
          if (t >= 0 && t <= 1) out.push({ t, at: p });
        }
        prev = cur;
      }
    }
  }
  out.sort((x, y) => x.t - y.t);
  // The same crossing found from two touching segments counts once.
  return out.filter((c, i) => i === 0 || Math.hypot(c.at.x - out[i - 1].at.x, c.at.y - out[i - 1].at.y) > 1e-6);
}

function cubicAt(p: Vec2[], t: number): Vec2 {
  const u = 1 - t;
  return {
    x: u * u * u * p[0].x + 3 * u * u * t * p[1].x + 3 * u * t * t * p[2].x + t * t * t * p[3].x,
    y: u * u * u * p[0].y + 3 * u * u * t * p[1].y + 3 * u * t * t * p[2].y + t * t * t * p[3].y,
  };
}

/** A number for a label: whole when it is, one decimal otherwise. */
export function fmt(v: number): string {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
