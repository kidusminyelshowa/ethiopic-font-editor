import { describe, expect, it } from "vitest";
import type { KerningData } from "./api";
import { editKey, isException, kernString, layoutLine, listPairs, resolve, sampleOf } from "./kerning";

const k: KerningData = {
  leftClasses: [{ name: "ha", members: "ሀሁሂ" }],
  rightClasses: [{ name: "la", members: "ለሉ" }],
  pairs: [
    { left: "@ha", right: "@la", value: -40 },
    { left: "@ha", right: "ሉ", value: -20 },
    { left: "ሀ", right: "ለ", value: 0 },
    { left: "ሂ", right: "@la", value: -10 },
    { left: "ለ", right: "ሀ", value: 15 },
  ],
};

describe("kerning", () => {
  it("resolves the most specific pair", () => {
    expect(resolve(k, "ሀ", "ለ")).toEqual({ value: 0, source: "exception", left: "ሀ", right: "ለ" });
    expect(resolve(k, "ሂ", "ሉ")?.value).toBe(-10);
    expect(resolve(k, "ሁ", "ሉ")?.value).toBe(-20);
    expect(resolve(k, "ሁ", "ለ")).toEqual({ value: -40, source: "pair", left: "@ha", right: "@la" });
    expect(resolve(k, "ለ", "ሀ")?.source).toBe("pair");
    expect(resolve(k, "ሉ", "ሀ")).toBeNull();
  });

  it("edits the class pair unless a side is locked", () => {
    expect(editKey(k, "ሁ", "ለ", false, false)).toEqual(["@ha", "@la"]);
    expect(editKey(k, "ሁ", "ለ", true, false)).toEqual(["ሁ", "@la"]);
    expect(editKey(k, "ለ", "ሀ", false, false)).toEqual(["ለ", "ሀ"]);
  });

  it("marks exceptions and sorts pairs", () => {
    expect(k.pairs.map((p) => isException(k, p))).toEqual([false, true, true, true, false]);
    expect(listPairs(k, "", "value").map((p) => p.value)).toEqual([-40, -20, 15, -10, 0]);
    expect(listPairs(k, "@la", "name")).toHaveLength(2);
    expect(sampleOf(k, "left", "@ha")).toBe("ሀ");
  });

  it("builds kerning strings with one glyph per class", () => {
    expect(kernString(k, "ሀ", ["ለ", "ሉ", "መ", "ሀ"])).toBe("ሀለሀመሀ");
  });

  it("lays out a line with kerning", () => {
    expect(layoutLine(["a", "b", "c"], () => 100, (l) => (l === "a" ? -10 : 0))).toEqual([0, 90, 190, 290]);
  });
});
