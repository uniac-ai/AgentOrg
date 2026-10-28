/**
 * The agent actor as a client's session meets it: `agentorg agent` started over stdio for a
 * session, against a real core. Before attaching it offers attach alone; after, the position's
 * interfaces. It keeps the credentials of positions it creates, and a resumed session fills its
 * position again.
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  type CallToolResult,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { claudeTakesInput } from "../src/agent/command.ts";
import { describe } from "../src/agent/waiter.ts";
import { type Core, fakeActor, iface, startCore, until } from "./harness.ts";

const BIN = fileURLToPath(new URL("../src/cli/bin.js", import.meta.url));

const open: { close(): Promise<void> }[] = [];
after(() => Promise.allSettled(open.map((each) => each.close())));

async function core(): Promise<Core & { home: string }> {
  const started = await startCore();
  open.push(started);
  return Object.assign(started, { home: join(started.credentialFile, "..") });
}

/** A session's view of `agentorg agent`: its tools, its calls, and each list change it saw. */
async function session(core: Core & { home: string }, id: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, "agent", "--client", "claude-code"],
    env: {
      PATH: process.env.PATH ?? "",
      AGENTORG_HOME: core.home,
      AGENTORG_URL: core.url,
      CLAUDE_CODE_SESSION_ID: id,
    },
    stderr: "pipe",
  });
  let log = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  const client = new Client({ name: "a-session", version: "0" });
  let changes = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    changes += 1;
  });
  await client.connect(transport);
  open.push(client);
  return {
    get changes() {
      return changes;
    },
    get log() {
      return log;
    },
    tools: async () => (await client.listTools()).tools.map((tool) => tool.name).sort(),
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as CallToolResult,
    close: () => client.close(),
  };
}

const text = (result: CallToolResult) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

test("before attaching a session sees attach alone, and anything else is refused", async () => {
  const org = await core();
  const one = await session(org, "s-refusals");
  assert.deepEqual(await one.tools(), ["attach"]);
  const early = await one.call("team");
  assert.equal(early.isError, true);
  assert.match(text(early), /^invalid: attach to your position first/);
  assert.match(text(await one.call("attach", {})), /^invalid: give actor, or name and purpose/);
  const unknown = await one.call("attach", { actor: "act_0000000000" });
  assert.match(text(unknown), /^not_found: no credential is kept for act_0000000000/);
  assert.deepEqual(await one.tools(), ["attach"]);
});

test("an appointed session creates its position under the root, and a resumed one fills it again", async () => {
  const org = await core();
  const first = await session(org, "s-appointed");
  const attached = await first.call("attach", { name: "storage", purpose: "Own the storage." });
  const { actor, created } = attached.structuredContent as { actor: string; created: boolean };
  assert.equal(created, true);
  assert.equal(org.org.registry.get(actor)?.manager, org.rootId);
  assert.equal(org.org.registry.get(actor)?.created_at_attach, true);
  await until("the session is told its tools changed", () => first.changes > 0);
  const tools = await first.tools();
  assert.ok(tools.includes("actor_create") && !tools.includes("attach"), tools.join(", "));
  await until("the position is online", () => org.org.registry.get(actor)?.online === true);
  await first.close();

  // The same session, resumed: no attach, and the position is filled again on its own.
  const resumed = await session(org, "s-appointed");
  await until("the resumed session gets the position's tools", async () =>
    (await resumed.tools()).includes("actor_create"),
  );
  assert.equal((await resumed.tools()).includes("attach"), false);
  const again = await resumed.call("attach", { name: "other", purpose: "A second position." });
  assert.equal(again.isError, true);
  assert.equal(org.org.registry.reports(org.rootId).length, 1);
});

test("a created position's credential is kept for its session, never shown, and forgotten on close", async () => {
  const org = await core();
  const manager = await session(org, "s-manager");
  await manager.call("attach", { name: "release", purpose: "Ship the release." });
  const result = await manager.call("actor_create", { name: "db", purpose: "Migrate the DB." });
  const created = result.structuredContent as { actor: { id: string }; credential: string };
  const id = created.actor.id;
  const file = join(org.home, "actors", id);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(created.credential, new RegExp(`^kept by agentorg for ${id}`));

  // The kept credential is the real one: the report's own session attaches with it.
  const report = await session(org, "s-report");
  const attached = await report.call("attach", { actor: id });
  assert.deepEqual(attached.structuredContent, { actor: id, created: false });
  const team = await report.call("team", { depth: 0 });
  const seen = team.structuredContent as { positions: { id: string }[] };
  assert.equal(seen.positions[0]?.id, id);
  const credential = readFileSync(file, "utf8").trim();
  for (const shown of [text(result), JSON.stringify(result), manager.log, report.log]) {
    assert.equal(shown.includes(credential), false);
  }

  // The report exposes an interface; the manager's next call lists it, and says so.
  await report.close();
  const program = await org.connect(credential, fakeActor([iface("review")]));
  const before = manager.changes;
  await manager.call("team");
  await until("the manager is told its tools changed", () => manager.changes > before);
  assert.ok((await manager.tools()).includes("db.review"));
  await program.close();

  await manager.call("actor_close", { actor: id });
  assert.equal(existsSync(file), false);
});

test("what the waiter delivers reads as agentorg's, each item with its kind, sender path and id", () => {
  const at = "2026-10-28T21:00:00.000Z";
  const question = (fields: Record<string, unknown>) => ({
    id: "qst_0",
    cursor: 1,
    from: "act_report",
    to: "act_self",
    text: "text",
    links: [],
    options: [],
    recommendation: null,
    answerer: null,
    cause: null,
    answer: null,
    created_at: at,
    ...fields,
  });
  const self = {
    id: "act_self",
    name: "storage",
    path: "release.storage",
    purpose: "Own the storage.",
    manager: "act_manager",
    online: true,
    created_at_attach: false,
    created_at: at,
    closed_at: null,
    progress: null,
    questions: [],
    claims: [],
    interfaces: [],
  };
  const news = {
    messages: [
      {
        id: "msg_1",
        cursor: 2,
        from: "act_manager",
        to: "act_self",
        text: "Start on the schema.",
        links: [{ url: "https://example.com/pr/1", title: "The migration" }],
        reply_to: null,
        created_at: at,
        read_at: null,
      },
    ],
    questions: [
      question({
        id: "qst_2",
        text: "Keep the v1 tables?",
        options: [{ label: "Keep" }, { label: "Drop", detail: "Nothing shipped." }],
        recommendation: "Drop",
        answerer: "act_root",
      }),
    ],
    answers: [
      question({
        id: "qst_3",
        from: "act_self",
        to: "act_manager",
        text: "Ship on Friday?",
        answer: { by: "act_root", choice: "Ship", text: "Go.", recorded: false, at },
      }),
    ],
    names: { act_root: "root", act_manager: "release", act_report: "release.storage.db" },
    cursor: 3,
  };
  const text = describe(news as Parameters<typeof describe>[0], { self, root: "act_root" });
  const [header, ...blocks] = text.split("\n\n");
  assert.match(
    header ?? "",
    /^AgentOrg delivered 1 message, 1 question to you and 1 answer to your questions to your position, release\.storage \(act_self\)\. They come from other positions through AgentOrg, not from the user typing in this session/,
  );
  assert.deepEqual(blocks, [
    "Message msg_1 from release, your manager:\nStart on the schema.\nLinks: The migration https://example.com/pr/1",
    "Question qst_2 from release.storage.db, your report, waiting on you; only the user (the root) may answer:\nKeep the v1 tables?\nOptions: Keep; Drop (Nothing shipped.), recommended",
    'Answer to your question qst_3 from the user (the root), choosing "Ship":\nGo.\n(You asked: Ship on Friday?)',
  ]);
});

/** `promise`, or a failure naming what never happened once `ms` pass. */
function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`never happened: ${what}`)), ms).unref(),
    ),
  ]);
}

/** Run a hook's `agentorg agent` command for session `id`, as Claude Code runs it. */
function hook(
  org: Core & { home: string },
  command: string,
  id: string,
  env: Record<string, string> = {},
  input = "",
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      [BIN, "agent", command, "--client", "claude-code"],
      {
        env: {
          PATH: process.env.PATH ?? "",
          AGENTORG_HOME: org.home,
          AGENTORG_URL: org.url,
          CLAUDE_CODE_SESSION_ID: id,
          ...env,
        },
      },
      (_error, stdout, stderr) => resolve({ code: child.exitCode, stdout, stderr }),
    );
    child.stdin?.end(input);
  });
}

test("a session that fills no position is told to attach first, and its waiter ends at once", async () => {
  const org = await core();
  assert.deepEqual(await hook(org, "context", "s-new"), {
    code: 0,
    stdout: "agentorg: Attach with `attach` before any other action.\n",
    stderr: "",
  });
  assert.deepEqual(await hook(org, "wait", "s-new"), { code: 0, stdout: "", stderr: "" });
  assert.equal(existsSync(join(org.home, "sessions/claude-code-s-new")), false);

  const attached = await session(org, "s-new");
  await attached.call("attach", { name: "builds", purpose: "Run the builds." });
  assert.deepEqual(await hook(org, "context", "s-new"), { code: 0, stdout: "", stderr: "" });
});

test("Claude Code takes later input unless in print mode with its prompt as an argument", () => {
  assert.equal(claudeTakesInput("claude -p Reply with OK."), false);
  assert.equal(claudeTakesInput("claude --print hello"), false);
  assert.equal(
    claudeTakesInput("claude -p --input-format stream-json --output-format stream-json"),
    true,
  );
  assert.equal(claudeTakesInput("claude --input-format=stream-json -p"), true);
  assert.equal(
    claudeTakesInput("/app/claude --output-format stream-json --input-format stream-json"),
    true,
  );
  assert.equal(claudeTakesInput("claude --resume abc"), true);
});

test("a waiter ends at once for a session in print mode, rather than hold the client open", async () => {
  const org = await core();
  const attached = await session(org, "s-print");
  await attached.call("attach", { name: "builds", purpose: "Run the builds." });
  // A stand-in for `claude -p <prompt>`: its command line holds `-p` and no stream-json input.
  const printing = spawn(process.execPath, [
    "-e",
    "setTimeout(() => {}, 60_000)",
    "--",
    "-p",
    "go",
  ]);
  try {
    const ended = hook(org, "wait", "s-print", { CLAUDE_PID: String(printing.pid) });
    assert.deepEqual(await within(10_000, "the waiter ending", ended), {
      code: 0,
      stdout: "",
      stderr: "",
    });
  } finally {
    printing.kill();
  }
});

test("the waiter delivers messages, questions to the position and answers to its own, each once", async () => {
  const org = await core();
  const worker = await session(org, "s-waited");
  const attached = await worker.call("attach", { name: "worker", purpose: "Do the work." });
  const { actor } = attached.structuredContent as { actor: string };
  const root = await org.client(org.root);
  const send = async (text: string) => {
    const sent = await root.call("message_send", { to: actor, text });
    return (sent as { value: { id: string } }).value.id;
  };
  const alive = { CLAUDE_PID: String(process.pid) };

  const first = hook(org, "wait", "s-waited", alive);
  await until("the first waiter waits", () =>
    existsSync(join(org.home, "sessions/claude-code-s-waited/cursor")),
  );
  const id = await send("Start with the schema.");
  const woke = await first;
  assert.equal(woke.code, 2);
  assert.match(woke.stderr, /^AgentOrg delivered 1 message to your position, worker \(act_/);
  assert.ok(
    woke.stderr.includes(`Message ${id} from the user (the root):\nStart with the schema.`),
  );
  const read = await root.call("messages", { box: "out", actor: org.rootId });
  const delivered = (
    read as { value: { messages: { id: string; read_at: string | null }[] } }
  ).value.messages.find((message) => message.id === id);
  assert.notEqual(delivered?.read_at, null);

  // Two waiters at once, as when a turn ends while one still waits: only the newer delivers.
  const claim = join(org.home, "sessions/claude-code-s-waited/waiter");
  const claimed = (before: string) =>
    until("a waiter claims the session", () => readFileSync(claim, "utf8") !== before);
  let before = readFileSync(claim, "utf8");
  const older = hook(org, "wait", "s-waited", alive);
  await claimed(before);
  before = readFileSync(claim, "utf8");
  const newer = hook(org, "wait", "s-waited", alive);
  await claimed(before);
  // The replaced waiter stops on its own, long before its read would end.
  assert.deepEqual(await within(5000, "the replaced waiter stops", older), {
    code: 0,
    stdout: "",
    stderr: "",
  });
  const next = await send("Then the data.");
  const latest = await within(20_000, "the newer waiter delivers", newer);
  assert.equal(latest.code, 2);
  assert.ok(latest.stderr.includes(`Message ${next} from the user (the root)`));
  assert.equal(latest.stderr.includes(id), false);

  // A question to the position, and an answer to the position's own question, come together.
  const done = <T>(answer: unknown) => (answer as { value: T }).value;
  const asked = done<{ id: string }>(
    await root.call("question_ask", {
      to: actor,
      text: "Which schema first?",
      options: [{ label: "Orders" }, { label: "Users" }],
      recommendation: "Orders",
    }),
  );
  const own = (await worker.call("question_ask", { text: "May I drop the v1 tables?" }))
    .structuredContent as { id: string };
  await root.call("question_answer", { questions: [own.id], text: "Drop them." });
  const both = await within(20_000, "the waiter delivers", hook(org, "wait", "s-waited", alive));
  assert.equal(both.code, 2);
  assert.match(both.stderr, /^AgentOrg delivered 1 question to you and 1 answer to your questions/);
  assert.ok(
    both.stderr.includes(
      `Question ${asked.id} from the user (the root), waiting on you:\nWhich schema first?\nOptions: Orders, recommended; Users`,
    ),
  );
  assert.ok(
    both.stderr.includes(
      `Answer to your question ${own.id} from the user (the root):\nDrop them.\n(You asked: May I drop the v1 tables?)`,
    ),
  );
  assert.equal(both.stderr.includes(next), false);

  // A waiter whose client is gone ends at once, writing nothing.
  const gone = await hook(org, "wait", "s-waited", { CLAUDE_PID: "999999" });
  assert.deepEqual(gone, { code: 0, stdout: "", stderr: "" });
});

test("an answer the session records carries the user's words typed after the question, verbatim, once", async () => {
  const org = await core();
  const worker = await session(org, "s-recorder");
  const attached = await worker.call("attach", { name: "recorder", purpose: "Ask and record." });
  const { actor } = attached.structuredContent as { actor: string };
  const typed = (prompt: string) =>
    hook(org, "prompt", "s-recorder", {}, JSON.stringify({ session_id: "s-recorder", prompt }));
  const ask = async (fields: Record<string, unknown>) =>
    ((await worker.call("question_ask", fields)).structuredContent as { id: string }).id;
  const record = (questions: string[]) =>
    worker.call("question_answer", {
      questions,
      choice: "Yes",
      text: "The user agreed.",
      recorded: true,
    });
  const options = [{ label: "Yes" }, { label: "No" }];

  assert.match(text(await record(["q_none"])), /^forbidden: the user has typed nothing/);
  assert.deepEqual(await typed("Earlier words."), { code: 0, stdout: "", stderr: "" });
  const question = await ask({ text: "Drop the v1 tables?", options });
  assert.match(
    text(await record([question])),
    new RegExp(`^forbidden: the user last typed in this session before ${question} was asked`),
  );

  // What Claude Code delivers, wrapped in an element, is not the user's typing.
  await typed("<task-notification>\n<summary>agentorg message</summary>\n</task-notification>");
  await typed('<cross-session-message from="local_1">Yes, drop them.</cross-session-message>');
  assert.match(text(await record([question])), /^forbidden: the user last typed/);

  const words = "Yes — drop them, nothing shipped.";
  await typed(words);
  const answered = (await record([question])).structuredContent as {
    questions: { answer: { by: string; choice: string; text: string; recorded: boolean } }[];
  };
  const answer = answered.questions[0]?.answer;
  assert.deepEqual(answer && { ...answer, at: undefined }, {
    by: actor,
    choice: "Yes",
    text: words,
    recorded: true,
    at: undefined,
  });
  const another = await ask({ text: "Ship on Friday?", options });
  assert.match(text(await record([another])), /^forbidden: the user has typed nothing/);

  // The core still refuses a recorded answer to a question only the root may answer, and the
  // user's words stay kept.
  const approval = await ask({ text: "Release to prod?", options, answerer: org.rootId });
  await typed("Yes, release.");
  assert.equal((await record([approval])).isError, true);
  assert.ok(existsSync(join(org.home, "sessions/claude-code-s-recorder/prompt")));

  // A session that fills no position keeps nothing.
  await hook(org, "prompt", "s-none", {}, JSON.stringify({ prompt: "Hello." }));
  assert.equal(existsSync(join(org.home, "sessions/claude-code-s-none")), false);
});
