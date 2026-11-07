// The packages the app adds at first run, built into `dist/bundled` as verified archives, with
// `index.json` naming each one's archive. They build from source, so the hashes are the same as
// `agentorg build` gives for the same source.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildPackage } from "@agentorg/sdk/build";

const at = (path) => new URL(`../${path}`, import.meta.url).pathname;
const BUNDLED = {
  installer: at("../installer"),
  chatgpt: at("../chatgpt"),
  assistant: at("../assistant"),
  board: at("../../examples/board"),
};
const out = at("dist/bundled");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "agentorg-bundle-"));
try {
  const index = {};
  for (const [name, dir] of Object.entries(BUNDLED)) {
    const built = await buildPackage(dir, { out: join(work, name) });
    if (built.manifest.name !== name)
      throw new Error(`${dir} builds the package ${built.manifest.name}, not ${name}.`);
    copyFileSync(built.file, join(out, basename(built.file)));
    index[name] = basename(built.file);
  }
  writeFileSync(join(out, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
