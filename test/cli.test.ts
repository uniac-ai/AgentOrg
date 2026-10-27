import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requestOf } from "../src/cli/operations.ts";
import { OPERATIONS } from "../src/contract/index.ts";
import { ensureToken, readToken } from "../src/home.ts";
import { live, TOKEN } from "./live.ts";

const BIN = new URL("../src/cli/bin.js", import.meta.url).pathname;

/** Run the real command line, without blocking the test's own server. */
function agentorg(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const parsed = (text: string) => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  // biome-ignore lint/suspicious/noExplicitAny: the tests read command output loosely.
  const done = new Promise<{ code: number; stdout: string; stderr: string; json: any }>((resolve) =>
    child.on("close", (code) =>
      resolve({ code: code ?? -1, stdout, stderr, json: parsed(stdout) }),
    ),
  );
  return Object.assign(done, { child });
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** A live server, and the environment that points the command line at it. */
async function withService(
  work: (env: Record<string, string>, server: Awaited<ReturnType<typeof live>>) => Promise<void>,
) {
  const server = await live();
  try {
    await work({ AGENTORG_URL: server.url, AGENTORG_TOKEN: TOKEN }, server);
  } finally {
    await server.close();
  }
}

/** A session the user started creates a manager at attach and a child, and one attaches to the child. */
async function organization(env: Record<string, string>) {
  const managing = await agentorg(
    [
      "session",
      "attach",
      '--new-agent={"title": "Run the release", "purpose": "Ship 1.0."}',
      "--client=script",
      "--client-session-id=m-1",
    ],
    env,
  );
  assert.equal(managing.code, 0, managing.stderr);
  const child = await agentorg(
    [
      "agent",
      "create",
      `--session=${managing.json.session.id}`,
      "--title=Migrate",
      "--purpose=Move to SQLite.",
    ],
    env,
  );
  const working = await agentorg(
    ["session", "attach", `--agent=${child.json.id}`, "--client=script", "--client-session-id=c-1"],
    env,
  );
  const ask = await agentorg(
    [
      "ask",
      "open",
      `--session=${working.json.session.id}`,
      "--title=Which database?",
      "--context=The service needs one store.",
      '--options={"label": "SQLite"}',
      '--options={"label": "Postgres"}',
      "--recommendation=SQLite",
    ],
    env,
  );
  assert.equal(ask.code, 0, ask.stderr);
  return {
    managing: managing.json.session.id as string,
    working: working.json.session.id as string,
    ask: ask.json,
  };
}

test("every agent and API operation is a command, and the user's are not", async () => {
  for (const [name, spec] of Object.entries(OPERATIONS)) {
    const [subject, ...verb] = name.split("_");
    const result = await agentorg([subject as string, verb.join("-"), "--help"]);
    assert.equal(result.code, spec.kind === "user" ? 2 : 0, name);
  }
});

test("flags and --json become the validated request", () => {
  assert.deepEqual(
    requestOf("ask_open", [
      "--session=ses_1",
      "--title=Which?",
      '--options={"label": "A"}',
      '--options={"label": "B"}',
      "--json",
      '{"context": "Both fit.", "recommendation": "B"}',
      "--recommendation=A",
    ]),
    {
      session: "ses_1",
      title: "Which?",
      context: "Both fit.",
      options: [{ label: "A" }, { label: "B" }],
      recommendation: "A",
      escalates: [],
    },
  );
  assert.deepEqual(requestOf("ask_wait", ["ask_1", "--timeout-seconds=5"]), {
    ask: "ask_1",
    timeout_seconds: 5,
  });
  assert.deepEqual(requestOf("agent_list", ["--include-closed"]), { include_closed: true });
  assert.deepEqual(
    requestOf("status_set", [
      "--session=s",
      "--state=blocked",
      "--blockers=CI",
      "--blockers=the user",
    ]),
    { session: "s", state: "blocked", summary: "", links: [], blockers: ["CI", "the user"] },
  );
  assert.deepEqual(requestOf("session_attach", ['--new-agent={"title": "T", "purpose": "P"}']), {
    new_agent: { title: "T", purpose: "P" },
  });
  assert.throws(() => requestOf("ask_open", ["--session=s"]), /title/);
});

test("a background ask wait exits 0 with the answer", async () => {
  await withService(async (env) => {
    const { managing, ask } = await organization(env);
    const waiting = agentorg(["ask", "wait", ask.id], env);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(waiting.child.exitCode, null);
    const answered = await agentorg(
      ["ask", "answer", `--session=${managing}`, ask.id, "--choice=Postgres"],
      env,
    );
    assert.equal(answered.code, 0, answered.stderr);
    const result = await waiting;
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      [result.json.answer.choice, result.json.answer.channel],
      ["Postgres", "agent"],
    );
  });
});

test("ask wait exits 2 when the ask is withdrawn and 1 when its timeout passes", async () => {
  await withService(async (env) => {
    const { working, ask } = await organization(env);
    const timed = await agentorg(["ask", "wait", ask.id, "--timeout-seconds=0.2"], env);
    assert.deepEqual([timed.code, timed.json.state], [1, "open"]);
    assert.match(timed.stderr, /still open/);
    await agentorg(["ask", "withdraw", `--session=${working}`, ask.id], env);
    const withdrawn = await agentorg(["ask", "wait", ask.id], env);
    assert.deepEqual([withdrawn.code, withdrawn.json.state], [2, "withdrawn"]);
  });
});

test("session context prints known facts and nothing otherwise", async () => {
  await withService(async (env) => {
    const { working } = await organization(env);
    const known = await agentorg(
      ["session", "context", "--client=script", "--client-session-id=c-1"],
      env,
    );
    assert.deepEqual([known.code, known.json.session.id], [0, working]);
    const unknown = await agentorg(
      ["session", "context", "--client=script", "--client-session-id=nobody"],
      env,
    );
    assert.deepEqual([unknown.code, unknown.stdout], [0, ""]);
  });
  const down = { AGENTORG_URL: `http://127.0.0.1:${await freePort()}`, AGENTORG_TOKEN: TOKEN };
  const stopped = await agentorg(
    ["session", "context", "--client=script", "--client-session-id=c-1"],
    down,
  );
  assert.deepEqual([stopped.code, stopped.stdout], [0, ""]);
  const home = mkdtempSync(join(tmpdir(), "agentorg-never-"));
  const neverStarted = await agentorg(
    ["session", "context", "--client=script", "--client-session-id=c-1"],
    {
      AGENTORG_HOME: home,
      AGENTORG_TOKEN: "",
    },
  );
  assert.deepEqual([neverStarted.code, neverStarted.stdout], [0, ""]);
  rmSync(home, { recursive: true });
});

test("refusals and a stopped service exit 1 with the reason on stderr", async () => {
  await withService(async (env) => {
    const missing = await agentorg(["ask", "get", "ask_404"], env);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /not_found/);
    const invalid = await agentorg(["ask", "open", "--session=ses_1"], env);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /invalid: .*title/);
  });
  const down = await agentorg(["agent", "list"], {
    AGENTORG_URL: `http://127.0.0.1:${await freePort()}`,
    AGENTORG_TOKEN: TOKEN,
  });
  assert.equal(down.code, 1);
  assert.match(down.stderr, /agentorg service not running at .*; start it with `agentorg serve`/);
});

/** A BROWSER that leaves a file behind when anything asks it to open a link. */
function recordingBrowser() {
  const directory = mkdtempSync(join(tmpdir(), "agentorg-browser-"));
  const opened = join(directory, "opened");
  const browser = join(directory, "browser");
  writeFileSync(browser, `#!/bin/sh\necho "$1" > "${opened}"\n`, { mode: 0o755 });
  return {
    browser,
    opened: () => existsSync(opened),
    remove: () => rmSync(directory, { recursive: true }),
  };
}

test("ui prints a one-time sign-in link, and opens nothing when not run in a terminal", async () => {
  const browser = recordingBrowser();
  try {
    await withService(async (env, server) => {
      const result = await agentorg(["ui"], { ...env, BROWSER: browser.browser });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout.trim(), new RegExp(`^${server.url}/ui/login\\?token=`));
      assert.equal(browser.opened(), false);
    });
  } finally {
    browser.remove();
  }
});

test("help comes before anything a command does", async () => {
  const browser = recordingBrowser();
  const home = join(mkdtempSync(join(tmpdir(), "agentorg-help-")), "home");
  try {
    await withService(async (env, server) => {
      for (const args of [
        ["ui", "--help"],
        ["ui", "-h"],
        ["serve", "--help"],
        ["mcp", "-h"],
        ["ask", "wait", "-h"],
      ]) {
        const result = await agentorg(args, {
          ...env,
          AGENTORG_HOME: home,
          BROWSER: browser.browser,
        });
        assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
        assert.match(result.stdout, /^usage: agentorg /, args.join(" "));
      }
      const minted = (await server.service.audit_list({ limit: 100 }, { channel: "api" })).entries;
      assert.equal(minted.filter((entry) => entry.operation === "ui_login_link").length, 0);
      assert.equal(browser.opened(), false);
      assert.equal(existsSync(home), false, "serve --help created no home");
    });
  } finally {
    browser.remove();
    rmSync(join(home, ".."), { recursive: true, force: true });
  }
});

test("the token file is private", () => {
  const home = mkdtempSync(join(tmpdir(), "agentorg-token-"));
  const saved = { home: process.env.AGENTORG_HOME, token: process.env.AGENTORG_TOKEN };
  process.env.AGENTORG_HOME = home;
  delete process.env.AGENTORG_TOKEN;
  try {
    assert.equal(readToken(), undefined);
    const token = ensureToken();
    assert.equal(statSync(join(home, "token")).mode & 0o777, 0o600);
    assert.deepEqual([ensureToken(), readToken()], [token, token]);
    process.env.AGENTORG_TOKEN = "from-env";
    assert.equal(readToken(), "from-env");
    chmodSync(join(home, "token"), 0o644);
    assert.throws(() => ensureToken(), /readable by other users/);
  } finally {
    process.env.AGENTORG_HOME = saved.home;
    if (saved.token === undefined) delete process.env.AGENTORG_TOKEN;
    else process.env.AGENTORG_TOKEN = saved.token;
    rmSync(home, { recursive: true });
  }
});

test("serve creates its home and serves on loopback until stopped", async () => {
  const home = join(mkdtempSync(join(tmpdir(), "agentorg-serve-")), "home");
  const port = await freePort();
  const running = agentorg(["serve", `--port=${port}`], { AGENTORG_HOME: home });
  try {
    let document: { info: { title: string } } | undefined;
    for (let tries = 0; !document && tries < 100; tries++) {
      document = await fetch(`http://127.0.0.1:${port}/openapi.json`)
        .then((response) => response.json() as Promise<{ info: { title: string } }>)
        .catch(() => new Promise((resolve) => setTimeout(() => resolve(undefined), 100)));
    }
    assert.equal(document?.info.title, "agentorg");
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, "token")).mode & 0o777, 0o600);
    assert.ok(statSync(join(home, "agentorg.db")).isFile());
    const token = (await import("node:fs")).readFileSync(join(home, "token"), "utf8").trim();
    const listed = await fetch(`http://127.0.0.1:${port}/api/agent/list`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.deepEqual(await listed.json(), { agents: [] });
  } finally {
    running.child.kill("SIGTERM");
    const stopped = await running;
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.doesNotMatch(stopped.stderr, /ExperimentalWarning/);
    rmSync(join(home, ".."), { recursive: true });
  }
});
