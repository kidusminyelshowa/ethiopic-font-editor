// The kerning view: a line of text with its pairs, the pair list and the
// class editor in the left panel, and the selected pair in the inspector.

import { api, type KernClass, type KernSide, type KerningData, type Metrics } from "./api";
import { el } from "./dom";
import { numberField, showMenu, type MenuEntry } from "./editorSide";
import { EMPTY_KERNING, classOf, classesOf, editKey, isException, kernString, layoutLine, listPairs, pairValue, resolve, sampleOf } from "./kerning";
import { actionFor, comboOf, keysFor } from "./shortcuts";

export interface KernHost {
  metrics(): Metrics | null;
  /** A character's outline and advance, or null when the project has no such glyph. */
  glyph(ch: string): { d: string | null; advance: number } | null;
  /** Drawn characters to pair with, in grid order. */
  partners(): string[];
  toast(message: string, tone?: "error" | "info"): void;
  openGlyph(ch: string): void;
  /** The search text of the left panel. */
  query(): string;
  /** After a change to the kerning: the proof and the project's saved state. */
  changed(): void;
  sideList: HTMLElement;
  inspector: HTMLElement;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const PREF = "efe.kerning";

interface Prefs {
  text: string;
  size: number;
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREF);
    if (raw) return { text: "", size: 96, ...JSON.parse(raw) };
  } catch {
    // Defaults.
  }
  return { text: "", size: 96 };
}

const isTyping = (t: EventTarget | null) => {
  const n = t as HTMLElement | null;
  return !!n && (n.tagName === "INPUT" || n.tagName === "TEXTAREA" || n.tagName === "SELECT" || n.isContentEditable);
};

export class KernView {
  data: KerningData = EMPTY_KERNING;
  private prefs = loadPrefs();
  /** The pair edited is the glyph before the cursor and the one after it. */
  cursor = 1;
  /** Kern glyph to glyph, as an exception, instead of class to class. */
  exception = false;
  private tab: "pairs" | "classes" = "pairs";
  private sort: "name" | "value" = "name";
  private openClass: string | null = null;
  private drag: { index: number; startX: number; start: number; now: number } | null = null;
  private undo: { left: string; right: string; value: number | null }[] = [];
  private svg: SVGSVGElement;
  private input: HTMLInputElement;
  private subtitle: HTMLElement;

  constructor(
    private root: HTMLElement,
    private host: KernHost,
  ) {
    this.svg = root.querySelector("svg.kern-canvas")!;
    this.input = root.querySelector("#kern-text")!;
    this.subtitle = root.querySelector(".kern-subtitle")!;
    const size = root.querySelector<HTMLInputElement>("#kern-size")!;
    size.value = String(this.prefs.size);
    size.addEventListener("input", () => {
      this.prefs.size = Number(size.value);
      this.savePrefs();
      this.render();
    });
    this.input.value = this.prefs.text;
    this.input.addEventListener("input", () => {
      this.prefs.text = this.input.value;
      this.savePrefs();
      this.cursor = Math.min(Math.max(1, this.cursor), Math.max(1, this.chars().length - 1));
      this.refresh();
    });
    root.querySelector("#kern-strings")!.addEventListener("click", (e) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      this.stringsMenu({ x: r.left, y: r.bottom + 4 });
    });
    new ResizeObserver(() => this.isActive() && this.render()).observe(this.svg);
    this.bindCanvas();
    window.addEventListener("keydown", (e) => this.onKey(e));
  }

  isActive(): boolean {
    return !this.root.hidden;
  }

  private savePrefs() {
    try {
      localStorage.setItem(PREF, JSON.stringify(this.prefs));
    } catch {
      // This session only.
    }
  }

  async show(): Promise<void> {
    if (!this.prefs.text) {
      this.prefs.text = this.host.partners().slice(0, 10).join("") || "ሀለሐመ";
      this.input.value = this.prefs.text;
    }
    this.data = await api.getKerning();
    this.refresh();
  }

  chars(): string[] {
    return [...this.input.value].filter((c) => c !== "\n");
  }

  /** The two glyphs of the selected pair. */
  pair(): [string, string] | null {
    const cs = this.chars();
    if (cs.length < 2) return null;
    const i = Math.min(Math.max(1, this.cursor), cs.length - 1);
    return [cs[i - 1], cs[i]];
  }

  refresh(): void {
    this.render();
    this.renderSidebar();
    this.renderInspector();
  }

  // ---------- Canvas ----------

  private advance(ch: string): number {
    const m = this.host.metrics();
    const upm = m?.units_per_em ?? 1000;
    if (ch === " ") return upm * 0.3;
    return this.host.glyph(ch)?.advance ?? upm * 0.6;
  }

  private kernAt(l: string, r: string, i: number): number {
    if (this.drag && this.drag.index === i) return this.drag.now;
    return resolve(this.data, l, r)?.value ?? 0;
  }

  render(): void {
    if (!this.isActive()) return;
    const m = this.host.metrics();
    const svg = this.svg;
    svg.replaceChildren();
    if (!m) return;
    const cs = this.chars();
    const upm = m.units_per_em;
    const scale = this.prefs.size / upm;
    const width = svg.clientWidth || 800;
    const pad = 32;
    const xs = layoutLine(cs, (c) => this.advance(c), (l, r, i) => this.kernAt(l, r, i));
    // Positions per glyph, wrapped into rows that fit the width.
    const lineH = (m.pa_top - m.pa_bottom) * scale + 64;
    let row = 0;
    let rowStart = 0;
    const placed: { x: number; y: number }[] = [];
    cs.forEach((_, i) => {
      if (i > 0 && (xs[i + 1] - rowStart) * scale > width - 2 * pad) {
        row++;
        rowStart = xs[i];
      }
      placed.push({ x: pad + (xs[i] - rowStart) * scale, y: pad + m.pa_top * scale + 24 + row * lineH });
    });
    svg.setAttribute("height", String(Math.max(200, (row + 1) * lineH + 2 * pad)));
    const p = this.pair() ? Math.min(Math.max(1, this.cursor), cs.length - 1) : -1;
    cs.forEach((ch, i) => {
      const at = placed[i];
      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("class", `kern-glyph${i === p || i === p - 1 ? " in-pair" : ""}`);
      g.dataset.index = String(i);
      // A box to click and drag, the glyph's advance tall as the em.
      const hit = document.createElementNS(SVG_NS, "rect");
      hit.setAttribute("x", String(at.x));
      hit.setAttribute("y", String(at.y - m.pa_top * scale - 16));
      hit.setAttribute("width", String(Math.max(4, this.advance(ch) * scale)));
      hit.setAttribute("height", String((m.pa_top - m.pa_bottom) * scale + 32));
      hit.setAttribute("class", "kern-hit");
      g.append(hit);
      const glyph = this.host.glyph(ch);
      if (glyph?.d) {
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", glyph.d);
        path.setAttribute("transform", `translate(${at.x} ${at.y}) scale(${scale} ${-scale})`);
        g.append(path);
      } else if (ch !== " ") {
        const t = document.createElementNS(SVG_NS, "text");
        t.setAttribute("x", String(at.x));
        t.setAttribute("y", String(at.y));
        t.setAttribute("font-size", String(upm * scale * 0.7));
        t.setAttribute("class", "kern-missing");
        t.textContent = ch;
        g.append(t);
      }
      svg.append(g);
      if (i === 0 || placed[i].y !== placed[i - 1].y) return;
      // The value between this glyph and the one before.
      const r = resolve(this.data, cs[i - 1], ch);
      const v = this.drag?.index === i ? this.drag.now : (r?.value ?? 0);
      const selected = i === p;
      if (selected) {
        const line = document.createElementNS(SVG_NS, "line");
        line.setAttribute("x1", String(at.x));
        line.setAttribute("x2", String(at.x));
        line.setAttribute("y1", String(at.y - m.pa_top * scale - 12));
        line.setAttribute("y2", String(at.y - m.pa_bottom * scale + 8));
        line.setAttribute("class", "kern-cursor");
        svg.append(line);
      }
      if (v !== 0 || selected || r) {
        const label = document.createElementNS(SVG_NS, "text");
        label.setAttribute("x", String(at.x));
        label.setAttribute("y", String(at.y - m.pa_bottom * scale + 24));
        label.setAttribute("class", `kern-value${r?.source === "exception" ? " exception" : ""}${selected ? " selected" : ""}`);
        label.textContent = String(v);
        svg.append(label);
      }
    });
    const pr = this.pair();
    this.subtitle.textContent = pr ? `${pr[0]}${pr[1]}` : "";
  }

  private bindCanvas() {
    const svg = this.svg;
    const indexAt = (e: MouseEvent) => {
      const g = (e.target as Element).closest<SVGGElement>("g.kern-glyph");
      return g ? Number(g.dataset.index) : null;
    };
    svg.addEventListener("pointerdown", (e) => {
      const i = indexAt(e);
      if (i === null) return;
      const cs = this.chars();
      this.cursor = Math.max(1, i);
      const pr = this.pair();
      if (i >= 1 && pr) {
        const start = resolve(this.data, pr[0], pr[1])?.value ?? 0;
        this.drag = { index: i, startX: e.clientX, start, now: start };
        svg.setPointerCapture(e.pointerId);
      }
      if (cs.length >= 2) this.refresh();
    });
    svg.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d) return;
      const m = this.host.metrics();
      const scale = this.prefs.size / (m?.units_per_em ?? 1000);
      const now = d.start + Math.round((e.clientX - d.startX) / scale);
      if (now !== d.now) {
        d.now = now;
        this.render();
      }
    });
    const end = () => {
      const d = this.drag;
      this.drag = null;
      if (d && d.now !== d.start) void this.setValue(d.now);
      else this.render();
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
    svg.addEventListener("dblclick", (e) => {
      const i = indexAt(e);
      if (i !== null) this.host.openGlyph(this.chars()[i]);
    });
  }

  private onKey(e: KeyboardEvent) {
    if (!this.isActive() || isTyping(e.target) || document.querySelector(".modal, .context-menu")) return;
    const action = actionFor(comboOf(e));
    const pr = this.pair();
    const step: Record<string, number> = { "kern.tighter": -1, "kern.looser": 1, "kern.tighter10": -10, "kern.looser10": 10 };
    if (action && action in step) {
      e.preventDefault();
      if (pr) void this.setValue((resolve(this.data, pr[0], pr[1])?.value ?? 0) + step[action]);
      return;
    }
    if (action === "kern.exception") {
      e.preventDefault();
      this.exception = !this.exception;
      this.refresh();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
      e.preventDefault();
      void this.undoLast();
      return;
    }
    if (e.altKey || mod) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const n = this.chars().length;
      this.cursor = Math.min(Math.max(1, this.cursor + (e.key === "ArrowLeft" ? -1 : 1)), Math.max(1, n - 1));
      this.refresh();
    } else if ((e.key === "Delete" || e.key === "Backspace") && pr) {
      e.preventDefault();
      void this.removeAtKey();
    }
  }

  // ---------- Changes ----------

  /** The stored pair an edit of the selected glyphs writes to. */
  editKey(): [string, string] | null {
    const pr = this.pair();
    return pr ? editKey(this.data, pr[0], pr[1], this.exception, this.exception) : null;
  }

  private async write(left: string, right: string, value: number | null, record = true) {
    if (record) this.undo.push({ left, right, value: pairValue(this.data, left, right) });
    if (this.undo.length > 200) this.undo.shift();
    try {
      this.data = await api.setKernPair(left, right, value);
      this.host.changed();
    } catch (err) {
      this.host.toast(String(err), "error");
    }
    this.refresh();
  }

  async setValue(value: number): Promise<void> {
    const k = this.editKey();
    if (k) await this.write(k[0], k[1], value);
  }

  async removeAtKey(): Promise<void> {
    const k = this.editKey();
    if (k && pairValue(this.data, k[0], k[1]) !== null) await this.write(k[0], k[1], null);
  }

  private async undoLast() {
    const u = this.undo.pop();
    if (u) await this.write(u.left, u.right, u.value, false);
  }

  private async setClass(side: KernSide, name: string, members: string, rename?: string) {
    try {
      this.data = await api.setKernClass(side, name, members, rename);
      this.host.changed();
    } catch (err) {
      this.host.toast(String(err), "error");
    }
    this.refresh();
  }

  /** Put a glyph in a class on one side, or take it out (`null`). */
  async assign(side: KernSide, ch: string, name: string | null): Promise<void> {
    const cur = classOf(this.data, side, ch);
    if (name === null) {
      if (!cur) return;
      const c = classesOf(this.data, side).find((x) => x.name === cur)!;
      return this.setClass(side, cur, [...c.members].filter((m) => m !== ch).join(""));
    }
    const target = classesOf(this.data, side).find((x) => x.name === name);
    await this.setClass(side, name, (target?.members ?? "") + ch);
  }

  /** A new class on one side holding one glyph, named after it. */
  async newClass(side: KernSide, ch: string): Promise<void> {
    const taken = new Set(classesOf(this.data, side).map((c) => c.name));
    let name = ch;
    for (let n = 2; taken.has(name); n++) name = `${ch}${n}`;
    await this.setClass(side, name, ch);
  }

  /** Show a pair in the line: its two glyphs, or a class's first member. */
  showPair(left: string, right: string): void {
    const l = sampleOf(this.data, "left", left);
    const r = sampleOf(this.data, "right", right);
    if (!l || !r) return;
    this.input.value = l + r;
    this.prefs.text = this.input.value;
    this.savePrefs();
    this.cursor = 1;
    this.exception = !left.startsWith("@") && !right.startsWith("@") && (!!classOf(this.data, "left", l) || !!classOf(this.data, "right", r));
    this.refresh();
  }

  private setText(text: string) {
    this.input.value = text;
    this.prefs.text = text;
    this.savePrefs();
    this.cursor = 1;
    this.refresh();
  }

  private stringsMenu(at: { x: number; y: number }) {
    const partners = this.host.partners();
    const pr = this.pair();
    const entries: MenuEntry[] = [];
    if (pr) {
      for (const ch of new Set(pr)) {
        entries.push({ label: `${ch} against every glyph`, run: () => this.setText(kernString(this.data, ch, partners)) });
      }
      const lc = classOf(this.data, "left", pr[0]);
      if (lc) {
        const c = classesOf(this.data, "left").find((x) => x.name === lc)!;
        entries.push({ label: `Class @${lc} against ${pr[1]}`, run: () => this.setText([...c.members].map((m) => m + pr[1]).join("")) });
      }
      const rc = classOf(this.data, "right", pr[1]);
      if (rc) {
        const c = classesOf(this.data, "right").find((x) => x.name === rc)!;
        entries.push({ label: `${pr[0]} against class @${rc}`, run: () => this.setText([...c.members].map((m) => pr[0] + m).join("")) });
      }
      entries.push("sep");
    }
    entries.push({ label: "Every glyph", run: () => this.setText(partners.join("")) });
    entries.push({ label: "With punctuation", run: () => this.setText(partners.filter((c) => /[ሀ-፟]/u.test(c)).slice(0, 12).join("፡") + "።") });
    showMenu(entries, at);
  }

  // ---------- Left panel ----------

  renderSidebar(): void {
    if (!this.isActive()) return;
    const list = this.host.sideList;
    const seg = el("div", { class: "menu-segment kern-tabs", role: "tablist" });
    for (const t of ["pairs", "classes"] as const) {
      const b = el("button", { class: `segment${this.tab === t ? " on" : ""}`, role: "tab", "aria-selected": String(this.tab === t) }, t === "pairs" ? `Pairs ${this.data.pairs.length || ""}`.trim() : "Classes");
      b.addEventListener("click", () => {
        this.tab = t;
        this.renderSidebar();
      });
      seg.append(b);
    }
    const rows: Node[] = [seg];
    if (this.tab === "pairs") rows.push(...this.pairRows());
    else rows.push(...this.classGroup("left"), ...this.classGroup("right"));
    list.replaceChildren(...rows);
  }

  private pairRows(): Node[] {
    const k = this.data;
    const sort = el("div", { class: "kern-sort" });
    for (const s of ["name", "value"] as const) {
      const b = el("button", { class: `link-btn${this.sort === s ? " on" : ""}`, title: s === "name" ? "In order of the left glyph" : "Largest values first" }, s === "name" ? "By name" : "Largest");
      b.addEventListener("click", () => {
        this.sort = s;
        this.renderSidebar();
      });
      sort.append(b);
    }
    const out: Node[] = [sort];
    const pairs = listPairs(k, this.host.query(), this.sort);
    const selKey = this.editKey();
    for (const p of pairs) {
      const exc = isException(k, p);
      const row = el(
        "div",
        {
          class: `tree-row kern-pair-row${selKey && selKey[0] === p.left && selKey[1] === p.right ? " selected" : ""}`,
          role: "treeitem",
          tabindex: "0",
          title: exc ? "Exception: overrides the class pair" : p.left.startsWith("@") || p.right.startsWith("@") ? "Class pair" : "Glyph pair",
        },
        el("span", { class: `kern-side${p.left.startsWith("@") ? " cls" : ""}`, lang: "gez" }, p.left),
        el("span", { class: `kern-side${p.right.startsWith("@") ? " cls" : ""}`, lang: "gez" }, p.right),
        el("span", { class: `tree-meta kern-num${exc ? " exception" : ""}` }, String(p.value)),
      );
      const del = el("button", { class: "icon-btn kern-del", title: "Remove the pair", "aria-label": "Remove the pair" }, "×");
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.write(p.left, p.right, null);
      });
      row.append(del);
      row.addEventListener("click", () => this.showPair(p.left, p.right));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.showPair(p.left, p.right);
      });
      out.push(row);
    }
    if (!pairs.length) out.push(el("p", { class: "side-note" }, k.pairs.length ? "No pair matches." : "No pairs yet."));
    return out;
  }

  private classGroup(side: KernSide): Node[] {
    const pr = this.pair();
    const ch = pr ? (side === "left" ? pr[0] : pr[1]) : null;
    const add = el("button", {
      class: "icon-btn",
      title: ch ? `New ${side}-side class with ${ch}` : "Select a pair to start a class",
      "aria-label": "New class",
    }, "+");
    (add as HTMLButtonElement).disabled = !ch;
    add.addEventListener("click", () => ch && void this.newClass(side, ch));
    const head = el(
      "div",
      { class: "tree-section kern-class-head", title: side === "left" ? "Glyphs on the left of a pair, grouped by their right edge" : "Glyphs on the right of a pair, grouped by their left edge" },
      el("span", {}, side === "left" ? "Left side" : "Right side"),
      add,
    );
    const q = this.host.query().trim().toLowerCase();
    const out: Node[] = [head];
    for (const c of classesOf(this.data, side)) {
      if (q && !`${c.name} ${c.members}`.toLowerCase().includes(q)) continue;
      out.push(this.classRow(side, c));
    }
    return out;
  }

  private classRow(side: KernSide, c: KernClass): HTMLElement {
    const id = `${side}:${c.name}`;
    const open = this.openClass === id;
    const row = el(
      "div",
      { class: `kern-class${open ? " open" : ""}`, "data-side": side, "data-class": c.name },
    );
    const head = el(
      "button",
      { class: "tree-row kern-class-row", "aria-expanded": String(open) },
      el("span", { class: "kern-class-name", lang: "gez" }, `@${c.name}`),
      el("span", { class: "tree-label glyph-label", lang: "gez" }, [...c.members].slice(0, 8).join("")),
      el("span", { class: "tree-meta" }, String([...c.members].length)),
    );
    head.addEventListener("click", () => {
      this.openClass = open ? null : id;
      this.renderSidebar();
    });
    row.append(head);
    // Drop a glyph from another class here to move it.
    row.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes(`application/x-kern-${side}`)) {
        e.preventDefault();
        row.classList.add("drop");
      }
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop"));
    row.addEventListener("drop", (e) => {
      row.classList.remove("drop");
      const ch = e.dataTransfer?.getData(`application/x-kern-${side}`);
      if (ch) {
        e.preventDefault();
        void this.assign(side, ch, c.name);
      }
    });
    if (open) {
      const chips = el("div", { class: "kern-chips" });
      for (const m of c.members) {
        const chip = el("span", { class: "kern-chip", lang: "gez", draggable: "true", title: "Drag to another class" }, m);
        chip.addEventListener("dragstart", (e) => e.dataTransfer?.setData(`application/x-kern-${side}`, m));
        const x = el("button", { class: "kern-chip-x", "aria-label": `Take ${m} out`, title: "Take out of the class" }, "×");
        x.addEventListener("click", () => void this.assign(side, m, null));
        chip.append(x);
        chips.append(chip);
      }
      const name = el("input", { type: "text", class: "kern-class-input", value: c.name, "aria-label": "Class name", spellcheck: "false" }) as HTMLInputElement;
      name.addEventListener("change", () => {
        const v = name.value.trim();
        if (v && v !== c.name) {
          this.openClass = `${side}:${v}`;
          void this.setClass(side, c.name, c.members, v);
        }
      });
      const members = el("input", { type: "text", class: "kern-class-input", value: c.members, "aria-label": "Members", title: "Type or paste glyphs to set the members", spellcheck: "false", lang: "gez" }) as HTMLInputElement;
      members.addEventListener("change", () => void this.setClass(side, c.name, members.value.replace(/\s+/g, "")));
      for (const i of [name, members]) i.addEventListener("keydown", (e) => e.key === "Enter" && i.blur());
      const remove = el("button", { class: "pill small ghost" }, "Delete class");
      remove.addEventListener("click", () => void this.setClass(side, c.name, ""));
      row.append(
        el("div", { class: "kern-class-body" }, chips, el("label", { class: "field" }, el("span", {}, "Name"), name), el("label", { class: "field" }, el("span", {}, "Members"), members), el("div", { class: "button-row" }, remove)),
      );
    }
    return row;
  }

  // ---------- Inspector ----------

  renderInspector(): void {
    if (!this.isActive()) return;
    const k = this.data;
    const pr = this.pair();
    const sections: Node[] = [];
    if (!pr) {
      sections.push(el("h3", { class: "section-label first" }, "Pair"), el("p", { class: "side-note" }, "Type two or more glyphs in the line."));
      this.host.inspector.replaceChildren(el("div", { class: "inspector-body kern-side-panel" }, ...sections));
      return;
    }
    const [l, r] = pr;
    const res = resolve(k, l, r);
    const key = this.editKey()!;
    const stored = pairValue(k, key[0], key[1]);
    const glyphView = (ch: string) => el("span", { class: "kern-big", lang: "gez" }, ch);
    sections.push(el("h3", { class: "section-label first" }, "Pair"), el("div", { class: "kern-pair-head" }, glyphView(l), glyphView(r)));

    // Class or exception.
    const seg = el("div", { class: "menu-segment kern-mode", role: "group", "aria-label": "Kern by" });
    for (const exc of [false, true]) {
      const b = el(
        "button",
        {
          class: `segment${this.exception === exc ? " on" : ""}`,
          "aria-pressed": String(this.exception === exc),
          title: exc ? `Only ${l}${r}, over any class pair (${keysFor("kern.exception")})` : `Every pair of their classes (${keysFor("kern.exception")})`,
        },
        exc ? "Exception" : "Classes",
      );
      b.addEventListener("click", () => {
        this.exception = exc;
        this.refresh();
      });
      seg.append(b);
    }
    sections.push(seg);
    const value = numberField("Value", stored ?? res?.value ?? 0, (v) => void this.setValue(Math.round(v)), `${keysFor("kern.tighter")} and ${keysFor("kern.looser")} step by 1`);
    const remove = el("button", { class: "pill small ghost", title: "Remove this pair (Delete)" }, "Remove");
    (remove as HTMLButtonElement).disabled = stored === null;
    remove.addEventListener("click", () => void this.removeAtKey());
    sections.push(el("div", { class: "field-row kern-value-row" }, value, remove));
    const writes = `${key[0]} ${key[1]}`;
    let note = `Writes to ${writes}.`;
    if (res && (res.left !== key[0] || res.right !== key[1])) {
      note = res.source === "exception" && !this.exception ? `The exception ${res.left} ${res.right} (${res.value}) wins over ${writes}.` : `Now ${res.value} from ${res.left} ${res.right}. Editing writes to ${writes}.`;
    } else if (res?.source === "exception") note = `Exception over the class pair.`;
    sections.push(el("p", { class: "side-note kern-note" }, note));

    // Classes of the two glyphs.
    const classSelect = (side: KernSide, ch: string) => {
      const cur = classOf(k, side, ch);
      const sel = el("select", { class: "zone-select", "aria-label": `${side === "left" ? "Left" : "Right"}-side class of ${ch}` }) as HTMLSelectElement;
      sel.append(el("option", { value: "" }, "No class"));
      for (const c of classesOf(k, side)) sel.append(el("option", { value: c.name }, `@${c.name}`));
      sel.append(el("option", { value: "\u0000new" }, `New class “${ch}”`));
      sel.value = cur ?? "";
      sel.addEventListener("change", () => {
        if (sel.value === "\u0000new") void this.newClass(side, ch);
        else void this.assign(side, ch, sel.value || null);
      });
      return el(
        "label",
        { class: "kern-class-field", title: side === "left" ? `Glyphs whose right edge kerns like ${ch}'s` : `Glyphs whose left edge kerns like ${ch}'s` },
        el("span", { class: "kern-field-label", lang: "gez" }, side === "left" ? `${ch} right edge` : `${ch} left edge`),
        sel,
      );
    };
    sections.push(el("h3", { class: "section-label" }, "Classes"), classSelect("left", l), classSelect("right", r));
    this.host.inspector.replaceChildren(el("div", { class: "inspector-body kern-side-panel" }, ...sections));
  }
}
