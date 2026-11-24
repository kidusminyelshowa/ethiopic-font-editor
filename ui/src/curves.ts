// Curve tools at the level of Glyphs and FontLab: open, close, break and join
// paths; Tunni lines; harmonize; curvature combs; power nudge; automatic
// handles; and fitting freehand strokes to curves. Pure functions on contours,
// so the editor only wires them up.

import { clone, fromNodes, neighbour, rebuilt, toNodes, type Contour, type Node, type Vec2 } from "./geometry";

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const len = (a: Vec2) => Math.hypot(a.x, a.y);
const dist = (a: Vec2, b: Vec2) => len(sub(a, b));
const unit = (a: Vec2): Vec2 => {
  const l = len(a);
  return l < 1e-9 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};
const r2 = (p: Vec2): Vec2 => ({ x: Math.round(p.x), y: Math.round(p.y) });
const maxPointId = (c: Contour) => c.points.reduce((m, p) => Math.max(m, p.id), -1);

// ---------- Open, close, break, join ----------

/** Close an open path with a straight segment from its last point to its first. */
export function closePath(c: Contour): Contour {
  if (!c.open) return clone(c);
  const nodes = toNodes(c);
  const out = fromNodes(nodes, c.id, c.part, maxPointId(c) + 1, false);
  if (c.name) out.name = c.name;
  // Two ends on top of each other become one point.
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (nodes.length > 2 && dist(first.pos, last.pos) < 0.5) {
    const merged = toNodes(out);
    const end = merged.pop()!;
    merged[0].in = end.in;
    return rebuilt({ ...out, open: false }, merged, maxPointId(out) + 1);
  }
  return out;
}

/**
 * Cut a path at an on-curve point. A closed path opens there, starting and
 * ending on that spot; an open path splits in two. Returns the new contours
 * (the first keeps the contour's id; the second takes `freeId`).
 */
export function breakAt(c: Contour, pointId: number, freeId: number): Contour[] {
  const nodes = toNodes(c);
  const k = nodes.findIndex((nd) => nd.id === pointId);
  if (k < 0) return [clone(c)];
  let next = maxPointId(c) + 1;
  const copyOf = (nd: Node): Node => ({ ...clone(nd), id: next++ });
  if (!c.open) {
    // Rotate so the cut point is first, and add a copy of it at the end.
    const rot = [...nodes.slice(k), ...nodes.slice(0, k)];
    const end = copyOf(rot[0]);
    delete end.out;
    if (end.in) end.in = { id: next++, pos: { ...end.in.pos } };
    delete rot[0].in;
    rot[0].smooth = false;
    end.smooth = false;
    return [named(c, fromNodes([...rot, end], c.id, c.part, next, true))];
  }
  if (k === 0 || k === nodes.length - 1) return [clone(c)];
  const head = nodes.slice(0, k + 1);
  const tailStart = copyOf(nodes[k]);
  if (tailStart.out) tailStart.out = { id: next++, pos: { ...tailStart.out.pos } };
  delete tailStart.in;
  const tail = [tailStart, ...nodes.slice(k + 1)];
  head[k] = { ...head[k], smooth: false };
  delete head[k].out;
  tailStart.smooth = false;
  return [
    named(c, fromNodes(head, c.id, c.part, next, true)),
    named(c, fromNodes(tail, freeId, c.part, next + 4, true)),
  ];
}

function named(from: Contour, c: Contour): Contour {
  if (from.name) c.name = from.name;
  return c;
}

/** Which end of an open path a point is: its first node, its last, or neither. */
export function endOf(c: Contour, pointId: number): "start" | "end" | null {
  if (!c.open) return null;
  const nodes = toNodes(c);
  if (nodes[0]?.id === pointId) return "start";
  if (nodes[nodes.length - 1]?.id === pointId) return "end";
  return null;
}

/**
 * Join two open paths at the given ends, or close one path when both ends
 * are its own. Ends within half a unit merge into one point; otherwise a
 * straight segment connects them. The result keeps `a`'s id.
 */
export function joinPaths(a: Contour, aEnd: "start" | "end", b: Contour, bEnd: "start" | "end"): Contour {
  if (a === b || a.id === b.id) return closePath(a);
  let na = toNodes(a);
  let nb = toNodes(b);
  // Run a so it ends at the join, and b so it starts there.
  if (aEnd === "start") na = flip(na);
  if (bEnd === "end") nb = flip(nb);
  let next = Math.max(maxPointId(a), maxPointId(b)) + 1;
  const used = new Set(na.flatMap((nd) => [nd.id, nd.in?.id, nd.out?.id]).filter((v) => v !== undefined));
  const fresh = (id: number) => (used.has(id) ? next++ : id);
  nb = nb.map((nd) => ({
    ...nd,
    id: fresh(nd.id),
    in: nd.in && { id: fresh(nd.in.id), pos: nd.in.pos },
    out: nd.out && { id: fresh(nd.out.id), pos: nd.out.pos },
  }));
  const tail = na[na.length - 1];
  const head = nb[0];
  if (dist(tail.pos, head.pos) < 0.5) {
    tail.out = head.out;
    tail.smooth = false;
    nb = nb.slice(1);
  }
  return named(a, fromNodes([...na, ...nb], a.id, a.part, next + 2, true));
}

function flip(nodes: Node[]): Node[] {
  return [...nodes].reverse().map((nd) => ({ ...nd, in: nd.out, out: nd.in }));
}

// ---------- Tunni lines ----------

/** Where the two handle lines of a cubic meet, or null when they are parallel or point away. */
export function tunniPoint(pts: Vec2[]): Vec2 | null {
  if (pts.length !== 4) return null;
  const [p0, p1, p2, p3] = pts;
  const d0 = sub(p1, p0);
  const d1 = sub(p2, p3);
  const den = cross(d0, d1);
  if (Math.abs(den) < 1e-9 || len(d0) < 1e-9 || len(d1) < 1e-9) return null;
  const t = cross(sub(p3, p0), d1) / den;
  const u = cross(sub(p3, p0), d0) / den;
  if (t <= 0 || u <= 0) return null;
  return add(p0, mul(d0, t));
}

/** How far each handle reaches toward the Tunni point, 0..1. */
export function tensions(pts: Vec2[]): [number, number] | null {
  const t = tunniPoint(pts);
  if (!t) return null;
  const [p0, p1, p2, p3] = pts;
  return [dist(p0, p1) / Math.max(1e-9, dist(p0, t)), dist(p3, p2) / Math.max(1e-9, dist(p3, t))];
}

/**
 * Drag the Tunni point to `to`: each handle keeps its direction and its
 * length changes by how far `to` moved along that handle's line.
 */
export function moveTunni(pts: Vec2[], to: Vec2): [Vec2, Vec2] | null {
  const t = tunniPoint(pts);
  if (!t) return null;
  const [p0, p1, p2, p3] = pts;
  const u0 = unit(sub(p1, p0));
  const u1 = unit(sub(p2, p3));
  const r0 = Math.max(0.01, dot(sub(to, p0), u0) / dist(p0, t));
  const r1 = Math.max(0.01, dot(sub(to, p3), u1) / dist(p3, t));
  return [add(p0, mul(sub(p1, p0), r0)), add(p3, mul(sub(p2, p3), r1))];
}

/** Even out the two handles of a cubic: both reach the same share of the way to the Tunni point. */
export function balanceHandles(pts: Vec2[]): [Vec2, Vec2] | null {
  const ts = tensions(pts);
  const t = tunniPoint(pts);
  if (!ts || !t) return null;
  const k = (ts[0] + ts[1]) / 2;
  const [p0, , , p3] = pts;
  return [add(p0, mul(sub(t, p0), k)), add(p3, mul(sub(t, p3), k))];
}

/** Balance the handles of every curve between two selected on-curve points. */
export function balanceContour(c: Contour, ids: Set<number>): Contour {
  const nodes = toNodes(c);
  const n = nodes.length;
  for (let k = 0; k < (c.open ? n - 1 : n); k++) {
    const a = nodes[k];
    const b = nodes[(k + 1) % n];
    if (!ids.has(a.id) || !ids.has(b.id) || !a.out || !b.in) continue;
    const res = balanceHandles([a.pos, a.out.pos, b.in.pos, b.pos]);
    if (!res) continue;
    a.out.pos = r2(res[0]);
    b.in.pos = r2(res[1]);
  }
  return rebuilt(c, nodes, maxPointId(c) + 1);
}

// ---------- Harmonize ----------

/**
 * Move each selected smooth point along its handle line so the curvature
 * matches on both sides (G2), keeping the handles where they are.
 */
export function harmonize(c: Contour, ids: Set<number>): Contour {
  const nodes = toNodes(c);
  nodes.forEach((nd, k) => {
    if (!ids.has(nd.id) || !nd.in || !nd.out) return;
    const prev = neighbour(nodes, k, -1, c.open);
    const nxt = neighbour(nodes, k, 1, c.open);
    if (!prev?.out || !nxt?.in) return;
    const a1 = prev.out.pos;
    const a2 = nd.in.pos;
    const b1 = nd.out.pos;
    const b2 = nxt.in.pos;
    const d = intersect(a1, a2, b1, b2);
    let t: number;
    if (d) {
      const p0 = dist(a1, a2) / Math.max(1e-9, dist(a2, d));
      const p1 = dist(d, b1) / Math.max(1e-9, dist(b1, b2));
      const r = Math.sqrt(p0 * p1);
      t = r / (r + 1);
    } else {
      // Parallel outer handles: split by handle lengths.
      const la = dist(a1, a2);
      const lb = dist(b1, b2);
      t = la / Math.max(1e-9, la + lb);
    }
    if (!Number.isFinite(t) || t <= 0 || t >= 1) return;
    nd.pos = r2(add(a2, mul(sub(b1, a2), t)));
    nd.smooth = true;
  });
  return rebuilt(c, nodes, maxPointId(c) + 1);
}

function intersect(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const da = sub(a2, a1);
  const db = sub(b2, b1);
  const den = cross(da, db);
  if (Math.abs(den) < 1e-9) return null;
  const t = cross(sub(b1, a1), db) / den;
  return add(a1, mul(da, t));
}

// ---------- Curvature comb ----------

/** Curvature of a cubic at t: positive turns left. */
export function curvatureAt(pts: Vec2[], t: number): number {
  if (pts.length !== 4) return 0;
  const [p0, p1, p2, p3] = pts;
  const u = 1 - t;
  const d1 = add(add(mul(sub(p1, p0), 3 * u * u), mul(sub(p2, p1), 6 * u * t)), mul(sub(p3, p2), 3 * t * t));
  const d2 = add(mul(add(sub(p2, mul(p1, 2)), p0), 6 * u), mul(add(sub(p3, mul(p2, 2)), p1), 6 * t));
  const l = len(d1);
  if (l < 1e-9) return 0;
  return cross(d1, d2) / (l * l * l);
}

/**
 * Teeth of a curvature comb along a cubic: from a point on the curve out
 * along its normal, as long as the curvature times `scale`.
 */
export function combTeeth(pts: Vec2[], scale: number, steps = 24): { at: Vec2; tip: Vec2 }[] {
  if (pts.length !== 4) return [];
  const [p0, p1, p2, p3] = pts;
  const out: { at: Vec2; tip: Vec2 }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const at = add(add(mul(p0, u * u * u), mul(p1, 3 * u * u * t)), add(mul(p2, 3 * u * t * t), mul(p3, t * t * t)));
    const d1 = add(add(mul(sub(p1, p0), 3 * u * u), mul(sub(p2, p1), 6 * u * t)), mul(sub(p3, p2), 3 * t * t));
    const n = unit({ x: -d1.y, y: d1.x });
    const k = curvatureAt(pts, t);
    // Teeth point away from the centre of curvature, as in Glyphs and FontLab.
    out.push({ at, tip: add(at, mul(n, -k * scale)) });
  }
  return out;
}

// ---------- Power nudge ----------

/**
 * Move on-curve points by `d` and reshape the segments next to them
 * proportionally: each segment between a moving and a still point is
 * scaled and turned about the still end, handles included, so its shape is
 * kept. Selected handles move with their points; unselected ones follow.
 */
export function powerNudge(c: Contour, ids: Set<number>, d: Vec2): Contour {
  const nodes = toNodes(c);
  const old = clone(nodes);
  const n = nodes.length;
  const moving = (k: number) => ids.has(old[k].id);
  for (let k = 0; k < n; k++) {
    if (!moving(k)) continue;
    const nd = nodes[k];
    nd.pos = add(nd.pos, d);
    if (nd.in) nd.in.pos = add(nd.in.pos, d);
    if (nd.out) nd.out.pos = add(nd.out.pos, d);
  }
  for (let k = 0; k < (c.open ? n - 1 : n); k++) {
    const j = (k + 1) % n;
    if (moving(k) === moving(j)) continue;
    // One end moves: map the old segment onto the new chord.
    const fixed = moving(k) ? old[j].pos : old[k].pos;
    const from = moving(k) ? old[k].pos : old[j].pos;
    const to = add(from, d);
    const m = similarity(fixed, from, to);
    if (!m) continue;
    if (old[k].out) nodes[k].out!.pos = m(old[k].out!.pos);
    if (old[j].in) nodes[j].in!.pos = m(old[j].in!.pos);
  }
  return rebuilt(c, nodes.map((nd) => roundNode(nd)), maxPointId(c) + 1);
}

/** The rotation and scale about `o` that takes `a` to `b`. */
function similarity(o: Vec2, a: Vec2, b: Vec2): ((p: Vec2) => Vec2) | null {
  const va = sub(a, o);
  const vb = sub(b, o);
  const la = dot(va, va);
  if (la < 1e-9) return null;
  // Complex division vb / va.
  const re = dot(vb, va) / la;
  const im = cross(va, vb) / la;
  return (p) => {
    const v = sub(p, o);
    return add(o, { x: v.x * re - v.y * im, y: v.x * im + v.y * re });
  };
}

function roundNode(nd: Node): Node {
  return {
    ...nd,
    pos: r2(nd.pos),
    in: nd.in && { id: nd.in.id, pos: r2(nd.in.pos) },
    out: nd.out && { id: nd.out.id, pos: r2(nd.out.pos) },
  };
}

// ---------- Automatic handles ----------

/**
 * Hobby-style handles for the selected on-curve points: each smooth point's
 * direction runs from its previous neighbour to its next, and handle lengths
 * follow Hobby's velocity function, so curves through the points come out
 * round without hand-tuning.
 */
export function autoHandles(c: Contour, ids: Set<number>): Contour {
  const nodes = toNodes(c);
  const n = nodes.length;
  let next = maxPointId(c) + 1;
  const dirs = new Map<number, Vec2>();
  nodes.forEach((nd, k) => {
    const prev = neighbour(nodes, k, -1, c.open);
    const nxt = neighbour(nodes, k, 1, c.open);
    if (prev && nxt) dirs.set(k, unit(sub(nxt.pos, prev.pos)));
    else if (nxt) dirs.set(k, unit(sub(nxt.pos, nd.pos)));
    else if (prev) dirs.set(k, unit(sub(nd.pos, prev.pos)));
  });
  for (let k = 0; k < (c.open ? n - 1 : n); k++) {
    const j = (k + 1) % n;
    const a = nodes[k];
    const b = nodes[j];
    if (!ids.has(a.id) && !ids.has(b.id)) continue;
    const chord = sub(b.pos, a.pos);
    const l = len(chord);
    if (l < 1e-6) continue;
    const ua = ids.has(a.id) ? dirs.get(k)! : a.out ? unit(sub(a.out.pos, a.pos)) : unit(chord);
    const ub = ids.has(b.id) ? dirs.get(j)! : b.in ? unit(sub(b.pos, b.in.pos)) : unit(chord);
    const theta = Math.atan2(cross(chord, ua), dot(chord, ua));
    const phi = Math.atan2(cross(ub, chord), dot(ub, chord));
    const ra = hobbyVelocity(theta, phi) * l / 3;
    const rb = hobbyVelocity(phi, theta) * l / 3;
    a.out = { id: a.out?.id ?? next++, pos: r2(add(a.pos, mul(ua, ra))) };
    b.in = { id: b.in?.id ?? next++, pos: r2(sub(b.pos, mul(ub, rb))) };
  }
  for (const nd of nodes) if (ids.has(nd.id) && nd.in && nd.out) nd.smooth = true;
  return rebuilt(c, nodes, next);
}

/** Hobby's velocity function at tension 1. */
function hobbyVelocity(theta: number, phi: number): number {
  const st = Math.sin(theta);
  const sp = Math.sin(phi);
  const ct = Math.cos(theta);
  const cp = Math.cos(phi);
  const a = Math.SQRT2;
  const b = 1 / 16;
  const c = (3 - Math.sqrt(5)) / 2;
  const num = 2 + a * (st - b * sp) * (sp - b * st) * (ct - cp);
  const den = 1 + (1 - c) * ct + c * cp;
  // θ = φ = 0 gives 1: a third of the chord after the /3 above.
  return num / den;
}

// ---------- Freehand ----------

/**
 * Fit a freehand stroke with as few cubics as stay within `tolerance` font
 * units (Schneider's algorithm). Returns nodes ready for `fromNodes`.
 */
export function fitStroke(raw: Vec2[], tolerance = 4, closed = false): Node[] {
  const pts = dedupe(raw);
  if (pts.length < 2) return pts.map((p, i) => ({ id: i, pos: r2(p), smooth: false }));
  const segs: Vec2[][] = [];
  const t0 = unit(sub(pts[1], pts[0]));
  const t1 = unit(sub(pts[pts.length - 2], pts[pts.length - 1]));
  fitRange(pts, 0, pts.length - 1, t0, t1, tolerance * tolerance, segs);
  let id = 0;
  const nodes: Node[] = [{ id: id++, pos: r2(segs[0][0]), smooth: false }];
  for (const s of segs) {
    const prev = nodes[nodes.length - 1];
    prev.out = { id: id++, pos: r2(s[1]) };
    nodes.push({ id: id++, pos: r2(s[3]), smooth: true, in: { id: id++, pos: r2(s[2]) } });
  }
  nodes[nodes.length - 1].smooth = false;
  if (closed && nodes.length > 2 && dist(nodes[0].pos, nodes[nodes.length - 1].pos) < tolerance * 4) {
    const end = nodes.pop()!;
    nodes[0].in = end.in;
  }
  return nodes;
}

function dedupe(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) if (!out.length || dist(out[out.length - 1], p) > 0.5) out.push(p);
  return out;
}

function fitRange(pts: Vec2[], first: number, last: number, t0: Vec2, t1: Vec2, err2: number, out: Vec2[][]): void {
  if (last - first === 1) {
    const d = dist(pts[first], pts[last]) / 3;
    out.push([pts[first], add(pts[first], mul(t0, d)), add(pts[last], mul(t1, d)), pts[last]]);
    return;
  }
  let u = chordParams(pts, first, last);
  let bez = generate(pts, first, last, u, t0, t1);
  let { max, at } = maxError(pts, first, last, bez, u);
  if (max < err2) {
    out.push(bez);
    return;
  }
  if (max < err2 * 4) {
    for (let i = 0; i < 4; i++) {
      u = reparam(pts, first, last, u, bez);
      bez = generate(pts, first, last, u, t0, t1);
      ({ max, at } = maxError(pts, first, last, bez, u));
      if (max < err2) {
        out.push(bez);
        return;
      }
    }
  }
  const tc = unit(sub(pts[at - 1], pts[at + 1]));
  fitRange(pts, first, at, t0, tc, err2, out);
  fitRange(pts, at, last, mul(tc, -1), t1, err2, out);
}

function chordParams(pts: Vec2[], first: number, last: number): number[] {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + dist(pts[i], pts[i - 1]));
  const total = u[u.length - 1] || 1;
  return u.map((v) => v / total);
}

function bezAt(b: Vec2[], t: number): Vec2 {
  const u = 1 - t;
  return add(add(mul(b[0], u * u * u), mul(b[1], 3 * u * u * t)), add(mul(b[2], 3 * u * t * t), mul(b[3], t * t * t)));
}

function generate(pts: Vec2[], first: number, last: number, u: number[], t0: Vec2, t1: Vec2): Vec2[] {
  const p0 = pts[first];
  const p3 = pts[last];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  u.forEach((t, i) => {
    const s = 1 - t;
    const b0 = s * s * s, b1 = 3 * s * s * t, b2 = 3 * s * t * t, b3 = t * t * t;
    const a0 = mul(t0, b1);
    const a1 = mul(t1, b2);
    c00 += dot(a0, a0);
    c01 += dot(a0, a1);
    c11 += dot(a1, a1);
    const tmp = sub(pts[first + i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
    x0 += dot(a0, tmp);
    x1 += dot(a1, tmp);
  });
  const det = c00 * c11 - c01 * c01;
  const seg = dist(p0, p3);
  let al = 0;
  let ar = 0;
  if (Math.abs(det) > 1e-12) {
    al = (x0 * c11 - x1 * c01) / det;
    ar = (c00 * x1 - c01 * x0) / det;
  }
  if (al < seg * 1e-6 || ar < seg * 1e-6) al = ar = seg / 3;
  return [p0, add(p0, mul(t0, al)), add(p3, mul(t1, ar)), p3];
}

function maxError(pts: Vec2[], first: number, last: number, b: Vec2[], u: number[]): { max: number; at: number } {
  let max = 0;
  let at = Math.floor((first + last) / 2);
  for (let i = first + 1; i < last; i++) {
    const d = sub(bezAt(b, u[i - first]), pts[i]);
    const e = dot(d, d);
    if (e >= max) {
      max = e;
      at = i;
    }
  }
  return { max, at };
}

function reparam(pts: Vec2[], first: number, last: number, u: number[], b: Vec2[]): number[] {
  const d1 = [mul(sub(b[1], b[0]), 3), mul(sub(b[2], b[1]), 3), mul(sub(b[3], b[2]), 3)];
  const d2 = [mul(sub(d1[1], d1[0]), 2), mul(sub(d1[2], d1[1]), 2)];
  const q1 = (t: number) => add(add(mul(d1[0], (1 - t) * (1 - t)), mul(d1[1], 2 * (1 - t) * t)), mul(d1[2], t * t));
  const q2 = (t: number) => add(mul(d2[0], 1 - t), mul(d2[1], t));
  return u.map((t, i) => {
    const diff = sub(bezAt(b, t), pts[first + i]);
    const a = q1(t);
    const num = dot(diff, a);
    const den = dot(a, a) + dot(diff, q2(t));
    if (Math.abs(den) < 1e-12) return t;
    return Math.min(1, Math.max(0, t - num / den));
  });
}
