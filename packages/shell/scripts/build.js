// The shell as static files for the gateway to serve: one bundled script, its page and its styles,
// and the licences of the packages they take in.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { at, bundleApp, scriptPackages, stylesheetPackages, thirdPartyLicenses } from "./bundle.js";

mkdirSync(at("dist"), { recursive: true });
const { metafile } = await bundleApp();
copyFileSync(at("static/index.html"), at("dist/index.html"));
// The tab's icon: AgentOrg's icon, scaled down to 16 and 32 pixels (`sips -Z`).
for (const icon of ["icon-16.png", "icon-32.png"])
  copyFileSync(at(`static/${icon}`), at(`dist/${icon}`));
// One stylesheet: the tokens, the sign-in page's styles, and Tailwind's classes as the components
// use them.
const tailwind = dirname(createRequire(import.meta.url).resolve("@tailwindcss/cli/package.json"));
execFileSync(
  process.execPath,
  [join(tailwind, "dist", "index.mjs"), "-i", at("src/styles.css"), "-o", at("dist/app.css")],
  { cwd: at("."), stdio: ["ignore", "ignore", "inherit"] },
);
// What the script and the stylesheet take in from npm, each package with its licence.
writeFileSync(
  at("dist/THIRD_PARTY_LICENSES.txt"),
  thirdPartyLicenses(new Set([...scriptPackages(metafile), ...stylesheetPackages()])),
);
// What the folder is, for the core that serves it: the release it comes with, which is the CLI's
// version, and the contract it speaks: "The frontend contract" in the repository's README.
const CONTRACT = 1;
const { version } = JSON.parse(readFileSync(at("../app/package.json"), "utf8"));
writeFileSync(at("dist/frontend.json"), `${JSON.stringify({ version, contract: CONTRACT })}\n`);
