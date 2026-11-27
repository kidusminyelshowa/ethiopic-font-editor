// Automatic spacing and kerning by white area, and the corpus they work from.

import { api, type KernProposal, type KerningData, type Spacing } from "./api";
import { el } from "./dom";
import { numberField } from "./editorSide";

export interface AutoHost {
  toast(message: string, tone?: "error" | "info"): void;
  /** After spacing changed: reload outlines and widths. */
  respaced(): Promise<void>;
  /** After kerning was written. */
  kerned(data: KerningData): void;
  /** Redraw this panel. */
  rerender(): void;
}

let spacing: Spacing | null = null;
let proposals: KernProposal[] | null = null;
let skipped = new Set<string>();

const key = (p: KernProposal) => p.left + p.right;

async function save(change: Partial<Spacing>, host: AutoHost) {
  if (!spacing) return;
  try {
    spacing = await api.setSpacing({ ...spacing, ...change });
    proposals = null;
    host.rerender();
  } catch (err) {
    host.toast(String(err), "error");
  }
}

/** The Auto tab of the kerning view's left panel. */
export function autoPanel(host: AutoHost): Node[] {
  if (!spacing) {
    void api.getSpacing().then((s) => {
      spacing = s;
      host.rerender();
    });
    return [el("p", { class: "subtle side-pad" }, "Loading…")];
  }
  const s = spacing;
  const letters = s.letters ?? [];
  const pairs = s.pairs ?? [];

  // Corpus.
  const text = el("textarea", { class: "corpus-text", rows: "4", placeholder: "Paste text in the language, or load a .txt file", spellcheck: "false", "aria-label": "Corpus text" }) as HTMLTextAreaElement;
  text.addEventListener("keydown", (e) => e.stopPropagation());
  const file = el("input", { type: "file", accept: ".txt,text/plain", hidden: "" }) as HTMLInputElement;
  const read = async (t: string) => {
    try {
      spacing = await api.readCorpus(t);
      proposals = null;
      host.toast(`Counted ${spacing.letters?.length ?? 0} letters and ${spacing.pairs?.length ?? 0} pairs.`);
      host.rerender();
    } catch (err) {
      host.toast(String(err), "error");
    }
  };
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (f) await read(await f.text());
  });
  const load = el("button", { class: "pill small ghost" }, "Load .txt");
  load.addEventListener("click", () => file.click());
  const count = el("button", { class: "pill small", title: "Count the letters and pairs of this text" }, "Count");
  count.addEventListener("click", () => text.value.trim() && void read(text.value));
  const top = (list: [string, number][], n: number) => list.slice(0, n).map(([c, k]) => el("span", { class: "freq-chip", title: `${k} times` }, c));
  const corpus = el(
    "div",
    { class: "side-box auto-box" },
    text,
    el("div", { class: "button-row" }, count, load, file),
    ...(letters.length
      ? [
          el("div", { class: "menu-label" }, "Most frequent letters"),
          el("div", { class: "freq-row" }, ...top(letters, 24)),
          el("div", { class: "menu-label" }, "Most frequent pairs"),
          el("div", { class: "freq-row" }, ...top(pairs, 24)),
        ]
      : [el("p", { class: "side-note" }, "Frequencies decide which pairs get kerned first.")]),
  );

  // Spacing.
  const ref = el("input", { type: "text", value: s.reference, maxlength: "2", spellcheck: "false", "aria-label": "Reference glyph" }) as HTMLInputElement;
  ref.addEventListener("keydown", (e) => e.stopPropagation());
  ref.addEventListener("change", () => {
    const c = [...ref.value.trim()][0];
    if (c) void save({ reference: c }, host);
  });
  const spaceAll = el("button", { class: "pill small", title: "Set the sidebearings of every base, numeral and mark so each side has the reference's white. Sides set by a key keep their key." }, "Space all glyphs");
  spaceAll.addEventListener("click", async () => {
    try {
      const n = await api.autoSpace(null);
      host.toast(n ? `Spaced ${n} glyph${n > 1 ? "s" : ""} to match ${s.reference}.` : "Every glyph already matches.");
      proposals = null;
      await host.respaced();
    } catch (err) {
      host.toast(String(err), "error");
    }
  });
  const spacingBox = el(
    "div",
    { class: "side-box auto-box" },
    el(
      "div",
      { class: "field-row" },
      el("label", { class: "field", title: "Space this glyph by hand; the others match its white" }, el("span", {}, "Match"), ref),
      numberField("Depth", s.depth, (v) => void save({ depth: Math.max(0, Math.round(v)) }, host)),
    ),
    el("div", { class: "button-row" }, spaceAll),
  );

  // Kerning.
  const propose = el("button", { class: "pill small", title: "Look at the most frequent pairs and kern those that come closer or stand further apart than usual" }, proposals ? "Look again" : "Propose kerning");
  propose.disabled = !pairs.length;
  propose.title = pairs.length ? propose.title : "Count a corpus first";
  propose.addEventListener("click", async () => {
    try {
      proposals = await api.proposeKerning();
      skipped = new Set();
      host.rerender();
    } catch (err) {
      host.toast(String(err), "error");
    }
  });
  const kernBox = el(
    "div",
    { class: "side-box auto-box" },
    el(
      "div",
      { class: "field-row" },
      numberField("Pairs", s.pair_count, (v) => void save({ pair_count: Math.max(1, Math.round(v)) }, host)),
      numberField("Strength %", Math.round(s.strength * 100), (v) => void save({ strength: Math.min(1, Math.max(0, v / 100)) }, host)),
      numberField("Least", s.min_kern, (v) => void save({ min_kern: Math.max(0, Math.round(v)) }, host)),
    ),
    el("div", { class: "button-row" }, propose),
  );
  if (proposals) {
    if (!proposals.length) kernBox.append(el("p", { class: "side-note" }, "No pair stands out. Try more pairs or a lower least value."));
    for (const p of proposals.slice(0, 200)) {
      const on = !skipped.has(key(p));
      const box = el("input", { type: "checkbox" }) as HTMLInputElement;
      box.checked = on;
      box.addEventListener("change", () => {
        if (box.checked) skipped.delete(key(p));
        else skipped.add(key(p));
      });
      kernBox.append(
        el("label", { class: "check-row proposal-row", title: `${p.count} times in the corpus` }, box, el("span", { class: "proposal-pair" }, p.left + p.right), el("span", { class: "tree-meta mono" }, p.value > 0 ? `+${p.value}` : String(p.value))),
      );
    }
    if (proposals.length) {
      const apply = el("button", { class: "pill small pill-dark", title: "Write the ticked pairs as glyph pairs. Pairs kerned by hand stay." }, "Apply");
      apply.addEventListener("click", async () => {
        try {
          const chosen = proposals!.filter((p) => !skipped.has(key(p)));
          host.kerned(await api.applyKerning(chosen));
          host.toast(`Kerned ${chosen.length} pair${chosen.length === 1 ? "" : "s"}.`);
          proposals = null;
          host.rerender();
        } catch (err) {
          host.toast(String(err), "error");
        }
      });
      kernBox.append(el("div", { class: "button-row" }, apply));
    }
  }

  return [
    el("h3", { class: "section-label auto-label", title: "Text in the language the font is for" }, "Corpus"),
    corpus,
    el("h3", { class: "section-label auto-label", title: "Sidebearings from the white inside each side, counted through the Pa band up to the depth" }, "Spacing"),
    spacingBox,
    el("h3", { class: "section-label auto-label", title: "Kerning for the most frequent pairs, from how close they come" }, "Kerning"),
    kernBox,
  ];
}

/** Forget what was loaded, for a new or opened project. */
export function resetAuto(): void {
  spacing = null;
  proposals = null;
}
