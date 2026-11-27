import { describe, expect, it } from "vitest";
import { ellipseContour, rectContour } from "./geometry";
import { clipLine, crossings, distanceToGuide, fmt, projectOnGuide, rulerTicks, type Guide } from "./guides";

const g = (angle: number): Guide => ({ id: 1, x: 100, y: 200, angle });

describe("guides", () => {
  it("measures distance to horizontal, vertical and slanted guides", () => {
    expect(distanceToGuide(g(0), { x: 500, y: 230 })).toBeCloseTo(30);
    expect(distanceToGuide(g(90), { x: 140, y: -900 })).toBeCloseTo(40);
    expect(distanceToGuide(g(45), { x: 200, y: 300 })).toBeCloseTo(0);
    const p = projectOnGuide(g(45), { x: 200, y: 200 });
    expect(p.x).toBeCloseTo(150);
    expect(p.y).toBeCloseTo(250);
  });

  it("clips a line to the view", () => {
    expect(clipLine({ x: 50, y: 40 }, { x: 1, y: 0 }, 300, 200)).toEqual([
      { x: 0, y: 40 },
      { x: 300, y: 40 },
    ]);
    expect(clipLine({ x: 50, y: 400 }, { x: 1, y: 0 }, 300, 200)).toBeNull();
    const diag = clipLine({ x: 0, y: 0 }, { x: Math.SQRT1_2, y: Math.SQRT1_2 }, 100, 200)!;
    expect(diag[1].x).toBeCloseTo(100);
    expect(diag[1].y).toBeCloseTo(100);
  });
});

describe("rulers", () => {
  it("picks a round step that leaves room for labels", () => {
    const t = rulerTicks(0, 1000, 0.5);
    expect(t.step).toBe(200);
    expect(t.major).toEqual([0, 200, 400, 600, 800, 1000]);
    expect(t.minor.length).toBeGreaterThan(0);
    expect(rulerTicks(0, 100, 4).step).toBe(20);
  });
});

describe("measuring line", () => {
  it("finds both sides of a stem", () => {
    const stem = rectContour(0, { x: 100, y: 0 }, { x: 180, y: 700 });
    const hits = crossings([stem], { x: 0, y: 300 }, { x: 400, y: 300 });
    expect(hits.map((h) => h.at.x)).toEqual([100, 180]);
  });

  it("reads a curved counter true", () => {
    const ring = ellipseContour(0, { x: 0, y: 0 }, { x: 400, y: 400 });
    const hits = crossings([ring], { x: -50, y: 200 }, { x: 450, y: 200 });
    expect(hits).toHaveLength(2);
    expect(hits[1].at.x - hits[0].at.x).toBeCloseTo(400, 1);
    expect(fmt(hits[1].at.x - hits[0].at.x)).toBe("400");
  });
});
