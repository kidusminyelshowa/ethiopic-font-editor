// Vector files from other apps: PDF (and Illustrator .ai, which is PDF
// inside) and EPS. Each is read for its filled paths and handed on as SVG,
// so the SVG importer does the fitting to the Pa-height.

type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);

/**
 * Builds SVG path data from PostScript-style drawing (y up), keeping only
 * paths that are filled.
 */
class PathSink {
  private cur = "";
  private start: [number, number] | null = null;
  private at: [number, number] = [0, 0];
  readonly filled: string[] = [];
  ctm: Mat = IDENTITY;

  private pt(x: number, y: number): string {
    const m = this.ctm;
    // y flips for SVG, whose y runs down.
    return `${fmt(m[0] * x + m[2] * y + m[4])} ${fmt(-(m[1] * x + m[3] * y + m[5]))}`;
  }
  moveTo(x: number, y: number) {
    this.cur += `M${this.pt(x, y)}`;
    this.start = [x, y];
    this.at = [x, y];
  }
  lineTo(x: number, y: number) {
    if (!this.start) return this.moveTo(x, y);
    this.cur += `L${this.pt(x, y)}`;
    this.at = [x, y];
  }
  curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number) {
    if (!this.start) this.moveTo(x1, y1);
    this.cur += `C${this.pt(x1, y1)} ${this.pt(x2, y2)} ${this.pt(x, y)}`;
    this.at = [x, y];
  }
  get current(): [number, number] {
    return this.at;
  }
  close() {
    if (this.start) {
      this.cur += "Z";
      this.at = this.start;
    }
  }
  rect(x: number, y: number, w: number, h: number) {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.close();
  }
  fill() {
    if (this.cur) this.filled.push(this.cur);
    this.discard();
  }
  discard() {
    this.cur = "";
    this.start = null;
  }
}

/** Wrap filled path data as an SVG document the SVG importer reads. */
function toSvg(paths: string[]): string {
  if (!paths.length) throw new Error("No filled shapes found in the file.");
  return `<svg xmlns="http://www.w3.org/2000/svg">${paths.map((d) => `<path d="${d}"/>`).join("")}</svg>`;
}

// ---------- PDF ----------

/** The filled paths drawn by one PDF content stream, as SVG path data. */
export function pdfContentToPaths(content: string): string[] {
  const sink = new PathSink();
  const stack: Mat[] = [];
  const nums: number[] = [];
  const re = /(\[|\]|<<|>>|\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]*>|\/[^\s/[\]()<>{}%]*|%[^\n\r]*|[-+]?(?:\d+\.?\d*|\.\d+)|[A-Za-z'"*]+)/g;
  let m: RegExpExecArray | null;
  let depth = 0;
  while ((m = re.exec(content))) {
    const tok = m[1];
    if (tok === "[") depth++;
    else if (tok === "]") depth = Math.max(0, depth - 1);
    if (depth > 0 || tok === "]" || tok.startsWith("(") || tok.startsWith("<") || tok.startsWith("/") || tok.startsWith("%")) {
      if (!/^[-+.\d]/.test(tok)) continue;
    }
    if (/^[-+.\d]/.test(tok)) {
      if (depth === 0) nums.push(parseFloat(tok));
      continue;
    }
    const n = nums.splice(0);
    const a = (k: number) => n[n.length - k] ?? 0;
    switch (tok) {
      case "q":
        stack.push(sink.ctm);
        break;
      case "Q":
        sink.ctm = stack.pop() ?? IDENTITY;
        break;
      case "cm":
        sink.ctm = mul([a(6), a(5), a(4), a(3), a(2), a(1)], sink.ctm);
        break;
      case "m":
        sink.moveTo(a(2), a(1));
        break;
      case "l":
        sink.lineTo(a(2), a(1));
        break;
      case "c":
        sink.curveTo(a(6), a(5), a(4), a(3), a(2), a(1));
        break;
      case "v": {
        const [cx, cy] = sink.current;
        sink.curveTo(cx, cy, a(4), a(3), a(2), a(1));
        break;
      }
      case "y":
        sink.curveTo(a(4), a(3), a(2), a(1), a(2), a(1));
        break;
      case "h":
        sink.close();
        break;
      case "re":
        sink.rect(a(4), a(3), a(2), a(1));
        break;
      case "f":
      case "F":
      case "f*":
      case "B":
      case "B*":
        sink.fill();
        break;
      case "b":
      case "b*":
        sink.close();
        sink.fill();
        break;
      case "S":
      case "s":
      case "n":
        sink.discard();
        break;
      case "BI": {
        // Inline image: skip to its end.
        const end = content.indexOf("EI", re.lastIndex);
        if (end >= 0) re.lastIndex = end + 2;
        break;
      }
      default:
        break;
    }
  }
  return sink.filled;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate");
  const out = new Response(bytes as unknown as BodyInit).body!.pipeThrough(ds);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

const latin1 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
};

/** Read a PDF (or an Illustrator .ai file) and return its filled shapes as SVG. */
export async function pdfToSvg(bytes: Uint8Array): Promise<string> {
  const text = latin1(bytes);
  if (!text.startsWith("%PDF")) throw new Error("This is not a PDF file.");
  const paths: string[] = [];
  const objRe = /\d+\s+\d+\s+obj\b([\s\S]*?)\bendobj/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(text))) {
    const body = m[1];
    const s = body.indexOf("stream");
    if (s < 0) continue;
    const dict = body.slice(0, s);
    // Images, fonts and the file's own bookkeeping hold no outlines.
    if (/\/Subtype\s*\/Image|\/Length1|\/FontFile|\/Type\s*\/(XRef|ObjStm|Metadata)|\/Subtype\s*\/(XML|Type1C|CIDFontType0C|OpenType)/.test(dict)) continue;
    let dataStart = m.index + m[0].indexOf("stream") + 6;
    if (text[dataStart] === "\r") dataStart++;
    if (text[dataStart] === "\n") dataStart++;
    let end = text.indexOf("endstream", dataStart);
    if (end < 0) continue;
    // The stated length when it is given directly; otherwise up to the line break before endstream.
    const stated = /\/Length\s+(\d+)\b(?!\s+\d+\s+R)/.exec(dict);
    if (stated && dataStart + Number(stated[1]) <= end) end = dataStart + Number(stated[1]);
    else {
      if (text[end - 1] === "\n") end--;
      if (text[end - 1] === "\r") end--;
    }
    let raw: Uint8Array = bytes.slice(dataStart, end);
    const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1] ?? "";
    try {
      if (/FlateDecode/.test(filter)) raw = await inflate(raw);
      else if (filter) continue;
    } catch {
      continue;
    }
    paths.push(...pdfContentToPaths(latin1(raw)));
  }
  return toSvg(paths);
}

// ---------- EPS ----------

/** Read an EPS file (PostScript, or Illustrator's own shorthand) for its filled shapes, as SVG. */
export function epsToSvg(text: string): string {
  const sink = new PathSink();
  const nums: number[] = [];
  const body = text.replace(/%[^\n\r]*/g, " ");
  const re = /(\((?:\\.|[^\\)])*\)|<[^>]*>|\/[^\s/[\]()<>{}%]*|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[A-Za-z*]+|\[|\]|\{|\})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const tok = m[1];
    if (/^[-+.\d]/.test(tok)) {
      nums.push(parseFloat(tok));
      continue;
    }
    const n = nums.splice(0);
    const a = (k: number) => n[n.length - k] ?? 0;
    const [cx, cy] = sink.current;
    switch (tok) {
      case "moveto":
      case "m":
        sink.moveTo(a(2), a(1));
        break;
      case "rmoveto":
        sink.moveTo(cx + a(2), cy + a(1));
        break;
      case "lineto":
      case "l":
      case "L":
        sink.lineTo(a(2), a(1));
        break;
      case "rlineto":
        sink.lineTo(cx + a(2), cy + a(1));
        break;
      case "curveto":
      case "c":
      case "C":
        sink.curveTo(a(6), a(5), a(4), a(3), a(2), a(1));
        break;
      case "rcurveto":
        sink.curveTo(cx + a(6), cy + a(5), cx + a(4), cy + a(3), cx + a(2), cy + a(1));
        break;
      case "v":
      case "V":
        sink.curveTo(cx, cy, a(4), a(3), a(2), a(1));
        break;
      case "y":
      case "Y":
        sink.curveTo(a(4), a(3), a(2), a(1), a(2), a(1));
        break;
      case "closepath":
      case "h":
      case "H":
        sink.close();
        break;
      case "fill":
      case "eofill":
      case "f":
      case "F":
      case "b":
      case "B":
        if (tok === "b" || tok === "f") sink.close();
        sink.fill();
        break;
      case "stroke":
      case "newpath":
      case "S":
      case "s":
      case "n":
      case "N":
        sink.discard();
        break;
      default:
        break;
    }
  }
  return toSvg(sink.filled);
}

/** Pick the reader by file name. */
export async function vectorFileToSvg(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".svg")) return file.text();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const head = latin1(bytes.subarray(0, 8));
  if (head.startsWith("%PDF")) return pdfToSvg(bytes);
  if (name.endsWith(".eps") || name.endsWith(".ps") || head.startsWith("%!PS")) return epsToSvg(latin1(bytes));
  if (name.endsWith(".ai")) throw new Error("This Illustrator file has no PDF inside. Save it with “Create PDF Compatible File” on.");
  throw new Error("Open an SVG, PDF, AI or EPS file.");
}

/**
 * SVG inside pasted HTML (some apps put vectors on the clipboard that way),
 * or null when there is none.
 */
export function svgFromHtml(html: string): string | null {
  const m = /<svg[\s\S]*<\/svg>/i.exec(html);
  return m ? m[0] : null;
}

/** Figma's own clipboard: shapes that only paste back into Figma. */
export const isFigmaClipboard = (html: string) => /figmeta|data-metadata="<!--\(figm/i.test(html);
