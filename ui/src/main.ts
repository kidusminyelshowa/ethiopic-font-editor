import "@fontsource-variable/fraunces/opsz.css";
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/noto-serif-ethiopic/index.css";
import "./style.css";
import "./shell.css";

import {
  api,
  PARTS,
  type AlterationSummary,
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
  type DrawingKind,
  type SymbolCell,
} from "./api";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { el, glyphView, hex } from "./dom";
import { GlyphEditor, PART_COLORS } from "./editor";
import { checkForUpdate } from "./updater";
import { setupChrome } from "./chrome";

setupChrome();
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
  /** A selected punctuation mark or numeral, by symbol id. */
  selectedSymbol: null as string | null,
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
  head.append(el("th", { scope: "col", class: "corner" }, "Family"));
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
        { scope: "row" },
        el(
          "span",
          { class: "family" },
          el("span", { class: "family-glyph", lang: "gez" }, base),
          el("span", { class: "family-name" }, row.name),
        ),
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
          title: cell.note ? `${STATE_LABEL[cell.state]}: ${cell.note}` : STATE_LABEL[cell.state],
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
  await openDrawing({ kind: "base", id: baseOf(family) });
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

function renderEmptyInspector() {
  ui.inspector.replaceChildren(
    el("div", { class: "preview preview-empty" }, el("span", { class: "preview-glyph", lang: "gez" }, "ሄ")),
    el(
      "div",
      { class: "inspector-body" },
      el("h2", { class: "display inspector-title muted" }, "No selection"),
    ),
  );
}

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
}) {
  const row = el(
    "button",
    {
      class: `tree-row depth-${opts.depth}${opts.dim ? " dim" : ""}`,
      role: "treeitem",
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
    el("span", { class: "tree-label" }, opts.label),
    el("span", { class: "tree-meta" }, opts.meta ?? ""),
    ...(opts.dot ? [el("span", { class: `badge badge-${opts.dot}`, "aria-hidden": "true" })] : []),
  );
  return row;
}

function renderSidebar() {
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
      const fam = treeRow({ depth: 0, glyph: base, label: r.name, meta: String(r.cells.length), twisty: true, expanded, data: { "data-fam": r.family } });
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
      const item = treeRow({ depth: 0, glyph: r.cells[0]?.codepoint ?? "", label: r.name, meta: "base", data: { "data-target": `base:${r.base}` } });
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
      else item.title = "Deforming alterations are not drawn; they reshape the base.";
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
    d.target.kind === "base" ? "The family, live" : `Everywhere it lands (${orderNamesOf(d.target.id)})`;
  if (d.target.kind !== "symbol") sections.push(el("h3", { class: "section-label first" }, previewTitle), strip);
  const token = ++previewToken;
  if (d.target.kind === "symbol") {
    // A symbol stands alone: nothing else is built from it.
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
    );
  }
  sections.push(el("h3", { class: "section-label", title: "Alt-drag on the canvas to move the sketch. Kept for this session only." }, "Sketch"), sketchBox);

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
    state.alterations = await api.listAlterations();
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
    state.alterations = await api.listAlterations();
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
  const on = sets.filter((s) => s.enabled);
  document.getElementById("charset-label")!.textContent =
    on.length === 1 ? on[0].name : on.length === sets.length ? "Full Ethiopic" : `${on.length} sets`;
  const item = (s: (typeof sets)[number]) => {
    const b = el(
      "button",
      {
        class: "menu-item check",
        role: "menuitemcheckbox",
        "aria-checked": String(s.enabled),
        title: s.range,
      },
      el("span", { class: "check-box", "aria-hidden": "true" }),
      el("span", { class: "check-name" }, s.name),
      el("span", { class: "check-count" }, String(s.count)),
    );
    b.addEventListener("click", () => void toggleCharset(s.id));
    return b;
  };
  const group = (label: string, ids: CharSetId[]) => [
    el("div", { class: "menu-label" }, label),
    ...sets.filter((s) => ids.includes(s.id)).map(item),
  ];
  const all = el("button", { class: "menu-item" }, "Full Ethiopic");
  all.addEventListener("click", () => void applyCharsets(sets.map((s) => s.id)));
  const geez = el("button", { class: "menu-item" }, "Ge'ez only");
  geez.addEventListener("click", () => void applyCharsets(["geez"]));
  charsetMenu.replaceChildren(
    ...group("Ethiopic", ["geez", "ethiopic-letters", "ethiopic-labialized", "ethiopic-marks"]),
    ...group("Supplements", ["supplement", "extended", "extended-a", "extended-b"]),
    el("div", { class: "menu-sep", role: "separator" }),
    all,
    geez,
  );
}

async function toggleCharset(id: CharSetId) {
  const sets = state.grid?.charsets ?? [];
  const next = sets.filter((s) => (s.id === id ? !s.enabled : s.enabled)).map((s) => s.id);
  if (!next.length) return;
  await applyCharsets(next);
}

async function applyCharsets(ids: CharSetId[]) {
  try {
    state.grid = await api.setCharsets(ids);
    if (state.selected && !state.grid.rows.some((r) => r.family === state.selected!.family && r.cells.some((c) => c.order === state.selected!.order))) {
      state.selected = null;
      renderEmptyInspector();
    }
    if (state.selectedSymbol && !state.grid.symbols.some((s) => s.id === state.selectedSymbol)) {
      state.selectedSymbol = null;
      renderEmptyInspector();
    }
    ui.summary.textContent = gridSummary(state.grid);
    renderFilters(state.grid);
    renderGrid(state.grid);
    renderSidebar();
    renderCharsetMenu();
    fillDrawingSelect();
    state.alterations = await api.listAlterations();
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

document.querySelectorAll<HTMLElement>("[data-menu]").forEach((b) =>
  b.addEventListener("click", () => {
    const m = b.dataset.menu;
    if (m === "export") void exportFont();
    else if (m === "view-grid") showView("grid");
    else if (m === "view-editor") showView("editor");
    else if (m === "toggle-left") toggleSidebars();
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
    ui.status.classList.add("ok");
    ui.status.title = `${info.familyCount} families · ${info.alterationCount} alterations`;
    state.alterations = await api.listAlterations();
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
