// Alternates of the open glyph (ሀ.ss01, ሀ.locl.TIR), its code point, and
// characters that two glyphs claim.

import { api, type DrawingTarget } from "./api";
import { el } from "./dom";

export interface AlternatesHost {
  open(t: DrawingTarget): void;
  toast(message: string, tone?: "error" | "info"): void;
  /** A symbol's character changed. */
  changed(): void;
}

/** The next stylistic set not used yet. */
function nextSet(taken: string[]): string {
  for (let n = 1; n <= 20; n++) {
    const s = `ss${String(n).padStart(2, "0")}`;
    if (!taken.some((t) => t.endsWith(`.${s}`))) return s;
  }
  return "salt";
}

/** The glyph whose alternate is open, to go back to. */
let owner: DrawingTarget | null = null;

export function alternatesSection(target: DrawingTarget, host: AlternatesHost): Node[] {
  if (!["base", "symbol", "fidel", "alternate"].includes(target.kind)) return [];
  if (target.kind !== "alternate") owner = target;
  const box = el("div", { class: "side-box alt-box" });
  void api.alternatesOf(target).then((v) => {
    if (!v.of) return;
    const rows: Node[] = [];
    if (target.kind === "symbol") {
      const cp = el("input", { type: "text", class: "mono", value: `U+${v.of.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`, spellcheck: "false", "aria-label": "Unicode", title: "Type U+XXXX or the character" }) as HTMLInputElement;
      cp.addEventListener("keydown", (e) => e.stopPropagation());
      cp.addEventListener("change", async () => {
        const t = cp.value.trim();
        const m = /^(?:U\+)?([0-9a-f]{4,6})$/i.exec(t);
        const c = m ? String.fromCodePoint(parseInt(m[1], 16)) : [...t].length === 1 ? t : null;
        if (!c) return host.toast("Type U+ and a hex number, or the character itself.", "error");
        try {
          await api.setSymbolCodepoint(target.id, c);
          host.changed();
        } catch (err) {
          host.toast(String(err), "error");
        }
      });
      rows.push(el("label", { class: "field" }, el("span", {}, "Unicode"), cp));
    }
    const chips = v.list.map(([id, label]) => {
      const on = target.kind === "alternate" && target.id === id;
      const b = el("button", { class: `placement-head${on ? " on" : ""}`, title: on ? "Being edited" : "Edit this alternate" }, label);
      b.addEventListener("click", () => !on && host.open({ kind: "alternate", id }));
      return b;
    });
    if (chips.length) rows.push(el("div", { class: "freq-row" }, ...chips));
    const suffix = el("input", { type: "text", class: "mono", value: nextSet(v.list.map((x) => x[1])), spellcheck: "false", "aria-label": "Suffix", title: "ss01 to ss20, salt, cv01, or locl.TIR for one language" }) as HTMLInputElement;
    suffix.addEventListener("keydown", (e) => e.stopPropagation());
    const add = el("button", { class: "pill small ghost", title: "Another drawing of this character, swapped in by the feature its suffix names" }, "Add alternate");
    add.addEventListener("click", async () => {
      try {
        host.open({ kind: "alternate", id: await api.addAlternate(v.of!, suffix.value) });
      } catch (err) {
        host.toast(String(err), "error");
      }
    });
    rows.push(el("div", { class: "button-row" }, suffix, add));
    if (target.kind === "alternate") {
      const remove = el("button", { class: "pill small ghost" }, "Remove alternate");
      remove.addEventListener("click", async () => {
        try {
          await api.removeAlternate(target.id);
          if (owner) host.open(owner);
        } catch (err) {
          host.toast(String(err), "error");
        }
      });
      rows.push(el("div", { class: "button-row" }, remove));
    }
    if (v.duplicates.length) {
      rows.push(el("p", { class: "side-note warn" }, "Claimed twice: " + v.duplicates.map(([c, who]) => `${c} (${who.join(", ")})`).join("; ") + ". Only one exports."));
    }
    box.replaceChildren(...rows);
  });
  return [el("h3", { class: "section-label", title: "Other drawings of this character for features, and its code point" }, "Alternates"), box];
}
