/**
 * The agent actor as a client's session meets it: `agentorg-mcp` started over stdio for a
 * session, against a real core. The stable tools attach, list and invoke the position's
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
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { claudeTakesInput } from "../src/clients/mcp/command.ts";
import { describe } from "../src/clients/mcp/waiter.ts";
import { CONNECTION_PATH, establish } from "../src/connection/index.ts";
import { Form, Message, Position } from "../src/contract/index.ts";
import { dial } from "../src/network/index.ts";
import { type Core, startCore, until } from "./harness.ts";

const BIN = fileURLToPath(new URL("../src/clients/mcp/bin.js", import.meta.url));

const open: { close(): Promise<void> }[] = [];
after(() => Promise.allSettled(open.map((each) => each.close())));

async function core(
  options: Parameters<typeof startCore>[0] = {},
): Promise<Core & { home: string }> {
  const started = await startCore(options);
  open.push(started);
  return Object.assign(started, { home: join(started.credentialFile, "..") });
}

/** A session's view of `agentorg-mcp`: stable tools, current capabilities and calls. */
async function session(core: Core & { home: string }, id: string, kind = "claude-code") {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, "--client", kind],
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
  await client.connect(transport);
  open.push(client);
  const tool = async (
    name: string,
    args: Record<string, unknown> = {},
    metadata: Record<string, unknown> = kind === "codex" ? { threadId: id } : {},
    options?: RequestOptions,
  ) =>
    (await client.callTool(
      { name, arguments: args, _meta: metadata },
      undefined,
      options,
    )) as CallToolResult;
  return {
    get log() {
      return log;
    },
    instructions: () => client.getInstructions(),
    tools: async () => (await client.listTools()).tools.map((tool) => tool.name).sort(),
    tool,
    interfaces: async () => {
      const listed = await tool("interfaces");
      return (
        (
          listed.structuredContent as { tools?: { interfaces: { call: string }[] }[] }
        )?.tools?.flatMap((tool) => tool.interfaces.map((offer) => offer.call)) ?? []
      );
    },
    call: async (
      name: string,
      args: Record<string, unknown> = {},
      metadata: Record<string, unknown> = kind === "codex" ? { threadId: id } : {},
    ) =>
      tool(
        name === "attach" ? name : "call",
        name === "attach" ? args : { name, input: args },
        metadata,
      ),
    close: () => client.close(),
  };
}

const text = (result: CallToolResult) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

test("Codex binds from each call, resumes the same actor, and gives a fork its own attachment", async () => {
  const org = await core();
  const first = await session(org, "codex-thread", "codex");
  assert.deepEqual(
    await first.tools(),
    ["attach", "call", "interfaces"],
    "initialization and listing need no identity",
  );
  for (const metadata of [{}, { threadId: 1 }, { threadId: "../other" }, { threadId: "" }]) {
    const refused = await first.call("attach", { name: "wrong", purpose: "Wrong" }, metadata);
    assert.equal(refused.isError, true);
    assert.match(text(refused), /^invalid: the client must identify its occupant session/);
  }
  assert.equal(org.org.registry.reports(org.rootId).length, 0);
  assert.equal(existsSync(join(org.home, "sessions/codex-")), false);
  const [attached, competing] = await Promise.all([
    first.call("attach", { name: "codex", purpose: "Own Codex." }),
    first.call("attach", { name: "competing", purpose: "Another position." }),
  ]);
  assert.equal(competing.isError, true);
  assert.equal(org.org.registry.reports(org.rootId).length, 1);
  const { actor } = attached.structuredContent as { actor: string };
  assert.equal(
    readFileSync(join(org.home, "sessions/codex-codex-thread/position"), "utf8").trim(),
    actor,
  );
  assert.equal(
    Array.isArray((await first.call("team", { depth: 0 })).structuredContent?.positions),
    true,
  );
  for (const metadata of [{}, { threadId: "different-thread" }]) {
    assert.equal(
      (await first.call("actor_create", { name: "wrong", purpose: "Wrong" }, metadata)).isError,
      true,
    );
  }
  assert.equal(org.org.registry.reports(actor).length, 0);
  await first.close();

  const resumed = await session(org, "codex-thread", "codex");
  assert.deepEqual(await resumed.tools(), ["attach", "call", "interfaces"]);
  assert.deepEqual((await resumed.call("attach", { actor })).structuredContent, {
    actor,
    created: false,
  });
  const team = (await resumed.call("team", { depth: 0 })).structuredContent as {
    positions: { id: string }[];
  };
  assert.equal(team.positions[0]?.id, actor);
  assert.equal(
    (await resumed.call("attach", { name: "another", purpose: "Another" })).isError,
    true,
  );
  assert.equal((await resumed.call("attach", { actor: org.rootId })).isError, true);
  const created = (await resumed.call("actor_create", { name: "report", purpose: "A report." }))
    .structuredContent as { actor: { id: string }; credential: string };
  const credential = readFileSync(join(org.home, "actors", created.actor.id), "utf8").trim();
  assert.match(created.credential, /^kept by agentorg/);
  assert.equal(JSON.stringify(created).includes(credential), false);
  assert.equal(resumed.log.includes(credential), false);

  const fork = await session(org, "fork-thread", "codex");
  assert.deepEqual(await fork.tools(), ["attach", "call", "interfaces"]);
  assert.match(text(await fork.call("team")), /^invalid: attach to your position first/);
  assert.equal(existsSync(join(org.home, "sessions/codex-fork-thread/position")), false);
  assert.deepEqual((await fork.call("attach", { actor: created.actor.id })).structuredContent, {
    actor: created.actor.id,
    created: false,
  });
  assert.equal(Array.isArray((await fork.call("activity")).structuredContent?.entries), true);
  assert.equal(
    (
      await fork.call("actor_create", {
        name: "appointment",
        purpose: "Appointment",
        created_at_attach: true,
      })
    ).isError,
    true,
  );
  await resumed.call("actor_close", { actor: created.actor.id });
  await until(
    "the closed actor's attachment refuses operations",
    async () => (await fork.call("attach", { actor: created.actor.id })).isError === true,
  );
});

test("the stdio catalog is stable and only attachment can act before a position is filled", async () => {
  const org = await core();
  const one = await session(org, "s-refusals");
  assert.deepEqual(await one.tools(), ["attach", "call", "interfaces"]);
  assert.match(one.instructions() ?? "", /Attach before any other action/);
  assert.match(one.instructions() ?? "", /agentorg skill/);
  assert.equal((await one.tool("interfaces")).isError, true);
  assert.equal((await one.tool("call", { name: "team", input: {} })).isError, true);
  const early = await one.call("team");
  assert.equal(early.isError, true);
  assert.match(text(early), /^invalid: attach to your position first/);
  assert.match(text(await one.call("attach", {})), /^invalid: give actor, or name and purpose/);
  const unknown = await one.call("attach", { actor: "act_0000000000" });
  assert.match(text(unknown), /^not_found: no credential is kept for act_0000000000/);
  assert.deepEqual(await one.tools(), ["attach", "call", "interfaces"]);
  const attached = await one.call("attach", { name: "gateway", purpose: "Verify the gateway." });
  const actor = (attached.structuredContent as { actor: string }).actor;
  assert.deepEqual(await one.tools(), ["attach", "call", "interfaces"]);
  assert.equal((await one.tool("team")).isError, true, "operations go through call");
  for (const input of [{}, { name: "team" }, { name: "team", input: [] }]) {
    assert.equal((await one.tool("call", input)).isError, true);
  }
  const listed = (await one.tool("interfaces")).structuredContent as { tools: unknown[] };
  const asActor = await org.client(readFileSync(join(org.home, "actors", actor), "utf8").trim());
  assert.deepEqual(Object.keys(listed), ["tools"]);
  assert.deepEqual(listed.tools, await asActor.available());
  assert.equal(listed.tools.length, 9);
  assert.equal((await one.interfaces()).includes("activity"), true);
  const { actor: report, credential } = await org.org.registry.create(actor, "report", "A report");
  await org.client(credential);
  await until("the report's ordinary client is online", () =>
    org.org.connections.connected(report.id),
  );
  const refreshed = await one.tool("interfaces");
  assert.notEqual(refreshed.isError, true);
  const tools = refreshed.structuredContent?.tools as {
    id: string;
    interfaces: { call: string }[];
  }[];
  assert.equal(tools.length, 9, "connecting an Actor never adds a Tool");
  assert.equal(
    tools.some((tool) => tool.id === report.id),
    false,
  );
  assert.deepEqual(tools, listed.tools);
});

test("an appointed session creates its position under the root, and a resumed one fills it again", async () => {
  const org = await core();
  const first = await session(org, "s-appointed");
  const attached = await first.call("attach", { name: "storage", purpose: "Own the storage." });
  const { actor, created } = attached.structuredContent as { actor: string; created: boolean };
  assert.equal(created, true);
  assert.equal(org.org.registry.get(actor)?.manager, org.rootId);
  const tools = await first.interfaces();
  assert.ok(tools.includes("actor_create") && !tools.includes("attach"), tools.join(", "));
  await until("the position is online", () => org.org.connections.connected(actor));
  await first.close();

  // The same session, resumed: no attach, and the position is filled again on its own.
  const resumed = await session(org, "s-appointed");
  await until("the resumed session gets the position's tools", async () =>
    (await resumed.interfaces()).includes("actor_create"),
  );
  assert.deepEqual(await resumed.tools(), ["attach", "call", "interfaces"]);
  const again = await resumed.call("attach", { name: "other", purpose: "A second position." });
  assert.equal(again.isError, true);
  assert.equal(org.org.registry.reports(org.rootId).length, 1);
});

test("the model receives execution failure while its created Actor credential remains private and usable", async () => {
  const org = await core();
  const manager = await session(org, "s-execution-manager");
  const attachment = await manager.call("attach", { name: "lead", purpose: "Manage execution" });
  assert.notEqual(attachment.isError, true);
  const result = await manager.call("actor_create", {
    name: "worker",
    purpose: "Use an external Provider",
    execution: { providerId: "unavailable", config: {} },
  });
  assert.notEqual(result.isError, true);
  const created = result.structuredContent as {
    actor: { id: string };
    credential: string;
    execution: { providerId: string; status: string; error?: { code: string } };
  };
  assert.equal(created.execution.providerId, "unavailable");
  assert.equal(created.execution.status, "failed");
  assert.equal(typeof created.execution.error?.code, "string");
  assert.match(created.credential, /^kept by agentorg/);
  const credential = readFileSync(join(org.home, "actors", created.actor.id), "utf8").trim();
  assert.equal((await org.org.registry.byCredential(credential))?.id, created.actor.id);
  assert.equal(JSON.stringify(result).includes(credential), false);
  assert.equal(manager.log.includes(credential), false);
  const worker = await session(org, "s-execution-worker");
  const attached = await worker.call("attach", { actor: created.actor.id });
  assert.deepEqual(attached.structuredContent, { actor: created.actor.id, created: false });
});

for (const heldStage of ["describe", "create"] as const) {
  test(`the aggregate execution deadline returns through external MCP while ${heldStage} is held`, async (t) => {
    const providerCredential = "sentinel-budget-provider";
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(providerCredential),
    );
    const org = await core({
      providers: [{ providerId: "factory", credentialHash: Buffer.from(hash).toString("hex") }],
    });
    const model = await session(org, `budget-${heldStage}`);
    assert.notEqual(
      (await model.call("attach", { name: "lead", purpose: "Manage work" })).isError,
      true,
    );
    const url = new URL(CONNECTION_PATH, org.url);
    url.protocol = "ws:";
    const raw = await dial(url);
    t.after(() => raw.close());
    const { channel } = await establish(raw, {
      providerId: "factory",
      credential: providerCredential,
    });
    type ProviderRequest = {
      id: string;
      method: string;
      params: { actorId: string; credential: string };
    };
    let described!: (request: ProviderRequest) => void;
    let launched!: (request: ProviderRequest) => void;
    const description = new Promise<ProviderRequest>((resolve) => {
      described = resolve;
    });
    const launch = new Promise<ProviderRequest>((resolve) => {
      launched = resolve;
    });
    const methods: string[] = [];
    channel.listen(
      (text) => {
        const request = JSON.parse(text) as ProviderRequest;
        methods.push(request.method);
        if (request.method === "provider.describe") described(request);
        else launched(request);
      },
      () => {},
    );
    const reply = (request: ProviderRequest, result: object) =>
      channel.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    async function observed<T>(work: Promise<T>, what: string): Promise<T> {
      let guard: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          work,
          new Promise<never>((_resolve, reject) => {
            guard = realSetTimeout(() => reject(new Error(`never happened: ${what}`)), 5000);
          }),
        ]);
      } finally {
        realClearTimeout(guard);
      }
    }
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    try {
      // Neither the external SDK call nor the child adapter receives a custom timeout.
      const creating = model.call("actor_create", {
        name: "worker",
        purpose: "Work",
        execution: { providerId: "factory", config: {} },
      });
      const request = await observed(description, "the Hub asks Provider for its schema");
      let native: ProviderRequest | undefined;
      if (heldStage === "create") {
        t.mock.timers.tick(30_000);
        reply(request, { configSchema: { type: "object" } });
        native = await observed(launch, "the Hub launches after description");
        t.mock.timers.tick(15_000);
      } else t.mock.timers.tick(45_000);
      const answer = await observed(
        creating,
        "the external default-budget MCP call returns the created Actor",
      );
      assert.notEqual(answer.isError, true);
      const value = answer.structuredContent as {
        actor: { id: string };
        credential: string;
        execution: { status: string; error: { code: string } };
      };
      assert.equal(value.execution.status, heldStage === "create" ? "unknown" : "failed");
      assert.match(value.credential, /^kept by agentorg/);
      assert.equal(org.org.registry.get(value.actor.id)?.closed_at, null);
      if (native) reply(native, { actorId: native.params.actorId });
      else reply(request, { configSchema: { type: "object" } });
      assert.notEqual(
        (await observed(model.call("team"), "the Actor remains callable after expiry")).isError,
        true,
      );
      assert.deepEqual(
        methods,
        heldStage === "create"
          ? ["provider.describe", "provider.createActor"]
          : ["provider.describe"],
      );
    } finally {
      t.mock.timers.reset();
    }
  });
}

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

  // The same private credential also operates an ordinary program client.
  await report.close();
  const program = await org.client(credential);
  assert.equal(
    (await program.call("work_create", { ownerID: org.rootId, goal: "Working" })).state,
    "done",
  );
  assert.equal((await manager.call("db.review")).isError, true);
  await program.close();

  await manager.call("actor_close", { actor: id });
  assert.equal(existsSync(file), false);
});

test("the waiter names ordinary Actor records without claiming native user provenance", () => {
  const at = "2026-10-30T00:00:00.000Z";
  const self = Position.parse({
    id: "self",
    name: "worker",
    path: "team.worker",
    purpose: "Work",
    manager: "manager",
    online: true,
    created_at: at,
    closed_at: null,
  });
  const message = Message.parse({
    messageID: "msg1",
    senderID: "manager",
    recipientID: "self",
    text: "Build the schema.",
    createdAt: at,
    revision: 1,
    cursor: 1,
    history: [],
  });
  const form = Form.parse({
    formID: "form1",
    requesterID: "peer",
    respondentIDs: ["self"],
    fields: [{ name: "choice", label: "Choose", required: true }],
    status: "open",
    createdAt: at,
    responses: {},
    revision: 1,
    cursor: 1,
    history: [],
  });
  const delivered = describe(
    {
      messages: [message],
      forms: [form],
      names: { manager: "lead", peer: "reviewer" },
      position: { messages: 1, forms: 1 },
    },
    { self },
  );
  assert.match(delivered, /Message msg1 from lead, your manager:\nBuild the schema/);
  assert.match(delivered, /Form form1 from reviewer, open, revision 1/);
  assert.match(delivered, /native approval requires its client's validated binding/);
  assert.doesNotMatch(delivered, /only the user|recorded: true|the user \(the root\)/);
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

/** Run a hook's `agentorg-mcp` command for session `id`, as Claude Code runs it. */
function hook(
  org: Core & { home: string },
  command: string,
  id: string,
  env: Record<string, string> = {},
  input = "",
  kind = "claude-code",
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      [BIN, command, "--client", kind],
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

test("Codex context hooks use stdin identity and never create an unattached session", async () => {
  const org = await core();
  const run = (payload: Record<string, unknown>) =>
    hook(
      org,
      "context",
      "wrong-inherited-id",
      { CODEX_THREAD_ID: "wrong-inherited-id" },
      JSON.stringify(payload),
      "codex",
    );
  assert.match((await run({ session_id: "hook-thread" })).stdout, /attach with `attach`/);
  for (const input of ['["sentinel-credential"]', '{"prompt":"sentinel-credential"']) {
    const malformed = await hook(org, "context", "unused", {}, input, "codex");
    assert.equal(malformed.code, 1);
    assert.match(malformed.stderr, /client hook input must be a JSON object/);
    assert.equal((malformed.stdout + malformed.stderr).includes("sentinel-credential"), false);
  }
  const worker = await session(org, "hook-thread", "codex");
  await worker.call("attach", { name: "hooked", purpose: "Work" });
  assert.deepEqual(await run({ session_id: "hook-thread" }), { code: 0, stdout: "", stderr: "" });
  assert.equal(existsSync(join(org.home, "sessions/codex-wrong-inherited-id")), false);
  assert.equal(existsSync(join(org.home, "sessions/codex-hook-thread/prompt")), false);
});

test("a session that fills no position is told to attach first, and its waiter ends at once", async () => {
  const org = await core();
  assert.deepEqual(await hook(org, "context", "s-new"), {
    code: 0,
    stdout:
      "agentorg: This session can fill a position in an AgentOrg organization. Load the agentorg skill, then attach with `attach` before any other action.\n",
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

test("the waiter delivers Messages and Form changes using private per-module positions", async () => {
  const org = await core();
  const worker = await session(org, "s-waited");
  const { actor } = (await worker.call("attach", { name: "worker", purpose: "Work" }))
    .structuredContent as { actor: string };
  const root = await org.client(org.root);
  const done = <T>(answer: unknown) => (answer as { value: T }).value;
  const send = async (text: string) =>
    done<{ messageID: string }>(await root.call("message_send", { recipientID: actor, text }))
      .messageID;
  const alive = { CLAUDE_PID: String(process.pid) };
  const claim = join(org.home, "sessions/claude-code-s-waited/waiter");
  const inbox = join(org.home, "sessions/claude-code-s-waited/inbox");
  const first = hook(org, "wait", "s-waited", alive);
  await until("the waiter polls", () => existsSync(inbox));
  const id = await send("Start with the schema.");
  const woke = await within(20_000, "the first message", first);
  assert.equal(woke.code, 2);
  assert.ok(woke.stderr.includes(`Message ${id} from root, your manager:\nStart with the schema.`));
  const original = done(await root.call("message_get", { messageID: id }));
  assert.equal(JSON.stringify(original).includes("read_at"), false);
  const claimed = (before: string) =>
    until("a waiter claims the session", () => readFileSync(claim, "utf8") !== before);
  let before = readFileSync(claim, "utf8");
  const older = hook(org, "wait", "s-waited", alive);
  await claimed(before);
  before = readFileSync(claim, "utf8");
  const newer = hook(org, "wait", "s-waited", alive);
  await claimed(before);
  assert.deepEqual(await within(5000, "the replaced waiter stops", older), {
    code: 0,
    stdout: "",
    stderr: "",
  });
  const next = await send("Then the data.");
  const latest = await within(20_000, "the newer waiter", newer);
  assert.equal(latest.code, 2);
  assert.ok(latest.stderr.includes(next));
  assert.equal(latest.stderr.includes(id), false);
  assert.deepEqual(
    done(await root.call("message_get", { messageID: id })),
    original,
    "delivery never mutates public messages",
  );
  const form = done<{ formID: string }>(
    await root.call("form_create", {
      respondentIDs: [actor],
      fields: [{ name: "choice", label: "Choose", required: true }],
    }),
  );
  const delivered = await within(20_000, "the form", hook(org, "wait", "s-waited", alive));
  assert.equal(delivered.code, 2);
  assert.ok(delivered.stderr.includes(`Form ${form.formID}`));
  assert.equal(delivered.stderr.includes(next), false);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(inbox, "utf8"))).sort(), [
    "forms",
    "messages",
  ]);
  assert.deepEqual(await hook(org, "wait", "s-waited", { CLAUDE_PID: "999999" }), {
    code: 0,
    stdout: "",
    stderr: "",
  });
});
