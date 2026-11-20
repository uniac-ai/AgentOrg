import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CHANNEL } from "../src/installed.ts";

// dist/test/install.test.js → the repository's root, its install.sh and its pin of the Mac app.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const script = join(root, "install.sh");
const pinned = join(root, "mac-app.json");

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
  // The Mac app's version, and its sum, or none until it is published.
  assert.match(text, /^APP_VERSION="\d+\.\d+\.\d+"$/m);
  assert.match(text, /^APP_SHA256="(?:[0-9a-f]{64})?"$/m);
  // The release's archive name the Mac app is published under.
  assert.match(text, /AgentOrg-\$AGENTORG_VERSION-mac-arm64\.zip/);
});

test("install.sh carries the Mac app mac-app.json pins: its version, and its archive's sum or none", () => {
  const pin = JSON.parse(readFileSync(pinned, "utf8"));
  assert.deepEqual(Object.keys(pin).sort(), ["sha256", "version"]);
  assert.match(pin.version, /^\d+\.\d+\.\d+$/);
  assert.match(pin.sha256, /^(?:[0-9a-f]{64})?$/);
  const text = readFileSync(script, "utf8");
  assert.equal(text.match(/^APP_VERSION="(.*)"$/m)?.[1], pin.version);
  assert.equal(text.match(/^APP_SHA256="(.*)"$/m)?.[1], pin.sha256);
});

/**
 * The release's Mac app job, scripts/carry-mac-app.sh, on a pin of its own. curl serves AgentComputer's
 * release from `served`, gh answers GitHub's digest as `digest`, and each leaves a mark when run.
 */
function carrier(t: test.TestContext) {
  const at = mkdtempSync(join(tmpdir(), "agentorg-carry-"));
  t.after(() => rmSync(at, { recursive: true, force: true }));
  const bin = join(at, "bin");
  const served = join(at, "served");
  mkdirSync(bin);
  mkdirSync(served);
  const standIn = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\ntouch "${join(at, "fetched")}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  standIn(
    "curl",
    `while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac; shift; done
cp "${served}/\${url##*/}" "$out"`,
  );
  standIn("gh", `cat "${join(at, "digest")}"`);
  const out = join(at, "out");
  const run = (pin: object, digest = "") => {
    writeFileSync(join(at, "pin.json"), JSON.stringify(pin));
    writeFileSync(join(at, "digest"), digest);
    writeFileSync(join(at, "output"), "");
    return new Promise<{ code: number; stdout: string; stderr: string; output: string }>((done) =>
      execFile(
        "bash",
        [join(root, "scripts", "carry-mac-app.sh"), join(at, "pin.json"), out],
        {
          env: { PATH: `${bin}:/usr/bin:/bin`, GITHUB_OUTPUT: join(at, "output") },
          timeout: 30_000,
        },
        (error, stdout, stderr) =>
          done({
            code: error ? Number(error.code ?? 1) : 0,
            stdout,
            stderr,
            output: readFileSync(join(at, "output"), "utf8"),
          }),
      ),
    );
  };
  return { run, served, out, fetched: () => existsSync(join(at, "fetched")) };
}

test("AgentOrg names one AgentComputer version: the SDK's pins, the program's development pins and mac-app.json's", () => {
  const read = (...path: string[]) => JSON.parse(readFileSync(join(root, ...path), "utf8"));
  const connector = read("packages", "computer", "package.json");
  const cli = read("packages", "app", "package.json");
  const sdk = connector.dependencies["@agentorg/computer-sdk"];
  assert.match(sdk, /^\d+\.\d+\.\d+$/);
  const named = {
    "the cli's SDK": cli.dependencies["@agentorg/computer-sdk"],
    "the connector's program, for its tests": connector.devDependencies["@agentorg/computer"],
    "the cli's program, for its tests": cli.devDependencies["@agentorg/computer"],
    "mac-app.json": read("mac-app.json").version,
  };
  assert.deepEqual(named, Object.fromEntries(Object.keys(named).map((what) => [what, sdk])));
});

test("with no sum pinned, the release's Mac app job fetches nothing, carries nothing and passes", async (t) => {
  const carry = carrier(t);
  const none = await carry.run({ version: "0.0.32", sha256: "" });
  assert.equal(none.code, 0, none.stderr);
  assert.match(none.stdout, /pins no sum: no Mac app of AgentComputer 0\.0\.32 is published yet/);
  assert.equal(none.output, "carried=false\n");
  assert.equal(existsSync(carry.out), false);
  assert.equal(carry.fetched(), false);
  // What isn't a version or a sum is refused before anything is fetched.
  for (const pin of [
    { version: "next", sha256: "" },
    { version: "0.0.32", sha256: "not-a-sum" },
  ]) {
    const refused = await carry.run(pin);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /isn't one/);
    assert.equal(carry.fetched(), false);
  }
});

test("with a sum pinned, the job carries AgentComputer's archive unchanged under the name install.sh fetches, once every sum agrees", async (t) => {
  const carry = carrier(t);
  const archive = Buffer.from("the archive's bytes");
  const sum = createHash("sha256").update(archive).digest("hex");
  const other = createHash("sha256").update("other bytes").digest("hex");
  const name = "AgentOrg-mac-arm64-0.0.32.zip";
  writeFileSync(join(carry.served, name), archive);
  writeFileSync(join(carry.served, "SHA256SUMS"), `${other}  other.zip\n${sum}  ${name}\n`);
  const agentorg = JSON.parse(readFileSync(join(root, "packages", "app", "package.json"), "utf8"))
    .version as string;
  const carried = `AgentOrg-${agentorg}-mac-arm64.zip`;

  // A sum that disagrees with the pin's, the release's SHA256SUMS or GitHub's digest carries nothing.
  for (const [pinned, digest, says] of [
    [other, `sha256:${sum}`, /sum is [0-9a-f]{64}, not the [0-9a-f]{64}/],
    [sum, `sha256:${other}`, /GitHub's digest of AgentOrg-mac-arm64-0\.0\.32\.zip is sha256:/],
  ] as const) {
    const refused = await carry.run({ version: "0.0.32", sha256: pinned }, digest);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, says);
    assert.equal(refused.output, "");
    assert.equal(existsSync(carry.out), false);
  }
  writeFileSync(join(carry.served, "SHA256SUMS"), `${other}  ${name}\n`);
  const unlisted = await carry.run({ version: "0.0.32", sha256: sum }, `sha256:${sum}`);
  assert.equal(unlisted.code, 1);
  assert.match(
    unlisted.stderr,
    /SHA256SUMS of v0\.0\.32 gives AgentOrg-mac-arm64-0\.0\.32\.zip [0-9a-f]{64}, not/,
  );
  assert.equal(existsSync(carry.out), false);

  writeFileSync(join(carry.served, "SHA256SUMS"), `${sum} *${name}\n`);
  const done = await carry.run({ version: "0.0.32", sha256: sum }, `sha256:${sum}`);
  assert.equal(done.code, 0, done.stderr);
  assert.equal(done.output, "carried=true\n");
  assert.deepEqual(readFileSync(join(carry.out, carried)), archive);
  assert.equal(readFileSync(join(carry.out, "SHA256SUMS"), "utf8"), `${sum}  ${carried}\n`);
});

const tagsAt = "https://registry.npmjs.org/-/package/@agentorg/cli/dist-tags";
const download = "https://github.com/uniac-ai/AgentOrg/releases/download";

/**
 * get.sh, the line's script, with a stand-in curl first on the PATH: it answers npm's dist-tags as
 * `tag` sets them and the releases from `served/releases/v<version>/<file>`, fails as `curl -f`
 * does for anything else, and records each URL in `asked` and each call's options in `options`. The
 * release's install.sh is whatever a case serves; shasum is the Mac's own. `left` is what get.sh
 * left in its TMPDIR.
 */
function getter(t: test.TestContext) {
  const at = mkdtempSync(join(tmpdir(), "agentorg-get-"));
  t.after(() => rmSync(at, { recursive: true, force: true }));
  const bin = join(at, "bin");
  const served = join(at, "served");
  const temp = join(at, "tmp");
  for (const made of [bin, temp, served]) mkdirSync(made, { recursive: true });
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh
options=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; *) options="$options $1" ;; esac; shift; done
printf '%s\\n' "$url" >> "${join(at, "asked")}"
printf '%s\\n' "$options" >> "${join(at, "options")}"
case "$url" in
${tagsAt}) file="${served}/dist-tags" ;;
${download}/*) file="${served}/releases/\${url#${download}/}" ;;
*) exit 6 ;;
esac
[ -f "$file" ] || exit 22
cp "$file" "$out"
`,
  );
  chmodSync(join(bin, "curl"), 0o755);
  const ran = join(at, "ran");
  const tags: Record<string, string> = {};
  /** npm's dist-tags, flat as it answers them, with `channel` naming `version`. */
  const tag = (channel: string, version: string) => {
    tags[channel] = version;
    writeFileSync(join(served, "dist-tags"), JSON.stringify(tags));
  };
  /** A release whose install.sh records its arguments' count and them in `ran`, and SHA256SUMS as `sums` writes it. */
  const release = (version: string, sums = (sum: string) => `${sum}  install.sh\n`) => {
    const folder = join(served, "releases", `v${version}`);
    mkdirSync(folder, { recursive: true });
    const script = `printf '%s\\n' "$#" "$@" > '${ran}'\nexit 3\n`;
    writeFileSync(join(folder, "install.sh"), script);
    const sum = createHash("sha256").update(script).digest("hex");
    writeFileSync(join(folder, "SHA256SUMS"), sums(sum));
    return { folder, sum };
  };
  /** get.sh run with `args`, or, given `piped`, that text piped into `bash -s --` with `args`. */
  const run = (env: Record<string, string>, args: string[], piped?: string) => {
    for (const record of ["asked", "options", "ran"]) rmSync(join(at, record), { force: true });
    return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      const child = execFile(
        "bash",
        piped === undefined ? [join(root, "get.sh"), ...args] : ["-s", "--", ...args],
        {
          env: { HOME: join(at, "account"), PATH: `${bin}:/usr/bin:/bin`, TMPDIR: temp, ...env },
          timeout: 30_000,
        },
        (error, stdout, stderr) =>
          done({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
      );
      // bash may be gone before its input is written, as when get.sh refuses its arguments at
      // once: the write then fails with EPIPE, which says nothing of the run. The run is judged by
      // its exit code, its output and what it left.
      child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") throw error;
      });
      child.stdin?.end(piped ?? "");
    });
  };
  const lines = (name: string) =>
    existsSync(join(at, name))
      ? readFileSync(join(at, name), "utf8").split("\n").filter(Boolean)
      : [];
  return {
    served,
    tag,
    release,
    run,
    asked: () => lines("asked"),
    options: () => lines("options"),
    ran: () => (existsSync(ran) ? readFileSync(ran, "utf8") : undefined),
    left: () => readdirSync(temp),
  };
}

test("get.sh reads next's version, fetches that release's install.sh and SHA256SUMS, and runs install.sh with the other arguments once its sum is listed", async (t) => {
  const get = getter(t);
  get.tag("latest", "0.0.30");
  get.tag("next", "0.0.31");
  get.release(
    "0.0.31",
    (sum) => `${"0".repeat(64)}  agentorg-core-0.0.31.tgz\n${sum}  install.sh\n`,
  );
  const got = await get.run({}, ["--update", "--no-open"]);
  // install.sh's exit code is get.sh's.
  assert.equal(got.code, 3, got.stderr);
  assert.equal(got.stdout, "Installing AgentOrg 0.0.31, the next channel's release.\n");
  assert.equal(get.ran(), "2\n--update\n--no-open\n");
  assert.equal(CHANNEL, "next");
  assert.deepEqual(get.asked(), [
    tagsAt,
    `${download}/v0.0.31/install.sh`,
    `${download}/v0.0.31/SHA256SUMS`,
  ]);
  // Each fetch is https only, redirects too, and has a time limit.
  for (const options of get.options())
    assert.match(options, /--proto =https --proto-redir =https --max-time \d+ /);
  assert.deepEqual(get.left(), [], "its folder is removed after");
  // With no arguments, under the Mac's own bash, install.sh is given none.
  const bare = await get.run({}, []);
  assert.equal(bare.code, 3, bare.stderr);
  assert.equal(get.ran(), "0\n");
});

test("get.sh reads latest's version with --channel latest or AGENTORG_CHANNEL=latest, and refuses a channel that isn't one", async (t) => {
  const get = getter(t);
  get.tag("latest", "0.0.30");
  get.tag("next", "0.0.31");
  get.release("0.0.31");
  get.release("0.0.30", (sum) => `${sum} *install.sh\n`);
  for (const [env, args] of [
    [{}, ["--channel", "latest", "--no-open"]],
    [{ AGENTORG_CHANNEL: "latest" }, ["--no-open"]],
    [{ AGENTORG_CHANNEL: "next" }, ["--no-open", "--channel", "latest"]],
  ] as const) {
    const got = await get.run(env, [...args]);
    assert.equal(got.code, 3, got.stderr);
    assert.equal(got.stdout, "Installing AgentOrg 0.0.30, the latest channel's release.\n");
    assert.equal(get.ran(), "1\n--no-open\n");
    assert.deepEqual(get.asked(), [
      tagsAt,
      `${download}/v0.0.30/install.sh`,
      `${download}/v0.0.30/SHA256SUMS`,
    ]);
  }
  const wrong = await get.run({}, ["--channel", "beta"]);
  assert.equal(wrong.code, 1);
  assert.equal(wrong.stderr, "AgentOrg's channels are latest and next, not beta.\n");
  assert.deepEqual(get.asked(), []);
});

test("get.sh runs nothing when install.sh's sum differs, SHA256SUMS has no line for it, the version isn't one, or a fetch fails", async (t) => {
  const get = getter(t);
  get.tag("next", "0.0.31");
  const refused = async (says: string) => {
    const got = await get.run({}, ["--no-open"]);
    assert.equal(got.code, 1);
    assert.equal(got.stderr, `${says}\n`);
    assert.equal(got.stdout, "");
    assert.equal(get.ran(), undefined, "install.sh didn't run");
    assert.deepEqual(get.left(), []);
  };
  const { sum } = get.release("0.0.31", () => `${"1".repeat(64)}  install.sh\n`);
  await refused(
    `install.sh of AgentOrg 0.0.31 isn't the one its SHA256SUMS lists (its SHA-256 is ${sum}), so nothing was installed.`,
  );
  get.release("0.0.31", (sum) => `${sum}  agentorg-core-0.0.31.tgz\n${sum}  install.sh.old\n`);
  await refused(
    "The SHA256SUMS of AgentOrg 0.0.31 has no line for install.sh, so nothing was installed.",
  );
  // npm has a version whose release isn't up: none before this change carries install.sh.
  get.tag("next", "0.0.29");
  await refused(
    "AgentOrg 0.0.29 is on npm, but its release isn't up yet: try again in a few minutes.",
  );
  for (const version of ["0.0.31/../x", "../0.0.31", "not a version"]) {
    get.tag("next", version);
    await refused("npm names no version for AgentOrg's next channel, so nothing was installed.");
  }
  rmSync(join(get.served, "dist-tags"));
  await refused(`Couldn't download ${tagsAt}, so nothing was installed.`);
});

test("get.sh cut off anywhere, piped into bash, fetches nothing and runs nothing", async (t) => {
  const get = getter(t);
  get.tag("latest", "0.0.30");
  get.release("0.0.30");
  const args = ["--channel", "latest", "--update"];
  const whole = readFileSync(join(root, "get.sh"), "utf8");
  const ran = await get.run({}, args, whole);
  assert.equal(ran.code, 3, ran.stderr);
  assert.equal(get.ran(), "1\n--update\n");
  // Cut at every line's end, and at every point of the last line.
  const last = whole.lastIndexOf("\n", whole.length - 2) + 1;
  const cuts = [...whole.matchAll(/\n/g)].map((match) => match.index + 1);
  for (let at = last + 1; at < whole.length - 1; at++) cuts.push(at);
  for (const at of cuts.filter((at) => at < whole.length - 1)) {
    const cut = whole.slice(0, at);
    await get.run({}, args, cut);
    assert.deepEqual(get.asked(), [], JSON.stringify(cut.slice(-40)));
    assert.equal(get.ran(), undefined, JSON.stringify(cut.slice(-40)));
  }
});
