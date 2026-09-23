import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [
    react(),
    {
      name: "tauri-relative-html",
      transformIndexHtml(html) {
        return html.replaceAll(" crossorigin", "");
      },
    },
  ],
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  optimizeDeps: {
    include: ["monaco-editor", "highlight.js/lib/common", "@xterm/xterm", "@xterm/addon-fit"],
  },
});
