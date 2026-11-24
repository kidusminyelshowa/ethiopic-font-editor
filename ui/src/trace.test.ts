import { describe, expect, it } from "vitest";
import { contoursBounds, toNodes, validate } from "./geometry";
import { directionOk, segments } from "./pathops";
import { traceLoops, traceToContours } from "./trace";

function grid(w: number, h: number, inside: (x: number, y: number) => boolean): boolean[] {
  const g: boolean[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g.push(inside(x + 0.5, y + 0.5));
  return g;
}

describe("auto-trace", () => {
  it("follows the edge of a block", () => {
    const loops = traceLoops(grid(10, 10, (x, y) => x > 2 && x < 7 && y > 3 && y < 8), 10, 10);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(20);
  });

  it("keeps a square's corners and a ring's counter", () => {
    const toFont = (p: { x: number; y: number }) => ({ x: p.x * 10, y: (60 - p.y) * 10 });
    const square = traceToContours(grid(60, 60, (x, y) => x > 10 && x < 50 && y > 10 && y < 50), 60, 60, toFont, 1);
    expect(square).toHaveLength(1);
    expect(validate(square[0])).toBeNull();
    expect(toNodes(square[0]).length).toBeLessThanOrEqual(8);
    const b = contoursBounds(square)!;
    expect(Math.round(b.minX)).toBe(100);
    expect(Math.round(b.maxX)).toBe(500);
    expect(toNodes(square[0])).toHaveLength(4);

    const ring = traceToContours(
      grid(80, 80, (x, y) => {
        const r = Math.hypot(x - 40, y - 40);
        return r < 32 && r > 18;
      }),
      80,
      80,
      toFont,
      1,
    );
    expect(ring).toHaveLength(2);
    expect(directionOk(ring).every(Boolean)).toBe(true);
    // Smooth round shapes come back as a few curves, not a staircase.
    for (const c of ring) {
      expect(segments(c).length).toBeLessThan(16);
      expect(segments(c).some((s) => s.pts.length === 4)).toBe(true);
    }
  });
});
