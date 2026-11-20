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

const STATE_LABEL: Record<StateKind, string> = {
  linked: "Linked",
  adjusted: "Adjusted",
  irregular: "Irregular",
  detached: "Detached",
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderGrid(grid: FidelGrid): HTMLTableElement {
  const table = el("table", { class: "fidel-grid" });
  const head = table.createTHead().insertRow();
  head.append(el("th", { scope: "col" }, "Family"));
  for (const o of grid.orders) {
    const th = el("th", { scope: "col" });
    th.append(el("span", { class: "order-num" }, String(o.number)), el("span", {}, o.name));
    head.append(th);
  }

  const body = table.createTBody();
  for (const row of grid.rows) {
    const tr = body.insertRow();
    const th = el("th", { scope: "row" });
    th.append(el("span", { class: "family-name" }, row.name));
    tr.append(th);
    for (const cell of row.cells) {
      const td = tr.insertCell();
      td.className = `cell state-${cell.state}`;
      const label = `${cell.codepoint ?? ""} ${row.name} ${cell.order}: ${STATE_LABEL[cell.state]}`;
      td.title = cell.note ? `${label}. ${cell.note}` : label;
      td.append(el("span", { class: "glyph", lang: "gez" }, cell.codepoint ?? ""));
      td.append(el("span", { class: `badge badge-${cell.badge}`, "aria-hidden": "true" }));
    }
  }
  return table;
}

async function main() {
  const status = document.getElementById("core-status")!;
  const gridHost = document.getElementById("grid")!;
  try {
    const info = await invoke<AppInfo>("app_info");
    status.textContent =
      `Rust core ${info.coreVersion} · ${info.familyCount} families · ${info.alterationCount} alterations`;
    status.classList.add("ok");
    gridHost.replaceChildren(renderGrid(await invoke<FidelGrid>("fidel_grid")));
  } catch (err) {
    status.textContent = "Core not reachable. Run inside the desktop app (npm run tauri dev).";
    status.classList.add("error");
    console.error(err);
  }
}

main();
