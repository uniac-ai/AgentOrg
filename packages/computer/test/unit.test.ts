import assert from "node:assert/strict";
import test from "node:test";
import { computerUnit, type Found, WEB_UNIT } from "../src/unit.ts";

test("a stack holds one computer and one web search, and only no isolation is a caution", () => {
  const local = (found: Found) =>
    computerUnit(found)
      .form.find((field) => field.id === "service")
      ?.options?.find((option) => option.value === "local");
  assert.equal(local({ isolation: "none" })?.caution, true);
  assert.equal(local({ isolation: "container" })?.caution, undefined);
  assert.equal(local(undefined)?.caution, undefined);
  assert.equal(computerUnit(undefined).once, true);
  assert.equal(WEB_UNIT.once, true);
});

test("the computer's form is titled and ordered: where it resides, its folder, what it reaches, a browser", () => {
  const { form } = computerUnit({ isolation: "none" });
  assert.deepEqual(
    form.map(({ id, title }) => [id, title]),
    [
      ["service", "Where it resides"],
      ["address", "Address"],
      ["token", "Token"],
      ["workspace", "Workspace directory"],
      ["path", "Workspace directory"],
      ["access", "What it reaches"],
      ["browser", "With a browser"],
    ],
  );
  const titles = (id: string) =>
    form.find((field) => field.id === id)?.options?.map((option) => option.title);
  assert.deepEqual(titles("service"), ["This computer", "Another address"]);
  assert.deepEqual(titles("access"), [
    "No files or terminal",
    "Read-only files",
    "Files",
    "Files and terminal",
  ]);
});
