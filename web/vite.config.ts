// Builds the decisions page into dist/page, which the service serves at `/`.
// `npm run dev:page` serves it with hot reload and forwards /ui to a running `agentorg serve`.

import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.join(root, "src") } },
  build: {
    outDir: path.join(root, "../dist/page"),
    emptyOutDir: true,
    modulePreload: { polyfill: false },
  },
  server: {
    proxy: { "/ui": `http://127.0.0.1:${process.env.AGENTORG_PORT ?? 8740}` },
  },
});
