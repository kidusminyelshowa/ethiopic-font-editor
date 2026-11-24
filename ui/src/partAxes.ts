// Parametric parts: a leaf, cap or corner with axes of its own (a leaf's
// size), drawn in states and set per placement or tied to a font axis.

import { api, type PartAxis, type PartView } from "./api";
import { el } from "./dom";
import type { GlyphEditor } from "./editor";
import { numberField } from "./editorSide";

/** `leaf#2` is the second state of `leaf`. */
export function stateRef(id: string): { part: string; state: number | null } {
  const m = /^(.*)#(\d+)$/.exec(id);
  if (!m || Number(m[2]) < 1) return { part: id, state: null };
  return { part: m[1], state: Number(m[2]) - 1 };
}

export function stateId(part: string, state: number | null) {
  return state == null ? part : `${part}#${state + 1}`;
}

/** A new axis with a name not used yet. */
export function newAxis(existing: PartAxis[]): PartAxis {
  const names = new Set(existing.map((a) => a.name));
  let name = "Size";
  for (let n = 2; names.has(name); n++) name = `Size ${n}`;
  return { name, min: 0, default: 0, max: 100, follows: null };
}

const same = (a: Record<string, number>, b: Record<string, number>, axes: PartAxis[]) =>
  axes.every((x) => (a[x.name] ?? x.default) === (b[x.name] ?? x.default));

/** Where a new state goes: each axis's far end in turn, then the corner. */
export function nextStateLocation(axes: PartAxis[], taken: Record<string, number>[]): Record<string, number> {
  const options: Record<string, number>[] = [];
  for (const a of axes) {
    if (a.max > a.default) options.push({ [a.name]: a.max });
    if (a.min < a.default) options.push({ [a.name]: a.min });
  }
  if (axes.length > 1) options.push(Object.fromEntries(axes.map((a) => [a.name, a.max])));
  return options.find((o) => !taken.some((t) => same(o, t, axes))) ?? Object.fromEntries(axes.map((a) => [a.name, a.max]));
}

/** "Size 100", or "Size 100, Width 50". */
export function stateLabel(axes: PartAxis[], loc: Record<string, number>) {
  const parts = axes.filter((a) => (loc[a.name] ?? a.default) !== a.default).map((a) => `${a.name} ${loc[a.name]}`);
  return parts.join(", ") || "Default";
}

/** Sliders for a placement's settings; axes tied to the font say so. */
export function partValueFields(
  axes: PartAxis[],
  values: Record<string, number> | undefined,
  onChange: (values: Record<string, number>) => void,
): HTMLElement[] {
  return axes.map((a) => {
    if (a.follows) {
      return el("div", { class: "field static part-follow", title: `Set by the font's ${a.follows} axis` }, el("span", {}, a.name), el("strong", {}, `Follows ${a.follows}`));
    }
    const v = values?.[a.name] ?? a.default;
    const range = el("input", { type: "range", min: String(a.min), max: String(a.max), step: "any", value: String(v), "aria-label": a.name }) as HTMLInputElement;
    const out = el("span", { class: "part-value" }, String(Math.round(v)));
    range.addEventListener("input", () => (out.textContent = String(Math.round(Number(range.value)))));
    range.addEventListener("change", () => onChange({ ...(values ?? {}), [a.name]: Math.round(Number(range.value) * 10) / 10 }));
    return el("label", { class: "field range part-range" }, el("span", {}, a.name, out), range);
  });
}

export interface PartHost {
  open(id: string): void;
  /** The part's axes changed: placements elsewhere need the new list. */
  changed(): void;
}

/** For a component drawing: its axes and states. */
export function partSection(ed: GlyphEditor, openId: string, host: PartHost): Node[] {
  const { part, state: current } = stateRef(openId);
  const box = el("div", { class: "side-box part-box" });
  const fail = (err: unknown) => ed.notify(String(err), "error");
  const draw = (v: PartView) => {
    const change = (axes: PartAxis[]) =>
      api.setPartAxes(part, axes).then((next) => {
        draw(next);
        host.changed();
        ed.changedInCore();
      }, fail);
    const rows: Node[] = [];
    v.axes.forEach((a, i) => {
      const set = (patch: Partial<PartAxis>) => void change(v.axes.map((x, j) => (j === i ? { ...x, ...patch } : x)));
      const name = el("input", { type: "text", value: a.name, spellcheck: "false", "aria-label": "Axis name", class: "part-axis-name" }) as HTMLInputElement;
      name.addEventListener("change", () => {
        if (name.value.trim()) set({ name: name.value.trim() });
        else name.value = a.name;
      });
      const follows = el("select", { class: "zone-select", "aria-label": "Follows", title: "Tie it to a font axis, or set it by hand on each placement" }) as HTMLSelectElement;
      follows.append(el("option", { value: "" }, "Set by hand"));
      for (const [tag, label] of v.fontAxes) {
        const o = el("option", { value: tag }, `Follows ${label}`) as HTMLOptionElement;
        o.selected = a.follows === tag;
        follows.append(o);
      }
      follows.addEventListener("change", () => set({ follows: follows.value || null }));
      const remove = el("button", { class: "icon-btn ds-remove", title: "Remove this axis", "aria-label": "Remove this axis" }, "×");
      remove.addEventListener("click", () => void change(v.axes.filter((_, j) => j !== i)));
      rows.push(
        el(
          "div",
          { class: "part-axis" },
          el("div", { class: "ds-row" }, name, remove),
          el(
            "div",
            { class: "field-row three" },
            numberField("Min", a.min, (x) => set({ min: x })),
            numberField("Default", a.default, (x) => set({ default: x }), "The main drawing sits here"),
            numberField("Max", a.max, (x) => set({ max: x })),
          ),
          ...(v.fontAxes.length ? [follows] : []),
        ),
      );
    });
    const addAxis = el("button", { class: "pill small ghost", title: "A way this part varies, such as its size" }, v.axes.length ? "Add axis" : "Add an axis");
    addAxis.addEventListener("click", () => void change([...v.axes, newAxis(v.axes)]));
    rows.push(el("div", { class: "button-row" }, addAxis));

    if (v.axes.length) {
      rows.push(el("div", { class: "menu-label rule-label", title: "The part drawn at other settings. Each must match the default point for point." }, "States"));
      const chip = (label: string, idx: number | null, problem: string | null) => {
        const on = idx === current;
        const b = el("button", { class: `placement-head${on ? " on" : ""}${problem ? " warn" : ""}`, title: problem ?? (on ? "Being edited" : "Edit this state") }, label);
        b.addEventListener("click", () => {
          if (!on) host.open(stateId(part, idx));
        });
        return b;
      };
      rows.push(el("div", { class: "placement" }, chip("Default", null, null)));
      v.states.forEach((s, i) => {
        const row = el("div", { class: `placement${i === current ? " selected" : ""}` }, chip(`State ${i + 1} · ${stateLabel(v.axes, s.location)}`, i, s.problem));
        const remove = el("button", { class: "pill small ghost" }, "Remove");
        remove.addEventListener("click", () => {
          api.removePartState(part, i).then((next) => {
            if (current != null && current >= i) host.open(stateId(part, current > i ? current - 1 : null));
            else draw(next);
            ed.changedInCore();
          }, fail);
        });
        if (i === current) {
          row.append(
            el(
              "div",
              { class: "field-row" },
              ...v.axes.map((a) =>
                numberField(a.name, s.location[a.name] ?? a.default, (x) => {
                  api.setPartState(part, i, { ...s.location, [a.name]: x }).then((next) => {
                    draw(next);
                    ed.changedInCore();
                  }, fail);
                }),
              ),
            ),
          );
          if (s.problem) row.append(el("p", { class: "side-note warn" }, `Left out: ${s.problem}.`));
          row.append(el("div", { class: "button-row" }, remove));
        }
        rows.push(row);
      });
      const addState = el("button", { class: "pill small ghost", title: "Starts as a copy of the default drawing" }, "Add state");
      addState.addEventListener("click", () => {
        const loc = nextStateLocation(v.axes, v.states.map((s) => s.location));
        api.addPartState(part, loc).then((next) => host.open(stateId(part, next.states.length - 1)), fail);
      });
      rows.push(el("div", { class: "button-row" }, addState));
    }
    box.replaceChildren(...rows);
  };
  api.getPart(part).then(draw, fail);
  return [el("h3", { class: "section-label", title: "Ways this part varies inside one master, set on each placement or tied to a font axis" }, "Part axes"), box];
}
