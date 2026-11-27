import { describe, expect, it } from "vitest";
import { epsToSvg, pdfContentToPaths, pdfToSvg } from "./vectorImport";

describe("PDF", () => {
  it("reads filled paths with their transform, and skips strokes", () => {
    const paths = pdfContentToPaths("q 1 0 0 1 10 20 cm 0 0 m 100 0 l 100 50 l h f Q 0 0 m 5 5 l S 0 0 50 50 re f");
    expect(paths).toEqual(["M10 -20L110 -20L110 -70Z", "M0 0L50 0L50 -50L0 -50Z"]);
  });

  it("reads curves, including the v and y shorthands", () => {
    const [d] = pdfContentToPaths("0 0 m 0 10 10 20 20 20 c 30 20 30 0 v 40 0 40 0 y h f*");
    expect(d).toBe("M0 0C0 -10 10 -20 20 -20C20 -20 30 -20 30 0C40 0 40 0 40 0Z");
  });

  it("opens a compressed PDF", async () => {
    const enc = new TextEncoder();
    const packed = new Response(enc.encode("0 0 m 100 0 l 100 100 l 0 100 l h f")).body!.pipeThrough(new CompressionStream("deflate"));
    const content = new Uint8Array(await new Response(packed).arrayBuffer());
    const head = enc.encode("%PDF-1.4\n1 0 obj\n<< /Length " + content.length + " /Filter /FlateDecode >>\nstream\n");
    const tail = enc.encode("\nendstream\nendobj\n%%EOF\n");
    const file = new Uint8Array(head.length + content.length + tail.length);
    file.set(head, 0);
    file.set(content, head.length);
    file.set(tail, head.length + content.length);
    const svg = await pdfToSvg(file);
    expect(svg).toContain('d="M0 0L100 0L100 -100L0 -100Z"');
  });
});

describe("EPS", () => {
  it("reads PostScript and Illustrator shorthand", () => {
    const svg = epsToSvg("%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 100 100\nnewpath 0 0 moveto 100 0 lineto 100 100 lineto closepath fill\n10 10 m\n20 10 L\n20 20 30 30 40 40 c\nf\n0 0 m 5 5 l S");
    expect(svg).toContain('d="M0 0L100 0L100 -100Z"');
    expect(svg).toContain('d="M10 -10L20 -10C20 -20 30 -30 40 -40Z"');
    expect(svg.match(/<path/g)).toHaveLength(2);
  });

  it("says so when there is nothing to import", () => {
    expect(() => epsToSvg("%!PS\n0 0 moveto 10 10 lineto stroke")).toThrow(/No filled shapes/);
  });
});
