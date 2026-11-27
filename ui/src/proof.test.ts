import { describe, expect, it } from "vitest";
import { resolveEscapes, templates } from "./proof";

describe("proof", () => {
  it("types characters by their Unicode escapes", () => {
    expect(resolveEscapes("U+1200 \\u1208 \\u{1210} u+1218x")).toBe("ሀ ለ ሐ መx");
    expect(resolveEscapes("U+12")).toBe("U+12");
  });

  it("builds templates from what the font covers", () => {
    const t = templates({
      rows: () => [
        { base: "ሀ", orders: ["ሀ", "ሁ"], extras: [] },
        { base: "ለ", orders: ["ለ", "ሉ"], extras: ["ሏ"] },
      ],
      symbols: () => ["፩", "።"],
      testInstall: () => {},
    });
    const by = (id: string) => t.find((x) => x.id === id)!.text();
    expect(by("orders")).toBe("ሀ ሁ\nለ ሉ");
    expect(by("labialized")).toBe("ሏ");
    expect(by("symbols")).toBe("፩ ።");
    expect(by("spacing").split("\n")[1]).toBe("ሀሀለሀሀለሀለለሀ");
  });
});
