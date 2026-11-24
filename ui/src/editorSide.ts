// Editor panels that sit around the canvas: the transform, metrics, shape
// and outline-check sections of the inspector, the history list, the
// right-click menu and the view (snapping and display) menu.

import { el } from "./dom";
import type { StrokeJoin } from "./api";
import { SHAPE_LABEL, SHAPES, type GlyphEditor, type ShapeKind } from "./editor";
import { evalNumber, ISSUE_LABEL, rotateAbout, scaleAbout, skewAbout, type IssueKind } from "./pathops";
import { prefs, setPref, type CanvasPrefs } from "./prefs";

/** A number field that also takes simple arithmetic (120/6, 500+20). */
export function numberField(label: string, value: number, onChange: (v: number) => void, title?: string): HTMLElement {
  const shown = Math.round(value * 100) / 100;
  const input = el("input", { type: "text", inputmode: "decimal", value: String(shown), spellcheck: "false" }) as HTMLInputElement;
  const commit = () => {
    const v = evalNumber(input.value);
    if (v === null) input.value = String(shown);
    else if (v !== shown) onChange(v);
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") {
      input.value = String(shown);
      input.blur();
    }
    // Arrow keys step the value, like Figma's fields.
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const v = (evalNumber(input.value) ?? shown) + (e.key === "ArrowUp" ? step : -step);
      input.value = String(v);
      onChange(v);
    }
  });
  return el("label", { class: "field", ...(title ? { title } : {}) }, el("span", {}, label), input);
}

const icon = (d: string, size = 14) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = d;
  return svg;
};

const ICONS = {
  alignLeft: '<path d="M2.5 2v12" stroke="currentColor" stroke-width="1.3"/><rect x="4.5" y="4" width="8" height="3" rx=".6" fill="currentColor"/><rect x="4.5" y="9" width="5" height="3" rx=".6" fill="currentColor"/>',
  alignHCenter: '<path d="M8 2v12" stroke="currentColor" stroke-width="1.3"/><rect x="3" y="4" width="10" height="3" rx=".6" fill="currentColor"/><rect x="5" y="9" width="6" height="3" rx=".6" fill="currentColor"/>',
  alignRight: '<path d="M13.5 2v12" stroke="currentColor" stroke-width="1.3"/><rect x="3.5" y="4" width="8" height="3" rx=".6" fill="currentColor"/><rect x="6.5" y="9" width="5" height="3" rx=".6" fill="currentColor"/>',
  alignTop: '<path d="M2 2.5h12" stroke="currentColor" stroke-width="1.3"/><rect x="4" y="4.5" width="3" height="8" rx=".6" fill="currentColor"/><rect x="9" y="4.5" width="3" height="5" rx=".6" fill="currentColor"/>',
  alignVCenter: '<path d="M2 8h12" stroke="currentColor" stroke-width="1.3"/><rect x="4" y="3" width="3" height="10" rx=".6" fill="currentColor"/><rect x="9" y="5" width="3" height="6" rx=".6" fill="currentColor"/>',
  alignBottom: '<path d="M2 13.5h12" stroke="currentColor" stroke-width="1.3"/><rect x="4" y="3.5" width="3" height="8" rx=".6" fill="currentColor"/><rect x="9" y="6.5" width="3" height="5" rx=".6" fill="currentColor"/>',
  distH: '<path d="M2 2v12M14 2v12" stroke="currentColor" stroke-width="1.3"/><rect x="6.5" y="4" width="3" height="8" rx=".6" fill="currentColor"/>',
  distV: '<path d="M2 2h12M2 14h12" stroke="currentColor" stroke-width="1.3"/><rect x="4" y="6.5" width="8" height="3" rx=".6" fill="currentColor"/>',
  flipH: '<path d="M8 1.5v13" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.5"/><path d="M6 4L2 12h4z" fill="currentColor"/><path d="M10 4l4 8h-4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
  flipV: '<path d="M1.5 8h13" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.5"/><path d="M4 6l8-4v4z" fill="currentColor"/><path d="M4 10l8 4v-4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
  rotL: '<path d="M4.5 5.5A5 5 0 1 1 3.2 9.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/><path d="M2.5 2.8v3.4h3.4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  rotR: '<path d="M11.5 5.5A5 5 0 1 0 12.8 9.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/><path d="M13.5 2.8v3.4h-3.4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  repeat: '<path d="M3 6.5A5 5 0 0 1 12.5 5M13 9.5A5 5 0 0 1 3.5 11" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/><path d="M12.8 2.5V5.3H10M3.2 13.5v-2.8H6" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  eye: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="8" cy="8" r="2" fill="currentColor"/>',
  eyeOff: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" stroke="currentColor" stroke-width="1.3" fill="none" opacity=".45"/><path d="M2.5 13.5l11-11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.2" fill="currentColor"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" stroke-width="1.3" fill="none"/>',
  unlock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>',
};

export function iconButton(name: keyof typeof ICONS, title: string, onClick: () => void, cls = "icon-btn"): HTMLButtonElement {
  const b = el("button", { class: cls, title, "aria-label": title }) as HTMLButtonElement;
  b.append(icon(ICONS[name]));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

export const LAYER_ICONS = { eye: ICONS.eye, eyeOff: ICONS.eyeOff, lock: ICONS.lock, unlock: ICONS.unlock, icon };

/** Position, size, rotate, flip, skew, align and distribute for the selection. */
export function transformSection(ed: GlyphEditor): Node[] {
  const box = ed.transformBox();
  if (!box) return [];
  const a = ed.anchorOf(box);
  // The anchor picker: nine dots, like FontLab's and Glyphs' origin choice.
  const picker = el("div", { class: "anchor-picker", role: "radiogroup", "aria-label": "Transform origin" });
  for (const y of [1, 0.5, 0] as const) {
    for (const x of [0, 0.5, 1] as const) {
      const on = ed.anchor.x === x && ed.anchor.y === y;
      const names = { 0: "left", 0.5: "centre", 1: "right" } as const;
      const vnames = { 0: "bottom", 0.5: "middle", 1: "top" } as const;
      const dot = el("button", {
        class: `anchor-dot${on ? " on" : ""}`,
        role: "radio",
        "aria-checked": String(on),
        title: x === 0.5 && y === 0.5 ? "Origin: centre" : `Origin: ${vnames[y]} ${names[x]}`.replace("middle centre", "centre"),
      });
      dot.addEventListener("click", () => {
        ed.anchor = { x, y };
        ed.render();
        refresh(ed);
      });
      picker.append(dot);
    }
  }
  const pos = el(
    "div",
    { class: "field-grid" },
    numberField("X", a.x, (v) => ed.setSelectionBox({ x: v })),
    numberField("Y", a.y, (v) => ed.setSelectionBox({ y: v })),
    numberField("W", box.maxX - box.minX, (v) => ed.setSelectionBox({ w: v })),
    numberField("H", box.maxY - box.minY, (v) => ed.setSelectionBox({ h: v })),
  );

  let angle = 90;
  let scale = 100;
  let skew = 12;
  const rot = numberField("Rotate °", angle, (v) => (angle = v), "Angle for the rotate buttons");
  const sc = numberField("Scale %", scale, (v) => (scale = v), "Scale both directions from the origin");
  const sk = numberField("Slant °", skew, (v) => (skew = v), "Slant (skew) from the origin, top to the right");
  const at = (b: typeof box) => ed.anchorOf(b);
  const actions = el(
    "div",
    { class: "icon-row" },
    iconButton("rotL", "Rotate counter-clockwise", () => ed.applyTransform((b) => rotateAbout(at(b), angle), `Rotate ${angle}°`)),
    iconButton("rotR", "Rotate clockwise", () => ed.applyTransform((b) => rotateAbout(at(b), -angle), `Rotate −${angle}°`)),
    iconButton("flipH", "Flip horizontal", () => ed.applyTransform((b) => scaleAbout(at(b), -1, 1), "Flip horizontal")),
    iconButton("flipV", "Flip vertical", () => ed.applyTransform((b) => scaleAbout(at(b), 1, -1), "Flip vertical")),
    iconButton("repeat", ed.lastTransform ? `Repeat: ${ed.lastTransform.label}` : "Repeat the last transform", () => ed.repeatTransform()),
  );
  const apply = el("div", { class: "button-row" });
  const scaleBtn = el("button", { class: "pill small" }, "Scale");
  scaleBtn.addEventListener("click", () => ed.applyTransform((b) => scaleAbout(at(b), scale / 100, scale / 100), `Scale ${scale}%`));
  const skewBtn = el("button", { class: "pill small" }, "Slant");
  skewBtn.addEventListener("click", () => ed.applyTransform((b) => skewAbout(at(b), skew), `Slant ${skew}°`));
  apply.append(scaleBtn, skewBtn);

  const align = el(
    "div",
    { class: "icon-row" },
    iconButton("alignLeft", "Align left", () => ed.align("left")),
    iconButton("alignHCenter", "Align horizontal centres", () => ed.align("hcenter")),
    iconButton("alignRight", "Align right", () => ed.align("right")),
    iconButton("alignTop", "Align top", () => ed.align("top")),
    iconButton("alignVCenter", "Align vertical centres", () => ed.align("vcenter")),
    iconButton("alignBottom", "Align bottom", () => ed.align("bottom")),
    iconButton("distH", "Distribute horizontally", () => ed.distribute("x")),
    iconButton("distV", "Distribute vertically", () => ed.distribute("y")),
  );
  return [
    el("h3", { class: "section-label" }, "Transform"),
    el("div", { class: "transform-head" }, picker, pos),
    actions,
    el("div", { class: "field-grid three" }, rot, sc, sk),
    apply,
    el("h3", { class: "section-label" }, "Align"),
    align,
  ];
}

/** Left and right sidebearings and width, for drawings with an advance. */
export function metricsSection(ed: GlyphEditor, paLabel: string): Node[] {
  const sb = ed.sidebearings();
  if (!sb) return [];
  const center = el("button", { class: "pill small ghost", title: "Same space left and right" }, "Center");
  center.addEventListener("click", () => ed.centerInWidth());
  return [
    el("h3", { class: "section-label", title: "Drag the left or right metric line on the canvas, too" }, "Metrics"),
    el(
      "div",
      { class: "field-grid three" },
      numberField("LSB", sb.lsb, (v) => ed.setSidebearing("left", v), "Left sidebearing"),
      numberField("Width", sb.width, (v) => void ed.setAdvance(v), "Advance width"),
      numberField("RSB", sb.rsb, (v) => ed.setSidebearing("right", v), "Right sidebearing"),
    ),
    el("div", { class: "button-row" }, center, el("span", { class: "side-note inline" }, `Pa-height ${paLabel}`)),
  ];
}

/** Options for the shape tool in use. */
export function shapeSection(ed: GlyphEditor): Node[] {
  const t = ed.tool;
  if (!(SHAPES as string[]).includes(t)) return [];
  const shape = t as ShapeKind;
  const fields: HTMLElement[] = [];
  if (shape === "rounded") fields.push(numberField("Radius", prefs.cornerRadius, (v) => setPref("cornerRadius", Math.max(0, v))));
  if (shape === "polygon") fields.push(numberField("Sides", prefs.polygonSides, (v) => setPref("polygonSides", Math.max(3, Math.round(v)))));
  if (shape === "star") {
    fields.push(
      numberField("Points", prefs.starPoints, (v) => setPref("starPoints", Math.max(3, Math.round(v)))),
      numberField("Inner %", Math.round(prefs.starInner * 100), (v) => setPref("starInner", Math.min(0.95, Math.max(0.05, v / 100)))),
    );
  }
  return [
    el("h3", { class: "section-label", title: "Shift keeps proportions, Alt draws from the centre" }, SHAPE_LABEL[shape]),
    ...(fields.length ? [el("div", { class: "field-row" }, ...fields)] : [el("p", { class: "side-note" }, "Drag on the canvas.")]),
  ];
}

/** The outline check: problems found in the drawing, and a safe fix. */
export function issuesSection(ed: GlyphEditor): Node[] {
  const issues = ed.issues();
  if (!issues.length) return [];
  const counts = new Map<IssueKind, number>();
  for (const i of issues) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
  const list = el("ul", { class: "issue-list" });
  for (const [kind, n] of counts) {
    const li = el("li", {}, el("span", { class: "issue-dot", "aria-hidden": "true" }), ISSUE_LABEL[kind], ...(n > 1 ? [el("span", { class: "issue-count" }, String(n))] : []));
    li.addEventListener("click", () => {
      const first = issues.find((i) => i.kind === kind)!;
      ed.selectLayer(first.contour, false);
    });
    list.append(li);
  }
  const fix = el("button", { class: "pill small", title: "Fixes direction, duplicate points, near-straight lines, kinks and missing extremes" }, "Fix");
  fix.disabled = !issues.some((i) => i.fixable);
  if (ed.drawing?.generated) {
    // A generated fidel takes its outline from the base: fix it there.
    fix.disabled = true;
    fix.title = "Generated from the base: fix the outline on the base";
  }
  fix.addEventListener("click", () => ed.fixOutline());
  return [el("h3", { class: "section-label" }, "Outline check"), list, el("div", { class: "button-row" }, fix)];
}

/** The history of the open drawing, newest at the bottom; click a step to go back to it. */
export function historyRows(ed: GlyphEditor): HTMLElement[] {
  const { labels, applied } = ed.steps;
  if (!labels.length) return [];
  const rows: HTMLElement[] = [el("div", { class: "tree-section" }, "History")];
  const opened = el("div", { class: `history-row${applied === 0 ? " current" : ""}`, role: "button", tabindex: "0" }, "Opened");
  opened.addEventListener("click", () => ed.jumpTo(0));
  rows.push(opened);
  // Only the last steps; older ones stay undoable with Ctrl+Z.
  const from = Math.max(0, labels.length - 40);
  labels.slice(from).forEach((label, i) => {
    const n = from + i + 1;
    const row = el("div", { class: `history-row${n === applied ? " current" : ""}${n > applied ? " undone" : ""}`, role: "button", tabindex: "0" }, label);
    row.addEventListener("click", () => ed.jumpTo(n));
    rows.push(row);
  });
  return rows;
}

// ---------- Menus ----------

export type MenuEntry =
  | { label: string; keys?: string; run: () => void; disabled?: boolean; checked?: boolean }
  | "sep"
  | { heading: string };

let openMenu: HTMLElement | null = null;

function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

document.addEventListener("pointerdown", (e) => {
  if (openMenu && !openMenu.contains(e.target as globalThis.Node)) closeMenu();
});
window.addEventListener("keydown", (e) => {
  if (openMenu && e.key === "Escape") closeMenu();
});
window.addEventListener("blur", closeMenu);

export function showMenu(entries: MenuEntry[], at: { x: number; y: number }) {
  closeMenu();
  const menu = el("div", { class: "menu context-menu", role: "menu" });
  for (const e of entries) {
    if (e === "sep") {
      menu.append(el("div", { class: "menu-sep", role: "separator" }));
      continue;
    }
    if ("heading" in e) {
      menu.append(el("div", { class: "menu-label" }, e.heading));
      continue;
    }
    const b = el("button", {
      class: `menu-item${e.checked !== undefined ? " radio" : ""}`,
      role: e.checked !== undefined ? "menuitemradio" : "menuitem",
      ...(e.checked !== undefined ? { "aria-checked": String(e.checked) } : {}),
    }) as HTMLButtonElement;
    b.append(e.label);
    if (e.keys) b.append(el("kbd", {}, e.keys));
    b.disabled = !!e.disabled;
    b.addEventListener("click", () => {
      closeMenu();
      e.run();
    });
    menu.append(b);
  }
  document.body.append(menu);
  // Keep it on screen.
  const r = menu.getBoundingClientRect();
  const x = Math.min(at.x, window.innerWidth - r.width - 8);
  const y = Math.min(at.y, window.innerHeight - r.height - 8);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
  openMenu = menu;
}

/** Right-click on the canvas: what can be done to the selection. */
export function showContextMenu(ed: GlyphEditor, at: { x: number; y: number }) {
  const entries: MenuEntry[] = [];
  const sel = ed.selection.size;
  const contours = ed.selectedContours();
  const nodes = ed.selectedNodes();
  if (ed.tool === "direct" && nodes.length) {
    const types = new Set(nodes.map((n) => n.type));
    const only = types.size === 1 ? [...types][0] : null;
    entries.push(
      { heading: nodes.length === 1 ? "Point" : `${nodes.length} points` },
      { label: "Corner", checked: only === "corner", run: () => ed.setNodeType("corner") },
      { label: "Smooth", checked: only === "smooth", run: () => ed.setNodeType("smooth") },
      { label: "Tangent", checked: only === "tangent", run: () => ed.setNodeType("tangent") },
      { label: "Cycle point type", keys: "Shift C", run: () => ed.cycleNodeType() },
      { label: "Retract handles", run: () => ed.setNodeType("retract"), disabled: !nodes.some((n) => n.handles) },
    );
    const segs = ed.selectedSegments();
    if (segs.lines) entries.push({ label: segs.lines > 1 ? "Make curves" : "Make curve", run: () => ed.setSegmentKind("curve") });
    if (segs.curves) entries.push({ label: segs.curves > 1 ? "Make lines" : "Make line", run: () => ed.setSegmentKind("line") });
    if (nodes.length === 1) entries.push({ label: "Set as start point", run: () => ed.setStartPoint() });
    entries.push(
      { label: "Break path here", run: () => ed.breakAtSelection() },
      ...(ed.canJoin ? [{ label: "Join ends", keys: "Shift J", run: () => void ed.joinSelection() }] : []),
      { label: "Harmonize", run: () => ed.harmonize(), disabled: !nodes.some((n) => n.type === "smooth") },
      { label: "Balance handles", run: () => ed.balanceHandles(), disabled: !segs.curves },
      { label: "Automatic handles", run: () => ed.autoHandles() },
    );
    entries.push("sep", { heading: "Select" });
    entries.push(
      { label: "Select path", run: () => { for (const ci of contours) ed.selectContour(ci); ed.render(); refresh(ed); } },
      { label: "Select similar points", run: () => ed.selectSimilar() },
      ...(nodes.length === 1
        ? [
            { label: "Points on this horizontal", run: () => ed.selectOnLine("y") },
            { label: "Points on this vertical", run: () => ed.selectOnLine("x") },
          ]
        : []),
    );
  }
  if (sel) {
    entries.push(
      { label: "Invert selection", keys: "Ctrl Shift I", run: () => ed.invertSelection() },
      "sep",
      { heading: contours.length === 1 ? "Path" : `${contours.length} paths` },
      ...(ed.hasOpenSelection ? [{ label: "Close path", run: () => ed.closePaths() }] : []),
      { label: "Reverse direction", keys: "Ctrl Shift R", run: () => ed.reverseDirection() },
      { label: "Correct path direction", run: () => ed.correctDirection() },
      { label: "Add extremes", run: () => ed.addExtremes() },
      { label: "Tidy up", run: () => ed.tidyUp() },
      { label: "Remove overlap", keys: "Ctrl Shift O", run: () => void ed.removeOverlap() },
      ...(contours.length > 1
        ? [
            { label: "Union", run: () => void ed.booleanOp("union") },
            { label: "Subtract front", run: () => void ed.booleanOp("subtract") },
            { label: "Intersect", run: () => void ed.booleanOp("intersect") },
            { label: "Exclude", run: () => void ed.booleanOp("exclude") },
          ]
        : []),
      { label: "Duplicate", keys: "Ctrl D", run: () => ed.duplicate() },
      { label: "Lock", keys: "Ctrl Shift L", run: () => ed.setLayerFlag("locked", contours, true) },
      { label: "Hide", keys: "Ctrl Shift H", run: () => ed.setLayerFlag("hidden", contours, true) },
      { label: "Delete", keys: "Del", run: () => ed.deleteSelection() },
    );
  } else {
    entries.push(
      { heading: "Drawing" },
      { label: "Select all", keys: "Ctrl A", run: () => ed.selectAll() },
      { label: "Correct path direction", run: () => ed.correctDirection() },
      { label: "Add extremes", run: () => ed.addExtremes() },
      { label: "Tidy up", run: () => ed.tidyUp() },
      { label: "Remove overlap", keys: "Ctrl Shift O", run: () => void ed.removeOverlap() },
      { label: "Round coordinates", run: () => ed.roundCoordinates() },
    );
  }
  const anyLocked = ed.contours.some((c) => c.locked);
  const anyHidden = ed.contours.some((c) => c.hidden);
  if (anyLocked || anyHidden) {
    entries.push("sep");
    if (anyLocked) entries.push({ label: "Unlock all", run: () => ed.clearLayerFlag("locked") });
    if (anyHidden) entries.push({ label: "Show all", run: () => ed.clearLayerFlag("hidden") });
  }
  entries.push("sep", { label: "Paste", keys: "Ctrl V", run: () => ed.pastePaths(), disabled: false });
  showMenu(entries, at);
}

/** The canvas view menu: snapping, grid, nudge steps and what is shown. */
export function bindViewMenu(root: HTMLElement) {
  const btn = root.querySelector<HTMLButtonElement>(".view-btn");
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (openMenu?.classList.contains("view-menu")) return closeMenu();
    const r = btn.getBoundingClientRect();
    renderViewMenu({ x: r.right, y: r.bottom });
  });
}

function renderViewMenu(anchor: { x: number; y: number }) {
  closeMenu();
  const menu = el("div", { class: "menu context-menu view-menu", role: "menu" });
  const check = (label: string, k: keyof CanvasPrefs) => {
    const on = prefs[k] as boolean;
    const b = el(
      "button",
      { class: "menu-item check", role: "menuitemcheckbox", "aria-checked": String(on) },
      el("span", { class: "check-box", "aria-hidden": "true" }),
      el("span", {}, label),
      el("span", {}),
    );
    b.addEventListener("click", () => {
      setPref(k, !on as never);
      b.setAttribute("aria-checked", String(!on));
      renderViewMenu(anchor);
    });
    return b;
  };
  const num = (label: string, value: number, set: (v: number) => void) => {
    const input = el("input", { type: "text", inputmode: "decimal", value: String(value), "aria-label": label }) as HTMLInputElement;
    input.addEventListener("change", () => {
      const v = evalNumber(input.value);
      if (v !== null && v > 0) set(v);
      else input.value = String(value);
    });
    input.addEventListener("keydown", (e) => e.stopPropagation());
    return el("label", { class: "menu-field" }, el("span", {}, label), input);
  };
  menu.append(
    el("div", { class: "menu-label" }, "Snapping"),
    check("Snap to points", "snapPoints"),
    check("Snap to metrics", "snapMetrics"),
    check("Snap to Pa-height zones", "snapZones"),
    check("Snap to grid", "snapGrid"),
    el("div", { class: "menu-sep", role: "separator" }),
    el("div", { class: "menu-label" }, "Grid"),
    check("Show grid", "showGrid"),
    el(
      "div",
      { class: "menu-fields" },
      num("Spacing", prefs.gridSize, (v) => setPref("gridSize", Math.round(v))),
      num("Subdivisions", prefs.gridSub, (v) => setPref("gridSub", Math.max(1, Math.round(v)))),
    ),
    el("div", { class: "menu-label" }, "Arrow key steps"),
    el(
      "div",
      { class: "menu-fields three" },
      num("Arrow", prefs.nudge[0], (v) => setPref("nudge", [v, prefs.nudge[1], prefs.nudge[2]])),
      num("Shift", prefs.nudge[1], (v) => setPref("nudge", [prefs.nudge[0], v, prefs.nudge[2]])),
      num("Ctrl", prefs.nudge[2], (v) => setPref("nudge", [prefs.nudge[0], prefs.nudge[1], v])),
    ),
    el("div", { class: "menu-sep", role: "separator" }),
    el("div", { class: "menu-label" }, "Show"),
    check("Filled outline", "fill"),
    check("Path direction", "showArrows"),
    check("Part labels", "showPartLabels"),
    check("Pa-height zones", "showZones"),
    check("Outline warnings", "showWarnings"),
    check("Tunni lines", "showTunni"),
    check("Curvature comb", "showComb"),
  );
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, anchor.x - r.width)}px`;
  menu.style.top = `${Math.min(anchor.y + 6, window.innerHeight - r.height - 8)}px`;
  openMenu = menu;
}

let refreshSide: (ed: GlyphEditor) => void = () => {};

/** Set how the panels ask the inspector to redraw. */
export function onRefresh(fn: (ed: GlyphEditor) => void) {
  refreshSide = fn;
}

function refresh(ed: GlyphEditor) {
  refreshSide(ed);
}

/** Values the path operation fields remember between uses. */
const opValues = { offset: 10, stroke: 40, radius: 20, join: "miter" as StrokeJoin };

/**
 * Remove overlap, booleans, offset, expand stroke and corners for the
 * selection (or the whole drawing when nothing is selected).
 */
export function pathOpsSection(ed: GlyphEditor): Node[] {
  if (!ed.contours.length) return [];
  const closed = ed.selectedContours().filter((ci) => !ed.contours[ci].open).length;
  const btn = (label: string, title: string, run: () => void, disabled = false) => {
    const b = el("button", { class: "pill small ghost", title }, label);
    b.disabled = disabled;
    b.addEventListener("click", run);
    return b;
  };
  const bools = el(
    "div",
    { class: "button-row" },
    btn("Remove overlap", "Merge overlapping paths into one outline (Ctrl Shift O)", () => void ed.removeOverlap()),
    btn("Tidy up", "Merge doubled points, straighten flat curves and drop points in the middle of straight lines", () => ed.tidyUp()),
    btn("Union", "Merge the selected paths", () => void ed.booleanOp("union"), closed < 2),
    btn("Subtract", "Cut the frontmost selected path out of the others", () => void ed.booleanOp("subtract"), closed < 2),
    btn("Intersect", "Keep only where the selected paths overlap", () => void ed.booleanOp("intersect"), closed < 2),
    btn("Exclude", "Keep where the selected paths do not overlap", () => void ed.booleanOp("exclude"), closed < 2),
  );
  const join = el("select", { class: "built-on-select", "aria-label": "Corners" }) as HTMLSelectElement;
  for (const j of ["miter", "round", "bevel"] as StrokeJoin[]) {
    const o = el("option", { value: j }, { miter: "Sharp corners", round: "Round corners", bevel: "Cut corners" }[j]);
    if (opValues.join === j) o.selected = true;
    join.append(o);
  }
  join.addEventListener("change", () => (opValues.join = join.value as StrokeJoin));
  const offset = el(
    "div",
    { class: "field-row" },
    numberField("Offset", opValues.offset, (v) => (opValues.offset = v), "Positive grows the paths, negative shrinks them"),
    btn("Offset", "Grow or shrink the selected paths", () => void ed.offsetPaths(opValues.offset, opValues.join)),
  );
  const stroke = el(
    "div",
    { class: "field-row" },
    numberField("Width", opValues.stroke, (v) => (opValues.stroke = Math.abs(v)), "Width of the outline drawn around each path"),
    btn("Expand stroke", "Turn the selected paths into outlines of this width", () => void ed.expandStroke(opValues.stroke, opValues.join)),
  );
  const corners = ed.selectedNodes().some((n) => n.type === "corner");
  const round = el(
    "div",
    { class: "field-row" },
    numberField("Radius", opValues.radius, (v) => (opValues.radius = Math.abs(v)), "How far back along each side the corner starts"),
    btn("Round", "Round the selected corner points", () => ed.roundCorners(opValues.radius, "round"), !corners),
    btn("Chamfer", "Cut the selected corner points straight across", () => ed.roundCorners(opValues.radius, "chamfer"), !corners),
  );
  return [
    el("h3", { class: "section-label", title: "Works on the selected paths, or the whole drawing when nothing is selected" }, "Path operations"),
    el("div", { class: "side-box" }, bools, offset, stroke, join, ...(ed.tool === "direct" ? [round] : [])),
  ];
}
