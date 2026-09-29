import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const uiDir = path.dirname(fileURLToPath(import.meta.url));
const vditorRoot = path.join(uiDir, "node_modules", "vditor");

function vditorAssets(): Plugin {
  const types: Record<string, string> = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".map": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".wasm": "application/wasm",
  };
  return {
    name: "vditor-assets",
    configureServer(server) {
      server.middlewares.use("/vditor", (req, res, next) => {
        const raw = decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/+/, "");
        const file = path.resolve(vditorRoot, raw);
        const relative = path.relative(vditorRoot, file);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          next();
          return;
        }
        fs.stat(file, (error, stat) => {
          if (error || !stat.isFile()) {
            next();
            return;
          }
          res.setHeader("Content-Type", types[path.extname(file).toLowerCase()] || "application/octet-stream");
          fs.createReadStream(file).pipe(res);
        });
      });
    },
    closeBundle() {
      fs.cpSync(path.join(vditorRoot, "dist"), path.join(uiDir, "dist", "vditor", "dist"), { recursive: true });
    },
  };
}

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [
    react(),
    vditorAssets(),
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
