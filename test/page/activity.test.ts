import assert from "node:assert/strict";
import { test } from "node:test";
import type { AskRecord, EntityView, MessageRecord } from "../../src/page/types.ts";
import { chain, feed } from "../../web/src/model/activity.ts";

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

const status = (minute: number, summary: string) => ({
  state: "running" as const,
  summary,
  links: [],
  blockers: [],
  at: at(minute),
  session: "s",
});

test("the feed mixes statuses, asks, answers and messages, newest first, without what is pinned, open asks going up or the current status", () => {
  const answered = ask("own", {
    agent: "lead",
    to: null,
    opened_at: at(2),
    state: "answered",
    answer: { choice: "Keep", words: null, by: null, channel: "page", answered_at: at(6) },
  });
  const stillOpen = ask("still-open", { opened_at: at(7) });
  const goingUp = ask("going-up", { agent: "lead", to: null, opened_at: at(7) });
  const unread = message("unread", { sent_at: at(8) });
  const view = {
    agent: { id: "lead", status: { updated_at: at(9) } },
    asks_to_answer: [stillOpen],
    own_asks: [answered, goingUp],
    inbox: [unread],
    history: {
      asks: [
        answered,
        ask("from-child", { opened_at: at(4), state: "withdrawn" }),
        stillOpen,
        goingUp,
      ],
      messages: [message("note", { sent_at: at(5), read_at: at(5) }), unread],
      sessions: [],
      status_history: [status(9, "Current."), status(3, "Asked."), status(1, "Started.")],
    },
  } as unknown as EntityView;

  assert.deepEqual(
    feed(view).map((entry) => [entry.kind, entry.at]),
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
