import { describe, expect, it } from "vitest";
import { featureLabel, featureSettings, highlight, indent, membersText, parseMembers, stylisticSets } from "./features";

describe("feature code", () => {
  it("highlights comments, keywords, classes and numbers", () => {
    const h = highlight("feature kern { pos @L.ha uni1208 -20; } kern; # done");
    expect(h).toContain('<span class="fea-w">feature</span>');
    expect(h).toContain('<span class="fea-k">@L.ha</span>');
    expect(h).toContain('<span class="fea-n">-20</span>');
    expect(h).toContain('<span class="fea-c"># done</span>');
    expect(h).toContain("uni1208");
    expect(highlight("a < b")).toContain("&lt;");
  });

  it("reads class members", () => {
    expect(parseMembers("ሀለሐ uni1200 ሀ")).toEqual(["ሀ", "ለ", "ሐ", "uni1200"]);
    expect(membersText(["ሀ", "ለ", "uni1200", "ሐ"])).toBe("ሀለ uni1200 ሐ");
  });

  it("builds preview settings and labels", () => {
    expect(featureSettings(["kern", "ss01"], new Set(["kern"]))).toBe('"kern" 1, "ss01" 0');
    expect(featureSettings([], new Set())).toBe("normal");
    expect(stylisticSets(["kern", "ss01", "ss21", "ss20"])).toEqual(["ss01", "ss20"]);
    expect(featureLabel("ss03")).toBe("Stylistic set 3");
    expect(featureLabel("kern")).toBe("Kerning");
  });

  it("indents and outdents lines", () => {
    expect(indent("ab", 1, 1, false)).toEqual({ text: "a  b", start: 3, end: 3 });
    expect(indent("a\nb", 0, 3, false).text).toBe("  a\n  b");
    expect(indent("  a\n  b", 0, 7, true).text).toBe("a\nb");
  });
});
