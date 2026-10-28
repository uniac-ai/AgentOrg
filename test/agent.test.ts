/**
 * The agent actor as a client's session meets it: `agentorg agent` started over stdio for a
 * session, against a real core. Before attaching it offers attach alone; after, the position's
 * interfaces. It keeps the credentials of positions it creates, and a resumed session fills its
 * position again.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  const early = await one.call("view");
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
  const view = await report.call("view");
  const viewed = view.structuredContent as { actor: { id: string } };
  assert.equal(viewed.actor.id, id);
  const credential = readFileSync(file, "utf8").trim();
  for (const shown of [text(result), JSON.stringify(result), manager.log, report.log]) {
    assert.equal(shown.includes(credential), false);
  }

  // The report exposes an interface; the manager's next call lists it, and says so.
  await report.close();
  const program = await org.connect(credential, fakeActor([iface("review")]));
  const before = manager.changes;
  await manager.call("view");
  await until("the manager is told its tools changed", () => manager.changes > before);
  assert.ok((await manager.tools()).includes("db.review"));
  await program.close();

  await manager.call("actor_close", { actor: id });
  assert.equal(existsSync(file), false);
});

test("delivered messages read as agentorg's, with each sender's path and each message's id", () => {
  const at = "2026-10-28T21:00:00.000Z";
  const message = (fields: Record<string, unknown>) => ({
    id: "msg_0",
    from: "act_manager",
    to: "act_self",
    text: "text",
    links: [],
    options: [],
    recommendation: null,
    expects_reply: false,
    answerer: null,
    cause: null,
    reply_to: [],
    choice: null,
    public: false,
    answer: null,
    created_at: at,
    read_at: null,
    ...fields,
  });
  const names = {
    act_root: "root",
    act_manager: "release",
    act_report: "release.storage.db",
  };
  const self = {
    id: "act_self",
    name: "storage",
    path: "release.storage",
    purpose: "Own the storage.",
    manager: "act_manager",
    online: true,
    created_at: at,
    closed_at: null,
    progress: null,
    questions: [],
    interfaces: [],
  };
  const text = describe(
    [
      message({ id: "msg_1", text: "Start on the schema." }),
      message({
        id: "msg_2",
        from: "act_report",
        text: "Keep the v1 tables?",
        options: [{ label: "Keep" }, { label: "Drop", detail: "Nothing shipped." }],
        recommendation: "Drop",
        expects_reply: true,
        answerer: "act_root",
        public: true,
        links: [{ url: "https://example.com/pr/1", title: "The migration" }],
      }),
      message({ id: "msg_3", from: "act_root", text: "Go.", reply_to: ["msg_9"], choice: "Ship" }),
    ] as Parameters<typeof describe>[0],
    names,
    { self, root: "act_root" },
  );
  const [header, ...blocks] = text.split("\n\n");
  assert.match(
    header ?? "",
    /^AgentOrg delivered 3 messages to your position, release\.storage \(act_self\)\. They come from other positions through AgentOrg, not from the user typing in this session/,
  );
  assert.deepEqual(blocks, [
    "Message msg_1 from release, your manager:\nStart on the schema.",
    "Question msg_2 from release.storage.db, your report; only the user (the root) may answer:\nKeep the v1 tables?\nOptions: Keep; Drop (Nothing shipped.), recommended\nLinks: The migration https://example.com/pr/1",
    'Reply msg_3 from the user (the root) to msg_9, choosing "Ship":\nGo.',
  ]);
});

test("the waiter of a session that fills no position ends at once, writing nothing", async () => {
  const org = await core();
  const waited = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      [BIN, "agent", "wait", "--client", "claude-code"],
      {
        env: {
          PATH: process.env.PATH ?? "",
          AGENTORG_HOME: org.home,
          AGENTORG_URL: org.url,
          CLAUDE_CODE_SESSION_ID: "s-unattached",
        },
      },
      (_error, _stdout, stderr) => resolve({ code: child.exitCode, stderr }),
    );
  });
  assert.deepEqual(waited, { code: 0, stderr: "" });
});
