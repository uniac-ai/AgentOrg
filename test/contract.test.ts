import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentClose,
  AgentCreate,
  AskAnswer,
  AskAnswerAsUser,
  AskOpen,
  SessionAttach,
  StatusSet,
} from "../src/contract/index.ts";

const ask = (changes: Record<string, unknown> = {}) =>
  AskOpen.safeParse({
    session: "ses_1",
    title: "Which database?",
    context: "The service needs one store. Both options fit the load.",
    options: [{ label: "SQLite" }, { label: "Postgres", detail: "Needs a server." }],
    recommendation: "SQLite",
    ...changes,
  });

test("a complete ask is accepted, trimmed, and escalates nothing by default", () => {
  const parsed = ask({ title: "  Which database?  " });
  assert.ok(parsed.success);
  assert.equal(parsed.data.title, "Which database?");
  assert.deepEqual(parsed.data.escalates, []);
});

for (const [why, changes] of Object.entries({
  "no context": { context: undefined },
  "blank context": { context: "   " },
  "context past its cap": { context: "x".repeat(1001) },
  "one option": { options: [{ label: "SQLite" }] },
  "seven options": {
    options: Array.from({ length: 7 }, (_, n) => ({ label: String(n) })),
    recommendation: "1",
  },
  "repeated labels": { options: [{ label: "SQLite" }, { label: "SQLite" }] },
  "a recommendation that is no option": { recommendation: "MySQL" },
  "no session": { session: undefined },
  "an unknown field": { unknown: "field" },
})) {
  test(`an ask with ${why} is refused`, () => {
    assert.equal(ask(changes).success, false);
  });
}

test("an answer needs a choice or words", () => {
  for (const schema of [AskAnswer, AskAnswerAsUser]) {
    const base = schema === AskAnswer ? { session: "ses_1", ask: "ask_1" } : { ask: "ask_1" };
    assert.equal(schema.safeParse(base).success, false);
    assert.ok(schema.safeParse({ ...base, words: "Use SQLite for now." }).success);
    assert.ok(schema.safeParse({ ...base, choice: "SQLite" }).success);
  }
});

test("a status needs a known state and a short summary", () => {
  assert.equal(StatusSet.safeParse({ session: "ses_1", state: "done" }).success, false);
  const long = { session: "ses_1", state: "running", summary: "x".repeat(2001) };
  assert.equal(StatusSet.safeParse(long).success, false);
  const parsed = StatusSet.parse({ session: "ses_1", state: "running" });
  assert.deepEqual([parsed.summary, parsed.links, parsed.blockers], ["", [], []]);
});

test("a client kind is a plain lowercase name", () => {
  assert.ok(SessionAttach.safeParse({ agent: "agt_1", client: "claude-code" }).success);
  assert.equal(SessionAttach.safeParse({ agent: "agt_1", client: "Claude Code" }).success, false);
});

test("an attach names either an agent or a new agent, not both", () => {
  const newAgent = { title: "Plan the release", purpose: "Decide what ships in 1.0." };
  assert.ok(SessionAttach.safeParse({ agent: "agt_1" }).success);
  assert.ok(SessionAttach.safeParse({ new_agent: newAgent }).success);
  assert.equal(SessionAttach.safeParse({}).success, false);
  assert.equal(SessionAttach.safeParse({ agent: "agt_1", new_agent: newAgent }).success, false);
});

test("creating and closing an agent need the acting session", () => {
  const brief = { title: "Migrate storage", purpose: "Move sessions to SQLite." };
  assert.equal(AgentCreate.safeParse(brief).success, false);
  assert.ok(AgentCreate.safeParse({ session: "ses_1", ...brief }).success);
  assert.equal(AgentClose.safeParse({ agent: "agt_1" }).success, false);
  assert.ok(AgentClose.safeParse({ session: "ses_1", agent: "agt_1" }).success);
});
