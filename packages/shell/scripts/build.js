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
for (const file of ["index.html", "app.css"])
  copyFileSync(at(`static/${file}`), at(`dist/${file}`));
