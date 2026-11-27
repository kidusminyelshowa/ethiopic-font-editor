// Path operations for the editor's point and shape tools: affine transforms,
// segments, inserting and removing points without changing the curve,
// tangent points, start points, path direction by containment, extra shapes
// and outline checks. Everything works on the UFO point model in geometry.ts
// and keeps point ids stable where it can.

import {
  clone,
  contoursBounds,
  fromNodes,
  isClockwise,
  isOn,
  rebuilt,
  reversed,
  signedArea,
  toNodes,
  type Box,
  type Contour,
  type Node,
  type Point,
  type Vec2,
} from "./geometry";

// ---------- Affine transforms ----------

/** x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function apply(m: Matrix, p: Vec2): Vec2 {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** `m` then `n`. */
export function compose(m: Matrix, n: Matrix): Matrix {
  return [
    n[0] * m[0] + n[2] * m[1],
    n[1] * m[0] + n[3] * m[1],
    n[0] * m[2] + n[2] * m[3],
    n[1] * m[2] + n[3] * m[3],
    n[0] * m[4] + n[2] * m[5] + n[4],
    n[1] * m[4] + n[3] * m[5] + n[5],
  ];
}

const about = (o: Vec2, m: Matrix): Matrix => compose(compose([1, 0, 0, 1, -o.x, -o.y], m), [1, 0, 0, 1, o.x, o.y]);

export const scaleAbout = (o: Vec2, sx: number, sy: number): Matrix => about(o, [sx, 0, 0, sy, 0, 0]);

/** Counter-clockwise, in degrees (y up). */
export function rotateAbout(o: Vec2, deg: number): Matrix {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return about(o, [c, s, -s, c, 0, 0]);
}

/** Slant: positive angles lean the top to the right, like an italic. */
export function skewAbout(o: Vec2, degX: number, degY = 0): Matrix {
  return about(o, [1, Math.tan((degY * Math.PI) / 180), Math.tan((degX * Math.PI) / 180), 1, 0, 0]);
}

export const translate = (dx: number, dy: number): Matrix => [1, 0, 0, 1, dx, dy];

/** A reflection reverses winding; flip the contour back so its direction keeps meaning outer or counter. */
export const mirrors = (m: Matrix): boolean => m[0] * m[3] - m[1] * m[2] < 0;

/** Transform the points that `pick` accepts. Handles of a picked on-curve point follow it. */
export function transformContours(
  contours: Contour[],
  m: Matrix,
  pick: (ci: number, pi: number) => boolean = () => true,
): Contour[] {
  const out = clone(contours);
  out.forEach((c, ci) => {
    const n = c.points.length;
    const moving = new Set<number>();
    c.points.forEach((p, pi) => {
      if (!pick(ci, pi)) return;
      moving.add(pi);
      if (isOn(p)) {
        for (const j of [(pi - 1 + n) % n, (pi + 1) % n]) if (!isOn(c.points[j])) moving.add(j);
      }
    });
    for (const pi of moving) c.points[pi].pos = apply(m, c.points[pi].pos);
  });
  return out;
}

/** Transform whole contours, keeping each one's direction when the transform mirrors. */
export function transformWhole(contours: Contour[], m: Matrix, which: Set<number>): Contour[] {
  const out = transformContours(contours, m, (ci) => which.has(ci));
  if (mirrors(m)) for (const ci of which) out[ci] = reversed(out[ci]);
  return out;
}

// ---------- Segments ----------

export interface Segment {
  /** Index into toNodes(c) of the start and end node. */
  from: number;
  to: number;
  /** p0..p3 for a curve, or p0, p3 for a line. */
  pts: Vec2[];
}

export function segments(c: Contour): Segment[] {
  const nodes = toNodes(c);
  const n = nodes.length;
  const out: Segment[] = [];
  // An open path has no closing segment.
  for (let k = 0; k < (c.open ? n - 1 : n); k++) {
    const a = nodes[k];
    const b = nodes[(k + 1) % n];
    out.push(a.out || b.in ? { from: k, to: (k + 1) % n, pts: [a.pos, a.out?.pos ?? a.pos, b.in?.pos ?? b.pos, b.pos] } : { from: k, to: (k + 1) % n, pts: [a.pos, b.pos] });
  }
  return out;
}

export function pointAt(pts: Vec2[], t: number): Vec2 {
  if (pts.length === 2) return { x: pts[0].x + (pts[1].x - pts[0].x) * t, y: pts[0].y + (pts[1].y - pts[0].y) * t };
  const u = 1 - t;
  const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return {
    x: a * pts[0].x + b * pts[1].x + c * pts[2].x + d * pts[3].x,
    y: a * pts[0].y + b * pts[1].y + c * pts[2].y + d * pts[3].y,
  };
}

/** The closest point of a segment to `p`: its parameter and distance. */
export function closestOnSegment(pts: Vec2[], p: Vec2): { t: number; d: number } {
  let best = { t: 0, d: Infinity };
  const steps = pts.length === 2 ? 16 : 48;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const q = pointAt(pts, t);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < best.d) best = { t, d };
  }
  // Refine by bisection around the best sample.
  let lo = Math.max(0, best.t - 1 / steps);
  let hi = Math.min(1, best.t + 1 / steps);
  for (let i = 0; i < 24; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const d1 = dist(pointAt(pts, m1), p);
    const d2 = dist(pointAt(pts, m2), p);
    if (d1 < d2) hi = m2;
    else lo = m1;
  }
  const t = (lo + hi) / 2;
  return { t, d: dist(pointAt(pts, t), p) };
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const r2 = (p: Vec2): Vec2 => ({ x: Math.round(p.x), y: Math.round(p.y) });
const maxPointId = (c: Contour) => c.points.reduce((m, p) => Math.max(m, p.id), -1);

/**
 * Add an on-curve point on segment `seg` at parameter t, without changing
 * the outline. Returns the new contour and the new point's id.
 */
export function insertPoint(c: Contour, seg: number, t: number): { contour: Contour; id: number } {
  const nodes = toNodes(c);
  const s = segments(c)[seg];
  let next = maxPointId(c) + 1;
  const id = next++;
  const a = nodes[s.from];
  const b = nodes[s.to];
  let node: Node;
  if (s.pts.length === 2) {
    node = { id, pos: r2(pointAt(s.pts, t)), smooth: false };
  } else {
    // de Casteljau.
    const [p0, p1, p2, p3] = s.pts;
    const q0 = lerp(p0, p1, t);
    const q1 = lerp(p1, p2, t);
    const q2 = lerp(p2, p3, t);
    const r0 = lerp(q0, q1, t);
    const r1 = lerp(q1, q2, t);
    const m = lerp(r0, r1, t);
    a.out = { id: a.out?.id ?? next++, pos: r2(q0) };
    b.in = { id: b.in?.id ?? next++, pos: r2(q2) };
    node = { id, pos: r2(m), smooth: true, in: { id: next++, pos: r2(r0) }, out: { id: next++, pos: r2(r1) } };
  }
  nodes.splice(s.from + 1, 0, node);
  return { contour: rebuilt(c, nodes, next), id };
}

/**
 * Remove on-curve points and refit the curve across each gap, so the outline
 * keeps its shape as well as one cubic can (Glyphs' "delete keeping shape").
 */
export function removePointsKeepingShape(c: Contour, ids: Set<number>): Contour | null {
  let cur = clone(c);
  for (const id of ids) {
    const nodes = toNodes(cur);
    if (nodes.length <= 2) return null;
    const k = nodes.findIndex((nd) => nd.id === id);
    if (k < 0) continue;
    const segs = segments(cur);
    const n = nodes.length;
    const rest = nodes.filter((_, i) => i !== k);
    // The end of an open path just goes; the path ends at its neighbour.
    if (cur.open && (k === 0 || k === n - 1)) {
      cur = rebuilt(cur, rest, maxPointId(cur) + 1);
      continue;
    }
    const before = segs[(k - 1 + n) % n];
    const after = segs[k];
    const prev = nodes[(k - 1 + n) % n];
    const nxt = nodes[(k + 1) % n];
    if (before.pts.length === 2 && after.pts.length === 2) {
      delete prev.out;
      delete nxt.in;
    } else {
      const fit = fitCubic([before.pts, after.pts], prev.pos, nxt.pos, prev.out?.pos, nxt.in?.pos);
      let free = maxPointId(cur) + 1;
      prev.out = { id: prev.out?.id ?? free++, pos: r2(fit[0]) };
      nxt.in = { id: nxt.in?.id ?? free++, pos: r2(fit[1]) };
    }
    cur = rebuilt(cur, rest, maxPointId(cur) + 1);
  }
  return cur;
}

/**
 * One cubic from p0 to p3 through the given pieces. Handle directions come
 * from the existing outer handles (or the chord to the removed point); their
 * lengths are a least-squares fit to samples of the original pieces.
 */
function fitCubic(pieces: Vec2[][], p0: Vec2, p3: Vec2, h0?: Vec2, h3?: Vec2): [Vec2, Vec2] {
  const samples: Vec2[] = [];
  for (const pts of pieces) for (let i = 0; i < 12; i++) samples.push(pointAt(pts, i / 12));
  samples.push(p3);
  // Chord-length parameters.
  const ts = [0];
  for (let i = 1; i < samples.length; i++) ts.push(ts[i - 1] + dist(samples[i], samples[i - 1]));
  const total = ts[ts.length - 1] || 1;
  const unit = (v: Vec2) => {
    const l = Math.hypot(v.x, v.y);
    return l < 1e-9 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l };
  };
  const away = (from: Vec2, cands: Vec2[]) => cands.find((q) => dist(q, from) > 1e-6) ?? from;
  const lastPiece = pieces[pieces.length - 1];
  const t0 = h0 && dist(h0, p0) > 1e-6 ? h0 : away(p0, pieces[0].slice(1));
  const t3 = h3 && dist(h3, p3) > 1e-6 ? h3 : away(p3, lastPiece.slice(0, -1).reverse());
  const dir0 = unit({ x: t0.x - p0.x, y: t0.y - p0.y });
  const dir3 = unit({ x: t3.x - p3.x, y: t3.y - p3.y });
  // P(t) = B0 p0 + B1 (p0 + α u) + B2 (p3 + β v) + B3 p3, linear in α, β.
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const t = ts[i] / total;
    const u = 1 - t;
    const B0 = u * u * u, B1 = 3 * u * u * t, B2 = 3 * u * t * t, B3 = t * t * t;
    const base = { x: (B0 + B1) * p0.x + (B2 + B3) * p3.x, y: (B0 + B1) * p0.y + (B2 + B3) * p3.y };
    const ax = { x: B1 * dir0.x, y: B1 * dir0.y };
    const bx = { x: B2 * dir3.x, y: B2 * dir3.y };
    const r = { x: samples[i].x - base.x, y: samples[i].y - base.y };
    a11 += ax.x * ax.x + ax.y * ax.y;
    a12 += ax.x * bx.x + ax.y * bx.y;
    a22 += bx.x * bx.x + bx.y * bx.y;
    b1 += ax.x * r.x + ax.y * r.y;
    b2 += bx.x * r.x + bx.y * r.y;
  }
  const det = a11 * a22 - a12 * a12;
  const chord = dist(p0, p3) / 3;
  let alpha = chord;
  let beta = chord;
  if (Math.abs(det) > 1e-9) {
    alpha = (b1 * a22 - b2 * a12) / det;
    beta = (a11 * b2 - a12 * b1) / det;
  }
  // Handles that point backwards make loops; fall back to a third of the chord.
  if (!(alpha > 0)) alpha = chord;
  if (!(beta > 0)) beta = chord;
  return [
    { x: p0.x + dir0.x * alpha, y: p0.y + dir0.y * alpha },
    { x: p3.x + dir3.x * beta, y: p3.y + dir3.y * beta },
  ];
}

/** Turn the segments between consecutive selected nodes into curves (handles at thirds) or lines. */
export function setSegmentKind(c: Contour, ids: Set<number>, to: "curve" | "line"): Contour {
  const nodes = toNodes(c);
  const n = nodes.length;
  let next = maxPointId(c) + 1;
  for (let k = 0; k < (c.open ? n - 1 : n); k++) {
    const a = nodes[k];
    const b = nodes[(k + 1) % n];
    if (!ids.has(a.id) || !ids.has(b.id) || n < 2) continue;
    if (to === "line") {
      delete a.out;
      delete b.in;
      // A smooth point next to a straight segment becomes a corner unless it keeps a handle on the other side.
    } else if (!a.out && !b.in) {
      a.out = { id: next++, pos: r2(lerp(a.pos, b.pos, 1 / 3)) };
      b.in = { id: next++, pos: r2(lerp(a.pos, b.pos, 2 / 3)) };
    }
  }
  return rebuilt(c, nodes, next);
}

/** Make `id` the contour's start point, keeping the outline and ids. */
export function setStartPoint(c: Contour, id: number): Contour {
  const nodes = toNodes(c);
  const k = nodes.findIndex((nd) => nd.id === id);
  if (k <= 0) return clone(c);
  // An open path can only start at one of its two ends.
  if (c.open) return k === nodes.length - 1 ? reversed(c) : clone(c);
  return rebuilt(c, [...nodes.slice(k), ...nodes.slice(0, k)], maxPointId(c) + 1);
}

/**
 * A tangent point: smooth between a straight segment and a curve. The
 * curve's handle is put in line with the straight segment.
 */
export function makeTangent(c: Contour, ids: Set<number>): Contour {
  const nodes = toNodes(c);
  const n = nodes.length;
  nodes.forEach((nd, k) => {
    if (!ids.has(nd.id)) return;
    const prev = nodes[(k - 1 + n) % n];
    const nxt = nodes[(k + 1) % n];
    if (c.open && (k === 0 || k === n - 1)) return;
    const lineIn = !nd.in && !prev.out;
    const lineOut = !nd.out && !nxt.in;
    if (lineIn === lineOut) return;
    const from = lineIn ? prev.pos : nxt.pos;
    const dx = nd.pos.x - from.x;
    const dy = nd.pos.y - from.y;
    const l = Math.hypot(dx, dy);
    if (l < 1e-6) return;
    const h = lineIn ? nd.out : nd.in;
    if (!h) return;
    const len = Math.max(1, Math.hypot(h.pos.x - nd.pos.x, h.pos.y - nd.pos.y));
    h.pos = r2({ x: nd.pos.x + (dx / l) * len, y: nd.pos.y + (dy / l) * len });
    nd.smooth = true;
  });
  return rebuilt(c, nodes, maxPointId(c) + 1);
}

/** Corner, smooth or tangent, for drawing and the point-type menu. */
export function pointType(c: Contour, pi: number): "corner" | "smooth" | "tangent" | "handle" {
  const p = c.points[pi];
  if (!isOn(p)) return "handle";
  if (!p.smooth) return "corner";
  const n = c.points.length;
  const prevHandle = !isOn(c.points[(pi - 1 + n) % n]);
  const nextHandle = !isOn(c.points[(pi + 1) % n]);
  return prevHandle !== nextHandle ? "tangent" : "smooth";
}

// ---------- Direction by containment ----------

/** The contour as a polygon, curves sampled. */
export function flatten(c: Contour, steps = 8): Vec2[] {
  const out: Vec2[] = [];
  for (const s of segments(c)) {
    const k = s.pts.length === 2 ? 1 : steps;
    for (let i = 0; i < k; i++) out.push(pointAt(s.pts, i / k));
  }
  return out;
}

export function insidePolygon(poly: Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** How many other contours enclose this one: 0 for an outer shape, 1 for a counter, and so on. */
export function depths(contours: Contour[]): number[] {
  const polys = contours.map((c) => flatten(c));
  return contours.map((c, i) => {
    const probe = c.points.find(isOn)?.pos;
    if (!probe) return 0;
    let d = 0;
    polys.forEach((poly, j) => {
      if (j !== i && !contours[j].open && poly.length > 2 && Math.abs(signedArea(contours[j])) > Math.abs(signedArea(c)) && insidePolygon(poly, probe)) d++;
    });
    return d;
  });
}

/** Whether each contour runs the way its depth wants: outer shapes counter-clockwise, counters clockwise. */
export function directionOk(contours: Contour[]): boolean[] {
  const d = depths(contours);
  // An open path has no direction to get wrong.
  return contours.map((c, i) => !!c.open || isClockwise(c) === (d[i] % 2 === 1));
}

/** Reverse every contour that runs the wrong way for its depth. */
export function correctDirections(contours: Contour[]): Contour[] {
  const ok = directionOk(contours);
  return contours.map((c, i) => (ok[i] ? clone(c) : reversed(c)));
}

// ---------- Shapes ----------

/** A rectangle with round corners (radius clamped to half the shorter side), counter-clockwise. */
export function roundedRectContour(id: number, a: Vec2, b: Vec2, radius: number): Contour {
  const x0 = Math.round(Math.min(a.x, b.x));
  const x1 = Math.round(Math.max(a.x, b.x));
  const y0 = Math.round(Math.min(a.y, b.y));
  const y1 = Math.round(Math.max(a.y, b.y));
  const r = Math.max(0, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2));
  if (r < 1) {
    const corners = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    return { id, points: corners.map((pos, i) => ({ id: i, pos, kind: "line" as const })), part: null };
  }
  const k = Math.round(r * 0.5523);
  let i = 0;
  const nd = (x: number, y: number, inn?: Vec2, out?: Vec2): Node => ({
    id: i++,
    pos: { x, y },
    smooth: false,
    ...(inn ? { in: { id: i++, pos: inn } } : {}),
    ...(out ? { out: { id: i++, pos: out } } : {}),
  });
  const R = Math.round(r);
  // Counter-clockwise from the bottom-left corner's bottom end.
  const nodes = [
    nd(x0 + R, y0, { x: x0 + R - k, y: y0 }),
    nd(x1 - R, y0, undefined, { x: x1 - R + k, y: y0 }),
    nd(x1, y0 + R, { x: x1, y: y0 + R - k }),
    nd(x1, y1 - R, undefined, { x: x1, y: y1 - R + k }),
    nd(x1 - R, y1, { x: x1 - R + k, y: y1 }),
    nd(x0 + R, y1, undefined, { x: x0 + R - k, y: y1 }),
    nd(x0, y1 - R, { x: x0, y: y1 - R + k }),
    nd(x0, y0 + R, undefined, { x: x0, y: y0 + R - k }),
  ];
  return fromNodes(nodes, id, null, i);
}

/** A regular polygon (or star, with an inner ratio) inscribed in the box a-b, counter-clockwise, point up. */
export function polygonContour(id: number, a: Vec2, b: Vec2, sides: number, innerRatio?: number): Contour {
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const rx = Math.abs(b.x - a.x) / 2;
  const ry = Math.abs(b.y - a.y) / 2;
  const n = Math.max(3, Math.round(sides));
  const star = innerRatio !== undefined;
  const count = star ? n * 2 : n;
  const pts: Point[] = [];
  for (let i = 0; i < count; i++) {
    const ang = Math.PI / 2 + (i * 2 * Math.PI) / count;
    const f = star && i % 2 === 1 ? innerRatio! : 1;
    pts.push({ id: i, pos: { x: Math.round(cx + Math.cos(ang) * rx * f), y: Math.round(cy + Math.sin(ang) * ry * f) }, kind: "line" });
  }
  return { id, points: pts, part: null };
}

// ---------- Outline checks ----------

export type IssueKind = "open" | "direction" | "duplicate" | "tiny" | "almost-straight" | "kink" | "extremes";

export interface OutlineIssue {
  kind: IssueKind;
  contour: number;
  /** Where to draw the marker. */
  at: Vec2;
  /** Whether "fix" can repair it safely. */
  fixable: boolean;
}

export const ISSUE_LABEL: Record<IssueKind, string> = {
  open: "Open path: not exported until it is closed",
  direction: "Wrong path direction",
  duplicate: "Two points on top of each other",
  tiny: "Very short segment",
  "almost-straight": "Line just off horizontal or vertical",
  kink: "Smooth point with a kink",
  extremes: "Curve missing a point at its extreme",
};

/** Parameters in (0, 1) where a cubic reaches a horizontal or vertical extreme. */
export function extremeTs(pts: Vec2[]): number[] {
  if (pts.length !== 4) return [];
  const out: number[] = [];
  for (const axis of ["x", "y"] as const) {
    const [p0, p1, p2, p3] = pts.map((p) => p[axis]);
    // Derivative coefficients: a t² + b t + c.
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const b = 2 * (p0 - 2 * p1 + p2);
    const c = p1 - p0;
    const roots: number[] = [];
    if (Math.abs(a) < 1e-9) {
      if (Math.abs(b) > 1e-9) roots.push(-c / b);
    } else {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const s = Math.sqrt(disc);
        roots.push((-b + s) / (2 * a), (-b - s) / (2 * a));
      }
    }
    for (const t of roots) {
      if (t <= 0.02 || t >= 0.98) continue;
      // Only an extreme that sticks out past both ends by a unit or more counts.
      const v = pointAt(pts, t)[axis];
      if (Math.min(Math.abs(v - p0), Math.abs(v - p3)) >= 1) out.push(t);
    }
  }
  return out.sort((x, y) => x - y);
}

export function outlineIssues(contours: Contour[]): OutlineIssue[] {
  const out: OutlineIssue[] = [];
  const ok = directionOk(contours);
  contours.forEach((c, ci) => {
    const first = c.points.find(isOn);
    if (!first) return;
    if (c.open) out.push({ kind: "open", contour: ci, at: first.pos, fixable: false });
    if (!ok[ci]) out.push({ kind: "direction", contour: ci, at: first.pos, fixable: true });
    const nodes = toNodes(c);
    const segs = segments(c);
    segs.forEach((s) => {
      const a = s.pts[0];
      const b = s.pts[s.pts.length - 1];
      const len = dist(a, b);
      if (len < 0.5 && s.pts.length === 2) out.push({ kind: "duplicate", contour: ci, at: a, fixable: true });
      else if (len < 4 && s.pts.length === 2) out.push({ kind: "tiny", contour: ci, at: a, fixable: false });
      if (s.pts.length === 2 && len >= 4) {
        const dx = Math.abs(b.x - a.x);
        const dy = Math.abs(b.y - a.y);
        if ((dx > 0 && dx <= 2 && dy > 20) || (dy > 0 && dy <= 2 && dx > 20)) out.push({ kind: "almost-straight", contour: ci, at: lerp(a, b, 0.5), fixable: true });
      }
      if (extremeTs(s.pts).length) out.push({ kind: "extremes", contour: ci, at: pointAt(s.pts, extremeTs(s.pts)[0]), fixable: true });
    });
    for (const nd of nodes) {
      if (!nd.smooth || !nd.in || !nd.out) continue;
      const ix = nd.pos.x - nd.in.pos.x;
      const iy = nd.pos.y - nd.in.pos.y;
      const ox = nd.out.pos.x - nd.pos.x;
      const oy = nd.out.pos.y - nd.pos.y;
      const il = Math.hypot(ix, iy);
      const ol = Math.hypot(ox, oy);
      if (il < 1 || ol < 1) continue;
      const cross = (ix * oy - iy * ox) / (il * ol);
      // Over about 1.5° counts; rounding to whole units can leave a little less.
      if (Math.abs(cross) > 0.026) out.push({ kind: "kink", contour: ci, at: nd.pos, fixable: true });
    }
  });
  return out;
}

/** Split every curve at its extremes. */
export function addExtremes(c: Contour): Contour {
  let cur = clone(c);
  for (let guard = 0; guard < 64; guard++) {
    const segs = segments(cur);
    const k = segs.findIndex((s) => extremeTs(s.pts).length);
    if (k < 0) break;
    const t = extremeTs(segs[k].pts)[0];
    const res = insertPoint(cur, k, t);
    // Snap the new point's handles flat so it is a true extreme.
    const nodes = toNodes(res.contour);
    const nd = nodes.find((x) => x.id === res.id)!;
    if (nd.in && nd.out) {
      const horizontal = Math.abs(nd.out.pos.y - nd.in.pos.y) < Math.abs(nd.out.pos.x - nd.in.pos.x);
      if (horizontal) {
        nd.in.pos.y = nd.pos.y;
        nd.out.pos.y = nd.pos.y;
      } else {
        nd.in.pos.x = nd.pos.x;
        nd.out.pos.x = nd.pos.x;
      }
    }
    cur = rebuilt(res.contour, nodes, maxPointId(res.contour) + 1);
  }
  return cur;
}

/** Repair what can be repaired safely: direction, duplicates, near-straight lines, kinks, extremes. */
export function fixIssues(contours: Contour[]): Contour[] {
  let out = correctDirections(contours);
  out = out.map((c) => {
    const nodes = toNodes(c);
    // Duplicate points: drop the second of two on-curve points in the same place.
    const kept: Node[] = [];
    for (const nd of nodes) {
      const prev = kept[kept.length - 1];
      if (prev && dist(prev.pos, nd.pos) < 0.5 && !prev.out && !nd.in) {
        if (nd.out) prev.out = nd.out;
        continue;
      }
      kept.push(nd);
    }
    // Near-straight lines become straight.
    for (let k = 0; k < kept.length; k++) {
      const a = kept[k];
      const b = kept[(k + 1) % kept.length];
      if (a.out || b.in) continue;
      const dx = Math.abs(b.pos.x - a.pos.x);
      const dy = Math.abs(b.pos.y - a.pos.y);
      if (dx > 0 && dx <= 2 && dy > 20) b.pos.x = a.pos.x;
      else if (dy > 0 && dy <= 2 && dx > 20) b.pos.y = a.pos.y;
    }
    // Kinks: put both handles on their average tangent.
    for (const nd of kept) {
      if (!nd.smooth || !nd.in || !nd.out) continue;
      const ix = nd.pos.x - nd.in.pos.x;
      const iy = nd.pos.y - nd.in.pos.y;
      const ox = nd.out.pos.x - nd.pos.x;
      const oy = nd.out.pos.y - nd.pos.y;
      const il = Math.hypot(ix, iy);
      const ol = Math.hypot(ox, oy);
      if (il < 1 || ol < 1) continue;
      let tx = ix / il + ox / ol;
      let ty = iy / il + oy / ol;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      nd.in.pos = { x: nd.pos.x - tx * il, y: nd.pos.y - ty * il };
      nd.out.pos = { x: nd.pos.x + tx * ol, y: nd.pos.y + ty * ol };
    }
    return kept.length >= 2 ? addExtremes(rebuilt(c, kept, maxPointId(c) + 1)) : c;
  });
  return out;
}

// ---------- Selection helpers ----------

/** The bounding box of the selected points (and, for whole contours, their handles). */
export function selectionBox(contours: Contour[], keys: Set<string>): Box | null {
  const pts: Vec2[] = [];
  for (const k of keys) {
    const [ci, pi] = k.split(":").map(Number);
    const p = contours[ci]?.points[pi];
    if (p) pts.push(p.pos);
  }
  if (!pts.length) return null;
  return contoursBounds([{ id: -1, points: pts.map((pos, i) => ({ id: i, pos, kind: "line" as const })) }]);
}

/** Evaluate a number field: plain numbers or simple arithmetic such as 120/6 or 500+20. */
export function evalNumber(text: string): number | null {
  const s = text.trim().replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/,/g, ".");
  if (!s || !/^[\d\s.()+\-*\/]+$/.test(s)) return null;
  // Recursive descent: expr = term (('+'|'-') term)*, term = factor (('*'|'/') factor)*.
  let i = 0;
  const peek = () => s[i];
  const skip = () => {
    while (s[i] === " ") i++;
  };
  const factor = (): number => {
    skip();
    if (peek() === "(") {
      i++;
      const v = expr();
      skip();
      if (peek() !== ")") throw new Error("paren");
      i++;
      return v;
    }
    if (peek() === "-") {
      i++;
      return -factor();
    }
    if (peek() === "+") {
      i++;
      return factor();
    }
    const m = /^\d*\.?\d+|^\d+\.?/.exec(s.slice(i));
    if (!m) throw new Error("num");
    i += m[0].length;
    return Number(m[0]);
  };
  const term = (): number => {
    let v = factor();
    for (;;) {
      skip();
      if (peek() === "*") {
        i++;
        v *= factor();
      } else if (peek() === "/") {
        i++;
        v /= factor();
      } else return v;
    }
  };
  const expr = (): number => {
    let v = term();
    for (;;) {
      skip();
      if (peek() === "+") {
        i++;
        v += term();
      } else if (peek() === "-") {
        i++;
        v -= term();
      } else return v;
    }
  };
  try {
    const v = expr();
    skip();
    return i === s.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
