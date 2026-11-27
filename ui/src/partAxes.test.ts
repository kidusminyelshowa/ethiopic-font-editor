import { describe, expect, it } from "vitest";
import { newAxis, nextStateLocation, stateId, stateLabel, stateRef } from "./partAxes";

const size = { name: "Size", min: 0, default: 0, max: 100 };
const width = { name: "Width", min: -50, default: 0, max: 50 };

describe("part axes", () => {
  it("reads and writes state ids", () => {
    expect(stateRef("leaf")).toEqual({ part: "leaf", state: null });
    expect(stateRef("leaf#2")).toEqual({ part: "leaf", state: 1 });
    expect(stateRef("leaf#0")).toEqual({ part: "leaf#0", state: null });
    expect(stateId("leaf", 1)).toBe("leaf#2");
    expect(stateId("leaf", null)).toBe("leaf");
  });

  it("names new axes apart", () => {
    expect(newAxis([]).name).toBe("Size");
    expect(newAxis([size]).name).toBe("Size 2");
  });

  it("puts new states at free ends, then the corner", () => {
    expect(nextStateLocation([size], [])).toEqual({ Size: 100 });
    expect(nextStateLocation([size, width], [{ Size: 100 }, { Width: 50 }])).toEqual({ Width: -50 });
    expect(nextStateLocation([size, width], [{ Size: 100 }, { Width: 50 }, { Width: -50 }])).toEqual({ Size: 100, Width: 50 });
  });

  it("labels states by what differs from the default", () => {
    expect(stateLabel([size, width], { Size: 100, Width: 0 })).toBe("Size 100");
    expect(stateLabel([size], {})).toBe("Default");
  });
});
