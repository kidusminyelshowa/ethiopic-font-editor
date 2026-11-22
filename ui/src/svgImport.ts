// Turn pasted SVG (markup or bare path data) into closed cubic contours in font
// units: y flipped to point up, scaled so the drawing spans the Pa-height.

import { fromNodes, type Contour, type Node, type Vec2 } from "./geometry";

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

interface Segment {
  c1?: Vec2;
  c2?: Vec2;
  to: Vec2;
}

interface Subpath {
  start: Vec2;
  segments: Segment[];
}

export interface ImportOptions {
  /** Height the drawing is scaled to, in font units. */
  height: number;
  /** Where the drawing's bottom edge lands. */
  bottom: number;
  /** Where its left edge lands, or its centre when `centerX` is set. */
  left: number;
  centerX?: boolean;
  firstContourId: number;
}

export class SvgImportError extends Error {}

export function importSvg(text: string, opts: ImportOptions): Contour[] {
  const subpaths = parseSvgText(text.trim());
  const usable = subpaths.filter((s) => s.segments.length >= 2 || s.segments.some((g) => g.c1));
  if (!usable.length) throw new SvgImportError("No closed shapes found in the SVG.");
  return toContours(usable, opts);
}

export function parseSvgText(text: string): Subpath[] {
  if (/^[Mm]/.test(text)) return parsePathData(text, IDENTITY);
  if (!text.includes("<svg") && !text.includes("<path")) {
    throw new SvgImportError("The clipboard does not hold SVG.");
  }
  const markup = text.includes("<svg") ? text : `<svg xmlns="http://www.w3.org/2000/svg">${text}</svg>`;
  const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
  if (doc.querySelector("parsererror")) throw new SvgImportError("The SVG could not be read.");
  const root = doc.querySelector("svg");
  if (!root) throw new SvgImportError("No <svg> element found.");

  const out: Subpath[] = [];
  const walk = (el: Element, m: Matrix) => {
    const local = multiply(m, parseTransform(el.getAttribute("transform")));
    const tag = el.tagName.toLowerCase();
    if (tag === "defs" || tag === "clippath" || tag === "mask" || tag === "symbol") return;
    const attr = (n: string) => parseFloat(el.getAttribute(n) ?? "0") || 0;
    switch (tag) {
      case "path":
        out.push(...parsePathData(el.getAttribute("d") ?? "", local));
        break;
      case "rect": {
        const [x, y, w, h] = [attr("x"), attr("y"), attr("width"), attr("height")];
        let rx = attr("rx");
        let ry = attr("ry");
        if (!el.hasAttribute("rx")) rx = ry;
        if (!el.hasAttribute("ry")) ry = rx;
        rx = Math.min(rx, w / 2);
        ry = Math.min(ry, h / 2);
        const d =
          rx > 0 || ry > 0
            ? `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
            : `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
        out.push(...parsePathData(d, local));
        break;
      }
      case "circle":
      case "ellipse": {
        const cx = attr("cx");
        const cy = attr("cy");
        const rx = tag === "circle" ? attr("r") : attr("rx");
        const ry = tag === "circle" ? attr("r") : attr("ry");
        const d = `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
        out.push(...parsePathData(d, local));
        break;
      }
      case "polygon":
      case "polyline": {
        const nums = (el.getAttribute("points") ?? "").trim().split(/[\s,]+/).map(Number);
        if (nums.length >= 6) {
          let d = `M${nums[0]} ${nums[1]}`;
          for (let i = 2; i + 1 < nums.length; i += 2) d += `L${nums[i]} ${nums[i + 1]}`;
          out.push(...parsePathData(d + "Z", local));
        }
        break;
      }
    }
    for (const child of Array.from(el.children)) walk(child, local);
  };
  walk(root, IDENTITY);
  return out;
}

// ---------- Path data ----------

const TOKEN = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;

export function parsePathData(d: string, m: Matrix): Subpath[] {
  const tokens: (string | number)[] = [];
  for (const t of d.matchAll(TOKEN)) tokens.push(t[1] ?? parseFloat(t[2]));

  const paths: Subpath[] = [];
  let cur: Subpath | null = null;
  let pos: Vec2 = { x: 0, y: 0 };
  let start: Vec2 = { x: 0, y: 0 };
  let lastCtrl: Vec2 | null = null;
  let lastQuad: Vec2 | null = null;
  let cmd = "";
  let i = 0;

  const num = () => {
    const v = tokens[i++];
    if (typeof v !== "number") throw new SvgImportError("Malformed path data.");
    return v;
  };
  const hasNum = () => typeof tokens[i] === "number";
  const pt = (rel: boolean): Vec2 => {
    const x = num();
    const y = num();
    return rel ? { x: pos.x + x, y: pos.y + y } : { x, y };
  };
  const ensure = () => {
    if (!cur) {
      cur = { start: { ...pos }, segments: [] };
      paths.push(cur);
    }
    return cur;
  };
  const line = (to: Vec2) => {
    ensure().segments.push({ to });
    pos = to;
    lastCtrl = lastQuad = null;
  };
  const cubic = (c1: Vec2, c2: Vec2, to: Vec2) => {
    ensure().segments.push({ c1, c2, to });
    pos = to;
    lastCtrl = c2;
    lastQuad = null;
  };

  while (i < tokens.length) {
    if (typeof tokens[i] === "string") cmd = tokens[i++] as string;
    else if (!cmd) throw new SvgImportError("Path data must start with a command.");
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case "M": {
        pos = pt(rel);
        start = { ...pos };
        cur = { start: { ...pos }, segments: [] };
        paths.push(cur);
        lastCtrl = lastQuad = null;
        cmd = rel ? "l" : "L";
        break;
      }
      case "L":
        line(pt(rel));
        break;
      case "H": {
        const x = num();
        line({ x: rel ? pos.x + x : x, y: pos.y });
        break;
      }
      case "V": {
        const y = num();
        line({ x: pos.x, y: rel ? pos.y + y : y });
        break;
      }
      case "C": {
        const c1 = pt(rel);
        const c2 = pt(rel);
        cubic(c1, c2, pt(rel));
        break;
      }
      case "S": {
        const lc = lastCtrl as Vec2 | null;
        const c1: Vec2 = lc ? { x: 2 * pos.x - lc.x, y: 2 * pos.y - lc.y } : { ...pos };
        const c2 = pt(rel);
        cubic(c1, c2, pt(rel));
        break;
      }
      case "Q":
      case "T": {
        const lq = lastQuad as Vec2 | null;
        const q: Vec2 =
          cmd.toUpperCase() === "Q" ? pt(rel) : lq ? { x: 2 * pos.x - lq.x, y: 2 * pos.y - lq.y } : { ...pos };
        const to = pt(rel);
        const from = pos;
        cubic(
          { x: from.x + (2 / 3) * (q.x - from.x), y: from.y + (2 / 3) * (q.y - from.y) },
          { x: to.x + (2 / 3) * (q.x - to.x), y: to.y + (2 / 3) * (q.y - to.y) },
          to,
        );
        lastQuad = q;
        break;
      }
      case "A": {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = num() !== 0;
        const sweep = num() !== 0;
        const to = pt(rel);
        for (const [c1, c2, end] of arcToCubics(pos, to, rx, ry, rot, large, sweep)) cubic(c1, c2, end);
        if (!(rx && ry)) line(to);
        break;
      }
      case "Z":
        if (cur && (pos.x !== start.x || pos.y !== start.y)) line({ ...start });
        pos = { ...start };
        cur = null;
        lastCtrl = lastQuad = null;
        // Z takes no numbers; a number after it is malformed.
        if (hasNum()) throw new SvgImportError("Malformed path data.");
        break;
    }
  }

  return paths.map((p) => ({
    start: apply(m, p.start),
    segments: p.segments.map((s) => ({
      c1: s.c1 && apply(m, s.c1),
      c2: s.c2 && apply(m, s.c2),
      to: apply(m, s.to),
    })),
  }));
}

/** Endpoint arc to cubic Béziers (SVG implementation notes, F.6). */
export function arcToCubics(
  p0: Vec2,
  p1: Vec2,
  rxIn: number,
  ryIn: number,
  rotDeg: number,
  large: boolean,
  sweep: boolean,
): [Vec2, Vec2, Vec2][] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (!rx || !ry || (p0.x === p1.x && p0.y === p1.y)) return [];
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2;
  const dy = (p0.y - p1.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const sign = large === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const coef = sign * Math.sqrt(Math.max(0, num / den));
  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0.x + p1.x) / 2;
  const cy = sin * cx1 + cos * cy1 + (p0.y + p1.y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;

  const parts = Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9);
  const step = delta / parts;
  const k = (4 / 3) * Math.tan(step / 4);
  const onEllipse = (t: number): Vec2 => ({
    x: cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
    y: cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos,
  });
  const derivative = (t: number): Vec2 => ({
    x: -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin,
    y: -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos,
  });
  const out: [Vec2, Vec2, Vec2][] = [];
  for (let s = 0; s < parts; s++) {
    const t0 = theta1 + s * step;
    const t1 = t0 + step;
    const a = onEllipse(t0);
    const b = s === parts - 1 ? { ...p1 } : onEllipse(t1);
    const da = derivative(t0);
    const db = derivative(t1);
    out.push([
      { x: a.x + k * da.x, y: a.y + k * da.y },
      { x: b.x - k * db.x, y: b.y - k * db.y },
      b,
    ]);
  }
  return out;
}

// ---------- Transforms ----------

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function apply(m: Matrix, p: Vec2): Vec2 {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function parseTransform(t: string | null): Matrix {
  let m: Matrix = IDENTITY;
  if (!t) return m;
  for (const [, name, args] of t.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const v = args.trim().split(/[\s,]+/).map(Number);
    let next: Matrix = IDENTITY;
    switch (name) {
      case "matrix":
        next = [v[0], v[1], v[2], v[3], v[4], v[5]];
        break;
      case "translate":
        next = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
        break;
      case "scale":
        next = [v[0], 0, 0, v[1] ?? v[0], 0, 0];
        break;
      case "rotate": {
        const a = ((v[0] ?? 0) * Math.PI) / 180;
        const r: Matrix = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
        next =
          v.length >= 3
            ? multiply(multiply([1, 0, 0, 1, v[1], v[2]], r), [1, 0, 0, 1, -v[1], -v[2]])
            : r;
        break;
      }
      case "skewX":
        next = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewY":
        next = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = multiply(m, next);
  }
  return m;
}

// ---------- To contours ----------

const near = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;

function toContours(subpaths: Subpath[], opts: ImportOptions): Contour[] {
  const all = subpaths.flatMap((s) => [s.start, ...s.segments.flatMap((g) => [g.c1, g.c2, g.to])]).filter(
    (p): p is Vec2 => !!p,
  );
  const minX = Math.min(...all.map((p) => p.x));
  const maxX = Math.max(...all.map((p) => p.x));
  const minY = Math.min(...all.map((p) => p.y));
  const maxY = Math.max(...all.map((p) => p.y));
  const scale = opts.height / (maxY - minY || 1);
  const left = opts.centerX ? opts.left - ((maxX - minX) * scale) / 2 : opts.left;
  // SVG y points down; font y points up.
  const tx = (p: Vec2): Vec2 => ({
    x: Math.round((p.x - minX) * scale + left),
    y: Math.round((maxY - p.y) * scale + opts.bottom),
  });

  return subpaths.map((sp, k) => {
    const nodes: Node[] = [{ id: 0, pos: tx(sp.start), smooth: false }];
    let id = 1;
    for (const seg of sp.segments) {
      const prev = nodes[nodes.length - 1];
      const node: Node = { id: id++, pos: tx(seg.to), smooth: false };
      if (seg.c1 && seg.c2) {
        prev.out = { id: id++, pos: tx(seg.c1) };
        node.in = { id: id++, pos: tx(seg.c2) };
      }
      nodes.push(node);
    }
    // A closing segment that lands back on the start merges into the first node.
    const last = nodes[nodes.length - 1];
    if (nodes.length > 1 && near(last.pos, nodes[0].pos)) {
      nodes[0].in = last.in;
      nodes.pop();
    }
    for (const nd of nodes) nd.smooth = isSmooth(nd);
    return fromNodes(nodes, opts.firstContourId + k, null, id);
  });
}

function isSmooth(nd: Node): boolean {
  if (!nd.in || !nd.out) return false;
  const a = Math.atan2(nd.pos.y - nd.in.pos.y, nd.pos.x - nd.in.pos.x);
  const b = Math.atan2(nd.out.pos.y - nd.pos.y, nd.out.pos.x - nd.pos.x);
  let diff = Math.abs(a - b);
  if (diff > Math.PI) diff = 2 * Math.PI - diff;
  return diff < (3 * Math.PI) / 180;
}
