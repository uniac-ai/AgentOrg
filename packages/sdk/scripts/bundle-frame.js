// The frame runtime as one self-contained browser script, the only one a view's frame loads
// before the view's own bundle: `@agentorg/sdk/frame/runtime.js`.
import { build } from "esbuild";

await build({
  entryPoints: [new URL("../src/frame-entry.ts", import.meta.url).pathname],
  outfile: new URL("../dist/frame/runtime.js", import.meta.url).pathname,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  legalComments: "none",
  logLevel: "warning",
});
