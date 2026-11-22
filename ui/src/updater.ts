// Checks GitHub Releases for a newer signed build when the app starts, and
// offers to install it. Dev builds never check.

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { el } from "./dom";

interface Hooks {
  /** Resolves true when it is fine to close the open project. */
  confirmDiscard(action: string): Promise<boolean>;
  toast(message: string, tone?: "error" | "info"): void;
}

export async function checkForUpdate(host: HTMLElement, hooks: Hooks): Promise<void> {
  if (import.meta.env.DEV) return;
  let update: Update | null;
  try {
    update = await check();
  } catch (err) {
    // Offline or no release yet: stay quiet, the app works without it.
    console.warn("Update check failed", err);
    return;
  }
  if (!update) return;
  showBanner(host, update, hooks);
}

function showBanner(host: HTMLElement, update: Update, hooks: Hooks) {
  const text = el("span", { class: "update-text" }, `Version ${update.version} is available.`);
  const install = el("button", { class: "update-btn update-install" }, "Update and restart");
  const later = el("button", { class: "update-btn" }, "Later");
  const banner = el("div", { class: "toast update-banner", role: "status" }, text, install, later);
  host.append(banner);

  later.addEventListener("click", () => banner.remove());
  install.addEventListener("click", async () => {
    if (!(await hooks.confirmDiscard("Update"))) return;
    install.disabled = later.disabled = true;
    let total = 0;
    let done = 0;
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          done += e.data.chunkLength;
          text.textContent = total
            ? `Downloading ${Math.round((done / total) * 100)}%…`
            : "Downloading…";
        } else text.textContent = "Installing…";
      });
      await relaunch();
    } catch (err) {
      banner.remove();
      hooks.toast(`Could not update: ${err}`, "error");
    }
  });
}
