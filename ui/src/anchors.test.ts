import { describe, expect, it } from "vitest";
import { isAccent, joinsAsAccent, parseParts, presetPosition, showPart } from "./anchors";

const box = { minX: 100, minY: 0, maxX: 500, maxY: 700 };

describe("anchors", () => {
  it("places presets on the drawing", () => {
    expect(presetPosition("top", box, 600)).toEqual({ x: 300, y: 700 });
    expect(presetPosition("bottom", box, 600)).toEqual({ x: 300, y: 0 });
    expect(presetPosition("ogonek", box, 600)).toEqual({ x: 500, y: 0 });
    expect(presetPosition("_top", box, 600)).toEqual({ x: 300, y: 0 });
    expect(presetPosition("top", null, 600)).toEqual({ x: 300, y: 0 });
  });

  it("reads and shows parts", () => {
    expect(parseParts("A ◌̀")).toBe("À");
    expect(parseParts("A uni0301 U+0308")).toBe("Á̈");
    expect(showPart("̀")).toBe("◌̀");
    expect(showPart("A")).toBe("A");
    expect(isAccent("፟")).toBe(true);
  });

  it("tells accents from letters", () => {
    expect(joinsAsAccent({ _top: {} }, "x")).toBe(true);
    expect(joinsAsAccent({ top: {} }, "A")).toBe(false);
    expect(joinsAsAccent({}, "́")).toBe(true);
  });
});
