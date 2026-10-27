import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { OPERATIONS, type RequestOf } from "../src/contract/index.ts";
import type { Caller } from "../src/operations/index.ts";
import { Conflict, Forbidden, Invalid, NotFound } from "../src/operations/index.ts";
import { StoreService } from "../src/operations/service.ts";
import { Store } from "../src/store/index.ts";

const directory = mkdtempSync(join(tmpdir(), "agentorg-service-"));
after(() => rmSync(directory, { recursive: true, force: true }));
let count = 0;

const API: Caller = { channel: "api" };
const PAGE: Caller = { channel: "page" };
const mcp = (clientSessionId: string): Caller => ({
  channel: "mcp",
  client: "claude-code",
  clientSessionId,
});

/** A service over a fresh store, with a clock the test moves. */
function setup() {
  const clock = { now: new Date("2026-01-01T00:00:00Z") };
  const store = new Store(join(directory, `${++count}.db`));
  const service = new StoreService(store, { now: () => clock.now, machine: "laptop" });
  const parse = <N extends keyof typeof OPERATIONS>(name: N, request: unknown) =>
    OPERATIONS[name].request.parse(request) as RequestOf<N>;
  return { clock, store, service, parse };
}

/** A session the user started creates a manager at attach, then a child, and a session attaches. */
async function organization() {
  const context = setup();
  const { service, parse } = context;
  const managing = await service.session_attach(
    parse("session_attach", { new_agent: { title: "Run the release", purpose: "Ship 1.0." } }),
    mcp("m-1"),
  );
  const manager = managing.agent;
  const child = await service.agent_create(
    parse("agent_create", {
      session: managing.session.id,
      title: "Migrate storage",
      purpose: "Move to SQLite.",
    }),
    mcp("m-1"),
  );
  const working = await service.session_attach(
    parse("session_attach", { agent: child.id }),
    mcp("c-1"),
  );
  const ask = (session: string, fields: Record<string, unknown> = {}) =>
    service.ask_open(
      parse("ask_open", {
        session,
        title: "Which database?",
        context: "The service needs one store.",
        options: [{ label: "SQLite" }, { label: "Postgres" }],
        recommendation: "SQLite",
        ...fields,
      }),
      mcp("x"),
    );
  return { ...context, manager, managing, child, working, ask };
}

test("an agent created at attach sits under the user, and a session's agent creates its children", async () => {
  const { manager, managing, child } = await organization();
  assert.deepEqual(
    [manager.manager, manager.created_by, manager.created_at_attach],
    [null, managing.session.id, true],
  );
  assert.equal(child.manager, manager.id);
  assert.equal(child.created_by, managing.session.id);
  assert.equal(child.state, "pending");
});

test("attaching activates the agent and returns its facts", async () => {
  const { service, parse, manager, child, managing } = await organization();
  const facts = await service.session_attach(
    parse("session_attach", { agent: manager.id }),
    mcp("m-1"),
  );
  assert.equal(facts.session.id, managing.session.id, "the same client session resumes");
  assert.equal(facts.agent.state, "active");
  assert.equal(facts.manager, null);
  assert.deepEqual(
    facts.children.map((agent) => [agent.id, agent.state]),
    [[child.id, "active"]],
  );
  assert.equal(facts.session.client, "claude-code");
  assert.equal(facts.session.machine, "laptop");
});

test("a new attachment ends the old one, and the old session can no longer write", async () => {
  const { service, parse, child, working } = await organization();
  const elsewhere = await service.session_attach(
    parse("session_attach", { agent: child.id, client: "codex", client_session_id: "x-1" }),
    API,
  );
  assert.notEqual(elsewhere.session.id, working.session.id);
  await assert.rejects(
    service.status_set(parse("status_set", { session: working.session.id, state: "running" }), API),
    Conflict,
  );
  const { agent } = await service.agent_get({ agent: child.id }, API).then((detail) => detail);
  assert.equal(agent.id, child.id);
  const sessions = (await service.agent_get({ agent: child.id }, API)).sessions;
  assert.deepEqual(
    sessions.map((session) => session.detached_at === null),
    [true, false],
  );
});

test("one client session attaches to one agent at a time", async () => {
  const { service, parse, manager, child, working } = await organization();
  await service.session_attach(parse("session_attach", { agent: manager.id }), mcp("c-1"));
  const [childSession] = (await service.agent_get({ agent: child.id }, API)).sessions;
  assert.equal(childSession?.id, working.session.id);
  assert.notEqual(childSession?.detached_at, null);
});

test("new_agent creates an agent under the user, once per client session", async () => {
  const { service, parse } = setup();
  const brief = { title: "Plan the launch", purpose: "Decide what ships." };
  const facts = await service.session_attach(
    parse("session_attach", { new_agent: brief }),
    mcp("u-1"),
  );
  assert.deepEqual(
    [facts.agent.manager, facts.agent.created_at_attach, facts.agent.created_by, facts.agent.state],
    [null, true, facts.session.id, "active"],
  );
  await assert.rejects(
    service.session_attach(parse("session_attach", { new_agent: brief }), mcp("u-1")),
    Conflict,
  );
  const again = await service.session_attach(
    parse("session_attach", { agent: facts.agent.id }),
    mcp("u-1"),
  );
  assert.equal(again.agent.created_by, facts.session.id);
  await assert.rejects(
    service.session_attach(parse("session_attach", { new_agent: brief, client: "script" }), API),
    Invalid,
  );
});

test("an attach needs a client kind and an open agent", async () => {
  const { service, parse } = setup();
  await assert.rejects(
    service.session_attach(parse("session_attach", { agent: "agt_404" }), API),
    Invalid,
  );
  await assert.rejects(
    service.session_attach(parse("session_attach", { agent: "agt_404", client: "codex" }), API),
    NotFound,
  );
  await assert.rejects(
    service.session_attach(parse("session_attach", { agent: "agt_1" }), {
      channel: "api",
      client: "Not A Kind",
    }),
    Invalid,
  );
});

test("the context reads an attached client session's facts, and nothing else", async () => {
  const { service, child, working } = await organization();
  assert.deepEqual(await service.session_context({}, mcp("nobody")), { facts: null });
  assert.deepEqual(await service.session_context({}, API), { facts: null });
  const known = await service.session_context({}, mcp("c-1"));
  assert.equal(known.facts?.session.id, working.session.id);
  assert.equal(known.facts?.agent.id, child.id);
  const byRequest = await service.session_context(
    { client: "claude-code", client_session_id: "c-1" },
    API,
  );
  assert.deepEqual(byRequest, known);
});

test("the status shows in the manager's facts", async () => {
  const { service, parse, manager, working } = await organization();
  await service.status_set(
    parse("status_set", {
      session: working.session.id,
      state: "blocked",
      summary: "Waiting\non CI.",
      blockers: ["CI"],
    }),
    API,
  );
  const facts = await service.session_attach(
    parse("session_attach", { agent: manager.id }),
    mcp("m-1"),
  );
  assert.deepEqual(
    [
      facts.children[0]?.status?.state,
      facts.children[0]?.status?.summary,
      facts.children[0]?.status?.blockers,
    ],
    ["blocked", "Waiting\non CI.", ["CI"]],
  );
});

test("an ask goes to the manager, and only the manager answers it, once", async () => {
  const { service, parse, manager, managing, working, ask } = await organization();
  const opened = await ask(working.session.id);
  assert.equal(opened.to, manager.id);
  const facts = await service.session_attach(
    parse("session_attach", { agent: manager.id }),
    mcp("m-1"),
  );
  assert.deepEqual(
    facts.asks_to_answer.map((each) => each.id),
    [opened.id],
  );

  await assert.rejects(
    service.ask_answer(
      parse("ask_answer", { session: working.session.id, ask: opened.id, choice: "SQLite" }),
      API,
    ),
    Forbidden,
  );
  await assert.rejects(
    service.ask_answer(
      parse("ask_answer", { session: managing.session.id, ask: opened.id, choice: "MySQL" }),
      API,
    ),
    Invalid,
  );
  const answered = await service.ask_answer(
    parse("ask_answer", {
      session: managing.session.id,
      ask: opened.id,
      choice: "SQLite",
      words: "Go.",
    }),
    API,
  );
  assert.deepEqual(
    [answered.state, answered.answer?.by, answered.answer?.channel, answered.answer?.words],
    ["answered", manager.id, "agent", "Go."],
  );
  await assert.rejects(
    service.ask_answer(
      parse("ask_answer", { session: managing.session.id, ask: opened.id, choice: "Postgres" }),
      API,
    ),
    Conflict,
  );
});

test("an escalated ask is answered by the user on the page, and the manager answers the child", async () => {
  const { service, parse, manager, managing, working, ask } = await organization();
  const question = await ask(working.session.id);
  const waiting = service.ask_wait(parse("ask_wait", { ask: question.id }), mcp("c-1"));
  const escalation = await ask(managing.session.id, {
    escalates: [question.id],
    title: "Which database for 1.0?",
  });
  assert.deepEqual([escalation.to, escalation.escalates], [null, [question.id]]);

  const open = await service.ask_list(parse("ask_list", {}), API);
  assert.deepEqual(
    open.asks.map((each) => each.id),
    [question.id, escalation.id],
  );
  assert.deepEqual(
    open.agents.map((agent) => agent.id).sort(),
    [manager.id, question.agent].sort(),
  );

  const decided = await service.ask_answer_as_user(
    parse("ask_answer_as_user", { ask: escalation.id, choice: "Postgres" }),
    PAGE,
  );
  assert.deepEqual([decided.answer?.by, decided.answer?.channel], [null, "page"]);
  await service.ask_answer(
    parse("ask_answer", { session: managing.session.id, ask: question.id, choice: "Postgres" }),
    API,
  );
  const woken = await waiting;
  assert.deepEqual(
    [woken.state, woken.answer?.choice, woken.answer?.by],
    ["answered", "Postgres", manager.id],
  );
});

test("only an open ask addressed to the agent can be escalated", async () => {
  const { managing, working, ask } = await organization();
  const own = await ask(managing.session.id);
  await assert.rejects(ask(managing.session.id, { escalates: [own.id] }), Invalid);
  await assert.rejects(ask(working.session.id, { escalates: ["ask_404"] }), NotFound);
});

test("the user may step in on any open ask", async () => {
  const { service, parse, working, ask } = await organization();
  const opened = await ask(working.session.id);
  const answered = await service.ask_answer_as_user(
    parse("ask_answer_as_user", { ask: opened.id, words: "Use SQLite." }),
    PAGE,
  );
  assert.deepEqual([answered.answer?.by, answered.answer?.words], [null, "Use SQLite."]);
});

test("the asking agent records an answer the user gave in its own conversation", async () => {
  const { service, parse, managing, working, ask } = await organization();
  const toUser = await ask(managing.session.id);
  const toManager = await ask(working.session.id);
  const record = (session: string, id: string) =>
    service.ask_record_answer(
      parse("ask_record_answer", { session, ask: id, words: "SQLite.", choice: "SQLite" }),
      API,
    );
  await assert.rejects(record(working.session.id, toUser.id), Forbidden);
  await assert.rejects(record(working.session.id, toManager.id), Invalid);
  const recorded = await record(managing.session.id, toUser.id);
  assert.deepEqual(
    [recorded.answer?.channel, recorded.answer?.by, recorded.answer?.words],
    ["session", null, "SQLite."],
  );
});

test("only the asking agent withdraws an ask, and a wait returns", async () => {
  const { service, parse, managing, working, ask } = await organization();
  const opened = await ask(working.session.id);
  const waiting = service.ask_wait(parse("ask_wait", { ask: opened.id }), API);
  await assert.rejects(
    service.ask_withdraw({ session: managing.session.id, ask: opened.id }, API),
    Forbidden,
  );
  const withdrawn = await service.ask_withdraw(
    { session: working.session.id, ask: opened.id },
    API,
  );
  assert.equal((await waiting).state, "withdrawn");
  assert.equal(withdrawn.answer, null);
  await assert.rejects(
    service.ask_withdraw({ session: working.session.id, ask: opened.id }, API),
    Conflict,
  );
  const facts = await service.session_attach(
    parse("session_attach", { agent: withdrawn.agent }),
    mcp("c-1"),
  );
  assert.deepEqual(facts.own_asks, []);
});

test("a wait with a timeout returns the ask still open", async () => {
  const { service, parse, working, ask } = await organization();
  const opened = await ask(working.session.id);
  const waited = await service.ask_wait(
    parse("ask_wait", { ask: opened.id, timeout_seconds: 0.01 }),
    API,
  );
  assert.equal(waited.state, "open");
});

test("messages go up, a report stays in the inbox until acknowledged, and a note until read", async () => {
  const { service, parse, manager, managing, working } = await organization();
  const note = await service.message_send(
    parse("message_send", { session: working.session.id, kind: "note", body: "Started." }),
    API,
  );
  const report = await service.message_send(
    parse("message_send", { session: working.session.id, kind: "report", body: "Done." }),
    API,
  );
  assert.equal(report.to, manager.id);
  assert.equal(
    (await service.agent_list(parse("agent_list", {}), API)).agents[0]?.unread_messages,
    2,
  );

  const first = await service.inbox_read({ session: managing.session.id }, API);
  assert.deepEqual(
    first.messages.map((message) => [message.id, message.read_at !== null]),
    [
      [note.id, true],
      [report.id, true],
    ],
  );
  const second = await service.inbox_read({ session: managing.session.id }, API);
  assert.deepEqual(
    second.messages.map((message) => message.id),
    [report.id],
  );

  await assert.rejects(
    service.message_ack({ session: working.session.id, message: report.id }, API),
    Forbidden,
  );
  await assert.rejects(
    service.message_ack({ session: managing.session.id, message: note.id }, API),
    Invalid,
  );
  const acknowledged = await service.message_ack(
    { session: managing.session.id, message: report.id },
    API,
  );
  assert.notEqual(acknowledged.acknowledged_at, null);
  assert.deepEqual(
    await service.message_ack({ session: managing.session.id, message: report.id }, API),
    acknowledged,
  );
  assert.deepEqual((await service.inbox_read({ session: managing.session.id }, API)).messages, []);
});

test("the user reads notes and acknowledges reports from agents directly under the user", async () => {
  const { service, parse, managing, working } = await organization();
  const note = await service.message_send(
    parse("message_send", { session: managing.session.id, kind: "note", body: "On track." }),
    API,
  );
  const report = await service.message_send(
    parse("message_send", { session: managing.session.id, kind: "report", body: "Shipped." }),
    API,
  );
  const lower = await service.message_send(
    parse("message_send", { session: working.session.id, kind: "report", body: "Mine." }),
    API,
  );
  assert.notEqual((await service.message_read_as_user({ message: note.id }, PAGE)).read_at, null);
  await assert.rejects(service.message_read_as_user({ message: report.id }, PAGE), Invalid);
  await assert.rejects(service.message_ack_as_user({ message: lower.id }, PAGE), Forbidden);
  assert.notEqual(
    (await service.message_ack_as_user({ message: report.id }, PAGE)).acknowledged_at,
    null,
  );
});

test("only the manager closes a child, bottom up, and the closed agent cannot act", async () => {
  const { service, parse, manager, managing, child, working, ask } = await organization();
  const opened = await ask(working.session.id);
  await assert.rejects(
    service.agent_close(
      parse("agent_close", { session: working.session.id, agent: child.id }),
      API,
    ),
    Forbidden,
  );
  await assert.rejects(service.agent_close_as_user({ agent: manager.id }, PAGE), Conflict);
  const closed = await service.agent_close(
    parse("agent_close", { session: managing.session.id, agent: child.id }),
    API,
  );
  assert.equal(closed.agent.state, "closed");
  assert.deepEqual(
    closed.withdrawn_asks.map((each) => [each.id, each.state]),
    [[opened.id, "withdrawn"]],
  );
  assert.deepEqual(
    closed.detached_sessions.map((session) => session.id),
    [working.session.id],
  );
  const again = await service.agent_close(
    parse("agent_close", { session: managing.session.id, agent: child.id }),
    API,
  );
  assert.deepEqual([again.withdrawn_asks, again.detached_sessions], [[], []]);
  await assert.rejects(
    service.session_attach(parse("session_attach", { agent: child.id }), mcp("c-2")),
    Conflict,
  );
  assert.deepEqual(
    (await service.agent_list(parse("agent_list", {}), API)).agents.map((each) => each.agent.id),
    [manager.id],
  );
  const closedByUser = await service.agent_close_as_user({ agent: manager.id }, PAGE);
  assert.equal(closedByUser.agent.state, "closed");
  await assert.rejects(ask(managing.session.id), Conflict);
});

test("the agent list counts what waits on each agent, and the detail reads everything", async () => {
  const { service, parse, manager, child, working, ask } = await organization();
  const opened = await ask(working.session.id);
  const [top, below] = (await service.agent_list(parse("agent_list", {}), API)).agents;
  assert.deepEqual(
    [top?.agent.id, top?.asks_to_answer, below?.agent.id, below?.asks_to_answer],
    [manager.id, 1, child.id, 0],
  );
  const detail = await service.agent_get({ agent: child.id }, API);
  assert.deepEqual(
    detail.own_asks.map((each) => each.id),
    [opened.id],
  );
  const managerDetail = await service.agent_get({ agent: manager.id }, API);
  assert.deepEqual(
    managerDetail.addressed_asks.map((each) => each.id),
    [opened.id],
  );
});

test("every write is audited with its outcome, and reads are not", async () => {
  const { service, parse, child, working } = await organization();
  await service.session_context({}, mcp("c-1"));
  await service.agent_list(parse("agent_list", {}), API);
  await assert.rejects(
    service.ask_answer_as_user(parse("ask_answer_as_user", { ask: "ask_404", choice: "A" }), PAGE),
    NotFound,
  );
  await service.status_set(
    parse("status_set", { session: working.session.id, state: "running" }),
    mcp("c-1"),
  );
  const entries = (await service.audit_list(parse("audit_list", {}), API)).entries;
  assert.deepEqual(
    entries.map((entry) => [entry.operation, entry.channel, entry.outcome]),
    [
      ["status_set", "mcp", "ok"],
      ["ask_answer_as_user", "page", "not_found"],
      ["session_attach", "mcp", "ok"],
      ["agent_create", "mcp", "ok"],
      ["session_attach", "mcp", "ok"],
    ],
  );
  assert.deepEqual(
    [entries[0]?.session, entries[0]?.agent, entries[0]?.client, entries[0]?.target],
    [working.session.id, child.id, "claude-code", child.id],
  );
  assert.equal(entries[1]?.target, "ask_404");
  const own = await service.audit_list(parse("audit_list", { agent: child.id, limit: 1 }), API);
  assert.deepEqual(
    own.entries.map((entry) => entry.operation),
    ["status_set"],
  );
});

test("a login link works once and before it expires, and a page session expires", async () => {
  const { service, clock } = setup();
  const link = await service.ui_login_link({}, API);
  const token = link.path.replace("/ui/login?token=", "");
  const page = await service.redeemLoginToken(token);
  assert.deepEqual(await service.getPageSession(page.id), page);
  assert.equal(await service.getPageSession("unknown"), null);
  await assert.rejects(service.redeemLoginToken(token), Invalid);
  const late = await service.ui_login_link({}, API);
  clock.now = new Date(clock.now.getTime() + 6 * 60 * 1000);
  await assert.rejects(
    service.redeemLoginToken(late.path.replace("/ui/login?token=", "")),
    Invalid,
  );
  clock.now = new Date(clock.now.getTime() + 7 * 24 * 60 * 60 * 1000);
  assert.equal(await service.getPageSession(page.id), null);
});
