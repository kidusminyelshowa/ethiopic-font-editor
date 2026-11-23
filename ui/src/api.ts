// Types and calls for the Rust commands in src-tauri.

import { invoke } from "@tauri-apps/api/core";
import type { Contour } from "./geometry";

export type StateKind = "linked" | "adjusted" | "irregular" | "detached";
export type Badge = "none" | "dot" | "outlined" | "solid";
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
}

export interface OrderRef {
  order: string;
  orderName: string;
  codepoint: string | null;
}

export type DrawingKind = "base" | "alteration" | "symbol";
export type DrawingTarget = { kind: DrawingKind; id: string };

export interface DrawingView {
  target: DrawingTarget;
  title: string;
  subtitle: string;
  contours: Contour[];
  advanceWidth: number | null;
  metrics: Metrics;
  context?: { family: string; familyName: string; d: string };
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
  setCharsets: (sets: CharSetId[]) => invoke<FidelGrid>("set_charsets", { sets }),
  familyPreview: (family: string) => invoke<FidelPreview[]>("family_preview", { family }),
};

export function sameTarget(a: DrawingTarget | null, b: DrawingTarget | null): boolean {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}
