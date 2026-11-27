// Canvas preferences: snapping, grid, nudge steps, shape options and what
// the canvas shows. Kept per user in local storage, not in the project.

export interface CanvasPrefs {
  snapPoints: boolean;
  snapMetrics: boolean;
  snapGrid: boolean;
  /** Snap to the Pa-height zones (M2). */
  snapZones: boolean;
  snapGuides: boolean;
  showGrid: boolean;
  /** Grid spacing in font units, and how many parts each step is cut into for snapping. */
  gridSize: number;
  gridSub: number;
  /** Arrow key steps: plain, Shift, Ctrl. */
  nudge: [number, number, number];
  showArrows: boolean;
  showPartLabels: boolean;
  showWarnings: boolean;
  showZones: boolean;
  showGuides: boolean;
  showBackground: boolean;
  showRulers: boolean;
  /** Tunni lines on selected curves. */
  showTunni: boolean;
  /** Curvature combs on selected paths. */
  showComb: boolean;
  /** Filled outline, or outline only. */
  fill: boolean;
  showMetrics: boolean;
  /** Point size on the canvas. */
  nodeSize: "small" | "medium" | "large";
  /** Corner, smooth and tangent points in their own colours. */
  pointColors: boolean;
  /** Coordinates next to selected points. */
  showCoords: boolean;
  /** Points filled in, instead of hollow. */
  solidPoints: boolean;
  /** Anchors and their names. */
  showAnchors: boolean;
  /** Shape tool options. */
  cornerRadius: number;
  polygonSides: number;
  starPoints: number;
  starInner: number;
}

export const DEFAULT_PREFS: CanvasPrefs = {
  snapPoints: true,
  snapMetrics: true,
  snapGrid: false,
  snapZones: true,
  snapGuides: true,
  showGrid: false,
  gridSize: 50,
  gridSub: 5,
  nudge: [1, 10, 100],
  showArrows: true,
  showPartLabels: true,
  showWarnings: true,
  showZones: true,
  showGuides: true,
  showBackground: true,
  showRulers: true,
  showTunni: true,
  showComb: false,
  fill: true,
  showMetrics: true,
  nodeSize: "medium",
  pointColors: false,
  showCoords: false,
  solidPoints: false,
  showAnchors: true,
  cornerRadius: 40,
  polygonSides: 6,
  starPoints: 5,
  starInner: 0.45,
};

const KEY = "efe.canvas-prefs";

function load(): CanvasPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    // Private mode or bad data: defaults.
  }
  return { ...DEFAULT_PREFS };
}

export const prefs: CanvasPrefs = load();

const listeners = new Set<() => void>();

export function setPref<K extends keyof CanvasPrefs>(key: K, value: CanvasPrefs[K]): void {
  prefs[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Not saved; still applies for this session.
  }
  for (const fn of listeners) fn();
}

export function onPrefs(fn: () => void): void {
  listeners.add(fn);
}

/** The step snapping lands on: grid size over subdivisions. */
export function gridStep(): number {
  return Math.max(1, prefs.gridSize / Math.max(1, prefs.gridSub));
}
