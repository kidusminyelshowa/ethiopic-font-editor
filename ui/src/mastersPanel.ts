// Masters, axes and instances: the font properties sections, the master
// switcher in the title bar, and the axis sliders of the proof.

import { api, type Axis, type DesignData, type InstanceInfo } from "./api";
import { el } from "./dom";
import { formatMap, instancesFromMasters, masterLabel, nextAxis, nextMasterLocation, parseMap, styleName, toDesign, toUser } from "./design";
import { showMenu, type MenuEntry } from "./editorSide";

export interface MastersHost {
  toast(message: string, tone?: "error" | "info"): void;
  /** After the master being edited changed: reload drawings everywhere. */
  afterSwitch(): Promise<void>;
  /** After any change: the proof and the project's saved state. */
  changed(): void;
  /** Open a drawing named like `base:ha` or `fidel:ha/kaib`. */
  openDrawing(key: string): void;
  exportVariable(): void;
  exportInstances(): void;
  /** Show the font properties, where the masters are. */
  showProperties(): void;
}

export let design: DesignData | null = null;
let host: MastersHost;
const listeners = new Set<() => void>();

/** Where the proof shows the font, in user units; null for the master being edited. */
export let proofLocation: Record<string, number> | null = null;

export function initMasters(h: MastersHost): void {
  host = h;
  const btn = document.getElementById("master-btn");
  btn?.addEventListener("click", () => {
    const r = btn.getBoundingClientRect();
    masterMenu({ x: r.left, y: r.bottom + 4 });
  });
}

export function onDesign(fn: () => void): void {
  listeners.add(fn);
}

export async function loadDesign(): Promise<void> {
  try {
    set(await api.getDesign());
  } catch {
    design = null;
  }
}

function set(d: DesignData) {
  design = d;
  if (proofLocation && !d.axes.length) proofLocation = null;
  renderMasterButton();
  for (const fn of listeners) fn();
}

async function change(run: () => Promise<DesignData>, switched = false): Promise<void> {
  try {
    set(await run());
    if (switched) await host.afterSwitch();
    host.changed();
  } catch (err) {
    host.toast(String(err), "error");
  }
}

export function switchMaster(index: number): Promise<void> {
  return change(() => api.switchMaster(index), true);
}

// ---------- Title bar ----------

function renderMasterButton() {
  const btn = document.getElementById("master-btn");
  if (!btn) return;
  const d = design;
  const many = !!d && d.masters.length > 1;
  btn.hidden = !many;
  if (many) {
    btn.textContent = masterLabel(d!, d!.masters[d!.active]);
    btn.title = "Master being edited";
  }
}

function masterMenu(at: { x: number; y: number }) {
  const d = design;
  if (!d) return;
  const entries: MenuEntry[] = [{ heading: "Edit master" }];
  d.masters.forEach((m, i) =>
    entries.push({ label: masterLabel(d, m) + (i === d.default ? " (default)" : ""), checked: i === d.active, run: () => void switchMaster(i) }),
  );
  entries.push("sep", { label: "Masters and axes…", run: () => host.showProperties() });
  showMenu(entries, at);
}

// ---------- Font properties ----------

const num = (label: string, value: number, set: (v: number) => void, title?: string) => {
  const input = el("input", { type: "number", value: String(Math.round(value * 1000) / 1000), step: "any", "aria-label": label }) as HTMLInputElement;
  input.addEventListener("change", () => {
    const v = Number(input.value);
    if (input.value.trim() !== "" && Number.isFinite(v)) set(v);
  });
  return el("label", { class: "field", ...(title ? { title } : {}) }, el("span", {}, label), input);
};

const text = (label: string, value: string, set: (v: string) => void, attrs: Record<string, string> = {}) => {
  const input = el("input", { type: "text", value, spellcheck: "false", "aria-label": label, ...attrs }) as HTMLInputElement;
  input.addEventListener("change", () => set(input.value.trim()));
  return el("label", { class: "field" }, el("span", {}, label), input);
};

const removeBtn = (title: string, run: () => void) => {
  const b = el("button", { class: "icon-btn ds-remove", title, "aria-label": title }, "×");
  b.addEventListener("click", run);
  return b;
};

const addBtn = (title: string, run: () => void) => {
  const b = el("button", { class: "icon-btn", title, "aria-label": title }, "+");
  b.addEventListener("click", run);
  return b;
};

const head = (label: string, title: string, ...extra: Node[]) =>
  el("div", { class: "section-label ds-head", title }, el("span", {}, label), ...extra);

/** The Axes, Masters and Instances sections of the font properties. */
export function designSections(): Node[] {
  const d = design;
  if (!d) return [];
  const out: Node[] = [];

  // Axes.
  out.push(
    head(
      "Axes",
      "What the masters vary along: weight, width, or your own",
      addBtn("Add an axis", () => void change(() => api.setAxis(null, nextAxis(d.axes)))),
    ),
  );
  for (const a of d.axes) {
    const save = (patch: Partial<Axis>) => void change(() => api.setAxis(a.tag, { ...a, ...patch }));
    const map = el("input", {
      type: "text",
      value: formatMap(a.map),
      placeholder: "None",
      spellcheck: "false",
      "aria-label": "Axis map",
    }) as HTMLInputElement;
    map.addEventListener("change", () => {
      const m = parseMap(map.value);
      if (m === null) {
        host.toast("Write the map as user>design pairs, like 400>400, 700>620", "error");
        map.value = formatMap(a.map);
      } else save({ map: m });
    });
    out.push(
      el(
        "div",
        { class: "ds-card" },
        el(
          "div",
          { class: "field-row ds-row" },
          text("Name", a.name, (v) => v && save({ name: v })),
          text("Tag", a.tag, (v) => v && save({ tag: v }), { maxlength: "4", class: "ds-tag" }),
          removeBtn("Remove the axis", () => void change(() => api.removeAxis(a.tag))),
        ),
        el(
          "div",
          { class: "field-grid three" },
          num("Min", a.min, (v) => save({ min: v })),
          num("Default", a.default, (v) => save({ default: v })),
          num("Max", a.max, (v) => save({ max: v })),
        ),
        el("label", { class: "field", title: "Makes the slider move evenly: user value > the value the masters sit at" }, el("span", {}, "Map"), map),
      ),
    );
  }

  // Masters.
  const addMaster = () => {
    const loc = nextMasterLocation(d);
    const userLoc = Object.fromEntries(d.axes.map((a) => [a.tag, toUser(a, loc[a.tag])]));
    void change(() => api.addMaster(styleName(d.axes, userLoc), loc));
  };
  out.push(head("Masters", "Each master is a full set of drawings; the font varies between them", addBtn("Add a master from the one being edited", addMaster)));
  if (d.masters.length < 2) {
    out.push(el("p", { class: "side-note" }, d.axes.length ? "One master. Add another to vary along the axes." : "One master. Add an axis, then a master to vary towards."));
  }
  d.masters.forEach((m, i) => {
    const active = i === d.active;
    const edit = el("button", { class: `pill small${active ? " on" : " ghost"}`, title: active ? "Being edited" : "Edit this master's drawings" }, active ? "Editing" : "Edit");
    (edit as HTMLButtonElement).disabled = active;
    edit.addEventListener("click", () => void switchMaster(i));
    const loc = { ...m.location };
    const save = (name = m.name) => void change(() => api.setMaster(i, name, loc));
    out.push(
      el(
        "div",
        { class: `ds-card${active ? " active" : ""}` },
        el(
          "div",
          { class: "field-row ds-row" },
          text("Name", m.name, (v) => save(v)),
          edit,
          removeBtn("Remove the master and its drawings", () => void change(() => api.removeMaster(i), active)),
        ),
        ...(d.axes.length
          ? [
              el(
                "div",
                { class: "field-grid three" },
                ...d.axes.map((a) =>
                  num(a.name, m.location[a.tag] ?? toDesign(a, a.default), (v) => {
                    loc[a.tag] = v;
                    save();
                  }, a.map?.length ? "In design units, after the axis map" : undefined),
                ),
              ),
            ]
          : []),
        ...(i === d.default ? [el("p", { class: "side-note" }, "Default master")] : []),
      ),
    );
  });
  if (d.problem) out.push(el("p", { class: "side-note ds-problem" }, d.problem));

  // Compatibility.
  if (d.incompatible.length) {
    out.push(head("Do not interpolate", "These drawings differ in points or contours between masters; they stay as in the default master"));
    const list = el("div", { class: "ds-incompat" });
    for (const x of d.incompatible.slice(0, 60)) {
      const row = el("button", { class: "tree-row ds-incompat-row", title: `Differs in ${x.masters.join(", ")}` }, el("span", { class: "tree-label" }, drawingLabel(x.drawing)), el("span", { class: "tree-meta" }, x.masters.join(", ")));
      row.addEventListener("click", () => host.openDrawing(x.drawing));
      list.append(row);
    }
    out.push(list);
  }

  // Instances.
  if (d.masters.length > 1) {
    const saveAll = (list: InstanceInfo[]) => void change(() => api.setInstances(list));
    const add = () => {
      const loc = Object.fromEntries(d.axes.map((a) => [a.tag, a.default]));
      saveAll([...d.instances, { name: styleName(d.axes, loc), location: loc, export: true }]);
    };
    const fromMasters = el("button", { class: "pill small ghost", title: "One instance at each master" }, "From masters");
    fromMasters.addEventListener("click", () => saveAll(instancesFromMasters(d)));
    out.push(head("Instances", "Named styles: in the variable font's menu, and each its own font when exported", addBtn("Add an instance", add)));
    d.instances.forEach((inst, i) => {
      const upd = (patch: Partial<InstanceInfo>) => saveAll(d.instances.map((x, j) => (j === i ? { ...x, ...patch } : x)));
      const exp = el("input", { type: "checkbox", "aria-label": "Export as its own font" }) as HTMLInputElement;
      exp.checked = inst.export;
      exp.addEventListener("change", () => upd({ export: exp.checked }));
      out.push(
        el(
          "div",
          { class: "ds-card" },
          el(
            "div",
            { class: "field-row ds-row" },
            text("Name", inst.name, (v) => v && upd({ name: v })),
            el("label", { class: "ds-check", title: "Export as its own font" }, exp, "Static"),
            removeBtn("Remove the instance", () => saveAll(d.instances.filter((_, j) => j !== i))),
          ),
          el(
            "div",
            { class: "field-grid three" },
            ...d.axes.map((a) => num(a.name, inst.location[a.tag] ?? a.default, (v) => upd({ location: { ...inst.location, [a.tag]: v } }))),
          ),
        ),
      );
    });
    const vf = el("button", { class: "pill small" }, "Export variable font…");
    vf.addEventListener("click", () => host.exportVariable());
    const st = el("button", { class: "pill small ghost" }, "Export instances…");
    (st as HTMLButtonElement).disabled = !d.instances.some((i) => i.export);
    st.addEventListener("click", () => host.exportInstances());
    out.push(el("div", { class: "button-row ds-actions" }, fromMasters, vf, st));
  }
  return out;
}

function drawingLabel(key: string): string {
  const [kind, id] = key.split(/:(.*)/s);
  const k = { base: "Base", alteration: "Alteration", symbol: "Symbol", component: "Component", fidel: "Fidel" }[kind] ?? kind;
  return `${k} ${id}`;
}

// ---------- Proof sliders ----------

/** Sliders for each axis in the proof; moving one shows the font there. */
export function proofAxes(onChange: () => void): HTMLElement {
  const box = el("div", { class: "proof-axes" });
  const render = () => {
    const d = design;
    box.replaceChildren();
    if (!d || d.masters.length < 2 || !d.axes.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const at = proofLocation ?? Object.fromEntries(d.axes.map((a) => [a.tag, toUser(a, d.masters[d.active].location[a.tag] ?? toDesign(a, a.default))]));
    for (const a of d.axes) {
      const span = a.max - a.min;
      const range = el("input", {
        type: "range",
        min: String(a.min - span * 0.25),
        max: String(a.max + span * 0.25),
        step: String(span / 200 || 1),
        value: String(at[a.tag] ?? a.default),
        "aria-label": a.name,
      }) as HTMLInputElement;
      const out = el("span", { class: "proof-value" }, String(Math.round(Number(range.value))));
      let timer: number | undefined;
      range.addEventListener("input", () => {
        proofLocation = { ...at, [a.tag]: Number(range.value) };
        Object.assign(at, proofLocation);
        const v = Number(range.value);
        out.textContent = String(Math.round(v));
        out.title = v < a.min || v > a.max ? "Past the masters: extrapolated" : "";
        window.clearTimeout(timer);
        timer = window.setTimeout(onChange, 120);
      });
      box.append(el("label", { class: "proof-range", title: `${a.name}: past the ends extrapolates` }, el("span", { class: "proof-range-label" }, a.tag), range, out));
    }
    const reset = el("button", { class: "proof-flag", title: "Back to the master being edited" }, "Master");
    reset.addEventListener("click", () => {
      proofLocation = null;
      render();
      onChange();
    });
    box.append(reset);
  };
  onDesign(render);
  render();
  return box;
}
