// Inspector sections for anchors and for letters built from parts.

import { api, type DrawingView } from "./api";
import { ANCHOR_PRESETS, joinsAsAccent, parseParts, presetPosition, showPart } from "./anchors";
import { el } from "./dom";
import type { GlyphEditor } from "./editor";
import { numberField } from "./editorSide";
import { contoursBounds } from "./geometry";

export interface AnchorHost {
  /** The character the open drawing makes. */
  charOf(d: DrawingView): string | null;
  /** Drawn characters to preview with: accents and letters, with names. */
  glyphs(): { ch: string; name: string }[];
  /** After a built letter changed: reload the drawing and the grid. */
  rebuilt(): Promise<void>;
}

/** For bases and symbols: anchors, and another glyph shown against this one. */
export function anchorsSection(ed: GlyphEditor, d: DrawingView, host: AnchorHost): Node[] {
  if (d.target.kind !== "base" && d.target.kind !== "symbol" && d.target.kind !== "fidel") return [];
  const anchors = { ...(d.anchors ?? {}) };
  const box = el("div", { class: "side-box anchor-box" });
  const save = (next: Record<string, { x: number; y: number }>) => void ed.saveAnchors(next);

  for (const [name, a] of Object.entries(anchors)) {
    const sel = ed.anchorSel === name;
    const nameIn = el("input", { type: "text", class: "anchor-name mono", value: name, spellcheck: "false", "aria-label": "Anchor name" }) as HTMLInputElement;
    nameIn.addEventListener("focus", () => {
      ed.anchorSel = name;
      ed.render();
    });
    nameIn.addEventListener("change", () => {
      const n = nameIn.value.trim();
      if (!n || n === name || anchors[n]) {
        nameIn.value = name;
        return;
      }
      const next: typeof anchors = {};
      for (const [k, v] of Object.entries(anchors)) next[k === name ? n : k] = v;
      ed.anchorSel = n;
      save(next);
    });
    const del = el("button", { class: "icon-btn ds-remove", title: "Remove the anchor", "aria-label": "Remove the anchor" }, "×");
    del.addEventListener("click", () => {
      const { [name]: _, ...rest } = anchors;
      save(rest);
    });
    box.append(
      el(
        "div",
        { class: `anchor-row${sel ? " selected" : ""}` },
        el("div", { class: "ds-row" }, nameIn, del),
        el(
          "div",
          { class: "field-row" },
          numberField("X", a.x, (v) => save({ ...anchors, [name]: { x: Math.round(v), y: a.y } })),
          numberField("Y", a.y, (v) => save({ ...anchors, [name]: { x: a.x, y: Math.round(v) } })),
        ),
      ),
    );
  }

  const add = el("select", { class: "zone-select", "aria-label": "Add an anchor" }) as HTMLSelectElement;
  add.append(el("option", { value: "" }, "Add anchor…"));
  const own = host.charOf(d);
  const accent = joinsAsAccent(anchors, own);
  const presets = [...ANCHOR_PRESETS].sort((a, b) => Number(a.startsWith("_") !== accent) - Number(b.startsWith("_") !== accent));
  for (const p of presets) if (!anchors[p]) add.append(el("option", { value: p }, p));
  add.append(el("option", { value: "*" }, "Other…"));
  add.addEventListener("change", () => {
    let name = add.value;
    if (!name) return;
    if (name === "*") {
      let n = 1;
      while (anchors[`anchor${n}`]) n++;
      name = `anchor${n}`;
    }
    const b = contoursBounds(ed.contours);
    ed.anchorSel = name;
    save({ ...anchors, [name]: presetPosition(name, b, ed.drawing?.advanceWidth ?? 0) });
  });
  box.append(add);

  // Preview: an accent on this letter, or a letter under this accent.
  const partners = host.glyphs().filter((g) => g.ch !== own && joinsAsAccent(undefined, g.ch) !== accent);
  if (partners.length) {
    const pick = el("select", { class: "zone-select", "aria-label": accent ? "Show on a letter" : "Show with an accent", title: "Shown by their anchors, not saved" }) as HTMLSelectElement;
    pick.append(el("option", { value: "" }, accent ? "Show on a letter…" : "Show with an accent…"));
    for (const g of partners) {
      const o = el("option", { value: g.ch }, `${showPart(g.ch)}  ${g.name}`) as HTMLOptionElement;
      o.selected = ed.markPreview?.partner === g.ch;
      pick.append(o);
    }
    pick.addEventListener("change", () => void ed.setMarkPreview(pick.value || null));
    box.append(pick);
  }
  const tip = accent ? "Name it _top to join a letter's top" : "top, bottom and ogonek are where accents go";
  return [el("h3", { class: "section-label", title: tip }, "Anchors"), box];
}

/** For a symbol: built from a letter and accents, or drawn by hand. */
export function builtSection(ed: GlyphEditor, d: DrawingView, host: AnchorHost): Node[] {
  if (d.target.kind !== "symbol") return [];
  const id = d.target.id;
  const built = d.built;
  const box = el("div", { class: "side-box" });
  const parts = el("input", {
    type: "text",
    class: "built-parts",
    value: built ? built.parts.map(showPart).join(" ") : "",
    placeholder: "A ◌́  or  A uni0301",
    spellcheck: "false",
    "aria-label": "Built from",
    title: "A letter, then its accents: characters, uni0301 or U+0301",
  }) as HTMLInputElement;
  const run = async (f: () => Promise<void>) => {
    try {
      await f();
      await host.rebuilt();
    } catch (err) {
      ed.notify(String(err), "error");
    }
  };
  parts.addEventListener("change", () => void run(() => api.setBuiltFrom(id, parseParts(parts.value))));
  box.append(el("label", { class: "field" }, el("span", {}, "Built from"), parts));
  if (built) {
    const decompose = el("button", { class: "pill small ghost", title: "Copy the built outline into a drawing of its own" }, "Decompose");
    decompose.addEventListener("click", () => void run(() => api.decomposeSymbol(id)));
    const draw = el("button", { class: "pill small ghost", title: "Stop building it and draw it by hand" }, "Draw by hand");
    draw.addEventListener("click", () => void run(() => api.setBuiltFrom(id, "")));
    box.append(
      el("p", { class: "side-note" }, "Accents sit on the letter by their anchors. Edit the letter or the accent and this follows."),
      el("div", { class: "button-row" }, decompose, draw),
    );
  }
  return [el("h3", { class: "section-label", title: "Accented letters are built from a letter and accents" }, "Built from"), box];
}
