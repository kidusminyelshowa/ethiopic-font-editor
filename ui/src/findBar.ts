// The grid's find bar: search, filters (saved as smart filters), grid or
// list view, and the colour, tags and note panel for the inspector.

import { api, type FidelGrid, type StateKind } from "./api";
import { el, glyphView } from "./dom";
import {
  EMPTY_ORGANIZE,
  MARK_COLORS,
  glyphItems,
  matchesQuery,
  matchesRules,
  ruleLabel,
  toggleRule,
  unicodeOf,
  type GlyphItem,
  type GlyphMark,
  type MarkColor,
  type OrganizeView,
} from "./organize";

export interface FindHooks {
  grid(): FidelGrid | null;
  /** The grid element the cells live in. */
  gridEl: HTMLElement;
  selectItem(item: GlyphItem): void;
  openItem(item: GlyphItem): void;
  /** The list view replaced or restored the grid: mark the selection again. */
  redrawn(): void;
  toast(message: string, tone?: "error" | "info"): void;
  /** The search or criteria changed. */
  changed(): void;
}

const STATE_NAMES: Record<StateKind, string> = { linked: "Linked", adjusted: "Adjusted", detached: "Drawn by hand" };
const COLOR_NAMES: Record<MarkColor, string> = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  gray: "Gray",
};

export const find = {
  query: "",
  rules: [] as string[],
  mode: "grid" as "grid" | "list",
  organize: EMPTY_ORGANIZE as OrganizeView,
};

let hooks: FindHooks;
let filterBtn: HTMLButtonElement;
let filterMenu: HTMLElement;
let search: HTMLInputElement;

export function initFind(h: FindHooks, bar: HTMLElement): void {
  hooks = h;
  search = el("input", {
    id: "grid-search",
    class: "grid-search",
    type: "search",
    placeholder: "Find",
    "aria-label": "Find glyphs",
    title: "A fidel, U+1200, a name, family, order, tag or note",
    spellcheck: "false",
  }) as HTMLInputElement;
  search.addEventListener("input", () => {
    find.query = search.value;
    applyFind();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      search.value = "";
      find.query = "";
      applyFind();
      e.stopPropagation();
    }
  });
  filterBtn = el(
    "button",
    { class: "stage-btn filter-btn", "aria-haspopup": "menu", "aria-expanded": "false", title: "Filter by state, colour, tag and more" },
    el("span", { class: "filter-btn-label" }, "Filter"),
  ) as HTMLButtonElement;
  filterMenu = el("div", { class: "menu filter-menu", role: "menu", "aria-label": "Filter", hidden: "" });
  filterBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFilterMenu();
  });
  filterMenu.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => toggleFilterMenu(false));
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !filterMenu.hidden) toggleFilterMenu(false);
    // Ctrl+F finds in the grid.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && hooks.gridEl.offsetParent) {
      e.preventDefault();
      search.focus();
      search.select();
    }
  });
  const mode = el("div", { class: "filters view-mode", role: "group", "aria-label": "Show as" });
  for (const m of ["grid", "list"] as const) {
    const b = el("button", { class: `filter${find.mode === m ? " active" : ""}`, "data-mode": m, "aria-pressed": String(find.mode === m) }, m === "grid" ? "Grid" : "List");
    b.addEventListener("click", () => {
      find.mode = m;
      mode.querySelectorAll<HTMLElement>(".filter").forEach((x) => {
        x.classList.toggle("active", x.dataset.mode === m);
        x.setAttribute("aria-pressed", String(x.dataset.mode === m));
      });
      redraw();
    });
    mode.append(b);
  }
  bar.prepend(search, el("div", { class: "menu-wrap filter-wrap" }, filterBtn, filterMenu), mode);
  void loadOrganize();
}

export async function loadOrganize(): Promise<void> {
  try {
    find.organize = await api.getOrganize();
  } catch {
    find.organize = EMPTY_ORGANIZE;
  }
  applyFind();
}

function toggleFilterMenu(open = filterMenu.hidden): void {
  filterMenu.hidden = !open;
  filterBtn.setAttribute("aria-expanded", String(open));
  if (open) renderFilterMenu();
}

export function setRules(rules: string[]): void {
  find.rules = rules;
  applyFind();
  if (!filterMenu.hidden) renderFilterMenu();
}

function renderFilterMenu(): void {
  const o = find.organize;
  const items = hooks.grid() ? glyphItems(hooks.grid()!) : [];
  const count = (rule: string) => items.filter((i) => matchesRules(i, [rule], o)).length;
  const check = (rule: string, label: string, extra?: Node) => {
    const on = find.rules.includes(rule);
    const b = el(
      "button",
      { class: "menu-item check", role: "menuitemcheckbox", "aria-checked": String(on) },
      el("span", { class: "check-box", "aria-hidden": "true" }),
      el("span", { class: "check-name" }, ...(extra ? [extra] : []), label),
      el("span", { class: "check-count" }, String(count(rule))),
    );
    b.addEventListener("click", () => setRules(toggleRule(find.rules, rule)));
    return b;
  };
  const nodes: Node[] = [];
  nodes.push(el("div", { class: "menu-label" }, "State"));
  for (const s of ["linked", "adjusted", "detached"] as const) nodes.push(check(`state:${s}`, STATE_NAMES[s], el("span", { class: `swatch swatch-${s}`, "aria-hidden": "true" })));
  nodes.push(el("div", { class: "menu-sep", role: "separator" }), el("div", { class: "menu-label" }, "Colour"));
  const swatches = el("div", { class: "mark-swatches", role: "group", "aria-label": "Colour" });
  for (const c of MARK_COLORS) {
    const on = find.rules.includes(`color:${c}`);
    const b = el("button", { class: `mark-swatch mark-${c}${on ? " on" : ""}`, "aria-pressed": String(on), "aria-label": COLOR_NAMES[c], title: `${COLOR_NAMES[c]} (${count(`color:${c}`)})` });
    b.addEventListener("click", () => setRules(toggleRule(find.rules, `color:${c}`)));
    swatches.append(b);
  }
  nodes.push(swatches);
  if (o.tags.length) {
    nodes.push(el("div", { class: "menu-sep", role: "separator" }), el("div", { class: "menu-label" }, "Tags"));
    for (const t of o.tags) nodes.push(check(`tag:${t}`, t));
  }
  nodes.push(el("div", { class: "menu-sep", role: "separator" }), el("div", { class: "menu-label" }, "Show"));
  for (const r of ["has:note", "has:background", "has:mark", "not:drawn"]) nodes.push(check(r, ruleLabel(r)));

  nodes.push(el("div", { class: "menu-sep", role: "separator" }), el("div", { class: "menu-label" }, "Smart filters"));
  for (const f of o.filters) {
    const active = f.query === find.query.trim() && sameRules(f.rules ?? [], find.rules);
    const b = el("button", { class: `menu-item smart-filter${active ? " active" : ""}`, role: "menuitem" }, el("span", { class: "check-name" }, f.name));
    b.addEventListener("click", () => {
      find.query = f.query ?? "";
      search.value = find.query;
      setRules([...(f.rules ?? [])]);
    });
    const del = el("button", { class: "smart-filter-del", "aria-label": `Delete ${f.name}`, title: "Delete" }, "×");
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      void saveFilters(o.filters.filter((x) => x !== f));
    });
    nodes.push(el("div", { class: "smart-filter-row" }, b, del));
  }
  const filtering = !!find.query.trim() || find.rules.length > 0;
  if (filtering) {
    const name = el("input", { class: "smart-filter-name", type: "text", placeholder: "Save as…", "aria-label": "Name of the smart filter", spellcheck: "false" }) as HTMLInputElement;
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && name.value.trim()) {
        const next = [...o.filters.filter((f) => f.name.toLowerCase() !== name.value.trim().toLowerCase()), { name: name.value.trim(), query: find.query.trim(), rules: [...find.rules] }];
        void saveFilters(next);
      }
    });
    nodes.push(el("div", { class: "smart-filter-save" }, name));
    const clear = el("button", { class: "menu-item", role: "menuitem" }, "Clear the filter");
    clear.addEventListener("click", () => {
      find.query = "";
      search.value = "";
      setRules([]);
    });
    nodes.push(el("div", { class: "menu-sep", role: "separator" }), clear);
  } else if (!o.filters.length) {
    nodes.push(el("div", { class: "menu-note" }, "Filter or search, then save it here."));
  }
  filterMenu.replaceChildren(...nodes);
}

const sameRules = (a: string[], b: string[]) => a.length === b.length && a.every((r) => b.includes(r));

async function saveFilters(filters: OrganizeView["filters"]): Promise<void> {
  try {
    find.organize = await api.setSmartFilters(filters);
    renderFilterMenu();
  } catch (err) {
    hooks.toast(`Could not save the filter: ${err}`, "error");
  }
}

/** The glyphs that pass the search and filter. */
export function visibleItems(): GlyphItem[] {
  const grid = hooks.grid();
  if (!grid) return [];
  return glyphItems(grid).filter((i) => matchesQuery(i, find.query, find.organize) && matchesRules(i, find.rules, find.organize));
}

/** Re-render the grid or list for the current mode. */
function redraw(): void {
  if (find.mode === "grid") hooks.redrawn();
  applyFind();
}

/** Show which glyphs match, and their colour marks, without rebuilding the grid. */
export function applyFind(): void {
  if (!hooks) return;
  const filtering = !!find.query.trim() || find.rules.length > 0;
  const n = find.rules.length + (find.query.trim() ? 1 : 0);
  filterBtn.querySelector(".filter-btn-label")!.textContent = find.rules.length ? `Filter · ${find.rules.length}` : "Filter";
  filterBtn.classList.toggle("active", find.rules.length > 0);
  hooks.gridEl.classList.toggle("filtering", filtering);
  if (find.mode === "list") {
    renderList();
    hooks.changed();
    return;
  }
  const keep = new Set(filtering ? visibleItems().map((i) => i.key) : []);
  const marks = find.organize.marks;
  hooks.gridEl.querySelectorAll<HTMLElement>(".cell").forEach((c) => {
    const key = c.dataset.symbol ? `symbol:${c.dataset.symbol}` : `fidel:${c.dataset.family}/${c.dataset.order}`;
    c.classList.toggle("no-match", filtering && !keep.has(key));
    const m = marks[key];
    if (m?.color) c.dataset.mark = m.color;
    else delete c.dataset.mark;
    c.classList.toggle("has-note", !!m?.note);
  });
  // Rows and sections with nothing left are hidden while filtering.
  hooks.gridEl.querySelectorAll<HTMLTableRowElement>("tbody tr:not(.section-row)").forEach((tr) => {
    tr.hidden = filtering && !tr.querySelector(".cell:not(.no-match)");
  });
  hooks.gridEl.querySelectorAll<HTMLTableRowElement>("tbody tr.section-row").forEach((tr) => {
    let next = tr.nextElementSibling as HTMLTableRowElement | null;
    let any = false;
    while (next && !next.classList.contains("section-row")) {
      if (!next.hidden) any = true;
      next = next.nextElementSibling as HTMLTableRowElement | null;
    }
    tr.hidden = filtering && !any;
  });
  const sym = hooks.gridEl.querySelector<HTMLElement>(".symbol-grid");
  if (sym) sym.hidden = filtering && !sym.querySelector(".cell:not(.no-match)");
  let empty = hooks.gridEl.querySelector<HTMLElement>(".find-empty");
  const none = filtering && keep.size === 0;
  if (none && !empty) {
    empty = el("p", { class: "find-empty subtle" }, "Nothing matches.");
    hooks.gridEl.append(empty);
  } else if (!none) empty?.remove();
  void n;
  hooks.changed();
}

/** The list view: one row per glyph, with what the grid does not show. */
function renderList(): void {
  const grid = hooks.grid();
  if (!grid) return;
  const items = visibleItems();
  const table = el("table", { class: "glyph-list" });
  const head = table.createTHead().insertRow();
  for (const h of ["", "Name", "Unicode", "Family", "Order", "State", "Width", "Tags", "Note"]) head.append(el("th", { scope: "col" }, h));
  const body = table.createTBody();
  for (const it of items) {
    const m: GlyphMark = find.organize.marks[it.key] ?? {};
    const tr = body.insertRow();
    tr.className = "list-row";
    tr.dataset.key = it.key;
    if (m.color) tr.dataset.mark = m.color;
    const outline = it.family
      ? grid.rows.find((r) => r.family === it.family)?.cells.find((c) => c.order === it.order)?.outline
      : grid.symbols.find((s) => `symbol:${s.id}` === it.key)?.outline;
    tr.append(
      el("td", { class: "list-glyph" }, el("span", { class: "list-mark", "aria-hidden": "true" }), el("span", { class: `list-preview${outline ? " drawn" : ""}`, lang: "gez" }, glyphView(outline, grid.metrics, it.char))),
      el("td", { class: "mono" }, it.glyphName),
      el("td", { class: "mono" }, unicodeOf(it.char)),
      el("td", {}, it.familyName),
      el("td", {}, it.orderName),
      el("td", {}, it.state ? el("span", { class: "list-state" }, el("span", { class: `swatch swatch-${it.state}`, "aria-hidden": "true" }), STATE_NAMES[it.state]) : "—"),
      el("td", { class: "num" }, it.width === null ? "—" : String(Math.round(it.width))),
      el("td", {}, ...(m.tags ?? []).map((t) => el("span", { class: "tag-chip" }, t))),
      el("td", { class: "list-note", title: m.note ?? "" }, m.note ?? ""),
    );
    tr.addEventListener("click", () => {
      hooks.gridEl.querySelectorAll(".list-row.selected").forEach((r) => r.classList.remove("selected"));
      tr.classList.add("selected");
      hooks.selectItem(it);
    });
    tr.addEventListener("dblclick", () => hooks.openItem(it));
  }
  const nodes: Node[] = [table];
  if (!items.length) nodes.push(el("p", { class: "find-empty subtle" }, "Nothing matches."));
  hooks.gridEl.replaceChildren(...nodes);
}

/** Colour, tags and note for a glyph, and a note for its family. */
export function markSection(key: string, family: { key: string; name: string } | null): Node[] {
  const mark = (k: string): GlyphMark => find.organize.marks[k] ?? {};
  const save = async (k: string, next: GlyphMark) => {
    try {
      find.organize = await api.setMark(k, next);
      applyFind();
    } catch (err) {
      hooks.toast(`Could not save: ${err}`, "error");
    }
  };
  const box = el("div", { class: "mark-box" });
  const render = () => {
    const m = mark(key);
    const swatches = el("div", { class: "mark-swatches", role: "radiogroup", "aria-label": "Colour" });
    for (const c of [null, ...MARK_COLORS] as (MarkColor | null)[]) {
      const on = (m.color ?? null) === c;
      const b = el("button", {
        class: `mark-swatch ${c ? `mark-${c}` : "mark-none"}${on ? " on" : ""}`,
        role: "radio",
        "aria-checked": String(on),
        "aria-label": c ? COLOR_NAMES[c] : "No colour",
        title: c ? COLOR_NAMES[c] : "No colour",
      });
      b.addEventListener("click", () => void save(key, { ...mark(key), color: c }).then(render));
      swatches.append(b);
    }
    const tags = el("div", { class: "tag-list" });
    for (const t of m.tags ?? []) {
      const x = el("button", { class: "tag-remove", "aria-label": `Remove ${t}`, title: "Remove" }, "×");
      x.addEventListener("click", () => void save(key, { ...mark(key), tags: (mark(key).tags ?? []).filter((y) => y !== t) }).then(render));
      tags.append(el("span", { class: "tag-chip" }, t, x));
    }
    const add = el("input", { class: "tag-input", type: "text", placeholder: "Add a tag", "aria-label": "Add a tag", list: "known-tags", spellcheck: "false" }) as HTMLInputElement;
    add.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && add.value.trim()) {
        void save(key, { ...mark(key), tags: [...(mark(key).tags ?? []), add.value.trim()] }).then(() => {
          render();
          box.querySelector<HTMLInputElement>(".tag-input")?.focus();
        });
      }
    });
    const known = el("datalist", { id: "known-tags" }, ...find.organize.tags.map((t) => el("option", { value: t })));
    tags.append(add, known);
    const note = (k: string, label: string) => {
      const ta = el("textarea", { class: "note-input", rows: "2", placeholder: label, "aria-label": label, spellcheck: "true" }) as HTMLTextAreaElement;
      ta.value = mark(k).note ?? "";
      ta.addEventListener("change", () => void save(k, { ...mark(k), note: ta.value }));
      return ta;
    };
    box.replaceChildren(swatches, tags, note(key, "Note"), ...(family ? [note(family.key, `Note on ${family.name}`)] : []));
  };
  render();
  return [el("h3", { class: "section-label" }, "Organize"), box];
}
