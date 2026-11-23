// The outline glyph editor: canvas, tools, selection, history and the side
// panel. Edits are made on a local copy for speed and written back to the core
// (set_drawing) when each gesture ends, so every fidel that uses the drawing
// updates.

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
import { importSvg, SvgImportError } from "./svgImport";

/** Move selects and moves whole shapes; Direct selects points and handles. */
export type Tool = "select" | "direct" | "pen" | "rect" | "ellipse" | "hand";

/** Snap distance, in screen pixels. */
const SNAP_PX = 6;

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
}

type Gesture =
  | { kind: "move"; start: Vec2; base: Contour[]; moved: boolean; lead: Vec2 | null; box: Box | null }
  | { kind: "attach"; start: Vec2; origin: Vec2; base: Contour[]; moved: boolean }
  | { kind: "shape"; shape: "rect" | "ellipse"; start: Vec2; now: Vec2 }
  | { kind: "marquee"; start: Vec2; now: Vec2; additive: boolean }
  | { kind: "zoom"; start: Vec2; now: Vec2; out: boolean }
  | { kind: "pan"; startScreen: Vec2; view: View }
  | { kind: "pen-drag"; node: Node }
  | { kind: "sketch"; start: Vec2; origin: Vec2 };

export interface EditorHost {
  /** Called after a change has been written to the core. */
  changed(target: DrawingTarget): void;
  toast(message: string, tone?: "error" | "info"): void;
  /** Fill the side panel. */
  renderSide(editor: GlyphEditor): void;
}

const key = (ci: number, pi: number) => `${ci}:${pi}`;

/** Marks our own paths on the system clipboard, so a paste keeps them exact. */
const CLIP_TAG = "ethiopic-font-editor/contours";

/**
 * Copied paths, in canvas units. Every drawing shares one design space, so a
 * path pasted into another glyph lands where it was. Kept here as well as on
 * the system clipboard in case the webview hides clipboard data.
 */
let clipboard: Contour[] | null = null;
const HIT_PX = 8;

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

export class GlyphEditor {
  drawing: DrawingView | null = null;
  contours: Contour[] = [];
  /** Selected points as "contourIndex:pointIndex". */
  selection = new Set<string>();
  tool: Tool = "select";
  showParts = true;
  sketches = new Map<string, Sketch>();

  private view: View = { scale: 0.5, tx: 100, ty: 500 };
  /** For an alteration: its attach point on the context base. Contours are
   * shown and edited at origin + stored position, so the part sits where it
   * lands on the base and the canvas keeps the base's frame. */
  origin: Vec2 = { x: 0, y: 0 };
  private contextKey = "";
  /** Guides shown while a drag snaps. */
  private snapLines: { x?: number; y?: number } = {};
  private gesture: Gesture | null = null;
  private pen: Node[] | null = null;
  private cursor: Vec2 | null = null;
  private spaceHeld = false;
  /** Z held down: click zooms in, Alt-click out, drag zooms to an area. */
  private zoomHeld = false;
  private committed = "[]";
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private saving: Promise<void> = Promise.resolve();

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
    this.committed = JSON.stringify(this.contours);
    if (!sameFrame) {
      this.undoStack = [];
      this.redoStack = [];
      this.selection.clear();
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
    this.undoStack = [];
    this.redoStack = [];
    this.committed = "[]";
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

  fit(): void {
    if (!this.drawing) return;
    const r = this.svg.getBoundingClientRect();
    const w = r.width || 800;
    const h = r.height || 600;
    const m = this.drawing.metrics;
    // Frame the drawing like its base: same advance, same Pa band, so moving
    // between a base and its alterations never shifts the design space.
    const frame = this.frameWidth;
    const b = contoursBounds(this.contours);
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
          const [ci, pi] = k.split(":").map(Number);
          return this.contours[ci].points[pi].pos;
        })
      : this.contours.flatMap((c) => c.points.map((p) => p.pos));
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

  // ---------- Hit testing ----------

  private hitPoint(screen: Vec2): [number, number] | null {
    let best: [number, number] | null = null;
    let bestD = HIT_PX;
    this.contours.forEach((c, ci) =>
      c.points.forEach((p, pi) => {
        const s = this.toScreen(p.pos);
        const d = Math.hypot(s.x - screen.x, s.y - screen.y);
        // Prefer handles when they sit on top of their point.
        if (d < bestD || (d === bestD && !isOn(p))) {
          bestD = d;
          best = [ci, pi];
        }
      }),
    );
    return best;
  }

  private screenOf(e: PointerEvent | MouseEvent): Vec2 {
    const r = this.svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ---------- Canvas events ----------

  private bindCanvas(): void {
    const svg = this.svg;
    svg.addEventListener("pointerdown", (e) => this.onDown(e));
    svg.addEventListener("pointermove", (e) => this.onMove(e));
    svg.addEventListener("pointerup", (e) => this.onUp(e));
    svg.addEventListener("pointercancel", () => (this.gesture = null));
    svg.addEventListener("dblclick", (e) => this.onDoubleClick(e));
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
    if (!this.drawing) return;
    this.svg.setPointerCapture(e.pointerId);
    const screen = this.screenOf(e);
    const font = this.toFont(e);

    if (this.tool === "hand" || this.spaceHeld || e.button === 1) {
      this.gesture = { kind: "pan", startScreen: screen, view: { ...this.view } };
      return;
    }

    if (this.zoomHeld) {
      this.gesture = { kind: "zoom", start: font, now: font, out: e.altKey };
      return;
    }

    if (this.tool === "pen") {
      this.penDown(this.penTarget(font, e), screen);
      return;
    }

    if (this.tool === "rect" || this.tool === "ellipse") {
      const at = this.snapped(font, e).pos;
      this.gesture = { kind: "shape", shape: this.tool, start: at, now: at };
      return;
    }

    // The attach point of an alteration can be dragged with either selection tool.
    if (this.hitAttach(screen)) {
      this.gesture = { kind: "attach", start: font, origin: { ...this.origin }, base: clone(this.contours), moved: false };
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
      this.gesture = { kind: "move", start: font, base: clone(this.contours), moved: false, lead, box: null };
      this.changedSelection();
      return;
    }

    const shape = (e.target as Element).closest<SVGElement>("[data-ci]");
    const inBox = !direct && this.selectionBoxHit(font);
    if (shape || inBox) {
      if (shape) {
        const ci = Number(shape.dataset.ci);
        const already = this.contours[ci].points.every((_, pi) => this.selection.has(key(ci, pi)));
        if (!already && !e.shiftKey) this.selection.clear();
        this.selectContour(ci);
      }
      const box = contoursBounds(this.selectedContours().map((ci) => this.contours[ci]));
      this.gesture = { kind: "move", start: font, base: clone(this.contours), moved: false, lead: null, box };
      this.changedSelection();
      return;
    }

    if (e.altKey && this.sketch) {
      this.gesture = { kind: "sketch", start: font, origin: { x: this.sketch.x, y: this.sketch.y } };
      return;
    }

    if (!e.shiftKey) this.selection.clear();
    this.gesture = { kind: "marquee", start: font, now: font, additive: e.shiftKey };
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
        if (!e.altKey) {
          if (g.lead) {
            // Direct selection: the grabbed point snaps.
            const want = { x: g.lead.x + dx, y: g.lead.y + dy };
            const s = this.snapped(want, e, true);
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
        this.contours = this.moved(g.base, dx, dy);
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
        let to = this.snapped(font, e).pos;
        if (e.shiftKey) {
          const side = Math.max(Math.abs(to.x - g.start.x), Math.abs(to.y - g.start.y));
          to = { x: g.start.x + Math.sign(to.x - g.start.x || 1) * side, y: g.start.y + Math.sign(to.y - g.start.y || 1) * side };
        }
        g.now = to;
        break;
      }
      case "marquee":
      case "zoom":
        g.now = font;
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
          sk.x = g.origin.x + font.x - g.start.x;
          sk.y = g.origin.y + font.y - g.start.y;
        }
        break;
      }
    }
    this.render();
  }

  private onUp(e: PointerEvent): void {
    const g = this.gesture;
    this.gesture = null;
    this.snapLines = {};
    if (!g) return;
    if (g.kind === "move" && g.moved) {
      roundContours(this.contours);
      this.commit();
    } else if (g.kind === "attach" && g.moved) {
      void this.saveAttach();
    } else if (g.kind === "shape") {
      const w = Math.abs(g.now.x - g.start.x);
      const h = Math.abs(g.now.y - g.start.y);
      if (w * this.view.scale > 2 && h * this.view.scale > 2) {
        const id = nextContourId(this.contours);
        const c = g.shape === "rect" ? rectContour(id, g.start, g.now) : ellipseContour(id, g.start, g.now);
        c.name = g.shape === "rect" ? "Rectangle" : "Ellipse";
        const ci = this.contours.length;
        this.contours.push(c);
        this.selection = new Set(c.points.map((_, pi) => key(ci, pi)));
        this.commit();
        this.host.renderSide(this);
      }
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
    } else if (g.kind === "marquee") {
      const x0 = Math.min(g.start.x, g.now.x);
      const x1 = Math.max(g.start.x, g.now.x);
      const y0 = Math.min(g.start.y, g.now.y);
      const y1 = Math.max(g.start.y, g.now.y);
      this.contours.forEach((c, ci) => {
        const inside = c.points.filter((p) => p.pos.x >= x0 && p.pos.x <= x1 && p.pos.y >= y0 && p.pos.y <= y1);
        if (!inside.length) return;
        // Move selects whole shapes; Direct selects only the points inside.
        if (this.tool === "direct") {
          c.points.forEach((p, pi) => {
            if (p.pos.x >= x0 && p.pos.x <= x1 && p.pos.y >= y0 && p.pos.y <= y1) this.selection.add(key(ci, pi));
          });
        } else this.selectContour(ci);
      });
      this.host.renderSide(this);
    }
    if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
    this.render();
  }

  private onDoubleClick(e: MouseEvent): void {
    if (this.hitAttach(this.screenOf(e))) {
      this.resetAttach();
      return;
    }
    const screen = this.screenOf(e);
    if (this.tool === "select") {
      // Double-clicking a shape goes into its points, like Figma.
      const shape = (e.target as Element).closest<SVGElement>("[data-ci]");
      if (shape) this.setTool("direct");
      return;
    }
    if (this.tool !== "direct") return;
    const hit = this.hitPoint(screen);
    if (!hit) return;
    const p = this.contours[hit[0]].points[hit[1]];
    if (!isOn(p)) return;
    this.setNodeType(p.smooth ? "corner" : "smooth");
  }

  private changedSelection(): void {
    this.render();
    this.host.renderSide(this);
  }

  /** Add every point of one contour to the selection. */
  selectContour(ci: number, only = false): void {
    if (only) this.selection.clear();
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
    this.commit();
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

  // ---------- Snapping ----------

  /** Lines a point can snap to: other on-curve points, the Pa lines, the sidebearings. */
  private snapTargets(skipSelected: boolean): { xs: number[]; ys: number[] } {
    const m = this.drawing!.metrics;
    const xs = [0];
    const ys = [m.pa_top, m.pa_bottom, 0];
    const frame = this.frameWidth;
    if (frame !== null) xs.push(frame);
    if (this.drawing?.context) {
      xs.push(this.origin.x);
      ys.push(this.origin.y);
    }
    this.contours.forEach((c, ci) =>
      c.points.forEach((p, pi) => {
        if (!isOn(p) || (skipSelected && this.selection.has(key(ci, pi)))) return;
        xs.push(p.pos.x);
        ys.push(p.pos.y);
      }),
    );
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
    return { pos: { x: x ?? p.x, y: y ?? p.y }, lines: { x, y } };
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
    if (allowX) {
      const f = fit([b.minX + dx, b.maxX + dx], xs);
      if (f) {
        dx += f.shift;
        lines.x = f.line;
      }
    } else dx = 0;
    if (allowY) {
      const f = fit([b.minY + dy, b.maxY + dy], ys);
      if (f) {
        dy += f.shift;
        lines.y = f.line;
      }
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
      // The stored part did not change, only where it sits; history in
      // canvas coordinates no longer lines up.
      this.committed = JSON.stringify(this.contours);
      this.undoStack = [];
      this.redoStack = [];
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
    const singleHandle =
      this.selection.size === 1 ? [...this.selection][0].split(":").map(Number) : null;
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
    this.commit();
    this.render();
  }

  cancelPen(): void {
    this.pen = null;
    this.render();
  }

  // ---------- Edits ----------

  setTool(tool: Tool): void {
    if (this.pen && tool !== "pen") this.finishPen();
    this.tool = tool;
    this.root.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) => {
      b.classList.toggle("active", b.dataset.tool === tool);
    });
    this.svg.dataset.tool = tool;
  }

  selectAll(): void {
    this.selection = new Set(this.contours.flatMap((c, ci) => c.points.map((_, pi) => key(ci, pi))));
    this.render();
    this.host.renderSide(this);
  }

  nudge(dx: number, dy: number): void {
    if (!this.selection.size) return;
    this.contours = this.moved(this.contours, dx, dy);
    this.commit();
    this.render();
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
    this.commit();
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
    const first = nextContourId(this.contours);
    const pasted = clone(picked).map((c, k) => ({ ...c, id: first + k }));
    const start = this.contours.length;
    this.contours.push(...pasted);
    this.selection = new Set(pasted.flatMap((c, k) => c.points.map((_, pi) => key(start + k, pi))));
    this.commit();
    this.render();
    this.host.renderSide(this);
    return true;
  }

  deleteSelection(): void {
    if (!this.selection.size) return;
    const next: Contour[] = [];
    this.contours.forEach((c, ci) => {
      const gone = new Set(c.points.filter((_, pi) => this.selection.has(key(ci, pi))).map((p) => p.id));
      if (!gone.size) {
        next.push(c);
        return;
      }
      const free = Math.max(...c.points.map((p) => p.id)) + 1;
      const nodes = toNodes(c).filter((nd) => !gone.has(nd.id));
      for (const nd of nodes) {
        if (nd.in && gone.has(nd.in.id)) delete nd.in;
        if (nd.out && gone.has(nd.out.id)) delete nd.out;
      }
      if (nodes.length >= 2) next.push(rebuilt(c, nodes, free));
    });
    this.contours = next;
    this.selection.clear();
    this.commit();
    this.render();
    this.host.renderSide(this);
  }

  /**
   * Rebuild the contours that hold selected points, then select the same
   * points again by id, since rebuilding can renumber them.
   */
  private editSelectedContours(fn: (c: Contour, ids: Set<number>) => Contour, all = false): void {
    const picked = new Map<number, Set<number>>();
    for (const k of this.selection) {
      const [ci, pi] = k.split(":").map(Number);
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
    this.commit();
    this.render();
    this.host.renderSide(this);
  }

  /** Corner, smooth, or retract the handles of the selected on-curve points. */
  setNodeType(to: NodeType): void {
    this.editSelectedContours((c, ids) => convertNodes(c, ids, to));
  }

  /** Reverse the direction of the selected contours, or of every contour when nothing is selected. */
  reverseDirection(): void {
    this.editSelectedContours((c) => reversed(c), true);
  }

  /** The selected on-curve points. */
  selectedNodes(): { smooth: boolean; handles: boolean }[] {
    return [...this.selection].flatMap((k) => {
      const [ci, pi] = k.split(":").map(Number);
      const c = this.contours[ci];
      const p = c?.points[pi];
      if (!p || !isOn(p)) return [];
      const n = c.points.length;
      const handles = !isOn(c.points[(pi - 1 + n) % n]) || !isOn(c.points[(pi + 1) % n]);
      return [{ smooth: !!p.smooth, handles }];
    });
  }

  /** Contours with at least one selected point. */
  selectedContours(): number[] {
    return [...new Set([...this.selection].map((k) => Number(k.split(":")[0])))].sort((a, b) => a - b);
  }

  setPart(part: Part | null): void {
    for (const ci of this.selectedContours()) this.contours[ci].part = part;
    this.commit();
    this.render();
    this.host.renderSide(this);
  }

  setPointPosition(x: number, y: number): void {
    if (this.selection.size !== 1) return;
    const [ci, pi] = [...this.selection][0].split(":").map(Number);
    const p = this.contours[ci].points[pi];
    this.contours = this.moved(this.contours, x - p.pos.x, y - p.pos.y);
    roundContours(this.contours);
    this.commit();
    this.render();
  }

  async setAdvance(width: number): Promise<void> {
    if (!this.drawing || !this.target || this.target.kind === "alteration") return;
    const w = Math.max(0, Math.round(width));
    await api.setAdvance(this.target, w);
    this.drawing.advanceWidth = w;
    this.render();
    this.host.changed(this.target);
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
      this.commit();
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
        this.sketches.set(this.targetKey, { href, x: 0, y: m.pa_bottom, w, h, opacity: 0.35 });
        this.render();
        this.host.renderSide(this);
      };
      img.src = href;
    };
    reader.readAsDataURL(file);
  }

  updateSketch(change: Partial<Pick<Sketch, "opacity">> & { scale?: number }): void {
    const sk = this.sketch;
    if (!sk) return;
    if (change.opacity !== undefined) sk.opacity = change.opacity;
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

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private commit(): void {
    const now = JSON.stringify(this.contours);
    if (now === this.committed) return;
    for (const c of this.contours) {
      const problem = validate(c);
      if (problem) {
        this.host.toast(`That edit would break contour ${c.id} (${problem}). Undone.`, "error");
        this.contours = JSON.parse(this.committed);
        return;
      }
    }
    this.undoStack.push(this.committed);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.committed = now;
    this.persist();
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push(this.committed);
    this.restore(prev);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(this.committed);
    this.restore(next);
  }

  private restore(state: string): void {
    this.committed = state;
    this.contours = JSON.parse(state);
    this.selection.clear();
    this.persist();
    this.render();
    this.host.renderSide(this);
  }

  private persist(): void {
    const target = this.target;
    if (!target) return;
    // Alterations are stored relative to their attach point.
    const contours = translated(JSON.parse(this.committed) as Contour[], { x: -this.origin.x, y: -this.origin.y });
    // Keep writes in order.
    this.saving = this.saving
      .then(() => api.setDrawing(target, contours))
      .then(() => this.host.changed(target))
      .catch((err) => this.host.toast(`Could not save the drawing: ${err}`, "error"));
  }

  // ---------- Chrome: tool palette, bottom bar, keys, paste ----------

  private bindChrome(): void {
    this.root.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) =>
      b.addEventListener("click", () => this.setTool(b.dataset.tool as Tool)),
    );
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
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (mod && k === "y") {
        e.preventDefault();
        this.redo();
      } else if (mod && k === "a") {
        e.preventDefault();
        this.selectAll();
      } else if (mod && e.shiftKey && k === "r") {
        e.preventDefault();
        this.reverseDirection();
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
          this.render();
          this.host.renderSide(this);
        }
      } else if (k === "enter" && this.pen) this.finishPen();
      else if (k === "delete" || k === "backspace") {
        e.preventDefault();
        this.deleteSelection();
      } else if (k.startsWith("arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const d = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, step], arrowdown: [0, -step] }[k];
        if (d) this.nudge(d[0], d[1]);
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

    // Pa band and guides.
    parts.push(
      `<rect class="pa-band" x="0" y="${sy(m.pa_top)}" width="${W}" height="${(m.pa_top - m.pa_bottom) * scale}"/>`,
    );
    const guide = (y: number, label: string, cls = "guide") =>
      `<line class="${cls}" x1="0" x2="${W}" y1="${sy(y)}" y2="${sy(y)}"/><text class="guide-label" x="12" y="${sy(y) - 6}">${label}</text>`;
    parts.push(guide(m.pa_top, `Pa-top ${m.pa_top}`));
    parts.push(guide(m.pa_bottom, m.pa_bottom === 0 ? "Baseline · Pa-bottom 0" : `Pa-bottom ${m.pa_bottom}`));
    if (m.pa_bottom !== 0) parts.push(guide(0, "Baseline", "guide guide-baseline"));

    const frame = this.frameWidth;
    if (frame !== null) {
      for (const x of [0, frame]) {
        parts.push(`<line class="guide guide-v" x1="${sx(x)}" x2="${sx(x)}" y1="0" y2="${H}"/>`);
      }
      parts.push(`<text class="guide-label" x="${sx(frame) + 6}" y="${H - 64}">${Math.round(frame)}</text>`);
    }

    const xf = `matrix(${scale} 0 0 ${-scale} ${tx} ${ty})`;

    const sk = this.sketch;
    if (sk) {
      // Image y goes down, so place its top edge at the sketch's top.
      parts.push(
        `<image href="${sk.href}" x="${sx(sk.x)}" y="${sy(sk.y + sk.h)}" width="${sk.w * scale}" height="${sk.h * scale}" opacity="${sk.opacity}" preserveAspectRatio="none" class="sketch"/>`,
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

    // Filled outline (all contours together, so counters cut out), then each
    // contour for hit testing and part colour.
    const all = this.contours.map(contourPath).join("");
    parts.push(`<path class="outline-fill" transform="${xf}" d="${all}"/>`);
    this.contours.forEach((c, ci) => {
      const color = this.showParts && c.part ? PART_COLORS[c.part] : null;
      parts.push(
        `<path class="contour${color ? " tagged" : ""}" data-ci="${ci}" transform="${xf}" d="${contourPath(c)}"${color ? ` style="--part:${color}"` : ""}/>`,
      );
      if (color && c.points.length) {
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

    // Move tool: a box around the selected shapes. Direct and pen: points and handles.
    const showPoints = this.tool === "direct" || this.tool === "pen";
    if (!showPoints && this.selection.size) {
      const b = contoursBounds(this.selectedContours().map((ci) => this.contours[ci]));
      if (b) {
        const x0 = sx(b.minX);
        const y0 = sy(b.maxY);
        const w = (b.maxX - b.minX) * scale;
        const h = (b.maxY - b.minY) * scale;
        parts.push(`<rect class="sel-box" x="${x0}" y="${y0}" width="${w}" height="${h}"/>`);
        for (const [cx, cy] of [[x0, y0], [x0 + w, y0], [x0, y0 + h], [x0 + w, y0 + h]]) {
          parts.push(`<rect class="sel-corner" x="${cx - 3}" y="${cy - 3}" width="6" height="6"/>`);
        }
      }
    }
    if (showPoints) {
      this.contours.forEach((c, ci) => {
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
        c.points.forEach((p, pi) => {
          const x = sx(p.pos.x);
          const y = sy(p.pos.y);
          const sel = this.selection.has(key(ci, pi)) ? " selected" : "";
          if (!isOn(p)) parts.push(`<circle class="pt-off${sel}" cx="${x}" cy="${y}" r="3.5"/>`);
          else if (p.smooth) parts.push(`<circle class="pt-on${sel}" cx="${x}" cy="${y}" r="4.5"/>`);
          else parts.push(`<rect class="pt-on${sel}" x="${x - 4}" y="${y - 4}" width="8" height="8" rx="1.5"/>`);
        });
      });
    }

    // Path direction: an arrow just past each start point, pointing the way
    // the contour runs. All contours with Direct and Pen, selected ones with Move.
    const arrowsFor = showPoints ? this.contours.map((_, ci) => ci) : this.selectedContours();
    for (const ci of arrowsFor) {
      const sd = startDirection(this.contours[ci]);
      if (!sd) continue;
      const at = this.toScreen(sd.at);
      const d = { x: sd.dir.x, y: -sd.dir.y };
      const q = { x: -d.y, y: d.x };
      const pt = (a: number, b: number) => `${at.x + d.x * a + q.x * b},${at.y + d.y * a + q.y * b}`;
      parts.push(`<polygon class="dir-arrow" points="${pt(22, 0)} ${pt(10, 5.5)} ${pt(10, -5.5)}"/>`);
    }

    // The attach point of an alteration, draggable.
    if (this.drawing.context) {
      const o = this.toScreen(this.origin);
      const moved = this.origin.x !== this.drawing.context.autoOrigin.x || this.origin.y !== this.drawing.context.autoOrigin.y;
      parts.push(
        `<g class="attach${moved ? " moved" : ""}"><circle cx="${o.x}" cy="${o.y}" r="7"/><line x1="${o.x - 12}" x2="${o.x + 12}" y1="${o.y}" y2="${o.y}"/><line x1="${o.x}" x2="${o.x}" y1="${o.y - 12}" y2="${o.y + 12}"/></g>`,
      );
    }

    const g = this.gesture;
    if (g?.kind === "shape") {
      const a = { x: sx(g.start.x), y: sy(g.start.y) };
      const b = { x: sx(g.now.x), y: sy(g.now.y) };
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(a.x - b.x);
      const h = Math.abs(a.y - b.y);
      parts.push(
        g.shape === "rect"
          ? `<rect class="shape-preview" x="${x}" y="${y}" width="${w}" height="${h}"/>`
          : `<ellipse class="shape-preview" cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}"/>`,
      );
    }
    if (g?.kind === "marquee" || g?.kind === "zoom") {
      const a = { x: sx(g.start.x), y: sy(g.start.y) };
      const b = { x: sx(g.now.x), y: sy(g.now.y) };
      parts.push(
        `<rect class="marquee" x="${Math.min(a.x, b.x)}" y="${Math.min(a.y, b.y)}" width="${Math.abs(a.x - b.x)}" height="${Math.abs(a.y - b.y)}"/>`,
      );
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

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

export { PARTS };
