import { readFileSync } from "node:fs";

/** The package version, read from package.json two levels above the compiled `dist/src`. */
export const VERSION: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;
