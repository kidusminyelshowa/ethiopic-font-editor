import "@fontsource-variable/fraunces/opsz.css";
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/noto-serif-ethiopic/index.css";
import "./style.css";
import "./shell.css";

import {
  api,
  PARTS,
  type AlterationSummary,
  type ComponentKind,
  type ComponentSummary,
  type Effect,
  type ImpactView,
  type Scope,
  type DrawingTarget,
  type FidelDetail,
  type FidelGrid,
  type FidelPreview,
  type ProjectInfo,
  type StateKind,
  type CharSetId,
  type CharSetInfo,
  type LanguageId,
  type LanguageInfo,
  type FontProperties,
  type DrawingKind,
  type SymbolCell,
} from "./api";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { el, glyphView, hex } from "./dom";
import { GlyphEditor, PART_COLORS } from "./editor";
import { componentsSection, orderRulesSection } from "./orderSide";
import {
  bindViewMenu,
  historyRows,
  issuesSection,
  LAYER_ICONS,
  metricsSection,
  numberField,
  onRefresh,
  shapeSection,
  showContextMenu,
  showMenu,
  pathOpsSection,
  guideSection,
  backgroundSection,
  transformSection,
  showShortcuts,
} from "./editorSide";
import { checkForUpdate } from "./updater";
import { setupChrome } from "./chrome";
import { keysFor, onShortcuts, showKeys } from "./shortcuts";

setupChrome();
import { isClockwise, isOn } from "./geometry";

const STATES: StateKind[] = ["linked", "adjusted", "detached"];

const STATE_LABEL: Record<StateKind, string> = {
  linked: "Linked",
  adjusted: "Adjusted",
  detached: "Drawn by hand",
};

const STATE_HELP: Record<StateKind, string> = {
  linked: "Generated from the base and the order rule. Updates automatically.",
  adjusted: "Generated, with local nudges that survive upstream changes.",
  detached: "Drawn by hand. No longer follows the base or the order's form.",
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
  components: [] as ComponentSummary[],
  filter: "all" as StateKind | "all",
  selected: null as { family: string; order: string } | null,
  /** A selected punctuation mark or numeral, by symbol id. */
  selectedSymbol: null as string | null,
  /** Family whose base is drawn behind an alteration in the editor. */
  contextFamily: undefined as string | undefined,
};

/** Alterations and components, for the Parts list and the editor. */
async function loadParts() {
  [state.alterations, state.components] = await Promise.all([api.listAlterations(), api.listComponents()]);
}

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
    if (!editor.drawing) void openDrawing({ kind: "base", id: state.grid?.rows[0]?.base ?? "ha" });
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
  void refreshProof();
  state.grid = await api.fidelGrid();
  ui.summary.textContent = gridSummary(state.grid);
  renderFilters(state.grid);
  renderGrid(state.grid);
  renderSidebar();
  renderCharsetMenu();
}

function gridSummary(grid: FidelGrid): string {
  const fidel = grid.rows.reduce((n, r) => n + r.cells.length, 0);
  const parts = [`${fidel} fidel`, `${grid.rows.length} families`];
  if (grid.symbols.length) parts.push(`${grid.symbols.length} symbols`);
  return parts.join(" · ");
}

/** The set a family row is listed under, by name. */
function setName(id: CharSetId): string {
  return state.grid?.charsets.find((c) => c.id === id)?.name ?? id;
}

/** The base drawing a family row is built from. */
function baseOf(family: string): string {
  return state.grid?.rows.find((r) => r.family === family)?.base ?? family;
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
  const extras = grid.orders.filter((o) => o.extra).length;
  const table = el("table", { class: `fidel-grid${extras ? " has-extra" : ""}` });
  const head = table.createTHead().insertRow();
  head.append(el("th", { scope: "col", class: "corner" }));
  for (const [i, o] of grid.orders.entries()) {
    const first = o.extra && !grid.orders[i - 1]?.extra;
    head.append(
      el(
        "th",
        { scope: "col", class: o.extra ? `extra${first ? " extra-first" : ""}` : "" },
        o.extra
          ? el("span", { class: "order-pill" }, o.name)
          : el("span", { class: "order-pill" }, el("span", { class: "order-num" }, String(o.number)), o.name),
      ),
    );
  }

  const body = table.createTBody();
  const sections = new Set(grid.rows.map((r) => r.section));
  let section: string | null = null;
  for (const row of grid.rows) {
    if (sections.size > 1 && row.section !== section) {
      section = row.section;
      const tr = body.insertRow();
      tr.className = "section-row";
      tr.append(el("th", { scope: "rowgroup", colspan: String(grid.orders.length + 1) }, setName(row.section)));
    }
    const tr = body.insertRow();
    const base = row.cells[0]?.codepoint ?? "";
    tr.append(
      el(
        "th",
        { scope: "row", title: row.name },
        el("span", { class: "family" }, el("span", { class: "family-glyph", lang: "gez" }, base)),
      ),
    );
    for (const [i, o] of grid.orders.entries()) {
      const td = tr.insertCell();
      if (o.extra) td.className = !grid.orders[i - 1]?.extra ? "extra extra-first" : "extra";
      const cell = row.cells.find((c) => c.order === o.order);
      if (!cell) continue;
      const btn = el(
        "button",
        {
          class: `cell state-${cell.state}${cell.outline ? " drawn" : ""}`,
          "data-family": row.family,
          "data-order": cell.order,
          "data-state": cell.state,
          "aria-label": `${cell.codepoint ?? ""}, ${row.name}, ${o.name}, ${STATE_LABEL[cell.state]}`,
          title: `${row.name} · ${o.name}${cell.note ? `\n${STATE_LABEL[cell.state]}: ${cell.note}` : cell.state === "linked" ? "" : ` · ${STATE_LABEL[cell.state]}`}`,
        },
        glyphView(cell.outline, grid.metrics, cell.codepoint),
        el("span", { class: `badge badge-${cell.badge}`, "aria-hidden": "true" }),
      );
      btn.addEventListener("click", () => void select(row.family, cell.order));
      btn.addEventListener("dblclick", () => void editFromCell(row.family, cell.order));
      td.append(btn);
    }
  }
  const nodes: Node[] = [table];
  if (grid.symbols.length) {
    const wrap = el("section", { class: "symbol-grid", "aria-label": "Symbols" });
    wrap.append(el("h2", { class: "symbol-heading" }, "Punctuation, numerals and marks"));
    const list = el("div", { class: "symbol-cells" });
    for (const s of grid.symbols) list.append(symbolButton(s, grid));
    wrap.append(list);
    nodes.push(wrap);
  }
  ui.grid.replaceChildren(...nodes);
  markSelected();
}

function symbolButton(s: SymbolCell, grid: FidelGrid) {
  const btn = el(
    "button",
    {
      class: `cell symbol-cell${s.outline ? " drawn" : ""}`,
      "data-symbol": s.id,
      "data-state": "linked",
      "aria-label": `${s.codepoint}, ${s.name}`,
      title: `${s.name} · ${codeOf(s.codepoint)}`,
    },
    glyphView(s.outline, grid.metrics, s.codepoint),
  );
  btn.addEventListener("click", () => selectSymbol(s.id));
  btn.addEventListener("dblclick", () => void openDrawing({ kind: "symbol", id: s.id }));
  return btn;
}

function selectSymbol(id: string) {
  state.selected = null;
  state.selectedSymbol = id;
  markSelected();
  const s = state.grid?.symbols.find((x) => x.id === id);
  if (!s || !state.grid) return;
  const edit = el("button", { class: "pill pill-dark symbol-open" }, "Open in editor");
  edit.addEventListener("click", () => void openDrawing({ kind: "symbol", id }));
  const metrics = state.grid.metrics;
  ui.inspector.replaceChildren(
    el(
      "div",
      { class: "preview preview-linked" },
      s.outline
        ? el("span", { class: "preview-glyph drawn" }, glyphView(s.outline, metrics, s.codepoint))
        : el("span", { class: "preview-glyph", lang: "gez" }, s.codepoint),
      el("span", { class: "chip chip-glass preview-code" }, hex(s.codepoint)),
    ),
    el(
      "div",
      { class: "inspector-body" },
      el("h2", { class: "display inspector-title" }, s.name),
      el(
        "dl",
        { class: "facts" },
        el("div", {}, el("dt", {}, "Kind"), el("dd", {}, "Symbol")),
        el("div", {}, el("dt", {}, "Outline"), el("dd", {}, s.outline ? "Drawn" : "Not drawn")),
      ),
      edit,
    ),
  );
}

function markSelected() {
  markSidebar();
  for (const node of ui.grid.querySelectorAll<HTMLElement>(".cell.selected")) node.classList.remove("selected");
  if (state.selectedSymbol) {
    ui.grid.querySelector<HTMLElement>(`.cell[data-symbol="${state.selectedSymbol}"]`)?.classList.add("selected");
  }
  if (!state.selected) return;
  ui.grid
    .querySelector<HTMLElement>(`.cell[data-family="${state.selected.family}"][data-order="${state.selected.order}"]`)
    ?.classList.add("selected");
}

async function select(family: string, order: string) {
  state.selected = { family, order };
  state.selectedSymbol = null;
  markSelected();
  try {
    const d = await api.fidelDetail(family, order);
    // A double-click may have opened the editor meanwhile: its panel wins.
    if (state.view === "grid") renderInspector(d);
  } catch (err) {
    ui.inspector.replaceChildren(el("p", { class: "subtle" }, String(err)));
  }
}

/** Double-click: the 1st order opens its base; every other order opens the fidel itself. */
async function editFromCell(family: string, order: string) {
  if (order === "giiz") {
    await openDrawing({ kind: "base", id: baseOf(family) });
    return;
  }
  state.contextFamily = family;
  await openDrawing({ kind: "fidel", id: `${family}/${order}` });
}

function cellOutline(family: string, order: string) {
  return state.grid?.rows.find((r) => r.family === family)?.cells.find((c) => c.order === order)?.outline;
}

function renderInspector(d: FidelDetail) {
  const metrics = state.grid?.metrics;
  const recipe = el("ul", { class: "recipe" });
  if (d.builtOn) {
    const on = d.builtOn;
    const b = el(
      "button",
      { class: "chip recipe-step clickable", title: "Select the fidel this one is built on" },
      el("span", { class: "step-glyph", lang: "gez" }, on.codepoint ?? ""),
      el("span", {}, `Built on ${on.orderName}`),
      el("span", { class: "step-edit" }, "Go"),
    );
    b.addEventListener("click", () => void select(d.family, on.order));
    recipe.append(el("li", {}, b));
  } else if (d.baseGlyph && d.state !== "detached") {
    const b = el(
      "button",
      { class: "chip recipe-step clickable", title: "Edit this base" },
      el("span", { class: "step-glyph", lang: "gez" }, d.baseGlyph),
      el("span", {}, `Base · ${d.familyName}`),
      el("span", { class: "step-edit" }, "Edit"),
    );
    b.addEventListener("click", () => void openDrawing({ kind: "base", id: baseOf(d.family) }));
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
        : [el("span", { class: "step-note" }, "Deform")]),
    );
    if (drawable) {
      chip.addEventListener("click", () => {
        state.contextFamily = d.family;
        void openDrawing({ kind: "alteration", id: step.id });
      });
    } else {
      chip.title = "Reshapes the base. Set its zone and throw from the base, under Orders.";
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
        { class: `chip chip-glass preview-state state-${d.state}`, title: STATE_HELP[d.state] },
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
        el("div", {}, el("dt", {}, "Order"), el("dd", {}, d.orderNumber > 7 ? d.orderName : `${d.orderNumber} · ${d.orderName}`)),
        el("div", {}, el("dt", {}, "Group"), el("dd", {}, d.group ? (GROUP_LABEL[d.group] ?? d.group) : "—")),
        el("div", {}, el("dt", {}, "Nudges"), el("dd", {}, String(d.nudgeCount))),
      ),
      ...(d.note ? [el("p", { class: "state-help" }, d.note)] : []),
      el("h3", { class: "section-label" }, "Recipe"),
      recipe,
      ...(d.order !== "giiz" ? [formPicker(d)] : []),
      ...(d.builtOnChoices.length && d.order !== "giiz" ? [builtOnPicker(d)] : []),
      ...(d.builtOnBy.length
        ? [
            el(
              "p",
              { class: "built-on-by" },
              el("span", { lang: "gez" }, d.builtOnBy.map((r) => r.codepoint ?? r.orderName).join(" ")),
              ` ${d.builtOnBy.length === 1 ? "is" : "are"} built on this fidel and follow its changes.`,
            ),
          ]
        : []),
      el("div", { class: "actions" }, open, ...stateActions(d)),
    ),
  );
}

/** How this family forms the order: one of the order's forms, or drawn by hand. */
function formPicker(d: FidelDetail, onChange?: (d: FidelDetail) => void) {
  const pick = el("select", { class: "built-on-select", "aria-label": "Form" });
  for (const v of d.variants) {
    const opt = el("option", { value: String(v.index) }, v.label || "Nothing added");
    if (!d.drawnByHand && v.index === d.variant) opt.selected = true;
    pick.append(opt);
  }
  const draw = el("option", { value: "draw" }, "Draw it");
  if (d.drawnByHand) draw.selected = true;
  pick.append(draw);
  pick.addEventListener("change", () => {
    const variant = pick.value === "draw" ? null : Number(pick.value);
    const run = () => api.setForm(d.family, d.order, variant);
    if (onChange) void run().then(onChange, (err) => toast(String(err), "error"));
    else void changeFidel(run, d);
  });
  return el(
    "label",
    {
      class: "built-on",
      title: `How ${d.familyName} forms its ${d.orderName}. "Draw it" keeps the generated outline as a starting point.`,
    },
    el("span", { class: "section-label" }, "Form"),
    pick,
  );
}

/** "Start from": the bare base, or another order of the family. */
function builtOnPicker(d: FidelDetail) {
  const pick = el("select", { class: "built-on-select", "aria-label": "Start from" });
  pick.append(el("option", { value: "" }, `Base ${d.baseGlyph ?? ""}`));
  for (const c of d.builtOnChoices) {
    const opt = el("option", { value: c.order }, `${c.codepoint ?? ""} · ${c.orderName}`);
    if (d.builtOn?.order === c.order) opt.selected = true;
    pick.append(opt);
  }
  pick.addEventListener("change", () => {
    void changeFidel(() => api.setBuiltOn(d.family, d.order, pick.value || null), d);
  });
  return el("label", { class: "built-on" }, el("span", { class: "section-label" }, "Start from"), pick);
}

function stateActions(d: FidelDetail) {
  const out: HTMLElement[] = [];
  if (d.state === "adjusted" || d.state === "detached") {
    const relink = el("button", { class: "pill", title: "Drop local edits and follow the order rule again" }, "Relink");
    relink.addEventListener("click", () => void changeFidel(() => api.relinkFidel(d.family, d.order), d));
    out.push(relink);
  }
  if (d.state !== "detached") {
    const detach = el(
      "button",
      { class: "pill", title: "Keep the current outline as a hand drawing that no longer updates" },
      "Detach",
    );
    detach.addEventListener("click", () => void changeFidel(() => api.detachFidel(d.family, d.order), d));
    out.push(detach);
  }
  return out;
}

/** Run a change to one fidel, then refresh the inspector, grid and title. */
async function changeFidel(run: () => Promise<FidelDetail>, d: FidelDetail) {
  try {
    renderInspector(await run());
    await refreshGrid();
    void refreshProjectInfo();
  } catch (err) {
    ui.inspector.append(el("p", { class: "subtle error-note" }, String(err)));
    void select(d.family, d.order);
  }
}

/** With nothing selected, the inspector shows the font itself. */
function renderEmptyInspector() {
  const token = ++fontPropsToken;
  void api
    .fontProperties()
    .then((p) => {
      if (token === fontPropsToken && !state.selected && !state.selectedSymbol) renderFontProperties(p);
    })
    .catch(() => {
      ui.inspector.replaceChildren(
        el("div", { class: "inspector-body" }, el("h2", { class: "display inspector-title muted" }, "No selection")),
      );
    });
}

let fontPropsToken = 0;

function renderFontProperties(p: FontProperties) {
  const info = { ...p.info };
  let paTop = p.metrics.pa_top;
  let paBottom = p.metrics.pa_bottom;
  const save = async () => {
    try {
      await api.setFontProperties(info, paTop, paBottom);
      void refreshProjectInfo();
      if (state.grid) {
        state.grid.metrics.pa_top = paTop;
        state.grid.metrics.pa_bottom = paBottom;
      }
    } catch (err) {
      toast(String(err), "error");
      renderEmptyInspector();
    }
  };
  const text = (label: string, value: string, placeholder: string, set: (v: string) => void) => {
    const input = el("input", { type: "text", value, placeholder, spellcheck: "false" }) as HTMLInputElement;
    input.addEventListener("change", () => {
      set(input.value);
      void save();
    });
    return el("label", { class: "field" }, el("span", {}, label), input);
  };
  const num = (label: string, value: number, set: (v: number) => void, step = "1") => {
    const input = el("input", { type: "number", value: String(value), step }) as HTMLInputElement;
    input.addEventListener("change", () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      set(v);
      void save();
    });
    return el("label", { class: "field" }, el("span", {}, label), input);
  };
  ui.inspector.replaceChildren(
    el(
      "div",
      { class: "inspector-body font-props" },
      el("h2", { class: "display inspector-title" }, info.family_name || p.defaultFamilyName),
      el("p", { class: "subtle" }, `${p.drawn} of ${p.glyphs} glyphs drawn`),
      el("h3", { class: "section-label" }, "Font"),
      text("Family name", info.family_name, p.defaultFamilyName, (v) => (info.family_name = v.trim())),
      el(
        "div",
        { class: "field-row" },
        text("Style", info.style_name, "Regular", (v) => (info.style_name = v.trim() || "Regular")),
        num("Version", info.version, (v) => (info.version = Math.max(0, v)), "0.001"),
      ),
      text("Designer", info.designer, "", (v) => (info.designer = v.trim())),
      el("h3", { class: "section-label" }, "Metrics"),
      el(
        "div",
        { class: "field-row" },
        num("Pa-top", paTop, (v) => (paTop = v)),
        num("Pa-bottom", paBottom, (v) => (paBottom = v)),
      ),
      el("div", { class: "field static" }, el("span", {}, "Units per em"), el("strong", {}, String(p.metrics.units_per_em))),
    ),
  );
}

function deselect() {
  if (!state.selected && !state.selectedSymbol) return;
  state.selected = null;
  state.selectedSymbol = null;
  markSelected();
  renderEmptyInspector();
}

// Clicking the board outside the cells shows the font's properties.
document.getElementById("grid-view")!.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest(".cell, button, input, select, label, .menu, .proof")) return;
  deselect();
});

// ---------- Left sidebar: glyphs and parts ----------

const side = {
  tab: "glyphs" as "glyphs" | "parts",
  query: "",
  open: new Set<string>(),
  list: document.getElementById("side-list")!,
  search: document.getElementById("side-search") as HTMLInputElement,
};

function matches(...texts: (string | null | undefined)[]) {
  const q = side.query.trim().toLowerCase();
  if (!q) return true;
  return texts.some((t) => t?.toLowerCase().includes(q));
}

function codeOf(c: string | null) {
  return c ? `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}` : "";
}

function treeRow(opts: {
  depth: number;
  glyph?: string;
  label: string;
  meta?: string;
  dot?: string;
  twisty?: boolean;
  expanded?: boolean;
  data?: Record<string, string>;
  dim?: boolean;
  title?: string;
  /** The label is Ethiopic text. */
  glyphLabel?: boolean;
}) {
  const row = el(
    "button",
    {
      class: `tree-row depth-${opts.depth}${opts.dim ? " dim" : ""}`,
      role: "treeitem",
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.twisty ? { "aria-expanded": String(!!opts.expanded) } : {}),
      ...(opts.data ?? {}),
    },
    el(
      "span",
      { class: `twisty${opts.twisty ? "" : " none"}`, "aria-hidden": "true" },
      ...(opts.twisty
        ? [
            (() => {
              const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
              svg.setAttribute("viewBox", "0 0 10 10");
              svg.setAttribute("width", "8");
              svg.setAttribute("height", "8");
              svg.innerHTML = '<path d="M3.5 2l3 3-3 3" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
              return svg;
            })(),
          ]
        : []),
    ),
    el("span", { class: "tree-glyph", lang: "gez" }, opts.glyph ?? ""),
    el("span", { class: `tree-label${opts.glyphLabel ? " glyph-label" : ""}`, ...(opts.glyphLabel ? { lang: "gez" } : {}) }, opts.label),
    el("span", { class: "tree-meta" }, opts.meta ?? ""),
    ...(opts.dot ? [el("span", { class: `badge badge-${opts.dot}`, "aria-hidden": "true" })] : []),
  );
  return row;
}

/** In the editor the left panel lists the open drawing's layers. */
function renderLayers() {
  const ed = editor;
  const rows: HTMLElement[] = [];
  const d = ed.drawing;
  if (d) {
    rows.push(el("div", { class: "tree-section layers-head" }, d.title));
    const selected = new Set(ed.selectedContours());
    // Top of the list is the last drawn, like Figma.
    for (let ci = ed.contours.length - 1; ci >= 0; ci--) {
      const c = ed.contours[ci];
      const label = c.name || (c.part ? c.part[0].toUpperCase() + c.part.slice(1) : "Path");
      const pts = c.points.filter((p) => p.kind !== "offcurve").length;
      const dir = isClockwise(c) ? "↻" : "↺";
      const row = treeRow({ depth: 0, label, meta: `${pts} pt ${dir}`, data: { "data-layer": String(ci) } });
      row.title = isClockwise(c) ? "Clockwise" : "Counter-clockwise";
      row.classList.add("layer-row");
      if (selected.has(ci)) row.classList.add("selected");
      const swatch = row.querySelector<HTMLElement>(".tree-glyph")!;
      swatch.replaceChildren(el("span", { class: "layer-swatch", style: c.part ? `--part:${PART_COLORS[c.part]}` : "" }));
      if (c.hidden) row.classList.add("layer-hidden");
      if (c.locked) row.classList.add("layer-locked");
      const flags = el("span", { class: "layer-flags" });
      const flag = (name: "locked" | "hidden", on: boolean, iconOn: string, iconOff: string, title: string) => {
        const b = el("button", { class: `layer-flag${on ? " on" : ""}`, title, "aria-label": title, "aria-pressed": String(on) });
        b.append(LAYER_ICONS.icon(on ? iconOn : iconOff, 12));
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          ed.setLayerFlag(name, [ci]);
        });
        b.addEventListener("dblclick", (e) => e.stopPropagation());
        return b;
      };
      flags.append(
        flag("locked", !!c.locked, LAYER_ICONS.lock, LAYER_ICONS.unlock, c.locked ? "Unlock" : "Lock"),
        flag("hidden", !!c.hidden, LAYER_ICONS.eyeOff, LAYER_ICONS.eye, c.hidden ? "Show" : "Hide"),
      );
      row.append(flags);
      row.addEventListener("click", (e) => {
        if (!c.locked && !c.hidden) ed.selectLayer(ci, e.shiftKey);
      });
      row.addEventListener("dblclick", () => {
        const labelEl = row.querySelector<HTMLElement>(".tree-label")!;
        const input = el("input", { class: "layer-rename", type: "text", value: label, spellcheck: "false" }) as HTMLInputElement;
        labelEl.replaceChildren(input);
        input.focus();
        input.select();
        const done = (keep: boolean) => {
          if (keep) ed.renameLayer(ci, input.value);
          else renderLayers();
        };
        input.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") done(true);
          if (e.key === "Escape") done(false);
        });
        input.addEventListener("blur", () => done(true), { once: true });
        input.addEventListener("click", (e) => e.stopPropagation());
      });
      rows.push(row);
    }
    if (!ed.contours.length) rows.push(el("p", { class: "side-empty" }, "No layers"));
    if (d.context) {
      rows.push(
        el("div", { class: "tree-section" }, "Context"),
        treeRow({ depth: 0, glyph: "", label: `Base · ${d.context.familyName}`, meta: "", dim: true }),
      );
    }
    rows.push(...historyRows(ed));
  }
  side.list.replaceChildren(...rows);
}

function renderSidebar() {
  document.body.classList.toggle("editing", state.view === "editor");
  if (state.view === "editor") {
    renderLayers();
    return;
  }
  const rows: HTMLElement[] = [];
  if (side.tab === "glyphs") {
    const multi = new Set((state.grid?.rows ?? []).map((r) => r.section)).size > 1 || !!state.grid?.symbols.length;
    let section: string | null = null;
    for (const r of state.grid?.rows ?? []) {
      const base = r.cells[0]?.codepoint ?? "";
      const cells = r.cells.filter((c) => matches(r.name, r.family, c.codepoint, codeOf(c.codepoint), c.order));
      if (!cells.length) continue;
      if (multi && r.section !== section) {
        section = r.section;
        rows.push(el("div", { class: "tree-section" }, setName(r.section)));
      }
      const expanded = side.open.has(r.family) || !!side.query.trim();
      const glyphs = r.cells.filter((c) => !state.grid?.orders.find((o) => o.order === c.order)?.extra).map((c) => c.codepoint ?? "").join(" ");
      const fam = treeRow({ depth: 0, glyph: "", label: glyphs, glyphLabel: true, title: r.name, meta: String(r.cells.length), twisty: true, expanded, data: { "data-fam": r.family } });
      fam.addEventListener("click", () => {
        if (side.open.has(r.family)) side.open.delete(r.family);
        else side.open.add(r.family);
        renderSidebar();
      });
      rows.push(fam);
      if (!expanded) continue;
      for (const c of cells) {
        const order = state.grid?.orders.find((o) => o.order === c.order);
        const item = treeRow({
          depth: 1,
          glyph: c.codepoint ?? "",
          label: order ? `${order.number} · ${order.name}` : c.order,
          meta: codeOf(c.codepoint),
          dot: c.badge,
          data: { "data-family": r.family, "data-order": c.order },
        });
        item.addEventListener("click", () => {
          if (state.view !== "grid") showView("grid");
          void select(r.family, c.order);
        });
        item.addEventListener("dblclick", () => void editFromCell(r.family, c.order));
        rows.push(item);
      }
    }
    const symbols = (state.grid?.symbols ?? []).filter((s) => matches(s.name, s.id, s.codepoint, codeOf(s.codepoint)));
    if (symbols.length) rows.push(el("div", { class: "tree-section" }, "Symbols"));
    for (const s of symbols) {
      const item = treeRow({ depth: 0, glyph: s.codepoint, label: s.name, meta: codeOf(s.codepoint), data: { "data-symbol": s.id } });
      item.addEventListener("click", () => {
        if (state.view !== "grid") showView("grid");
        selectSymbol(s.id);
      });
      item.addEventListener("dblclick", () => void openDrawing({ kind: "symbol", id: s.id }));
      rows.push(item);
    }
  } else {
    const head = (t: string) => el("div", { class: "tree-section" }, t);
    const bases = baseRows().filter((r) => matches(r.name, r.family, r.cells[0]?.codepoint));
    if (bases.length) rows.push(head("Bases"));
    for (const r of bases) {
      const item = treeRow({ depth: 0, glyph: r.cells[0]?.codepoint ?? "", label: "Base", title: r.name, meta: "", data: { "data-target": `base:${r.base}` } });
      item.addEventListener("click", () => void openDrawing({ kind: "base", id: r.base }));
      rows.push(item);
    }
    const alts = state.alterations.filter((a) => matches(a.name, a.id));
    if (alts.length) rows.push(head("Alterations"));
    for (const a of alts) {
      const item = treeRow({
        depth: 0,
        glyph: a.drawable ? "+" : "~",
        label: a.name,
        meta: a.drawable ? (a.drawn ? "" : "to draw") : "deform",
        dim: !a.drawable,
        data: { "data-target": `alteration:${a.id}` },
      });
      if (a.drawable) item.addEventListener("click", () => void openDrawing({ kind: "alteration", id: a.id }));
      else {
        item.title = "Reshapes the base. Its zone and throw are set from a base, under Orders.";
        item.addEventListener("click", () => void openDrawing({ kind: "base", id: baseOf(state.contextFamily ?? firstDrawnFamily()) }));
      }
      rows.push(item);
    }
    const comps = state.components.filter((c) => matches(c.name, c.id));
    const add = el("button", { class: "tree-add", title: "New component", "aria-label": "New component" }, "+");
    add.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = add.getBoundingClientRect();
      showMenu(
        (["leaf", "cap", "corner"] as const).map((kind) => ({
          label: `${kind[0].toUpperCase()}${kind.slice(1)}`,
          run: () => void newComponent(kind),
        })),
        { x: r.left, y: r.bottom + 4 },
      );
    });
    rows.push(el("div", { class: "tree-section with-action" }, el("span", {}, "Components"), add));
    for (const c of comps) {
      const item = treeRow({
        depth: 0,
        glyph: c.kind === "leaf" ? "❦" : c.kind === "cap" ? "⌒" : "⌐",
        label: c.name,
        meta: c.drawn ? (c.uses ? `${c.uses} base${c.uses === 1 ? "" : "s"}` : "") : "to draw",
        data: { "data-target": `component:${c.id}` },
      });
      item.addEventListener("click", () => void openDrawing({ kind: "component", id: c.id }));
      rows.push(item);
    }
  }
  if (side.tab === "parts") {
    const symbols = (state.grid?.symbols ?? []).filter((s) => matches(s.name, s.id, s.codepoint, codeOf(s.codepoint)));
    if (symbols.length) rows.push(el("div", { class: "tree-section" }, "Symbols"));
    for (const s of symbols) {
      const item = treeRow({ depth: 0, glyph: s.codepoint, label: s.name, meta: s.outline ? "" : "to draw", data: { "data-target": `symbol:${s.id}` } });
      item.addEventListener("click", () => void openDrawing({ kind: "symbol", id: s.id }));
      rows.push(item);
    }
  }
  if (!rows.length) rows.push(el("p", { class: "side-empty" }, side.query ? "Nothing matches." : "Loading…"));
  side.list.replaceChildren(...rows);
  markSidebar();
}

async function newComponent(kind: ComponentKind) {
  const name = `${kind[0].toUpperCase()}${kind.slice(1)}`;
  try {
    const id = await api.addComponent(name, kind);
    await loadParts();
    fillDrawingSelect();
    await openDrawing({ kind: "component", id });
  } catch (err) {
    toast(`Could not add the component: ${err}`, "error");
  }
}

/** The first family whose base is drawn, for opening something to look at. */
function firstDrawnFamily(): string {
  const rows = state.grid?.rows ?? [];
  return (rows.find((r) => r.cells[0]?.outline) ?? rows[0])?.family ?? "ha";
}

/** One row per base: Sebatbeit and Gurage rows share the plain row's base. */
function baseRows() {
  const seen = new Set<string>();
  return (state.grid?.rows ?? []).filter((r) => !seen.has(r.base) && !!seen.add(r.base));
}

function markSidebar() {
  for (const n of side.list.querySelectorAll(".tree-row.selected")) n.classList.remove("selected");
  if (side.tab === "glyphs" && state.selected) {
    side.list
      .querySelector(`.tree-row[data-family="${state.selected.family}"][data-order="${state.selected.order}"]`)
      ?.classList.add("selected");
  }
  if (side.tab === "glyphs" && state.selectedSymbol) {
    side.list.querySelector(`.tree-row[data-symbol="${state.selectedSymbol}"]`)?.classList.add("selected");
  }
  if (side.tab === "parts" && editor.drawing && state.view === "editor") {
    side.list.querySelector(`.tree-row[data-target="${ui.drawingSelect.value}"]`)?.classList.add("selected");
  }
}

document.querySelectorAll<HTMLElement>(".side-tab").forEach((t) =>
  t.addEventListener("click", () => {
    side.tab = t.dataset.side as "glyphs" | "parts";
    document.querySelectorAll<HTMLElement>(".side-tab").forEach((o) => {
      o.classList.toggle("active", o === t);
      o.setAttribute("aria-selected", String(o === t));
    });
    renderSidebar();
  }),
);
side.search.addEventListener("input", () => {
  side.query = side.search.value;
  renderSidebar();
});

// ---------- Editor ----------

const editor = new GlyphEditor(ui.editorView, {
  changed: () => {
    scheduleSideRefresh();
    void refreshProjectInfo();
  },
  toast,
  renderSide: (ed) => renderEditorSide(ed),
  contextMenu: (ed, at) => showContextMenu(ed, at),
  alterationName: (id) => state.alterations.find((a) => a.id === id)?.name ?? id,
  glyphFor: (ch) => {
    const g = glyphIndex().get(ch);
    return g ? { target: g.target, d: g.outline?.d ?? null, advance: g.outline?.advanceWidth ?? state.grid?.metrics.units_per_em ?? 1000 } : null;
  },
  charOf: (target) => charOf(target),
  openTarget: (target) => void openDrawing(target),
});
// The editor's line of text updates when outlines change.
const redrawLine = () => {
  if (state.view === "editor" && editor.textIndex >= 0) editor.render();
};

/** Every character the project draws, with its drawing and outline. */
let glyphIndexCache: { grid: FidelGrid | null; map: Map<string, { target: DrawingTarget; outline?: { d: string; advanceWidth: number } }> } = {
  grid: null,
  map: new Map(),
};
function glyphIndex() {
  if (glyphIndexCache.grid === state.grid) return glyphIndexCache.map;
  const map = new Map<string, { target: DrawingTarget; outline?: { d: string; advanceWidth: number } }>();
  for (const row of state.grid?.rows ?? []) {
    for (const cell of row.cells) {
      if (cell.codepoint && !map.has(cell.codepoint)) {
        map.set(cell.codepoint, { target: { kind: "fidel", id: `${row.family}/${cell.order}` }, outline: cell.outline });
      }
    }
  }
  for (const sym of state.grid?.symbols ?? []) {
    if (!map.has(sym.codepoint)) map.set(sym.codepoint, { target: { kind: "symbol", id: sym.id }, outline: sym.outline });
  }
  glyphIndexCache = { grid: state.grid, map };
  return map;
}

/** The character a drawing makes: a fidel's, a symbol's, or a base's first order. */
function charOf(target: DrawingTarget): string | null {
  const grid = state.grid;
  if (!grid) return null;
  if (target.kind === "symbol") return grid.symbols.find((s) => s.id === target.id)?.codepoint ?? null;
  if (target.kind === "fidel") {
    const [family, order] = target.id.split("/");
    return grid.rows.find((r) => r.family === family)?.cells.find((c) => c.order === order)?.codepoint ?? null;
  }
  if (target.kind === "base") return grid.rows.find((r) => r.family === target.id)?.cells[0]?.codepoint ?? null;
  return null;
}

/** How dark a sketch pixel must be to be traced, 0 to 255. */
let traceThreshold = 128;

// ---------- Editor tabs ----------

/** Open drawings, each with its own line of text, as in Glyphs' edit tabs. */
interface EditorTab {
  target: DrawingTarget | null;
  text: string;
  title?: string;
}
const tabs: EditorTab[] = [{ target: null, text: "" }];
let currentTab = 0;
const tabBar = document.getElementById("editor-tabs")!;
const textInput = document.getElementById("text-line") as HTMLInputElement;

function tabLabel(t: EditorTab): string {
  if (t.text.trim()) return [...t.text.trim()].slice(0, 12).join("");
  if (!t.target) return "New tab";
  return charOf(t.target) ?? t.title ?? t.target.id.split("/")[0];
}

function renderTabs() {
  tabs[currentTab].target = editor.target;
  tabs[currentTab].text = editor.textLine;
  tabs[currentTab].title = editor.drawing?.title;
  const chips = tabs.map((t, i) => {
    const chip = el("button", { class: `editor-tab${i === currentTab ? " active" : ""}`, role: "tab", "aria-selected": String(i === currentTab), title: "Ctrl T new tab, Ctrl W close" }, tabLabel(t));
    chip.addEventListener("click", () => switchTab(i));
    if (tabs.length > 1) {
      const x = el("span", { class: "editor-tab-close", role: "button", "aria-label": "Close tab", title: "Close (Ctrl W)" }, "×");
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTab(i);
      });
      chip.append(x);
    }
    return chip;
  });
  const add = el("button", { class: "editor-tab add", title: "New tab (Ctrl T)", "aria-label": "New tab" }, "+");
  add.addEventListener("click", () => newTab());
  tabBar.replaceChildren(...chips, add);
}

function switchTab(i: number) {
  if (i === currentTab || !tabs[i]) return;
  tabs[currentTab].target = editor.target;
  tabs[currentTab].text = editor.textLine;
  currentTab = i;
  const t = tabs[i];
  textInput.value = t.text;
  editor.setText(t.text);
  if (t.target) void openDrawing(t.target);
  renderTabs();
}

function newTab() {
  tabs[currentTab].target = editor.target;
  tabs[currentTab].text = editor.textLine;
  tabs.push({ target: editor.target, text: editor.textLine });
  currentTab = tabs.length - 1;
  renderTabs();
  textInput.focus();
  textInput.select();
}

function closeTab(i: number) {
  if (tabs.length < 2) return;
  tabs.splice(i, 1);
  const next = Math.min(i === currentTab ? i : currentTab > i ? currentTab - 1 : currentTab, tabs.length - 1);
  currentTab = -1;
  switchTab(next);
}

textInput.addEventListener("input", () => {
  editor.setText(textInput.value);
  // Typing a line while nothing in it is open: open its first glyph.
  if (editor.textIndex < 0) {
    for (const ch of textInput.value) {
      const g = glyphIndex().get(ch);
      if (g) {
        void openDrawing(g.target);
        break;
      }
    }
  }
  renderTabs();
});
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === "Escape") textInput.blur();
});
window.addEventListener("keydown", (e) => {
  if (state.view !== "editor" || !(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "t") {
    e.preventDefault();
    newTab();
  } else if (k === "w" && tabs.length > 1) {
    e.preventDefault();
    closeTab(currentTab);
  }
});
onRefresh((ed) => renderEditorSide(ed));
bindViewMenu(ui.editorView);

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
    renderTabs();
    if (target.kind === "base") side.open.add(target.id);
    markSidebar();
  } catch (err) {
    toast(`Could not open the drawing: ${err}`, "error");
  }
}

function fillDrawingSelect() {
  const bases = el("optgroup", { label: "Bases" });
  for (const row of baseRows()) {
    bases.append(el("option", { value: `base:${row.base}` }, `${row.cells[0]?.codepoint ?? ""}  ${row.name}`));
  }
  const alts = el("optgroup", { label: "Alterations" });
  for (const a of state.alterations.filter((a) => a.drawable)) {
    alts.append(el("option", { value: `alteration:${a.id}` }, `${a.name}${a.drawn ? "" : " (not drawn)"}`));
  }
  const groups = [bases, alts];
  if (state.components.length) {
    const comps = el("optgroup", { label: "Components" });
    for (const c of state.components) comps.append(el("option", { value: `component:${c.id}` }, `${c.name}${c.drawn ? "" : " (not drawn)"}`));
    groups.push(comps);
  }
  if (state.grid?.symbols.length) {
    const syms = el("optgroup", { label: "Symbols" });
    for (const s of state.grid.symbols) syms.append(el("option", { value: `symbol:${s.id}` }, `${s.codepoint}  ${s.name}`));
    groups.push(syms);
  }
  ui.drawingSelect.replaceChildren(...groups);
  if (editor.target) ui.drawingSelect.value = editor.targetKey;
}

ui.drawingSelect.addEventListener("change", () => {
  const [kind, ...rest] = ui.drawingSelect.value.split(":");
  void openDrawing({ kind: kind as DrawingKind, id: rest.join(":") });
});

let sideTimer: number | undefined;
function scheduleSideRefresh() {
  clearTimeout(sideTimer);
  sideTimer = window.setTimeout(async () => {
    await loadParts();
    state.grid = await api.fidelGrid();
    fillDrawingSelect();
    redrawLine();
    if (state.view === "editor") renderEditorSide(editor);
  }, 120);
}

let previewToken = 0;

/** The editor's panel for a fidel: its form, and what it is built from. */
function fidelFormSection(fd: FidelDetail, ed: GlyphEditor): Node[] {
  const reopen = async () => {
    if (ed.drawing) await editor.open(ed.drawing.target);
    await refreshGrid();
    void refreshProjectInfo();
  };
  const parts = el("div", { class: "button-row" });
  if (fd.baseGlyph) {
    const b = el(
      "button",
      { class: "pill small ghost", title: `Edit the base. Every ${fd.familyName} fidel follows it.` },
      el("span", { lang: "gez" }, fd.baseGlyph),
      " Base",
    );
    b.addEventListener("click", () => void openDrawing({ kind: "base", id: baseOf(fd.family) }));
    parts.append(b);
  }
  for (const step of fd.recipe) {
    if (!state.alterations.find((a) => a.id === step.id)?.drawable) continue;
    const b = el(
      "button",
      {
        class: `pill small ghost${step.drawn ? "" : " undrawn"}`,
        title: `${step.drawn ? "Edit" : "Draw"} this mark. Every fidel that uses it follows.`,
      },
      step.name,
    );
    b.addEventListener("click", () => {
      state.contextFamily = fd.family;
      void openDrawing({ kind: "alteration", id: step.id });
    });
    parts.append(b);
  }
  return [
    formPicker(fd, () => void reopen()),
    ...(fd.drawnByHand || !parts.childElementCount
      ? []
      : [el("h3", { class: "section-label", title: "Edit a part to change every fidel that uses it" }, "Built from"), parts]),
  ];
}

function renderEditorSide(ed: GlyphEditor) {
  if (state.view !== "editor" || !ed.drawing) return;
  renderSidebar();
  const d = ed.drawing;
  const metrics = d.metrics;
  const sections: Node[] = [];

  // Live preview: the drawing inside the system.
  const strip = el("div", { class: "system-strip" });
  const previewTitle =
    d.target.kind === "base" ? "The family, live" : `Everywhere it lands (${orderNamesOf(d.target.id)})`;
  const standalone = d.target.kind === "symbol" || d.target.kind === "fidel" || d.target.kind === "component";
  if (!standalone) sections.push(el("h3", { class: "section-label first" }, previewTitle), strip);
  const token = ++previewToken;
  if (standalone) {
    // A symbol or a hand-drawn fidel stands alone: nothing else follows it.
  } else if (d.target.kind === "base") {
    void api.familyPreview(d.target.id).then((list) => {
      if (token === previewToken) strip.replaceChildren(...list.map((p) => previewCell(p, metrics)));
    });
  } else {
    strip.classList.add("many");
    const alt = state.alterations.find((a) => a.id === d.target.id);
    const scopeBox = el("div", { class: "scope-box" });
    void api.alterationImpacts(d.target.id).then((impacts) => {
      if (token !== previewToken) return;
      strip.replaceChildren(...impacts.map((i) => impactCell(i, d.target, d.context?.family, metrics)));
      renderScope(scopeBox, impacts, alt, d.context?.family);
    });
    sections.push(el("h3", { class: "section-label" }, "Where this applies"), scopeBox);
    if (d.context) {
      const ctx = d.context;
      const moved = ed.origin.x !== ctx.autoOrigin.x || ed.origin.y !== ctx.autoOrigin.y;
      const reset = el("button", { class: "pill small ghost", title: "Back to the automatic point (or double-click the point)" }, "Reset");
      reset.disabled = !moved;
      reset.addEventListener("click", () => ed.resetAttach());
      sections.push(
        el("h3", { class: "section-label", title: `Moves this mark on every ${ctx.familyName} fidel` }, `Attach point · ${ctx.familyName}`),
        el(
          "div",
          { class: "field-row" },
          numberField("X", ed.origin.x, (v) => ed.setAttachOrigin(v, ed.origin.y)),
          numberField("Y", ed.origin.y, (v) => ed.setAttachOrigin(ed.origin.x, v)),
          reset,
        ),
      );
    }
  }

  if (d.target.kind === "base") {
    const fam = baseRows().find((r) => r.base === d.target.id)?.family ?? d.target.id;
    sections.push(...orderRulesSection(fam, state.alterations, d.zones ?? [], () => scheduleSideRefresh()));
  }

  if (d.target.kind === "fidel") {
    const [family, order] = d.target.id.split("/");
    const formBox = el("div", { class: "side-box" });
    sections.push(formBox);
    void api.fidelDetail(family, order).then((fd) => {
      if (token !== previewToken) return;
      formBox.replaceChildren(...fidelFormSection(fd, ed));
    });
  }

  // Selection.
  const sel = ed.selection.size;
  const selBox = el("div", { class: "side-box" });
  if (!sel) {
    selBox.append(el("p", { class: "side-note" }, `${ed.contours.length} contour${ed.contours.length === 1 ? "" : "s"}`));
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
      }
    }
    // Point type of the selected on-curve points.
    const nodes = ed.selectedNodes();
    if (nodes.length && ed.tool !== "select") {
      const types = new Set(nodes.map((n) => n.type));
      const only = types.size === 1 ? [...types][0] : null;
      const seg = el("div", { class: "segmented", role: "group", "aria-label": "Point type" });
      const typeBtn = (t: "corner" | "smooth" | "tangent", label: string, title: string) => {
        const b = el("button", { class: only === t ? "on" : "", title }, label);
        b.addEventListener("click", () => ed.setNodeType(t));
        seg.append(b);
      };
      typeBtn("corner", "Corner", "Handles move on their own (double-click a point to switch, Shift+C cycles)");
      typeBtn("smooth", "Smooth", "Handles stay in line; adds handles to a point without them");
      typeBtn("tangent", "Tangent", "Smooth between a straight segment and a curve");
      const retract = el("button", { class: "pill small ghost", title: "Remove the handles, so the segments next to the point go straight" }, "Retract");
      retract.disabled = !nodes.some((n) => n.handles);
      retract.addEventListener("click", () => ed.setNodeType("retract"));
      const row = el("div", { class: "button-row" }, seg, retract);
      const segs = ed.selectedSegments();
      if (segs.lines || segs.curves) {
        const toCurve = el("button", { class: "pill small ghost", title: "Give the segment between the selected points handles" }, "Make curve");
        toCurve.disabled = !segs.lines;
        toCurve.addEventListener("click", () => ed.setSegmentKind("curve"));
        const toLine = el("button", { class: "pill small ghost", title: "Straighten the segment between the selected points" }, "Make line");
        toLine.disabled = !segs.curves;
        toLine.addEventListener("click", () => ed.setSegmentKind("line"));
        row.append(toCurve, toLine);
      }
      selBox.append(el("h3", { class: "section-label" }, nodes.length === 1 ? "Point" : `${nodes.length} points`), row);
    }
    // Direction of the selected contours.
    const dirs = new Set(contours.map((ci) => isClockwise(ed.contours[ci])));
    const dirLabel = dirs.size > 1 ? "Mixed" : dirs.has(true) ? "↻ Clockwise" : "↺ Counter-clockwise";
    const reverse = el("button", { class: "pill small", title: "Reverse path direction (Ctrl+Shift+R)" }, "Reverse");
    reverse.addEventListener("click", () => ed.reverseDirection());
    const correct = el("button", { class: "pill small ghost", title: "Outer paths counter-clockwise, counters clockwise, for the whole drawing" }, "Correct all");
    correct.addEventListener("click", () => ed.correctDirection());
    selBox.append(
      el("h3", { class: "section-label", title: "Outer contours run counter-clockwise, counters clockwise" }, "Direction"),
      el("div", { class: "button-row" }, el("span", { class: "side-note" }, dirLabel), reverse, correct),
    );
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
  sections.push(...guideSection(ed));
  sections.push(el("h3", { class: "section-label" }, "Selection"), selBox);
  sections.push(...transformSection(ed));
  sections.push(...pathOpsSection(ed));
  sections.push(...shapeSection(ed));

  // Metrics: sidebearings and width, for bases and symbols.
  sections.push(...metricsSection(ed, `${metrics.pa_bottom}–${metrics.pa_top}`));
  if (d.target.kind === "base") sections.push(...componentsSection(ed, state.components, (kind) => void newComponent(kind)));
  sections.push(...issuesSection(ed));
  sections.push(...backgroundSection(ed));

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
    const lock = el("button", { class: `pill small ghost${sk.unlocked ? " on" : ""}`, title: sk.unlocked ? "Lock the sketch in place" : "Unlock to drag the sketch on the canvas" }, sk.unlocked ? "Lock" : "Unlock");
    lock.addEventListener("click", () => {
      ed.updateSketch({ unlocked: !sk.unlocked });
      renderEditorSide(ed);
    });
    const trace = el("button", { class: "pill small", title: "Turn the dark parts of the sketch into editable outlines" }, "Trace");
    trace.addEventListener("click", () => void ed.traceSketch(traceThreshold));
    sketchBox.append(
      remove,
      lock,
      trace,
      el(
        "div",
        { class: "field-row" },
        numberField("X", sk.x, (v) => ed.updateSketch({ x: v })),
        numberField("Y", sk.y, (v) => ed.updateSketch({ y: v })),
      ),
      rangeField("Opacity", sk.opacity, 0.05, 1, (v) => ed.updateSketch({ opacity: v })),
      rangeField("Size", sk.h / (metrics.pa_top - metrics.pa_bottom), 0.3, 2, (v) => ed.updateSketch({ scale: v })),
      rangeField("Trace threshold", traceThreshold / 255, 0.1, 0.95, (v) => (traceThreshold = Math.round(v * 255))),
    );
  }
  sections.push(el("h3", { class: "section-label", title: "Unlock it to drag it on the canvas. Kept for this session only." }, "Sketch"), sketchBox);

  ui.inspector.replaceChildren(el("div", { class: "inspector-body editor-side" }, ...sections));
}

function orderNamesOf(altId: string): string {
  const alt = state.alterations.find((a) => a.id === altId);
  const names = alt?.orders.map((o) => state.grid?.orders.find((h) => h.order === o)?.name ?? o) ?? [];
  return names.join(", ") || "unused";
}

const EFFECT_NOTE: Record<Effect, string> = {
  regenerates: "updates",
  "regenerates-keeping-nudges": "updates and keeps its nudges",
  untouched: "drawn by hand, stays as it is",
};

function impactCell(i: ImpactView, target: DrawingTarget, current: string | undefined, metrics: FidelGrid["metrics"]) {
  const outline = cellOutline(i.family, i.order);
  const b = el(
    "button",
    {
      class: `mini effect-${i.effect}${current === i.family ? " current" : ""}`,
      title: `${i.codepoint ?? ""} ${i.familyName}: ${EFFECT_NOTE[i.effect]}. Click to draw against it.`,
    },
    glyphView(outline, metrics, i.codepoint),
  );
  if (i.effect !== "regenerates") b.append(el("span", { class: "mini-issue", "aria-hidden": "true" }));
  b.addEventListener("click", () => {
    state.contextFamily = i.family;
    void editor.open(target, i.family);
  });
  return b;
}

/** "fidel" is its own plural. */
function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 || word === "fidel" ? "" : "s"}`;
}

/** Summary of what an edit reaches, and buttons to narrow it to a copy. */
function renderScope(box: HTMLElement, impacts: ImpactView[], alt: AlterationSummary | undefined, contextFamily?: string) {
  if (!alt) return;
  const count = (e: Effect) => impacts.filter((i) => i.effect === e).length;
  const parts = [`${count("regenerates")} update`];
  if (count("regenerates-keeping-nudges")) parts.push(`${count("regenerates-keeping-nudges")} keep their nudges`);
  if (count("untouched")) parts.push(`${count("untouched")} drawn by hand stay as they are`);
  const lead = alt.forkedFrom
    ? `This is a copy. Edits reach only ${plural(impacts.length, "fidel")}`
    : `Edits here reach ${plural(impacts.length, "fidel")}`;
  box.replaceChildren(el("p", { class: "side-note" }, `${lead}: ${parts.join(", ")}.`));

  const actions = el("div", { class: "scope-actions" });
  const fork = (label: string, scope: Scope) => {
    const b = el("button", { class: "toggle" }, label);
    b.addEventListener("click", () => void forkTo(alt, scope, contextFamily));
    actions.append(b);
  };
  const here = impacts.filter((i) => i.family === contextFamily);
  if (impacts.length > 1 && here.length === 1) {
    fork(`Only ${here[0].codepoint ?? here[0].familyName}`, { kind: "fidel", family: here[0].family, order: here[0].order });
  }
  if (here.length > 1 && here.length < impacts.length) {
    fork(`Only ${here[0].familyName} family`, { kind: "family", family: here[0].family });
  }
  const orders = [...new Set(impacts.map((i) => i.order))];
  if (orders.length > 1) {
    for (const o of orders) fork(`Only ${state.grid?.orders.find((h) => h.order === o)?.name ?? o} order`, { kind: "order", order: o });
  }
  if (actions.childElementCount) {
    box.append(actions);
  }
  if (alt.forkedFrom) {
    const shared = state.alterations.find((a) => a.id === alt.forkedFrom);
    const b = el("button", { class: "toggle" }, `Use the shared ${shared?.name ?? "alteration"} again`);
    b.title = "Drop this copy. Its fidel go back to the shared drawing and keep their nudges.";
    b.addEventListener("click", () => void rejoin(alt));
    box.append(el("div", { class: "scope-actions" }, b));
  }
}

async function forkTo(alt: AlterationSummary, scope: Scope, contextFamily?: string) {
  try {
    const id = await api.forkAlteration(alt.id, scope);
    void refreshProjectInfo();
    await loadParts();
    await refreshGrid();
    fillDrawingSelect();
    const copy = state.alterations.find((a) => a.id === id);
    state.contextFamily = scope.kind === "fidel" || scope.kind === "family" ? scope.family : contextFamily;
    await openDrawing({ kind: "alteration", id });
    toast(`Made “${copy?.name ?? id}”. Edits here no longer change the others.`);
  } catch (err) {
    toast(`Could not split it off: ${err}`, "error");
  }
}

async function rejoin(alt: AlterationSummary) {
  try {
    const shared = await api.rejoinAlteration(alt.id);
    void refreshProjectInfo();
    await loadParts();
    await refreshGrid();
    fillDrawingSelect();
    await openDrawing({ kind: "alteration", id: shared });
    toast(`Back on the shared drawing. “${alt.name}” was removed.`);
  } catch (err) {
    toast(`Could not rejoin: ${err}`, "error");
  }
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
  document.title = `${info.dirty ? "• " : ""}${info.name} · Hohe`;
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
  await loadParts();
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
    else void saveProject(action === "saveas" || e.shiftKey);
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

// ---------- Font export and live proof ----------

const FONT_FILTER = [{ name: "Font", extensions: ["ttf"] }];

async function exportFont() {
  const path = await saveDialog({ defaultPath: `${projectInfo.name}.ttf`, filters: FONT_FILTER });
  if (!path) return;
  try {
    const r = await api.exportFont(path);
    const left = r.skipped ? ` ${r.skipped} not drawn yet use the system font.` : "";
    toast(`Exported ${r.exported} fidel as “${r.familyName}”.${left}`);
  } catch (err) {
    toast(`Could not export: ${err}`, "error");
  }
}

document.getElementById("export-font")!.addEventListener("click", () => void exportFont());

// ---------- Character sets ----------

const charsetBtn = document.getElementById("charset-btn") as HTMLButtonElement;
const charsetMenu = document.getElementById("charset-menu")!;

function renderCharsetMenu() {
  const sets = state.grid?.charsets ?? [];
  const langs = state.grid?.languages ?? [];
  const onSets = sets.filter((s) => s.enabled);
  const onLangs = langs.filter((l) => l.enabled);
  const names = [...onLangs.map((l) => l.name), ...onSets.map((s) => s.name)];
  document.getElementById("charset-label")!.textContent =
    onSets.length === sets.length ? "Full Ethiopic" : names.length === 1 ? names[0] : `${names.length} sets`;
  const item = (name: string, count: number, enabled: boolean, title: string, toggle: () => void) => {
    const b = el(
      "button",
      { class: "menu-item check", role: "menuitemcheckbox", "aria-checked": String(enabled), title },
      el("span", { class: "check-box", "aria-hidden": "true" }),
      el("span", { class: "check-name" }, name),
      el("span", { class: "check-count" }, String(count)),
    );
    b.addEventListener("click", toggle);
    return b;
  };
  const setItem = (s: CharSetInfo) =>
    item(s.name, s.count, s.enabled, s.range, () => {
      const next = sets.filter((x) => (x.id === s.id ? !x.enabled : x.enabled)).map((x) => x.id);
      void applyCoverage(next, onLangs.map((l) => l.id));
    });
  const langItem = (l: LanguageInfo) =>
    item(l.name, l.count, l.enabled, `Everything ${l.name} is written with`, () => {
      const next = langs.filter((x) => (x.id === l.id ? !x.enabled : x.enabled)).map((x) => x.id);
      void applyCoverage(onSets.map((s) => s.id), next);
    });
  const group = (ids: CharSetId[]) => sets.filter((s) => ids.includes(s.id)).map(setItem);
  const all = el("button", { class: "menu-item" }, "Full Ethiopic");
  all.addEventListener("click", () => void applyCoverage(sets.map((s) => s.id), []));
  charsetMenu.replaceChildren(
    el("div", { class: "menu-label" }, "Languages"),
    ...langs.map(langItem),
    el("div", { class: "menu-label" }, "Ethiopic"),
    ...group(["geez", "ethiopic-letters", "ethiopic-labialized", "ethiopic-marks"]),
    el("div", { class: "menu-label" }, "Supplements"),
    ...group(["supplement", "extended", "extended-a", "extended-b"]),
    el("div", { class: "menu-sep", role: "separator" }),
    all,
  );
}

async function applyCoverage(sets: CharSetId[], languages: LanguageId[]) {
  if (!sets.length && !languages.length) return;
  try {
    const grid = await api.setCoverage(sets, languages);
    state.grid = grid;
    if (state.selected && !grid.rows.some((r) => r.family === state.selected!.family && r.cells.some((c) => c.order === state.selected!.order))) {
      state.selected = null;
      renderEmptyInspector();
    }
    if (state.selectedSymbol && !grid.symbols.some((s) => s.id === state.selectedSymbol)) {
      state.selectedSymbol = null;
      renderEmptyInspector();
    }
    ui.summary.textContent = gridSummary(grid);
    renderFilters(grid);
    renderGrid(grid);
    renderSidebar();
    renderCharsetMenu();
    fillDrawingSelect();
    await loadParts();
    void refreshProjectInfo();
    void refreshProof();
  } catch (err) {
    toast(`Could not change the character sets: ${err}`, "error");
  }
}

function toggleCharsetMenu(open = charsetMenu.hidden) {
  charsetMenu.hidden = !open;
  charsetBtn.setAttribute("aria-expanded", String(open));
  if (open) charsetMenu.querySelector<HTMLElement>(".menu-item")?.focus();
}

charsetBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleCharsetMenu();
});
charsetMenu.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => toggleCharsetMenu(false));
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !charsetMenu.hidden) toggleCharsetMenu(false);
});

function toggleSidebars() {
  document.body.classList.toggle("panels-hidden");
}

/** Tool tooltips show the keys each tool runs on now. */
function refreshToolTitles(): void {
  document.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) => {
    const keys = keysFor(`tool.${b.dataset.tool}`);
    if (!b.title || b.dataset.tool === "shape") return;
    const label = b.title.replace(/\s*\([^)]*\)/, "");
    const [name, ...rest] = label.split(":");
    const space = b.dataset.tool === "hand" ? (keys ? ", or hold Space" : " (hold Space)") : "";
    b.title = `${name}${keys ? ` (${showKeys(keys)}${space})` : space}${rest.length ? ":" + rest.join(":") : ""}`;
  });
}
refreshToolTitles();
onShortcuts(refreshToolTitles);

document.querySelectorAll<HTMLElement>("[data-menu]").forEach((b) =>
  b.addEventListener("click", () => {
    const m = b.dataset.menu;
    if (m === "export") void exportFont();
    else if (m === "view-grid") showView("grid");
    else if (m === "view-editor") showView("editor");
    else if (m === "toggle-left") toggleSidebars();
    else if (m === "shortcuts") showShortcuts();
    else if (m === "charsets") {
      showView("grid");
      setTimeout(() => toggleCharsetMenu(true), 0);
    }
  }),
);

window.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.closest("input, select, textarea") || t.isContentEditable)) return;
  if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
    e.preventDefault();
    toggleSidebars();
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "1" || e.key === "2")) {
    showView(e.key === "1" ? "grid" : "editor");
  }
});
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e") {
    e.preventDefault();
    void exportFont();
  }
});

// The proof line is set in a font built from the current drawings, falling
// back to the system Ethiopic font for fidel that are not drawn yet.
let proofFace: FontFace | null = null;
let proofSerial = 0;

async function refreshProof() {
  const input = document.getElementById("proof-input") as HTMLInputElement;
  const note = document.getElementById("proof-note")!;
  try {
    const bytes = await api.proofFont();
    if (proofFace) document.fonts.delete(proofFace);
    proofFace = null;
    if (!bytes.byteLength) {
      input.style.fontFamily = "";
      note.title = "System font until you draw";
      return;
    }
    const face = new FontFace(`Fidel Proof ${++proofSerial}`, bytes);
    await face.load();
    document.fonts.add(face);
    proofFace = face;
    input.style.fontFamily = `"${face.family}", var(--ethiopic)`;
    note.title = "Your drawings, the rest in the system font";
  } catch (err) {
    console.warn("Proof font failed", err);
  }
}

// ---------- Start ----------

async function main() {
  renderEmptyInspector();
  const label = ui.status.querySelector(".label")!;
  try {
    const info = await api.appInfo();
    await refreshProjectInfo();
    label.textContent = `Core ${info.coreVersion}`;
    document.getElementById("about-line")!.textContent = `Hohe ${info.appVersion} · Ethiopic font editor`;
    ui.status.classList.add("ok");
    ui.status.title = `${info.familyCount} families · ${info.alterationCount} alterations`;
    await loadParts();
    await refreshGrid();
    fillDrawingSelect();
    const row = state.grid?.rows[1];
    if (row) await select(row.family, row.cells[4].order);
    void checkForUpdate(ui.toasts, { confirmDiscard, toast });
  } catch (err) {
    label.textContent = "Core offline";
    ui.status.classList.add("error");
    ui.summary.textContent = "Run inside the desktop app (npm run tauri dev) to load the grid.";
    console.error(err);
  }
}

void main();
