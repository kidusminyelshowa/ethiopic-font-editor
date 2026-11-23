/**
 * Window chrome: the app draws its own title bar (the toolbar), with window
 * controls on Windows and Linux and the native traffic lights on macOS, and
 * keeps the light/dark choice tucked into the "More" menu.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemeChoice = "system" | "light" | "dark";

const THEME_KEY = "fidel.theme";
const isMac = /Mac/i.test(navigator.userAgent);

function storedTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    // Storage can be unavailable; fall back to the system.
  }
  return "system";
}

export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Not remembered; it still applies for this session.
  }
  // Keep the native frame (shadow, macOS traffic lights) in step.
  void getCurrentWindow()
    .setTheme(choice === "system" ? null : choice)
    .catch(() => {});
  for (const item of document.querySelectorAll<HTMLElement>("[data-theme-choice]")) {
    item.setAttribute("aria-checked", String(item.dataset.themeChoice === choice));
  }
}

function setupMenu() {
  const btn = document.querySelector<HTMLButtonElement>("#app-menu-btn");
  const menu = document.querySelector<HTMLElement>("#app-menu");
  if (!btn || !menu) return;
  const close = () => {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) menu.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  });
  menu.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      close();
      btn.focus();
    }
  });
  for (const item of menu.querySelectorAll<HTMLElement>("[data-theme-choice]")) {
    item.addEventListener("click", () => {
      applyTheme(item.dataset.themeChoice as ThemeChoice);
      close();
    });
  }
}

function setupWindowControls() {
  const win = getCurrentWindow();
  const controls = document.querySelector<HTMLElement>("#window-controls");
  if (!controls) return;
  if (isMac) {
    controls.hidden = true;
    return;
  }
  controls.querySelector('[data-win="minimize"]')?.addEventListener("click", () => void win.minimize());
  controls.querySelector('[data-win="maximize"]')?.addEventListener("click", () => void win.toggleMaximize());
  // Goes through onCloseRequested, so unsaved work is still asked about.
  controls.querySelector('[data-win="close"]')?.addEventListener("click", () => void win.close());
  const syncMax = async () => {
    controls.classList.toggle("maximized", await win.isMaximized().catch(() => false));
  };
  void win.onResized(() => void syncMax());
  void syncMax();
}

export function setupChrome() {
  if (isMac) document.documentElement.classList.add("platform-mac");
  applyTheme(storedTheme());
  setupMenu();
  setupWindowControls();
}
