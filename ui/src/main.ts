import "@fontsource-variable/fraunces/opsz.css";
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/noto-serif-ethiopic/index.css";
import "./style.css";

import { invoke } from "@tauri-apps/api/core";

type StateKind = "linked" | "adjusted" | "irregular" | "detached";
type Badge = "none" | "dot" | "outlined" | "solid";

interface AppInfo {
  appVersion: string;
  coreVersion: string;
  familyCount: number;
  alterationCount: number;
}

interface OrderHeader {
  order: string;
  number: number;
  name: string;
}

interface GridCell {
  order: string;
  codepoint: string | null;
  state: StateKind;
  badge: Badge;
  note?: string;
}

interface GridRow {
  family: string;
  name: string;
  group: string | null;
  cells: GridCell[];
}

interface FidelGrid {
  orders: OrderHeader[];
  rows: GridRow[];
}

interface RecipeStep {
  id: string;
  name: string;
  drawn: boolean;
}

interface FidelDetail {
  family: string;
  familyName: string;
  baseGlyph: string | null;
  group: string | null;
  order: string;
  orderNumber: number;
  orderName: string;
  codepoint: string | null;
  state: StateKind;
  badge: Badge;
  note: string | null;
  recipe: RecipeStep[];
  nudgeCount: number;
}

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

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

function hex(c: string | null): string {
  if (!c) return "";
  return "U+" + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
}

const ui = {
  status: document.getElementById("core-status")!,
  summary: document.getElementById("grid-summary")!,
  filters: document.getElementById("filters")!,
  grid: document.getElementById("grid")!,
  inspector: document.getElementById("inspector")!,
};

let filter: StateKind | "all" = "all";
let selected: { family: string; order: string } | null = null;

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
    ...options.map((key) => {
      const label = key === "all" ? "All" : STATE_LABEL[key];
      const btn = el(
        "button",
        { class: `filter${filter === key ? " active" : ""}`, "data-state": key, "aria-pressed": String(filter === key) },
        el("span", { class: `swatch swatch-${key}`, "aria-hidden": "true" }),
        label,
        el("span", { class: "count" }, String(counts[key] ?? 0)),
      );
      btn.addEventListener("click", () => {
        filter = key;
        ui.grid.dataset.filter = key;
        renderFilters(grid);
      });
      return btn;
    }),
  );
  ui.grid.dataset.filter = filter;
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
          class: `cell state-${cell.state}`,
          "data-family": row.family,
          "data-order": cell.order,
          "data-state": cell.state,
          "aria-label": `${cell.codepoint ?? ""}, ${row.name}, ${cell.order}, ${STATE_LABEL[cell.state]}`,
          title: cell.note ? `${STATE_LABEL[cell.state]}: ${cell.note}` : STATE_LABEL[cell.state],
        },
        el("span", { class: "glyph", lang: "gez" }, cell.codepoint ?? ""),
        el("span", { class: `badge badge-${cell.badge}`, "aria-hidden": "true" }),
      );
      btn.addEventListener("click", () => select(row.family, cell.order));
      td.append(btn);
    }
  }
  ui.grid.replaceChildren(table);
}

function markSelected() {
  for (const node of ui.grid.querySelectorAll<HTMLElement>(".cell.selected")) node.classList.remove("selected");
  if (!selected) return;
  ui.grid
    .querySelector<HTMLElement>(`.cell[data-family="${selected.family}"][data-order="${selected.order}"]`)
    ?.classList.add("selected");
}

async function select(family: string, order: string) {
  selected = { family, order };
  markSelected();
  try {
    renderInspector(await invoke<FidelDetail>("fidel_detail", { family, order }));
  } catch (err) {
    ui.inspector.replaceChildren(el("p", { class: "subtle" }, String(err)));
  }
}

function renderInspector(d: FidelDetail) {
  const recipe = el("ul", { class: "recipe" });
  if (d.baseGlyph) {
    recipe.append(
      el(
        "li",
        { class: "chip recipe-step" },
        el("span", { class: "step-glyph", lang: "gez" }, d.baseGlyph),
        el("span", {}, `Base · ${d.familyName}`),
      ),
    );
  }
  for (const step of d.recipe) {
    recipe.append(
      el(
        "li",
        { class: `chip recipe-step${step.drawn ? "" : " undrawn"}` },
        el("span", { class: "step-plus", "aria-hidden": "true" }, "+"),
        el("span", {}, step.name),
        ...(step.drawn ? [] : [el("span", { class: "step-note" }, "not drawn")]),
      ),
    );
  }
  if (d.state === "detached") {
    recipe.append(el("li", { class: "chip recipe-step" }, "Hand-drawn outline"));
  }

  ui.inspector.replaceChildren(
    el(
      "div",
      { class: `preview preview-${d.state}` },
      el("span", { class: "preview-glyph", lang: "gez" }, d.codepoint ?? ""),
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
        el("button", { class: "pill pill-dark", disabled: "", title: "The glyph editor arrives with ETH-3" }, "Open in editor"),
        el("button", { class: "pill", disabled: "", title: "Arrives with ETH-6" }, "Detach"),
      ),
    ),
  );
}

function renderEmptyInspector() {
  ui.inspector.replaceChildren(
    el(
      "div",
      { class: "preview preview-empty" },
      el("span", { class: "preview-glyph", lang: "gez" }, "ሄ"),
    ),
    el(
      "div",
      { class: "inspector-body" },
      el("h2", { class: "display inspector-title" }, "Pick a fidel"),
      el("p", { class: "state-help" }, "Select any cell to see its order, state and the recipe that builds it."),
    ),
  );
}

async function main() {
  renderEmptyInspector();
  const label = ui.status.querySelector(".label")!;
  try {
    const info = await invoke<AppInfo>("app_info");
    label.textContent = `Core ${info.coreVersion}`;
    ui.status.classList.add("ok");
    ui.status.title = `${info.familyCount} families · ${info.alterationCount} alterations`;
    const grid = await invoke<FidelGrid>("fidel_grid");
    ui.summary.textContent = `${grid.rows.length} families · ${grid.orders.length} orders · Ge'ez`;
    renderFilters(grid);
    renderGrid(grid);
    const fifth = grid.rows[1]?.cells[4];
    if (fifth) await select(grid.rows[1].family, fifth.order);
  } catch (err) {
    label.textContent = "Core offline";
    ui.status.classList.add("error");
    ui.summary.textContent = "Run inside the desktop app (npm run tauri dev) to load the grid.";
    console.error(err);
  }
}

main();
