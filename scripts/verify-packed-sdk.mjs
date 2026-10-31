/** Install the distributable in an owned consumer, check declarations and run its public flow. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tarball = process.argv[2];
assert.ok(tarball, "usage: node scripts/verify-packed-sdk.mjs <sdk.tgz> [report.json]");
const report = process.argv[3] && resolve(process.argv[3]);
const directory = mkdtempSync(join(tmpdir(), "agentorg-sdk-consumer-"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const version = (name) => lock.packages[`node_modules/${name}`].version;

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: directory,
    env,
    stdio: "inherit",
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
}

try {
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "agentorg-packed-consumer-proof",
      private: true,
      type: "module",
      dependencies: { "@agentorg/cli": `file:${resolve(tarball)}` },
      devDependencies: {
        "@types/node": version("@types/node"),
        typescript: version("typescript"),
        zod: version("zod"),
      },
    }),
  );
  for (const [source, target] of [
    ["packed-consumer.ts.txt", "consumer.ts"],
    ["packed-tsconfig.json", "tsconfig.json"],
    ["packed-flow.mjs", "flow.mjs"],
  ]) {
    copyFileSync(new URL(`../test/fixtures/${source}`, import.meta.url), join(directory, target));
  }
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
  run(process.execPath, [join(directory, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"]);
  const output = join(directory, "flow-result.json");
  run(process.execPath, ["flow.mjs"], { ...process.env, PROOF_OUTPUT: output });
  const result = {
    ...JSON.parse(readFileSync(output, "utf8")),
    strictDeclarations: true,
    skipLibCheck: false,
  };
  if (report) writeFileSync(report, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
