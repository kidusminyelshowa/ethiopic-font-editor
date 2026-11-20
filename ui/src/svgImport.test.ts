import { describe, expect, it } from "vitest";
import { contoursBounds, validate } from "./geometry";
import { arcToCubics, importSvg, parsePathData, parseTransform, SvgImportError } from "./svgImport";

const opts = { height: 700, bottom: 0, left: 50, firstContourId: 3 };

describe("svg import", () => {
  it("imports a path, flips y and fits the Pa-height", () => {
    const contours = importSvg('<svg viewBox="0 0 10 20"><path d="M0 0H10V20H0Z"/></svg>', opts);
    expect(contours).toHaveLength(1);
    expect(contours[0].id).toBe(3);
    expect(validate(contours[0])).toBeNull();
    const b = contoursBounds(contours)!;
    expect(b).toEqual({ minX: 50, minY: 0, maxX: 400, maxY: 700 });
    // Closing line back to the start does not duplicate the start point.
    expect(contours[0].points).toHaveLength(4);
  });

  it("can centre a smaller drawing under a point", () => {
    const contours = importSvg("M0 0H20V10H0Z", { height: 100, bottom: -100, left: 0, centerX: true, firstContourId: 0 });
    expect(contoursBounds(contours)).toEqual({ minX: -100, minY: -100, maxX: 100, maxY: 0 });
  });

  it("accepts bare path data and relative commands", () => {
    const contours = importSvg("m0 0 l10 0 l0 10 z", opts);
    expect(contours[0].points).toHaveLength(3);
  });

  it("turns circles into four smooth cubic segments", () => {
    const contours = importSvg('<svg><circle cx="50" cy="50" r="50"/></svg>', opts);
    const c = contours[0];
    expect(validate(c)).toBeNull();
    const on = c.points.filter((p) => p.kind !== "offcurve");
    expect(on).toHaveLength(4);
    expect(on.every((p) => p.smooth)).toBe(true);
    const b = contoursBounds(contours)!;
    expect(b.maxY - b.minY).toBe(700);
  });

  it("handles rects, polygons, quadratics and S curves", () => {
    const svg = `<svg>
      <rect x="0" y="0" width="10" height="10" rx="2"/>
      <polygon points="20,0 30,0 25,10"/>
      <path d="M40 0Q45 10 50 0T60 0Z"/>
      <path d="M70 0C70 5 75 10 80 10S90 5 90 0Z"/>
    </svg>`;
    const contours = importSvg(svg, opts);
    expect(contours).toHaveLength(4);
    for (const c of contours) expect(validate(c)).toBeNull();
    expect(contours.map((c) => c.id)).toEqual([3, 4, 5, 6]);
  });

  it("applies transforms from groups", () => {
    const paths = parsePathData("M0 0L1 0", parseTransform("translate(10 5) scale(2)"));
    expect(paths[0].start).toEqual({ x: 10, y: 5 });
    expect(paths[0].segments[0].to).toEqual({ x: 12, y: 5 });
  });

  it("splits arcs into quarter turns or less", () => {
    const parts = arcToCubics({ x: 0, y: 0 }, { x: 100, y: 0 }, 50, 50, 0, false, true);
    expect(parts).toHaveLength(2);
    expect(parts[1][2]).toEqual({ x: 100, y: 0 });
  });

  it("rejects text that is not SVG", () => {
    expect(() => importSvg("hello", opts)).toThrow(SvgImportError);
    expect(() => importSvg("<svg></svg>", opts)).toThrow(/No closed shapes/);
  });
});
