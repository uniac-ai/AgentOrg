import assert from "node:assert/strict";
import test from "node:test";
import { computerUnit } from "../src/unit.ts";

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
