import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// dist/test/install.test.js → the repository's install.sh.
const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "install.sh");

/**
 * install.sh on a machine its stand-ins describe: `uname`, `sysctl`, `sw_vers` and `id` answer as
 * `machine` says, first on the PATH. An account folder of its own is its HOME, so nothing of this one's is
 * touched. Each case here is refused before the script writes anything.
 */
async function install(
  t: test.TestContext,
  machine: { system?: string; arm64?: string; macos?: string; uid?: string },
  ...args: string[]
) {
  const root = mkdtempSync(join(tmpdir(), "agentorg-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const account = join(root, "account");
  mkdirSync(bin);
  mkdirSync(account);
  const standIn = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  standIn("uname", `echo ${machine.system ?? "Darwin"}`);
  // Apple silicon says so here even under Rosetta, where uname -m says x86_64.
  standIn("sysctl", `echo ${machine.arm64 ?? "1"}`);
  standIn("sw_vers", `echo ${machine.macos ?? "15.4"}`);
  standIn("id", `echo ${machine.uid ?? "501"}`);
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
    execFile(
      "bash",
      [script, ...args],
      { env: { HOME: account, PATH: `${bin}:/usr/bin:/bin` }, timeout: 30_000 },
      (error, stdout, stderr) =>
        done({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    ),
  );
  return { ...result, wrote: existsSync(join(account, ".agentorg")) };
}

test("install.sh refuses anything but a Mac with Apple silicon and macOS 13 or later, run as the person, and writes nothing then", async (t) => {
  for (const [machine, says] of [
    [
      { system: "Linux" },
      /^This installs AgentOrg on a Mac\. On another system, run it from npm: npx @agentorg\/cli@next\n$/,
    ],
    [{ arm64: "" }, /^AgentOrg's Mac app runs on Apple silicon only for now\.\n$/],
    [{ macos: "12.7" }, /^AgentOrg needs macOS 13 or later; this Mac has 12\.7\.\n$/],
    [{ uid: "0" }, /^Run this as yourself, not as root or with sudo/],
  ] as const) {
    const refused = await install(t, machine);
    assert.equal(refused.code, 1, JSON.stringify(machine));
    assert.match(refused.stderr, says);
    assert.equal(refused.wrote, false, "nothing is written before the checks pass");
  }
});

test("install.sh says what it takes, and refuses an option it doesn't know or a file that isn't there", async (t) => {
  const help = await install(t, {}, "--help");
  assert.equal(help.code, 0);
  assert.match(
    help.stdout,
    /^Installs AgentOrg \d+\.\d+\.\d+ on this Mac, or with --update moves to it\.\nUsage: bash install\.sh \[--update\]/,
  );
  const unknown = await install(t, {}, "--nope");
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /^Unknown option --nope\. Run it with --help/);
  const missing = await install(t, {}, "--app", "/no/such.zip");
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /\/no\/such\.zip isn't a file\./);
  assert.equal(missing.wrote, false);
  // Until a release publishes the Mac app, the plain line installs nothing and makes nothing.
  if (/^APP_SHA256=""$/m.test(readFileSync(script, "utf8"))) {
    const unpublished = await install(t, {});
    assert.equal(unpublished.code, 1);
    assert.match(unpublished.stderr, /^AgentOrg's Mac app for \d+\.\d+\.\d+ isn't published yet/);
    assert.equal(unpublished.wrote, false);
  }
});

test("install.sh pins Node by its published sum and names one release for the core and the Mac app", () => {
  const text = readFileSync(script, "utf8");
  assert.match(text, /^AGENTORG_VERSION="\d+\.\d+\.\d+"$/m);
  assert.match(text, /^NODE_VERSION="24\.\d+\.\d+"$/m);
  assert.match(text, /^NODE_SHA256="[0-9a-f]{64}"$/m);
  // The Mac app's sum is the release's, or none until it is published.
  assert.match(text, /^APP_SHA256="(?:[0-9a-f]{64})?"$/m);
  // The release's archive name the Mac app is published under.
  assert.match(text, /AgentOrg-\$AGENTORG_VERSION-mac-arm64\.zip/);
});
