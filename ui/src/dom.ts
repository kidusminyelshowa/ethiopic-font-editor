import type { Metrics, Outline } from "./api";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * A resolved outline drawn in a box, or the system font as a stand-in while
 * nothing is drawn yet.
 */
export function glyphView(outline: Outline | undefined, metrics: Metrics, fallback: string | null): Element {
  if (!outline) return el("span", { class: "glyph placeholder", lang: "gez" }, fallback ?? "");
  const pad = 140;
  const top = metrics.pa_top + pad;
  const height = metrics.pa_top - metrics.pa_bottom + 2 * pad;
  const width = Math.max(outline.advanceWidth, 200);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "glyph-svg");
  svg.setAttribute("viewBox", `${(outline.advanceWidth - width) / 2} ${-top} ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", outline.d);
  path.setAttribute("transform", "scale(1 -1)");
  svg.append(path);
  return svg;
}

export function hex(c: string | null): string {
  if (!c) return "";
  return "U+" + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
}
