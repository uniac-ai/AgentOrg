// The window's page as static files for the app to show: one bundled script, its page and its
// styles. With --serve, it rebuilds on each change and serves the folder, for the app's dev mode.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { context } from "esbuild";

const at = (path) => new URL(`../${path}`, import.meta.url).pathname;
const serve = process.argv.includes("--serve");
mkdirSync(at("dist"), { recursive: true });
copyFileSync(at("static/index.html"), at("dist/index.html"));
const tailwind = [
  join(
    dirname(createRequire(import.meta.url).resolve("@tailwindcss/cli/package.json")),
    "dist",
    "index.mjs",
  ),
  "-i",
  at("src/styles.css"),
  "-o",
  at("dist/app.css"),
];
const scripts = await context({
  entryPoints: [at("src/main.tsx")],
  outfile: at("dist/app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: !serve,
  define: { "process.env.NODE_ENV": serve ? '"development"' : '"production"' },
  legalComments: "none",
  logLevel: "warning",
});
if (serve) {
  spawn(process.execPath, [...tailwind, "--watch"], { cwd: at("."), stdio: "inherit" });
  await scripts.watch();
  const { port } = await scripts.serve({ servedir: at("dist"), port: 5180 });
  console.log(`The window's page: http://localhost:${port}/`);
} else {
  await scripts.rebuild();
  await scripts.dispose();
  execFileSync(process.execPath, tailwind, {
    cwd: at("."),
    stdio: ["ignore", "ignore", "inherit"],
  });
}
