import { describe, expect, it } from "vitest";
import type { ComponentRef } from "./api";
import { placeContours, placePoint, unplaceContours, unplacePoint } from "./components";
import { isClockwise, rectContour } from "./geometry";

const ref = (over: Partial<ComponentRef> = {}): ComponentRef => ({ id: 0, component: "leaf", at: { x: 100, y: 50 }, ...over });

describe("component placement", () => {
  it("matches the core's transform", () => {
    expect(placePoint(ref(), { x: 10, y: 0 })).toEqual({ x: 110, y: 50 });
    const p = placePoint(ref({ flip_x: true, scale: 2 }), { x: 10, y: 5 });
    expect(p).toEqual({ x: 80, y: 60 });
    const q = placePoint(ref({ rotate: 90 }), { x: 10, y: 0 });
    expect(q.x).toBeCloseTo(100);
    expect(q.y).toBeCloseTo(60);
  });

  it("goes back and forth", () => {
    const r = ref({ rotate: 30, scale: 1.5, flip_y: true });
    const p = unplacePoint(r, placePoint(r, { x: 37, y: -12 }));
    expect(p.x).toBeCloseTo(37);
    expect(p.y).toBeCloseTo(-12);
  });

  it("keeps path direction through a mirror", () => {
    const sq = rectContour(0, { x: 0, y: 0 }, { x: 50, y: 50 });
    const placed = placeContours(ref({ flip_x: true }), [sq])[0];
    expect(isClockwise(placed)).toBe(isClockwise(sq));
    const back = unplaceContours(ref({ flip_x: true }), [placed])[0];
    expect(isClockwise(back)).toBe(isClockwise(sq));
  });
});
