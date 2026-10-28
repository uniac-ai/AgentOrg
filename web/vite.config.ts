// Builds the web app into dist/page, which the human actor serves at `/`.
// `npm run dev:page` serves it with hot reload and forwards its API and sign-in to a running
// `agentorg human`.

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
    proxy: Object.fromEntries(
      ["/api", "/signin"].map((path) => [
        path,
        `http://127.0.0.1:${process.env.AGENTORG_HUMAN_PORT ?? 8741}`,
      ]),
    ),
  },
});
