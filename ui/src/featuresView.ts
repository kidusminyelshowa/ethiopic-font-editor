// The Features view: hand-written OpenType code with highlighting and
// errors in place, glyph classes, language systems, stylistic set names, and
// a preview with each feature switched on or off.

import { api, type Features, type FeaturesView as View } from "./api";
import { el } from "./dom";
import { featureLabel, featureSettings, highlight, indent, membersText, onByDefault, parseMembers, stylisticSets } from "./features";

export interface FeaturesHost {
  toast(message: string, tone?: "error" | "info"): void;
  /** After a change: the proof and the project's saved state. */
  changed(): void;
  /** The font family of the current proof font, if there is one. */
  proofFamily(): string | null;
  sideList: HTMLElement;
  inspector: HTMLElement;
}

const PREF = "efe.features";

export class FeaturesView {
  data: View | null = null;
  private code: HTMLTextAreaElement;
  private shade: HTMLElement;
  private gutter: HTMLElement;
  private problems: HTMLElement;
  private generated: HTMLElement;
  private status: HTMLElement;
  private timer = 0;
  private saving: Promise<void> = Promise.resolve();
  private previewText = "ሀለሐመ ሠረሰሸ ቀበተቸ";
  private off = new Set<string>();
  private on = new Set<string>();

  constructor(
    private root: HTMLElement,
    private host: FeaturesHost,
  ) {
    try {
      const p = JSON.parse(localStorage.getItem(PREF) ?? "{}");
      if (typeof p.text === "string") this.previewText = p.text;
    } catch {
      // This session only.
    }
    this.status = el("span", { class: "subtle fea-status" });
    const showGen = el("button", { class: "stage-btn", "aria-pressed": "false", title: "Show what the project writes before your code: language systems, classes and kerning" }, "Generated code");
    this.generated = el("pre", { class: "fea-generated", hidden: "" });
    showGen.addEventListener("click", () => {
      const open = this.generated.hidden === true;
      this.generated.hidden = !open;
      showGen.setAttribute("aria-pressed", String(open));
      showGen.classList.toggle("on", open);
    });
    this.code = el("textarea", { class: "fea-code", spellcheck: "false", autocomplete: "off", "aria-label": "Feature code", wrap: "off", placeholder: "# Your feature code. Glyphs can be typed as characters:\nfeature ss01 {\n  sub ሀ by ሀ.alt;\n} ss01;" }) as HTMLTextAreaElement;
    this.shade = el("pre", { class: "fea-shade", "aria-hidden": "true" });
    this.gutter = el("div", { class: "fea-gutter", "aria-hidden": "true" });
    this.problems = el("div", { class: "fea-problems", role: "status" });
    const editor = el("div", { class: "fea-editor" }, this.gutter, el("div", { class: "fea-layers" }, this.shade, this.code));
    root.append(
      el("div", { class: "stage-bar" }, el("div", { class: "stage-title" }, el("h1", { class: "stage-heading" }, "Features"), this.status), showGen),
      el("div", { class: "fea-wrap" }, this.generated, editor, this.problems),
    );
    this.code.addEventListener("input", () => {
      this.paint();
      this.queueSave();
    });
    this.code.addEventListener("scroll", () => {
      this.shade.scrollTop = this.code.scrollTop;
      this.shade.scrollLeft = this.code.scrollLeft;
      this.gutter.scrollTop = this.code.scrollTop;
    });
    this.code.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const r = indent(this.code.value, this.code.selectionStart, this.code.selectionEnd, e.shiftKey);
        this.code.value = r.text;
        this.code.setSelectionRange(r.start, r.end);
        this.paint();
        this.queueSave();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        // Save the project as usual; the code itself is already kept.
        window.clearTimeout(this.timer);
        void this.save();
      }
    });
  }

  isActive(): boolean {
    return !this.root.hidden;
  }

  /** The core leaves out empty fields. */
  private take(v: View): View {
    const f = v.features;
    return { ...v, features: { code: f.code ?? "", classes: f.classes ?? {}, languages: f.languages ?? [], set_names: f.set_names ?? {} } };
  }

  async show(): Promise<void> {
    try {
      this.data = this.take(await api.getFeatures());
    } catch (err) {
      this.host.toast(`Could not read the features: ${err}`, "error");
      return;
    }
    if (document.activeElement !== this.code) this.code.value = this.data.features.code;
    this.refresh();
  }

  refresh(): void {
    if (!this.data) return;
    this.generated.textContent = this.data.generated;
    this.paint();
    this.renderProblems();
    this.renderSidebar();
    this.renderInspector();
  }

  private errorLines(): Set<number> {
    return new Set((this.data?.messages ?? []).filter((m) => m.error && m.line).map((m) => m.line!));
  }

  private paint(): void {
    this.shade.innerHTML = highlight(this.code.value);
    const lines = this.code.value.split("\n").length;
    const bad = this.errorLines();
    const nums: Node[] = [];
    for (let i = 1; i <= lines; i++) nums.push(el("div", { class: bad.has(i) ? "bad" : "" }, String(i)));
    this.gutter.replaceChildren(...nums);
  }

  private renderProblems(): void {
    const d = this.data!;
    const errs = d.messages.filter((m) => m.error);
    this.status.textContent = d.ok ? (d.messages.length ? `${d.messages.length} warning${d.messages.length === 1 ? "" : "s"}` : "Compiles") : `${errs.length || 1} error${errs.length === 1 ? "" : "s"}`;
    this.status.classList.toggle("bad", !d.ok);
    this.problems.hidden = !d.messages.length;
    this.problems.replaceChildren(
      ...d.messages.map((m) => {
        const where = m.line ? `Line ${m.line}` : "Generated code";
        const row = el("button", { class: `fea-problem${m.error ? " error" : ""}`, title: m.line ? "Go to the line" : "In the part the project writes" }, el("span", { class: "fea-where" }, where), el("span", {}, m.message));
        row.addEventListener("click", () => this.goTo(m.line, m.column));
        return row;
      }),
    );
  }

  private goTo(line: number | null, column: number | null): void {
    if (!line) {
      if (this.generated.hidden) (this.root.querySelector(".stage-btn") as HTMLElement | null)?.click();
      return;
    }
    const lines = this.code.value.split("\n");
    let at = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) at += lines[i].length + 1;
    at += Math.max(0, (column ?? 1) - 1);
    this.code.focus();
    this.code.setSelectionRange(at, at);
    const lh = parseFloat(getComputedStyle(this.code).lineHeight) || 18;
    this.code.scrollTop = Math.max(0, (line - 4) * lh);
  }

  private queueSave(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.save(), 500);
  }

  /** Write the features and show what the compiler says. */
  async save(change?: (f: Features) => void): Promise<void> {
    if (!this.data) return;
    const f: Features = { ...this.data.features, code: this.code.value };
    change?.(f);
    this.saving = this.saving.then(async () => {
      try {
        this.data = this.take(await api.setFeatures(f));
        this.host.changed();
        this.paint();
        this.renderProblems();
        this.renderSidebar();
        this.renderInspector();
      } catch (err) {
        this.host.toast(`Could not save the features: ${err}`, "error");
      }
    });
    return this.saving;
  }

  // ---------- Left panel: features and classes ----------

  renderSidebar(): void {
    if (!this.isActive() || !this.data) return;
    const d = this.data;
    const rows: Node[] = [el("div", { class: "menu-label side-group" }, "Features")];
    if (!d.tags.length) rows.push(el("p", { class: "side-note" }, "None yet. Kerning appears here once there are pairs."));
    for (const t of d.tags) {
      const row = el("button", { class: "tree-row fea-tag-row", title: `Go to ${t}` }, el("span", { class: "tree-label" }, featureLabel(t)), el("span", { class: "tree-meta mono" }, t));
      row.addEventListener("click", () => {
        const i = this.code.value.search(new RegExp(`feature\\s+${t}\\b`));
        if (i >= 0) {
          this.goTo(this.code.value.slice(0, i).split("\n").length, 1);
        } else if (this.generated.hidden) {
          (this.root.querySelector(".stage-btn") as HTMLElement | null)?.click();
        }
      });
      rows.push(row);
    }

    rows.push(el("div", { class: "menu-label side-group", title: "Named groups of glyphs to use in the code as @name" }, "Classes"));
    for (const [name, members] of Object.entries(d.features.classes)) rows.push(this.classRow(name, members));
    const add = el("button", { class: "pill small ghost", title: "A named group of glyphs" }, "New class");
    add.addEventListener("click", () => {
      let n = 1;
      while (d.features.classes[`class${n}`]) n++;
      void this.save((f) => (f.classes = { ...f.classes, [`class${n}`]: [] }));
    });
    rows.push(el("div", { class: "button-row fea-add" }, add));

    if (d.kernClasses.length) {
      rows.push(el("div", { class: "menu-label side-group", title: "Kerning classes, named for use in the code. Edit them in the kerning view." }, "From kerning"));
      for (const [name, members] of d.kernClasses) {
        rows.push(el("div", { class: "tree-row fea-kern-class" }, el("span", { class: "tree-label mono" }, name), el("span", { class: "tree-meta", lang: "gez" }, members)));
      }
    }
    this.host.sideList.replaceChildren(...rows);
  }

  private classRow(name: string, members: string[]): HTMLElement {
    const nameIn = el("input", { type: "text", class: "fea-class-name mono", value: `@${name}`, spellcheck: "false", "aria-label": "Class name" }) as HTMLInputElement;
    const membersIn = el("input", { type: "text", class: "fea-class-members", value: membersText(members), spellcheck: "false", lang: "gez", placeholder: "Type glyphs", "aria-label": "Members" }) as HTMLInputElement;
    const del = el("button", { class: "icon-btn ds-remove", title: "Remove the class", "aria-label": "Remove the class" }, "×");
    nameIn.addEventListener("change", () => {
      const next = nameIn.value.trim().replace(/^@/, "");
      if (!next || next === name || this.data?.features.classes[next]) {
        nameIn.value = `@${name}`;
        return;
      }
      void this.save((f) => {
        const classes: Record<string, string[]> = {};
        for (const [k, v] of Object.entries(f.classes)) classes[k === name ? next : k] = v;
        f.classes = classes;
      });
    });
    membersIn.addEventListener("change", () => void this.save((f) => (f.classes = { ...f.classes, [name]: parseMembers(membersIn.value) })));
    del.addEventListener("click", () =>
      void this.save((f) => {
        const { [name]: _, ...rest } = f.classes;
        f.classes = rest;
      }),
    );
    return el("div", { class: "fea-class" }, el("div", { class: "ds-row" }, nameIn, del), membersIn);
  }

  // ---------- Right panel: languages, set names, preview ----------

  renderInspector(): void {
    if (!this.isActive() || !this.data) return;
    const d = this.data;
    const sections: Node[] = [];

    // Preview.
    const family = this.host.proofFamily();
    const enabled = new Set(d.tags.filter((t) => (onByDefault(t) ? !this.off.has(t) : this.on.has(t))));
    const sample = el("div", { class: "fea-preview", lang: "gez" }, this.previewText);
    sample.style.fontFamily = family ? `"${family}", var(--ethiopic)` : "var(--ethiopic)";
    sample.style.fontFeatureSettings = featureSettings(d.tags, enabled);
    const text = el("input", { type: "text", class: "text-line fea-preview-text", value: this.previewText, lang: "gez", "aria-label": "Preview text", spellcheck: "false" }) as HTMLInputElement;
    text.addEventListener("input", () => {
      this.previewText = text.value;
      sample.textContent = text.value;
      try {
        localStorage.setItem(PREF, JSON.stringify({ text: text.value }));
      } catch {
        // This session only.
      }
    });
    const toggles = el("div", { class: "fea-toggles", role: "group", "aria-label": "Features in the preview" });
    for (const t of d.tags) {
      const on = enabled.has(t);
      const b = el("button", { class: `fea-toggle${on ? " on" : ""}`, "aria-pressed": String(on), title: featureLabel(t) }, t);
      b.addEventListener("click", () => {
        const set = onByDefault(t) ? this.off : this.on;
        if (set.has(t)) set.delete(t);
        else set.add(t);
        this.renderInspector();
      });
      toggles.append(b);
    }
    sections.push(
      el("h3", { class: "section-label first", title: family ? "Set in the font as it exports now" : "Draw some glyphs to preview them in the font" }, "Preview"),
      el("div", { class: "side-box" }, text, sample, d.tags.length ? toggles : el("p", { class: "side-note" }, "No features to switch yet.")),
    );

    // Stylistic set names.
    const sets = stylisticSets(d.tags);
    if (sets.length) {
      const box = el("div", { class: "side-box" });
      for (const t of sets) {
        const input = el("input", { type: "text", value: d.features.set_names[t] ?? "", placeholder: featureLabel(t), spellcheck: "false" }) as HTMLInputElement;
        input.addEventListener("change", () =>
          void this.save((f) => {
            const names = { ...f.set_names };
            if (input.value.trim()) names[t] = input.value.trim();
            else delete names[t];
            f.set_names = names;
          }),
        );
        box.append(el("label", { class: "field", title: "Shown in apps' typography menus" }, el("span", {}, t), input));
      }
      sections.push(el("h3", { class: "section-label" }, "Stylistic set names"), box);
    }

    // Languages.
    const langs = el("div", { class: "side-box fea-langs" });
    for (const [script, tag, name] of d.languages) {
      const key = `${script}/${tag}`;
      const on = d.features.languages.includes(key);
      const box = el("input", { type: "checkbox" }) as HTMLInputElement;
      box.checked = on;
      box.addEventListener("change", () =>
        void this.save((f) => (f.languages = box.checked ? [...f.languages, key] : f.languages.filter((l) => l !== key))),
      );
      langs.append(el("label", { class: "check-row", title: `languagesystem ${script} ${tag}` }, box, el("span", {}, name), el("span", { class: "tree-meta mono" }, `${script} ${tag}`)));
    }
    sections.push(el("h3", { class: "section-label", title: "The scripts and languages every feature is registered for" }, "Languages"), langs);

    this.host.inspector.replaceChildren(el("div", { class: "inspector-body fea-side" }, ...sections));
  }
}
