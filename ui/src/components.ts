// Components on the canvas: placing a component's drawing into a base, and
// mapping a base back into the component's own space for editing in place.

import type { ComponentRef } from "./api";
import { clone, reversed, type Contour, type Vec2 } from "./geometry";

/** Map a point of the component's drawing into the base, as the core does. */
export function placePoint(r: ComponentRef, p: Vec2): Vec2 {
  const s = r.scale ?? 1;
  const x = p.x * (r.flip_x ? -s : s);
  const y = p.y * (r.flip_y ? -s : s);
  const a = ((r.rotate ?? 0) * Math.PI) / 180;
  return { x: x * Math.cos(a) - y * Math.sin(a) + r.at.x, y: x * Math.sin(a) + y * Math.cos(a) + r.at.y };
}

/** Map a point of the base into the component's drawing. */
export function unplacePoint(r: ComponentRef, p: Vec2): Vec2 {
  const s = r.scale ?? 1;
  const a = (-(r.rotate ?? 0) * Math.PI) / 180;
  const dx = p.x - r.at.x;
  const dy = p.y - r.at.y;
  const x = dx * Math.cos(a) - dy * Math.sin(a);
  const y = dx * Math.sin(a) + dy * Math.cos(a);
  return { x: x / (r.flip_x ? -s : s), y: y / (r.flip_y ? -s : s) };
}

const mirrored = (r: ComponentRef) => !!r.flip_x !== !!r.flip_y;

function mapContours(contours: Contour[], f: (p: Vec2) => Vec2, flip: boolean): Contour[] {
  return contours.map((c) => {
    const out = clone(c);
    for (const p of out.points) p.pos = f(p.pos);
    // A mirror flips the path direction; turn it back.
    return flip ? reversed(out) : out;
  });
}

/** The component's contours as they sit in the base. */
export function placeContours(r: ComponentRef, contours: Contour[]): Contour[] {
  return mapContours(contours, (p) => placePoint(r, p), mirrored(r));
}

/** Base contours seen from inside the component, for drawing it in place. */
export function unplaceContours(r: ComponentRef, contours: Contour[]): Contour[] {
  return mapContours(contours, (p) => unplacePoint(r, p), mirrored(r));
}
