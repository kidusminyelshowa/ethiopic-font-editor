import "@fontsource-variable/fraunces/opsz.css";
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/noto-serif-ethiopic/index.css";
import "./style.css";

import {
  api,
  PARTS,
  type AlterationSummary,
  type DrawingTarget,
  type FidelDetail,
  type FidelGrid,
  type FidelPreview,
  type ProjectInfo,
  type StateKind,
} from "./api";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { el, glyphView, hex } from "./dom";
import { GlyphEditor, PART_COLORS } from "./editor";
import { isOn } from "./geometry";

const STATES: StateKind[] = ["linked", "adjusted", "irregular", "detached"];

const STATE_LABEL: Record<StateKind, string> = {
  linked: "Linked",
  adjusted: "Adjusted",
  irregular: "Irregular",
  detached: "Detached",
};

const STATE_HELP: Record<StateKind, string> = {
  linked: "Generated from the base and the order rule. Updates automatically.",
  adjusted: "Generated, with local nudges that survive upstream changes.",
  irregular: "The order rule does not apply. Uses its own recipe.",
  detached: "Redrawn by hand. No longer receives updates.",
};

const GROUP_LABEL: Record<string, string> = {
  "open-counter": "Open counter",
  "closed-counter": "Closed counter",
  "stem-based": "Stem based",
  "diagonal-based": "Diagonal based",
};

const ui = {
  status: document.getElementById("core-status")!,
  summary: document.getElementById("grid-summary")!,
  filters: document.getElementById("filters")!,
  grid: document.getElementById("grid")!,
  inspector: document.getElementById("inspector")!,
  gridView: document.getElementById("grid-view")!,
  editorView: document.getElementById("editor-view")!,
  drawingSelect: document.getElementById("drawing-select") as HTMLSelectElement,
  toasts: document.getElementById("toasts")!,
  projectName: document.getElementById("project-name")!,
  projectMeta: document.getElementById("project-meta")!,
};

type ViewName = "grid" | "editor";

const state = {
  view: "grid" as ViewName,
  grid: null as FidelGrid | null,
  alterations: [] as AlterationSummary[],
  filter: "all" as StateKind | "all",
  selected: null as { family: string; order: string } | null,
  /** Family whose base is drawn behind an alteration in the editor. */
  contextFamily: undefined as string | undefined,
};

// ---------- Toasts ----------

function toast(message: string, tone: "error" | "info" = "info") {
  const t = el("div", { class: `toast toast-${tone}`, role: tone === "error" ? "alert" : "status" }, message);
  ui.toasts.append(t);
  setTimeout(() => t.classList.add("leaving"), 3600);
  setTimeout(() => t.remove(), 4000);
}

// ---------- Views ----------

function showView(view: ViewName) {
  state.view = view;
  ui.gridView.hidden = view !== "grid";
  ui.editorView.hidden = view !== "editor";
  document.querySelectorAll<HTMLElement>(".tab[data-view]").forEach((t) => {
    const on = t.dataset.view === view;
    t.classList.toggle("active", on);
    if (on) t.setAttribute("aria-current", "page");
    else t.removeAttribute("aria-current");
  });
  if (view === "grid") {
    void refreshGrid().then(() => {
      if (state.selected) void select(state.selected.family, state.selected.order);
      else renderEmptyInspector();
    });
  } else {
    if (!editor.drawing) void openDrawing({ kind: "base", id: state.grid?.rows[0]?.family ?? "ha" });
    else {
      editor.render();
      renderEditorSide(editor);
    }
  }
}

document.querySelectorAll<HTMLElement>(".tab[data-view]").forEach((t) =>
  t.addEventListener("click", () => showView(t.dataset.view as ViewName)),
);

// ---------- Grid ----------

async function refreshGrid() {
  state.grid = await api.fidelGrid();
  ui.summary.textContent = `${state.grid.rows.length} families · ${state.grid.orders.length} orders · Ge'ez`;
  renderFilters(state.grid);
  renderGrid(state.grid);
}

function renderFilters(grid: FidelGrid) {
  const counts: Record<string, number> = { all: 0 };
  for (const row of grid.rows) {
    for (const cell of row.cells) {
      counts.all++;
      counts[cell.state] = (counts[cell.state] ?? 0) + 1;
    }
  }
  const options: (StateKind | "all")[] = ["all", ...STATES];
  ui.filters.replaceChildren(
    ...options.map((k) => {
      const label = k === "all" ? "All" : STATE_LABEL[k];
      const btn = el(
        "button",
        { class: `filter${state.filter === k ? " active" : ""}`, "aria-pressed": String(state.filter === k) },
        el("span", { class: `swatch swatch-${k}`, "aria-hidden": "true" }),
        label,
        el("span", { class: "count" }, String(counts[k] ?? 0)),
      );
      btn.addEventListener("click", () => {
        state.filter = k;
        ui.grid.dataset.filter = k;
        renderFilters(grid);
      });
      return btn;
    }),
  );
  ui.grid.dataset.filter = state.filter;
}

function renderGrid(grid: FidelGrid) {
  const table = el("table", { class: "fidel-grid" });
  const head = table.createTHead().insertRow();
  head.append(el("th", { scope: "col", class: "corner" }, "Family"));
  for (const o of grid.orders) {
    head.append(
      el(
        "th",
        { scope: "col" },
        el("span", { class: "order-pill" }, el("span", { class: "order-num" }, String(o.number)), o.name),
      ),
    );
  }

  const body = table.createTBody();
  for (const row of grid.rows) {
    const tr = body.insertRow();
    const base = row.cells[0]?.codepoint ?? "";
    tr.append(
      el(
        "th",
        { scope: "row" },
        el(
          "span",
          { class: "family" },
          el("span", { class: "family-glyph", lang: "gez" }, base),
          el("span", { class: "family-name" }, row.name),
        ),
      ),
    );
    for (const cell of row.cells) {
      const td = tr.insertCell();
      const btn = el(
        "button",
        {
          class: `cell state-${cell.state}${cell.outline ? " drawn" : ""}`,
          "data-family": row.family,
          "data-order": cell.order,
          "data-state": cell.state,
          "aria-label": `${cell.codepoint ?? ""}, ${row.name}, ${cell.order}, ${STATE_LABEL[cell.state]}`,
          title: `${cell.note ? `${STATE_LABEL[cell.state]}: ${cell.note}` : STATE_LABEL[cell.state]}. Double-click to edit.`,
        },
        glyphView(cell.outline, grid.metrics, cell.codepoint),
        el("span", { class: `badge badge-${cell.badge}`, "aria-hidden": "true" }),
      );
      btn.addEventListener("click", () => void select(row.family, cell.order));
      btn.addEventListener("dblclick", () => void editFromCell(row.family, cell.order));
      td.append(btn);
    }
  }
  ui.grid.replaceChildren(table);
  markSelected();
}

function markSelected() {
  for (const node of ui.grid.querySelectorAll<HTMLElement>(".cell.selected")) node.classList.remove("selected");
  if (!state.selected) return;
  ui.grid
    .querySelector<HTMLElement>(`.cell[data-family="${state.selected.family}"][data-order="${state.selected.order}"]`)
    ?.classList.add("selected");
}

async function select(family: string, order: string) {
  state.selected = { family, order };
  markSelected();
  try {
    renderInspector(await api.fidelDetail(family, order));
  } catch (err) {
    ui.inspector.replaceChildren(el("p", { class: "subtle" }, String(err)));
  }
}

/** Double-click: the 1st order opens its base; other orders open their first drawable alteration. */
async function editFromCell(family: string, order: string) {
  if (order !== "giiz") {
    const detail = await api.fidelDetail(family, order);
    const drawable = detail.recipe.find((s) => state.alterations.find((a) => a.id === s.id)?.drawable);
    if (drawable) {
      state.contextFamily = family;
      await openDrawing({ kind: "alteration", id: drawable.id });
      return;
    }
  }
  await openDrawing({ kind: "base", id: family });
}

function cellOutline(family: string, order: string) {
  return state.grid?.rows.find((r) => r.family === family)?.cells.find((c) => c.order === order)?.outline;
}

function renderInspector(d: FidelDetail) {
  const metrics = state.grid?.metrics;
  const recipe = el("ul", { class: "recipe" });
  if (d.baseGlyph) {
    const b = el(
      "button",
      { class: "chip recipe-step clickable", title: "Edit this base" },
      el("span", { class: "step-glyph", lang: "gez" }, d.baseGlyph),
      el("span", {}, `Base · ${d.familyName}`),
      el("span", { class: "step-edit" }, "Edit"),
    );
    b.addEventListener("click", () => void openDrawing({ kind: "base", id: d.family }));
    recipe.append(el("li", {}, b));
  }
  for (const step of d.recipe) {
    const drawable = state.alterations.find((a) => a.id === step.id)?.drawable ?? false;
    const chip = el(
      drawable ? "button" : "span",
      { class: `chip recipe-step${step.drawn ? "" : " undrawn"}${drawable ? " clickable" : ""}` },
      el("span", { class: "step-plus", "aria-hidden": "true" }, "+"),
      el("span", {}, step.name),
      ...(drawable
        ? [el("span", { class: step.drawn ? "step-edit" : "step-note" }, step.drawn ? "Edit" : "Draw")]
        : [el("span", { class: "step-note muted-note" }, "not applied yet")]),
    );
    if (drawable) {
      chip.addEventListener("click", () => {
        state.contextFamily = d.family;
        void openDrawing({ kind: "alteration", id: step.id });
      });
    }
    recipe.append(el("li", {}, chip));
  }
  if (d.state === "detached") recipe.append(el("li", { class: "chip recipe-step" }, "Hand-drawn outline"));

  const outline = cellOutline(d.family, d.order);
  const open = el("button", { class: "pill pill-dark" }, "Open in editor");
  open.addEventListener("click", () => void editFromCell(d.family, d.order));

  ui.inspector.replaceChildren(
    el(
      "div",
      { class: `preview preview-${d.state}` },
      metrics && outline
        ? el("span", { class: "preview-glyph drawn" }, glyphView(outline, metrics, d.codepoint))
        : el("span", { class: "preview-glyph", lang: "gez" }, d.codepoint ?? ""),
      el("span", { class: "chip chip-glass preview-code" }, hex(d.codepoint)),
      el(
        "span",
        { class: `chip chip-glass preview-state state-${d.state}` },
        el("span", { class: `badge badge-${d.badge}`, "aria-hidden": "true" }),
        STATE_LABEL[d.state],
      ),
    ),
    el(
      "div",
      { class: "inspector-body" },
      el("h2", { class: "display inspector-title" }, `${d.familyName} `, el("span", { class: "muted" }, d.orderName)),
      el(
        "dl",
        { class: "facts" },
        el("div", {}, el("dt", {}, "Order"), el("dd", {}, `${d.orderNumber} · ${d.orderName}`)),
        el("div", {}, el("dt", {}, "Group"), el("dd", {}, d.group ? (GROUP_LABEL[d.group] ?? d.group) : "—")),
        el("div", {}, el("dt", {}, "Nudges"), el("dd", {}, String(d.nudgeCount))),
      ),
      el("p", { class: "state-help" }, d.note ?? STATE_HELP[d.state]),
      el("h3", { class: "section-label" }, "Recipe"),
      recipe,
      el(
        "div",
        { class: "actions" },
        open,
        el("button", { class: "pill", disabled: "", title: "Arrives with ETH-6" }, "Detach"),
      ),
    ),
  );
}

function renderEmptyInspector() {
  ui.inspector.replaceChildren(
    el("div", { class: "preview preview-empty" }, el("span", { class: "preview-glyph", lang: "gez" }, "ሄ")),
    el(
      "div",
      { class: "inspector-body" },
      el("h2", { class: "display inspector-title" }, "Pick a fidel"),
      el(
        "p",
        { class: "state-help" },
        "Select any cell to see its order, state and recipe. Double-click to draw its base or alteration.",
      ),
    ),
  );
}

// ---------- Editor ----------

const editor = new GlyphEditor(ui.editorView, {
  changed: () => {
    scheduleSideRefresh();
    void refreshProjectInfo();
  },
  toast,
  renderSide: (ed) => renderEditorSide(ed),
});

async function openDrawing(target: DrawingTarget) {
  try {
    if (state.view !== "editor") {
      state.view = "editor";
      ui.gridView.hidden = true;
      ui.editorView.hidden = false;
      document.querySelectorAll<HTMLElement>(".tab[data-view]").forEach((t) => {
        t.classList.toggle("active", t.dataset.view === "editor");
      });
    }
    await editor.open(target, target.kind === "alteration" ? state.contextFamily : undefined);
    ui.drawingSelect.value = `${target.kind}:${target.id}`;
  } catch (err) {
    toast(`Could not open the drawing: ${err}`, "error");
  }
}

function fillDrawingSelect() {
  const bases = el("optgroup", { label: "Bases" });
  for (const row of state.grid?.rows ?? []) {
    bases.append(el("option", { value: `base:${row.family}` }, `${row.cells[0]?.codepoint ?? ""}  ${row.name}`));
  }
  const alts = el("optgroup", { label: "Alterations" });
  for (const a of state.alterations.filter((a) => a.drawable)) {
    alts.append(el("option", { value: `alteration:${a.id}` }, `${a.name}${a.drawn ? "" : " (not drawn)"}`));
  }
  ui.drawingSelect.replaceChildren(bases, alts);
  if (editor.target) ui.drawingSelect.value = editor.targetKey;
}

ui.drawingSelect.addEventListener("change", () => {
  const [kind, ...rest] = ui.drawingSelect.value.split(":");
  void openDrawing({ kind: kind as "base" | "alteration", id: rest.join(":") });
});

let sideTimer: number | undefined;
function scheduleSideRefresh() {
  clearTimeout(sideTimer);
  sideTimer = window.setTimeout(async () => {
    state.alterations = await api.listAlterations();
    state.grid = await api.fidelGrid();
    fillDrawingSelect();
    if (state.view === "editor") renderEditorSide(editor);
  }, 120);
}

let previewToken = 0;

function renderEditorSide(ed: GlyphEditor) {
  if (state.view !== "editor" || !ed.drawing) return;
  const d = ed.drawing;
  const metrics = d.metrics;
  const sections: Node[] = [];

  // Live preview: the drawing inside the system.
  const strip = el("div", { class: "system-strip" });
  const previewTitle =
    d.target.kind === "base" ? "The family, live" : `On every family (${orderNamesOf(d.target.id)})`;
  sections.push(el("h3", { class: "section-label first" }, previewTitle), strip);
  const token = ++previewToken;
  if (d.target.kind === "base") {
    void api.familyPreview(d.target.id).then((list) => {
      if (token === previewToken) strip.replaceChildren(...list.map((p) => previewCell(p, metrics)));
    });
  } else {
    const alt = state.alterations.find((a) => a.id === d.target.id);
    const order = alt?.orders[0];
    strip.classList.add("many");
    for (const row of state.grid?.rows ?? []) {
      const cell = row.cells.find((c) => c.order === order);
      if (!cell) continue;
      const b = el(
        "button",
        {
          class: `mini${d.context?.family === row.family ? " current" : ""}`,
          title: `${row.name}: show its base behind the drawing`,
        },
        glyphView(cell.outline, metrics, cell.codepoint),
      );
      b.addEventListener("click", () => {
        state.contextFamily = row.family;
        void editor.open(d.target, row.family);
      });
      strip.append(b);
    }
    if (d.context) {
      sections.push(el("p", { class: "side-note" }, `Drawn against ${d.context.familyName}. Click a fidel to switch.`));
    } else {
      sections.push(el("p", { class: "side-note" }, "Draw a base first to see this alteration in context."));
    }
  }

  // Selection.
  const sel = ed.selection.size;
  const selBox = el("div", { class: "side-box" });
  if (!sel) {
    selBox.append(el("p", { class: "side-note" }, `${ed.contours.length} contour${ed.contours.length === 1 ? "" : "s"}. Nothing selected.`));
  } else {
    const contours = ed.selectedContours();
    selBox.append(
      el(
        "p",
        { class: "side-note" },
        `${sel} point${sel === 1 ? "" : "s"} in ${contours.length} contour${contours.length === 1 ? "" : "s"}`,
      ),
    );
    if (sel === 1) {
      const [ci, pi] = [...ed.selection][0].split(":").map(Number);
      const p = ed.contours[ci]?.points[pi];
      if (p) {
        const x = numberField("X", p.pos.x, (v) => ed.setPointPosition(v, p.pos.y));
        const y = numberField("Y", p.pos.y, (v) => ed.setPointPosition(p.pos.x, v));
        selBox.append(el("div", { class: "field-row" }, x, y));
        if (isOn(p)) {
          const smooth = el("button", { class: `toggle${p.smooth ? " on" : ""}` }, p.smooth ? "Smooth" : "Corner");
          smooth.title = "Toggle smooth (double-click a point)";
          smooth.addEventListener("click", () => ed.setSmooth(!p.smooth));
          selBox.append(smooth);
        }
      }
    }
    // Part tags for the selected contours.
    const current = new Set(contours.map((ci) => ed.contours[ci]?.part ?? null));
    const only = current.size === 1 ? [...current][0] : undefined;
    const tags = el("div", { class: "part-tags" });
    for (const part of PARTS) {
      const b = el(
        "button",
        { class: `part-tag${only === part ? " on" : ""}`, style: `--part:${PART_COLORS[part]}` },
        el("span", { class: "part-dot", "aria-hidden": "true" }),
        part,
      );
      b.addEventListener("click", () => ed.setPart(only === part ? null : part));
      tags.append(b);
    }
    selBox.append(el("h3", { class: "section-label" }, "Part"), tags);
  }
  sections.push(el("h3", { class: "section-label" }, "Selection"), selBox);

  // Metrics.
  if (d.advanceWidth !== null) {
    sections.push(
      el("h3", { class: "section-label" }, "Metrics"),
      el(
        "div",
        { class: "field-row" },
        numberField("Advance", d.advanceWidth, (v) => void ed.setAdvance(v)),
        el("div", { class: "field static" }, el("span", {}, "Pa-height"), el("strong", {}, `${metrics.pa_bottom}–${metrics.pa_top}`)),
      ),
    );
  }

  // Sketch.
  const sk = ed.sketch;
  const sketchBox = el("div", { class: "side-box" });
  const file = el("input", { type: "file", accept: "image/*", hidden: "" }) as HTMLInputElement;
  file.addEventListener("change", () => {
    if (file.files?.[0]) ed.loadSketch(file.files[0]);
  });
  const load = el("button", { class: "pill small" }, sk ? "Replace image" : "Place a sketch");
  load.addEventListener("click", () => file.click());
  sketchBox.append(file, load);
  if (sk) {
    const remove = el("button", { class: "pill small ghost" }, "Remove");
    remove.addEventListener("click", () => ed.removeSketch());
    sketchBox.append(
      remove,
      rangeField("Opacity", sk.opacity, 0.05, 1, (v) => ed.updateSketch({ opacity: v })),
      rangeField("Size", sk.h / (metrics.pa_top - metrics.pa_bottom), 0.3, 2, (v) => ed.updateSketch({ scale: v })),
      el("p", { class: "side-note" }, "Alt-drag on the canvas to move it. Kept for this session only."),
    );
  }
  sections.push(el("h3", { class: "section-label" }, "Sketch"), sketchBox);

  sections.push(
    el(
      "p",
      { class: "shortcuts" },
      "V select · P pen · H or Space pan · Ctrl+V paste SVG · Delete · Arrows nudge (Shift ×10) · Double-click toggles smooth",
    ),
  );

  ui.inspector.replaceChildren(el("div", { class: "inspector-body editor-side" }, ...sections));
}

function orderNamesOf(altId: string): string {
  const alt = state.alterations.find((a) => a.id === altId);
  const names = alt?.orders.map((o) => state.grid?.orders.find((h) => h.order === o)?.name ?? o) ?? [];
  return names.join(", ") || "unused";
}

function previewCell(p: FidelPreview, metrics: FidelGrid["metrics"]): Node {
  const issue = p.issues[0];
  return el(
    "div",
    { class: `mini${p.outline ? "" : " empty"}`, title: issue ? `${p.orderName}: ${issue}` : p.orderName },
    glyphView(p.outline, metrics, p.codepoint),
    el("span", { class: "mini-label" }, p.orderName),
    ...(issue ? [el("span", { class: "mini-issue", "aria-hidden": "true" })] : []),
  );
}

function numberField(label: string, value: number, onChange: (v: number) => void): HTMLElement {
  const input = el("input", { type: "number", value: String(Math.round(value)), step: "1" }) as HTMLInputElement;
  input.addEventListener("change", () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onChange(v);
  });
  return el("label", { class: "field" }, el("span", {}, label), input);
}

function rangeField(label: string, value: number, min: number, max: number, onInput: (v: number) => void): HTMLElement {
  const input = el("input", { type: "range", min: String(min), max: String(max), step: "0.01", value: String(value) }) as HTMLInputElement;
  input.addEventListener("input", () => onInput(Number(input.value)));
  return el("label", { class: "field range" }, el("span", {}, label), input);
}

// ---------- Files ----------

const KID_FILTER = [{ name: "Ethiopic font project", extensions: ["kid"] }];
let projectInfo: ProjectInfo = { name: "Untitled Ge'ez", path: null, dirty: false };

function showProjectInfo(info: ProjectInfo) {
  projectInfo = info;
  ui.projectName.textContent = info.name;
  ui.projectMeta.textContent = info.dirty ? "Unsaved changes" : info.path ? "Saved" : "Regular · 1000 UPM";
  ui.projectMeta.classList.toggle("unsaved", info.dirty);
  ui.projectName.title = info.path ?? "Not saved yet";
  document.title = `${info.dirty ? "• " : ""}${info.name} · Ethiopic Font Editor`;
}

async function refreshProjectInfo() {
  showProjectInfo(await api.projectInfo());
}

/** True when it is fine to throw away the open project. */
async function confirmDiscard(action: string): Promise<boolean> {
  await refreshProjectInfo();
  if (!projectInfo.dirty) return true;
  return ask(`${projectInfo.name} has unsaved changes. ${action} anyway and lose them?`, {
    title: "Unsaved changes",
    kind: "warning",
    okLabel: action,
    cancelLabel: "Keep editing",
  });
}

async function afterProjectChanged(info: ProjectInfo) {
  showProjectInfo(info);
  editor.reset();
  state.selected = null;
  state.contextFamily = undefined;
  state.alterations = await api.listAlterations();
  await refreshGrid();
  fillDrawingSelect();
  showView("grid");
}

async function newProject() {
  if (!(await confirmDiscard("Start a new project"))) return;
  await afterProjectChanged(await api.newProject());
}

async function openProject() {
  if (!(await confirmDiscard("Open another file"))) return;
  const path = await openDialog({ multiple: false, directory: false, filters: KID_FILTER });
  if (typeof path !== "string") return;
  try {
    await afterProjectChanged(await api.openProject(path));
    toast(`Opened ${projectInfo.name}.`);
  } catch (err) {
    toast(String(err), "error");
  }
}

async function saveProject(saveAs = false): Promise<boolean> {
  let path: string | undefined;
  if (saveAs || !projectInfo.path) {
    const chosen = await saveDialog({ defaultPath: `${projectInfo.name}.kid`, filters: KID_FILTER });
    if (!chosen) return false;
    path = chosen;
  }
  try {
    showProjectInfo(await api.saveProject(path));
    toast(`Saved ${projectInfo.name}.`);
    return true;
  } catch (err) {
    toast(`Could not save: ${err}`, "error");
    return false;
  }
}

document.querySelectorAll<HTMLButtonElement>("[data-file]").forEach((b) =>
  b.addEventListener("click", (e) => {
    const action = b.dataset.file;
    if (action === "new") void newProject();
    else if (action === "open") void openProject();
    else void saveProject(e.shiftKey);
  }),
);

window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === "s") {
    e.preventDefault();
    void saveProject(e.shiftKey);
  } else if (k === "o") {
    e.preventDefault();
    void openProject();
  } else if (k === "n") {
    e.preventDefault();
    void newProject();
  }
});

// Ask before closing the window with unsaved work.
void getCurrentWindow()
  .onCloseRequested(async (event) => {
    if (!(await confirmDiscard("Close"))) event.preventDefault();
  })
  .catch(() => {
    /* not running inside Tauri */
  });

// ---------- Start ----------

async function main() {
  renderEmptyInspector();
  const label = ui.status.querySelector(".label")!;
  try {
    const info = await api.appInfo();
    await refreshProjectInfo();
    label.textContent = `Core ${info.coreVersion}`;
    ui.status.classList.add("ok");
    ui.status.title = `${info.familyCount} families · ${info.alterationCount} alterations`;
    state.alterations = await api.listAlterations();
    await refreshGrid();
    fillDrawingSelect();
    const row = state.grid?.rows[1];
    if (row) await select(row.family, row.cells[4].order);
  } catch (err) {
    label.textContent = "Core offline";
    ui.status.classList.add("error");
    ui.summary.textContent = "Run inside the desktop app (npm run tauri dev) to load the grid.";
    console.error(err);
  }
}

void main();
