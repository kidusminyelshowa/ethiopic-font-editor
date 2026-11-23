import { describe, expect, it } from "vitest";
import {
  constrain45,
  contourPath,
  ellipseContour,
  fromNodes,
  mirrorSmooth,
  rectContour,
  toNodes,
  validate,
  type Contour,
} from "./geometry";

const circle: Contour = {
  id: 0,
  points: [
    { id: 0, pos: { x: 100, y: 0 }, kind: "curve", smooth: true },
    { id: 1, pos: { x: 155, y: 0 }, kind: "offcurve" },
    { id: 2, pos: { x: 200, y: 45 }, kind: "offcurve" },
    { id: 3, pos: { x: 200, y: 100 }, kind: "curve", smooth: true },
    { id: 4, pos: { x: 200, y: 155 }, kind: "offcurve" },
    { id: 5, pos: { x: 155, y: 200 }, kind: "offcurve" },
    { id: 6, pos: { x: 100, y: 200 }, kind: "curve" },
    { id: 7, pos: { x: 0, y: 100 }, kind: "line" },
    { id: 8, pos: { x: 0, y: 45 }, kind: "offcurve" },
    { id: 9, pos: { x: 45, y: 0 }, kind: "offcurve" },
  ],
};

describe("geometry", () => {
  it("matches the core's SVG path output", () => {
    expect(contourPath(circle)).toBe("M100 0C155 0 200 45 200 100C200 155 155 200 100 200L0 100C0 45 45 0 100 0Z");
  });

  it("round-trips through nodes keeping point ids", () => {
    const nodes = toNodes(circle);
    expect(nodes.map((n) => n.id)).toEqual([0, 3, 6, 7]);
    expect(nodes[0].in?.id).toBe(9);
    expect(nodes[0].out?.id).toBe(1);
    const back = fromNodes(nodes, 0, null, 10);
    expect(validate(back)).toBeNull();
    expect(contourPath(back)).toBe(contourPath(circle));
    expect(new Set(back.points.map((p) => p.id))).toEqual(new Set(circle.points.map((p) => p.id)));
  });

  it("removing a node keeps the contour valid and adds handles only where needed", () => {
    const nodes = toNodes(circle).filter((n) => n.id !== 3);
    const back = fromNodes(nodes, 0, null, 10);
    expect(validate(back)).toBeNull();
    expect(back.points.filter((p) => p.kind !== "offcurve").map((p) => p.id).sort()).toEqual([0, 6, 7]);
  });

  it("validates like the core", () => {
    const bad = structuredClone(circle);
    bad.points[3].kind = "line";
    expect(validate(bad)).toBe("handles before a line point");
    const dup = structuredClone(circle);
    dup.points[1].id = 0;
    expect(validate(dup)).toMatch(/duplicate/);
  });

  it("keeps a smooth point's handles in line", () => {
    const c = structuredClone(circle);
    // Move the handle before point 3 (index 2) to the left; index 4 should follow.
    c.points[2].pos = { x: 200, y: 20 };
    mirrorSmooth(c, 2);
    expect(c.points[4].pos.x).toBeCloseTo(200);
    expect(c.points[4].pos.y).toBeCloseTo(155);
    c.points[2].pos = { x: 180, y: 50 };
    mirrorSmooth(c, 2);
    const a = Math.atan2(100 - 50, 200 - 180);
    const b = Math.atan2(c.points[4].pos.y - 100, c.points[4].pos.x - 200);
    expect(a).toBeCloseTo(b);
  });
});

describe("shapes and constraints", () => {
  it("snaps a drag to 0, 45 and 90 degrees", () => {
    expect(constrain45({ x: 0, y: 0 }, { x: 100, y: 7 })).toEqual({ x: 100, y: 0 });
    expect(constrain45({ x: 0, y: 0 }, { x: 4, y: -90 })).toEqual({ x: 0, y: -90 });
    const d = constrain45({ x: 0, y: 0 }, { x: 50, y: 55 });
    expect(Math.abs(d.x - d.y)).toBeLessThan(1e-9);
  });

  it("makes valid rectangles and ellipses", () => {
    const r = rectContour(3, { x: 10, y: 50 }, { x: -20, y: 0 });
    expect(validate(r)).toBeNull();
    expect(r.points.map((p) => p.pos)).toEqual([
      { x: -20, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 50 },
      { x: -20, y: 50 },
    ]);
    const e = ellipseContour(4, { x: 0, y: 0 }, { x: 200, y: 100 });
    expect(validate(e)).toBeNull();
    expect(e.points.filter((p) => p.kind === "curve")).toHaveLength(4);
    expect(e.points).toHaveLength(12);
  });
});
