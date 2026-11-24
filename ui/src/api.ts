// Types and calls for the Rust commands in src-tauri.

import { invoke } from "@tauri-apps/api/core";
import type { Contour } from "./geometry";
import type { Guide } from "./guides";

export type StateKind = "linked" | "adjusted" | "detached";
export type Badge = "none" | "dot" | "solid";
export type Part =
  | "stem" | "leg" | "arm" | "bar" | "branch" | "leaf" | "ring" | "bowl" | "diagonal" | "neck" | "break";

export const PARTS: Part[] = [
  "stem", "leg", "arm", "bar", "branch", "leaf", "ring", "bowl", "diagonal", "neck", "break",
];

export interface Metrics {
  units_per_em: number;
  pa_top: number;
  pa_bottom: number;
}

export interface AppInfo {
  appVersion: string;
  coreVersion: string;
  familyCount: number;
  alterationCount: number;
}

export interface Outline {
  d: string;
  advanceWidth: number;
}

export interface OrderHeader {
  order: string;
  number: number;
  name: string;
  /** A labialized or -oa column. */
  extra: boolean;
}

export interface GridCell {
  order: string;
  codepoint: string | null;
  state: StateKind;
  badge: Badge;
  note?: string;
  outline?: Outline;
}

export interface GridRow {
  family: string;
  name: string;
  /** The base the row is drawn from; Sebatbeit and Gurage rows share one. */
  base: string;
  group: string | null;
  section: CharSetId;
  cells: GridCell[];
}

export type CharSetId =
  | "geez"
  | "ethiopic-letters"
  | "ethiopic-labialized"
  | "ethiopic-marks"
  | "supplement"
  | "extended"
  | "extended-a"
  | "extended-b";

export interface CharSetInfo {
  id: CharSetId;
  name: string;
  range: string;
  count: number;
  enabled: boolean;
}

export type LanguageId = "amharic" | "tigrinya" | "gurage";

export interface LanguageInfo {
  id: LanguageId;
  name: string;
  count: number;
  enabled: boolean;
}

export interface FontInfo {
  family_name: string;
  style_name: string;
  version: number;
  designer: string;
}

export interface FontProperties {
  info: FontInfo;
  metrics: Metrics;
  defaultFamilyName: string;
  glyphs: number;
  drawn: number;
}

export interface SymbolCell {
  id: string;
  codepoint: string;
  name: string;
  outline?: Outline;
}

export interface FidelGrid {
  metrics: Metrics;
  orders: OrderHeader[];
  rows: GridRow[];
  symbols: SymbolCell[];
  charsets: CharSetInfo[];
  languages: LanguageInfo[];
}

export interface RecipeStep {
  id: string;
  name: string;
  drawn: boolean;
}

export interface FidelDetail {
  family: string;
  familyName: string;
  baseGlyph: string | null;
  group: string | null;
  order: string;
  orderNumber: number;
  orderName: string;
  codepoint: string | null;
  state: StateKind;
  badge: Badge;
  note: string | null;
  recipe: RecipeStep[];
  nudgeCount: number;
  builtOn: OrderRef | null;
  builtOnBy: OrderRef[];
  builtOnChoices: OrderRef[];
  /** Drawn by hand: opens as its own outline. */
  drawnByHand: boolean;
  /** The order rule's variants, when it has more than one. */
  variants: { index: number; label: string }[];
  /** The variant this family uses. */
  variant: number;
}

export interface OrderRef {
  order: string;
  orderName: string;
  codepoint: string | null;
}

export type DrawingKind = "base" | "alteration" | "symbol" | "fidel" | "component";
export type DrawingTarget = { kind: DrawingKind; id: string };

/** A Pa-height zone: the height where a kind of alteration lands (shortened legs end, cricks bend). */
export interface Zone {
  id: string;
  name: string;
  /** Height in font units. */
  position: number;
  /** Snapping band around it, in font units. */
  size: number;
}

export type ComponentKind = "leaf" | "cap" | "corner";

/** One placement of a component on a base. */
export interface ComponentRef {
  id: number;
  component: string;
  at: { x: number; y: number };
  scale?: number;
  rotate?: number;
  flip_x?: boolean;
  flip_y?: boolean;
  /** The base contour it sits on; deforms of that contour carry it along. */
  on?: number | null;
}

export interface PlacedComponent {
  placement: ComponentRef;
  name: string;
  kind: ComponentKind | null;
  /** Placed outline, in base coordinates. */
  d: string;
}

export type CornerSide = "outer" | "inner" | "both";

/** An adjustment to one rule placement. */
export interface Tweak {
  dx: number;
  dy: number;
  scale: number;
  flip: boolean;
}

/** One place a component lands by rule on a base. */
export interface RuleEnd {
  component: string;
  name: string;
  kind: ComponentKind;
  key: string;
  /** "Bar · Right end". */
  label: string;
  on: boolean;
  tweak: Tweak;
  /** Placed outline, in base coordinates. */
  d: string;
}

export interface ComponentSummary {
  id: string;
  name: string;
  kind: ComponentKind;
  drawn: boolean;
  uses: number;
}

export interface DrawingView {
  target: DrawingTarget;
  /** Pa-height zones for snapping and display. */
  zones?: Zone[];
  /** For a base: the components placed on it. */
  components?: PlacedComponent[];
  title: string;
  subtitle: string;
  contours: Contour[];
  advanceWidth: number | null;
  metrics: Metrics;
  context?: {
    family: string;
    familyName: string;
    d: string;
    advanceWidth: number;
    /** Where the alteration attaches on this family; its contours are relative to it. */
    origin: { x: number; y: number };
    /** The automatic attach point, before the family's offset. */
    autoOrigin: { x: number; y: number };
  };
  /** A generated fidel opened in place: points move (as nudges), none are added or removed. */
  generated: boolean;
  /** Ends of deformed strokes on a generated fidel, to drag. */
  handles: DeformHandle[];
  /** For a component: where it lands by rule, and how many times. */
  rule?: { landsOn: Part[]; corners: CornerSide; uses: number };
}

export interface DeformHandle {
  alteration: string;
  at: { x: number; y: number };
  /** Moves up and down (a short leg's end) rather than sideways. */
  vertical: boolean;
  offset: { x: number; y: number };
}

export interface AlterationSummary {
  id: string;
  name: string;
  verb: string;
  drawable: boolean;
  drawn: boolean;
  orders: string[];
  users: number;
  forkedFrom?: string;
  /** Deforms: the zone it lands on and how far it pulls (null: automatic). */
  zone?: string;
  amount?: number;
}

export type Effect = "regenerates" | "regenerates-keeping-nudges" | "untouched";

export interface ImpactView {
  family: string;
  familyName: string;
  order: string;
  codepoint: string | null;
  state: StateKind;
  effect: Effect;
}

export type Scope =
  | { kind: "everywhere" }
  | { kind: "order"; order: string }
  | { kind: "family"; family: string }
  | { kind: "fidel"; family: string; order: string };

export interface FidelPreview {
  order: string;
  orderName: string;
  codepoint: string | null;
  outline?: Outline;
  issues: string[];
}

export interface ProjectInfo {
  name: string;
  path: string | null;
  dirty: boolean;
}

export interface ExportSummary {
  path: string;
  familyName: string;
  exported: number;
  skipped: number;
}

export const api = {
  setBuiltOn: (family: string, order: string, on: string | null) =>
    invoke<FidelDetail>("set_built_on", { family, order, on }),
  detachFidel: (family: string, order: string) => invoke<FidelDetail>("detach_fidel", { family, order }),
  relinkFidel: (family: string, order: string) => invoke<FidelDetail>("relink_fidel", { family, order }),
  alterationImpacts: (id: string) => invoke<ImpactView[]>("alteration_impacts", { id }),
  baseImpacts: (id: string) => invoke<ImpactView[]>("base_impacts", { id }),
  forkAlteration: (id: string, scope: Scope) => invoke<string>("fork_alteration", { id, scope }),
  rejoinAlteration: (id: string) => invoke<string>("rejoin_alteration", { id }),
  exportFont: (path: string) => invoke<ExportSummary>("export_font", { path }),
  /** Font bytes of everything drawn so far; empty when nothing is drawn. */
  proofFont: () => invoke<ArrayBuffer>("proof_font"),
  projectInfo: () => invoke<ProjectInfo>("project_info"),
  newProject: () => invoke<ProjectInfo>("new_project"),
  openProject: (path: string) => invoke<ProjectInfo>("open_project", { path }),
  saveProject: (path?: string) => invoke<ProjectInfo>("save_project", { path: path ?? null }),
  appInfo: () => invoke<AppInfo>("app_info"),
  fidelGrid: () => invoke<FidelGrid>("fidel_grid"),
  fidelDetail: (family: string, order: string) => invoke<FidelDetail>("fidel_detail", { family, order }),
  listAlterations: () => invoke<AlterationSummary[]>("list_alterations"),
  getDrawing: (target: DrawingTarget, contextFamily?: string) =>
    invoke<DrawingView>("get_drawing", { target, contextFamily: contextFamily ?? null }),
  setDrawing: (target: DrawingTarget, contours: Contour[]) => invoke<void>("set_drawing", { target, contours }),
  setAdvance: (target: DrawingTarget, advanceWidth: number) => invoke<void>("set_advance", { target, advanceWidth }),
  setCoverage: (sets: CharSetId[], languages: LanguageId[]) =>
    invoke<FidelGrid>("set_coverage", { sets, languages }),
  setAttachOffset: (family: string, alteration: string, offset: { x: number; y: number }) =>
    invoke<void>("set_attach_offset", { family, alteration, offset }),
  fontProperties: () => invoke<FontProperties>("font_properties"),
  setFontProperties: (info: FontInfo, paTop: number, paBottom: number) =>
    invoke<void>("set_font_properties", { info, paTop, paBottom }),
  familyPreview: (family: string) => invoke<FidelPreview[]>("family_preview", { family }),
  setRuleVariant: (family: string, order: string, variant: number) =>
    invoke<FidelDetail>("set_rule_variant", { family, order, variant }),
  /** Remove overlap, booleans, offset, expand stroke or knife, done by the core. */
  pathOp: (op: PathOp) => invoke<Contour[]>("path_op", { op }),
  /** Pick one of the order's forms, or `null` to draw it by hand. */
  setForm: (family: string, order: string, variant: number | null) =>
    invoke<FidelDetail>("set_form", { family, order, variant }),
  setDeform: (id: string, zone: string | null, amount: number | null) => invoke<void>("set_deform", { id, zone, amount }),
  setZone: (id: string, position: number, name?: string) =>
    invoke<Zone[]>("set_zone", { id, name: name ?? null, position }),
  /** A drawing's own guides and the global ones. */
  getGuides: (drawing: string) => invoke<{ local: Guide[]; global: Guide[] }>("get_guides", { drawing }),
  setGuides: (drawing: string, local: Guide[], global: Guide[]) => invoke<void>("set_guides", { drawing, local, global }),
  getBackground: (drawing: string) => invoke<Contour[]>("get_background", { drawing }),
  setBackground: (drawing: string, contours: Contour[]) => invoke<void>("set_background", { drawing, contours }),
  listComponents: () => invoke<ComponentSummary[]>("list_components"),
  addComponent: (name: string, kind: ComponentKind) => invoke<string>("add_component", { name, kind }),
  removeComponent: (id: string) => invoke<void>("remove_component", { id }),
  setComponentRule: (id: string, landsOn: Part[], corners: CornerSide) =>
    invoke<void>("set_component_rule", { id, landsOn, corners }),
  setComponentEnd: (id: string, key: string, on: boolean, tweak: Tweak) =>
    invoke<void>("set_component_end", { id, key, on, tweak }),
  ruleEnds: (base: string) => invoke<RuleEnd[]>("rule_ends", { base }),
  setBaseComponents: (base: string, placements: ComponentRef[]) =>
    invoke<void>("set_base_components", { base, placements }),
};

export function sameTarget(a: DrawingTarget | null, b: DrawingTarget | null): boolean {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

export type BooleanKind = "union" | "subtract" | "intersect" | "exclude";
export type StrokeJoin = "miter" | "round" | "bevel";
export type PathOp =
  | { op: "remove-overlap"; contours: Contour[] }
  | { op: "boolean"; a: Contour[]; b: Contour[]; kind: BooleanKind; firstId: number }
  | { op: "offset"; contours: Contour[]; distance: number; join: StrokeJoin; firstId: number }
  | { op: "expand-stroke"; contours: Contour[]; width: number; join: StrokeJoin; firstId: number }
  | { op: "knife"; contours: Contour[]; from: { x: number; y: number }; to: { x: number; y: number }; firstId: number };
