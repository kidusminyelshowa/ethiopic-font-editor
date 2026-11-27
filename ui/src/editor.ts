// The outline glyph editor: canvas, tools, selection, transforms, history and
// the side panel. Edits are made on a local copy for speed and written back
// to the core (set_drawing) when each gesture ends, so every fidel that uses
// the drawing updates.

import {
  api,
  PARTS,
  type BooleanKind,
  type ComponentKind,
  type ComponentRef,
  type DeformHandle,
  type DrawingTarget,
  type DrawingView,
  type ImpactView,
  type Part,
  type PathOp,
  type MetricKeys,
  type RuleEnd,
  type StrokeJoin,
  type Tweak,
} from "./api";
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
  directionOk,
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
  pointAt,
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
import {
  autoHandles,
  balanceContour,
  breakAt,
  closePath,
  combTeeth,
  endOf,
  eraseSegments,
  fitStroke,
  harmonize,
  joinPaths,
  moveTunni,
  powerNudge,
  roundCorners,
  tidyUp,
  tunniPoint,
} from "./curves";
import { gridStep, onPrefs, prefs } from "./prefs";
import { clipLine, crossings, distanceToGuide, fmt, guideDir, isHorizontal, isVertical, projectOnGuide, rulerTicks, type Guide } from "./guides";
import { importSvg, SvgImportError } from "./svgImport";
import { inkFromPixels, traceToContours } from "./trace";
import { placeContours, unplaceContours } from "./components";
import { isFigmaClipboard, svgFromHtml, vectorFileToSvg } from "./vectorImport";
import { actionFor, comboOf, isFreedDefault } from "./shortcuts";

/** Move selects and moves whole shapes; Direct selects points and handles. */
export type Tool = "select" | "direct" | "pen" | "pencil" | "knife" | "eraser" | "measure" | ShapeKind | "hand";
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
/** Point sizes for the "Point size" display option. */
const NODE_SCALE: Record<string, number> = { small: 0.8, medium: 1, large: 1.35 };
const HIT_PX = 8;
/** Half the width of the eraser stroke, in screen pixels. */
const ERASER_RADIUS = 6;

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
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
  | { kind: "zone"; id: string; start: number; now: number }
  | { kind: "placement"; id: number; start: Vec2; d: Vec2; moved: boolean }
  | { kind: "deform"; i: number; start: Vec2; d: number }
  | { kind: "pencil"; pts: Vec2[]; startScreen: Vec2 }
  | { kind: "knife"; start: Vec2; now: Vec2 }
  | { kind: "eraser"; pts: Vec2[] }
  | { kind: "measure"; start: Vec2; now: Vec2 }
  | { kind: "guide"; scope: GuideScope; id: number; start: Vec2; origin: Vec2; isNew: boolean; moved: boolean; offRuler: boolean }
  | { kind: "tunni"; ci: number; seg: number; base: Contour[]; moved: boolean }
  | { kind: "anchor"; name: string; start: Vec2; origin: Vec2; moved: boolean }
  | { kind: "bend"; ci: number; seg: number; t: number; start: Vec2; base: Contour[]; moved: boolean };

type SelectMode = "replace" | "add" | "remove";

export type GuideScope = "local" | "global";

/** Width of the rulers along the top and left of the canvas, in pixels. */
const RULER_PX = 18;

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
  /** The display name of an alteration. */
  alterationName(id: string): string;
  /** Fill the side panel. */
  renderSide(editor: GlyphEditor): void;
  /** Open the canvas context menu at a screen point. */
  contextMenu(editor: GlyphEditor, at: { x: number; y: number }): void;
  /** A character's drawing and current outline, for the line of text. */
  glyphFor(ch: string): { target: DrawingTarget; d: string | null; advance: number } | null;
  /** The character a drawing makes, if any. */
  charOf(target: DrawingTarget): string | null;
  /** Kerning between two characters of the line of text. */
  kern?(left: string, right: string): number;
  /** Open another drawing in the editor. */
  openTarget(target: DrawingTarget): void;
}

/** Width of a space in the line of text, as a share of the em. */
const SPACE_EM = 0.25;

const key = (ci: number, pi: number) => `${ci}:${pi}`;

/** Same contours with the same points, wherever they are: only moves between `a` and `b`. */
function samePoints(a: Contour[], b: Contour[]): boolean {
  return (
    a.length === b.length &&
    a.every((c, i) => c.points.length === b[i].points.length && c.points.every((p, j) => p.id === b[i].points[j].id))
  );
}
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
  /** The drawing's own guides and the global ones. */
  guides: { local: Guide[]; global: Guide[] } = { local: [], global: [] };
  /** The line of text the edited glyph sits in, and where it sits. */
  textLine = "";
  textIndex = -1;
  /** The drawing's background (mask) layer: outlines kept behind it to compare against. */
  background: Contour[] = [];
  /** A component opened from a base: that base, drawn behind it in the component's own space. */
  private hostBehind = new Map<string, Contour[]>();
  /** Another glyph shown behind this one, by character, per drawing. */
  compareWith = new Map<string, string>();
  /** For a base or an alteration: the fidel its edits reach. */
  reach: ImpactView[] | null = null;
  /** The guide picked on the canvas, shown in the side panel. */
  guideSel: { scope: GuideScope; id: number } | null = null;
  /** The measuring line, kept until Escape or another tool. */
  private measureLine: { a: Vec2; b: Vec2 } | null = null;
  /** Guides shown while a drag snaps. */
  private snapLines: { x?: number; y?: number } = {};
  private gesture: Gesture | null = null;
  private pen: Node[] | null = null;
  /** When the pen carries on an open path: the path and where it sat in the list. */
  private penFrom: { at: number; contour: Contour } | null = null;
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

  /** The anchor picked on the canvas or in the panel. */
  anchorSel: string | null = null;
  /** Another glyph shown against this one by their anchors. */
  markPreview: { partner: string; d: string | null } | null = null;
  /** A parametric part at other settings, from the preview sliders. */
  partPreview: string | null = null;

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
      this.guideSel = null;
      this.measureLine = null;
      this.fit();
    }
    if (!sameDrawing) {
      this.ruleSel = null;
      this.anchorSel = null;
      this.markPreview = null;
      this.partPreview = null;
    } else if (this.markPreview) void this.refreshMarkPreview();
    void this.loadRuleEnds();
    if (!sameDrawing) {
      void this.loadGuides();
      void this.loadReach();
      void this.loadBackground();
    }
    this.placeInText();
    this.title.textContent = this.drawing.title;
    this.subtitle.textContent = this.drawing.subtitle;
    this.render();
    this.host.renderSide(this);
  }

  // ---------- Line of text ----------

  /** Set the line of text; the edited glyph is shown at its place in it. */
  setText(text: string): void {
    this.textLine = [...text].slice(0, 80).join("");
    this.placeInText();
    this.render();
  }

  /** Find the edited glyph in the line: the occurrence nearest where it was. */
  private placeInText(): void {
    const ch = this.target ? this.host.charOf(this.target) : null;
    const chars = [...this.textLine];
    if (!ch) {
      this.textIndex = -1;
      return;
    }
    if (chars[this.textIndex] === ch) return;
    let best = -1;
    chars.forEach((c, i) => {
      if (c === ch && (best < 0 || Math.abs(i - this.textIndex) < Math.abs(best - this.textIndex))) best = i;
    });
    this.textIndex = best;
  }

  /** Edit the glyph `step` places along the line (skipping spaces and characters with no drawing). */
  stepInText(step: number): void {
    const chars = [...this.textLine];
    for (let i = this.textIndex + step; i >= 0 && i < chars.length; i += step) {
      const g = this.host.glyphFor(chars[i]);
      if (!g) continue;
      this.textIndex = i;
      this.host.openTarget(g.target);
      return;
    }
  }

  /** The other glyphs of the line, laid out around the edited one at their advances. */
  private neighbours(): { i: number; x: number; d: string; advance: number }[] {
    if (this.textIndex < 0 || !this.drawing) return [];
    const chars = [...this.textLine];
    const upm = this.drawing.metrics.units_per_em || 1000;
    const glyph = (ch: string) => {
      if (/\s/.test(ch)) return { d: "", advance: upm * SPACE_EM };
      const g = this.host.glyphFor(ch);
      return g ? { d: g.d ?? "", advance: g.advance } : null;
    };
    const out: { i: number; x: number; d: string; advance: number }[] = [];
    const kern = (l: string, r: string) => this.host.kern?.(l, r) ?? 0;
    let x = 0;
    let next = chars[this.textIndex];
    for (let i = this.textIndex - 1; i >= 0; i--) {
      const g = glyph(chars[i]);
      if (!g) continue;
      x -= g.advance + kern(chars[i], next);
      next = chars[i];
      out.push({ i, x, ...g });
    }
    x = this.frameWidth ?? 0;
    let prev = chars[this.textIndex];
    for (let i = this.textIndex + 1; i < chars.length; i++) {
      const g = glyph(chars[i]);
      if (!g) continue;
      x += kern(prev, chars[i]);
      prev = chars[i];
      out.push({ i, x, ...g });
      x += g.advance;
    }
    return out;
  }

  // ---------- Background layer ----------

  private async loadBackground(): Promise<void> {
    const k = this.targetKey;
    this.background = [];
    try {
      const bg = await api.getBackground(k);
      if (this.targetKey !== k) return;
      this.background = translated(bg, this.origin);
    } catch {
      this.background = [];
    }
    this.render();
    this.host.renderSide(this);
  }

  private saveBackground(): void {
    const stored = translated(this.background, { x: -this.origin.x, y: -this.origin.y });
    api.setBackground(this.targetKey, stored).catch((err) => this.host.toast(`Could not save the background: ${err}`, "error"));
    this.render();
    this.host.renderSide(this);
  }

  /** Copy the selected paths (or the whole drawing) to the background, replacing what was there. */
  copyToBackground(): void {
    const sel = this.selectedContours();
    const from = sel.length ? sel.map((ci) => this.contours[ci]) : this.contours;
    this.background = clone(from).map((c, i) => ({ ...c, id: i, locked: undefined, hidden: undefined }));
    this.saveBackground();
    this.host.toast(sel.length ? "Selection copied to the background." : "Drawing copied to the background.");
  }

  /** Swap the drawing and its background: go back to the copy, keeping the edit behind it. */
  swapBackground(): void {
    if (!this.background.length) return;
    const front = this.contours;
    this.contours = clone(this.background);
    this.background = clone(front);
    this.selection.clear();
    this.commit("Swap with background");
    this.saveBackground();
  }

  clearBackground(): void {
    this.background = [];
    this.saveBackground();
  }

  /** Show another glyph behind this one; an empty string stops. */
  setCompare(ch: string): void {
    const first = [...ch.trim()][0] ?? "";
    if (first) this.compareWith.set(this.targetKey, first);
    else this.compareWith.delete(this.targetKey);
    this.render();
  }

  get compare(): string {
    return this.compareWith.get(this.targetKey) ?? "";
  }

  /** Another master of this drawing shown behind it, by master name, with its outline. */
  compareMaster: { key: string; master: string; d: string } | null = null;

  /** Show this drawing in another master behind it; null stops. */
  async setCompareMaster(master: string | null): Promise<void> {
    const target = this.target;
    if (!master || !target) {
      this.compareMaster = null;
      this.render();
      return;
    }
    try {
      const all = await api.masterDrawings(target);
      const m = all.find((x) => x.master === master);
      this.compareMaster = m ? { key: this.targetKey, master, d: m.d } : null;
    } catch (err) {
      this.host.toast(`Could not show that master: ${err}`, "error");
    }
    this.render();
  }

  /** Trace the sketch image into outlines, added to the drawing. */
  async traceSketch(threshold = 128): Promise<void> {
    const sk = this.sketch;
    if (!sk || !this.drawing) return;
    const img = new Image();
    img.src = sk.href;
    try {
      await img.decode();
    } catch {
      this.host.toast("Could not read the sketch image.", "error");
      return;
    }
    // Work at a size that keeps detail without taking long.
    const k = Math.min(1, 700 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k));
    const h = Math.max(1, Math.round(img.naturalHeight * k));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, w, h);
    const ink = inkFromPixels(ctx.getImageData(0, 0, w, h).data, w, h, threshold);
    const toFont = (p: Vec2): Vec2 => ({ x: sk.x + (p.x / w) * sk.w, y: sk.y + sk.h - (p.y / h) * sk.h });
    // Tidied the way a designer would: extremes added, kinks smoothed, flat lines made straight.
    const traced = fixIssues(traceToContours(ink, w, h, toFont, nextContourId(this.contours)).map((c) => addExtremes(c)));
    if (!traced.length) {
      this.host.toast("Nothing dark enough to trace. Try a higher threshold.");
      return;
    }
    roundContours(traced);
    const start = this.contours.length;
    this.contours = [...this.contours, ...traced];
    this.selection = new Set(traced.flatMap((c, i) => c.points.map((_, pi) => key(start + i, pi))));
    this.commit("Trace sketch");
    this.changedSelection();
    this.host.toast(`Traced ${traced.length} path${traced.length === 1 ? "" : "s"}.`);
  }

  // ---------- Components on the canvas ----------

  /** Turn the selected paths into a new component, placed where they were. */
  async makeComponent(kind: ComponentKind = "corner"): Promise<void> {
    const t = this.target;
    if (t?.kind !== "base" && t?.kind !== "symbol" && t?.kind !== "fidel") {
      this.host.toast("Components are placed on bases, fidel and symbols. Open one to make a component.");
      return;
    }
    const sel = this.selectedContours();
    if (!sel.length) {
      this.host.toast("Select the paths to turn into a component first.");
      return;
    }
    const picked = sel.map((ci) => this.contours[ci]);
    const b = contoursBounds(picked)!;
    // The component's origin: the bottom middle of the selection.
    const at = { x: Math.round((b.minX + b.maxX) / 2), y: Math.round(b.minY) };
    const local = translated(picked, { x: -at.x, y: -at.y }).map((c, i) => ({ ...c, id: i, locked: undefined, hidden: undefined }));
    try {
      const id = await api.addComponent(`${this.drawing?.title ?? "Component"} part`, kind);
      await api.setDrawing({ kind: "component", id }, local);
      const set = new Set(sel);
      this.contours = this.contours.filter((_, ci) => !set.has(ci));
      this.selection.clear();
      this.commit("Make component");
      await this.saving;
      const pid = Math.max(-1, ...this.placements.map((r) => r.id)) + 1;
      this.placementSel = pid;
      await this.setPlacements([...this.placements, { id: pid, component: id, at, on: null }]);
      this.host.toast("Made a component from the selection. Double-click it to edit it in place.");
    } catch (err) {
      this.host.toast(`Could not make the component: ${err}`, "error");
    }
  }

  /** Turn one placed component (or all of them) back into plain paths on the base. */
  async decompose(id?: number): Promise<void> {
    const t = this.target;
    if (t?.kind !== "base" && t?.kind !== "symbol" && t?.kind !== "fidel") return;
    const refs = this.placements;
    const which = id === undefined ? refs : refs.filter((r) => r.id === id);
    if (!which.length) return;
    try {
      let next = nextContourId(this.contours);
      const added: Contour[] = [];
      for (const r of which) {
        const d = await api.getDrawing({ kind: "component", id: r.component });
        for (const c of placeContours(r, d.contours)) added.push({ ...c, id: next++ });
      }
      roundContours(added);
      const start = this.contours.length;
      this.contours = [...this.contours, ...added];
      this.selection = new Set(added.flatMap((c, i) => c.points.map((_, pi) => key(start + i, pi))));
      this.commit(which.length > 1 ? "Decompose all" : "Decompose");
      await this.saving;
      this.placementSel = null;
      await this.setPlacements(refs.filter((r) => !which.includes(r)));
      this.changedSelection();
    } catch (err) {
      this.host.toast(`Could not decompose: ${err}`, "error");
    }
  }

  /** Open a placed component, with this base drawn behind it where the component sits. */
  async editComponentInPlace(id: number): Promise<void> {
    const r = this.placements.find((x) => x.id === id);
    if (!r) return;
    this.hostBehind.set(`component:${r.component}`, unplaceContours(r, this.contours));
    this.host.openTarget({ kind: "component", id: r.component });
  }

  // ---------- Shortcuts ----------

  private previewHeld = false;

  /** Run a rebindable shortcut's action. */
  runAction(id: string): void {
    const tools: Record<string, Tool> = {
      "tool.select": "select",
      "tool.direct": "direct",
      "tool.pen": "pen",
      "tool.pencil": "pencil",
      "tool.knife": "knife",
      "tool.eraser": "eraser",
      "tool.measure": "measure",
      "tool.rect": "rect",
      "tool.ellipse": "ellipse",
      "tool.hand": "hand",
    };
    if (tools[id]) return this.setTool(tools[id]);
    switch (id) {
      case "edit.selectAll":
        return this.selectAll();
      case "edit.invert":
        return this.invertSelection();
      case "edit.duplicate":
        return this.duplicate();
      case "edit.lock":
        return this.setLayerFlag("locked", this.selectedContours());
      case "edit.hide":
        return this.setLayerFlag("hidden", this.selectedContours());
      case "path.reverse":
        return this.reverseDirection();
      case "path.removeOverlap":
        return void this.removeOverlap();
      case "path.join":
        this.joinSelection();
        return;
      case "path.cycleNode":
        return this.cycleNodeType();
      case "view.fit":
        return this.fit();
      case "view.selection":
        return this.zoomToSelection();
      case "view.actual":
        return this.actualSize();
      case "view.zoomIn":
        return this.zoom(1.25);
      case "view.zoomOut":
        return this.zoom(0.8);
      case "view.preview":
        // Held down: the glyph alone, filled, as it will print.
        this.previewHeld = true;
        this.svg.dataset.preview = "true";
        return;
      case "text.next":
        return this.stepInText(1);
      case "text.prev":
        return this.stepInText(-1);
    }
  }

  // ---------- Guides ----------

  private async loadGuides(): Promise<void> {
    const k = this.targetKey;
    try {
      const g = await api.getGuides(k);
      if (this.targetKey !== k) return;
      this.guides = g;
    } catch {
      this.guides = { local: [], global: [] };
    }
    this.render();
  }

  /** Which fidel edits to this base or alteration reach, for the history panel. */
  private async loadReach(): Promise<void> {
    const t = this.target;
    this.reach = null;
    if (t?.kind !== "base" && t?.kind !== "alteration") return;
    try {
      const r = t.kind === "base" ? await api.baseImpacts(t.id) : await api.alterationImpacts(t.id);
      if (this.target === t) {
        this.reach = r;
        this.host.renderSide(this);
      }
    } catch {
      // Not shown; editing still works.
    }
  }

  private saveGuides(): void {
    const { local, global } = this.guides;
    api.setGuides(this.targetKey, local, global).catch((err) => this.host.toast(`Could not save the guides: ${err}`, "error"));
  }

  /** Every guide with its scope, for drawing, hit testing and snapping. */
  allGuides(): { g: Guide; scope: GuideScope }[] {
    if (!prefs.showGuides) return [];
    return [
      ...this.guides.global.map((g) => ({ g, scope: "global" as const })),
      ...this.guides.local.map((g) => ({ g, scope: "local" as const })),
    ];
  }

  selectedGuide(): { g: Guide; scope: GuideScope } | null {
    const s = this.guideSel;
    if (!s) return null;
    const g = this.guides[s.scope].find((x) => x.id === s.id);
    return g ? { g, scope: s.scope } : null;
  }

  private nextGuideId(): number {
    return Math.max(0, ...this.guides.local.map((g) => g.id), ...this.guides.global.map((g) => g.id)) + 1;
  }

  /** Change the selected guide: its position, angle, name, colour, lock, or whether it is global. */
  updateGuide(change: Partial<Guide> & { scope?: GuideScope }): void {
    const sel = this.selectedGuide();
    if (!sel) return;
    const { scope, ...rest } = change;
    Object.assign(sel.g, rest);
    if (scope && scope !== sel.scope) {
      this.guides[sel.scope] = this.guides[sel.scope].filter((x) => x !== sel.g);
      this.guides[scope].push(sel.g);
      this.guideSel = { scope, id: sel.g.id };
    }
    this.saveGuides();
    this.render();
    this.host.renderSide(this);
  }

  deleteGuide(): void {
    const sel = this.selectedGuide();
    if (!sel) return;
    this.guides[sel.scope] = this.guides[sel.scope].filter((x) => x !== sel.g);
    this.guideSel = null;
    this.saveGuides();
    this.render();
    this.host.renderSide(this);
  }

  /** Add a guide through the selection's centre (or the origin), horizontal or vertical. */
  addGuide(angle: number): void {
    const b = contoursBounds(this.selectedContours().map((ci) => this.contours[ci]));
    const at = b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : { x: 0, y: 0 };
    const g: Guide = { id: this.nextGuideId(), x: Math.round(at.x), y: Math.round(at.y), angle };
    this.guides.local.push(g);
    this.guideSel = { scope: "local", id: g.id };
    this.saveGuides();
    this.render();
    this.host.renderSide(this);
  }

  private alterationName(id: string): string {
    return this.host.alterationName(id);
  }

  /** Move a deform's end on this family by `d` (up for a short leg, sideways for a sweep). */
  private async moveDeform(h: DeformHandle, d: number): Promise<void> {
    const target = this.drawing?.target;
    if (target?.kind !== "fidel") return;
    const family = target.id.split("/")[0];
    const offset = h.vertical ? { x: h.offset.x, y: h.offset.y + d } : { x: h.offset.x + d, y: h.offset.y };
    try {
      await api.setAttachOffset(family, h.alteration, offset);
      await this.open(target);
      this.host.changed(target);
    } catch (err) {
      this.host.toast(String(err), "error");
      this.render();
    }
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
    const own = this.drawing?.advanceWidth ?? this.drawing?.context?.advanceWidth;
    if (own != null) return own;
    // A fidel takes its width from its base: read it from the glyph it makes.
    const ch = this.target?.kind === "fidel" ? this.host.charOf(this.target) : null;
    return (ch && this.host.glyphFor(ch)?.advance) || null;
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

  /** A Pa-height zone line under the pointer (Move tool, zones shown). */
  private hitZone(screen: Vec2): string | null {
    if (!this.drawing?.zones || this.tool !== "select" || !prefs.showZones) return null;
    for (const z of this.drawing.zones) {
      if (Math.abs(screen.y - this.toScreen({ x: 0, y: z.position }).y) <= 3) return z.id;
    }
    return null;
  }

  // ---------- Components placed on a base ----------

  /** The placement selected on the canvas or in the inspector. */
  placementSel: number | null = null;
  /** Components placed by rule on this base (leaves, caps, corners). */
  ruleEnds: RuleEnd[] = [];
  /** The selected rule placement, as `component@key`. */
  ruleSel: string | null = null;
  private pendingPlacement: { id: number; d: Vec2 } | null = null;

  get placements(): ComponentRef[] {
    return (this.drawing?.components ?? []).map((c) => c.placement);
  }

  /** Redraw the side panel, e.g. after picking a placement there. */
  refreshSide(): void {
    this.host.renderSide(this);
  }

  /** Write the base's component placements and reload their outlines. */
  /** Tell the app the open drawing changed in the core (outside the canvas). */
  changedInCore(): void {
    if (this.target) this.host.changed(this.target);
  }

  notify(message: string, tone?: "error" | "info"): void {
    this.host.toast(message, tone);
  }

  /** Fetch where components land by rule on this base. */
  async loadRuleEnds(): Promise<void> {
    const target = this.target;
    if (target?.kind !== "base") {
      this.ruleEnds = [];
      return;
    }
    try {
      const ends = await api.ruleEnds(target.id);
      if (this.target?.kind !== "base" || this.target.id !== target.id) return;
      const before = JSON.stringify(this.ruleEnds);
      this.ruleEnds = ends;
      if (this.ruleSel && !ends.some((e) => `${e.component}@${e.key}` === this.ruleSel)) this.ruleSel = null;
      if (JSON.stringify(ends) !== before) {
        this.render();
        this.host.renderSide(this);
      }
    } catch {
      this.ruleEnds = [];
    }
  }

  /** Switch one rule placement on or off, or adjust it. */
  /** Write the anchors (or these), and redraw what depends on them. */
  async saveAnchors(next?: Record<string, { x: number; y: number }>): Promise<void> {
    const target = this.target;
    if (!this.drawing || !target) return;
    if (next) this.drawing.anchors = next;
    try {
      await api.setAnchors(target, this.drawing.anchors ?? {});
      this.host.changed(target);
      if (this.markPreview) await this.refreshMarkPreview();
      this.render();
      this.host.renderSide(this);
    } catch (err) {
      this.host.toast(`Could not save the anchors: ${err}`, "error");
    }
  }

  /** Show another glyph against this one, or stop (null). */
  async setMarkPreview(partner: string | null): Promise<void> {
    this.markPreview = partner ? { partner, d: null } : null;
    await this.refreshMarkPreview();
  }

  async refreshMarkPreview(): Promise<void> {
    const mp = this.markPreview;
    const target = this.target;
    if (!mp || !target) return this.render();
    try {
      mp.d = await api.markPreview(target, this.contours, mp.partner);
    } catch {
      mp.d = null;
    }
    this.render();
  }

  async setRuleEnd(end: RuleEnd, on: boolean, tweak: Tweak): Promise<void> {
    const target = this.target;
    try {
      await api.setComponentEnd(end.component, end.key, on, tweak);
      await this.loadRuleEnds();
      if (target) this.host.changed(target);
    } catch (err) {
      this.host.toast(`Could not change the component: ${err}`, "error");
    }
  }

  async setPlacements(refs: ComponentRef[]): Promise<void> {
    const target = this.target;
    if ((target?.kind !== "base" && target?.kind !== "symbol" && target?.kind !== "fidel") || !this.drawing) return;
    try {
      if (target.kind === "symbol") await api.setSymbolComponents(target.id, refs);
      else if (target.kind === "fidel") await api.setFidelComponents(target.id, refs);
      else await api.setBaseComponents(target.id, refs);
      const fresh = await api.getDrawing(target);
      if (this.target?.kind === target.kind && this.target.id === target.id && this.drawing) {
        this.drawing.components = fresh.components;
      }
      if (this.placementSel !== null && !refs.some((r) => r.id === this.placementSel)) this.placementSel = null;
      this.render();
      this.host.changed(target);
      this.host.renderSide(this);
    } catch (err) {
      this.host.toast(`Could not place the component: ${err}`, "error");
    }
  }

  /** Move a zone line; every deform that lands on it follows. */
  async moveZone(id: string, position: number): Promise<void> {
    try {
      const zones = await api.setZone(id, Math.round(position));
      if (this.drawing) this.drawing.zones = zones;
      this.render();
      if (this.target) this.host.changed(this.target);
      this.host.renderSide(this);
    } catch (err) {
      this.host.toast(`Could not move the zone: ${err}`, "error");
    }
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

  /** Move the selected points onto a guide, along its perpendicular; their handles come along. */
  alignToGuide(scope: GuideScope, id: number): void {
    const g = this.guides[scope].find((x) => x.id === id);
    if (!g) return;
    const moves: { ci: number; pi: number; d: Vec2 }[] = [];
    this.contours.forEach((c, ci) =>
      c.points.forEach((p, pi) => {
        if (!this.selection.has(key(ci, pi)) || !isOn(p)) return;
        const to = projectOnGuide(g, p.pos);
        moves.push({ ci, pi, d: { x: to.x - p.pos.x, y: to.y - p.pos.y } });
      }),
    );
    if (!moves.length) {
      this.host.toast("Select points to put on the guide.");
      return;
    }
    for (const { ci, pi, d } of moves) {
      const pts = this.contours[ci].points;
      const n = pts.length;
      const near = new Set([pi]);
      for (const j of [(pi + n - 1) % n, (pi + 1) % n]) if (!isOn(pts[j]) && !this.selection.has(key(ci, j))) near.add(j);
      this.contours = transformContours(this.contours, translate(d.x, d.y), (c, p) => c === ci && near.has(p));
    }
    roundContours(this.contours);
    this.commit("Align to guide");
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

    // Drag out of a ruler to make a guide; Alt makes it global.
    const ruler = prefs.showRulers ? (e.target as Element | null)?.closest?.("[data-ruler]")?.getAttribute("data-ruler") : null;
    if (ruler) {
      const scope: GuideScope = e.altKey ? "global" : "local";
      const g: Guide = { id: this.nextGuideId(), x: Math.round(font.x), y: Math.round(font.y), angle: ruler === "top" ? 0 : 90 };
      this.guides[scope].push(g);
      this.guideSel = { scope, id: g.id };
      this.gesture = { kind: "guide", scope, id: g.id, start: font, origin: { x: g.x, y: g.y }, isNew: true, moved: false, offRuler: false };
      this.render();
      return;
    }

    if (this.tool === "measure") {
      const at = this.snapped(font, e).pos;
      this.gesture = { kind: "measure", start: at, now: at };
      this.measureLine = null;
      return;
    }

    if (this.tool === "pencil") {
      this.gesture = { kind: "pencil", pts: [font], startScreen: screen };
      return;
    }
    if (this.tool === "knife") {
      this.gesture = { kind: "knife", start: font, now: font };
      return;
    }
    if (this.tool === "eraser") {
      this.gesture = { kind: "eraser", pts: [font] };
      this.render();
      return;
    }

    // A glyph of the line of text: edit it.
    const ti = (e.target as Element | null)?.closest?.("[data-ti]")?.getAttribute("data-ti");
    if (ti != null && (this.tool === "select" || this.tool === "direct")) {
      const g = this.host.glyphFor([...this.textLine][Number(ti)] ?? "");
      if (g) {
        this.textIndex = Number(ti);
        this.host.openTarget(g.target);
        return;
      }
    }

    // An anchor: pick it and drag it.
    const an = (e.target as Element | null)?.closest?.("[data-anchor]")?.getAttribute("data-anchor");
    if (an != null && (this.tool === "select" || this.tool === "direct") && this.drawing.anchors?.[an]) {
      const a = this.drawing.anchors[an];
      this.anchorSel = an;
      this.selection.clear();
      this.gesture = { kind: "anchor", name: an, start: font, origin: { x: a.x, y: a.y }, moved: false };
      this.render();
      this.host.renderSide(this);
      return;
    }

    // A guide under the pointer (and no point): pick it, and drag it unless locked.
    const gid = (e.target as Element | null)?.closest?.("[data-guide]")?.getAttribute("data-guide");
    if (gid && (this.tool === "select" || this.tool === "direct") && !this.hitPoint(screen)) {
      const [scope, id] = gid.split(":") as [GuideScope, string];
      const g = this.guides[scope].find((x) => x.id === Number(id));
      if (g) {
        this.guideSel = { scope, id: g.id };
        this.selection.clear();
        if (!g.locked) {
          this.gesture = { kind: "guide", scope, id: g.id, start: font, origin: { x: g.x, y: g.y }, isNew: false, moved: false, offRuler: false };
        }
        this.changedSelection();
        return;
      }
    }
    if (this.guideSel) {
      this.guideSel = null;
      this.host.renderSide(this);
    }

    // A Tunni point: drag to change both handles of its curve.
    const tun = (e.target as Element | null)?.closest?.("[data-tunni]")?.getAttribute("data-tunni");
    if (tun) {
      const [ci, seg] = tun.split(":").map(Number);
      this.gesture = { kind: "tunni", ci, seg, base: clone(this.contours), moved: false };
      return;
    }

    if (this.tool === "pen") {
      // Clicking the end of an open path carries on drawing it.
      if (!this.pen) {
        const hit = this.hitPoint(screen);
        const c = hit ? this.contours[hit[0]] : null;
        const end = c && hit ? endOf(c, c.points[hit[1]].id) : null;
        if (c && hit && end) {
          this.resumePen(hit[0], end);
          return;
        }
      }
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

    // The end of a deformed stroke on a generated fidel: drag to move it for the family.
    const hid = (e.target as Element | null)?.closest?.("[data-hid]")?.getAttribute("data-hid");
    if (hid != null) {
      this.gesture = { kind: "deform", i: Number(hid), start: font, d: 0 };
      this.render();
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

    const rk = (e.target as Element | null)?.closest?.("[data-rk]")?.getAttribute("data-rk");
    if (rk != null && !direct) {
      this.ruleSel = rk;
      this.placementSel = null;
      this.selection.clear();
      this.changedSelection();
      return;
    }
    if (this.ruleSel !== null) {
      this.ruleSel = null;
      this.host.renderSide(this);
    }

    const pid = (e.target as Element | null)?.closest?.("[data-pid]")?.getAttribute("data-pid");
    if (pid != null && !direct) {
      this.placementSel = Number(pid);
      this.selection.clear();
      this.gesture = { kind: "placement", id: Number(pid), start: font, d: { x: 0, y: 0 }, moved: false };
      this.changedSelection();
      return;
    }
    if (this.placementSel !== null) {
      this.placementSel = null;
      this.host.renderSide(this);
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

    const zone = this.hitZone(screen);
    if (zone) {
      const at = this.drawing.zones!.find((z) => z.id === zone)!.position;
      this.gesture = { kind: "zone", id: zone, start: at, now: at };
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
      case "knife": {
        g.now = e.shiftKey ? constrain45(g.start, font) : font;
        break;
      }
      case "eraser":
        g.pts.push(font);
        break;
      case "measure": {
        const to = e.shiftKey ? constrain45(g.start, font) : this.snapped(font, e).pos;
        g.now = to;
        break;
      }
      case "anchor": {
        const a = this.drawing?.anchors?.[g.name];
        if (!a) break;
        const s = this.snapped({ x: g.origin.x + font.x - g.start.x, y: g.origin.y + font.y - g.start.y }, e);
        a.x = Math.round(s.pos.x);
        a.y = Math.round(s.pos.y);
        this.snapLines = s.lines;
        g.moved ||= Math.hypot(font.x - g.start.x, font.y - g.start.y) * this.view.scale > 1;
        break;
      }
      case "guide": {
        const gd = this.guides[g.scope].find((x) => x.id === g.id);
        if (!gd) break;
        const want = { x: g.origin.x + font.x - g.start.x, y: g.origin.y + font.y - g.start.y };
        const s = this.snapped(want, e, false, gd);
        if (isHorizontal(gd)) gd.y = Math.round(s.pos.y);
        else if (isVertical(gd)) gd.x = Math.round(s.pos.x);
        else {
          gd.x = Math.round(s.pos.x);
          gd.y = Math.round(s.pos.y);
        }
        this.snapLines = isHorizontal(gd) ? { y: s.lines.y } : isVertical(gd) ? { x: s.lines.x } : s.lines;
        g.moved ||= Math.hypot(font.x - g.start.x, font.y - g.start.y) * this.view.scale > 1;
        const sc = this.screenOf(e);
        // Dragged back onto its ruler: it will be removed.
        g.offRuler = isHorizontal(gd) ? sc.y < RULER_PX : isVertical(gd) ? sc.x < RULER_PX : false;
        break;
      }
      case "pencil": {
        const last = g.pts[g.pts.length - 1];
        if (Math.hypot(font.x - last.x, font.y - last.y) * this.view.scale > 1.5) g.pts.push(font);
        break;
      }
      case "tunni": {
        const c = g.base[g.ci];
        const seg = segments(c)[g.seg];
        const res = seg ? moveTunni(seg.pts, font) : null;
        if (!res) break;
        const nodes = toNodes(c);
        const a = nodes[seg.from].out;
        const b = nodes[seg.to].in;
        if (!a || !b) break;
        const cur = clone(c);
        for (const p of cur.points) {
          if (p.id === a.id) p.pos = { x: Math.round(res[0].x), y: Math.round(res[0].y) };
          if (p.id === b.id) p.pos = { x: Math.round(res[1].x), y: Math.round(res[1].y) };
        }
        this.contours[g.ci] = cur;
        g.moved = true;
        break;
      }
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
      case "zone": {
        g.now = Math.round(this.snapped({ x: 0, y: font.y }, { altKey: true }).pos.y);
        const z = this.drawing?.zones?.find((z) => z.id === g.id);
        if (z) z.position = g.now;
        break;
      }
      case "deform": {
        const h = this.drawing?.handles[g.i];
        if (h) g.d = Math.round(h.vertical ? font.y - g.start.y : font.x - g.start.x);
        break;
      }
      case "placement": {
        let d = { x: font.x - g.start.x, y: font.y - g.start.y };
        if (e.shiftKey) d = Math.abs(d.x) > Math.abs(d.y) ? { x: d.x, y: 0 } : { x: 0, y: d.y };
        g.d = { x: Math.round(d.x), y: Math.round(d.y) };
        g.moved ||= Math.hypot(d.x, d.y) * this.view.scale > 2;
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
      else if (this.hitZone(screen) && this.hitShapeAt(screen) === null) cursor = "ns";
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
    } else if (g.kind === "zone") {
      if (g.now !== g.start) void this.moveZone(g.id, g.now);
    } else if (g.kind === "knife") {
      if (Math.hypot(g.now.x - g.start.x, g.now.y - g.start.y) * this.view.scale > 4) void this.knife(g.start, g.now);
      else this.render();
    } else if (g.kind === "eraser") {
      this.erase(g.pts);
    } else if (g.kind === "measure") {
      const far = Math.hypot(g.now.x - g.start.x, g.now.y - g.start.y) * this.view.scale > 3;
      this.measureLine = far ? { a: g.start, b: g.now } : null;
      this.render();
    } else if (g.kind === "anchor") {
      if (g.moved) void this.saveAnchors();
      this.render();
      this.host.renderSide(this);
    } else if (g.kind === "guide") {
      if (g.offRuler || (g.isNew && !g.moved)) {
        this.guides[g.scope] = this.guides[g.scope].filter((x) => x.id !== g.id);
        this.guideSel = null;
      }
      if (g.moved || g.isNew) this.saveGuides();
      this.render();
      this.host.renderSide(this);
    } else if (g.kind === "pencil") {
      this.finishPencil(g.pts, g.startScreen, this.screenOf(e));
    } else if (g.kind === "tunni") {
      if (g.moved) this.commit("Tunni line");
      this.render();
    } else if (g.kind === "deform") {
      const h = this.drawing?.handles[g.i];
      if (h && g.d) void this.moveDeform(h, g.d);
      else this.render();
    } else if (g.kind === "placement") {
      if (g.moved && (g.d.x || g.d.y)) {
        const refs = this.placements.map((r) =>
          r.id === g.id ? { ...r, at: { x: r.at.x + g.d.x, y: r.at.y + g.d.y } } : r,
        );
        // Keep the dragged outline where it was dropped until the core answers.
        this.pendingPlacement = { id: g.id, d: g.d };
        void this.setPlacements(refs).finally(() => {
          this.pendingPlacement = null;
          this.render();
        });
      } else this.host.renderSide(this);
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
    // Double-clicking a placed component edits it in place.
    const pid = (e.target as Element | null)?.closest?.("[data-pid]")?.getAttribute("data-pid");
    if (pid != null) {
      void this.editComponentInPlace(Number(pid));
      return;
    }
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
  private snapTargets(skipSelected: boolean, skipGuide?: Guide): { xs: number[]; ys: number[] } {
    const m = this.drawing!.metrics;
    const xs: number[] = [];
    const ys: number[] = [];
    if (prefs.snapGuides) {
      for (const { g } of this.allGuides()) {
        if (g === skipGuide) continue;
        if (isHorizontal(g)) ys.push(g.y);
        else if (isVertical(g)) xs.push(g.x);
      }
    }
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
      for (const z of this.drawing?.zones ?? []) ys.push(z.position);
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

  private snapped(p: Vec2, e: { altKey: boolean }, skipSelected = false, skipGuide?: Guide): { pos: Vec2; lines: { x?: number; y?: number } } {
    if (e.altKey || !this.drawing) return { pos: p, lines: {} };
    const { xs, ys } = this.snapTargets(skipSelected, skipGuide);
    // Slanted guides pull the point onto themselves.
    if (prefs.snapGuides) {
      for (const { g } of this.allGuides()) {
        if (g === skipGuide || isHorizontal(g) || isVertical(g)) continue;
        if (distanceToGuide(g, p) * this.view.scale <= SNAP_PX) return { pos: projectOnGuide(g, p), lines: {} };
      }
    }
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
        this.finishPen(true);
        return;
      }
    }
    const node: Node = { id: -1, pos, smooth: false };
    this.pen.push(node);
    this.gesture = { kind: "pen-drag", node };
    this.render();
  }

  /**
   * End the path being drawn. Clicking its first point closes it; Enter,
   * Escape or another tool leave it open, to carry on later from either end.
   */
  finishPen(close = false): void {
    const nodes = this.pen;
    const resumed = this.penFrom;
    this.pen = null;
    this.penFrom = null;
    if (!nodes || nodes.length < 2) {
      if (resumed) this.contours.splice(resumed.at, 0, resumed.contour);
      this.render();
      return;
    }
    let id = 0;
    for (const nd of nodes) {
      nd.id = id++;
      if (nd.in) nd.in = { id: id++, pos: { x: Math.round(nd.in.pos.x), y: Math.round(nd.in.pos.y) } };
      if (nd.out) nd.out = { id: id++, pos: { x: Math.round(nd.out.pos.x), y: Math.round(nd.out.pos.y) } };
    }
    const at = resumed ? resumed.at : this.contours.length;
    const contour = fromNodes(nodes, resumed?.contour.id ?? nextContourId(this.contours), resumed?.contour.part ?? null, id, !close);
    if (resumed?.contour.name) contour.name = resumed.contour.name;
    this.contours.splice(at, 0, contour);
    this.selection = new Set(contour.points.map((_, pi) => key(at, pi)));
    this.commit(close ? "Pen path" : "Open path");
    this.render();
  }

  /** Pick up an open path at one end and keep drawing from it. */
  private resumePen(ci: number, end: "start" | "end"): void {
    const c = this.contours[ci];
    let nodes = toNodes(c);
    if (end === "start") nodes = [...nodes].reverse().map((nd) => ({ ...nd, in: nd.out, out: nd.in }));
    this.contours.splice(ci, 1);
    this.penFrom = { at: ci, contour: c };
    this.selection.clear();
    this.pen = nodes;
    this.render();
  }

  cancelPen(): void {
    this.finishPen(false);
  }

  /** Turn a freehand stroke into curves: closed when it ends where it began. */
  private finishPencil(pts: Vec2[], startScreen: Vec2, endScreen: Vec2): void {
    if (pts.length < 3) return this.render();
    const closed = pts.length > 8 && Math.hypot(startScreen.x - endScreen.x, startScreen.y - endScreen.y) < HIT_PX * 2;
    // About one screen pixel and a half of tolerance, in font units.
    const nodes = fitStroke(pts, Math.max(1, 1.5 / this.view.scale), closed);
    if (nodes.length < 2) return this.render();
    const at = this.contours.length;
    const contour = fromNodes(nodes, nextContourId(this.contours), null, undefined, !closed);
    this.contours.push(contour);
    this.selection = new Set(contour.points.map((_, pi) => key(at, pi)));
    this.commit("Pencil");
    this.changedSelection();
  }

  // ---------- Edits ----------

  setTool(tool: Tool): void {
    if (this.pen && tool !== "pen") this.finishPen(false);
    if (isShape(tool)) this.shape = tool;
    if (tool !== "measure") this.measureLine = null;
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
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    // Plain SVG that Figma and Illustrator paste as shapes, carrying our own
    // paths too so pasting back here is exact.
    const data = esc(JSON.stringify({ [CLIP_TAG]: picked }));
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${b.minX} ${-b.maxY} ${w} ${h}">` +
      `<metadata>${data}</metadata><path transform="scale(1 -1)" d="${d}"/></svg>`;
    return { json: svg, svg };
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
        // Our paths come inside an SVG's metadata, or (from older copies) as bare JSON.
        const meta = /<metadata>([\s\S]*?)<\/metadata>/.exec(text)?.[1];
        const json = meta ? unesc(meta) : text;
        const parsed = JSON.parse(json);
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

  // ---------- Curve tools ----------

  /** Close the selected open paths with a straight segment. */
  closePaths(): void {
    this.editSelectedContours((c) => closePath(c), "Close path");
  }

  /** Whether any selected path is open. */
  get hasOpenSelection(): boolean {
    return this.selectedContours().some((ci) => this.contours[ci]?.open);
  }

  /** Selected on-curve points, as [contour index, point id]. */
  private selectedOnCurve(): [number, number][] {
    return [...this.selection].map(parseKey).flatMap(([ci, pi]) => {
      const p = this.contours[ci]?.points[pi];
      return p && isOn(p) ? [[ci, p.id] as [number, number]] : [];
    });
  }

  /** Cut paths at the selected on-curve points. */
  breakAtSelection(): void {
    const picked = this.selectedOnCurve();
    if (!picked.length) return;
    // Work contour by contour, from the last point back, so earlier cuts keep their ids.
    const byContour = new Map<number, number[]>();
    for (const [ci, id] of picked) byContour.set(ci, [...(byContour.get(ci) ?? []), id]);
    let free = nextContourId(this.contours);
    const out: Contour[] = [];
    const cut: number[] = [];
    this.contours.forEach((c, ci) => {
      const ids = byContour.get(ci);
      if (!ids) return out.push(c);
      let pieces = [c];
      for (const id of ids) {
        pieces = pieces.flatMap((pc) => (pc.points.some((p) => p.id === id && isOn(p)) ? breakAt(pc, id, free++) : [pc]));
      }
      for (const pc of pieces) {
        cut.push(out.length);
        out.push(pc);
      }
    });
    this.contours = out;
    this.selection = new Set(cut.flatMap((ci) => this.contours[ci].points.map((_, pi) => key(ci, pi))));
    this.commit("Break path");
    this.changedSelection();
  }

  /** Join two selected open ends (or close a path whose two ends are selected). */
  joinSelection(): boolean {
    const ends = this.selectedOnCurve().flatMap(([ci, id]) => {
      const e = endOf(this.contours[ci], id);
      return e ? [{ ci, e }] : [];
    });
    if (ends.length !== 2) return false;
    const [a, b] = ends;
    const joined = joinPaths(this.contours[a.ci], a.e, this.contours[b.ci], b.e);
    this.contours[a.ci] = joined;
    if (b.ci !== a.ci) this.contours.splice(b.ci, 1);
    const ci = b.ci !== a.ci && b.ci < a.ci ? a.ci - 1 : a.ci;
    this.selection = new Set(this.contours[ci].points.map((_, pi) => key(ci, pi)));
    this.commit(b.ci === a.ci ? "Close path" : "Join paths");
    this.changedSelection();
    return true;
  }

  /** Whether the selection is two open ends that can be joined. */
  get canJoin(): boolean {
    return this.selectedOnCurve().filter(([ci, id]) => endOf(this.contours[ci], id)).length === 2;
  }

  /** Move the selected smooth points so curvature matches on both sides. */
  harmonize(): void {
    this.editSelectedContours((c, ids) => harmonize(c, ids), "Harmonize");
  }

  /** Even out handle tension on the curves between selected points. */
  balanceHandles(): void {
    this.editSelectedContours((c, ids) => balanceContour(c, ids.size ? ids : new Set(c.points.map((p) => p.id))), "Balance handles");
  }

  /** Let the selected points set their own handles (Hobby curves). */
  autoHandles(): void {
    this.editSelectedContours((c, ids) => autoHandles(c, ids), "Automatic handles");
  }

  // ---------- Path operations (done by the core) ----------

  /** Contours a path operation works on: the selected ones, or every editable one. */
  private opTargets(): number[] {
    const sel = this.selectedContours();
    if (sel.length) return sel;
    return this.contours.flatMap((c, ci) => (c.locked || c.hidden ? [] : [ci]));
  }

  /**
   * Replace contours `which` with `result`, keeping part tags and names when
   * one contour turns into others, then fix path directions.
   */
  private replaceContours(which: number[], result: Contour[], label: string): void {
    const set = new Set(which);
    // Results keep a part tag or name only when every replaced contour shared it.
    const shared = <K extends "part" | "name">(k: K) => {
      const v = this.contours[which[0]]?.[k];
      return which.every((ci) => this.contours[ci][k] === v) ? v : undefined;
    };
    const part = shared("part");
    const name = shared("name");
    for (const c of result) {
      if (part && !c.part) c.part = part;
      if (name && !c.name) c.name = name;
    }
    const kept = this.contours.filter((_, ci) => !set.has(ci));
    // The results go where the first of the replaced contours was.
    const at = Math.min(Math.min(...which), kept.length);
    const merged = [...kept.slice(0, at), ...result, ...kept.slice(at)];
    // New outlines come back in any direction: outer paths counter-clockwise, counters clockwise.
    const ok = directionOk(merged);
    const fixed = merged.map((c, i) => (i >= at && i < at + result.length && !ok[i] ? reversed(c) : c));
    this.contours = fixed;
    this.selection = new Set(result.flatMap((_, i) => fixed[at + i].points.map((__, pi) => key(at + i, pi))));
    this.commit(label);
    this.changedSelection();
  }

  private async runOp(which: number[], op: PathOp, label: string): Promise<void> {
    if (!which.length) return;
    try {
      const out = await api.pathOp(op);
      this.replaceContours(which, out, label);
    } catch (err) {
      this.host.toast(`${label} failed: ${err}`, "error");
    }
  }

  /** Merge overlapping paths into one outline. */
  removeOverlap(): Promise<void> {
    const which = this.opTargets().filter((ci) => !this.contours[ci].open);
    return this.runOp(which, { op: "remove-overlap", contours: which.map((ci) => this.contours[ci]) }, "Remove overlap");
  }

  /**
   * Booleans between selected paths. The frontmost (last) selected path is
   * the one that cuts, as in Figma; union merges them all.
   */
  booleanOp(kind: BooleanKind): Promise<void> {
    const which = this.selectedContours().filter((ci) => !this.contours[ci].open);
    if (which.length < 2) {
      this.host.toast("Select two or more closed paths first.");
      return Promise.resolve();
    }
    const front = which[which.length - 1];
    const rest = which.slice(0, -1);
    const label = { union: "Union", subtract: "Subtract", intersect: "Intersect", exclude: "Exclude" }[kind];
    return this.runOp(
      which,
      { op: "boolean", a: rest.map((ci) => this.contours[ci]), b: [this.contours[front]], kind, firstId: nextContourId(this.contours) },
      label,
    );
  }

  /** Grow (positive) or shrink (negative) the selected paths. */
  offsetPaths(distance: number, join: StrokeJoin): Promise<void> {
    const which = this.opTargets().filter((ci) => !this.contours[ci].open);
    return this.runOp(which, { op: "offset", contours: which.map((ci) => this.contours[ci]), distance, join, firstId: nextContourId(this.contours) }, "Offset path");
  }

  /** Turn the selected paths into outlines of the given width. */
  expandStroke(width: number, join: StrokeJoin): Promise<void> {
    const which = this.opTargets();
    return this.runOp(which, { op: "expand-stroke", contours: which.map((ci) => this.contours[ci]), width, join, firstId: nextContourId(this.contours) }, "Expand stroke");
  }

  /** Cut along a line: the selected paths, or everything under it. */
  async knife(from: Vec2, to: Vec2): Promise<void> {
    const which = this.opTargets().filter((ci) => !this.contours[ci].open);
    await this.runOp(which, { op: "knife", contours: which.map((ci) => this.contours[ci]), from, to, firstId: nextContourId(this.contours) }, "Knife");
  }

  /**
   * Eraser: remove every path segment the stroke passed over. Closed paths
   * open where they were erased; open paths split.
   */
  erase(trail: Vec2[]): void {
    const r = ERASER_RADIUS / this.view.scale;
    const near = (p: Vec2) => {
      if (trail.length === 1) return Math.hypot(p.x - trail[0].x, p.y - trail[0].y) <= r;
      for (let i = 1; i < trail.length; i++) {
        if (distToSegment(p, trail[i - 1], trail[i]) <= r) return true;
      }
      return false;
    };
    let freeId = nextContourId(this.contours);
    let changed = false;
    const next: Contour[] = [];
    for (const c of this.contours) {
      if (c.locked || c.hidden) {
        next.push(c);
        continue;
      }
      const touched = new Set<number>();
      segments(c).forEach((seg, k) => {
        for (let t = 0; t <= 1.0001; t += 1 / 16) if (near(pointAt(seg.pts, t))) return void touched.add(k);
      });
      if (!touched.size) {
        next.push(c);
        continue;
      }
      changed = true;
      const pieces = eraseSegments(c, touched, freeId);
      freeId = Math.max(freeId, ...pieces.map((p) => p.id + 1));
      next.push(...pieces);
    }
    if (!changed) return this.render();
    this.contours = next;
    this.selection.clear();
    this.commit("Erase");
    this.render();
    this.host.renderSide(this);
  }

  /** Merge doubled points, straighten flat curves and drop in-line points. */
  tidyUp(): void {
    this.editSelectedContours((c) => tidyUp(c), "Tidy up", true);
  }

  /** Round or chamfer the selected corner points. */
  roundCorners(radius: number, style: "round" | "chamfer"): void {
    this.editSelectedContours((c, ids) => roundCorners(c, ids, radius, style), style === "round" ? "Round corners" : "Chamfer corners");
  }

  /** Move the selected on-curve points, reshaping the curves next to them proportionally. */
  powerNudge(dx: number, dy: number): void {
    if (!this.selectedOnCurve().length) return this.nudge(dx, dy);
    this.editSelectedContours((c, ids) => powerNudge(c, ids, { x: dx, y: dy }), "Power nudge");
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
    // In an italic, measured along the slant through the baseline, like the metric lines.
    const lean = Math.tan(((this.drawing?.metrics.italic_angle ?? 0) * Math.PI) / 180);
    const shown = this.visibleContours().length ? this.visibleContours() : this.contours;
    const b = contoursBounds(lean ? shown.map((c) => ({ ...c, points: c.points.map((p) => ({ ...p, pos: { x: p.pos.x - p.pos.y * lean, y: p.pos.y } })) })) : shown);
    const ink = this.drawing?.built?.ink;
    if (!b && ink) return { lsb: Math.round(ink[0]), rsb: Math.round(w - ink[1]), width: w };
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

  /** Set the metric keys of this base or symbol, then take the outline the core keyed. */
  async setMetricKeys(keys: MetricKeys): Promise<void> {
    const target = this.target;
    if (!target || (target.kind !== "base" && target.kind !== "symbol")) return;
    try {
      await this.saving;
      await api.setMetricKeys(target, keys);
      await this.syncFromCore();
      this.host.changed(target);
    } catch (err) {
      this.host.toast(`Could not set the key: ${err}`, "error");
    }
  }

  /** Give every other master this drawing's sidebearings. */
  async copyMetricsToMasters(): Promise<void> {
    const target = this.target;
    if (!target) return;
    try {
      await this.saving;
      const n = await api.copyMetricsToMasters(target);
      this.host.toast(n ? `Sidebearings copied to ${n} other master${n > 1 ? "s" : ""}.` : "The other masters already match.");
      this.host.changed(target);
    } catch (err) {
      this.host.toast(`Could not copy the metrics: ${err}`, "error");
    }
  }

  /** After a save, metric keys may have moved the outline or changed the width in the core: take that in. */
  private async syncFromCore(): Promise<void> {
    const target = this.target;
    if (!target || !this.drawing) return;
    const fresh = await api.getDrawing(target);
    if (this.target?.kind !== target.kind || this.target.id !== target.id || !this.drawing) return;
    this.drawing.metricKeys = fresh.metricKeys;
    const now = JSON.stringify({ c: fresh.contours, w: fresh.advanceWidth });
    if (now !== this.history.now) {
      this.contours = translated(fresh.contours, this.origin);
      this.drawing.advanceWidth = fresh.advanceWidth;
      this.savedAdvance = fresh.advanceWidth;
      this.history.now = this.snapshot();
    }
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
    // On a generated fidel, adding or removing points draws it by hand.
    const drawsByHand = !!this.drawing?.generated && !samePoints(this.drawing.contours, s.c);
    // Keep writes in order.
    this.saving = this.saving
      .then(() => api.setDrawing(target, s.c))
      .then(() => (widthChanged ? api.setAdvance(target, s.w!) : undefined))
      .then(() => {
        if (drawsByHand && this.drawing && this.target?.kind === target.kind && this.target.id === target.id) {
          this.drawing.generated = false;
          this.drawing.handles = [];
          this.drawing.subtitle = this.drawing.subtitle.replace(/ · .*$/, " · drawn by hand");
          this.subtitle.textContent = this.drawing.subtitle;
          this.render();
          this.host.toast("Now drawn by hand. Pick a form in the panel to go back to the generated one.");
        }
        if (target.kind === "base") void this.loadRuleEnds();
        // Drawing on a built letter draws it by hand.
        if (this.drawing?.built && s.c.length && this.target?.kind === target.kind && this.target.id === target.id) {
          this.drawing.built = undefined;
          this.host.renderSide(this);
          this.host.toast("Now drawn by hand. Type its parts in the panel to build it again.");
        }
        // Keys on this glyph (or on ones it follows) may have moved it.
        const mk = this.drawing?.metricKeys?.keys;
        if (mk && (mk.left || mk.right || mk.width)) void this.syncFromCore();
        // Drawing on a base made from another one makes it its own.
        const dv = this.drawing?.derived;
        if (dv?.follows && this.target?.kind === "base" && this.target.id === target.id) {
          dv.follows = false;
          this.drawing!.subtitle = "Base · drawn by hand";
          this.subtitle.textContent = this.drawing!.subtitle;
          this.host.renderSide(this);
        }
        this.host.changed(target);
      })
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
      input.value = "";
      if (!file) return;
      try {
        this.pasteSvg(await vectorFileToSvg(file));
      } catch (err) {
        this.host.toast(err instanceof Error ? err.message : String(err), "error");
      }
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
      // Vectors from other apps: SVG on the clipboard, as text or inside HTML.
      const html = e.clipboardData?.getData("text/html") ?? "";
      const text = e.clipboardData?.getData("image/svg+xml") || (plain.includes("<svg") ? plain : "") || svgFromHtml(html) || "";
      if (text.trim()) {
        e.preventDefault();
        this.pasteSvg(text);
      } else if (isFigmaClipboard(html)) {
        e.preventDefault();
        this.host.toast("Figma keeps its own copies to itself. In Figma, use Copy as SVG (Ctrl Shift C), then paste here.");
      } else if (plain.trim() && !clipboard) {
        e.preventDefault();
        this.host.toast("Nothing to paste as outlines. Copy shapes as SVG, or import a PDF, AI or EPS file.");
      } else if (clipboard) {
        e.preventDefault();
        this.pastePaths();
      }
    });

    window.addEventListener("keydown", (e) => {
      if (!this.isActive() || isTyping(e.target)) return;
      // Rebindable shortcuts first.
      const combo = comboOf(e);
      // Kerning keys belong to the kerning view; here Alt+arrows power-nudge.
      const action = actionFor(combo)?.startsWith("kern.") ? null : actionFor(combo);
      if (action) {
        e.preventDefault();
        if (!e.repeat || action.startsWith("view.zoom") || action === "view.preview") this.runAction(action);
        return;
      }
      if (isFreedDefault(combo)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (k.startsWith("arrow")) {
        e.preventDefault();
        const [small, medium, large] = prefs.nudge;
        const step = mod ? large : e.shiftKey ? medium : small;
        const d = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, step], arrowdown: [0, -step] }[k];
        // Alt: power nudge, which brings the curves along proportionally.
        if (d && e.altKey) this.powerNudge(d[0], d[1]);
        else if (d) this.nudge(d[0], d[1]);
        return;
      }
      if (k === "pagedown" || k === "pageup") {
        e.preventDefault();
        this.stepInText(k === "pagedown" ? 1 : -1);
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
      } else if (mod && e.shiftKey && k === "o") {
        e.preventDefault();
        void this.removeOverlap();
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
      else if (k === "b") this.setTool("pencil");
      else if (k === "k") this.setTool("knife");
      else if (e.shiftKey && k === "e") this.setTool("eraser");
      else if (k === "m") this.setTool("measure");
      else if (e.shiftKey && k === "j") this.joinSelection();
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
        if (this.pen) this.finishPen(false);
        else if (this.measureLine || this.guideSel) {
          this.measureLine = null;
          this.guideSel = null;
          this.render();
          this.host.renderSide(this);
        } else {
          this.selection.clear();
          this.pivot = null;
          this.render();
          this.host.renderSide(this);
        }
      } else if (k === "enter" && this.pen) this.finishPen(false);
      else if (k === "delete" || k === "backspace") {
        e.preventDefault();
        if (this.guideSel && !this.selection.size) this.deleteGuide();
        else this.deleteSelection(!e.altKey);
      }
    });
    window.addEventListener("blur", () => {
      this.previewHeld = false;
      delete this.svg.dataset.preview;
      this.zoomHeld = false;
      delete this.svg.dataset.zoom;
    });
    window.addEventListener("keyup", (e) => {
      if (this.previewHeld && actionFor(comboOf(e)) === "view.preview") {
        this.previewHeld = false;
        delete this.svg.dataset.preview;
      }
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
    if (prefs.solidPoints) this.svg.dataset.solidPoints = "true";
    else delete this.svg.dataset.solidPoints;
    if (prefs.pointColors) this.svg.dataset.pointColors = "true";
    else delete this.svg.dataset.pointColors;
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
    // Pa-height zones: where shortened legs end, cricks bend, and so on.
    if (prefs.showZones) {
      const g0 = this.gesture;
      for (const z of this.drawing.zones ?? []) {
        const active = g0?.kind === "zone" && g0.id === z.id;
        const y = sy(z.position);
        const h = z.size * scale;
        parts.push(
          `<rect class="zone" x="0" y="${y - h / 2}" width="${W}" height="${h}"/>`,
          `<line class="zone-line${active ? " active" : ""}" x1="0" x2="${W}" y1="${y}" y2="${y}"/>`,
          `<text class="zone-label" x="${W - 12}" y="${y - 5}">${esc(z.name)} ${Math.round(z.position)}</text>`,
        );
      }
    }
    const guide = (y: number, label: string, cls = "guide") =>
      `<line class="${cls}" x1="0" x2="${W}" y1="${sy(y)}" y2="${sy(y)}"/><text class="guide-label" x="${prefs.showRulers ? RULER_PX + 8 : 12}" y="${sy(y) - 6}">${label}</text>`;
    if (prefs.showMetrics) {
      parts.push(guide(m.pa_top, `Pa-top ${m.pa_top}`));
      parts.push(guide(m.pa_bottom, m.pa_bottom === 0 ? "Baseline · Pa-bottom 0" : `Pa-bottom ${m.pa_bottom}`));
      if (m.pa_bottom !== 0) parts.push(guide(0, "Baseline", "guide guide-baseline"));
    }

    const frame = this.frameWidth;
    const g = this.gesture;
    if (frame !== null && (prefs.showMetrics || g?.kind === "metric")) {
      const own = this.drawing.advanceWidth !== null;
      const dragging = g?.kind === "metric" ? g.side : null;
      // Leaning with the italic angle, through the baseline.
      const lean = Math.tan(((m.italic_angle ?? 0) * Math.PI) / 180);
      const fyTop = ty / scale;
      const fyBottom = (ty - H) / scale;
      for (const [x, side] of [[0, "left"], [frame, "right"]] as const) {
        parts.push(
          `<line class="guide guide-v${own ? " metric" : ""}${dragging === side ? " active" : ""}" x1="${sx(x + fyTop * lean)}" x2="${sx(x + fyBottom * lean)}" y1="0" y2="${H}"/>`,
        );
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
    // A letter built from parts: the built outline, filled behind.
    if (this.drawing.built && !this.contours.length) {
      parts.push(`<path class="built-layer" transform="${xf}" d="${this.drawing.built.d}"/>`);
    }
    if (this.markPreview?.d) {
      parts.push(`<path class="mark-preview" transform="${xf}" d="${this.markPreview.d}"/>`);
    }
    if (this.partPreview) {
      parts.push(`<path class="part-preview" transform="${xf}" d="${this.partPreview}"/>`);
    }

    // Snap guides.
    if (this.snapLines.x !== undefined) {
      parts.push(`<line class="snap-line" x1="${sx(this.snapLines.x)}" x2="${sx(this.snapLines.x)}" y1="0" y2="${H}"/>`);
    }
    if (this.snapLines.y !== undefined) {
      parts.push(`<line class="snap-line" x1="0" x2="${W}" y1="${sy(this.snapLines.y)}" y2="${sy(this.snapLines.y)}"/>`);
    }

    // Background layer and a glyph to compare with: outlines only, behind the drawing.
    if (prefs.showBackground && this.background.length) {
      parts.push(`<path class="background-layer" transform="${xf}" d="${this.background.map(contourPath).join("")}"/>`);
    }
    const host = this.hostBehind.get(this.targetKey);
    if (host?.length) parts.push(`<path class="host-layer" transform="${xf}" d="${host.map(contourPath).join("")}"/>`);
    const cmp = this.compare ? this.host.glyphFor(this.compare) : null;
    if (cmp?.d) parts.push(`<path class="compare-layer" transform="${xf}" d="${cmp.d}"/>`);
    const cm = this.compareMaster;
    if (cm?.key === this.targetKey && cm.d) parts.push(`<path class="compare-layer master" transform="${xf}" d="${cm.d}"/>`);

    // The rest of the line of text, filled, to judge the glyph in context.
    for (const n of this.neighbours()) {
      if (!n.d) continue;
      // The whole advance box is clickable, not just the ink.
      parts.push(
        `<rect class="neighbour-box" data-ti="${n.i}" x="${sx(n.x)}" y="${sy(m.pa_top)}" width="${n.advance * scale}" height="${(m.pa_top - m.pa_bottom) * scale}"/>`,
        `<path class="neighbour" data-ti="${n.i}" transform="matrix(${scale} 0 0 ${-scale} ${tx + n.x * scale} ${ty})" d="${n.d}"/>`,
      );
      // Their sidebearings too, so spacing is judged in the line.
      const ink = prefs.showMetrics ? pathXRange(n.d) : null;
      if (ink) {
        const y = sy(m.pa_bottom) + 18;
        parts.push(
          `<line class="neighbour-edge" x1="${sx(n.x)}" x2="${sx(n.x)}" y1="${sy(m.pa_top)}" y2="${y + 4}"/>`,
          `<line class="neighbour-edge" x1="${sx(n.x + n.advance)}" x2="${sx(n.x + n.advance)}" y1="${sy(m.pa_top)}" y2="${y + 4}"/>`,
          `<text class="neighbour-sb" x="${sx(n.x) + 4}" y="${y}">${Math.round(ink[0])}</text>`,
          `<text class="neighbour-sb" x="${sx(n.x + n.advance) - 4}" y="${y}" text-anchor="end">${Math.round(n.advance - ink[1])}</text>`,
        );
      }
    }

    // Filled outline (all visible contours together, so counters cut out),
    // then each contour for hit testing and part colour.
    const visible = this.visibleContours();
    const all = visible.filter((c) => !c.open).map(contourPath).join("");
    parts.push(`<path class="outline-fill${prefs.fill ? "" : " no-fill"}" transform="${xf}" d="${all}"/>`);
    this.contours.forEach((c, ci) => {
      if (c.hidden) return;
      const color = c.part ? PART_COLORS[c.part] : null;
      const cls = `contour${color ? " tagged" : ""}${c.locked ? " locked" : ""}${c.open ? " open" : ""}`;
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

    // Guides: over the outline, under the points. A wide clear line on top
    // of each makes it easy to grab.
    for (const { g, scope } of this.allGuides()) {
      const d = guideDir(g);
      const seg = clipLine({ x: sx(g.x), y: sy(g.y) }, { x: d.x, y: -d.y }, W, H);
      if (!seg) continue;
      const [a, b] = seg;
      const picked = this.guideSel?.scope === scope && this.guideSel.id === g.id;
      const cls = `user-guide ${scope}${picked ? " picked" : ""}${g.locked ? " locked" : ""}`;
      const style = g.color ? ` style="--guide:${esc(g.color)}"` : "";
      parts.push(
        `<line class="${cls}"${style} x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`,
        `<line class="guide-hit" data-guide="${scope}:${g.id}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`,
      );
      if (g.name || picked) {
        const label = `${g.name ? esc(g.name) + " " : ""}${isVertical(g) ? fmt(g.x) : isHorizontal(g) ? fmt(g.y) : `${fmt(g.angle)}°`}`;
        const pos = isVertical(g) ? { x: a.x + 4, y: H - 30 } : isHorizontal(g) ? { x: RULER_PX + 6, y: a.y - 5 } : { x: sx(g.x) + 6, y: sy(g.y) - 6 };
        parts.push(`<text class="user-guide-label ${scope}"${style} x="${pos.x}" y="${pos.y}">${label}</text>`);
      }
    }

    // Ends of deformed strokes on a generated fidel.
    (this.drawing.handles ?? []).forEach((h, i) => {
      const g1 = this.gesture;
      const d = g1?.kind === "deform" && g1.i === i ? g1.d : 0;
      const at = h.vertical ? { x: h.at.x, y: h.at.y + d } : { x: h.at.x + d, y: h.at.y };
      const name = this.alterationName(h.alteration);
      const tip = h.vertical
        ? `${name}: drag up or down to set where it ends on this family`
        : `${name}: drag sideways to set how far it goes on this family`;
      parts.push(
        `<circle class="deform-handle${h.vertical ? "" : " sideways"}${d ? " active" : ""}" data-hid="${i}" cx="${sx(at.x)}" cy="${sy(at.y)}" r="6"><title>${esc(tip)}</title></circle>`,
      );
    });

    // Components placed by rule: they follow the strokes they sit on.
    for (const r of this.ruleEnds) {
      const k = `${r.component}@${r.key}`;
      const cls = `rule-end${r.on ? "" : " off"}${this.ruleSel === k ? " selected" : ""}`;
      parts.push(`<path class="${cls}" data-rk="${esc(k)}" transform="${xf}" d="${r.d}"><title>${esc(`${r.name}: ${r.label}`)}</title></path>`);
    }

    // Components placed on a base: drawn once elsewhere, moved here as a whole.
    for (const pc of this.drawing.components ?? []) {
      const id = pc.placement.id;
      const g1 = this.gesture;
      const drag = g1?.kind === "placement" && g1.id === id ? g1.d : this.pendingPlacement?.id === id ? this.pendingPlacement.d : null;
      const move = drag ? ` translate(${drag.x} ${drag.y})` : "";
      const sel = this.placementSel === id ? " selected" : "";
      parts.push(
        `<path class="component${sel}" data-pid="${id}" transform="${xf}${move}" d="${pc.d}"><title>${esc(pc.name)}</title></path>`,
      );
    }

    // Anchors: where accents attach, or where this accent joins.
    for (const [name, a] of Object.entries(prefs.showAnchors ? (this.drawing.anchors ?? {}) : {})) {
      const x = sx(a.x);
      const y = sy(a.y);
      const r = 5;
      const sel = this.anchorSel === name ? " selected" : "";
      const join = name.startsWith("_") ? " join" : "";
      parts.push(
        `<g class="anchor${sel}${join}" data-anchor="${esc(name)}"><circle class="anchor-hit" cx="${x}" cy="${y}" r="10"/><path d="M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z"/><text x="${x + 9}" y="${y - 7}">${esc(name)}</text></g>`,
      );
    }

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

    // Eraser trail in progress.
    if (g?.kind === "eraser") {
      const trail = g.pts.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ");
      parts.push(`<polyline class="eraser-trail" points="${trail}"/>`);
    }

    // Knife line in progress.
    if (g?.kind === "knife") {
      parts.push(`<line class="knife-line" x1="${sx(g.start.x)}" y1="${sy(g.start.y)}" x2="${sx(g.now.x)}" y2="${sy(g.now.y)}"/>`);
    }

    // Measuring line: every crossing with the outline, and the distances between them.
    const ml = g?.kind === "measure" ? { a: g.start, b: g.now } : this.measureLine;
    if (ml && (ml.a.x !== ml.b.x || ml.a.y !== ml.b.y)) {
      const A = this.toScreen(ml.a);
      const B = this.toScreen(ml.b);
      parts.push(`<line class="measure-line" x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}"/>`);
      const hits = crossings(this.visibleContours(), ml.a, ml.b);
      const len = Math.hypot(B.x - A.x, B.y - A.y);
      const nx = -(B.y - A.y) / len;
      const ny = (B.x - A.x) / len;
      const stops = [ml.a, ...hits.map((h) => h.at), ml.b];
      for (let i = 1; i < stops.length; i++) {
        const p = stops[i - 1];
        const q = stops[i];
        const dist = Math.hypot(q.x - p.x, q.y - p.y);
        if (dist * this.view.scale < 14) continue;
        const m = this.toScreen({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
        // Inside the outline (between crossings 1-2, 3-4 …) reads as ink.
        const ink = i >= 2 && i < stops.length - 1 && i % 2 === 0;
        parts.push(`<text class="measure-label${ink ? " ink" : ""}" x="${m.x + nx * 12}" y="${m.y + ny * 12 + 4}" text-anchor="middle">${fmt(dist)}</text>`);
      }
      for (const h of hits) {
        const c = this.toScreen(h.at);
        parts.push(`<circle class="measure-hit" cx="${c.x}" cy="${c.y}" r="3"/>`);
      }
      const total = Math.hypot(ml.b.x - ml.a.x, ml.b.y - ml.a.y);
      const ang = (Math.atan2(ml.b.y - ml.a.y, ml.b.x - ml.a.x) * 180) / Math.PI;
      parts.push(`<text class="measure-total" x="${B.x + 10}" y="${B.y - 10}">${fmt(total)} · ${fmt(ang)}°</text>`);
    }

    // Freehand stroke in progress.
    if (g?.kind === "pencil" && g.pts.length > 1) {
      parts.push(`<polyline class="pen-path" points="${g.pts.map((p) => `${sx(p.x)},${sy(p.y)}`).join(" ")}"/>`);
    }

    // Curvature combs on the selected paths.
    if (prefs.showComb && !this.pen) {
      const curves = this.selectedContours().flatMap((ci) => (this.contours[ci].hidden ? [] : segments(this.contours[ci]).filter((sg) => sg.pts.length === 4)));
      // Scale so the longest tooth is about 60 px, whatever the zoom.
      let maxK = 0;
      const raw = curves.map((sg) => combTeeth(sg.pts, 1));
      for (const teeth of raw) for (const t of teeth) maxK = Math.max(maxK, Math.hypot(t.tip.x - t.at.x, t.tip.y - t.at.y));
      if (maxK > 1e-9) {
        const k = 60 / this.view.scale / maxK;
        for (const sg of curves) {
          const teeth = combTeeth(sg.pts, k);
          const tips = teeth.map((t) => `${sx(t.tip.x)},${sy(t.tip.y)}`).join(" ");
          parts.push(`<g class="comb">${teeth.map((t) => `<line x1="${sx(t.at.x)}" y1="${sy(t.at.y)}" x2="${sx(t.tip.x)}" y2="${sy(t.tip.y)}"/>`).join("")}<polyline points="${tips}"/></g>`);
        }
      }
    }

    // Tunni lines on curves with a selected point: drag the dot to change both handles.
    if (prefs.showTunni && this.tool === "direct" && !this.pen) {
      const byContour = new Map<number, Set<number>>();
      for (const k of this.selection) {
        const [ci, pi] = parseKey(k);
        const p = this.contours[ci]?.points[pi];
        if (!p) continue;
        if (!byContour.has(ci)) byContour.set(ci, new Set());
        byContour.get(ci)!.add(p.id);
      }
      for (const [ci, ids] of byContour) {
        const c = this.contours[ci];
        if (c.hidden || c.locked) continue;
        const nodes = toNodes(c);
        segments(c).forEach((sg, si) => {
          if (sg.pts.length !== 4) return;
          const a = nodes[sg.from];
          const b = nodes[sg.to];
          const touched = [a.id, b.id, a.out?.id, b.in?.id].some((id) => id !== undefined && ids.has(id));
          if (!touched) return;
          const t = tunniPoint(sg.pts);
          if (!t) return;
          const [, h0, h1] = sg.pts;
          parts.push(
            `<line class="tunni-line" x1="${sx(h0.x)}" y1="${sy(h0.y)}" x2="${sx(h1.x)}" y2="${sy(h1.y)}"/>`,
            `<circle class="tunni-pt" data-tunni="${ci}:${si}" cx="${sx(t.x)}" cy="${sy(t.y)}" r="4"><title>Tunni point: drag to change both handles</title></circle>`,
          );
        });
      }
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
        const k = NODE_SCALE[prefs.nodeSize] ?? 1;
        c.points.forEach((p, pi) => {
          const x = sx(p.pos.x);
          const y = sy(p.pos.y);
          const picked = this.selection.has(key(ci, pi));
          const sel = picked ? " selected" : "";
          if (pi === start) parts.push(`<circle class="start-ring" cx="${x}" cy="${y}" r="${8 * k}"/>`);
          const type = pointType(c, pi);
          // Coordinates next to selected points, when asked for.
          if (prefs.showCoords && picked) parts.push(`<text class="pt-coords" x="${x + 8 * k}" y="${y - 8 * k}">${fmt(p.pos.x)}, ${fmt(p.pos.y)}</text>`);
          if (type === "handle") parts.push(`<circle class="pt-off${sel}" cx="${x}" cy="${y}" r="${3.5 * k}"/>`);
          else if (type === "smooth") parts.push(`<circle class="pt-on smooth${sel}" cx="${x}" cy="${y}" r="${4.5 * k}"/>`);
          else if (type === "tangent") {
            // A triangle pointing along the straight side.
            const prev = c.points[(pi - 1 + n) % n];
            const toward = isOn(prev) ? { x: p.pos.x - prev.pos.x, y: p.pos.y - prev.pos.y } : { x: c.points[(pi + 1) % n].pos.x - p.pos.x, y: c.points[(pi + 1) % n].pos.y - p.pos.y };
            const l = Math.hypot(toward.x, toward.y) || 1;
            const d = { x: toward.x / l, y: -toward.y / l };
            const q = { x: -d.y, y: d.x };
            const pt = (a: number, b: number) => `${x + (d.x * a + q.x * b) * k},${y + (d.y * a + q.y * b) * k}`;
            parts.push(`<polygon class="pt-on tangent${sel}" points="${pt(6, 0)} ${pt(-4, 5)} ${pt(-4, -5)}"/>`);
          } else parts.push(`<rect class="pt-on corner${sel}" x="${x - 4 * k}" y="${y - 4 * k}" width="${8 * k}" height="${8 * k}" rx="1.5"/>`);
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

    // Dragging one handle: its length and angle.
    if (g?.kind === "move" && g.moved && this.tool === "direct" && this.selection.size === 1) {
      const [ci, pi] = parseKey([...this.selection][0]);
      const c = this.contours[ci];
      const p = c?.points[pi];
      if (p && !isOn(p)) {
        const n = c.points.length;
        const prev = c.points[(pi - 1 + n) % n];
        const anchor = isOn(prev) ? prev : c.points[(pi + 1) % n];
        const dx = p.pos.x - anchor.pos.x;
        const dy = p.pos.y - anchor.pos.y;
        const at = this.toScreen(p.pos);
        parts.push(`<text class="size-label" x="${at.x + 12}" y="${at.y - 12}">${fmt(Math.hypot(dx, dy))} · ${fmt((Math.atan2(dy, dx) * 180) / Math.PI)}°</text>`);
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

    // Rulers along the top and left edges, in font units; drag out of one for a guide.
    if (prefs.showRulers) {
      const R = RULER_PX;
      const tx0 = (R - tx) / scale;
      const tx1 = (W - tx) / scale;
      const ty0 = (ty - H) / scale;
      const ty1 = (ty - R) / scale;
      const tt = rulerTicks(tx0, tx1, scale);
      const lt = rulerTicks(ty0, ty1, scale);
      let d = "";
      let labels = "";
      for (const v of tt.major) {
        d += `M${sx(v)} 0V${R}`;
        labels += `<text class="ruler-label" x="${sx(v) + 3}" y="9">${fmt(v)}</text>`;
      }
      for (const v of tt.minor) d += `M${sx(v)} ${R - 5}V${R}`;
      for (const v of lt.major) {
        d += `M0 ${sy(v)}H${R}`;
        labels += `<text class="ruler-label" transform="translate(9 ${sy(v) - 3}) rotate(-90)">${fmt(v)}</text>`;
      }
      for (const v of lt.minor) d += `M${R - 5} ${sy(v)}H${R}`;
      parts.push(
        `<g class="rulers">`,
        `<rect class="ruler" data-ruler="top" x="0" y="0" width="${W}" height="${R}"><title>Drag down for a guide. Alt makes it global.</title></rect>`,
        `<rect class="ruler" data-ruler="left" x="0" y="0" width="${R}" height="${H}"><title>Drag right for a guide. Alt makes it global.</title></rect>`,
        `<path class="ruler-ticks" d="${d}"/>${labels}`,
        `<rect class="ruler-corner" x="0" y="0" width="${R}" height="${R}"/>`,
        `</g>`,
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

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function unesc(s: string): string {
  return s.replace(/&(amp|lt|gt|quot);/g, (_, n: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"' })[n]!);
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

export { PARTS };

/** The left and right ink edges of an SVG path of absolute pairs (M, L, C, Q), from its points. */
export function pathXRange(d: string): [number, number] | null {
  const nums = d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi);
  if (!nums || nums.length < 2) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < nums.length; i += 2) {
    const x = Number(nums[i]);
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  return [lo, hi];
}
