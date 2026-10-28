/** The communication standard: progress, messages and questions. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMUNICATION,
  MessageSend,
  objectSchema,
  ProgressSet,
} from "../src/domain/model/index.ts";

const issues = (result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`);

test("each method's request and result is an object schema, as interfaces declare them", () => {
  for (const spec of Object.values(COMMUNICATION)) {
    assert.equal(objectSchema(spec.request, "input").type, "object");
    assert.equal(objectSchema(spec.response, "output").type, "object");
  }
});

test("a request breaking the records' rules is refused before it reaches the core", () => {
  assert.deepEqual(
    issues(
      MessageSend.safeParse({
        text: "Which order?",
        options: [{ label: "a" }, { label: "a" }],
        recommendation: "b",
        choice: "a",
      }),
    ),
    [
      "options: labels must be unique",
      "recommendation: must be the label of one of the options",
      "choice: only a reply has one",
    ],
  );
  assert.deepEqual(issues(MessageSend.safeParse({ text: "FYI", answerer: "act_1" })), [
    "answerer: only a question has one",
  ]);
  assert.deepEqual(issues(MessageSend.safeParse({ text: "Go?", expects_reply: true })), []);
  assert.deepEqual(
    issues(
      ProgressSet.safeParse({
        items: [
          { title: "Schemas", state: "running", waits_on: [{ item: "Review" }] },
          { title: "Schemas", state: "planned", waits_on: [{ actor: "act_1", item: "Review" }] },
        ],
      }),
    ),
    ["items: titles must be unique", "items.0.waits_on: there is no item Review"],
  );
  assert.deepEqual(
    issues(ProgressSet.safeParse({ links: [{ url: "javascript:alert(1)" }] })).length,
    1,
  );
});
