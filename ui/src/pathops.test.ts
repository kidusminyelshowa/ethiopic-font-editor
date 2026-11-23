import { describe, expect, it } from "vitest";
import { contourPath, ellipseContour, isClockwise, rectContour, reversed, signedArea, toNodes, validate, type Contour } from "./geometry";
import {
  addExtremes,
  correctDirections,
  depths,
  evalNumber,
  extremeTs,
  insertPoint,
  makeTangent,
  outlineIssues,
  pointAt,
  pointType,
  polygonContour,
  removePointsKeepingShape,
  rotateAbout,
  roundedRectContour,
  scaleAbout,
  segments,
  setSegmentKind,
  setStartPoint,
  closestOnSegment,
  transformWhole,
  apply,
  skewAbout,
} from "./pathops";

const circle = () => ellipseContour(0, { x: 0, y: 0 }, { x: 200, y: 200 });

// Furthest distance from any sample of a to the outline of b.
function deviation(a: Contour, b: Contour): number {
  const target = segments(b);
  let worst = 0;
  for (const seg of segments(a)) {
    for (let i = 0; i <= 10; i++) {
      const p = pointAt(seg.pts, i / 10);
      let near = Infinity;
      for (const other of target) near = Math.min(near, closestOnSegment(other.pts, p).d);
      worst = Math.max(worst, near);
    }
  }
  return worst;
}

describe("transforms", () => {
  it("scales and rotates about an origin", () => {
    const m = scaleAbout({ x: 100, y: 100 }, 2, 2);
    expect(apply(m, { x: 150, y: 100 })).toEqual({ x: 200, y: 100 });
    const r = rotateAbout({ x: 0, y: 0 }, 90);
    const p = apply(r, { x: 10, y: 0 });
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(10);
    const k = apply(skewAbout({ x: 0, y: 0 }, 45), { x: 0, y: 100 });
    expect(k.x).toBeCloseTo(100);
  });

  it("keeps direction when mirroring whole contours", () => {
    const r = rectContour(0, { x: 0, y: 0 }, { x: 100, y: 50 });
    const out = transformWhole([r], scaleAbout({ x: 50, y: 25 }, -1, 1), new Set([0]));
    expect(isClockwise(out[0])).toBe(isClockwise(r));
    expect(validate(out[0])).toBeNull();
  });
});

describe("points on curves", () => {
  it("adds a point without changing the curve", () => {
    const c = circle();
    const { contour, id } = insertPoint(c, 0, 0.5);
    expect(validate(contour)).toBeNull();
    expect(toNodes(contour).map((n) => n.id)).toContain(id);
    expect(deviation(contour, c)).toBeLessThan(1.5);
  });

  it("adds a point on a line", () => {
    const r = rectContour(0, { x: 0, y: 0 }, { x: 100, y: 50 });
    const { contour } = insertPoint(r, 0, 0.25);
    expect(toNodes(contour).map((n) => n.pos)).toContainEqual({ x: 25, y: 0 });
  });

  it("removes a point and keeps the shape close", () => {
    const c = circle();
    const { contour, id } = insertPoint(c, 1, 0.4);
    const back = removePointsKeepingShape(contour, new Set([id]))!;
    expect(validate(back)).toBeNull();
    expect(toNodes(back)).toHaveLength(4);
    expect(deviation(back, c)).toBeLessThan(2);
  });

  it("refits one cubic across a removed smooth point of a circle", () => {
    const c = circle();
    const gone = toNodes(c)[1].id;
    const back = removePointsKeepingShape(c, new Set([gone]))!;
    expect(validate(back)).toBeNull();
    // A quarter circle twice as long can't be exact, but it stays close.
    expect(deviation(back, c)).toBeLessThan(25);
  });

  it("turns segments into curves and back", () => {
    const r = rectContour(0, { x: 0, y: 0 }, { x: 90, y: 90 });
    const ids = new Set(toNodes(r).slice(0, 2).map((n) => n.id));
    const curved = setSegmentKind(r, ids, "curve");
    expect(validate(curved)).toBeNull();
    expect(curved.points.filter((p) => p.kind === "offcurve")).toHaveLength(2);
    const back = setSegmentKind(curved, ids, "line");
    expect(contourPath(back)).toBe(contourPath(r));
  });

  it("makes a tangent point in line with its straight neighbour", () => {
    // Line from (0,0) to (100,0), then a curve up.
    const c: Contour = {
      id: 0,
      points: [
        { id: 0, pos: { x: 0, y: 0 }, kind: "line" },
        { id: 1, pos: { x: 100, y: 0 }, kind: "line" },
        { id: 2, pos: { x: 140, y: 20 }, kind: "offcurve" },
        { id: 3, pos: { x: 150, y: 60 }, kind: "offcurve" },
        { id: 4, pos: { x: 150, y: 100 }, kind: "curve" },
      ],
    };
    const t = makeTangent(c, new Set([1]));
    const h = t.points.find((p) => p.id === 2)!;
    expect(h.pos.y).toBe(0);
    expect(pointType(t, t.points.findIndex((p) => p.id === 1))).toBe("tangent");
  });

  it("moves the start point and keeps the outline", () => {
    const c = circle();
    const id = toNodes(c)[2].id;
    const s = setStartPoint(c, id);
    expect(s.points[0].id).toBe(id);
    expect(validate(s)).toBeNull();
    expect(Math.abs(signedArea(s))).toBeCloseTo(Math.abs(signedArea(c)));
  });
});

describe("direction and checks", () => {
  it("finds counters by containment and corrects direction", () => {
    const outer = rectContour(0, { x: 0, y: 0 }, { x: 300, y: 300 });
    const counter = rectContour(1, { x: 100, y: 100 }, { x: 200, y: 200 });
    expect(depths([outer, counter])).toEqual([0, 1]);
    const fixed = correctDirections([reversed(outer), counter]);
    expect(isClockwise(fixed[0])).toBe(false);
    expect(isClockwise(fixed[1])).toBe(true);
  });

  it("flags and adds missing extremes", () => {
    // A curve bulging past its end points with no point at the top.
    const c: Contour = {
      id: 0,
      points: [
        { id: 0, pos: { x: 0, y: 0 }, kind: "line" },
        { id: 1, pos: { x: 200, y: 0 }, kind: "line" },
        { id: 2, pos: { x: 200, y: 200 }, kind: "offcurve" },
        { id: 3, pos: { x: 0, y: 200 }, kind: "offcurve" },
        { id: 4, pos: { x: 0, y: 0 }, kind: "curve" },
      ],
    };
    expect(extremeTs([{ x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }, { x: 0, y: 0 }]).length).toBeGreaterThan(0);
    expect(outlineIssues([c]).some((i) => i.kind === "extremes")).toBe(true);
    const fixed = addExtremes(c);
    expect(validate(fixed)).toBeNull();
    expect(outlineIssues([fixed]).some((i) => i.kind === "extremes")).toBe(false);
  });

  it("a clean circle has no issues", () => {
    expect(outlineIssues([circle()])).toEqual([]);
  });
});

describe("shapes", () => {
  it("rounded rectangle, polygon and star are valid and counter-clockwise", () => {
    for (const c of [
      roundedRectContour(0, { x: 0, y: 0 }, { x: 200, y: 100 }, 30),
      roundedRectContour(0, { x: 0, y: 0 }, { x: 200, y: 100 }, 0),
      polygonContour(0, { x: 0, y: 0 }, { x: 200, y: 200 }, 6),
      polygonContour(0, { x: 0, y: 0 }, { x: 200, y: 200 }, 5, 0.45),
    ]) {
      expect(validate(c)).toBeNull();
      expect(isClockwise(c)).toBe(false);
    }
    expect(polygonContour(0, { x: 0, y: 0 }, { x: 200, y: 200 }, 5, 0.4).points).toHaveLength(10);
  });
});

describe("number fields", () => {
  it("does simple arithmetic", () => {
    expect(evalNumber("120/6")).toBe(20);
    expect(evalNumber(" 500 + 20*2 ")).toBe(540);
    expect(evalNumber("-(3+4)")).toBe(-7);
    expect(evalNumber("12.5")).toBe(12.5);
    expect(evalNumber("alert(1)")).toBeNull();
    expect(evalNumber("3+")).toBeNull();
  });
});
