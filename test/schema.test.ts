/** The shared validator accepts the JSON Schema dialects used by Actor and Provider clients. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { validSchema, violation } from "../src/schema.ts";

test("actual Zod 2020-12 output validates tuple positions, formats and required properties", () => {
  const schema = z.toJSONSchema(
    z
      .object({
        pair: z.tuple([z.string(), z.number()]),
        email: z.email(),
        mode: z.string().default("safe"),
      })
      .strict(),
    { io: "input" },
  );
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(validSchema(schema), true);
  const input = { pair: ["label", 2], email: "person@example.com" };
  assert.equal(violation(schema, input), undefined);
  assert.deepEqual(input, { pair: ["label", 2], email: "person@example.com" });
  for (const invalid of [
    { pair: [2, "label"], email: "person@example.com" },
    { pair: ["label", 2, 3], email: "person@example.com" },
    { pair: ["label", 2], email: "invalid-email" },
    { pair: ["label", 2], email: "person@example.com", extra: true },
    { email: "person@example.com" },
  ]) {
    assert.notEqual(violation(schema, invalid), undefined);
  }
});

test("2020-12 resolves local definitions and enforces dependentRequired", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: { name: { type: "string", minLength: 1 } },
    type: "object",
    properties: { first: { $ref: "#/$defs/name" }, second: { $ref: "#/$defs/name" } },
    dependentRequired: { first: ["second"] },
    additionalProperties: false,
  };
  assert.equal(validSchema(schema), true);
  assert.equal(violation(schema, { first: "a", second: "b" }), undefined);
  assert.notEqual(violation(schema, { first: "a" }), undefined);
  assert.notEqual(violation(schema, { first: "a", second: "" }), undefined);
});

test("draft-7 and schemas without a dialect retain tuple, definition and format validation", () => {
  for (const dialect of [undefined, "http://json-schema.org/draft-07/schema#"]) {
    const schema = {
      ...(dialect === undefined ? {} : { $schema: dialect }),
      type: "array",
      definitions: { email: { type: "string", format: "email" } },
      items: [{ $ref: "#/definitions/email" }, { type: "integer" }],
      minItems: 2,
      additionalItems: false,
    };
    assert.equal(validSchema(schema), true);
    assert.equal(violation(schema, ["person@example.com", 2]), undefined);
    assert.notEqual(violation(schema, [2, "person@example.com"]), undefined);
    assert.notEqual(violation(schema, ["bad-email", 2]), undefined);
    assert.notEqual(violation(schema, ["person@example.com", 2, 3]), undefined);
  }
});

test("independent schemas with the same local ID do not contaminate each other", () => {
  const string = { $id: "urn:agentorg:test:configuration", type: "string" };
  const number = { $id: "urn:agentorg:test:configuration", type: "number" };
  assert.equal(violation(string, "value"), undefined);
  assert.equal(violation(number, 5), undefined);
  assert.notEqual(violation(string, 5), undefined);
  assert.notEqual(violation(number, "value"), undefined);
});

test("invalid, remote and asynchronous schemas fail with fixed diagnostics", () => {
  for (const schema of [
    { type: "sentinel-invalid-schema-type" },
    { $schema: "sentinel-private-metadata", type: "object" },
    { $ref: "https://sentinel-private-reference.invalid/schema" },
    { $async: true, type: "object" },
  ]) {
    assert.equal(validSchema(schema), false);
    assert.equal(violation(schema, {}), "the schema itself is invalid");
  }
  assert.equal(validSchema(null), false);
  assert.equal(validSchema([]), false);
  const pattern = { type: "string", pattern: "sentinel-private-pattern" };
  assert.equal(violation(pattern, "sentinel-private-value"), "the value does not match the schema");
});
