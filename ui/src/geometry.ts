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
  /** Locked in the editor: drawn, but cannot be selected. */
  locked?: boolean;
  /** Hidden in the editor; still part of the glyph. */
  hidden?: boolean;
  /** An open path: no closing segment. Kept while drawing; not exported. */
  open?: boolean;
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
    const prev = c.open && i === 0 ? null : pts[(i - 1 + n) % n];
    const next = c.open && i === n - 1 ? null : pts[(i + 1) % n];
    const node: Node = { id: p.id, pos: { ...p.pos }, smooth: !!p.smooth };
    if (prev && !isOn(prev) && p.kind === "curve") node.in = { id: prev.id, pos: { ...prev.pos } };
    if (next && !isOn(next)) node.out = { id: next.id, pos: { ...next.pos } };
    nodes.push(node);
  }
  return nodes;
}

/**
 * Join nodes back into a contour, closed unless `open`. A segment is a curve
 * when either end has a handle on that side; a missing handle sits on its
 * node. Existing ids are reused and new ones are taken from `nextId`.
 */
export function fromNodes(nodes: Node[], id: number, part?: Part | null, firstFreeId?: number, open = false): Contour {
  let next = firstFreeId ?? maxId(nodes) + 1;
  const n = nodes.length;
  if (open && n) {
    // The ends of an open path have no outer handles.
    delete nodes[0].in;
    delete nodes[n - 1].out;
  }
  // Fill in missing handles first: a segment is a curve if either end has one.
  const curve: boolean[] = [];
  if (open) curve[0] = false;
  for (let k = 1; k <= (open ? n - 1 : n); k++) {
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
  const out: Contour = { id, points, part: part ?? null };
  if (open) out.open = true;
  return out;
}

/** `fromNodes`, keeping the layer name of the contour it came from. */
export function rebuilt(c: Contour, nodes: Node[], firstFreeId?: number): Contour {
  const out = fromNodes(nodes, c.id, c.part, firstFreeId, !!c.open);
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
  if (c.open && (start !== 0 || !isOn(c.points[n - 1]))) return "open path ends on a handle";
  let handles = 0;
  for (let i = 1; i <= (c.open ? n - 1 : n); i++) {
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
  for (let i = 1; i <= (c.open ? n - 1 : n); i++) {
    const p = pts[(start + i) % n];
    if (p.kind === "offcurve") {
      pending.push(p.pos);
    } else if (p.kind === "curve" && pending.length === 2) {
      d += `C${num(pending[0].x)} ${num(pending[0].y)} ${num(pending[1].x)} ${num(pending[1].y)} ${num(p.pos.x)} ${num(p.pos.y)}`;
      pending = [];
    } else {
      if (i < n || c.open) d += `L${num(p.pos.x)} ${num(p.pos.y)}`;
      pending = [];
    }
  }
  return c.open ? d : d + "Z";
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

/**
 * Twice the signed area of the contour's control polygon. Positive means
 * counter-clockwise with y up, the direction of outer contours here.
 */
export function signedArea(c: Contour): number {
  const pts = c.points;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i].pos;
    const q = pts[(i + 1) % pts.length].pos;
    a += p.x * q.y - q.x * p.y;
  }
  return a;
}

export const isClockwise = (c: Contour): boolean => signedArea(c) < 0;

/** Same outline drawn the other way round. The start point stays first and every id is kept. */
export function reversed(c: Contour): Contour {
  const nodes = toNodes(c);
  if (nodes.length < 2) return clone(c);
  // A closed path keeps its start point; an open one starts from its other end.
  const order = c.open ? [...nodes].reverse() : [nodes[0], ...nodes.slice(1).reverse()];
  const back = order.map((nd) => ({ ...nd, in: nd.out, out: nd.in }));
  return rebuilt(c, back);
}

/** The start point and the unit direction the contour leaves it in, for the direction arrow. */
export function startDirection(c: Contour): { at: Vec2; dir: Vec2 } | null {
  const pts = c.points;
  const start = pts.findIndex(isOn);
  if (start < 0) return null;
  const at = pts[start].pos;
  for (let i = 1; i < pts.length; i++) {
    const q = pts[(start + i) % pts.length].pos;
    const len = Math.hypot(q.x - at.x, q.y - at.y);
    if (len > 1e-6) return { at: { ...at }, dir: { x: (q.x - at.x) / len, y: (q.y - at.y) / len } };
  }
  return null;
}

/**
 * What an on-curve point is. A corner's handles move on their own; a smooth
 * point keeps its handles in line; retracting removes the handles, so the
 * segments next to it straighten.
 */
const same = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

export type NodeType = "corner" | "smooth" | "retract";

/** Change the type of the on-curve points in `ids`. New handles get fresh ids. */
export function convertNodes(c: Contour, ids: Set<number>, to: NodeType): Contour {
  const nodes = toNodes(c);
  const n = nodes.length;
  let next = c.points.reduce((m, p) => Math.max(m, p.id), -1) + 1;
  nodes.forEach((nd, k) => {
    if (!ids.has(nd.id)) return;
    if (to === "corner") {
      nd.smooth = false;
    } else if (to === "retract") {
      nd.smooth = false;
      delete nd.in;
      delete nd.out;
      // A neighbour's handle that sits on its own point would keep the segment curved.
      const prev = neighbour(nodes, k, -1, c.open);
      const nxt = neighbour(nodes, k, 1, c.open);
      if (prev?.out && same(prev.out.pos, prev.pos)) delete prev.out;
      if (nxt?.in && same(nxt.in.pos, nxt.pos)) delete nxt.in;
    } else {
      nd.smooth = true;
      if (n < 2) return;
      // At the end of an open path, the missing neighbour mirrors the other.
      const pn = neighbour(nodes, k, -1, c.open);
      const nn = neighbour(nodes, k, 1, c.open);
      if (!pn && !nn) return;
      const prev = pn ? pn.pos : { x: 2 * nd.pos.x - nn!.pos.x, y: 2 * nd.pos.y - nn!.pos.y };
      const nxt = nn ? nn.pos : { x: 2 * nd.pos.x - pn!.pos.x, y: 2 * nd.pos.y - pn!.pos.y };
      // The tangent: through the handles when there are both, else from neighbour to neighbour.
      let tx = nxt.x - prev.x;
      let ty = nxt.y - prev.y;
      if (nd.in && nd.out) {
        const ix = nd.pos.x - nd.in.pos.x;
        const iy = nd.pos.y - nd.in.pos.y;
        const ox = nd.out.pos.x - nd.pos.x;
        const oy = nd.out.pos.y - nd.pos.y;
        const il = Math.hypot(ix, iy);
        const ol = Math.hypot(ox, oy);
        if (il > 1e-6 && ol > 1e-6) {
          tx = ix / il + ox / ol;
          ty = iy / il + oy / ol;
        }
      }
      const tl = Math.hypot(tx, ty);
      if (tl < 1e-6) return;
      tx /= tl;
      ty /= tl;
      const inLen = nd.in ? Math.hypot(nd.in.pos.x - nd.pos.x, nd.in.pos.y - nd.pos.y) : 0;
      const outLen = nd.out ? Math.hypot(nd.out.pos.x - nd.pos.x, nd.out.pos.y - nd.pos.y) : 0;
      const li = inLen > 1e-6 ? inLen : Math.hypot(nd.pos.x - prev.x, nd.pos.y - prev.y) / 3;
      const lo = outLen > 1e-6 ? outLen : Math.hypot(nxt.x - nd.pos.x, nxt.y - nd.pos.y) / 3;
      const r = (v: number) => Math.round(v);
      nd.in = { id: nd.in?.id ?? next++, pos: { x: r(nd.pos.x - tx * li), y: r(nd.pos.y - ty * li) } };
      nd.out = { id: nd.out?.id ?? next++, pos: { x: r(nd.pos.x + tx * lo), y: r(nd.pos.y + ty * lo) } };
    }
  });
  return rebuilt(c, nodes, next);
}

/** The node before (-1) or after (1) node k, or null past the end of an open path. */
export function neighbour(nodes: Node[], k: number, step: -1 | 1, open?: boolean): Node | null {
  const n = nodes.length;
  const j = k + step;
  if (open && (j < 0 || j >= n)) return null;
  return nodes[(j + n) % n] ?? null;
}
