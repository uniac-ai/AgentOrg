import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentFull, AskRecord, MessageRecord } from "../../src/page/types.ts";
import { chain, feed, pending } from "../../web/src/model/activity.ts";

const at = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00Z`;

const ask = (id: string, fields: Partial<AskRecord> = {}): AskRecord =>
  ({
    id,
    agent: "child",
    to: "lead",
    state: "open",
    answer: null,
    escalates: [],
    opened_at: at(1),
    ...fields,
  }) as AskRecord;

const message = (id: string, fields: Partial<MessageRecord> = {}): MessageRecord =>
  ({
    id,
    from: "child",
    to: "lead",
    kind: "note",
    body: id,
    sent_at: at(1),
    read_at: null,
    acknowledged_at: null,
    ...fields,
  }) as MessageRecord;

const detail = (fields: Partial<AgentFull>): AgentFull =>
  ({
    agent: { id: "lead" },
    own_asks: [],
    addressed_asks: [],
    messages: [],
    sessions: [],
    status_history: [],
    ...fields,
  }) as AgentFull;

test("what waits on an agent: open asks to it, unread notes and unreviewed reports to it, oldest first", () => {
  const waiting = pending(
    detail({
      addressed_asks: [
        ask("newer", { opened_at: at(5) }),
        ask("answered", { state: "answered" }),
        ask("older", { opened_at: at(2) }),
      ],
      messages: [
        message("unread"),
        message("read", { read_at: at(3) }),
        message("report-read", { kind: "report", read_at: at(3), sent_at: at(0) }),
        message("report-done", { kind: "report", read_at: at(3), acknowledged_at: at(4) }),
        message("sent-up", { from: "lead", to: null }),
      ],
    }),
  );

  assert.deepEqual(
    waiting.asks.map((a) => a.id),
    ["older", "newer"],
  );
  assert.deepEqual(
    waiting.messages.map((m) => m.id),
    ["report-read", "unread"],
  );
});

test("the feed mixes statuses, asks, answers and messages, newest first, without what is pinned", () => {
  const answered = ask("own", {
    agent: "lead",
    to: null,
    opened_at: at(2),
    state: "answered",
    answer: { choice: "Keep", words: null, by: null, channel: "page", answered_at: at(6) },
  });
  const entries = feed(
    detail({
      own_asks: [answered],
      addressed_asks: [
        ask("from-child", { opened_at: at(4), state: "withdrawn" }),
        ask("still-open", { opened_at: at(7) }),
      ],
      messages: [
        message("note", { sent_at: at(5), read_at: at(5) }),
        message("unread", { sent_at: at(8) }),
      ],
      status_history: [
        { state: "running", summary: "Started.", links: [], blockers: [], at: at(1), session: "s" },
        { state: "waiting", summary: "Asked.", links: [], blockers: [], at: at(3), session: "s" },
      ],
    }),
  );

  assert.deepEqual(
    entries.map((entry) => [entry.kind, entry.at]),
    [
      ["answered", at(6)],
      ["message", at(5)],
      ["asked", at(4)],
      ["status", at(3)],
      ["asked", at(2)],
      ["status", at(1)],
    ],
  );
});

test("a chain nests the asks an ask carries up, and leaves out ones not known", () => {
  const bottom = ask("bottom");
  const middle = ask("middle", { escalates: ["bottom"] });
  const top = ask("top", { escalates: ["middle", "gone"] });
  const known = new Map([bottom, middle, top].map((a) => [a.id, a]));

  const ids = (c: ReturnType<typeof chain>): unknown => [c.ask.id, c.carries.map(ids)];
  assert.deepEqual(ids(chain(top, known)), ["top", [["middle", [["bottom", []]]]]]);
});
