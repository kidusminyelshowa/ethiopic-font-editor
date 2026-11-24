// Side panel sections for the order system: which variant of each order rule
// a family uses, where its deforms land, and the components placed on a base.

import { api, type AlterationSummary, type ComponentKind, type ComponentRef, type ComponentSummary, type Zone } from "./api";
import { el } from "./dom";
import type { GlyphEditor } from "./editor";
import { contoursBounds } from "./geometry";
import { iconButton, numberField } from "./editorSide";

const ORDERS = ["giiz", "kaib", "salis", "rabi", "hamis", "sadis", "sabi"];

/** An amount field that can be left empty for "automatic". */
function optionalField(label: string, value: number | null | undefined, onChange: (v: number | null) => void, title: string) {
  const input = el("input", {
    type: "text",
    inputmode: "decimal",
    value: value == null ? "" : String(value),
    placeholder: "Auto",
    "aria-label": label,
  }) as HTMLInputElement;
  input.addEventListener("keydown", (e) => e.stopPropagation());
  input.addEventListener("change", () => {
    const t = input.value.trim();
    if (!t) return onChange(null);
    const v = Number(t);
    if (Number.isFinite(v)) onChange(v);
    else input.value = value == null ? "" : String(value);
  });
  return el("label", { class: "field", title }, el("span", {}, label), input);
}

/**
 * For a base: the order rules with more than one variant (Hornus: ራብዕ shortens
 * the left leg or stretches the stem; ሳብዕ adds a loop or shortens the right
 * leg), and the settings of the deforms this family uses. Variants are per
 * family; deform settings are shared by every family that uses the deform.
 */
export function orderRulesSection(
  family: string,
  alterations: AlterationSummary[],
  zones: Zone[],
  changed: () => void,
): Node[] {
  const box = el("div", { class: "side-box rules-box" }, el("p", { class: "side-note" }, "Loading…"));
  void Promise.all(ORDERS.map((o) => api.fidelDetail(family, o).catch(() => null))).then((details) => {
    const rows: Node[] = [];
    const deforms = new Map<string, AlterationSummary>();
    for (const d of details) {
      if (!d) continue;
      for (const step of d.recipe) {
        const alt = alterations.find((a) => a.id === step.id);
        if (alt && !alt.drawable) deforms.set(alt.id, alt);
      }
      if (d.variants.length < 2) continue;
      const pick = el("div", { class: "variant-pick", role: "radiogroup", "aria-label": `${d.orderName} variant` });
      for (const v of d.variants) {
        const b = el(
          "button",
          { class: `variant${v.index === d.variant ? " on" : ""}`, role: "radio", "aria-checked": String(v.index === d.variant) },
          v.label || "Nothing added",
        );
        b.addEventListener("click", async () => {
          if (v.index === d.variant) return;
          await api.setRuleVariant(family, d.order, v.index);
          changed();
        });
        pick.append(b);
      }
      rows.push(
        el(
          "div",
          { class: "variant-row" },
          el("span", { class: "variant-order", lang: "gez", title: `${d.orderName}: ${d.codepoint ?? ""}` }, `${d.codepoint ?? ""} ${d.orderName}`),
          pick,
        ),
      );
    }
    for (const alt of deforms.values()) {
      const zone = el("select", { class: "zone-select", "aria-label": "Zone" }) as HTMLSelectElement;
      zone.append(el("option", { value: "" }, "Automatic"));
      for (const z of zones) {
        const o = el("option", { value: z.id }, `${z.name} · ${Math.round(z.position)}`) as HTMLOptionElement;
        o.selected = alt.zone === z.id;
        zone.append(o);
      }
      const save = async (zoneId: string | null, amount: number | null) => {
        await api.setDeform(alt.id, zoneId, amount);
        changed();
      };
      zone.addEventListener("change", () => void save(zone.value || null, alt.amount ?? null));
      const showsAmount = alt.verb !== "shorten";
      rows.push(
        el(
          "div",
          { class: "deform-row", title: `Shared by every family that uses it (${alt.users} fidel)` },
          el("span", { class: "deform-name" }, alt.name),
          el(
            "div",
            { class: "field-row" },
            el("label", { class: "field" }, el("span", {}, "Zone"), zone),
            ...(showsAmount
              ? [
                  optionalField(
                    alt.verb === "lengthen" ? "Adds" : "Throw",
                    alt.amount,
                    (v) => void save(alt.zone ?? null, v),
                    alt.verb === "lengthen" ? "How much longer the stroke gets" : "How far the foot moves sideways",
                  ),
                ]
              : []),
          ),
        ),
      );
    }
    if (!rows.length) rows.push(el("p", { class: "side-note" }, "Every order of this family follows one rule."));
    box.replaceChildren(...rows);
  });
  return [el("h3", { class: "section-label", title: "Which variant of each order this family uses" }, "Orders"), box];
}

/** For a base: the leaves, caps and corners placed on it. */
export function componentsSection(
  ed: GlyphEditor,
  components: ComponentSummary[],
  create: (kind: ComponentKind) => void,
): Node[] {
  const placed = ed.drawing?.components ?? [];
  const box = el("div", { class: "side-box" });
  const refs = () => ed.placements.map((r) => ({ ...r, at: { ...r.at } }));
  const update = (id: number, change: (r: ComponentRef) => void) => {
    const next = refs();
    const r = next.find((r) => r.id === id);
    if (!r) return;
    change(r);
    void ed.setPlacements(next);
  };

  const place = el("select", { class: "zone-select", "aria-label": "Place a component" }) as HTMLSelectElement;
  place.append(el("option", { value: "" }, "Place…"));
  if (components.length) {
    const group = el("optgroup", { label: "Place" });
    for (const c of components) group.append(el("option", { value: c.id }, `${c.name}${c.drawn ? "" : " (not drawn)"}`));
    place.append(group);
  }
  const fresh = el("optgroup", { label: "Draw a new one" });
  for (const kind of ["leaf", "cap", "corner"] as const) {
    fresh.append(el("option", { value: `new:${kind}` }, `New ${kind}`));
  }
  place.append(fresh);
  place.addEventListener("change", () => {
    const comp = place.value;
    if (!comp) return;
    if (comp.startsWith("new:")) return create(comp.slice(4) as ComponentKind);
    // At the bottom middle of the selected path, which it then sits on; or
    // in the middle of the advance.
    const sel = ed.selectedContours();
    const b = contoursBounds(sel.map((ci) => ed.contours[ci]));
    const at = b ? { x: Math.round((b.minX + b.maxX) / 2), y: Math.round(b.minY) } : { x: Math.round((ed.drawing?.advanceWidth ?? 0) / 2), y: 0 };
    const id = Math.max(-1, ...ed.placements.map((r) => r.id)) + 1;
    const on = sel.length ? ed.contours[sel[0]].id : null;
    ed.placementSel = id;
    void ed.setPlacements([...refs(), { id, component: comp, at, on }]);
  });
  box.append(place);

  for (const pc of placed) {
    const r = pc.placement;
    const selected = ed.placementSel === r.id;
    const head = el("button", { class: `placement-head${selected ? " on" : ""}` }, pc.name);
    head.addEventListener("click", () => {
      ed.placementSel = selected ? null : r.id;
      ed.render();
      ed.refreshSide();
    });
    const row = el("div", { class: `placement${selected ? " selected" : ""}` }, head);
    if (selected) {
      const on = el("select", { class: "zone-select", "aria-label": "Sits on" }) as HTMLSelectElement;
      on.append(el("option", { value: "" }, "Free"));
      for (const c of ed.contours) {
        const o = el("option", { value: String(c.id) }, c.name ?? (c.part ? c.part[0].toUpperCase() + c.part.slice(1) : `Path ${c.id}`)) as HTMLOptionElement;
        o.selected = r.on === c.id;
        on.append(o);
      }
      on.addEventListener("change", () => update(r.id, (x) => (x.on = on.value === "" ? null : Number(on.value))));
      const remove = el("button", { class: "pill small ghost" }, "Remove");
      remove.addEventListener("click", () => void ed.setPlacements(refs().filter((x) => x.id !== r.id)));
      const decompose = el("button", { class: "pill small ghost", title: "Turn it into plain paths on this base" }, "Decompose");
      decompose.addEventListener("click", () => void ed.decompose(r.id));
      const edit = el("button", { class: "pill small ghost", title: "Open it with this base behind it (or double-click it)" }, "Edit in place");
      edit.addEventListener("click", () => void ed.editComponentInPlace(r.id));
      // Swap for another component, keeping where and how it sits.
      const swap = el("select", { class: "zone-select", "aria-label": "Component" }) as HTMLSelectElement;
      for (const c of components) {
        const o = el("option", { value: c.id }, c.name) as HTMLOptionElement;
        o.selected = c.id === r.component;
        swap.append(o);
      }
      swap.addEventListener("change", () => update(r.id, (x) => (x.component = swap.value)));
      row.append(
        el(
          "div",
          { class: "field-row" },
          numberField("X", r.at.x, (v) => update(r.id, (x) => (x.at.x = v))),
          numberField("Y", r.at.y, (v) => update(r.id, (x) => (x.at.y = v))),
        ),
        el(
          "div",
          { class: "field-row" },
          numberField("Scale %", Math.round((r.scale ?? 1) * 1000) / 10, (v) => update(r.id, (x) => (x.scale = v / 100))),
          numberField("Rotate °", r.rotate ?? 0, (v) => update(r.id, (x) => (x.rotate = v))),
        ),
        el(
          "div",
          { class: "button-row" },
          iconButton("flipH", "Flip horizontally", () => update(r.id, (x) => (x.flip_x = !x.flip_x)), `icon-btn${r.flip_x ? " on" : ""}`),
          iconButton("flipV", "Flip vertically", () => update(r.id, (x) => (x.flip_y = !x.flip_y)), `icon-btn${r.flip_y ? " on" : ""}`),
          el("label", { class: "field grow", title: "The path it sits on: a shortened leg or crick carries it along" }, el("span", {}, "Sits on"), on),
          remove,
        ),
        el("label", { class: "field", title: "Swap it for another component" }, el("span", {}, "Component"), swap),
        el("div", { class: "button-row" }, edit, decompose),
      );
    }
    box.append(row);
  }
  const tools = el("div", { class: "button-row" });
  const make = el("button", { class: "pill small ghost", title: "Turn the selected paths into a component placed where they were" }, "Make from selection");
  make.disabled = !ed.selectedContours().length;
  make.addEventListener("click", () => void ed.makeComponent());
  tools.append(make);
  if (placed.length > 1) {
    const all = el("button", { class: "pill small ghost", title: "Turn every placed component into plain paths" }, "Decompose all");
    all.addEventListener("click", () => void ed.decompose());
    tools.append(all);
  }
  box.append(tools);
  return [el("h3", { class: "section-label", title: "Leaves, caps and corners drawn once and placed here" }, "Components"), box];
}
