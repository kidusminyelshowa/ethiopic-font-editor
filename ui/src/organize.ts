// Finding and organizing glyphs in the grid: search, filter criteria,
// colour marks, tags and notes.

import type { FidelGrid, StateKind } from "./api";

export type MarkColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "gray";
export const MARK_COLORS: MarkColor[] = ["red", "orange", "yellow", "green", "blue", "purple", "gray"];

export interface GlyphMark {
  color?: MarkColor | null;
  tags?: string[];
  note?: string;
}

export interface SmartFilter {
  name: string;
  query?: string;
  rules?: string[];
}

export interface OrganizeView {
  marks: Record<string, GlyphMark>;
  filters: SmartFilter[];
  tags: string[];
  /** Drawings with a background layer, as `base:la`. */
  backgrounds: string[];
}

export const EMPTY_ORGANIZE: OrganizeView = { marks: {}, filters: [], tags: [], backgrounds: [] };

/** One glyph as the grid lists it. */
export interface GlyphItem {
  /** `fidel:ha/kaib` or `symbol:uni1361`. */
  key: string;
  char: string;
  /** The name it gets in the font, `uni1200`. */
  glyphName: string;
  family: string | null;
  familyName: string;
  order: string | null;
  orderName: string;
  state: StateKind | null;
  drawn: boolean;
  width: number | null;
  /** The drawing behind it, for "has background": `base:ha` or `fidel:ha/kaib`. */
  drawings: string[];
}

export function glyphName(ch: string): string {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return "";
  const hex = cp.toString(16).toUpperCase();
  return cp > 0xffff ? `u${hex}` : `uni${hex.padStart(4, "0")}`;
}

export const unicodeOf = (ch: string) => {
  const cp = ch.codePointAt(0);
  return cp === undefined ? "" : `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
};

/** Every glyph in the grid, fidel by row then symbols. */
export function glyphItems(grid: FidelGrid): GlyphItem[] {
  const orderName = new Map(grid.orders.map((o) => [o.order, o.name]));
  const out: GlyphItem[] = [];
  for (const row of grid.rows) {
    for (const cell of row.cells) {
      const ch = cell.codepoint ?? "";
      out.push({
        key: `fidel:${row.family}/${cell.order}`,
        char: ch,
        glyphName: ch ? glyphName(ch) : "",
        family: row.family,
        familyName: row.name,
        order: cell.order,
        orderName: orderName.get(cell.order) ?? cell.order,
        state: cell.state,
        drawn: !!cell.outline,
        width: cell.outline?.advanceWidth ?? null,
        drawings: cell.order === "giiz" ? [`base:${row.base}`, `fidel:${row.family}/${cell.order}`] : [`fidel:${row.family}/${cell.order}`],
      });
    }
  }
  for (const s of grid.symbols) {
    out.push({
      key: `symbol:${s.id}`,
      char: s.codepoint,
      glyphName: glyphName(s.codepoint),
      family: null,
      familyName: s.name,
      order: null,
      orderName: "Symbol",
      state: null,
      drawn: !!s.outline,
      width: s.outline?.advanceWidth ?? null,
      drawings: [`symbol:${s.id}`],
    });
  }
  return out;
}

/** The mark on a glyph, falling back to nothing. */
const markOf = (o: OrganizeView, key: string): GlyphMark => o.marks[key] ?? {};

/** Does the glyph match every word of the search? A word matches the
 * character, its Unicode (`U+1200` or `1200`), its glyph name, family,
 * order, tags or note. */
export function matchesQuery(item: GlyphItem, query: string, o: OrganizeView): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const mark = markOf(o, item.key);
  const familyMark = item.family ? markOf(o, `family:${item.family}`) : {};
  const code = unicodeOf(item.char).toLowerCase();
  const hay = [
    item.glyphName.toLowerCase(),
    item.familyName.toLowerCase(),
    item.orderName.toLowerCase(),
    (item.order ?? "").toLowerCase(),
    ...(mark.tags ?? []).map((t) => t.toLowerCase()),
    (mark.note ?? "").toLowerCase(),
    (familyMark.note ?? "").toLowerCase(),
  ];
  return words.every((w) => {
    if (item.char && w === item.char.toLowerCase()) return true;
    // A typed fidel among other characters: any character of it.
    if ([...w].some((c) => c.codePointAt(0)! >= 0x1200 && c.codePointAt(0)! <= 0x139f)) return [...w].includes(item.char);
    const hex = w.replace(/^u\+/, "");
    if (/^[0-9a-f]{4,5}$/.test(hex) && code === `u+${hex}`) return true;
    return hay.some((h) => h.includes(w));
  });
}

/** Criteria: `state:adjusted`, `color:red`, `tag:review`, `has:note`,
 * `has:background`, `not:drawn`. All must hold. */
export function matchesRules(item: GlyphItem, rules: string[], o: OrganizeView): boolean {
  const mark = markOf(o, item.key);
  return rules.every((r) => {
    const [kind, value] = r.split(":", 2);
    switch (kind) {
      case "state":
        return item.state === value;
      case "color":
        return mark.color === value;
      case "tag":
        return (mark.tags ?? []).some((t) => t.toLowerCase() === value.toLowerCase());
      case "has":
        if (value === "note") return !!mark.note?.trim();
        if (value === "background") return item.drawings.some((d) => o.backgrounds.includes(d));
        if (value === "mark") return !!mark.color || !!mark.tags?.length;
        return true;
      case "not":
        if (value === "drawn") return !item.drawn;
        return true;
      default:
        return true;
    }
  });
}

/** How a criterion reads in the filter menu. */
export function ruleLabel(rule: string): string {
  const [kind, value] = rule.split(":", 2);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (kind === "has") return value === "note" ? "Has a note" : value === "background" ? "Has a background layer" : "Marked";
  if (kind === "not" && value === "drawn") return "Not drawn yet";
  if (kind === "tag") return `Tagged ${value}`;
  return cap(value);
}

/** Add a criterion, replacing another of the same kind for state and colour. */
export function toggleRule(rules: string[], rule: string): string[] {
  if (rules.includes(rule)) return rules.filter((r) => r !== rule);
  const kind = rule.split(":")[0];
  const single = kind === "state" || kind === "color";
  return [...rules.filter((r) => !single || r.split(":")[0] !== kind), rule];
}
