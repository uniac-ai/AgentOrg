import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { describeInterface, type Interface } from "@agentorg/sdk";
import * as exported from "../src/index.ts";

/**
 * The package's contracts and names as they were when these files were made. Moving code inside
 * the package must leave both as they are: every interface hashes the same, and every name is
 * still exported.
 */
const committed = (file: string): unknown =>
  // Read beside the test's source: the compiled test runs from dist/test.
  JSON.parse(readFileSync(new URL(`../../test/${file}`, import.meta.url), "utf8"));

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What `defineInterface` returns: a named, versioned rpc contract with its methods and events. */
const isInterface = (value: unknown): value is Interface =>
  isObject(value) &&
  value.kind === "rpc" &&
  typeof value.name === "string" &&
  Number.isInteger(value.major) &&
  isObject(value.methods) &&
  isObject(value.events);

test("every exported interface hashes as it did, and none is added or gone", () => {
  const expected = committed("interface-hashes.json") as Record<string, string>;
  const found = new Set<string>();
  for (const [as, value] of Object.entries(exported)) {
    if (!isInterface(value)) continue;
    const { id, hash } = describeInterface(value);
    const was = expected[id];
    assert.ok(
      was,
      `${id} (exported as ${as}) has no committed hash. Contracts must not change: moving code adds no interface.`,
    );
    assert.equal(
      hash,
      was,
      `${id} (exported as ${as}) hashes ${hash}, not ${was}. Contracts must not change: leave its schemas exactly as they are.`,
    );
    found.add(id);
  }
  for (const id of Object.keys(expected))
    assert.ok(
      found.has(id),
      `${id} is no longer exported. Contracts must not change: every interface stays exported.`,
    );
});

test("every name the package exported is still exported", () => {
  const names = new Set(Object.keys(exported));
  const missing = (committed("exported-names.json") as string[]).filter((n) => !names.has(n));
  assert.deepEqual(missing, [], `No longer exported: ${missing.join(", ")}.`);
});
