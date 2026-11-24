// Kerning on the UI side: which value two glyphs get, which pair an edit
// writes to, and kerning strings. Mirrors fidel-core's kerning module.

import type { KernClass, KernPair, KernSide, KerningData } from "./api";

export type KernSource = "pair" | "exception";

export interface Resolved {
  value: number;
  source: KernSource;
  /** The stored pair the value comes from. */
  left: string;
  right: string;
}

export const EMPTY_KERNING: KerningData = { leftClasses: [], rightClasses: [], pairs: [] };

export function classesOf(k: KerningData, side: KernSide): KernClass[] {
  return side === "left" ? k.leftClasses : k.rightClasses;
}

/** The class a glyph kerns with on one side. */
export function classOf(k: KerningData, side: KernSide, ch: string): string | null {
  return classesOf(k, side).find((c) => [...c.members].includes(ch))?.name ?? null;
}

export function pairValue(k: KerningData, left: string, right: string): number | null {
  return k.pairs.find((p) => p.left === left && p.right === right)?.value ?? null;
}

/**
 * The value between two glyphs. The most specific pair wins: glyph and glyph,
 * glyph and class, class and glyph, then class and class. A specific pair
 * over a class pair is an exception.
 */
export function resolve(k: KerningData, l: string, r: string): Resolved | null {
  const lc = classOf(k, "left", l);
  const rc = classOf(k, "right", r);
  const tries: [string, string][] = [[l, r]];
  if (rc) tries.push([l, `@${rc}`]);
  if (lc) tries.push([`@${lc}`, r]);
  const classPair = lc && rc ? pairValue(k, `@${lc}`, `@${rc}`) : null;
  for (const [a, b] of tries) {
    const v = pairValue(k, a, b);
    if (v !== null) return { value: v, source: classPair !== null ? "exception" : "pair", left: a, right: b };
  }
  if (classPair !== null) return { value: classPair, source: "pair", left: `@${lc}`, right: `@${rc}` };
  return null;
}

/**
 * The pair an edit of two glyphs writes to. Each side uses its class unless
 * it is locked to the glyph (an exception) or has no class.
 */
export function editKey(k: KerningData, l: string, r: string, glyphLeft: boolean, glyphRight: boolean): [string, string] {
  const lc = classOf(k, "left", l);
  const rc = classOf(k, "right", r);
  return [glyphLeft || !lc ? l : `@${lc}`, glyphRight || !rc ? r : `@${rc}`];
}

/** A glyph that stands for a side: itself, or the first member of the class. */
export function sampleOf(k: KerningData, side: KernSide, key: string): string {
  if (!key.startsWith("@")) return key;
  return [...(classesOf(k, side).find((x) => x.name === key.slice(1))?.members ?? "")][0] ?? "";
}

/**
 * A kerning string that puts `ch` on both sides of every partner: one glyph
 * per right-side class, then the partners in no class. `ch` sits between
 * them, so each pair shows up once as ch·x and once as x·ch.
 */
export function kernString(k: KerningData, ch: string, partners: string[], max = 24): string {
  const reps: string[] = [];
  const seen = new Set<string>();
  for (const p of partners) {
    const c = classOf(k, "right", p);
    const key = c ? `@${c}` : p;
    if (seen.has(key) || p === ch) continue;
    seen.add(key);
    reps.push(p);
    if (reps.length >= max) break;
  }
  return ch + reps.map((p) => p + ch).join("");
}

/** The pairs in the sidebar, filtered and sorted. */
export function listPairs(k: KerningData, query: string, sort: "name" | "value"): KernPair[] {
  const q = query.trim().toLowerCase();
  const out = k.pairs.filter((p) => !q || `${p.left} ${p.right}`.toLowerCase().includes(q));
  if (sort === "value") out.sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.value - b.value);
  return out;
}

/** Whether a stored pair is an exception: glyph-level with a class pair under it. */
export function isException(k: KerningData, p: KernPair): boolean {
  if (p.left.startsWith("@") && p.right.startsWith("@")) return false;
  const lc = p.left.startsWith("@") ? p.left.slice(1) : classOf(k, "left", p.left);
  const rc = p.right.startsWith("@") ? p.right.slice(1) : classOf(k, "right", p.right);
  return !!lc && !!rc && pairValue(k, `@${lc}`, `@${rc}`) !== null;
}

/** Where each glyph of a line starts, with kerning between neighbours. */
export function layoutLine(chars: string[], advance: (ch: string) => number, kern: (l: string, r: string, i: number) => number): number[] {
  const xs: number[] = [];
  let x = 0;
  chars.forEach((ch, i) => {
    if (i > 0) x += kern(chars[i - 1], ch, i);
    xs.push(x);
    x += advance(ch);
  });
  xs.push(x);
  return xs;
}
