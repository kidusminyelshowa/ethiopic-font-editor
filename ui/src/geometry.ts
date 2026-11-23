// Outline geometry on the UI side. Mirrors fidel-core's point model: closed
// cubic contours in UFO order, where each `curve` point is preceded by its two
// handles. Point and contour ids are kept stable across edits, because glyph
// nudges in the core refer to them.

import type { Part } from "./api";

export interface Vec2 {
  x: number;
  y: number;
}

export type PointKind = "line" | "curve" | "offcurve";

export interface Point {
  id: number;
  pos: Vec2;
  kind: PointKind;
  smooth?: boolean;
}

export interface Contour {
  id: number;
  points: Point[];
  part?: Part | null;
  /** Layer name, e.g. the alteration a detached contour came from. */
  name?: string | null;
}

/** An on-curve point with its handles: easier to edit than the flat list. */
export interface Node {
  id: number;
  pos: Vec2;
  smooth: boolean;
  in?: { id: number; pos: Vec2 };
  out?: { id: number; pos: Vec2 };
}

export const isOn = (p: Point) => p.kind !== "offcurve";

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/** Split a contour into nodes. Assumes a valid contour. */
export function toNodes(c: Contour): Node[] {
  const pts = c.points;
  const n = pts.length;
  const nodes: Node[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (!isOn(p)) continue;
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const node: Node = { id: p.id, pos: { ...p.pos }, smooth: !!p.smooth };
    if (!isOn(prev) && p.kind === "curve") node.in = { id: prev.id, pos: { ...prev.pos } };
    if (!isOn(next)) node.out = { id: next.id, pos: { ...next.pos } };
    nodes.push(node);
  }
  return nodes;
}

/**
 * Join nodes back into a closed contour. A segment is a curve when either end
 * has a handle on that side; a missing handle sits on its node. Existing ids
 * are reused and new ones are taken from `nextId`.
 */
export function fromNodes(nodes: Node[], id: number, part?: Part | null, firstFreeId?: number): Contour {
  let next = firstFreeId ?? maxId(nodes) + 1;
  const n = nodes.length;
  // Fill in missing handles first: a segment is a curve if either end has one.
  const curve: boolean[] = [];
  for (let k = 1; k <= n; k++) {
    const a = nodes[k - 1];
    const b = nodes[k % n];
    curve[k % n] = !!(a.out || b.in);
    if (curve[k % n]) {
      a.out ??= { id: next++, pos: { ...a.pos } };
      b.in ??= { id: next++, pos: { ...b.pos } };
    }
  }
  // The first node stays first; the handles of the closing segment go last.
  const points: Point[] = [];
  const on = (nd: Node, isCurve: boolean): Point => ({
    id: nd.id,
    pos: { ...nd.pos },
    kind: isCurve ? "curve" : "line",
    smooth: nd.smooth,
  });
  const handles = (a: Node, b: Node): Point[] => [
    { id: a.out!.id, pos: { ...a.out!.pos }, kind: "offcurve" },
    { id: b.in!.id, pos: { ...b.in!.pos }, kind: "offcurve" },
  ];
  points.push(on(nodes[0], curve[0]));
  for (let k = 1; k < n; k++) {
    if (curve[k]) points.push(...handles(nodes[k - 1], nodes[k]));
    points.push(on(nodes[k], curve[k]));
  }
  if (curve[0]) points.push(...handles(nodes[n - 1], nodes[0]));
  return { id, points, part: part ?? null };
}

/** `fromNodes`, keeping the layer name of the contour it came from. */
export function rebuilt(c: Contour, nodes: Node[], firstFreeId?: number): Contour {
  const out = fromNodes(nodes, c.id, c.part, firstFreeId);
  if (c.name) out.name = c.name;
  return out;
}

function maxId(nodes: Node[]): number {
  let m = -1;
  for (const nd of nodes) {
    m = Math.max(m, nd.id, nd.in?.id ?? -1, nd.out?.id ?? -1);
  }
  return m;
}

export function nextContourId(contours: Contour[]): number {
  return contours.reduce((m, c) => Math.max(m, c.id), -1) + 1;
}

/** Check a contour the same way the core does, so errors show before a round trip. */
export function validate(c: Contour): string | null {
  const n = c.points.length;
  if (n < 2) return "too few points";
  const ids = new Set<number>();
  for (const p of c.points) {
    if (ids.has(p.id)) return `duplicate point id ${p.id}`;
    ids.add(p.id);
  }
  const start = c.points.findIndex(isOn);
  if (start < 0) return "no on-curve point";
  let handles = 0;
  for (let i = 1; i <= n; i++) {
    const p = c.points[(start + i) % n];
    if (p.kind === "offcurve") {
      if (++handles > 2) return "too many handles in a row";
    } else if (p.kind === "line" && handles > 0) {
      return "handles before a line point";
    } else if (p.kind === "curve" && handles !== 2) {
      return "curve point without two handles";
    } else {
      handles = 0;
    }
  }
  return null;
}

const num = (v: number) => String(Math.round(v * 100) / 100);

/** SVG path data in font units (y up). */
export function contourPath(c: Contour): string {
  const pts = c.points;
  const n = pts.length;
  const start = pts.findIndex(isOn);
  if (start < 0) return "";
  let d = `M${num(pts[start].pos.x)} ${num(pts[start].pos.y)}`;
  let pending: Vec2[] = [];
  for (let i = 1; i <= n; i++) {
    const p = pts[(start + i) % n];
    if (p.kind === "offcurve") {
      pending.push(p.pos);
    } else if (p.kind === "curve" && pending.length === 2) {
      d += `C${num(pending[0].x)} ${num(pending[0].y)} ${num(pending[1].x)} ${num(pending[1].y)} ${num(p.pos.x)} ${num(p.pos.y)}`;
      pending = [];
    } else {
      if (i < n) d += `L${num(p.pos.x)} ${num(p.pos.y)}`;
      pending = [];
    }
  }
  return d + "Z";
}

export function drawingPath(contours: Contour[]): string {
  return contours.map(contourPath).join("");
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(points: Vec2[]): Box | null {
  if (!points.length) return null;
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of points) {
    b.minX = Math.min(b.minX, p.x);
    b.minY = Math.min(b.minY, p.y);
    b.maxX = Math.max(b.maxX, p.x);
    b.maxY = Math.max(b.maxY, p.y);
  }
  return b;
}

export function contoursBounds(contours: Contour[]): Box | null {
  return boundsOf(contours.flatMap((c) => c.points.map((p) => p.pos)));
}

/**
 * When a handle moves, keep the opposite handle of a smooth point on the same
 * line (keeping its own length), so the curve stays smooth through the point.
 */
export function mirrorSmooth(c: Contour, handleIndex: number): void {
  const pts = c.points;
  const n = pts.length;
  const at = (i: number) => pts[(i + n) % n];
  let anchor: Point | null = null;
  let opposite: Point | null = null;
  if (isOn(at(handleIndex - 1))) {
    anchor = at(handleIndex - 1);
    opposite = at(handleIndex - 2);
  } else if (isOn(at(handleIndex + 1))) {
    anchor = at(handleIndex + 1);
    opposite = at(handleIndex + 2);
  }
  if (!anchor || !anchor.smooth || !opposite || isOn(opposite)) return;
  const h = at(handleIndex).pos;
  const dx = anchor.pos.x - h.x;
  const dy = anchor.pos.y - h.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const keep = Math.hypot(opposite.pos.x - anchor.pos.x, opposite.pos.y - anchor.pos.y);
  opposite.pos = { x: anchor.pos.x + (dx / len) * keep, y: anchor.pos.y + (dy / len) * keep };
}

/** Round every coordinate to whole font units. */
export function roundContours(contours: Contour[]): void {
  for (const c of contours) {
    for (const p of c.points) {
      p.pos = { x: Math.round(p.pos.x), y: Math.round(p.pos.y) };
    }
  }
}

/** Move every point of every contour. */
export function translated(contours: Contour[], d: Vec2): Contour[] {
  const out = clone(contours);
  for (const c of out) for (const p of c.points) p.pos = { x: p.pos.x + d.x, y: p.pos.y + d.y };
  return out;
}

/** Snap a drag from `from` to `to` onto the nearest multiple of 45°, keeping its length along that ray. */
export function constrain45(from: Vec2, to: Vec2): Vec2 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { ...to };
  const step = Math.PI / 4;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  // Project onto the ray so a drag along an axis keeps its exact length.
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const t = dx * ux + dy * uy;
  const clean = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v);
  return { x: from.x + clean(t * ux), y: from.y + clean(t * uy) };
}

/** An axis-aligned rectangle, counter-clockwise like the core's. */
export function rectContour(id: number, a: Vec2, b: Vec2): Contour {
  const x0 = Math.round(Math.min(a.x, b.x));
  const x1 = Math.round(Math.max(a.x, b.x));
  const y0 = Math.round(Math.min(a.y, b.y));
  const y1 = Math.round(Math.max(a.y, b.y));
  const corners: Vec2[] = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  return { id, points: corners.map((pos, i) => ({ id: i, pos, kind: "line" as const })), part: null };
}

/** An ellipse inside the box a-b: four smooth points with cubic handles. */
export function ellipseContour(id: number, a: Vec2, b: Vec2): Contour {
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const rx = Math.abs(b.x - a.x) / 2;
  const ry = Math.abs(b.y - a.y) / 2;
  const k = 0.5523;
  const r = (v: number) => Math.round(v);
  // Counter-clockwise from the bottom.
  const nodes: Node[] = [
    { id: 0, pos: { x: r(cx), y: r(cy - ry) }, smooth: true, in: { id: 1, pos: { x: r(cx - rx * k), y: r(cy - ry) } }, out: { id: 2, pos: { x: r(cx + rx * k), y: r(cy - ry) } } },
    { id: 3, pos: { x: r(cx + rx), y: r(cy) }, smooth: true, in: { id: 4, pos: { x: r(cx + rx), y: r(cy - ry * k) } }, out: { id: 5, pos: { x: r(cx + rx), y: r(cy + ry * k) } } },
    { id: 6, pos: { x: r(cx), y: r(cy + ry) }, smooth: true, in: { id: 7, pos: { x: r(cx + rx * k), y: r(cy + ry) } }, out: { id: 8, pos: { x: r(cx - rx * k), y: r(cy + ry) } } },
    { id: 9, pos: { x: r(cx - rx), y: r(cy) }, smooth: true, in: { id: 10, pos: { x: r(cx - rx), y: r(cy + ry * k) } }, out: { id: 11, pos: { x: r(cx - rx), y: r(cy - ry * k) } } },
  ];
  return fromNodes(nodes, id, null, 12);
}
