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
  group: string | null;
  cells: GridCell[];
}

export interface FidelGrid {
  metrics: Metrics;
  orders: OrderHeader[];
  rows: GridRow[];
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
}

export type DrawingTarget = { kind: "base"; id: string } | { kind: "alteration"; id: string };

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
}

export interface FidelPreview {
  order: string;
  orderName: string;
  codepoint: string | null;
  outline?: Outline;
  issues: string[];
}

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  fidelGrid: () => invoke<FidelGrid>("fidel_grid"),
  fidelDetail: (family: string, order: string) => invoke<FidelDetail>("fidel_detail", { family, order }),
  listAlterations: () => invoke<AlterationSummary[]>("list_alterations"),
  getDrawing: (target: DrawingTarget, contextFamily?: string) =>
    invoke<DrawingView>("get_drawing", { target, contextFamily: contextFamily ?? null }),
  setDrawing: (target: DrawingTarget, contours: Contour[]) => invoke<void>("set_drawing", { target, contours }),
  setAdvance: (base: string, advanceWidth: number) => invoke<void>("set_advance", { base, advanceWidth }),
  familyPreview: (family: string) => invoke<FidelPreview[]>("family_preview", { family }),
};

export function sameTarget(a: DrawingTarget | null, b: DrawingTarget | null): boolean {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}
