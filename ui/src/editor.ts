// The outline glyph editor: canvas, tools, selection, transforms, history and
// the side panel. Edits are made on a local copy for speed and written back
// to the core (set_drawing) when each gesture ends, so every fidel that uses
// the drawing updates.

import { api, PARTS, type DrawingTarget, type DrawingView, type Part } from "./api";
import {
  clone,
  constrain45,
  contourPath,
  boundsOf,
  contoursBounds,
  convertNodes,
  ellipseContour,
  fromNodes,
  isOn,
  mirrorSmooth,
  nextContourId,
  rebuilt,
  rectContour,
  reversed,
  roundContours,
  startDirection,
  toNodes,
  translated,
  validate,
  type Box,
  type Contour,
  type Node,
  type NodeType,
  type Vec2,
} from "./geometry";
import {
  addExtremes,
  closestOnSegment,
  correctDirections,
  fixIssues,
  insertPoint,
  ISSUE_LABEL,
  makeTangent,
  outlineIssues,
  pointType,
  polygonContour,
  removePointsKeepingShape,
  rotateAbout,
  roundedRectContour,
  scaleAbout,
  segments,
  selectionBox,
  setSegmentKind,
  setStartPoint,
  insidePolygon,
  transformContours,
  transformWhole,
  translate,
  type Matrix,
  type OutlineIssue,
} from "./pathops";
import { gridStep, onPrefs, prefs } from "./prefs";
import { importSvg, SvgImportError } from "./svgImport";

/** Move selects and moves whole shapes; Direct selects points and handles. */
export type Tool = "select" | "direct" | "pen" | ShapeKind | "hand";
export type ShapeKind = "rect" | "rounded" | "ellipse" | "polygon" | "star";
export const SHAPES: ShapeKind[] = ["rect", "rounded", "ellipse", "polygon", "star"];
export const SHAPE_LABEL: Record<ShapeKind, string> = {
  rect: "Rectangle",
  rounded: "Rounded rectangle",
  ellipse: "Ellipse",
  polygon: "Polygon",
  star: "Star",
};
const isShape = (t: Tool): t is ShapeKind => (SHAPES as string[]).includes(t);

/** Snap distance, in screen pixels. */
const SNAP_PX = 6;
const HIT_PX = 8;
/** Transform handle size and the ring outside a corner that rotates. */
const HANDLE_PX = 7;
const ROTATE_PX = 18;

interface View {
  scale: number;
  tx: number;
  ty: number;
}

interface Sketch {
  href: string;
  /** Bottom-left corner and size, in font units. */
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
  /** Unlocked, the sketch can be dragged on the canvas. */
  unlocked: boolean;
}

/** Corners and edges of the transform box: which sides move. */
type Handle = { x: -1 | 0 | 1; y: -1 | 0 | 1 };

type Gesture =
  | { kind: "move"; start: Vec2; base: Contour[]; moved: boolean; lead: Vec2 | null; box: Box | null; dup: boolean }
  | { kind: "attach"; start: Vec2; origin: Vec2; base: Contour[]; moved: boolean }
  | { kind: "shape"; shape: ShapeKind; start: Vec2; now: Vec2; fromCenter: boolean }
  | { kind: "marquee"; start: Vec2; now: Vec2; mode: SelectMode }
  | { kind: "lasso"; pts: Vec2[]; mode: SelectMode }
  | { kind: "zoom"; start: Vec2; now: Vec2; out: boolean }
  | { kind: "pan"; startScreen: Vec2; view: View }
  | { kind: "pen-drag"; node: Node }
  | { kind: "sketch"; start: Vec2; origin: Vec2 }
  | { kind: "scale"; handle: Handle; start: Vec2; base: Contour[]; box: Box; moved: boolean }
  | { kind: "rotate"; center: Vec2; start: Vec2; base: Contour[]; moved: boolean; angle: number }
  | { kind: "pivot" }
  | { kind: "metric"; side: "left" | "right"; start: number; now: number; base: Contour[]; advance: number }
  | { kind: "bend"; ci: number; seg: number; t: number; start: Vec2; base: Contour[]; moved: boolean };

type SelectMode = "replace" | "add" | "remove";

/** One step of a drawing's history. `before` is the state the step started from. */
interface Step {
  before: string;
  label: string;
}

interface History {
  undo: Step[];
  redo: Step[];
  /** The state after the last step, to check the history still fits the drawing. */
  now: string;
}

export interface EditorHost {
  /** Called after a change has been written to the core. */
  changed(target: DrawingTarget): void;
  toast(message: string, tone?: "error" | "info"): void;
  /** Fill the side panel. */
  renderSide(editor: GlyphEditor): void;
  /** Open the canvas context menu at a screen point. */
  contextMenu(editor: GlyphEditor, at: { x: number; y: number }): void;
}

const key = (ci: number, pi: number) => `${ci}:${pi}`;
const parseKey = (k: string) => k.split(":").map(Number) as [number, number];

/** Marks our own paths on the system clipboard, so a paste keeps them exact. */
const CLIP_TAG = "ethiopic-font-editor/contours";

/**
 * Copied paths, in canvas units. Every drawing shares one design space, so a
 * path pasted into another glyph lands where it was. Kept here as well as on
 * the system clipboard in case the webview hides clipboard data.
 */
let clipboard: Contour[] | null = null;

export const PART_COLORS: Record<Part, string> = {
  stem: "#759d53",
  leg: "#d26f3b",
  arm: "#c9a227",
  bar: "#5f8fbf",
  branch: "#8e6bbf",
  leaf: "#3f9f8f",
  ring: "#e07a95",
  bowl: "#b5651d",
  diagonal: "#6d6e6e",
  neck: "#a0bb8b",
  break: "#b1b2b3",
};

/** Where a numeric transform is anchored: a corner, an edge middle or the centre of the selection. */
export type Anchor = { x: 0 | 0.5 | 1; y: 0 | 0.5 | 1 };

export class GlyphEditor {
  drawing: DrawingView | null = null;
  contours: Contour[] = [];
  /** Selected points as "contourIndex:pointIndex". */
  selection = new Set<string>();
  tool: Tool = "select";
  /** The shape the shape button draws. */
  shape: ShapeKind = "rect";
  sketches = new Map<string, Sketch>();
  /** Anchor for the numeric transform panel. */
  anchor: Anchor = { x: 0.5, y: 0.5 };
  /** The last transform applied, for "repeat". */
  lastTransform: { m: (box: Box) => Matrix; label: string } | null = null;

  private view: View = { scale: 0.5, tx: 100, ty: 500 };
  /** For an alteration: its attach point on the context base. Contours are
   * shown and edited at origin + stored position, so the part sits where it
   * lands on the base and the canvas keeps the base's frame. */
  origin: Vec2 = { x: 0, y: 0 };
  private contextKey = "";
  /** Where rotations and Alt-scaling turn around; the box centre when unset. */
  private pivot: Vec2 | null = null;
  /** Guides shown while a drag snaps. */
  private snapLines: { x?: number; y?: number } = {};
  private gesture: Gesture | null = null;
  private pen: Node[] | null = null;
  private cursor: Vec2 | null = null;
  private spaceHeld = false;
  /** Z held down: click zooms in, Alt-click out, drag zooms to an area. */
  private zoomHeld = false;
  /** The drawing's advance as last saved; differs from drawing.advanceWidth while a metric drag runs. */
  private savedAdvance: number | null = null;
  /** Each drawing keeps its own undo history. */
  private histories = new Map<string, History>();
  private history: History = { undo: [], redo: [], now: "" };
  private saving: Promise<void> = Promise.resolve();
  private issuesCache: { state: string; issues: OutlineIssue[] } | null = null;

  readonly svg: SVGSVGElement;
  private readonly zoomLabel: HTMLElement;
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly coords: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly host: EditorHost,
  ) {
    this.svg = root.querySelector<SVGSVGElement>(".canvas")!;
    this.zoomLabel = root.querySelector(".zoom-label")!;
    this.title = root.querySelector(".editor-title")!;
    this.subtitle = root.querySelector(".editor-subtitle")!;
    this.coords = root.querySelector(".coords")!;
    this.bindCanvas();
    this.bindChrome();
    new ResizeObserver(() => this.render()).observe(this.svg);
    onPrefs(() => this.render());
  }

  get target(): DrawingTarget | null {
    return this.drawing?.target ?? null;
  }

  get targetKey(): string {
    return this.target ? `${this.target.kind}:${this.target.id}` : "";
  }

  get sketch(): Sketch | undefined {
    return this.sketches.get(this.targetKey);
  }

  async open(target: DrawingTarget, contextFamily?: string): Promise<void> {
    const sameDrawing = this.target && this.target.kind === target.kind && this.target.id === target.id;
    this.drawing = await api.getDrawing(target, contextFamily);
    const contextKey = this.drawing.context?.family ?? "";
    const sameFrame = sameDrawing && contextKey === this.contextKey;
    this.contextKey = contextKey;
    this.origin = this.drawing.context ? { ...this.drawing.context.origin } : { x: 0, y: 0 };
    this.contours = translated(this.drawing.contours, this.origin);
    this.savedAdvance = this.drawing.advanceWidth;
    // Pick up this drawing's own history, if it still matches what the core has.
    const k = this.targetKey;
    const now = this.snapshot();
    const kept = this.histories.get(k);
    this.history = kept && kept.now === now ? kept : { undo: [], redo: [], now };
    this.histories.set(k, this.history);
    if (!sameFrame) {
      this.selection.clear();
      this.pivot = null;
      this.pen = null;
      this.fit();
    }
    this.title.textContent = this.drawing.title;
    this.subtitle.textContent = this.drawing.subtitle;
    this.render();
    this.host.renderSide(this);
  }

  /** Forget the open drawing, e.g. after another project is opened. */
  reset(): void {
    this.drawing = null;
    this.contours = [];
    this.selection.clear();
    this.pen = null;
    this.histories.clear();
    this.history = { undo: [], redo: [], now: "" };
    this.origin = { x: 0, y: 0 };
    this.contextKey = "";
    this.sketches.clear();
    this.svg.innerHTML = "";
  }

  // ---------- Coordinates ----------

  private toScreen(p: Vec2): Vec2 {
    return { x: p.x * this.view.scale + this.view.tx, y: -p.y * this.view.scale + this.view.ty };
  }

  private toFont(e: { clientX: number; clientY: number }): Vec2 {
    const r = this.svg.getBoundingClientRect();
    return {
      x: (e.clientX - r.left - this.view.tx) / this.view.scale,
      y: -(e.clientY - r.top - this.view.ty) / this.view.scale,
    };
  }

  private screenOf(e: { clientX: number; clientY: number }): Vec2 {
    const r = this.svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  fit(): void {
    if (!this.drawing) return;
    const r = this.svg.getBoundingClientRect();
    const w = r.width || 800;
    const h = r.height || 600;
    const m = this.drawing.metrics;
    // Frame the drawing like its base: same advance, same Pa band, so moving
    // between a base and its alterations never shifts the design space.
    const frame = this.frameWidth;
    const b = contoursBounds(this.visibleContours());
    const loose = frame === null;
    const minX = Math.min(b?.minX ?? 0, loose ? this.origin.x - 300 : 0);
    const maxX = Math.max(b?.maxX ?? 0, frame ?? 0, loose ? this.origin.x + 300 : 0);
    const minY = Math.min(b?.minY ?? 0, m.pa_bottom - 150);
    const maxY = Math.max(b?.maxY ?? 0, m.pa_top + 150);
    const scale = Math.min((w - 160) / (maxX - minX || 1), (h - 180) / (maxY - minY || 1));
    this.view = {
      scale,
      tx: (w - (maxX - minX) * scale) / 2 - minX * scale + 30,
      ty: (h - 60 - (maxY - minY) * scale) / 2 + maxY * scale,
    };
    this.render();
  }

  /** The advance the canvas is framed on: the drawing's own, or its context base's. */
  get frameWidth(): number | null {
    return this.drawing?.advanceWidth ?? this.drawing?.context?.advanceWidth ?? null;
  }

  zoom(factor: number, around?: Vec2): void {
    const r = this.svg.getBoundingClientRect();
    const sx = around?.x ?? r.width / 2;
    const sy = around?.y ?? r.height / 2;
    const scale = Math.min(8, Math.max(0.05, this.view.scale * factor));
    const f = scale / this.view.scale;
    this.view = { scale, tx: sx - (sx - this.view.tx) * f, ty: sy - (sy - this.view.ty) * f };
    this.render();
  }

  get scale(): number {
    return this.view.scale;
  }

  /** Frame a box of font units, with some room around it. */
  zoomTo(b: Box): void {
    const r = this.svg.getBoundingClientRect();
    const w = r.width || 800;
    const h = r.height || 600;
    const bw = Math.max(b.maxX - b.minX, 1);
    const bh = Math.max(b.maxY - b.minY, 1);
    const scale = Math.min(8, Math.max(0.05, Math.min((w - 120) / bw, (h - 160) / bh)));
    this.view = {
      scale,
      tx: w / 2 - ((b.minX + b.maxX) / 2) * scale,
      ty: (h - 40) / 2 + ((b.minY + b.maxY) / 2) * scale,
    };
    this.render();
  }

  /** Zoom to the selected points, or to the whole drawing when nothing is selected. */
  zoomToSelection(): void {
    const pts = this.selection.size
      ? [...this.selection].map((k) => {
          const [ci, pi] = parseKey(k);
          return this.contours[ci].points[pi].pos;
        })
      : this.visibleContours().flatMap((c) => c.points.map((p) => p.pos));
    const b = boundsOf(pts);
    if (!b) return this.fit();
    // A single point gets a sensible neighbourhood instead of the maximum zoom.
    const pad = Math.max(0, 60 - Math.min(b.maxX - b.minX, b.maxY - b.minY));
    this.zoomTo({ minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad });
  }

  /** 100%: one font unit to one screen pixel, centred where the view is. */
  actualSize(): void {
    this.zoom(1 / this.view.scale);
  }

  // ---------- Layers: lock and hide ----------

  private visibleContours(): Contour[] {
    return this.contours.filter((c) => !c.hidden);
  }

  /** Whether a contour can be picked on the canvas. */
  private pickable(ci: number): boolean {
    const c = this.contours[ci];
    return !!c && !c.hidden && !c.locked;
  }

  /** Lock or hide the given contours (or toggle when `on` is undefined). */
  setLayerFlag(flag: "locked" | "hidden", cis: number[], on?: boolean): void {
    if (!cis.length) return;
    const value = on ?? !cis.every((ci) => this.contours[ci]?.[flag]);
    for (const ci of cis) {
      const c = this.contours[ci];
      if (!c) continue;
      if (value) c[flag] = true;
      else delete c[flag];
    }
    // A locked or hidden contour can't stay selected.
    if (value) this.selection = new Set([...this.selection].filter((k) => this.pickable(parseKey(k)[0])));
    this.commit(value ? (flag === "locked" ? "Lock" : "Hide") : flag === "locked" ? "Unlock" : "Show");
    this.changedSelection();
  }

  /** Unlock or show every contour. */
  clearLayerFlag(flag: "locked" | "hidden"): void {
    this.setLayerFlag(
      flag,
      this.contours.map((_, ci) => ci).filter((ci) => this.contours[ci][flag]),
      false,
    );
  }

  // ---------- Hit testing ----------

  private hitPoint(screen: Vec2): [number, number] | null {
    let best: [number, number] | null = null;
    let bestD = HIT_PX;
    this.contours.forEach((c, ci) => {
      if (!this.pickable(ci)) return;
      c.points.forEach((p, pi) => {
        const s = this.toScreen(p.pos);
        const d = Math.hypot(s.x - screen.x, s.y - screen.y);
        // Prefer handles when they sit on top of their point.
        if (d < bestD || (d === bestD && !isOn(p))) {
          bestD = d;
          best = [ci, pi];
        }
      });
    });
    return best;
  }

  /** The segment under the pointer, if any: contour, segment index and parameter. */
  private hitSegment(font: Vec2): { ci: number; seg: number; t: number } | null {
    let best: { ci: number; seg: number; t: number } | null = null;
    let bestD = HIT_PX / this.view.scale;
    this.contours.forEach((c, ci) => {
      if (!this.pickable(ci)) return;
      segments(c).forEach((s, si) => {
        const hit = closestOnSegment(s.pts, font);
        if (hit.d < bestD) {
          bestD = hit.d;
          best = { ci, seg: si, t: hit.t };
        }
      });
    });
    return best;
  }

  /** The topmost contour whose filled area contains the point. */
  private hitShape(e: { target: EventTarget | null }): number | null {
    const shape = (e.target as Element | null)?.closest?.<SVGElement>("[data-ci]");
    return shape ? Number(shape.dataset.ci) : null;
  }

  // ---------- Transform box ----------

  /** What the transform box surrounds: whole contours with Move, selected points with Direct. */
  transformBox(): Box | null {
    if (!this.selection.size) return null;
    if (this.tool === "select") return contoursBounds(this.selectedContours().map((ci) => this.contours[ci]));
    if (this.tool === "direct") {
      const onCurve = [...this.selection].filter((k) => {
        const [ci, pi] = parseKey(k);
        const p = this.contours[ci]?.points[pi];
        return p && isOn(p);
      });
      if (onCurve.length < 2) return null;
      const b = selectionBox(this.contours, new Set(onCurve));
      if (!b || (b.maxX - b.minX < 1 && b.maxY - b.minY < 1)) return null;
      return b;
    }
    return null;
  }

  /** The point the box turns around: a moved pivot, or the box centre. */
  pivotOf(b: Box): Vec2 {
    return this.pivot ?? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  }

  private hitBox(screen: Vec2): { kind: "scale"; handle: Handle } | { kind: "rotate" } | { kind: "pivot" } | null {
    const b = this.transformBox();
    if (!b) return null;
    const p0 = this.toScreen({ x: b.minX, y: b.maxY });
    const p1 = this.toScreen({ x: b.maxX, y: b.minY });
    if (this.tool === "select") {
      const pv = this.toScreen(this.pivotOf(b));
      if (Math.hypot(pv.x - screen.x, pv.y - screen.y) < 6) return { kind: "pivot" };
    }
    const xs: [number, -1 | 0 | 1][] = [[p0.x, -1], [(p0.x + p1.x) / 2, 0], [p1.x, 1]];
    const ys: [number, -1 | 0 | 1][] = [[p0.y, 1], [(p0.y + p1.y) / 2, 0], [p1.y, -1]];
    const tiny = p1.x - p0.x < 24 || p1.y - p0.y < 24;
    for (const [x, hx] of xs) {
      for (const [y, hy] of ys) {
        if (hx === 0 && hy === 0) continue;
        if (tiny && (hx === 0 || hy === 0)) continue;
        if (Math.abs(screen.x - x) <= HANDLE_PX && Math.abs(screen.y - y) <= HANDLE_PX) return { kind: "scale", handle: { x: hx, y: hy } };
      }
    }
    // Edges scale along their whole length.
    const inX = screen.x > p0.x && screen.x < p1.x;
    const inY = screen.y > p0.y && screen.y < p1.y;
    if (inY && Math.abs(screen.x - p0.x) <= 4) return { kind: "scale", handle: { x: -1, y: 0 } };
    if (inY && Math.abs(screen.x - p1.x) <= 4) return { kind: "scale", handle: { x: 1, y: 0 } };
    if (inX && Math.abs(screen.y - p0.y) <= 4) return { kind: "scale", handle: { x: 0, y: 1 } };
    if (inX && Math.abs(screen.y - p1.y) <= 4) return { kind: "scale", handle: { x: 0, y: -1 } };
    // Just outside a corner rotates.
    for (const [x] of [xs[0], xs[2]]) {
      for (const [y] of [ys[0], ys[2]]) {
        const d = Math.hypot(screen.x - x, screen.y - y);
        const outside = screen.x < p0.x || screen.x > p1.x || screen.y < p0.y || screen.y > p1.y;
        if (outside && d > HANDLE_PX && d <= ROTATE_PX) return { kind: "rotate" };
      }
    }
    return null;
  }

  private hitMetric(screen: Vec2): "left" | "right" | null {
    if (this.drawing?.advanceWidth == null || this.tool !== "select") return null;
    if (Math.abs(screen.x - this.toScreen({ x: 0, y: 0 }).x) <= 4) return "left";
    if (Math.abs(screen.x - this.toScreen({ x: this.drawing.advanceWidth, y: 0 }).x) <= 4) return "right";
    return null;
  }

  /** Apply a transform to what is selected: whole contours with Move, points with Direct. */
  private transformed(base: Contour[], m: Matrix): Contour[] {
    if (this.tool === "select") return transformWhole(base, m, new Set(this.selectedContours()));
    return transformContours(base, m, (ci, pi) => this.selection.has(key(ci, pi)));
  }

  /** Transform the selection by a matrix built from its box, and remember it for "repeat". */
  applyTransform(build: (box: Box) => Matrix, label: string): void {
    const b = this.transformBox() ?? contoursBounds(this.selectedContours().map((ci) => this.contours[ci]));
    if (!b) return;
    this.contours = this.transformed(this.contours, build(b));
    roundContours(this.contours);
    this.lastTransform = { m: build, label };
    this.commit(label);
    this.changedSelection();
  }

  repeatTransform(): void {
    const t = this.lastTransform;
    if (t) this.applyTransform(t.m, t.label);
  }

  /** The panel's anchor point on a box. */
  anchorOf(b: Box): Vec2 {
    return { x: b.minX + (b.maxX - b.minX) * this.anchor.x, y: b.minY + (b.maxY - b.minY) * this.anchor.y };
  }

  /** Set the selection's position or size from the panel, keeping the anchor where it is. */
  setSelectionBox(change: { x?: number; y?: number; w?: number; h?: number }): void {
    const b = this.transformBox();
    if (!b) return;
    const a = this.anchorOf(b);
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    if (change.x !== undefined || change.y !== undefined) {
      const dx = change.x !== undefined ? change.x - a.x : 0;
      const dy = change.y !== undefined ? change.y - a.y : 0;
      this.applyTransform(() => translate(dx, dy), "Move");
      this.lastTransform = null;
      return;
    }
    const sx = change.w !== undefined && w > 0 ? change.w / w : 1;
    const sy = change.h !== undefined && h > 0 ? change.h / h : 1;
    this.applyTransform((bx) => scaleAbout(this.anchorOf(bx), sx, sy), "Resize");
  }

  /** Align selected contours (Move) or points (Direct) to the selection's edge or centre. */
  align(edge: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom"): void {
    const b = this.transformBox();
    if (!b) return;
    const target =
      edge === "left" ? b.minX : edge === "right" ? b.maxX : edge === "hcenter" ? (b.minX + b.maxX) / 2
      : edge === "bottom" ? b.minY : edge === "top" ? b.maxY : (b.minY + b.maxY) / 2;
    const horizontal = edge === "left" || edge === "right" || edge === "hcenter";
    if (this.tool === "select") {
      for (const ci of this.selectedContours()) {
        const cb = contoursBounds([this.contours[ci]]);
        if (!cb) continue;
        const at = horizontal
          ? edge === "left" ? cb.minX : edge === "right" ? cb.maxX : (cb.minX + cb.maxX) / 2
          : edge === "bottom" ? cb.minY : edge === "top" ? cb.maxY : (cb.minY + cb.maxY) / 2;
        const d = target - at;
        this.contours = transformContours(this.contours, horizontal ? translate(d, 0) : translate(0, d), (c) => c === ci);
      }
    } else {
      const m = (ci: number, pi: number) => this.selection.has(key(ci, pi)) && isOn(this.contours[ci].points[pi]);
      const moves: [number, number, number][] = [];
      this.contours.forEach((c, ci) =>
        c.points.forEach((p, pi) => {
          if (m(ci, pi)) moves.push([ci, pi, target - (horizontal ? p.pos.x : p.pos.y)]);
        }),
      );
      for (const [ci, pi, d] of moves) {
        this.contours = transformContours(this.contours, horizontal ? translate(d, 0) : translate(0, d), (c, p) => c === ci && p === pi);
      }
    }
    roundContours(this.contours);
    this.commit("Align");
    this.changedSelection();
  }

  /** Space the selected contours (or points) evenly between the outermost two. */
  distribute(axis: "x" | "y"): void {
    type Item = { at: number; move: (d: number) => void };
    const items: Item[] = [];
    if (this.tool === "select") {
      for (const ci of this.selectedContours()) {
        const cb = contoursBounds([this.contours[ci]])!;
        items.push({
          at: axis === "x" ? (cb.minX + cb.maxX) / 2 : (cb.minY + cb.maxY) / 2,
          move: (d) => (this.contours = transformContours(this.contours, axis === "x" ? translate(d, 0) : translate(0, d), (c) => c === ci)),
        });
      }
    } else {
      for (const k of this.selection) {
        const [ci, pi] = parseKey(k);
        const p = this.contours[ci]?.points[pi];
        if (!p || !isOn(p)) continue;
        items.push({
          at: p.pos[axis],
          move: (d) => (this.contours = transformContours(this.contours, axis === "x" ? translate(d, 0) : translate(0, d), (c, q) => c === ci && q === pi)),
        });
      }
    }
    if (items.length < 3) return;
    items.sort((a, b) => a.at - b.at);
    const first = items[0].at;
    const step = (items[items.length - 1].at - first) / (items.length - 1);
    items.forEach((it, i) => it.move(first + step * i - it.at));
    roundContours(this.contours);
    this.commit("Distribute");
    this.changedSelection();
  }

  // ---------- Canvas events ----------

  private bindCanvas(): void {
    const svg = this.svg;
    svg.addEventListener("pointerdown", (e) => this.onDown(e));
    svg.addEventListener("pointermove", (e) => this.onMove(e));
    svg.addEventListener("pointerup", (e) => this.onUp(e));
    svg.addEventListener("pointercancel", () => (this.gesture = null));
    svg.addEventListener("dblclick", (e) => this.onDoubleClick(e));
    svg.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    svg.addEventListener("pointerleave", () => {
      this.cursor = null;
      this.coords.textContent = "";
      if (this.pen) this.render();
    });
    svg.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        // Like Figma: two-finger scroll pans, pinch (sent as Ctrl+wheel) and
        // Ctrl+scroll zoom around the pointer, Shift+scroll pans sideways.
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        let dx = e.deltaX * unit;
        let dy = e.deltaY * unit;
        if (e.ctrlKey || e.metaKey) {
          const step = Math.max(-60, Math.min(60, dy));
          this.zoom(Math.exp(-step * 0.01), this.screenOf(e));
          return;
        }
        if (e.shiftKey && dx === 0) [dx, dy] = [dy, 0];
        this.view = { ...this.view, tx: this.view.tx - dx, ty: this.view.ty - dy };
        this.render();
      },
      { passive: false },
    );
  }

  private onDown(e: PointerEvent): void {
    if (!this.drawing || e.button === 2) return;
    this.svg.setPointerCapture(e.pointerId);
    const screen = this.screenOf(e);
    const font = this.toFont(e);
    const mode: SelectMode = e.shiftKey ? "add" : e.ctrlKey || e.metaKey ? "remove" : "replace";

    if (this.tool === "hand" || this.spaceHeld || e.button === 1) {
      this.gesture = { kind: "pan", startScreen: screen, view: { ...this.view } };
      return;
    }

    if (this.zoomHeld) {
      this.gesture = { kind: "zoom", start: font, now: font, out: e.altKey };
      return;
    }

    if (this.tool === "pen") {
      // Clicking a segment with the pen, outside a path in progress, adds a point on it.
      if (!this.pen) {
        const seg = this.hitPoint(screen) ? null : this.hitSegment(font);
        if (seg) {
          this.addPointOn(seg.ci, seg.seg, seg.t);
          return;
        }
      }
      this.penDown(this.penTarget(font, e), screen);
      return;
    }

    if (isShape(this.tool)) {
      // Ctrl turns snapping off here, since Alt draws from the centre.
      const at = this.snapped(font, { altKey: e.ctrlKey || e.metaKey }).pos;
      this.gesture = { kind: "shape", shape: this.tool, start: at, now: at, fromCenter: e.altKey };
      return;
    }

    // The attach point of an alteration can be dragged with either selection tool.
    if (this.hitAttach(screen)) {
      this.gesture = { kind: "attach", start: font, origin: { ...this.origin }, base: clone(this.contours), moved: false };
      return;
    }

    // Transform box handles come before points and shapes.
    const boxHit = this.hitBox(screen);
    if (boxHit) {
      const b = this.transformBox()!;
      if (boxHit.kind === "pivot") this.gesture = { kind: "pivot" };
      else if (boxHit.kind === "rotate") this.gesture = { kind: "rotate", center: this.pivotOf(b), start: font, base: clone(this.contours), moved: false, angle: 0 };
      else this.gesture = { kind: "scale", handle: boxHit.handle, start: font, base: clone(this.contours), box: b, moved: false };
      return;
    }

    const direct = this.tool === "direct";
    const hit = direct ? this.hitPoint(screen) : null;
    if (hit) {
      const k = key(...hit);
      if (e.shiftKey) {
        if (this.selection.has(k)) {
          this.selection.delete(k);
          this.changedSelection();
          return;
        }
        this.selection.add(k);
      } else if (!this.selection.has(k)) {
        this.selection = new Set([k]);
      }
      const lead = { ...this.contours[hit[0]].points[hit[1]].pos };
      this.gesture = { kind: "move", start: font, base: clone(this.contours), moved: false, lead, box: null, dup: false };
      this.changedSelection();
      return;
    }

    if (direct) {
      const seg = this.hitSegment(font);
      if (seg) {
        if (e.altKey && segments(this.contours[seg.ci])[seg.seg].pts.length === 2 && !e.shiftKey) {
          // Alt-drag a line: it becomes a curve and bends.
          const c = this.contours[seg.ci];
          const nodes = toNodes(c);
          const s = segments(c)[seg.seg];
          this.contours[seg.ci] = setSegmentKind(c, new Set([nodes[s.from].id, nodes[s.to].id]), "curve");
          this.gesture = { kind: "bend", ci: seg.ci, seg: seg.seg, t: seg.t, start: font, base: clone(this.contours), moved: false };
          return;
        }
        if (e.altKey) {
          this.addPointOn(seg.ci, seg.seg, seg.t);
          return;
        }
        // Grab a curve segment to bend it; a line segment selects its two points and moves them.
        const c = this.contours[seg.ci];
        const s = segments(c)[seg.seg];
        if (s.pts.length === 4) {
          this.gesture = { kind: "bend", ci: seg.ci, seg: seg.seg, t: seg.t, start: font, base: clone(this.contours), moved: false };
          return;
        }
        const nodes = toNodes(c);
        const ends = [nodes[s.from].id, nodes[s.to].id].map((id) => key(seg.ci, c.points.findIndex((p) => p.id === id)));
        if (!e.shiftKey) this.selection.clear();
        for (const k of ends) this.selection.add(k);
        this.gesture = { kind: "move", start: font, base: clone(this.contours), moved: false, lead: null, box: null, dup: false };
        this.changedSelection();
        return;
      }
    }

    const ci = this.hitShape(e);
    const shape = ci !== null && this.pickable(ci) ? ci : null;
    const inBox = !direct && this.selectionBoxHit(font);
    if (shape !== null || inBox) {
      if (shape !== null) {
        const already = this.contours[shape].points.every((_, pi) => this.selection.has(key(shape, pi)));
        if (!already && !e.shiftKey) this.selection.clear();
        this.selectContour(shape);
      }
      const box = contoursBounds(this.selectedContours().map((c) => this.contours[c]));
      this.gesture = { kind: "move", start: font, base: clone(this.contours), moved: false, lead: null, box, dup: e.altKey };
      this.changedSelection();
      return;
    }

    const metric = this.hitMetric(screen);
    if (metric) {
      const adv = this.drawing.advanceWidth ?? 0;
      const at = metric === "left" ? 0 : adv;
      this.gesture = { kind: "metric", side: metric, start: at, now: at, base: clone(this.contours), advance: adv };
      return;
    }

    const sk = this.sketch;
    if (sk?.unlocked && font.x >= sk.x && font.x <= sk.x + sk.w && font.y >= sk.y && font.y <= sk.y + sk.h) {
      this.gesture = { kind: "sketch", start: font, origin: { x: sk.x, y: sk.y } };
      return;
    }

    if (mode === "replace") this.selection.clear();
    this.pivot = null;
    // Alt-drag draws a lasso; a plain drag draws a rectangle.
    this.gesture = e.altKey ? { kind: "lasso", pts: [font], mode } : { kind: "marquee", start: font, now: font, mode };
    this.changedSelection();
  }

  private onMove(e: PointerEvent): void {
    const font = this.toFont(e);
    this.cursor = font;
    this.coords.textContent = `${Math.round(font.x)}, ${Math.round(font.y)}`;
    const g = this.gesture;
    if (!g) {
      if (this.pen) {
        this.cursor = this.penTarget(font, e);
        this.render();
      }
      this.updateHoverCursor(this.screenOf(e), font);
      return;
    }
    this.snapLines = {};
    switch (g.kind) {
      case "pan": {
        const s = this.screenOf(e);
        this.view = {
          ...g.view,
          tx: g.view.tx + s.x - g.startScreen.x,
          ty: g.view.ty + s.y - g.startScreen.y,
        };
        break;
      }
      case "move": {
        let to = font;
        if (e.shiftKey) to = constrain45(g.start, to);
        let dx = to.x - g.start.x;
        let dy = to.y - g.start.y;
        if (!e.altKey || g.dup) {
          if (g.lead) {
            // Direct selection: the grabbed point snaps.
            const want = { x: g.lead.x + dx, y: g.lead.y + dy };
            const s = this.snapped(want, { altKey: false }, true);
            if (!e.shiftKey || s.lines.x !== undefined || s.lines.y !== undefined) {
              dx = s.pos.x - g.lead.x;
              dy = s.pos.y - g.lead.y;
            }
            this.snapLines = s.lines;
          } else if (g.box) {
            const s = this.snapBox(g.box, dx, dy, !e.shiftKey || Math.abs(dx) > Math.abs(dy), !e.shiftKey || Math.abs(dy) >= Math.abs(dx));
            dx = s.dx;
            dy = s.dy;
            this.snapLines = s.lines;
          }
        }
        g.moved ||= Math.hypot(dx, dy) * this.view.scale > 1;
        if (g.dup && g.moved) {
          // Alt-drag a shape: move a copy, like Figma.
          const picked = this.selectedContours();
          const first = nextContourId(g.base);
          const copies = picked.map((ci, k) => ({ ...clone(g.base[ci]), id: first + k }));
          const start = g.base.length;
          const withCopies = [...clone(g.base), ...copies];
          this.selection = new Set(copies.flatMap((c, k) => c.points.map((_, pi) => key(start + k, pi))));
          this.contours = transformContours(withCopies, translate(dx, dy), (ci) => ci >= start);
        } else {
          this.contours = this.moved(g.base, dx, dy);
        }
        break;
      }
      case "attach": {
        const to = e.shiftKey ? constrain45(g.start, font) : font;
        let d = { x: to.x - g.start.x, y: to.y - g.start.y };
        if (!e.altKey) {
          const s = this.snapped({ x: g.origin.x + d.x, y: g.origin.y + d.y }, e, false);
          d = { x: s.pos.x - g.origin.x, y: s.pos.y - g.origin.y };
          this.snapLines = s.lines;
        }
        d = { x: Math.round(d.x), y: Math.round(d.y) };
        g.moved ||= Math.hypot(d.x, d.y) > 0;
        this.origin = { x: g.origin.x + d.x, y: g.origin.y + d.y };
        this.contours = translated(g.base, d);
        break;
      }
      case "shape": {
        let to = this.snapped(font, { altKey: e.ctrlKey || e.metaKey }).pos;
        if (e.shiftKey) {
          const side = Math.max(Math.abs(to.x - g.start.x), Math.abs(to.y - g.start.y));
          to = { x: g.start.x + Math.sign(to.x - g.start.x || 1) * side, y: g.start.y + Math.sign(to.y - g.start.y || 1) * side };
        }
        g.now = to;
        g.fromCenter = e.altKey;
        break;
      }
      case "marquee":
      case "zoom":
        g.now = font;
        break;
      case "lasso":
        g.pts.push(font);
        break;
      case "pen-drag": {
        let h = font;
        if (e.shiftKey) h = constrain45(g.node.pos, h);
        const d = { x: h.x - g.node.pos.x, y: h.y - g.node.pos.y };
        if (Math.hypot(d.x, d.y) * this.view.scale > 3) {
          g.node.out = { id: -1, pos: { x: g.node.pos.x + d.x, y: g.node.pos.y + d.y } };
          g.node.in = { id: -1, pos: { x: g.node.pos.x - d.x, y: g.node.pos.y - d.y } };
          g.node.smooth = true;
        }
        break;
      }
      case "sketch": {
        const sk = this.sketch;
        if (sk) {
          sk.x = Math.round(g.origin.x + font.x - g.start.x);
          sk.y = Math.round(g.origin.y + font.y - g.start.y);
        }
        break;
      }
      case "scale": {
        const b = g.box;
        const fixed = e.altKey
          ? this.pivotOf(b)
          : { x: g.handle.x === 1 ? b.minX : g.handle.x === -1 ? b.maxX : (b.minX + b.maxX) / 2, y: g.handle.y === 1 ? b.minY : g.handle.y === -1 ? b.maxY : (b.minY + b.maxY) / 2 };
        const from = { x: g.handle.x === 1 ? b.maxX : b.minX, y: g.handle.y === 1 ? b.maxY : b.minY };
        let sx = 1;
        let sy = 1;
        if (g.handle.x !== 0 && Math.abs(from.x - fixed.x) > 1e-6) sx = (font.x - fixed.x) / (from.x - fixed.x);
        if (g.handle.y !== 0 && Math.abs(from.y - fixed.y) > 1e-6) sy = (font.y - fixed.y) / (from.y - fixed.y);
        if (e.shiftKey) {
          if (g.handle.x === 0) sx = Math.abs(sy) * Math.sign(sx || 1);
          else if (g.handle.y === 0) sy = Math.abs(sx) * Math.sign(sy || 1);
          else {
            const s = Math.max(Math.abs(sx), Math.abs(sy));
            sx = s * Math.sign(sx || 1);
            sy = s * Math.sign(sy || 1);
          }
        }
        g.moved = true;
        this.contours = this.transformed(g.base, scaleAbout(fixed, sx, sy));
        break;
      }
      case "rotate": {
        const a0 = Math.atan2(g.start.y - g.center.y, g.start.x - g.center.x);
        const a1 = Math.atan2(font.y - g.center.y, font.x - g.center.x);
        let deg = ((a1 - a0) * 180) / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        g.angle = deg;
        g.moved = true;
        this.contours = this.transformed(g.base, rotateAbout(g.center, deg));
        break;
      }
      case "pivot": {
        this.pivot = this.snapped(font, e).pos;
        break;
      }
      case "metric": {
        let x = this.snapped({ x: font.x, y: 0 }, e).pos.x;
        x = Math.round(x);
        g.now = x;
        const d = x - g.start;
        if (g.side === "left") {
          this.contours = translated(g.base, { x: -d, y: 0 });
          this.drawing!.advanceWidth = Math.max(0, g.advance - d);
        } else {
          this.drawing!.advanceWidth = Math.max(0, g.advance + d);
        }
        break;
      }
      case "bend": {
        const d = { x: font.x - g.start.x, y: font.y - g.start.y };
        g.moved ||= Math.hypot(d.x, d.y) * this.view.scale > 1;
        // Move both handles so the curve passes through the pointer at t:
        // each handle takes a share of the pull by how near t is to its end.
        const t = Math.min(0.9, Math.max(0.1, g.t));
        const k = 1 / (3 * t * (1 - t) * ((1 - t) * (1 - t) + t * t));
        const c = clone(g.base[g.ci]);
        const s = segments(c)[g.seg];
        const nodes = toNodes(c);
        const a = nodes[s.from];
        const b = nodes[s.to];
        if (a.out) a.out.pos = { x: a.out.pos.x + d.x * k * (1 - t), y: a.out.pos.y + d.y * k * (1 - t) };
        if (b.in) b.in.pos = { x: b.in.pos.x + d.x * k * t, y: b.in.pos.y + d.y * k * t };
        const out = clone(g.base);
        out[g.ci] = rebuilt(c, nodes);
        this.contours = out;
        break;
      }
    }
    this.render();
  }

  /** Show what a press would do: resize, rotate or a metric line. */
  private updateHoverCursor(screen: Vec2, font: Vec2): void {
    let cursor = "";
    if (!this.spaceHeld && !this.zoomHeld && (this.tool === "select" || this.tool === "direct")) {
      const hb = this.hitBox(screen);
      if (hb?.kind === "rotate") cursor = "rotate";
      else if (hb?.kind === "pivot") cursor = "pivot";
      else if (hb?.kind === "scale") {
        const { x, y } = hb.handle;
        cursor = x === 0 ? "ns" : y === 0 ? "ew" : x === y ? "nesw" : "nwse";
      } else if (this.hitMetric(screen) && this.hitShapeAt(screen) === null) cursor = "ew";
      else if (this.tool === "direct" && !this.hitPoint(screen) && this.hitSegment(font)) cursor = "segment";
    } else if (this.tool === "pen" && !this.pen && !this.hitPoint(screen) && this.hitSegment(font)) cursor = "add";
    if (cursor) this.svg.dataset.hover = cursor;
    else delete this.svg.dataset.hover;
  }

  private hitShapeAt(screen: Vec2): number | null {
    const r = this.svg.getBoundingClientRect();
    const el = document.elementFromPoint?.(screen.x + r.left, screen.y + r.top);
    return this.hitShape({ target: el });
  }

  private onUp(e: PointerEvent): void {
    const g = this.gesture;
    this.gesture = null;
    this.snapLines = {};
    if (!g) return;
    if (g.kind === "move" && g.moved) {
      roundContours(this.contours);
      this.commit(g.dup ? "Duplicate" : g.lead ? "Move points" : "Move");
      if (g.dup) this.host.renderSide(this);
    } else if (g.kind === "attach" && g.moved) {
      void this.saveAttach();
    } else if (g.kind === "shape") {
      this.finishShape(g);
    } else if ((g.kind === "scale" || g.kind === "rotate") && g.moved) {
      roundContours(this.contours);
      this.commit(g.kind === "scale" ? "Scale" : `Rotate ${Math.round(g.angle)}°`);
      this.host.renderSide(this);
    } else if (g.kind === "metric") {
      if (g.now !== g.start) {
        this.commit(g.side === "left" ? "Left sidebearing" : "Width");
        this.host.renderSide(this);
      }
    } else if (g.kind === "bend" && g.moved) {
      roundContours(this.contours);
      this.commit("Bend curve");
    } else if (g.kind === "zoom") {
      const dragged = Math.hypot(g.now.x - g.start.x, g.now.y - g.start.y) * this.view.scale > 4;
      if (dragged && !g.out) {
        this.zoomTo({
          minX: Math.min(g.start.x, g.now.x),
          minY: Math.min(g.start.y, g.now.y),
          maxX: Math.max(g.start.x, g.now.x),
          maxY: Math.max(g.start.y, g.now.y),
        });
      } else this.zoom(g.out ? 0.5 : 2, this.toScreen(g.now));
    } else if (g.kind === "marquee" || g.kind === "lasso") {
      const inside =
        g.kind === "marquee"
          ? (p: Vec2) =>
              p.x >= Math.min(g.start.x, g.now.x) && p.x <= Math.max(g.start.x, g.now.x) &&
              p.y >= Math.min(g.start.y, g.now.y) && p.y <= Math.max(g.start.y, g.now.y)
          : (p: Vec2) => g.pts.length > 2 && insidePolygon(g.pts, p);
      const picked: string[] = [];
      this.contours.forEach((c, ci) => {
        if (!this.pickable(ci)) return;
        const pts = c.points.map((p, pi) => [p, pi] as const).filter(([p]) => inside(p.pos));
        if (!pts.length) return;
        // Move selects whole shapes; Direct selects only the points inside.
        if (this.tool === "direct") for (const [, pi] of pts) picked.push(key(ci, pi));
        else c.points.forEach((_, pi) => picked.push(key(ci, pi)));
      });
      for (const k of picked) {
        if (g.mode === "remove") this.selection.delete(k);
        else this.selection.add(k);
      }
      this.host.renderSide(this);
    }
    if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
    this.render();
  }

  private finishShape(g: Extract<Gesture, { kind: "shape" }>): void {
    const a = g.fromCenter ? { x: 2 * g.start.x - g.now.x, y: 2 * g.start.y - g.now.y } : g.start;
    const b = g.now;
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    if (w * this.view.scale <= 2 || h * this.view.scale <= 2) return;
    const id = nextContourId(this.contours);
    const c =
      g.shape === "rect" ? rectContour(id, a, b)
      : g.shape === "rounded" ? roundedRectContour(id, a, b, prefs.cornerRadius)
      : g.shape === "ellipse" ? ellipseContour(id, a, b)
      : g.shape === "polygon" ? polygonContour(id, a, b, prefs.polygonSides)
      : polygonContour(id, a, b, prefs.starPoints, prefs.starInner);
    c.name = SHAPE_LABEL[g.shape];
    const ci = this.contours.length;
    this.contours.push(c);
    this.selection = new Set(c.points.map((_, pi) => key(ci, pi)));
    this.commit(SHAPE_LABEL[g.shape]);
    this.host.renderSide(this);
  }

  private onDoubleClick(e: MouseEvent): void {
    if (this.hitAttach(this.screenOf(e))) {
      this.resetAttach();
      return;
    }
    const screen = this.screenOf(e);
    if (this.tool === "select") {
      // Double-clicking a shape goes into its points, like Figma.
      const ci = this.hitShape(e);
      if (ci !== null && this.pickable(ci)) this.setTool("direct");
      return;
    }
    if (this.tool !== "direct") return;
    const hit = this.hitPoint(screen);
    if (!hit) {
      // Double-click a segment: select its whole path.
      const seg = this.hitSegment(this.toFont(e));
      if (seg) {
        this.selectContour(seg.ci, !e.shiftKey);
        this.changedSelection();
      }
      return;
    }
    const p = this.contours[hit[0]].points[hit[1]];
    if (!isOn(p)) return;
    this.setNodeType(p.smooth ? "corner" : "smooth");
  }

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    if (!this.drawing) return;
    const screen = this.screenOf(e);
    const font = this.toFont(e);
    // Right-click picks what is under the pointer, like a left click, unless it is already selected.
    if (this.tool === "direct") {
      const hit = this.hitPoint(screen);
      if (hit && !this.selection.has(key(...hit))) this.selection = new Set([key(...hit)]);
      else if (!hit) {
        const seg = this.hitSegment(font);
        if (seg) {
          const c = this.contours[seg.ci];
          const s = segments(c)[seg.seg];
          const nodes = toNodes(c);
          const ends = [nodes[s.from].id, nodes[s.to].id].map((id) => key(seg.ci, c.points.findIndex((p) => p.id === id)));
          if (!ends.every((k) => this.selection.has(k))) this.selection = new Set(ends);
        }
      }
    } else if (this.tool === "select") {
      const ci = this.hitShape(e);
      if (ci !== null && this.pickable(ci) && !this.selectedContours().includes(ci)) {
        this.selection.clear();
        this.selectContour(ci);
      }
    }
    this.changedSelection();
    this.host.contextMenu(this, { x: e.clientX, y: e.clientY });
  }

  private changedSelection(): void {
    this.render();
    this.host.renderSide(this);
  }

  /** Add every point of one contour to the selection. */
  selectContour(ci: number, only = false): void {
    if (only) this.selection.clear();
    if (!this.pickable(ci)) return;
    this.contours[ci]?.points.forEach((_, pi) => this.selection.add(key(ci, pi)));
  }

  /** Select one layer, from the layers panel. */
  selectLayer(ci: number, additive: boolean): void {
    if (this.tool !== "select" && this.tool !== "direct") this.setTool("select");
    this.selectContour(ci, !additive);
    this.changedSelection();
  }

  renameLayer(ci: number, name: string): void {
    const c = this.contours[ci];
    if (!c) return;
    c.name = name.trim() || null;
    this.commit("Rename");
    this.changedSelection();
  }

  private selectionBoxHit(font: Vec2): boolean {
    if (!this.selection.size) return false;
    const b = contoursBounds(this.selectedContours().map((ci) => this.contours[ci]));
    return !!b && font.x >= b.minX && font.x <= b.maxX && font.y >= b.minY && font.y <= b.maxY;
  }

  private hitAttach(screen: Vec2): boolean {
    if (!this.drawing?.context) return false;
    const s = this.toScreen(this.origin);
    return Math.hypot(s.x - screen.x, s.y - screen.y) < HIT_PX + 4;
  }

  // ---------- Selection commands ----------

  /** Select the next (or previous) on-curve point along the path, like Tab in Glyphs. */
  stepPoint(dir: 1 | -1): void {
    if (this.tool !== "direct") this.setTool("direct");
    const onCurve: [number, number][] = [];
    this.contours.forEach((c, ci) => {
      if (this.pickable(ci)) c.points.forEach((p, pi) => isOn(p) && onCurve.push([ci, pi]));
    });
    if (!onCurve.length) return;
    const cur = [...this.selection].map(parseKey).find(([ci, pi]) => {
      const p = this.contours[ci]?.points[pi];
      return !!p && isOn(p);
    });
    let next: [number, number];
    if (!cur) next = dir === 1 ? onCurve[0] : onCurve[onCurve.length - 1];
    else {
      // Stay on the same contour, wrapping around it.
      const [ci, pi] = cur;
      const same = onCurve.filter(([c]) => c === ci);
      const i = same.findIndex(([, p]) => p === pi);
      next = same[(i + dir + same.length) % same.length];
    }
    this.selection = new Set([key(...next)]);
    this.changedSelection();
  }

  invertSelection(): void {
    const all = this.contours.flatMap((c, ci) => (this.pickable(ci) ? c.points.map((_, pi) => key(ci, pi)) : []));
    if (this.tool === "select") {
      const sel = new Set(this.selectedContours());
      this.selection = new Set(all.filter((k) => !sel.has(parseKey(k)[0])));
    } else {
      this.selection = new Set(all.filter((k) => !this.selection.has(k)));
    }
    this.changedSelection();
  }

  /** Every point of the same type as the selected ones (corner, smooth, tangent or handle). */
  selectSimilar(): void {
    const types = new Set([...this.selection].map((k) => {
      const [ci, pi] = parseKey(k);
      return pointType(this.contours[ci], pi);
    }));
    if (!types.size) return;
    this.setTool("direct");
    this.selection = new Set();
    this.contours.forEach((c, ci) => {
      if (!this.pickable(ci)) return;
      c.points.forEach((_, pi) => types.has(pointType(c, pi)) && this.selection.add(key(ci, pi)));
    });
    this.changedSelection();
  }

  /** Every on-curve point on the same horizontal or vertical line as the selected point. */
  selectOnLine(axis: "x" | "y"): void {
    const first = [...this.selection].map(parseKey)[0];
    if (!first) return;
    const v = this.contours[first[0]].points[first[1]].pos[axis];
    this.setTool("direct");
    this.selection = new Set();
    this.contours.forEach((c, ci) => {
      if (!this.pickable(ci)) return;
      c.points.forEach((p, pi) => isOn(p) && Math.abs(p.pos[axis] - v) < 0.5 && this.selection.add(key(ci, pi)));
    });
    this.changedSelection();
  }

  // ---------- Snapping ----------

  /** Lines a point can snap to: other on-curve points, the Pa lines, the sidebearings. */
  private snapTargets(skipSelected: boolean): { xs: number[]; ys: number[] } {
    const m = this.drawing!.metrics;
    const xs: number[] = [];
    const ys: number[] = [];
    if (prefs.snapMetrics) {
      xs.push(0);
      ys.push(m.pa_top, m.pa_bottom, 0);
      const frame = this.frameWidth;
      if (frame !== null) xs.push(frame);
      if (this.drawing?.context) {
        xs.push(this.origin.x);
        ys.push(this.origin.y);
      }
    }
    if (prefs.snapZones) {
      for (const z of this.drawing?.zones ?? []) ys.push(z.position, z.position + z.size);
    }
    if (prefs.snapPoints) {
      this.contours.forEach((c, ci) => {
        if (c.hidden) return;
        c.points.forEach((p, pi) => {
          if (!isOn(p) || (skipSelected && this.selection.has(key(ci, pi)))) return;
          xs.push(p.pos.x);
          ys.push(p.pos.y);
        });
      });
    }
    return { xs, ys };
  }

  private snapped(p: Vec2, e: { altKey: boolean }, skipSelected = false): { pos: Vec2; lines: { x?: number; y?: number } } {
    if (e.altKey || !this.drawing) return { pos: p, lines: {} };
    const { xs, ys } = this.snapTargets(skipSelected);
    const tol = SNAP_PX / this.view.scale;
    const near = (v: number, list: number[]) => {
      let best: number | undefined;
      for (const t of list) if (Math.abs(t - v) <= tol && (best === undefined || Math.abs(t - v) < Math.abs(best - v))) best = t;
      return best;
    };
    const x = near(p.x, xs);
    const y = near(p.y, ys);
    const step = gridStep();
    const onGrid = (v: number) => Math.round(v / step) * step;
    return {
      pos: { x: x ?? (prefs.snapGrid ? onGrid(p.x) : p.x), y: y ?? (prefs.snapGrid ? onGrid(p.y) : p.y) },
      lines: { x, y },
    };
  }

  /** Snap a moving bounding box by its edges. */
  private snapBox(b: Box, dx: number, dy: number, allowX: boolean, allowY: boolean) {
    const { xs, ys } = this.snapTargets(true);
    const tol = SNAP_PX / this.view.scale;
    const lines: { x?: number; y?: number } = {};
    const fit = (edges: number[], list: number[]) => {
      let best: { shift: number; line: number } | null = null;
      for (const edge of edges)
        for (const t of list) {
          const shift = t - edge;
          if (Math.abs(shift) <= tol && (!best || Math.abs(shift) < Math.abs(best.shift))) best = { shift, line: t };
        }
      return best;
    };
    const step = gridStep();
    if (allowX) {
      const f = fit([b.minX + dx, b.maxX + dx], xs);
      if (f) {
        dx += f.shift;
        lines.x = f.line;
      } else if (prefs.snapGrid) dx = Math.round((b.minX + dx) / step) * step - b.minX;
    } else dx = 0;
    if (allowY) {
      const f = fit([b.minY + dy, b.maxY + dy], ys);
      if (f) {
        dy += f.shift;
        lines.y = f.line;
      } else if (prefs.snapGrid) dy = Math.round((b.minY + dy) / step) * step - b.minY;
    } else dy = 0;
    return { dx, dy, lines };
  }

  /** Where the pen would put its next point: Shift keeps 0/45/90° from the last one, then it snaps. */
  private penTarget(font: Vec2, e: { shiftKey: boolean; altKey: boolean }): Vec2 {
    const last = this.pen?.[this.pen.length - 1];
    let p = font;
    if (e.shiftKey && last) p = constrain45(last.pos, p);
    const s = this.snapped(p, e);
    // Keep the angle when only one axis snapped.
    if (e.shiftKey && last) {
      this.snapLines = {};
      return p;
    }
    this.snapLines = s.lines;
    return s.pos;
  }

  // ---------- Attach point ----------

  private async saveAttach(): Promise<void> {
    const ctx = this.drawing?.context;
    const target = this.target;
    if (!ctx || target?.kind !== "alteration") return;
    const offset = { x: Math.round(this.origin.x - ctx.autoOrigin.x), y: Math.round(this.origin.y - ctx.autoOrigin.y) };
    try {
      await api.setAttachOffset(ctx.family, target.id, offset);
      ctx.origin = { ...this.origin };
      // History is kept relative to the attach point, so it still applies.
      this.host.changed(target);
      this.host.renderSide(this);
    } catch (err) {
      this.host.toast(`Could not move the attach point: ${err}`, "error");
    }
  }

  /** Put the attach point at (x, y) for the context family. */
  setAttachOrigin(x: number, y: number): void {
    if (!this.drawing?.context) return;
    const d = { x: Math.round(x) - this.origin.x, y: Math.round(y) - this.origin.y };
    this.origin = { x: this.origin.x + d.x, y: this.origin.y + d.y };
    this.contours = translated(this.contours, d);
    this.render();
    void this.saveAttach();
  }

  resetAttach(): void {
    const ctx = this.drawing?.context;
    if (ctx) this.setAttachOrigin(ctx.autoOrigin.x, ctx.autoOrigin.y);
  }

  /** Points of `base` with the selection moved by (dx, dy). Handles follow their point. */
  private moved(base: Contour[], dx: number, dy: number): Contour[] {
    const out = clone(base);
    const follow = new Set<string>();
    out.forEach((c, ci) => {
      const n = c.points.length;
      c.points.forEach((p, pi) => {
        if (!this.selection.has(key(ci, pi)) || !isOn(p)) return;
        for (const j of [(pi - 1 + n) % n, (pi + 1) % n]) {
          if (!isOn(c.points[j])) follow.add(key(ci, j));
        }
      });
    });
    const singleHandle = this.selection.size === 1 ? parseKey([...this.selection][0]) : null;
    out.forEach((c, ci) =>
      c.points.forEach((p, pi) => {
        const k = key(ci, pi);
        if (this.selection.has(k) || follow.has(k)) p.pos = { x: p.pos.x + dx, y: p.pos.y + dy };
      }),
    );
    if (singleHandle && !isOn(out[singleHandle[0]].points[singleHandle[1]])) {
      mirrorSmooth(out[singleHandle[0]], singleHandle[1]);
    }
    return out;
  }

  // ---------- Pen ----------

  private penDown(font: Vec2, screen: Vec2): void {
    const pos = { x: Math.round(font.x), y: Math.round(font.y) };
    if (!this.pen) {
      this.selection.clear();
      this.pen = [];
    }
    const first = this.pen[0];
    if (first && this.pen.length >= 2) {
      const s = this.toScreen(first.pos);
      if (Math.hypot(s.x - screen.x, s.y - screen.y) < HIT_PX + 2) {
        this.finishPen();
        return;
      }
    }
    const node: Node = { id: -1, pos, smooth: false };
    this.pen.push(node);
    this.gesture = { kind: "pen-drag", node };
    this.render();
  }

  finishPen(): void {
    const nodes = this.pen;
    this.pen = null;
    if (!nodes || nodes.length < 2) {
      this.render();
      return;
    }
    let id = 0;
    for (const nd of nodes) {
      nd.id = id++;
      if (nd.in) nd.in = { id: id++, pos: { x: Math.round(nd.in.pos.x), y: Math.round(nd.in.pos.y) } };
      if (nd.out) nd.out = { id: id++, pos: { x: Math.round(nd.out.pos.x), y: Math.round(nd.out.pos.y) } };
    }
    const ci = this.contours.length;
    const contour = fromNodes(nodes, nextContourId(this.contours), null, id);
    this.contours.push(contour);
    this.selection = new Set(contour.points.map((_, pi) => key(ci, pi)));
    this.commit("Pen path");
    this.render();
  }

  cancelPen(): void {
    this.pen = null;
    this.render();
  }

  // ---------- Edits ----------

  setTool(tool: Tool): void {
    if (this.pen && tool !== "pen") this.finishPen();
    if (isShape(tool)) this.shape = tool;
    this.tool = tool;
    this.root.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) => {
      const t = b.dataset.tool;
      b.classList.toggle("active", t === tool || (t === "shape" && isShape(tool)));
    });
    this.root.querySelectorAll<HTMLElement>("[data-shape-icon]").forEach((icon) => {
      icon.hidden = icon.dataset.shapeIcon !== this.shape;
    });
    this.svg.dataset.tool = isShape(tool) ? "shape" : tool;
    this.render();
    this.host.renderSide(this);
  }

  selectAll(): void {
    this.selection = new Set(this.contours.flatMap((c, ci) => (this.pickable(ci) ? c.points.map((_, pi) => key(ci, pi)) : [])));
    this.render();
    this.host.renderSide(this);
  }

  nudge(dx: number, dy: number): void {
    if (!this.selection.size) return;
    this.contours = this.moved(this.contours, dx, dy);
    this.commit("Nudge");
    this.render();
    this.host.renderSide(this);
  }

  /** Whole contours with a selected point, the way Figma copies shapes. */
  private copiedContours(): Contour[] {
    return clone(this.selectedContours().map((ci) => this.contours[ci]));
  }

  /** Copy the selected paths. Returns the clipboard text, or null when nothing is selected. */
  copy(): { json: string; svg: string } | null {
    const picked = this.copiedContours();
    if (!picked.length) return null;
    clipboard = picked;
    const b = contoursBounds(picked)!;
    const d = picked.map(contourPath).join("");
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.minX} ${-b.maxY} ${b.maxX - b.minX} ${b.maxY - b.minY}">` +
      `<path transform="scale(1 -1)" d="${d}"/></svg>`;
    return { json: JSON.stringify({ [CLIP_TAG]: picked }), svg };
  }

  cut(): { json: string; svg: string } | null {
    const out = this.copy();
    if (!out) return null;
    const gone = new Set(this.selectedContours());
    this.contours = this.contours.filter((_, ci) => !gone.has(ci));
    this.selection.clear();
    this.commit("Cut");
    this.render();
    this.host.renderSide(this);
    return out;
  }

  /** Paste copied paths in place, selected. `text` is the system clipboard, when we have it. */
  pastePaths(text?: string): boolean {
    let picked = clipboard;
    if (text) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && Array.isArray(parsed[CLIP_TAG])) picked = parsed[CLIP_TAG];
        else return false;
      } catch {
        return false;
      }
    }
    if (!picked?.length || !this.drawing) return false;
    this.insertContours(clone(picked), "Paste");
    return true;
  }

  /** Duplicate the selected contours in place, selected. */
  duplicate(): void {
    const picked = this.copiedContours();
    if (!picked.length) return;
    this.insertContours(picked, "Duplicate");
  }

  private insertContours(picked: Contour[], label: string): void {
    const first = nextContourId(this.contours);
    const pasted = picked.map((c, k) => {
      const out = { ...c, id: first + k };
      delete out.locked;
      delete out.hidden;
      return out;
    });
    const start = this.contours.length;
    this.contours.push(...pasted);
    if (this.tool !== "select" && this.tool !== "direct") this.setTool("select");
    this.selection = new Set(pasted.flatMap((c, k) => c.points.map((_, pi) => key(start + k, pi))));
    this.commit(label);
    this.render();
    this.host.renderSide(this);
  }

  /**
   * Delete what is selected. Whole contours go; single on-curve points are
   * removed keeping the curve's shape, the way Glyphs does it.
   */
  deleteSelection(keepShape = true): void {
    if (!this.selection.size) return;
    const next: Contour[] = [];
    this.contours.forEach((c, ci) => {
      const picked = c.points.filter((_, pi) => this.selection.has(key(ci, pi)));
      if (!picked.length) {
        next.push(c);
        return;
      }
      if (picked.length === c.points.length) return;
      const onIds = new Set(picked.filter(isOn).map((p) => p.id));
      const handleIds = new Set(picked.filter((p) => !isOn(p)).map((p) => p.id));
      let cur: Contour | null = c;
      if (onIds.size) {
        if (keepShape) cur = removePointsKeepingShape(c, onIds);
        else {
          const nodes = toNodes(c).filter((nd) => !onIds.has(nd.id));
          cur = nodes.length >= 2 ? rebuilt(c, nodes, Math.max(...c.points.map((p) => p.id)) + 1) : null;
        }
      }
      if (cur && handleIds.size) {
        // Deleting a handle retracts it.
        const nodes = toNodes(cur);
        for (const nd of nodes) {
          if (nd.in && handleIds.has(nd.in.id)) nd.in.pos = { ...nd.pos };
          if (nd.out && handleIds.has(nd.out.id)) nd.out.pos = { ...nd.pos };
        }
        cur = rebuilt(cur, nodes);
      }
      if (cur && toNodes(cur).length >= 2) next.push(cur);
    });
    this.contours = next;
    this.selection.clear();
    this.commit("Delete");
    this.render();
    this.host.renderSide(this);
  }

  /** Add an on-curve point on a segment without changing the outline, and select it. */
  addPointOn(ci: number, seg: number, t: number): void {
    const res = insertPoint(this.contours[ci], seg, t);
    this.contours[ci] = res.contour;
    if (this.tool !== "direct" && this.tool !== "pen") this.setTool("direct");
    this.selection = new Set([key(ci, res.contour.points.findIndex((p) => p.id === res.id))]);
    this.commit("Add point");
    this.changedSelection();
  }

  /**
   * Rebuild the contours that hold selected points, then select the same
   * points again by id, since rebuilding can renumber them.
   */
  private editSelectedContours(fn: (c: Contour, ids: Set<number>) => Contour, label: string, all = false): void {
    const picked = new Map<number, Set<number>>();
    for (const k of this.selection) {
      const [ci, pi] = parseKey(k);
      const p = this.contours[ci]?.points[pi];
      if (!p) continue;
      if (!picked.has(ci)) picked.set(ci, new Set());
      picked.get(ci)!.add(p.id);
    }
    if (all && !picked.size) this.contours.forEach((_, ci) => picked.set(ci, new Set()));
    if (!picked.size) return;
    for (const [ci, ids] of picked) this.contours[ci] = fn(this.contours[ci], ids);
    this.selection = new Set();
    for (const [ci, ids] of picked) {
      this.contours[ci].points.forEach((p, pi) => ids.has(p.id) && this.selection.add(key(ci, pi)));
    }
    this.commit(label);
    this.render();
    this.host.renderSide(this);
  }

  /** Corner, smooth, tangent, or retract the handles of the selected on-curve points. */
  setNodeType(to: NodeType | "tangent"): void {
    const label = { corner: "Corner point", smooth: "Smooth point", retract: "Retract handles", tangent: "Tangent point" }[to];
    this.editSelectedContours((c, ids) => (to === "tangent" ? makeTangent(c, ids) : convertNodes(c, ids, to)), label);
  }

  /** Corner → smooth → tangent → corner, for the selected points. */
  cycleNodeType(): void {
    const types = this.selectedNodes().map((n) => n.type);
    if (!types.length) return;
    const next = types.every((t) => t === "corner") ? "smooth" : types.every((t) => t === "smooth") ? "tangent" : "corner";
    this.setNodeType(next);
  }

  /** Turn the segments between selected points into curves or lines. */
  setSegmentKind(to: "curve" | "line"): void {
    this.editSelectedContours((c, ids) => setSegmentKind(c, ids, to), to === "curve" ? "Make curve" : "Make line");
  }

  /** Reverse the direction of the selected contours, or of every contour when nothing is selected. */
  reverseDirection(): void {
    this.editSelectedContours((c) => reversed(c), "Reverse direction", true);
  }

  /** Outer paths counter-clockwise, counters clockwise, for the whole drawing. */
  correctDirection(): void {
    const ids = new Map<number, Set<number>>();
    for (const k of this.selection) {
      const [ci, pi] = parseKey(k);
      if (!ids.has(ci)) ids.set(ci, new Set());
      ids.get(ci)!.add(this.contours[ci].points[pi].id);
    }
    this.contours = correctDirections(this.contours);
    this.selection = new Set();
    for (const [ci, set] of ids) this.contours[ci].points.forEach((p, pi) => set.has(p.id) && this.selection.add(key(ci, pi)));
    this.commit("Correct path direction");
    this.changedSelection();
  }

  /** Make the selected on-curve point its contour's start point. */
  setStartPoint(): void {
    const on = [...this.selection].map(parseKey).filter(([ci, pi]) => isOn(this.contours[ci].points[pi]));
    if (on.length !== 1) return;
    const [ci, pi] = on[0];
    const id = this.contours[ci].points[pi].id;
    this.contours[ci] = setStartPoint(this.contours[ci], id);
    this.selection = new Set([key(ci, this.contours[ci].points.findIndex((p) => p.id === id))]);
    this.commit("Set start point");
    this.changedSelection();
  }

  addExtremes(): void {
    this.editSelectedContours((c) => addExtremes(c), "Add extremes", true);
  }

  /** Round the selected points (or the whole drawing) to whole units. */
  roundCoordinates(): void {
    roundContours(this.contours);
    this.commit("Round coordinates");
    this.render();
  }

  /** Outline problems in the drawing, for the canvas markers and the side panel. */
  issues(): OutlineIssue[] {
    const state = JSON.stringify(this.contours);
    if (this.issuesCache?.state !== state) {
      const shown = this.contours.map((c, ci) => ({ c, ci })).filter(({ c }) => !c.hidden);
      const found = outlineIssues(shown.map((s) => s.c)).map((i) => ({ ...i, contour: shown[i.contour].ci }));
      this.issuesCache = { state, issues: found };
    }
    return this.issuesCache.issues;
  }

  /** Fix every safe outline problem. */
  fixOutline(): void {
    this.contours = fixIssues(this.contours);
    roundContours(this.contours);
    this.selection.clear();
    this.commit("Fix outline");
    this.changedSelection();
  }

  /** The selected on-curve points. */
  selectedNodes(): { smooth: boolean; handles: boolean; type: "corner" | "smooth" | "tangent" }[] {
    return [...this.selection].flatMap((k) => {
      const [ci, pi] = parseKey(k);
      const c = this.contours[ci];
      const p = c?.points[pi];
      if (!p || !isOn(p)) return [];
      const n = c.points.length;
      const handles = !isOn(c.points[(pi - 1 + n) % n]) || !isOn(c.points[(pi + 1) % n]);
      return [{ smooth: !!p.smooth, handles, type: pointType(c, pi) as "corner" | "smooth" | "tangent" }];
    });
  }

  /** Whether two selected on-curve points are neighbours, so their segment can change kind. */
  selectedSegments(): { lines: number; curves: number } {
    let lines = 0;
    let curves = 0;
    const byContour = new Map<number, Set<number>>();
    for (const k of this.selection) {
      const [ci, pi] = parseKey(k);
      const p = this.contours[ci]?.points[pi];
      if (!p || !isOn(p)) continue;
      if (!byContour.has(ci)) byContour.set(ci, new Set());
      byContour.get(ci)!.add(p.id);
    }
    for (const [ci, ids] of byContour) {
      const c = this.contours[ci];
      const nodes = toNodes(c);
      for (const s of segments(c)) {
        if (ids.has(nodes[s.from].id) && ids.has(nodes[s.to].id)) {
          if (s.pts.length === 2) lines++;
          else curves++;
        }
      }
    }
    return { lines, curves };
  }

  /** Contours with at least one selected point. */
  selectedContours(): number[] {
    return [...new Set([...this.selection].map((k) => parseKey(k)[0]))].sort((a, b) => a - b);
  }

  setPart(part: Part | null): void {
    for (const ci of this.selectedContours()) this.contours[ci].part = part;
    this.commit("Part tag");
    this.render();
    this.host.renderSide(this);
  }

  setPointPosition(x: number, y: number): void {
    if (this.selection.size !== 1) return;
    const [ci, pi] = parseKey([...this.selection][0]);
    const p = this.contours[ci].points[pi];
    this.contours = this.moved(this.contours, x - p.pos.x, y - p.pos.y);
    roundContours(this.contours);
    this.commit("Move point");
    this.render();
  }

  // ---------- Metrics ----------

  /** Left and right sidebearings of the visible outline, when the drawing has an advance. */
  sidebearings(): { lsb: number; rsb: number; width: number } | null {
    const w = this.drawing?.advanceWidth;
    if (w == null) return null;
    const b = contoursBounds(this.visibleContours().length ? this.visibleContours() : this.contours);
    if (!b) return { lsb: 0, rsb: w, width: w };
    return { lsb: Math.round(b.minX), rsb: Math.round(w - b.maxX), width: w };
  }

  async setAdvance(width: number): Promise<void> {
    if (!this.drawing || !this.target || this.target.kind === "alteration") return;
    this.drawing.advanceWidth = Math.max(0, Math.round(width));
    this.commit("Width");
    this.render();
    this.host.renderSide(this);
  }

  /** Set the left or right sidebearing: the left moves the outline, the right changes the width. */
  setSidebearing(side: "left" | "right", value: number): void {
    const sb = this.sidebearings();
    if (!sb || !this.drawing) return;
    const v = Math.round(value);
    if (side === "left") {
      const d = v - sb.lsb;
      this.contours = translated(this.contours, { x: d, y: 0 });
      this.drawing.advanceWidth = (this.drawing.advanceWidth ?? 0) + d;
    } else {
      this.drawing.advanceWidth = (this.drawing.advanceWidth ?? 0) + (v - sb.rsb);
    }
    this.commit(side === "left" ? "Left sidebearing" : "Right sidebearing");
    this.render();
    this.host.renderSide(this);
  }

  /** Put the outline in the middle of its width. */
  centerInWidth(): void {
    const sb = this.sidebearings();
    if (!sb) return;
    const d = Math.round((sb.rsb - sb.lsb) / 2);
    if (!d) return;
    this.contours = translated(this.contours, { x: d, y: 0 });
    this.commit("Center in width");
    this.render();
    this.host.renderSide(this);
  }

  pasteSvg(text: string): void {
    if (!this.drawing) return;
    try {
      const m = this.drawing.metrics;
      const pa = m.pa_top - m.pa_bottom;
      // A base fills the Pa-height. An alteration is a small part: it is
      // scaled to a quarter of that and hung just below its attach point.
      const isBase = this.drawing.target.kind !== "alteration";
      const raw = importSvg(text, {
        height: isBase ? pa : Math.round(pa / 4),
        bottom: isBase ? m.pa_bottom : -Math.round(pa / 4),
        left: isBase ? 50 : 0,
        centerX: !isBase,
        firstContourId: nextContourId(this.contours),
      });
      const imported = isBase ? raw : translated(raw, this.origin);
      const start = this.contours.length;
      this.contours.push(...imported);
      this.selection = new Set(
        imported.flatMap((c, k) => c.points.map((_, pi) => key(start + k, pi))),
      );
      this.commit("Import SVG");
      this.fit();
      this.host.renderSide(this);
      this.host.toast(
        `Pasted ${imported.length} contour${imported.length === 1 ? "" : "s"}${isBase ? ", scaled to the Pa-height" : ""}.`,
        "info",
      );
    } catch (err) {
      this.host.toast(err instanceof SvgImportError ? err.message : `Could not import SVG: ${err}`, "error");
    }
  }

  loadSketch(file: File): void {
    if (!this.drawing) return;
    const reader = new FileReader();
    reader.onload = () => {
      const href = String(reader.result);
      const img = new Image();
      img.onload = () => {
        const m = this.drawing!.metrics;
        const h = m.pa_top - m.pa_bottom;
        const w = (img.naturalWidth / img.naturalHeight) * h;
        this.sketches.set(this.targetKey, { href, x: 0, y: m.pa_bottom, w, h, opacity: 0.35, unlocked: false });
        this.render();
        this.host.renderSide(this);
      };
      img.src = href;
    };
    reader.readAsDataURL(file);
  }

  updateSketch(change: Partial<Pick<Sketch, "opacity" | "x" | "y" | "unlocked">> & { scale?: number }): void {
    const sk = this.sketch;
    if (!sk) return;
    if (change.opacity !== undefined) sk.opacity = change.opacity;
    if (change.x !== undefined) sk.x = change.x;
    if (change.y !== undefined) sk.y = change.y;
    if (change.unlocked !== undefined) sk.unlocked = change.unlocked;
    if (change.scale !== undefined) {
      const m = this.drawing!.metrics;
      const base = m.pa_top - m.pa_bottom;
      const ratio = sk.w / sk.h;
      sk.h = base * change.scale;
      sk.w = sk.h * ratio;
    }
    this.render();
  }

  removeSketch(): void {
    this.sketches.delete(this.targetKey);
    this.render();
    this.host.renderSide(this);
  }

  // ---------- History and saving ----------

  /** The drawing as stored: contours relative to the attach point, plus the advance. */
  private snapshot(): string {
    const stored = translated(this.contours, { x: -this.origin.x, y: -this.origin.y });
    return JSON.stringify({ c: stored, w: this.drawing?.advanceWidth ?? null });
  }

  get canUndo(): boolean {
    return this.history.undo.length > 0;
  }

  get canRedo(): boolean {
    return this.history.redo.length > 0;
  }

  /** The steps of this drawing's history, oldest first, and how many are applied. */
  get steps(): { labels: string[]; applied: number } {
    return {
      labels: [...this.history.undo.map((s) => s.label), ...[...this.history.redo].reverse().map((s) => s.label)],
      applied: this.history.undo.length,
    };
  }

  private commit(label: string): void {
    const now = this.snapshot();
    if (now === this.history.now) return;
    for (const c of this.contours) {
      const problem = validate(c);
      if (problem) {
        this.host.toast(`That edit would break contour ${c.id} (${problem}). Undone.`, "error");
        this.restoreState(this.history.now);
        return;
      }
    }
    this.history.undo.push({ before: this.history.now, label });
    if (this.history.undo.length > 300) this.history.undo.shift();
    this.history.redo = [];
    this.history.now = now;
    this.persist();
  }

  undo(): void {
    const step = this.history.undo.pop();
    if (!step) return;
    this.history.redo.push({ before: this.history.now, label: step.label });
    this.history.now = step.before;
    this.applyHistory();
  }

  redo(): void {
    const step = this.history.redo.pop();
    if (!step) return;
    this.history.undo.push({ before: this.history.now, label: step.label });
    this.history.now = step.before;
    this.applyHistory();
  }

  /** Go back or forward to the point where `applied` steps are done. */
  jumpTo(applied: number): void {
    while (this.history.undo.length > applied && this.history.undo.length) {
      const step = this.history.undo.pop()!;
      this.history.redo.push({ before: this.history.now, label: step.label });
      this.history.now = step.before;
    }
    while (this.history.undo.length < applied && this.history.redo.length) {
      const step = this.history.redo.pop()!;
      this.history.undo.push({ before: this.history.now, label: step.label });
      this.history.now = step.before;
    }
    this.applyHistory();
  }

  private applyHistory(): void {
    this.restoreState(this.history.now);
    this.selection.clear();
    this.persist();
    this.render();
    this.host.renderSide(this);
  }

  private restoreState(state: string): void {
    const s = JSON.parse(state) as { c: Contour[]; w: number | null };
    this.contours = translated(s.c, this.origin);
    if (this.drawing && s.w !== null) this.drawing.advanceWidth = s.w;
  }

  private persist(): void {
    const target = this.target;
    if (!target) return;
    // Alterations are stored relative to their attach point.
    const s = JSON.parse(this.history.now) as { c: Contour[]; w: number | null };
    const widthChanged = s.w !== null && s.w !== this.savedAdvance && target.kind !== "alteration";
    if (widthChanged) this.savedAdvance = s.w;
    // Keep writes in order.
    this.saving = this.saving
      .then(() => api.setDrawing(target, s.c))
      .then(() => (widthChanged ? api.setAdvance(target, s.w!) : undefined))
      .then(() => this.host.changed(target))
      .catch((err) => this.host.toast(`Could not save the drawing: ${err}`, "error"));
  }

  // ---------- Chrome: tool palette, bottom bar, keys, paste ----------

  private bindChrome(): void {
    this.root.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) =>
      b.addEventListener("click", () => {
        const t = b.dataset.tool!;
        this.setTool(t === "shape" ? this.shape : (t as Tool));
      }),
    );
    this.bindShapeMenu();
    const on = (action: string, fn: () => void) =>
      this.root.querySelector(`[data-action=${action}]`)?.addEventListener("click", fn);
    on("zoom-in", () => this.zoom(1.25));
    on("zoom-out", () => this.zoom(0.8));
    on("fit", () => this.fit());
    this.bindZoomMenu();
    on("import-svg", () => this.root.querySelector<HTMLInputElement>(".svg-file")!.click());
    on("import-image", () => this.root.querySelector<HTMLInputElement>(".image-file")!.click());
    this.root.querySelector<HTMLInputElement>(".image-file")!.addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (file) this.loadSketch(file);
      input.value = "";
    });
    this.root.querySelector<HTMLInputElement>(".svg-file")!.addEventListener("change", async (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (file) this.pasteSvg(await file.text());
      input.value = "";
    });
    const toClipboard = (e: ClipboardEvent, out: { json: string; svg: string } | null) => {
      if (!out) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", out.json);
      e.clipboardData?.setData("image/svg+xml", out.svg);
    };
    window.addEventListener("copy", (e) => {
      if (this.isActive() && !isTyping(e.target)) toClipboard(e, this.copy());
    });
    window.addEventListener("cut", (e) => {
      if (this.isActive() && !isTyping(e.target)) toClipboard(e, this.cut());
    });
    window.addEventListener("paste", (e) => {
      if (!this.isActive() || isTyping(e.target)) return;
      const plain = e.clipboardData?.getData("text/plain") ?? "";
      // Our own paths first, exactly where they were copied from.
      if (plain.includes(CLIP_TAG) && this.pastePaths(plain)) {
        e.preventDefault();
        return;
      }
      const text = e.clipboardData?.getData("image/svg+xml") || plain;
      if (text.trim()) {
        e.preventDefault();
        this.pasteSvg(text);
      } else if (clipboard) {
        e.preventDefault();
        this.pastePaths();
      }
    });

    window.addEventListener("keydown", (e) => {
      if (!this.isActive() || isTyping(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (k.startsWith("arrow")) {
        e.preventDefault();
        const [small, medium, large] = prefs.nudge;
        const step = mod ? large : e.shiftKey ? medium : small;
        const d = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, step], arrowdown: [0, -step] }[k];
        if (d) this.nudge(d[0], d[1]);
        return;
      }
      if (k === "tab") {
        e.preventDefault();
        this.stepPoint(e.shiftKey ? -1 : 1);
        return;
      }
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (mod && k === "y") {
        e.preventDefault();
        this.redo();
      } else if (mod && e.shiftKey && k === "i") {
        e.preventDefault();
        this.invertSelection();
      } else if (mod && k === "a") {
        e.preventDefault();
        this.selectAll();
      } else if (mod && k === "d") {
        e.preventDefault();
        this.duplicate();
      } else if (mod && e.shiftKey && k === "r") {
        e.preventDefault();
        this.reverseDirection();
      } else if (mod && e.shiftKey && k === "l") {
        e.preventDefault();
        this.setLayerFlag("locked", this.selectedContours());
      } else if (mod && e.shiftKey && k === "h") {
        e.preventDefault();
        this.setLayerFlag("hidden", this.selectedContours());
      } else if (mod && (k === "=" || k === "+")) {
        e.preventDefault();
        this.zoom(1.25);
      } else if (mod && (k === "-" || k === "_")) {
        e.preventDefault();
        this.zoom(0.8);
      } else if (mod && e.code === "Digit0") {
        e.preventDefault();
        this.fit();
      } else if (mod) {
        return;
      } else if (e.shiftKey && e.code === "Digit0") this.actualSize();
      else if (e.shiftKey && e.code === "Digit1") this.fit();
      else if (e.shiftKey && e.code === "Digit2") this.zoomToSelection();
      else if (e.shiftKey && k === "c") this.cycleNodeType();
      else if (k === "v") this.setTool("select");
      else if (k === "a") this.setTool("direct");
      else if (k === "p") this.setTool("pen");
      else if (k === "r") this.setTool("rect");
      else if (k === "e") this.setTool("ellipse");
      else if (k === "h") this.setTool("hand");
      else if (k === "z") {
        if (!e.repeat) {
          this.zoomHeld = true;
          this.svg.dataset.zoom = e.altKey ? "out" : "in";
        }
      }
      else if (k === "0" || k === "f") this.fit();
      else if (k === "=" || k === "+") this.zoom(1.25);
      else if (k === "-") this.zoom(0.8);
      else if (k === " ") {
        e.preventDefault();
        this.spaceHeld = true;
        this.svg.dataset.panning = "true";
      } else if (k === "alt") {
        if (this.zoomHeld) {
          e.preventDefault();
          this.svg.dataset.zoom = "out";
        }
      } else if (k === "escape") {
        if (this.pen) this.cancelPen();
        else {
          this.selection.clear();
          this.pivot = null;
          this.render();
          this.host.renderSide(this);
        }
      } else if (k === "enter" && this.pen) this.finishPen();
      else if (k === "delete" || k === "backspace") {
        e.preventDefault();
        this.deleteSelection(!e.altKey);
      }
    });
    window.addEventListener("blur", () => {
      this.zoomHeld = false;
      delete this.svg.dataset.zoom;
    });
    window.addEventListener("keyup", (e) => {
      if (e.key === "Alt" && this.zoomHeld) this.svg.dataset.zoom = "in";
      if (e.key.toLowerCase() === "z") {
        this.zoomHeld = false;
        delete this.svg.dataset.zoom;
      }
      if (e.key === " ") {
        this.spaceHeld = false;
        delete this.svg.dataset.panning;
      }
    });
  }

  /** The caret next to the shape tool opens a menu of shapes, like Figma's. */
  private bindShapeMenu(): void {
    const btn = this.root.querySelector<HTMLButtonElement>(".shape-caret");
    const menu = this.root.querySelector<HTMLElement>(".shape-menu");
    if (!btn || !menu) return;
    const keys: Partial<Record<ShapeKind, string>> = { rect: "R", ellipse: "E" };
    const close = () => {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    };
    const fill = () =>
      menu.replaceChildren(
        ...SHAPES.map((s) => {
          const b = document.createElement("button");
          b.className = `menu-item radio`;
          b.setAttribute("role", "menuitemradio");
          b.setAttribute("aria-checked", String(this.shape === s));
          b.append(SHAPE_LABEL[s]);
          if (keys[s]) {
            const kbd = document.createElement("kbd");
            kbd.textContent = keys[s]!;
            b.append(kbd);
          }
          b.addEventListener("click", () => {
            close();
            this.setTool(s);
          });
          return b;
        }),
      );
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      fill();
      menu.hidden = !menu.hidden;
      btn.setAttribute("aria-expanded", String(!menu.hidden));
    });
    document.addEventListener("pointerdown", (e) => {
      if (!menu.hidden && !menu.contains(e.target as globalThis.Node) && e.target !== btn) close();
    });
  }

  /** The zoom percentage opens a menu of zoom commands, like Figma's. */
  private bindZoomMenu(): void {
    const btn = this.root.querySelector<HTMLButtonElement>(".zoom-label")!;
    const menu = this.root.querySelector<HTMLElement>(".zoom-menu")!;
    const items: [string, string, () => void][] = [
      ["Zoom in", "Ctrl +", () => this.zoom(1.25)],
      ["Zoom out", "Ctrl −", () => this.zoom(0.8)],
      ["Zoom to fit", "Shift 1", () => this.fit()],
      ["Zoom to selection", "Shift 2", () => this.zoomToSelection()],
      ["Zoom to 50%", "", () => this.zoom(0.5 / this.view.scale)],
      ["Zoom to 100%", "Shift 0", () => this.actualSize()],
      ["Zoom to 200%", "", () => this.zoom(2 / this.view.scale)],
    ];
    menu.replaceChildren(
      ...items.map(([label, keys, fn]) => {
        const b = document.createElement("button");
        b.className = "menu-item";
        b.setAttribute("role", "menuitem");
        b.append(label);
        if (keys) {
          const kbd = document.createElement("kbd");
          kbd.textContent = keys;
          b.append(kbd);
        }
        b.addEventListener("click", () => {
          close();
          fn();
        });
        return b;
      }),
    );
    const close = () => {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    };
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      btn.setAttribute("aria-expanded", String(!menu.hidden));
    });
    document.addEventListener("pointerdown", (e) => {
      if (!menu.hidden && !menu.contains(e.target as globalThis.Node) && e.target !== btn) close();
    });
  }

  private isActive(): boolean {
    return !!this.drawing && this.root.offsetParent !== null;
  }

  // ---------- Rendering ----------

  render(): void {
    if (!this.drawing) return;
    const r = this.svg.getBoundingClientRect();
    const W = r.width;
    const H = r.height;
    const m = this.drawing.metrics;
    const { scale, tx, ty } = this.view;
    const sy = (y: number) => -y * scale + ty;
    const sx = (x: number) => x * scale + tx;
    const parts: string[] = [];

    // Grid, under everything.
    if (prefs.showGrid && prefs.gridSize * scale >= 6) {
      const g = prefs.gridSize;
      const x0 = Math.floor(-tx / scale / g) * g;
      const x1 = (W - tx) / scale;
      const y0 = Math.floor((ty - H) / scale / g) * g;
      const y1 = ty / scale;
      let d = "";
      for (let x = x0; x <= x1; x += g) d += `M${sx(x)} 0V${H}`;
      for (let y = y0; y <= y1; y += g) d += `M0 ${sy(y)}H${W}`;
      parts.push(`<path class="grid-lines" d="${d}"/>`);
    }

    // Pa band and guides.
    parts.push(
      `<rect class="pa-band" x="0" y="${sy(m.pa_top)}" width="${W}" height="${(m.pa_top - m.pa_bottom) * scale}"/>`,
    );
    // Pa-height zones: bands where shapes overshoot the Pa lines.
    if (prefs.showZones) {
      for (const z of this.drawing.zones ?? []) {
        const y0 = sy(Math.max(z.position, z.position + z.size));
        const h = Math.abs(z.size) * scale;
        parts.push(`<rect class="zone" x="0" y="${y0}" width="${W}" height="${h}"><title>${esc(z.name)}</title></rect>`);
      }
    }
    const guide = (y: number, label: string, cls = "guide") =>
      `<line class="${cls}" x1="0" x2="${W}" y1="${sy(y)}" y2="${sy(y)}"/><text class="guide-label" x="12" y="${sy(y) - 6}">${label}</text>`;
    parts.push(guide(m.pa_top, `Pa-top ${m.pa_top}`));
    parts.push(guide(m.pa_bottom, m.pa_bottom === 0 ? "Baseline · Pa-bottom 0" : `Pa-bottom ${m.pa_bottom}`));
    if (m.pa_bottom !== 0) parts.push(guide(0, "Baseline", "guide guide-baseline"));

    const frame = this.frameWidth;
    const g = this.gesture;
    if (frame !== null) {
      const own = this.drawing.advanceWidth !== null;
      const dragging = g?.kind === "metric" ? g.side : null;
      for (const [x, side] of [[0, "left"], [frame, "right"]] as const) {
        parts.push(`<line class="guide guide-v${own ? " metric" : ""}${dragging === side ? " active" : ""}" x1="${sx(x)}" x2="${sx(x)}" y1="0" y2="${H}"/>`);
      }
      parts.push(`<text class="guide-label" x="${sx(frame) + 6}" y="${H - 64}">${Math.round(frame)}</text>`);
      // Sidebearings while dragging a metric line.
      const sb = dragging ? this.sidebearings() : null;
      if (sb) {
        parts.push(`<text class="guide-label metric-label" x="${sx(0) + 6}" y="${H - 84}">${sb.lsb}</text>`);
        parts.push(`<text class="guide-label metric-label" x="${sx(frame) - 6}" y="${H - 84}" text-anchor="end">${sb.rsb}</text>`);
      }
    }

    const xf = `matrix(${scale} 0 0 ${-scale} ${tx} ${ty})`;

    const sk = this.sketch;
    if (sk) {
      // Image y goes down, so place its top edge at the sketch's top.
      parts.push(
        `<image href="${sk.href}" x="${sx(sk.x)}" y="${sy(sk.y + sk.h)}" width="${sk.w * scale}" height="${sk.h * scale}" opacity="${sk.opacity}" preserveAspectRatio="none" class="sketch${sk.unlocked ? " unlocked" : ""}"/>`,
      );
    }

    if (this.drawing.context) {
      parts.push(`<path class="ghost" transform="${xf}" d="${this.drawing.context.d}"/>`);
    }

    // Snap guides.
    if (this.snapLines.x !== undefined) {
      parts.push(`<line class="snap-line" x1="${sx(this.snapLines.x)}" x2="${sx(this.snapLines.x)}" y1="0" y2="${H}"/>`);
    }
    if (this.snapLines.y !== undefined) {
      parts.push(`<line class="snap-line" x1="0" x2="${W}" y1="${sy(this.snapLines.y)}" y2="${sy(this.snapLines.y)}"/>`);
    }

    // Filled outline (all visible contours together, so counters cut out),
    // then each contour for hit testing and part colour.
    const visible = this.visibleContours();
    const all = visible.map(contourPath).join("");
    parts.push(`<path class="outline-fill${prefs.fill ? "" : " no-fill"}" transform="${xf}" d="${all}"/>`);
    this.contours.forEach((c, ci) => {
      if (c.hidden) return;
      const color = c.part ? PART_COLORS[c.part] : null;
      const cls = `contour${color ? " tagged" : ""}${c.locked ? " locked" : ""}`;
      parts.push(
        `<path class="${cls}"${c.locked ? "" : ` data-ci="${ci}"`} transform="${xf}" d="${contourPath(c)}"${color ? ` style="--part:${color}"` : ""}/>`,
      );
      if (color && prefs.showPartLabels && c.points.length) {
        const b = contoursBounds([c])!;
        parts.push(
          `<text class="part-label" x="${sx((b.minX + b.maxX) / 2)}" y="${sy(b.maxY) - 8}" style="fill:${color}">${c.part}</text>`,
        );
      }
    });

    // Pen in progress.
    if (this.pen?.length) {
      const pts = [...this.pen];
      let d = `M${sx(pts[0].pos.x)} ${sy(pts[0].pos.y)}`;
      for (let i = 1; i < pts.length; i++) d += seg(pts[i - 1], pts[i], sx, sy);
      if (this.cursor && !this.gesture) {
        const c: Node = { id: -1, pos: this.cursor, smooth: false };
        d += seg(pts[pts.length - 1], c, sx, sy);
      }
      parts.push(`<path class="pen-path" d="${d}"/>`);
      for (const nd of pts) {
        for (const h of [nd.in, nd.out]) {
          if (h)
            parts.push(
              `<line class="handle-line" x1="${sx(nd.pos.x)}" y1="${sy(nd.pos.y)}" x2="${sx(h.pos.x)}" y2="${sy(h.pos.y)}"/><circle class="pt-off" cx="${sx(h.pos.x)}" cy="${sy(h.pos.y)}" r="3.5"/>`,
            );
        }
        parts.push(`<circle class="pt-on" cx="${sx(nd.pos.x)}" cy="${sy(nd.pos.y)}" r="4.5"/>`);
      }
      const first = pts[0];
      parts.push(`<circle class="pen-start" cx="${sx(first.pos.x)}" cy="${sy(first.pos.y)}" r="8"/>`);
    }

    // Outline problems, as small markers with the problem as a tooltip.
    if (prefs.showWarnings && !this.pen) {
      for (const issue of this.issues()) {
        const p = this.toScreen(issue.at);
        parts.push(`<g class="issue"><circle cx="${p.x}" cy="${p.y}" r="9"/><title>${ISSUE_LABEL[issue.kind]}</title></g>`);
      }
    }

    // Direct and pen: points and handles.
    const showPoints = this.tool === "direct" || this.tool === "pen";
    if (showPoints) {
      this.contours.forEach((c, ci) => {
        if (c.hidden || c.locked) return;
        const n = c.points.length;
        c.points.forEach((p, pi) => {
          if (isOn(p)) return;
          const prev = c.points[(pi - 1 + n) % n];
          const next = c.points[(pi + 1) % n];
          const anchor = isOn(prev) ? prev : next;
          parts.push(
            `<line class="handle-line" x1="${sx(anchor.pos.x)}" y1="${sy(anchor.pos.y)}" x2="${sx(p.pos.x)}" y2="${sy(p.pos.y)}"/>`,
          );
        });
        const start = c.points.findIndex(isOn);
        c.points.forEach((p, pi) => {
          const x = sx(p.pos.x);
          const y = sy(p.pos.y);
          const sel = this.selection.has(key(ci, pi)) ? " selected" : "";
          if (pi === start) parts.push(`<circle class="start-ring" cx="${x}" cy="${y}" r="8"/>`);
          const type = pointType(c, pi);
          if (type === "handle") parts.push(`<circle class="pt-off${sel}" cx="${x}" cy="${y}" r="3.5"/>`);
          else if (type === "smooth") parts.push(`<circle class="pt-on${sel}" cx="${x}" cy="${y}" r="4.5"/>`);
          else if (type === "tangent") {
            // A triangle pointing along the straight side.
            const prev = c.points[(pi - 1 + n) % n];
            const toward = isOn(prev) ? { x: p.pos.x - prev.pos.x, y: p.pos.y - prev.pos.y } : { x: c.points[(pi + 1) % n].pos.x - p.pos.x, y: c.points[(pi + 1) % n].pos.y - p.pos.y };
            const l = Math.hypot(toward.x, toward.y) || 1;
            const d = { x: toward.x / l, y: -toward.y / l };
            const q = { x: -d.y, y: d.x };
            const pt = (a: number, b: number) => `${x + d.x * a + q.x * b},${y + d.y * a + q.y * b}`;
            parts.push(`<polygon class="pt-on${sel}" points="${pt(6, 0)} ${pt(-4, 5)} ${pt(-4, -5)}"/>`);
          } else parts.push(`<rect class="pt-on${sel}" x="${x - 4}" y="${y - 4}" width="8" height="8" rx="1.5"/>`);
        });
      });
    }

    // Path direction: an arrow just past each start point, pointing the way
    // the contour runs. All contours with Direct and Pen, selected ones with Move.
    if (prefs.showArrows) {
      const arrowsFor = showPoints ? this.contours.map((_, ci) => ci) : this.selectedContours();
      for (const ci of arrowsFor) {
        if (this.contours[ci].hidden) continue;
        const sd = startDirection(this.contours[ci]);
        if (!sd) continue;
        const at = this.toScreen(sd.at);
        const d = { x: sd.dir.x, y: -sd.dir.y };
        const q = { x: -d.y, y: d.x };
        const pt = (a: number, b: number) => `${at.x + d.x * a + q.x * b},${at.y + d.y * a + q.y * b}`;
        parts.push(`<polygon class="dir-arrow" points="${pt(22, 0)} ${pt(10, 5.5)} ${pt(10, -5.5)}"/>`);
      }
    }

    // Transform box: corners and edges scale, just outside a corner rotates.
    const box = !this.pen && g?.kind !== "move" && g?.kind !== "marquee" && g?.kind !== "lasso" ? this.transformBox() : null;
    if (box) {
      const x0 = sx(box.minX);
      const y0 = sy(box.maxY);
      const w = (box.maxX - box.minX) * scale;
      const h = (box.maxY - box.minY) * scale;
      parts.push(`<rect class="sel-box" x="${x0}" y="${y0}" width="${w}" height="${h}"/>`);
      const tiny = w < 24 || h < 24;
      for (const [cx, cy, edge] of [
        [x0, y0, false], [x0 + w, y0, false], [x0, y0 + h, false], [x0 + w, y0 + h, false],
        [x0 + w / 2, y0, true], [x0 + w / 2, y0 + h, true], [x0, y0 + h / 2, true], [x0 + w, y0 + h / 2, true],
      ] as [number, number, boolean][]) {
        if (edge && tiny) continue;
        parts.push(`<rect class="sel-corner" x="${cx - 3.5}" y="${cy - 3.5}" width="7" height="7"/>`);
      }
      if (this.tool === "select") {
        const pv = this.toScreen(this.pivotOf(box));
        parts.push(`<g class="pivot${this.pivot ? " moved" : ""}"><circle cx="${pv.x}" cy="${pv.y}" r="4"/><line x1="${pv.x - 7}" x2="${pv.x + 7}" y1="${pv.y}" y2="${pv.y}"/><line x1="${pv.x}" x2="${pv.x}" y1="${pv.y - 7}" y2="${pv.y + 7}"/></g>`);
      }
      if (g?.kind === "scale" || g?.kind === "rotate") {
        const label = g.kind === "rotate" ? `${Math.round(g.angle)}°` : `${Math.round(box.maxX - box.minX)} × ${Math.round(box.maxY - box.minY)}`;
        parts.push(`<text class="size-label" x="${x0 + w / 2}" y="${y0 + h + 22}" text-anchor="middle">${label}</text>`);
      }
    }

    // The attach point of an alteration, draggable.
    if (this.drawing.context) {
      const o = this.toScreen(this.origin);
      const moved = this.origin.x !== this.drawing.context.autoOrigin.x || this.origin.y !== this.drawing.context.autoOrigin.y;
      parts.push(
        `<g class="attach${moved ? " moved" : ""}"><circle cx="${o.x}" cy="${o.y}" r="7"/><line x1="${o.x - 12}" x2="${o.x + 12}" y1="${o.y}" y2="${o.y}"/><line x1="${o.x}" x2="${o.x}" y1="${o.y - 12}" y2="${o.y + 12}"/></g>`,
      );
    }

    if (g?.kind === "shape") {
      const a0 = g.fromCenter ? { x: 2 * g.start.x - g.now.x, y: 2 * g.start.y - g.now.y } : g.start;
      const preview =
        g.shape === "rect" ? rectContour(0, a0, g.now)
        : g.shape === "rounded" ? roundedRectContour(0, a0, g.now, prefs.cornerRadius)
        : g.shape === "ellipse" ? ellipseContour(0, a0, g.now)
        : g.shape === "polygon" ? polygonContour(0, a0, g.now, prefs.polygonSides)
        : polygonContour(0, a0, g.now, prefs.starPoints, prefs.starInner);
      parts.push(`<path class="shape-preview" transform="${xf}" d="${contourPath(preview)}"/>`);
      parts.push(`<text class="size-label" x="${sx(Math.max(a0.x, g.now.x))}" y="${sy(Math.min(a0.y, g.now.y)) + 22}" text-anchor="end">${Math.round(Math.abs(g.now.x - a0.x))} × ${Math.round(Math.abs(g.now.y - a0.y))}</text>`);
    }
    if (g?.kind === "marquee" || g?.kind === "zoom") {
      const a = { x: sx(g.start.x), y: sy(g.start.y) };
      const b = { x: sx(g.now.x), y: sy(g.now.y) };
      parts.push(
        `<rect class="marquee" x="${Math.min(a.x, b.x)}" y="${Math.min(a.y, b.y)}" width="${Math.abs(a.x - b.x)}" height="${Math.abs(a.y - b.y)}"/>`,
      );
    }
    if (g?.kind === "lasso" && g.pts.length > 1) {
      const d = g.pts.map((p, i) => `${i ? "L" : "M"}${sx(p.x)} ${sy(p.y)}`).join("") + "Z";
      parts.push(`<path class="marquee lasso" d="${d}"/>`);
    }

    this.svg.innerHTML = parts.join("");
    this.zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  }
}

function seg(a: Node, b: Node, sx: (x: number) => number, sy: (y: number) => number): string {
  if (a.out || b.in) {
    const c1 = a.out?.pos ?? a.pos;
    const c2 = b.in?.pos ?? b.pos;
    return `C${sx(c1.x)} ${sy(c1.y)} ${sx(c2.x)} ${sy(c2.y)} ${sx(b.pos.x)} ${sy(b.pos.y)}`;
  }
  return `L${sx(b.pos.x)} ${sy(b.pos.y)}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

export { PARTS };
