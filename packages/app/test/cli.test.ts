import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

// dist/test/cli.test.js → the app's built command.
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

// Never the person's own home: a command that wrongly starts the app does it in a throwaway
// one, and is killed rather than left running.
const scratchHome = mkdtempSync(join(tmpdir(), "agentorg-cli-home-"));
after(() => rmSync(scratchHome, { recursive: true, force: true }));
const runIn = (env: Record<string, string>, ...args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
    execFile(
      process.execPath,
      [cli, ...args],
      {
        env: { ...process.env, AGENTORG_HUB_HOME: scratchHome, XDG_DATA_HOME: scratchHome, ...env },
        timeout: 30_000,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) =>
        done({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    ),
  );
const run = (...args: string[]) => runIn({}, ...args);

/**
 * An account folder of its own, with stand-ins first on the PATH for `launchctl` and for what opens
 * a browser: a command that wrongly gets past its checks touches nothing of this machine's.
 */
function account(t: test.TestContext) {
  const folder = mkdtempSync(join(tmpdir(), "agentorg-account-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const bin = join(folder, "bin");
  mkdirSync(bin);
  for (const name of ["launchctl", "open", "xdg-open"])
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return { HOME: folder, PATH: `${bin}:${process.env.PATH}` };
}

test("agentorg runs the app; while it runs, the person's commands go through it", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "agentorg-cli-"));
  let app: ChildProcess | undefined;
  t.after(() => {
    // Only the process this test started.
    if (app?.exitCode === null) app.kill("SIGTERM");
    rmSync(home, { recursive: true, force: true });
  });
  // Any free port: the default one is the person's. An account folder of its own, so no AgentOrg
  // Mac of this machine's is looked at for the first Assistant.
  app = spawn(process.execPath, [cli, "--no-open", "--port", "0", "--home", home], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: join(home, "account") },
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
  const want = ["AgentOrg", "ChatGPT", "Computers", "Local", "Management", "hub", "person"];
  let listed = await names();
  for (const end = Date.now() + 30_000; listed.join() !== want.join() && Date.now() < end; )
    listed = await names();
  assert.deepEqual(listed, want);
  // The person's notes are the gateway's own.
  const notes = await run("call", "store", "get", '{"key":"none"}', "--home", home);
  assert.equal(notes.code, 0, notes.stderr);
  assert.deepEqual(JSON.parse(notes.stdout), {});
  const refused = await run("call", "actors", "get", '{"actorId":"nobody"}', "--home", home);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /^Refused \(unknown\)/);
  // Run again on its home, it opens the running app rather than start a second one.
  const again = await run("--no-open", "--home", home);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /^AgentOrg is already running at http:\/\/127\.0\.0\.1:\d+, home /);
  // A bad option is still refused first, and one it can't give is said.
  assert.equal((await run("--port", "abc", "--home", home)).code, 2);
  const elsewhere = await run("--no-open", "--port", "5", "--home", home);
  assert.equal(elsewhere.code, 1);
  assert.match(elsewhere.stderr, /^Stop it first to run it with --port or --frontend\.\n$/);
  // Its status names it and its version. An account folder of its own, so no service of this
  // account's is read.
  const scratch = account(t);
  const own = JSON.parse(readFileSync(join(dirname(cli), "..", "..", "package.json"), "utf8"));
  const shown = await runIn(scratch, "status", "--home", home);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(
    shown.stdout,
    new RegExp(
      `^AgentOrg ${own.version.replaceAll(".", "\\.")} is running at http://127\\.0\\.0\\.1:\\d+, on `,
    ),
  );
  // A sign-in the app won't give is said, not thrown.
  writeFileSync(join(home, "cli-token"), "not-the-token\n");
  const unsigned = await runIn(scratch, "open", "--home", home);
  assert.equal(unsigned.code, 1);
  assert.match(
    unsigned.stderr,
    /^AgentOrg at http:\/\/127\.0\.0\.1:\d+ refused to sign a browser in \(\d{3}\)\.\n$/,
  );
  // Stopped, the app takes its files with it.
  const exited = new Promise((done) => app?.once("exit", done));
  app.kill("SIGTERM");
  await exited;
  assert.throws(() => readFileSync(join(home, "app.json")));
});

test("status says when the app isn't running; the service commands take no arguments", async (t) => {
  const own = account(t);
  const shown = await runIn(own, "status");
  assert.equal(shown.code, 3);
  assert.equal(
    shown.stdout,
    process.platform === "darwin"
      ? `AgentOrg isn't running on ${scratchHome}.\nIt isn't set up as a service. agentorg start sets it up.\n`
      : `AgentOrg isn't running on ${scratchHome}.\n`,
  );
  for (const name of ["start", "stop", "status", "update", "uninstall"]) {
    const extra = await runIn(own, name, "now");
    assert.equal(extra.code, 2, name);
    assert.match(extra.stderr, new RegExp(`^agentorg ${name} takes no arguments\\.\\nUsage:`));
  }
});

test("an unknown command gets the app's usage", async () => {
  const unknown = await run("nope");
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /^Unknown command "nope"\.\nUsage: agentorg \[command\]/);
  assert.match(unknown.stderr, /open +sign a browser in/);
});

test("an unknown option gets the usage and starts nothing; --version prints the version", async (t) => {
  const scratch = account(t);
  // Each is refused before anything runs: none of them may start the app on the default home.
  for (const args of [
    ["--nope"],
    ["--version", "--nope"],
    ["actors", "--bogus"],
    ["--home"],
    ["--home", "--no-open"],
    ["call", "s", "m", "-1"],
    ["start", "--port", "5"],
    ["stop", "--frontend", "/x"],
    ["uninstall", "--port", "5"],
    ["stop", "--delete-home"],
    ["--delete-home"],
  ]) {
    const result = await runIn(scratch, ...args);
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
    assert.equal(
      result.stderr,
      `AgentOrg isn't running in ${join(data, "agentorg")}. Run ${process.platform === "darwin" ? "agentorg start" : "agentorg"} first.\n`,
    );
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
