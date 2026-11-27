// Keyboard shortcuts the designer can rebind. Each action has a default; a
// rebinding is kept per user in local storage, like the canvas preferences.

export interface ShortcutAction {
  id: string;
  label: string;
  group: "Tools" | "Edit" | "Paths" | "View" | "Kerning";
  /** Default keys, written as `Ctrl+Shift+O`. Ctrl means Cmd on a Mac. */
  keys: string;
}

export const ACTIONS: ShortcutAction[] = [
  { id: "tool.select", label: "Move", group: "Tools", keys: "V" },
  { id: "tool.direct", label: "Direct selection", group: "Tools", keys: "A" },
  { id: "tool.pen", label: "Pen", group: "Tools", keys: "P" },
  { id: "tool.pencil", label: "Pencil", group: "Tools", keys: "B" },
  { id: "tool.knife", label: "Knife", group: "Tools", keys: "K" },
  { id: "tool.eraser", label: "Eraser", group: "Tools", keys: "Shift+E" },
  { id: "tool.measure", label: "Measure", group: "Tools", keys: "M" },
  { id: "tool.rect", label: "Rectangle", group: "Tools", keys: "R" },
  { id: "tool.ellipse", label: "Ellipse", group: "Tools", keys: "E" },
  { id: "tool.hand", label: "Hand", group: "Tools", keys: "H" },
  { id: "edit.selectAll", label: "Select all", group: "Edit", keys: "Ctrl+A" },
  { id: "edit.invert", label: "Invert selection", group: "Edit", keys: "Ctrl+Shift+I" },
  { id: "edit.duplicate", label: "Duplicate", group: "Edit", keys: "Ctrl+D" },
  { id: "edit.lock", label: "Lock paths", group: "Edit", keys: "Ctrl+Shift+L" },
  { id: "edit.hide", label: "Hide paths", group: "Edit", keys: "Ctrl+Shift+H" },
  { id: "path.reverse", label: "Reverse direction", group: "Paths", keys: "Ctrl+Shift+R" },
  { id: "path.removeOverlap", label: "Remove overlap", group: "Paths", keys: "Ctrl+Shift+O" },
  { id: "path.join", label: "Join ends", group: "Paths", keys: "Shift+J" },
  { id: "path.cycleNode", label: "Cycle point type", group: "Paths", keys: "Shift+C" },
  { id: "view.fit", label: "Fit the glyph", group: "View", keys: "Shift+1" },
  { id: "view.selection", label: "Zoom to selection", group: "View", keys: "Shift+2" },
  { id: "view.actual", label: "Zoom to 100%", group: "View", keys: "Shift+0" },
  { id: "view.zoomIn", label: "Zoom in", group: "View", keys: "Ctrl+=" },
  { id: "view.zoomOut", label: "Zoom out", group: "View", keys: "Ctrl+-" },
  { id: "view.preview", label: "Preview (hold)", group: "View", keys: "`" },
  { id: "text.next", label: "Next glyph in the line", group: "View", keys: "PageDown" },
  { id: "text.prev", label: "Previous glyph in the line", group: "View", keys: "PageUp" },
  { id: "kern.tighter", label: "Tighten pair by 1", group: "Kerning", keys: "Alt+ArrowLeft" },
  { id: "kern.looser", label: "Loosen pair by 1", group: "Kerning", keys: "Alt+ArrowRight" },
  { id: "kern.tighter10", label: "Tighten pair by 10", group: "Kerning", keys: "Alt+Shift+ArrowLeft" },
  { id: "kern.looser10", label: "Loosen pair by 10", group: "Kerning", keys: "Alt+Shift+ArrowRight" },
  { id: "kern.exception", label: "Toggle exception", group: "Kerning", keys: "Alt+E" },
];

const KEY = "efe.shortcuts";

function loadOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // Defaults.
  }
  return {};
}

let overrides: Record<string, string> = loadOverrides();
const listeners = new Set<() => void>();

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(overrides));
  } catch {
    // Applies for this session only.
  }
  for (const fn of listeners) fn();
}

export function onShortcuts(fn: () => void): void {
  listeners.add(fn);
}

/** The keys an action runs on now ("" when it has none). */
export function keysFor(id: string): string {
  return overrides[id] ?? ACTIONS.find((a) => a.id === id)?.keys ?? "";
}

/** The keys of a key press, written the way `keys` are. */
export function comboOf(e: { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): string {
  let k: string;
  if (e.code.startsWith("Key")) k = e.code.slice(3);
  else if (e.code.startsWith("Digit")) k = e.code.slice(5);
  else if (e.code === "Backquote") k = "`";
  else if (e.code === "Equal") k = "=";
  else if (e.code === "Minus") k = "-";
  else k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (["Control", "Meta", "Alt", "Shift"].includes(k)) return "";
  const mods = [e.ctrlKey || e.metaKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : ""].filter(Boolean);
  return [...mods, k].join("+");
}

/** The action bound to these keys, if any. */
export function actionFor(combo: string): string | null {
  if (!combo) return null;
  for (const a of ACTIONS) if (keysFor(a.id) === combo) return a.id;
  return null;
}

/** Keys that were an action's default but now do nothing, because it moved. */
export function isFreedDefault(combo: string): boolean {
  return !!combo && ACTIONS.some((a) => a.keys === combo && keysFor(a.id) !== combo) && !actionFor(combo);
}

/** Bind an action to new keys; whatever had them before loses them. Returns that action's label, if any. */
export function setBinding(id: string, combo: string): string | null {
  const taken = actionFor(combo);
  let lost: string | null = null;
  if (taken && taken !== id) {
    overrides[taken] = "";
    lost = ACTIONS.find((a) => a.id === taken)?.label ?? null;
  }
  const def = ACTIONS.find((a) => a.id === id)?.keys;
  if (combo === def) delete overrides[id];
  else overrides[id] = combo;
  save();
  return lost;
}

export function resetBindings(): void {
  overrides = {};
  save();
}

/** For display: `Ctrl+Shift+O` as `Ctrl Shift O`. */
export const showKeys = (keys: string) => keys.split("+").join(" ") || "None";
