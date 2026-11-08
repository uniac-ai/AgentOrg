import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

// dist/test/cli.test.js → the app's built command.
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

// Never the person's own home: a command that wrongly starts the app does it in a throwaway
// one, and is killed rather than left running.
const scratchHome = mkdtempSync(join(tmpdir(), "agentorg-cli-home-"));
after(() => rmSync(scratchHome, { recursive: true, force: true }));
const run = (...args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
    execFile(
      process.execPath,
      [cli, ...args],
      {
        env: { ...process.env, AGENTORG_HUB_HOME: scratchHome, XDG_DATA_HOME: scratchHome },
        timeout: 30_000,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) =>
        done({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    ),
  );

test("agentorg runs the app; while it runs, the person's commands go through it", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "agentorg-cli-"));
  let app: ChildProcess | undefined;
  t.after(() => {
    // Only the process this test started.
    if (app?.exitCode === null) app.kill("SIGTERM");
    rmSync(home, { recursive: true, force: true });
  });
  app = spawn(process.execPath, [cli, "--no-open", "--home", home], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const started = await new Promise<string>((done, failed) => {
    let out = "";
    app?.stdout?.on("data", (chunk) => {
      out += String(chunk);
      if (out.includes("\n")) done(out);
    });
    app?.once("exit", (code) => failed(new Error(`agentorg exited ${code}`)));
  });
  // The address, never a sign-in code.
  assert.match(started, /^AgentOrg at http:\/\/127\.0\.0\.1:\d+, home /);
  assert.doesNotMatch(started, /signin#/);
  // The person's channel is the app's: a command through it works where its own channel couldn't.
  // The built-ins, and the two the first run makes beside serving, once it has.
  const names = async () => {
    const actors = await run("actors", "--home", home);
    assert.equal(actors.code, 0, actors.stderr);
    const listed = JSON.parse(actors.stdout) as { actors: { name: string }[] };
    return listed.actors.map((a) => a.name).sort();
  };
  const want = ["ChatGPT", "Installer", "hub", "net", "person", "storage"];
  let listed = await names();
  for (const end = Date.now() + 30_000; listed.join() !== want.join() && Date.now() < end; )
    listed = await names();
  assert.deepEqual(listed, want);
  // layout@1 is the gateway's own, kept in the person's store.
  const layout = await run("call", "layout", "get", "--home", home);
  assert.equal(layout.code, 0, layout.stderr);
  assert.deepEqual(JSON.parse(layout.stdout), { home: [] });
  const refused = await run("call", "actors", "get", '{"actorId":"nobody"}', "--home", home);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /^Refused \(unknown\)/);
  // Stopped, the app takes its files with it.
  const exited = new Promise((done) => app?.once("exit", done));
  app.kill("SIGTERM");
  await exited;
  assert.throws(() => readFileSync(join(home, "app.json")));
});

test("agentorg build is the SDK's build", async (t) => {
  const out = mkdtempSync(join(tmpdir(), "agentorg-cli-build-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const built = await run("build", join(root, "examples", "board"));
  assert.equal(built.code, 0, built.stderr);
  assert.match(built.stdout, /^board@0\.1\.0 sha256-[0-9a-f]{64}\n/);
  rmSync(join(root, "examples", "board", "agentorg-build"), { recursive: true, force: true });
});

test("an unknown command gets the app's usage", async () => {
  const unknown = await run("nope");
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /^Unknown command "nope"\.\nUsage: agentorg \[command\]/);
  assert.match(unknown.stderr, /open +sign a browser in/);
});

test("an unknown option gets the usage and starts nothing; --version prints the version", async () => {
  // Each is refused before anything runs: none of them may start the app on the default home.
  for (const args of [
    ["--nope"],
    ["--version", "--nope"],
    ["actors", "--bogus"],
    ["--home"],
    ["--home", "--no-open"],
    ["call", "s", "m", "-1"],
  ]) {
    const result = await run(...args);
    assert.equal(result.code, 2, args.join(" "));
    assert.match(result.stderr, /Usage: agentorg \[command\]/, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
  }
  const version = await run("--version");
  assert.equal(version.code, 0);
  const own = JSON.parse(readFileSync(join(dirname(cli), "..", "..", "package.json"), "utf8"));
  assert.equal(version.stdout, `${own.version}\n`);
});

test("without --home or AGENTORG_HUB_HOME, the home is agentorg in the XDG data folder", async () => {
  const data = mkdtempSync(join(tmpdir(), "agentorg-xdg-"));
  try {
    const env: Record<string, string | undefined> = { ...process.env, XDG_DATA_HOME: data };
    delete env.AGENTORG_HUB_HOME;
    const result = await new Promise<{ code: number; stderr: string }>((done) =>
      execFile(process.execPath, [cli, "open"], { env }, (error, _out, stderr) =>
        done({ code: error ? Number(error.code ?? 1) : 0, stderr }),
      ),
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(`isn't running in ${join(data, "agentorg")}\\.`));
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
