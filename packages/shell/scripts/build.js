// The shell as static files for the gateway to serve: one bundled script, its page and its styles.
import { copyFileSync, mkdirSync } from "node:fs";
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
for (const file of ["index.html", "app.css"])
  copyFileSync(at(`static/${file}`), at(`dist/${file}`));
