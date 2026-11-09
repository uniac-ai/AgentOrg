// The shell as static files for the gateway to serve: one bundled script, its page and its styles.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const at = (path) => new URL(`../${path}`, import.meta.url).pathname;
mkdirSync(at("dist"), { recursive: true });
await build({
  entryPoints: [at("src/main.tsx")],
  outfile: at("dist/app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  logLevel: "warning",
});
// A new agent's connections, for Node too: what a test of New agent installs.
await build({
  entryPoints: [at("src/agent-bindings.ts")],
  outfile: at("dist/agent-bindings.js"),
  format: "esm",
  platform: "neutral",
  target: "es2022",
  logLevel: "warning",
});
copyFileSync(at("static/index.html"), at("dist/index.html"));
// One stylesheet: the older pages' styles, and Tailwind's classes as the components use them. Not
// minified: that would rewrite the tokens' values, which views read as written.
const tailwind = dirname(createRequire(import.meta.url).resolve("@tailwindcss/cli/package.json"));
execFileSync(
  process.execPath,
  [join(tailwind, "dist", "index.mjs"), "-i", at("src/styles.css"), "-o", at("dist/app.css")],
  { cwd: at("."), stdio: ["ignore", "ignore", "inherit"] },
);
