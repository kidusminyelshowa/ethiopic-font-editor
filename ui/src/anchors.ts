// Anchors and letters built from parts: pure helpers.

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Anchor names offered when adding one. */
export const ANCHOR_PRESETS = ["top", "bottom", "ogonek", "center", "_top", "_bottom", "_ogonek", "_center"] as const;

/** Where a preset anchor goes on a drawing with these bounds. */
export function presetPosition(name: string, b: Bounds | null, advance: number): { x: number; y: number } {
  const box = b ?? { minX: 0, minY: 0, maxX: advance, maxY: 0 };
  const cx = Math.round((box.minX + box.maxX) / 2);
  const cy = Math.round((box.minY + box.maxY) / 2);
  switch (name) {
    case "top":
      return { x: cx, y: Math.round(box.maxY) };
    case "bottom":
      return { x: cx, y: 0 };
    case "ogonek":
      return { x: Math.round(box.maxX), y: 0 };
    case "_top":
      return { x: cx, y: Math.round(box.minY) };
    case "_bottom":
      return { x: cx, y: Math.round(box.maxY) };
    case "_ogonek":
      return { x: Math.round(box.maxX), y: Math.round(box.maxY) };
    default:
      return { x: cx, y: cy };
  }
}

/** A combining accent, shown on a dotted circle so it can be seen alone. */
export function isAccent(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (cp >= 0x300 && cp < 0x370) || (cp >= 0x135d && cp <= 0x135f);
}

export function showPart(ch: string): string {
  return isAccent(ch) ? `◌${ch}` : ch;
}

/** Parts typed as text: characters, `uni0301` or `U+0301`; dotted circles are dropped. */
export function parseParts(text: string): string {
  let out = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const code = /^(?:uni|u\+|U\+|u)([0-9a-fA-F]{4,6})$/.exec(word);
    if (code) {
      out += String.fromCodePoint(parseInt(code[1], 16));
      continue;
    }
    for (const c of word) if (c !== "◌") out += c;
  }
  return out;
}

/** Whether a drawing is an accent: it joins at an `_` anchor. */
export function joinsAsAccent(anchors: Record<string, unknown> | undefined, ch: string | null): boolean {
  return Object.keys(anchors ?? {}).some((k) => k.startsWith("_")) || (!!ch && isAccent(ch));
}
