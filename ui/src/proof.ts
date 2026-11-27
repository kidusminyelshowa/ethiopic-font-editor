// The proof panel under the grid: text set in a font built from the current
// drawings, with preview options, templates and a waterfall.

import { el } from "./dom";

export interface ProofHooks {
  /** Base fidel of each family, in grid order, with their orders. */
  rows(): { base: string; orders: string[]; extras: string[] }[];
  /** Numerals, punctuation and other symbols in the font. */
  symbols(): string[];
  testInstall(): void;
}

export interface ProofPrefs {
  text: string;
  size: number;
  lineHeight: number;
  align: "left" | "center" | "right";
  waterfall: boolean;
  invert: boolean;
  kern: boolean;
  underline: boolean;
  strike: boolean;
  open: boolean;
}

const KEY = "efe.proof";
const DEFAULTS: ProofPrefs = {
  text: "በበግ ቤት በግ ገባ።",
  size: 40,
  lineHeight: 1.5,
  align: "left",
  waterfall: false,
  invert: false,
  kern: true,
  underline: false,
  strike: false,
  open: false,
};

const UDHR =
  "የሰው ልጅ ሁሉ ሲወለድ ነጻና በክብርና በመብትም እኩልነት ያለው ነው። የተፈጥሮ ማስተዋልና ሕሊና ስላለው አንዱ ሌላውን በወንድማማችነት መንፈስ መመልከት ይገባዋል።";

const WATERFALL = [12, 14, 18, 24, 32, 48, 64, 96];

/** Turn `U+1200`, `ሀ` and `\u{1200}` into the characters they name. */
export function resolveEscapes(text: string): string {
  return text.replace(/(?:[Uu]\+|\\u\{?)([0-9A-Fa-f]{4,6})\}?/g, (all, hex: string) => {
    const cp = parseInt(hex, 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
  });
}

/** Templates by name: each builds its text from what the font covers. */
export function templates(h: ProofHooks): { id: string; name: string; text: () => string }[] {
  return [
    { id: "pangram", name: "Pangram", text: () => DEFAULTS.text },
    { id: "paragraph", name: "Paragraph", text: () => UDHR },
    { id: "orders", name: "Fidel by order", text: () => h.rows().map((r) => r.orders.join(" ")).join("\n") },
    {
      id: "labialized",
      name: "Labialized forms",
      text: () =>
        h
          .rows()
          .filter((r) => r.extras.length)
          .map((r) => r.extras.join(" "))
          .join("\n"),
    },
    { id: "spacing", name: "Spacing strings", text: () => h.rows().map((r) => `ሀሀ${r.base}ሀሀ${r.base}ሀ${r.base}${r.base}ሀ`).join("\n") },
    { id: "symbols", name: "Numerals and punctuation", text: () => h.symbols().join(" ") },
  ];
}

function load(): ProofPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // Defaults.
  }
  return { ...DEFAULTS };
}

export const proof = load();

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(proof));
  } catch {
    // This session only.
  }
}

let root: HTMLElement;
let text: HTMLTextAreaElement;
let fall: HTMLElement;
let family = "";

export function initProof(container: HTMLElement, h: ProofHooks): void {
  root = container;
  root.replaceChildren();
  const toggle = el("button", { class: "proof-label", "aria-expanded": "false", title: "Open the proof with its options" }, "Proof");
  const collapse = el("button", { class: "proof-label", "aria-expanded": "true", title: "Back to one line" }, "Proof");
  const setOpen = (open: boolean) => {
    proof.open = open;
    save();
    apply();
    text.focus();
  };
  toggle.addEventListener("click", () => setOpen(true));
  collapse.addEventListener("click", () => setOpen(false));
  text = el("textarea", { id: "proof-input", class: "proof-input", lang: "am", spellcheck: "false", "aria-label": "Proof text", rows: "1" }) as HTMLTextAreaElement;
  text.value = proof.text;
  text.addEventListener("input", () => {
    const resolved = resolveEscapes(text.value);
    if (resolved !== text.value) {
      const back = text.value.length - text.selectionEnd;
      text.value = resolved;
      const at = Math.max(0, resolved.length - back);
      text.setSelectionRange(at, at);
    }
    proof.text = text.value;
    save();
    renderWaterfall();
  });
  // Collapsed, Enter does not add lines.
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !proof.open) e.preventDefault();
  });
  const note = el("span", { id: "proof-note", class: "proof-note", title: "System font until you draw" });

  // Options, shown when open.
  const tpl = el("select", { class: "proof-select", "aria-label": "Template", title: "Fill in a proof text" }) as HTMLSelectElement;
  tpl.append(el("option", { value: "" }, "Template…"));
  const list = templates(h);
  for (const t of list) tpl.append(el("option", { value: t.id }, t.name));
  tpl.addEventListener("change", () => {
    const t = list.find((x) => x.id === tpl.value);
    tpl.value = "";
    if (!t) return;
    text.value = t.text();
    proof.text = text.value;
    save();
    renderWaterfall();
  });
  const num = (label: string, value: number, min: number, max: number, step: number, set: (v: number) => void, suffix = "") => {
    const range = el("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(value), "aria-label": label }) as HTMLInputElement;
    const out = el("span", { class: "proof-value" }, `${value}${suffix}`);
    range.addEventListener("input", () => {
      set(Number(range.value));
      out.textContent = `${range.value}${suffix}`;
      save();
      apply();
    });
    return el("label", { class: "proof-range", title: label }, el("span", { class: "proof-range-label" }, label), range, out);
  };
  const flag = (label: string, key: "waterfall" | "invert" | "kern" | "underline" | "strike", title: string) => {
    const b = el("button", { class: `proof-flag${proof[key] ? " on" : ""}`, "aria-pressed": String(proof[key]), title }, label);
    b.addEventListener("click", () => {
      proof[key] = !proof[key];
      b.classList.toggle("on", proof[key]);
      b.setAttribute("aria-pressed", String(proof[key]));
      save();
      apply();
    });
    return b;
  };
  const align = el("div", { class: "menu-segment proof-align", role: "group", "aria-label": "Alignment" });
  for (const a of ["left", "center", "right"] as const) {
    const b = el("button", { class: `segment${proof.align === a ? " on" : ""}`, "aria-pressed": String(proof.align === a), title: `Align ${a}` }, a[0].toUpperCase() + a.slice(1));
    b.addEventListener("click", () => {
      proof.align = a;
      align.querySelectorAll(".segment").forEach((x) => x.classList.toggle("on", x === b));
      save();
      apply();
    });
    align.append(b);
  }
  const install = el("button", { class: "pill small proof-install", title: "Install the font on this computer, replacing the last test copy" }, "Test install");
  install.addEventListener("click", () => h.testInstall());
  const tools = el(
    "div",
    { class: "proof-tools" },
    collapse,
    tpl,
    num("Size", proof.size, 8, 200, 1, (v) => (proof.size = v), " px"),
    num("Line height", proof.lineHeight, 0.8, 3, 0.05, (v) => (proof.lineHeight = v)),
    align,
    flag("Waterfall", "waterfall", "The first line at every size"),
    flag("Kerning", "kern", "Kerning on or off"),
    flag("U", "underline", "Underline, at the font's own position"),
    flag("S", "strike", "Strikethrough"),
    flag("Invert", "invert", "Light text on dark"),
    el("span", { class: "grow" }),
    install,
  );
  fall = el("div", { class: "proof-waterfall", "aria-label": "Waterfall" });
  root.append(el("div", { class: "proof-line" }, toggle, text, note), tools, fall);
  apply();
}

/** Set the proof in this font family (null: the system font). */
export function setProofFont(name: string | null): void {
  family = name ?? "";
  apply();
}

function apply(): void {
  if (!root) return;
  root.classList.toggle("open", proof.open);
  root.classList.toggle("inverted", proof.open && proof.invert);
  const font = family ? `"${family}", var(--ethiopic)` : "";
  const deco = [proof.underline ? "underline" : "", proof.strike ? "line-through" : ""].filter(Boolean).join(" ") || "none";
  const set = (n: HTMLElement) => {
    n.style.fontFamily = font;
    n.style.fontKerning = proof.kern ? "normal" : "none";
    n.style.fontFeatureSettings = proof.kern ? "" : '"kern" 0';
  };
  set(text);
  set(fall);
  text.style.textDecorationLine = proof.open ? deco : "none";
  fall.style.setProperty("--proof-deco", deco);
  if (proof.open) {
    text.style.fontSize = `${proof.size}px`;
    text.style.lineHeight = String(proof.lineHeight);
    text.style.textAlign = proof.align;
    text.rows = 4;
  } else {
    text.style.fontSize = "";
    text.style.lineHeight = "";
    text.style.textAlign = "";
    text.rows = 1;
  }
  fall.hidden = !(proof.open && proof.waterfall);
  fall.style.textAlign = proof.align;
  renderWaterfall();
}

function renderWaterfall(): void {
  if (!fall || fall.hidden) return;
  const line = (text.value.split("\n").find((l) => l.trim()) ?? "").trim();
  fall.replaceChildren(
    ...WATERFALL.map((size) =>
      el("div", { class: "proof-fall-row" }, el("span", { class: "proof-fall-size" }, String(size)), el("span", { class: "proof-fall-text", style: `font-size:${size}px` }, line)),
    ),
  );
}
