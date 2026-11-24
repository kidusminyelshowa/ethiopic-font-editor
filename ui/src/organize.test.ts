import { describe, expect, it } from "vitest";
import { glyphName, matchesQuery, matchesRules, toggleRule, type GlyphItem, type OrganizeView } from "./organize";

const item = (over: Partial<GlyphItem> = {}): GlyphItem => ({
  key: "fidel:ha/kaib",
  char: "ሁ",
  glyphName: "uni1201",
  family: "ha",
  familyName: "Ha",
  order: "kaib",
  orderName: "Kaib",
  state: "adjusted",
  drawn: true,
  width: 600,
  drawings: ["fidel:ha/kaib"],
  ...over,
});
const org = (over: Partial<OrganizeView> = {}): OrganizeView => ({ marks: {}, filters: [], tags: [], backgrounds: [], ...over });

describe("search", () => {
  it("finds a glyph by character, Unicode, name, family and order", () => {
    const o = org();
    for (const q of ["ሁ", "U+1201", "1201", "uni1201", "ha", "kaib", "ha kaib", "ሀሁሂ"]) expect(matchesQuery(item(), q, o), q).toBe(true);
    for (const q of ["ሂ", "1202", "la", "ha salis"]) expect(matchesQuery(item(), q, o), q).toBe(false);
  });

  it("finds tags and notes, the family's note too", () => {
    const o = org({ marks: { "fidel:ha/kaib": { tags: ["Review"] }, "family:ha": { note: "Wide counter" } } });
    expect(matchesQuery(item(), "review", o)).toBe(true);
    expect(matchesQuery(item(), "counter", o)).toBe(true);
  });
});

describe("criteria", () => {
  it("checks state, colour, tags, notes, backgrounds and drawing", () => {
    const o = org({ marks: { "fidel:ha/kaib": { color: "red", tags: ["review"], note: "x" } }, backgrounds: ["fidel:ha/kaib"] });
    expect(matchesRules(item(), ["state:adjusted", "color:red", "tag:Review", "has:note", "has:background"], o)).toBe(true);
    expect(matchesRules(item(), ["state:linked"], o)).toBe(false);
    expect(matchesRules(item(), ["not:drawn"], o)).toBe(false);
    expect(matchesRules(item({ key: "fidel:ha/salis" }), ["has:note"], o)).toBe(false);
  });

  it("keeps one state and one colour at a time", () => {
    expect(toggleRule(["state:linked", "tag:a"], "state:adjusted")).toEqual(["tag:a", "state:adjusted"]);
    expect(toggleRule(["tag:a"], "tag:b")).toEqual(["tag:a", "tag:b"]);
    expect(toggleRule(["tag:a"], "tag:a")).toEqual([]);
  });

  it("names glyphs as the font does", () => {
    expect(glyphName("ሀ")).toBe("uni1200");
    expect(glyphName("A")).toBe("uni0041");
  });
});
