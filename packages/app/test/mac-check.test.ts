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

// dist/test/mac-check.test.js → the repository's root and the release's macOS check.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const script = join(root, "scripts", "mac-release-check.sh");
const version = "0.0.31";
const zip = `AgentOrg-${version}-mac-arm64.zip`;
const core = `agentorg-core-${version}.tgz`;

/**
 * The release workflow's mac-check job, scripts/mac-release-check.sh, in a folder of its own, with
 * an account folder of its own as its HOME. Every program it could change something with is a
 * stand-in first on the PATH, which notes its name and arguments in `called`: `bash`, which runs
 * install.sh, `launchctl`, `gh` and Apple's tools. `gh release list` answers `releases`, and `gh
 * release view` the release's `assets`, each a line. `ditto` unpacks an AgentOrg.app, `spctl`
 * says `spctl`'s lines, a notarized app's assessment until changed, and `codesign`, `spctl` or
 * `xcrun` fails when `fails` names it. Nothing here passes as a GitHub-hosted runner, so nothing
 * installs into an account.
 */
function checking(t: test.TestContext) {
  const at = mkdtempSync(join(tmpdir(), "agentorg-mac-check-"));
  t.after(() => rmSync(at, { recursive: true, force: true }));
  const bin = join(at, "bin");
  const from = join(at, "from");
  const account = join(at, "account");
  const called = join(at, "called");
  const output = join(at, "output");
  for (const dir of [bin, from, account]) mkdirSync(dir);
  writeFileSync(join(at, "releases"), "");
  writeFileSync(join(at, "assets"), "");
  writeFileSync(join(at, "fails"), "");
  writeFileSync(
    join(at, "spctl"),
    "AgentOrg.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: A (TEAM)\n",
  );
  const standIn = (name: string, body = "") => {
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nprintf '%s\\n' "${name} $*" >>"${called}"\n${body}\n`,
    );
    chmodSync(join(bin, name), 0o755);
  };
  for (const name of ["bash", "launchctl"]) standIn(name);
  standIn(
    "gh",
    `case "$1 $2" in
"release list") cat "${join(at, "releases")}" ;;
"release view") cat "${join(at, "assets")}" ;;
esac`,
  );
  standIn("ditto", `mkdir -p "$4/AgentOrg.app"`);
  standIn("spctl", `cat "${join(at, "spctl")}"; ! grep -qx spctl "${join(at, "fails")}"`);
  for (const name of ["codesign", "xcrun"])
    standIn(name, `! grep -qx ${name} "${join(at, "fails")}"`);
  const run = (...args: string[]) => {
    writeFileSync(output, "");
    return new Promise<{ code: number; stdout: string; stderr: string; output: string }>((done) =>
      execFile(
        "/bin/bash",
        [script, ...args],
        {
          env: { HOME: account, PATH: `${bin}:/usr/bin:/bin`, GITHUB_OUTPUT: output },
          timeout: 30_000,
        },
        (error, stdout, stderr) =>
          done({
            code: error ? Number(error.code ?? 1) : 0,
            stdout,
            stderr,
            output: readFileSync(output, "utf8"),
          }),
      ),
    );
  };
  const calls = () =>
    existsSync(called) ? readFileSync(called, "utf8").split("\n").slice(0, -1) : [];
  const lines = (name: string, names: string[]) =>
    writeFileSync(join(at, name), names.map((one) => `${one}\n`).join(""));
  return {
    from,
    run,
    calls,
    /** What the run's files are: the Mac app and the core, by the names the release gives them. */
    made: (...names: string[]) => {
      for (const name of names) writeFileSync(join(from, name), name);
    },
    releases: (tags: string[]) => lines("releases", tags),
    assets: (names: string[]) => lines("assets", names),
    fails: (name: string) => writeFileSync(join(at, "fails"), `${name}\n`),
    spctl: (says: string[]) => lines("spctl", says),
  };
}

test("a check without the run's Mac app or core fails, naming the file, before anything is run", async (t) => {
  for (const command of ["apple", "fresh", "update"]) {
    for (const missing of command === "apple" ? [zip] : [zip, core]) {
      const check = checking(t);
      check.made(...[zip, core].filter((name) => name !== missing));
      const refused = await check.run(command, version, check.from);
      assert.equal(refused.code, 1, `${command} without ${missing}`);
      assert.equal(
        refused.stderr,
        `${check.from} has no ${missing}, which this release carries.\n`,
      );
      assert.deepEqual(check.calls(), [], "nothing is run");
    }
  }
});

test("the check takes its arguments as it says, and refuses others", async (t) => {
  const check = checking(t);
  check.made(zip, core);
  const usage = [
    "Usage: scripts/mac-release-check.sh apple|fresh|update VERSION FROM",
    "       scripts/mac-release-check.sh uninstall",
    "",
  ].join("\n");
  for (const [args, says] of [
    [[], usage],
    [["install", version, check.from], usage],
    [["fresh", version], "fresh takes VERSION and FROM.\n"],
    [["update", version, check.from, "--mac"], "update takes VERSION and FROM.\n"],
    [["apple", "v0.0.31", check.from], 'Not a version: "v0.0.31".\n'],
    [["previous", version], usage],
    [["uninstall", "now"], "uninstall takes nothing.\n"],
  ] as const) {
    const refused = await check.run(...args);
    assert.equal(refused.code, 1, args.join(" "));
    assert.equal(refused.stderr, says, args.join(" "));
  }
  assert.deepEqual(check.calls(), [], "nothing is run");
});

test("fresh, update and uninstall run only on a GitHub-hosted macOS runner, never on a person's own Mac", async (t) => {
  const check = checking(t);
  check.made(zip, core);
  check.releases([`v${version}`, "v0.0.30"]);
  check.assets(["install.sh", "agentorg-core-0.0.30.tgz", "AgentOrg-0.0.30-mac-arm64.zip"]);
  for (const [args, what] of [
    [["fresh", version, check.from], "fresh"],
    [["update", version, check.from], "update"],
    [["uninstall"], "uninstall"],
  ] as const) {
    const refused = await check.run(...args);
    assert.equal(refused.code, 1, what);
    assert.match(
      refused.stderr,
      new RegExp(
        `^${what} installs AgentOrg into this account, so it runs only on a GitHub-hosted macOS runner, never on a person's own Mac\\.\\n$`,
      ),
    );
  }
  // Only update's reading of the releases ran: nothing was downloaded, and install.sh never ran.
  assert.deepEqual(check.calls(), [
    "gh release list --exclude-drafts --limit 100 --json tagName --jq .[].tagName",
    "gh release view v0.0.30 --json assets --jq .assets[].name",
  ]);
});

test("an update starts from the newest published release below this version, never this tag", async (t) => {
  const check = checking(t);
  check.made(zip, core);
  // As GitHub lists them, newest first: this tag's own, should a run be repeated, one after it,
  // and tags that aren't a release's version. The one found has no install.sh, so update stops there.
  check.releases([
    "v0.0.32",
    `v${version}`,
    "v0.0.31-rc.1",
    "nightly",
    "v0.0.9",
    "v0.0.30",
    "v0.0.29",
  ]);
  const found = await check.run("update", version, check.from);
  assert.equal(found.code, 0, found.stderr);
  assert.match(found.stdout, new RegExp(`^The release before v${version} is v0\\.0\\.30\\.\\n`));
  assert.deepEqual(check.calls(), [
    "gh release list --exclude-drafts --limit 100 --json tagName --jq .[].tagName",
    "gh release view v0.0.30 --json assets --jq .assets[].name",
  ]);
  // With only this tag's own release, there is none before it, and no update to check.
  check.releases([`v${version}`]);
  const first = await check.run("update", version, check.from);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(
    first.stdout,
    `There is no release before v${version}, so there is no update to check yet.\n`,
  );
  assert.equal(first.output, "updated=false\n");
});

test("an update from a release before with no install.sh, or no Mac app, is skipped and says why; with both it goes on", async (t) => {
  const check = checking(t);
  check.made(zip, core);
  check.releases([`v${version}`, "v0.0.30"]);
  const made = ["agentorg-core-0.0.30.tgz", "agentorg-frontend-0.0.30.tgz", "SHA256SUMS"];
  // A release made by hand, before the release run made its own: no install.sh.
  check.assets([...made, "AgentOrg-0.0.30-mac-arm64.zip"]);
  const unscripted = await check.run("update", version, check.from);
  assert.equal(unscripted.code, 0, unscripted.stderr);
  assert.equal(
    unscripted.stdout,
    [
      `The release before v${version} is v0.0.30.`,
      "Release v0.0.30 has no install.sh: it was made before the release run made its own, so there is no update to check from it. Skipped.",
      "",
    ].join("\n"),
  );
  assert.equal(unscripted.output, "updated=false\n");
  // install.sh but no Mac app: that install.sh refuses to install without one.
  check.assets([...made, "install.sh"]);
  const appless = await check.run("update", version, check.from);
  assert.equal(appless.code, 0, appless.stderr);
  assert.match(
    appless.stdout,
    /\nRelease v0\.0\.30 carries no Mac app, so its install\.sh can't install it, and there is no update to check from it\. Skipped\.\n$/,
  );
  assert.equal(appless.output, "updated=false\n");
  // install.sh and the Mac app, but not the core: not one the release run made.
  check.assets(["install.sh", "AgentOrg-0.0.30-mac-arm64.zip"]);
  const coreless = await check.run("update", version, check.from);
  assert.equal(coreless.code, 1);
  assert.equal(
    coreless.stderr,
    "Release v0.0.30 has install.sh but no agentorg-core-0.0.30.tgz, so it can't be installed from its own files.\n",
  );
  // All three: it goes on, as far as a person's Mac lets it, and is refused there.
  check.assets([...made, "install.sh", "AgentOrg-0.0.30-mac-arm64.zip"]);
  const whole = await check.run("update", version, check.from);
  assert.equal(whole.code, 1);
  assert.match(whole.stderr, /^update installs AgentOrg into this account, so it runs only on/);
  assert.equal(whole.output, "");
  assert.ok(!check.calls().some((call) => call.startsWith("gh release download")));
  assert.ok(!check.calls().some((call) => call.startsWith("bash ")), "install.sh never ran");
});

test("each of Apple's checks on the Mac app must pass: its signature, Gatekeeper's assessment and its notarization ticket", async (t) => {
  for (const failing of ["", "codesign", "spctl", "xcrun"]) {
    const check = checking(t);
    check.made(zip);
    if (failing) check.fails(failing);
    const done = await check.run("apple", version, check.from);
    const ran = check.calls();
    assert.ok(ran[0]?.startsWith(`ditto -x -k ${check.from}/${zip} `), ran[0]);
    const app = `${ran[0]?.split(" ").at(-1)}/AgentOrg.app`;
    const checks = [
      `codesign --verify --deep --strict --verbose=2 ${app}`,
      `spctl -a -t exec -vv ${app}`,
      `xcrun stapler validate ${app}`,
    ];
    if (!failing) {
      assert.equal(done.code, 0, done.stderr);
      assert.deepEqual(ran.slice(1), checks);
      assert.match(done.stdout, /passes Apple's checks: its signature, Gatekeeper's assessment/);
      continue;
    }
    // The first that fails stops the check, named, and none after it runs.
    const at = checks.findIndex((one) => one.startsWith(`${failing} `));
    assert.equal(done.code, 1, failing);
    assert.deepEqual(ran.slice(1), checks.slice(0, at + 1));
    assert.match(
      done.stderr,
      new RegExp(
        `^The Mac app fails .+: ${failing} exited with 1, so the release stops here\\.\\n$`,
      ),
    );
  }
});

test("Gatekeeper's assessment counts only as notarized by a Developer ID, so a Mac with Gatekeeper off can't pass it", async (t) => {
  const check = checking(t);
  check.made(zip);
  // What spctl says with Gatekeeper switched off: accepted, whatever the app.
  check.spctl(["AgentOrg.app: accepted", "override=security disabled"]);
  const off = await check.run("apple", version, check.from);
  assert.equal(off.code, 1);
  assert.match(off.stdout, /\noverride=security disabled\n$/);
  assert.equal(
    off.stderr,
    "Gatekeeper doesn't assess the Mac app as notarized by a Developer ID, so the release stops here.\n",
  );
  assert.ok(!check.calls().some((call) => call.startsWith("xcrun ")), "stapler isn't run");
});
