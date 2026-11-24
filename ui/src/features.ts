// OpenType feature code: highlighting, class members and preview settings.

const KEYWORDS = new Set([
  "feature",
  "lookup",
  "languagesystem",
  "script",
  "language",
  "sub",
  "substitute",
  "by",
  "from",
  "pos",
  "position",
  "enum",
  "ignore",
  "lookupflag",
  "markClass",
  "anchor",
  "mark",
  "base",
  "ligature",
  "cursive",
  "include",
  "table",
  "featureNames",
  "name",
  "useExtension",
  "exclude_dflt",
  "include_dflt",
  "required",
  "RightToLeft",
  "IgnoreMarks",
  "IgnoreBaseGlyphs",
  "IgnoreLigatures",
  "UseMarkFilteringSet",
  "MarkAttachmentType",
  "NULL",
]);

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Feature code as HTML with spans for comments, strings, keywords, classes and numbers. */
export function highlight(code: string): string {
  const re = /(#[^\n]*)|("(?:[^"\\]|\\.)*"?)|(@[A-Za-z0-9_.\-]+)|(-?\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_.\-]*)/g;
  let out = "";
  let last = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    out += escapeHtml(code.slice(last, m.index));
    const [t, comment, str, cls, num, word] = m;
    const cls_ = comment ? "c" : str ? "s" : cls ? "k" : num ? "n" : word && KEYWORDS.has(word) ? "w" : null;
    out += cls_ ? `<span class="fea-${cls_}">${escapeHtml(t)}</span>` : escapeHtml(t);
    last = m.index + t.length;
  }
  // A trailing newline needs a character after it to take up a line.
  return out + escapeHtml(code.slice(last)) + "\n";
}

/** Members typed as text: glyph names split on spaces, Ethiopic one per character. */
export function parseMembers(text: string): string[] {
  const out: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (/^[\x21-\x7e]+$/.test(word)) out.push(word);
    else for (const c of word) out.push(c);
  }
  return out.filter((m, i) => out.indexOf(m) === i);
}

export function membersText(members: string[]): string {
  let out = "";
  members.forEach((m, i) => {
    const prev = members[i - 1];
    const glued = prev && [...m].length === 1 && [...prev].length === 1 && !/^[\x21-\x7e]$/.test(m) && !/^[\x21-\x7e]$/.test(prev);
    out += (i && !glued ? " " : "") + m;
  });
  return out;
}

/** Features browsers switch on by themselves. */
const ON_BY_DEFAULT = new Set(["kern", "liga", "calt", "ccmp", "locl", "mark", "mkmk", "rlig", "clig", "curs", "rclt", "abvm", "blwm", "dist"]);

export function onByDefault(tag: string): boolean {
  return ON_BY_DEFAULT.has(tag);
}

/** The CSS `font-feature-settings` for these features, each on or off. */
export function featureSettings(tags: string[], on: Set<string>): string {
  return tags.map((t) => `"${t}" ${on.has(t) ? 1 : 0}`).join(", ") || "normal";
}

/** Stylistic sets among the tags. */
export function stylisticSets(tags: string[]): string[] {
  return tags.filter((t) => /^ss(0[1-9]|1\d|20)$/.test(t));
}

/** Readable names for common feature tags. */
export const FEATURE_NAMES: Record<string, string> = {
  kern: "Kerning",
  liga: "Standard ligatures",
  dlig: "Discretionary ligatures",
  calt: "Contextual alternates",
  ccmp: "Glyph composition",
  locl: "Localized forms",
  mark: "Mark positioning",
  mkmk: "Mark to mark",
  salt: "Stylistic alternates",
  case: "Case-sensitive forms",
  frac: "Fractions",
  lnum: "Lining figures",
  onum: "Oldstyle figures",
  tnum: "Tabular figures",
  pnum: "Proportional figures",
  zero: "Slashed zero",
  aalt: "Access all alternates",
};

export function featureLabel(tag: string): string {
  if (FEATURE_NAMES[tag]) return FEATURE_NAMES[tag];
  const ss = /^ss(\d\d)$/.exec(tag);
  if (ss) return `Stylistic set ${Number(ss[1])}`;
  const cv = /^cv(\d\d)$/.exec(tag);
  if (cv) return `Character variant ${Number(cv[1])}`;
  return tag;
}

/** Two spaces for a tab, and the selection after it. */
export function indent(text: string, start: number, end: number, outdent: boolean): { text: string; start: number; end: number } {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (start === end && !outdent) return { text: text.slice(0, start) + "  " + text.slice(end), start: start + 2, end: start + 2 };
  const block = text.slice(lineStart, end);
  const lines = block.split("\n");
  const changed = lines.map((l) => (outdent ? l.replace(/^ {1,2}/, "") : "  " + l));
  const delta0 = changed[0].length - lines[0].length;
  const total = changed.join("\n").length - block.length;
  return {
    text: text.slice(0, lineStart) + changed.join("\n") + text.slice(end),
    start: Math.max(lineStart, start + delta0),
    end: end + total,
  };
}
