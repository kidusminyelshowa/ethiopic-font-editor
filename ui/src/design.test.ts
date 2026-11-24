import { describe, expect, it } from "vitest";
import type { DesignData } from "./api";
import { formatMap, instancesFromMasters, nextAxis, nextMasterLocation, parseMap, styleName, toDesign, toUser } from "./design";

const wght = { tag: "wght", name: "Weight", min: 100, default: 400, max: 900 };
const d = (masters: Record<string, number>[]): DesignData => ({
  axes: [wght],
  masters: masters.map((location, i) => ({ id: `m${i}`, name: "", location })),
  instances: [],
  active: 0,
  default: 0,
  problem: null,
  incompatible: [],
});

describe("design space", () => {
  it("names styles", () => {
    expect(styleName([wght], { wght: 700 })).toBe("Bold");
    expect(styleName([wght], { wght: 400 })).toBe("Regular");
    expect(styleName([wght, { tag: "wdth", name: "Width", min: 75, default: 100, max: 100 }], { wght: 300, wdth: 75 })).toBe("Condensed Light");
  });

  it("suggests axes and master locations", () => {
    expect(nextAxis([]).tag).toBe("wght");
    expect(nextAxis([wght]).tag).toBe("wdth");
    expect(nextMasterLocation(d([{ wght: 400 }]))).toEqual({ wght: 900 });
    expect(nextMasterLocation(d([{ wght: 400 }, { wght: 900 }]))).toEqual({ wght: 100 });
  });

  it("makes instances from masters", () => {
    expect(instancesFromMasters(d([{ wght: 400 }, { wght: 900 }])).map((i) => i.name)).toEqual(["Regular", "Black"]);
  });

  it("maps user to design units and back", () => {
    const a = { ...wght, map: [[100, 100], [400, 400], [700, 500], [900, 900]] as [number, number][] };
    expect(toDesign(a, 700)).toBe(500);
    expect(toDesign(a, 550)).toBe(450);
    expect(toUser(a, 450)).toBe(550);
    expect(parseMap("100>100, 700 > 500")).toEqual([[100, 100], [700, 500]]);
    expect(parseMap("oops")).toBeNull();
    expect(formatMap([[1, 2]])).toBe("1>2");
  });
});
