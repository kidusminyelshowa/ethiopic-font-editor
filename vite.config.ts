/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// Tauri serves the UI from a fixed dev port and expects a plain static build.
export default defineConfig({
  root: "ui",
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  test: { environment: "jsdom" },
});
