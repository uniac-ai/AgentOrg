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

// dist/test/release.test.js → the repository's root, its release script and its install.sh.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const script = join(root, "scripts", "github-release.sh");
const version = "0.0.31";
const core = `agentorg-core-${version}.tgz`;
const frontend = `agentorg-frontend-${version}.tgz`;
const zip = `AgentOrg-${version}-mac-arm64.zip`;

/**
 * The release workflow's last job, scripts/github-release.sh, in a folder of its own: `from` holds
 * the files the run makes, `notes` the release notes, and `gh` is a stand-in that writes its
 * arguments, one a line, to a file, which `gh()` reads back (undefined when it wasn't run).
 */
function releasing(t: test.TestContext) {
  const at = mkdtempSync(join(tmpdir(), "agentorg-release-"));
  t.after(() => rmSync(at, { recursive: true, force: true }));
  const bin = join(at, "bin");
  const from = join(at, "from");
  const notes = join(at, "notes");
  const out = join(at, "release");
  const called = join(at, "called");
  for (const dir of [bin, from, notes]) mkdirSync(dir);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done >"${called}"\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const run = (...args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
      execFile(
        "bash",
        [script, ...args],
        { env: { PATH: `${bin}:/usr/bin:/bin` }, timeout: 30_000 },
        (error, stdout, stderr) =>
          done({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
      ),
    );
  // The job's steps after the downloads, in turn: create runs only once gather has passed. `mac`
  // is the mac-app job's `carried`.
  const release = async (mac = false) => {
    const gathered = await run("gather", version, from, out, ...(mac ? ["--mac"] : []));
    return gathered.code === 0 ? run("create", version, out, notes) : gathered;
  };
  const gh = () =>
    existsSync(called) ? readFileSync(called, "utf8").split("\n").slice(0, -1) : undefined;
  return { from, notes, out, run, release, gh };
}

/** The files the run makes: the core, the frontend, the repository's install.sh and the Mac app. */
const bytes = new Map([
  [core, Buffer.from([0x1f, 0x8b, 0, 0xff, 10, 13, 1])],
  [frontend, Buffer.from("the frontend's bytes")],
  ["install.sh", readFileSync(join(root, "install.sh"))],
  [zip, Buffer.from([0x50, 0x4b, 3, 4, 0xfe])],
]);
function bytesOf(name: string) {
  const got = bytes.get(name);
  assert.ok(got, name);
  return got;
}
function made(from: string, names: string[]) {
  for (const name of names) writeFileSync(join(from, name), bytesOf(name));
}

/** SHA256SUMS as sha256sum writes it, over `names` sorted by name. */
function sums(names: string[]) {
  return [...names]
    .sort()
    .map((name) => `${createHash("sha256").update(bytesOf(name)).digest("hex")}  ${name}\n`)
    .join("");
}

test("a release carries the core, the frontend and install.sh, unchanged, with their SHA256SUMS, and is published not latest with its notes", async (t) => {
  const run = releasing(t);
  const names = [core, frontend, "install.sh"];
  made(run.from, names);
  writeFileSync(join(run.notes, `v${version}.md`), "What changed.\n");
  const done = await run.release();
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(readdirSync(run.out).sort(), [...names, "SHA256SUMS"].sort());
  assert.equal(readFileSync(join(run.out, "SHA256SUMS"), "utf8"), sums(names));
  for (const name of names) assert.deepEqual(readFileSync(join(run.out, name)), bytesOf(name));
  assert.deepEqual(
    readFileSync(join(run.out, "install.sh")),
    readFileSync(join(root, "install.sh")),
  );
  const args = run.gh();
  assert.deepEqual(args, [
    "release",
    "create",
    `v${version}`,
    "--verify-tag",
    "--title",
    version,
    "--latest=false",
    "--notes-file",
    join(run.notes, `v${version}.md`),
    ...[...names].sort().map((name) => join(run.out, name)),
    join(run.out, "SHA256SUMS"),
  ]);
  assert.ok(!args?.some((arg) => arg === "-d" || arg.startsWith("--draft")), "not a draft");
});

test("a release that carries the Mac app has it too, in its SHA256SUMS", async (t) => {
  const run = releasing(t);
  const names = [core, frontend, "install.sh", zip];
  made(run.from, names);
  writeFileSync(join(run.notes, `v${version}.md`), "What changed.\n");
  const done = await run.release(true);
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(readdirSync(run.out).sort(), [...names, "SHA256SUMS"].sort());
  assert.equal(readFileSync(join(run.out, "SHA256SUMS"), "utf8"), sums(names));
  assert.deepEqual(readFileSync(join(run.out, zip)), bytesOf(zip));
  assert.ok(run.gh()?.includes(join(run.out, zip)));
});

test("a release that carries the Mac app, without its zip, gathers nothing and makes no release", async (t) => {
  const run = releasing(t);
  made(run.from, [core, frontend, "install.sh"]);
  writeFileSync(join(run.notes, `v${version}.md`), "What changed.\n");
  const refused = await run.release(true);
  assert.equal(refused.code, 1);
  assert.equal(refused.stderr, `${run.from} has no ${zip}, which this release carries.\n`);
  assert.equal(existsSync(run.out), false);
  assert.equal(run.gh(), undefined, "gh isn't run");
});

test("a release that doesn't carry the Mac app never takes a zip, even one that is there", async (t) => {
  const run = releasing(t);
  const names = [core, frontend, "install.sh"];
  made(run.from, [...names, zip]);
  writeFileSync(join(run.notes, `v${version}.md`), "What changed.\n");
  const done = await run.release();
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(readdirSync(run.out).sort(), [...names, "SHA256SUMS"].sort());
  assert.equal(readFileSync(join(run.out, "SHA256SUMS"), "utf8"), sums(names));
  assert.ok(!run.gh()?.some((arg) => arg.endsWith(zip)));
});

test("without the core, the frontend or install.sh, nothing is gathered and no release is made", async (t) => {
  for (const missing of [core, frontend, "install.sh"]) {
    const run = releasing(t);
    made(
      run.from,
      [core, frontend, "install.sh", zip].filter((name) => name !== missing),
    );
    writeFileSync(join(run.notes, `v${version}.md`), "What changed.\n");
    const refused = await run.release();
    assert.equal(refused.code, 1, missing);
    assert.equal(refused.stderr, `${run.from} has no ${missing}, which this release carries.\n`);
    assert.equal(existsSync(run.out), false);
    assert.equal(run.gh(), undefined, "gh isn't run");
  }
});

test("a release without its notes, release-notes/v<version>.md, or with them empty, is refused, and with them passes", async (t) => {
  const run = releasing(t);
  const file = join(run.notes, `v${version}.md`);
  const refused = await run.run("notes", version, run.notes);
  assert.equal(refused.code, 1);
  assert.equal(
    refused.stderr,
    `The release has no notes: add ${file} in the release's PR, then move the tag: delete it and push it again.\n`,
  );
  writeFileSync(file, "");
  const empty = await run.run("notes", version, run.notes);
  assert.equal(empty.code, 1);
  assert.equal(empty.stderr, refused.stderr);
  // The repository's own folder by default.
  const unwritten = await run.run("notes", "999.0.0");
  assert.equal(unwritten.code, 1);
  assert.equal(
    unwritten.stderr,
    "The release has no notes: add release-notes/v999.0.0.md in the release's PR, then move the tag: delete it and push it again.\n",
  );
  writeFileSync(file, "What changed.\n");
  const passed = await run.run("notes", version, run.notes);
  assert.equal(passed.code, 0, passed.stderr);
  assert.equal(passed.stdout, `The release has its notes: ${file}\n`);
});

test("create takes the names of a SHA256SUMS written in binary mode, `*name`, as the names", async (t) => {
  const run = releasing(t);
  const names = [core, frontend, "install.sh"];
  made(run.from, names);
  writeFileSync(join(run.notes, `v${version}.md`), "What changed.\n");
  const gathered = await run.run("gather", version, run.from, run.out);
  assert.equal(gathered.code, 0, gathered.stderr);
  writeFileSync(join(run.out, "SHA256SUMS"), sums(names).replaceAll("  ", " *"));
  const done = await run.run("create", version, run.out, run.notes);
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(run.gh()?.slice(-4), [
    ...[...names].sort().map((name) => join(run.out, name)),
    join(run.out, "SHA256SUMS"),
  ]);
});
