// The host runner as one self-contained Node program, so a package Actor's process reads only this
// file and its package's folder: `@agentorg/sdk/host/runner.js`.
import { build } from "esbuild";

await build({
  entryPoints: [new URL("../src/host-main.ts", import.meta.url).pathname],
  outfile: new URL("../dist/host/runner.js", import.meta.url).pathname,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  legalComments: "none",
  logLevel: "warning",
});
