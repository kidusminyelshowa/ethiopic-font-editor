// Auto-trace: turn a sketch image into editable outlines. The image is cut
// into ink and paper by brightness, the edges of the ink are followed into
// closed polygons, and those are fitted with curves, keeping sharp corners.

import { fitStroke } from "./curves";
import { fromNodes, type Contour, type Node, type Vec2 } from "./geometry";
import { correctDirections } from "./pathops";

/**
 * The outlines of the ink in a `w` × `h` grid (row by row, `true` for ink),
 * as closed polygons on the pixel corners, in pixel coordinates (y down).
 * Holes come back as their own loops.
 */
export function traceLoops(ink: ArrayLike<boolean>, w: number, h: number): Vec2[][] {
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && ink[y * w + x];
  // Directed edges with ink on their left (in y-down pixel space that is
  // clockwise around the ink), keyed by their start corner.
  const next = new Map<number, number[]>();
  const id = (x: number, y: number) => y * (w + 1) + x;
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = id(x0, y0);
    const list = next.get(k);
    if (list) list.push(id(x1, y1));
    else next.set(k, [id(x1, y1)]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) add(x, y, x + 1, y);
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  const xy = (k: number): Vec2 => ({ x: k % (w + 1), y: Math.floor(k / (w + 1)) });
  const loops: Vec2[][] = [];
  for (const [start, outs] of next) {
    while (outs.length) {
      const loop: Vec2[] = [xy(start)];
      let prev = start;
      let cur = outs.pop()!;
      let guard = 0;
      while (cur !== start && guard++ < 4 * (w + 1) * (h + 1)) {
        loop.push(xy(cur));
        const options = next.get(cur);
        if (!options?.length) break;
        // Where two edges leave one corner (ink touching diagonally), turn
        // the same way every time so the shapes stay apart.
        let pick = 0;
        if (options.length > 1) {
          const p = xy(prev);
          const c = xy(cur);
          const din = { x: c.x - p.x, y: c.y - p.y };
          pick = options.findIndex((o) => {
            const q = xy(o);
            return din.x * (q.y - c.y) - din.y * (q.x - c.x) > 0;
          });
          if (pick < 0) pick = 0;
        }
        prev = cur;
        cur = options.splice(pick, 1)[0];
      }
      if (loop.length >= 4) loops.push(loop);
    }
  }
  return loops;
}

/** Twice the signed area of a polygon. */
function area2(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a;
}

/**
 * Corners of a pixel loop (whose steps are one pixel long): where the
 * direction over `reach` pixels either side turns by `minTurn` degrees or
 * more. Looking a few pixels out reads a staircase as the line it is.
 */
export function loopCorners(loop: Vec2[], reach = 4, minTurn = 65): number[] {
  const n = loop.length;
  const turn = loop.map((p, i) => {
    const a = loop[(i - reach + n) % n];
    const b = loop[(i + reach) % n];
    const u = { x: p.x - a.x, y: p.y - a.y };
    const v = { x: b.x - p.x, y: b.y - p.y };
    const cos = (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y) || 1);
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  });
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (turn[i] < minTurn) continue;
    let peak = true;
    for (let k = 1; k <= reach && peak; k++) {
      if (turn[(i + k) % n] > turn[i] || turn[(i - k + n) % n] >= turn[i]) peak = false;
    }
    if (peak) out.push(i);
  }
  return out;
}

/** Whether every point of a run lies within `tol` of the line between its ends. */
function straight(run: Vec2[], tol: number): boolean {
  const a = run[0];
  const b = run[run.length - 1];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-9) return false;
  return run.every((p) => Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len <= tol);
}

/**
 * Fit a closed pixel loop: corners stay corner points, straight runs
 * between corners stay lines, the rest is fitted with curves to within
 * `tolerance` pixels. `toFont` maps pixels to font units.
 */
export function fitLoop(loop: Vec2[], tolerance: number, toFont: (p: Vec2) => Vec2): Node[] {
  const n = loop.length;
  const cs = loopCorners(loop);
  const unit = Math.hypot(toFont({ x: 1, y: 0 }).x - toFont({ x: 0, y: 0 }).x, toFont({ x: 1, y: 0 }).y - toFont({ x: 0, y: 0 }).y) || 1;
  // Pixel corners stair-step along slopes; midpoints of the steps follow the shape.
  const mid = (i: number) => {
    const p = loop[i];
    const q = loop[(i + 1) % n];
    return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  };
  let nodes: Node[] = [];
  if (!cs.length) {
    const pts = loop.map((_, i) => toFont(mid(i)));
    nodes = fitStroke([...pts, pts[0]], tolerance * unit, true);
  } else {
    for (let k = 0; k < cs.length; k++) {
      const from = cs[k];
      const to = cs[(k + 1) % cs.length];
      const px: Vec2[] = [loop[from]];
      for (let i = (from + 1) % n; ; i = (i + 1) % n) {
        if (i === to) {
          px.push(loop[to]);
          break;
        }
        px.push(mid(i));
      }
      const run = px.map(toFont);
      const part: Node[] = straight(px, 0.9)
        ? [
            { id: 0, pos: run[0], smooth: false },
            { id: 1, pos: run[run.length - 1], smooth: false },
          ]
        : fitStroke(run, tolerance * unit, false);
      if (!nodes.length) nodes.push(...part);
      else {
        // The run starts where the last one ended: one corner point.
        const joint = nodes[nodes.length - 1];
        if (part[0].out) joint.out = part[0].out;
        joint.smooth = false;
        nodes.push(...part.slice(1));
      }
    }
    // The last run ends on the first corner.
    const end = nodes.pop()!;
    if (end.in) nodes[0].in = end.in;
    nodes[0].smooth = false;
  }
  // Fresh ids for every point and handle.
  let id = 0;
  for (const nd of nodes) {
    nd.id = id++;
    if (nd.in) nd.in = { id: id++, pos: nd.in.pos };
    if (nd.out) nd.out = { id: id++, pos: nd.out.pos };
  }
  return nodes;
}

export interface TraceOptions {
  /** Ignore specks smaller than this many square pixels. */
  minArea?: number;
  /** How closely curves follow the ink, in pixels. */
  tolerance?: number;
}

/**
 * Trace an ink grid into contours, mapping pixels to font units with
 * `toFont`. Outer shapes run counter-clockwise and counters clockwise.
 */
export function traceToContours(
  ink: ArrayLike<boolean>,
  w: number,
  h: number,
  toFont: (p: Vec2) => Vec2,
  firstId: number,
  opts: TraceOptions = {},
): Contour[] {
  const minArea = opts.minArea ?? 12;
  const tol = opts.tolerance ?? 1.5;
  const loops = traceLoops(ink, w, h).filter((l) => Math.abs(area2(l)) / 2 >= minArea);
  const out = loops.map((loop, i) => fromNodes(fitLoop(loop, tol, toFont), firstId + i, null, undefined, false));
  return correctDirections(out);
}

/** Ink where a pixel is dark and not transparent. */
export function inkFromPixels(rgba: ArrayLike<number>, w: number, h: number, threshold = 128): boolean[] {
  const ink = new Array<boolean>(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const alpha = rgba[i * 4 + 3];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // Transparent pixels count as paper.
    ink[i] = alpha > 127 && lum < threshold;
  }
  return ink;
}
