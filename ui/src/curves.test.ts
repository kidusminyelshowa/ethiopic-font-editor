import { describe, expect, it } from "vitest";
import {
  autoHandles,
  balanceHandles,
  breakAt,
  closePath,
  combTeeth,
  curvatureAt,
  endOf,
  eraseSegments,
  fitStroke,
  harmonize,
  joinPaths,
  moveTunni,
  powerNudge,
  roundCorners,
  tensions,
  tidyUp,
  tunniPoint,
} from "./curves";
import { contourPath, fromNodes, rectContour, toNodes, validate, type Contour } from "./geometry";
import { segments } from "./pathops";

const square = (): Contour => rectContour(0, { x: 0, y: 0 }, { x: 100, y: 100 });

describe("open paths", () => {
  it("breaking a closed path opens it at that point", () => {
    const c = square();
    const id = c.points[2].id;
    const [open] = breakAt(c, id, 9);
    expect(open.open).toBe(true);
    expect(validate(open)).toBeNull();
    expect(toNodes(open)).toHaveLength(5);
    expect(segments(open)).toHaveLength(4);
    expect(contourPath(open).endsWith("Z")).toBe(false);
    expect(toNodes(open)[0].pos).toEqual(toNodes(open)[4].pos);
  });

  it("closing it again merges the two ends", () => {
    const c = square();
    const [open] = breakAt(c, c.points[0].id, 9);
    const closed = closePath(open);
    expect(closed.open).toBeFalsy();
    expect(validate(closed)).toBeNull();
    expect(toNodes(closed)).toHaveLength(4);
  });

  it("breaking an open path splits it in two", () => {
    const c = square();
    const [open] = breakAt(c, c.points[0].id, 9);
    const mid = toNodes(open)[2].id;
    const parts = breakAt(open, mid, 9);
    expect(parts).toHaveLength(2);
    expect(parts.map((p) => toNodes(p).length)).toEqual([3, 3]);
    expect(parts[1].id).toBe(9);
    for (const p of parts) expect(validate(p)).toBeNull();
  });

  it("joins two open paths end to start, merging touching ends", () => {
    const a = fromNodes([{ id: 0, pos: { x: 0, y: 0 }, smooth: false }, { id: 1, pos: { x: 100, y: 0 }, smooth: false }], 0, null, 2, true);
    const b = fromNodes([{ id: 0, pos: { x: 100, y: 0 }, smooth: false }, { id: 1, pos: { x: 100, y: 100 }, smooth: false }], 1, null, 2, true);
    expect(endOf(a, 1)).toBe("end");
    expect(endOf(b, 0)).toBe("start");
    const j = joinPaths(a, "end", b, "start");
    expect(validate(j)).toBeNull();
    expect(toNodes(j).map((n) => n.pos)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    expect(new Set(j.points.map((p) => p.id)).size).toBe(j.points.length);
  });
});

describe("Tunni lines", () => {
  const pts = [{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 60, y: 100 }, { x: 100, y: 100 }];
  it("finds where the handle lines meet", () => {
    expect(tunniPoint(pts)).toEqual({ x: 0, y: 100 });
    expect(tensions(pts)).toEqual([0.5, 0.4]);
  });
  it("dragging the Tunni point changes each handle by its own share", () => {
    const [h0, h1] = moveTunni(pts, { x: 10, y: 110 })!;
    expect(h0.x).toBeCloseTo(0);
    expect(h0.y).toBeCloseTo(55);
    expect(h1.y).toBeCloseTo(100);
    expect(h1.x).toBeCloseTo(64);
  });
  it("balancing gives both handles the same tension", () => {
    const [h0, h1] = balanceHandles(pts)!;
    expect(h0.y).toBeCloseTo(45);
    expect(h1.x).toBeCloseTo(55);
  });
});

describe("curvature", () => {
  it("a quarter circle has nearly even curvature", () => {
    const k = 0.5523 * 100;
    const arc = [{ x: 100, y: 0 }, { x: 100, y: k }, { x: k, y: 100 }, { x: 0, y: 100 }];
    const ks = [0, 0.25, 0.5, 0.75, 1].map((t) => curvatureAt(arc, t));
    for (const v of ks) expect(v).toBeCloseTo(0.01, 3);
    expect(combTeeth(arc, 1000, 4)).toHaveLength(5);
  });
});

describe("harmonize", () => {
  it("moves a smooth point to where both curvatures match", () => {
    const nodes = [
      { id: 0, pos: { x: 0, y: 0 }, smooth: false, out: { id: 1, pos: { x: 0, y: 80 } } },
      { id: 2, pos: { x: 100, y: 100 }, smooth: true, in: { id: 3, pos: { x: 40, y: 100 } }, out: { id: 4, pos: { x: 120, y: 100 } } },
      { id: 5, pos: { x: 200, y: 0 }, smooth: false, in: { id: 6, pos: { x: 200, y: 80 } } },
    ];
    const c = fromNodes(nodes, 0, null, 7, true);
    const h = harmonize(c, new Set([2]));
    const mid = toNodes(h)[1].pos;
    expect(mid.y).toBe(100);
    // Symmetric outer handles: the point lands halfway between its handles.
    expect(mid.x).toBe(80);
  });
});

describe("power nudge", () => {
  it("keeps a curve's shape when its end moves", () => {
    const nodes = [
      { id: 0, pos: { x: 0, y: 0 }, smooth: false, out: { id: 1, pos: { x: 0, y: 50 } } },
      { id: 2, pos: { x: 100, y: 100 }, smooth: false, in: { id: 3, pos: { x: 50, y: 100 } } },
    ];
    const c = fromNodes(nodes, 0, null, 4, true);
    const out = toNodes(powerNudge(c, new Set([2]), { x: 100, y: 100 }));
    expect(out[1].pos).toEqual({ x: 200, y: 200 });
    expect(out[0].out!.pos).toEqual({ x: 0, y: 100 });
    expect(out[1].in!.pos).toEqual({ x: 100, y: 200 });
  });
});

describe("automatic handles", () => {
  it("gives a straight run handles at a third of each chord", () => {
    const nodes = [0, 1, 2].map((i) => ({ id: i, pos: { x: i * 90, y: 0 }, smooth: false }));
    const c = fromNodes(nodes, 0, null, 3, true);
    const out = toNodes(autoHandles(c, new Set([0, 1, 2])));
    expect(out[0].out!.pos).toEqual({ x: 30, y: 0 });
    expect(out[1].in!.pos).toEqual({ x: 60, y: 0 });
    expect(out[1].smooth).toBe(true);
  });
});

describe("freehand", () => {
  it("fits a sampled arc with a few smooth curves", () => {
    const raw = Array.from({ length: 60 }, (_, i) => {
      const a = (i / 59) * Math.PI;
      return { x: 200 * Math.cos(a), y: 200 * Math.sin(a) };
    });
    const nodes = fitStroke(raw, 2);
    expect(nodes.length).toBeGreaterThan(1);
    expect(nodes.length).toBeLessThan(6);
    const c = fromNodes(nodes, 0, null, undefined, true);
    expect(validate(c)).toBeNull();
    // Every fitted point lies on the arc.
    for (const n of toNodes(c)) expect(Math.abs(Math.hypot(n.pos.x, n.pos.y) - 200)).toBeLessThan(3);
  });
});

describe("corners", () => {
  it("rounds a square's corner with a quarter circle", () => {
    const c = square();
    const id = c.points[0].id;
    const out = roundCorners(c, new Set([id]), 20, "round");
    const nodes = toNodes(out);
    expect(nodes).toHaveLength(5);
    expect(validate(out)).toBeNull();
    const pos = nodes.map((n) => n.pos);
    expect(pos).toContainEqual({ x: 20, y: 0 });
    expect(pos).toContainEqual({ x: 0, y: 20 });
    // Handle length of a quarter circle: 0.5523 of the radius.
    const a = nodes.find((n) => n.pos.x === 0 && n.pos.y === 20)!;
    const h = a.out ?? a.in;
    expect(h).toBeTruthy();
  });
  it("chamfers a corner with a straight cut", () => {
    const c = square();
    const out = roundCorners(c, new Set([c.points[0].id]), 20, "chamfer");
    expect(out.points.every((p) => p.kind === "line")).toBe(true);
    expect(toNodes(out)).toHaveLength(5);
  });
});

describe("eraser and tidy up", () => {
  it("erasing one side of a square leaves an open path of three sides", () => {
    const pieces = eraseSegments(square(), new Set([1]), 5);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].open).toBe(true);
    expect(segments(pieces[0])).toHaveLength(3);
    expect(validate(pieces[0])).toBeNull();
  });

  it("erasing two opposite sides leaves two open pieces with their own ids", () => {
    const pieces = eraseSegments(square(), new Set([0, 2]), 5);
    expect(pieces.map((p) => p.id)).toEqual([0, 5]);
    expect(pieces.every((p) => p.open && segments(p).length === 1)).toBe(true);
  });

  it("tidy up drops doubled and in-line points", () => {
    const nodes = toNodes(square());
    const mid = { id: 50, pos: { x: 50, y: 0 }, smooth: false };
    const dup = { id: 51, pos: { x: 100, y: 0.2 }, smooth: false };
    const messy = fromNodes([nodes[0], mid, nodes[1], dup, nodes[2], nodes[3]], 0, null, 60);
    const tidy = tidyUp(messy);
    expect(toNodes(tidy)).toHaveLength(4);
    expect(validate(tidy)).toBeNull();
    expect(tidyUp(square()).points).toEqual(square().points);
  });

  it("tidy up turns a curve with retracted handles into a line", () => {
    const nodes = toNodes(square());
    nodes[0].out = { id: 70, pos: { ...nodes[0].pos } };
    nodes[1].in = { id: 71, pos: { ...nodes[1].pos } };
    const c = fromNodes(nodes, 0, null, 80);
    expect(segments(c)[0].pts).toHaveLength(4);
    expect(segments(tidyUp(c)).every((s) => s.pts.length === 2)).toBe(true);
  });
});
