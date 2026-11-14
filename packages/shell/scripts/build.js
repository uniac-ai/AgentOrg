// The shell as static files for the gateway to serve: one bundled script, its page and its styles.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
copyFileSync(at("static/index.html"), at("dist/index.html"));
// One stylesheet: the tokens, the sign-in page's styles, and Tailwind's classes as the components
// use them.
const tailwind = dirname(createRequire(import.meta.url).resolve("@tailwindcss/cli/package.json"));
execFileSync(
  process.execPath,
  [join(tailwind, "dist", "index.mjs"), "-i", at("src/styles.css"), "-o", at("dist/app.css")],
  { cwd: at("."), stdio: ["ignore", "ignore", "inherit"] },
);
// What the folder is, for the core that serves it: the release it comes with, which is the CLI's
// version, and the contract it speaks: "The frontend contract" in the repository's README.
const CONTRACT = 1;
const { version } = JSON.parse(readFileSync(at("../app/package.json"), "utf8"));
writeFileSync(at("dist/frontend.json"), `${JSON.stringify({ version, contract: CONTRACT })}\n`);
