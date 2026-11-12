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

test("what a computer here reaches is said where it resides, and nowhere claims more than is true with a container", () => {
  const said = (found: Found) => {
    const { form } = computerUnit(found);
    const field = (id: string) => form.find((one) => one.id === id);
    const option = (id: string, value: string) =>
      field(id)?.options?.find((one) => one.value === value)?.description ?? "";
    return {
      local: option("service", "local"),
      rest: `${option("access", "terminal")} ${field("workspace")?.description}`,
    };
  };
  assert.match(said({ isolation: "none" }).local, /No isolation: it acts as you/);
  assert.match(
    said({ isolation: "container" }).local,
    /a container of its own, and the only folder of yours in it is its workspace directory/,
  );
  // The other answers hold however it is isolated, here or at another address.
  for (const found of [{ isolation: "none" }, { isolation: "container" }, undefined] as Found[]) {
    assert.doesNotMatch(said(found).rest, /every file and program|not a sandbox/);
    assert.match(said(found).rest, /depends on where it resides/);
    assert.match(said(found).rest, /made if it's missing/);
  }
});

test("the computer says what an agent built from it will hold: a capability, its surfaces and its views, by the answers", () => {
  const unit = computerUnit({ isolation: "none" });
  assert.deepEqual(unit.capability, { id: "computer", title: "Computer" });
  // Whatever the answers: the load surface, and the Where, meters and workspace views.
  assert.deepEqual(unit.gives.surfaces, [{ surface: "load", protocol: "metrics@1" }]);
  assert.deepEqual(
    unit.gives.views?.map((view) => [
      view.id,
      view.place,
      view.kind,
      view.surface ?? view.operation,
    ]),
    [
      ["where", "column", "facts", undefined],
      ["load", "column", "meters", "load"],
      ["workspace", "column", "facts", undefined],
    ],
  );
  const adds = (field: string, value?: string) => {
    const found = unit.form.find((one) => one.id === field);
    const given = value ? found?.options?.find((one) => one.value === value)?.adds : found?.adds;
    return {
      surfaces: given?.surfaces?.map((one) => one.surface) ?? [],
      views: given?.views?.map((one) => `${one.id}: ${one.operation} at ${one.slot}`) ?? [],
    };
  };
  // With files it has the connection whose `about` says how it is isolated; with none it has
  // neither, so nothing is said of it.
  assert.deepEqual(adds("access", "none"), { surfaces: [], views: [] });
  for (const level of ["read", "files"])
    assert.deepEqual(adds("access", level), {
      surfaces: ["files"],
      views: ["isolation: about at computer"],
    });
  assert.deepEqual(adds("access", "terminal"), {
    surfaces: ["terminal", "files"],
    views: ["isolation: about at computer"],
  });
  assert.deepEqual(adds("browser"), { surfaces: ["browser"], views: [] });
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
