/** The web app's models: the organization from the root's team, progress, and what waits on the user. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  MessageRecord,
  PositionRecord,
  ProgressRecord,
  QuestionRecord,
} from "../../src/human/types.ts";
import {
  answerOf,
  questionsForYou,
  sharedOptions,
  timeline,
} from "../../web/src/model/messages.ts";
import {
  flatten,
  type Member,
  managers,
  openQuestions,
  organizationOf,
  waitingOn,
} from "../../web/src/model/organization.ts";
import {
  isStale,
  recentlyChanged,
  rollup,
  STALE_AFTER_MS,
  total,
  totals,
} from "../../web/src/model/progress.ts";
import { itemState } from "../../web/src/model/state.ts";

type State = "running" | "waiting" | "blocked" | "review" | "closed" | null;

const T0 = "2026-01-01T00:00:00Z";

function member(id: string, manager: string | null, state: State = null, updated = T0): Member {
  const position = {
    id,
    name: id,
    manager,
    created_at: T0,
    closed_at: state === "closed" ? "2026-01-02T00:00:00Z" : null,
    progress:
      state === null || state === "closed"
        ? null
        : { version: 1, state, summary: "", updated_at: updated },
    questions: [],
  } as unknown as PositionRecord;
  return { ...position, reports: [] };
}

const question = (id: string, extra: Partial<QuestionRecord> = {}): QuestionRecord => ({
  id,
  cursor: 1,
  from: "lead",
  to: "root",
  text: id,
  links: [],
  options: [],
  recommendation: null,
  answerer: null,
  cause: null,
  answer: null,
  created_at: T0,
  ...extra,
});

const message = (id: string, extra: Partial<MessageRecord> = {}): MessageRecord => ({
  id,
  cursor: 1,
  from: "lead",
  to: "root",
  text: id,
  links: [],
  reply_to: null,
  created_at: T0,
  read_at: null,
  ...extra,
});

const options = (...labels: string[]) => labels.map((label) => ({ label }));

/** root → lead → store → script and audit (closed), lead → backfill; root → docs. */
function org() {
  const positions = [
    member("root", null),
    member("lead", "root", "waiting"),
    member("store", "lead", "review"),
    member("script", "store", "running"),
    member("audit", "store", "closed"),
    member("backfill", "lead", "blocked"),
    member("docs", "root", "running"),
  ];
  return organizationOf({ root: "root", positions, names: {} });
}

test("the organization holds every member by id, and flattens in tree order", () => {
  const organization = org();
  assert.equal(organization.members.size, 7);
  assert.deepEqual(
    flatten(organization.root.reports).map((each) => each.id),
    ["lead", "store", "script", "audit", "backfill", "docs"],
  );
});

test("an actor's managers run from below the root down, and an unknown one ends the path", () => {
  const { members } = org();
  assert.deepEqual(
    managers("script", members).map((each) => each.id),
    ["lead", "store"],
  );
  assert.deepEqual(managers("lead", members), []);
  assert.deepEqual(managers("missing", members), []);
});

test("a manager's roll-up counts its whole subtree by state, and totals count each actor once", () => {
  const organization = org();
  const lead = rollup(organization.members.get("lead") as Member);
  assert.deepEqual(
    [lead.review, lead.running, lead.closed, lead.blocked, total(lead)],
    [1, 1, 1, 1, 4],
  );
  assert.equal(total(rollup(organization.members.get("script") as Member)), 0);
  const everyone = totals(flatten(organization.root.reports));
  assert.equal(total(everyone), 6);
  assert.deepEqual([everyone.running, everyone.waiting, everyone.idle], [2, 1, 0]);
});

test("a running actor quiet too long is stale, and the latest progress comes first", () => {
  const now = Date.parse(T0) + STALE_AFTER_MS + 1;
  assert.equal(isStale(member("a", null, "running"), now), true);
  assert.equal(isStale(member("b", null, "waiting"), now), false);
  assert.equal(isStale(member("c", null, "running", new Date(now).toISOString()), now), false);
  const recent = recentlyChanged(
    [
      member("old", null, "running", "2026-01-01T01:00:00Z"),
      member("new", null, "review", "2026-01-01T03:00:00Z"),
      member("mid", null, "blocked", "2026-01-01T02:00:00Z"),
      member("none", null),
    ],
    2,
  );
  assert.deepEqual(
    recent.map((each) => each.id),
    ["new", "mid"],
  );
});

test("open questions come from every member, and wait on their addressee", () => {
  const organization = org();
  const lead = organization.members.get("lead") as Member;
  const store = organization.members.get("store") as Member;
  lead.questions = [question("q2", { created_at: "2026-01-01T02:00:00Z", options: options("Y") })];
  store.questions = [question("q1", { from: "store", to: "lead" })];
  assert.deepEqual(
    openQuestions(organization).map((each) => each.id),
    ["q1", "q2"],
  );
  assert.deepEqual(
    waitingOn("lead", organization).map((each) => each.id),
    ["q1"],
  );
});

test("what waits on the user leads with approvals only it gives, wherever they are addressed", () => {
  const toYou = [question("q2", { created_at: "2026-01-01T02:00:00Z" }), question("q1")];
  const open = [
    question("q1"),
    question("gate", {
      to: "lead",
      answerer: "root",
      options: options("Promote"),
      created_at: "2026-01-01T03:00:00Z",
    }),
    question("other", { to: "lead", answerer: "lead", options: options("Yes") }),
    question("plain", { to: "lead", options: options("Yes") }),
  ];
  assert.deepEqual(
    questionsForYou(toYou, open, "root").map((each) => each.id),
    ["gate", "q1", "q2"],
  );
});

test("one answer resolves several questions, choosing only among the options they share", () => {
  const a = question("a", { options: options("Approve", "Reject", "Later") });
  const b = question("b", { options: options("Reject", "Approve") });
  assert.deepEqual(sharedOptions([a, b]), ["Approve", "Reject"]);
  assert.deepEqual(sharedOptions([a, question("open")]), []);
  assert.deepEqual(sharedOptions([]), []);
  assert.deepEqual(answerOf(["a", "b"], "Approve", "  both, after the tests  "), {
    questions: ["a", "b"],
    choice: "Approve",
    text: "both, after the tests",
  });
  assert.deepEqual(answerOf(["a"], undefined, "neither: ship Friday"), {
    questions: ["a"],
    text: "neither: ship Friday",
  });
  assert.deepEqual(answerOf(["a"], "Approve", " "), { questions: ["a"], choice: "Approve" });
});

test("history is earlier progress, questions by their answer, and messages, newest first, each once", () => {
  const version = (at: string): ProgressRecord => ({
    actor: "lead",
    version: 1,
    state: "running",
    summary: at,
    items: [],
    links: [],
    updated_at: at,
  });
  const answered = question("q", {
    answer: {
      by: "lead",
      choice: null,
      text: "ship it",
      recorded: true,
      at: "2026-01-01T03:00:00Z",
    },
  });
  const entries = timeline(
    [version("2026-01-01T01:00:00Z")],
    [answered, answered],
    [
      message("m", { created_at: "2026-01-01T02:00:00Z" }),
      message("m", { created_at: "2026-01-01T02:00:00Z" }),
    ],
  );
  assert.deepEqual(
    entries.map((entry) => [entry.kind, entry.at]),
    [
      ["question", "2026-01-01T03:00:00Z"],
      ["message", "2026-01-01T02:00:00Z"],
      ["progress", "2026-01-01T01:00:00Z"],
    ],
  );
});

test("an item's state reads as one of the app's states, a planned one as idle", () => {
  const states = ["planned", "running", "waiting", "blocked", "review"] as const;
  assert.deepEqual(
    states.map((state) => itemState({ title: state, state })),
    ["idle", "running", "waiting", "blocked", "review"],
  );
});
