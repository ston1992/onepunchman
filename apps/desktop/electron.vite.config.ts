import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // Server the packaged app talks to; override at build time with TWINLY_API_URL.
    define: { __API_URL__: JSON.stringify(process.env.TWINLY_API_URL ?? "http://localhost:8787") },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: "src/renderer",
    plugins: [react()],
  },
});
