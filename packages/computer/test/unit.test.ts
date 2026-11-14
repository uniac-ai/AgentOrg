import assert from "node:assert/strict";
import test from "node:test";
import { computerUnit, type Found, INSTALL_STEPS, WEB_UNIT } from "../src/unit.ts";

const READY: Found = { made: [{ isolation: "container", ready: true }] };
const option = (found: Found, field: string, value: string) =>
  computerUnit(found)
    .form.find((one) => one.id === field)
    ?.options?.find((one) => one.value === value);

test("a stack holds one computer and one web search, and this computer, whole and as you, is a caution", () => {
  assert.equal(option(READY, "kind", "this")?.caution, true);
  assert.match(option(READY, "kind", "this")?.description ?? "", /whole machine.*acts as you/);
  assert.equal(option(READY, "kind", "new")?.caution, undefined);
  assert.equal(computerUnit(READY).once, true);
  assert.equal(WEB_UNIT.once, true);
});

test("what this machine can't give now is greyed with the service's reason", () => {
  const unavailable = (found: Found) => ({
    whole: option(found, "kind", "this")?.unavailable,
    container: option(found, "made", "container")?.unavailable,
    remote: option(found, "made", "remote")?.unavailable,
  });
  assert.deepEqual(unavailable(READY), {
    whole: undefined,
    container: undefined,
    remote: undefined,
  });
  const docker = "A container needs Docker, which isn't answering on this machine.";
  assert.deepEqual(
    unavailable({ made: [{ isolation: "container", ready: false, reason: docker }] }),
    {
      whole: undefined,
      container: docker,
      remote: undefined,
    },
  );
  // This computer, when the service here says it can't be attached now.
  assert.deepEqual(
    unavailable({
      thisComputer: { ready: false, reason: "Its user can't be found." },
      made: [{ isolation: "container", ready: true }],
    }),
    { whole: "Its user can't be found.", container: undefined, remote: undefined },
  );
  // Not installed: nothing of this machine, but a service elsewhere still.

  assert.deepEqual(unavailable(undefined), {
    whole: INSTALL_STEPS,
    container: INSTALL_STEPS,
    remote: undefined,
  });
  // None runs yet: one is started when a computer is added, and says then.
  assert.deepEqual(unavailable({ made: [], starts: true }), {
    whole: undefined,
    container: undefined,
    remote: undefined,
  });
  // One that can't be used, such as one older than this build: nothing of this machine, and why.
  assert.deepEqual(unavailable({ made: [], why: "Update it." }), {
    whole: "Update it.",
    container: "Update it.",
    remote: undefined,
  });
});

test("the computer says what an agent built from it will hold: a capability, its surfaces and its views, by the answers", () => {
  const unit = computerUnit(READY);
  assert.deepEqual(unit.capability, { id: "computer", title: "Computer" });
  // Whatever the answers: the load and presence surfaces, and the computer, meters, workspace and
  // in-use views.
  assert.deepEqual(unit.gives.surfaces, [
    { surface: "load", protocol: "metrics@1" },
    { surface: "presence", protocol: "presence@1" },
  ]);
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
      ["in-use", "column", "presence", "presence"],
    ],
  );
  const adds = (field: string, value?: string) => {
    const found = unit.form.find((one) => one.id === field);
    const given = value ? found?.options?.find((one) => one.value === value)?.adds : found?.adds;
    return {
      surfaces: given?.surfaces?.map((one) => one.surface) ?? [],
      views: given?.views?.map((one) => one.id) ?? [],
    };
  };
  assert.deepEqual(adds("access", "none"), { surfaces: [], views: [] });
  for (const level of ["read", "files"])
    assert.deepEqual(adds("access", level), { surfaces: ["files"], views: [] });
  assert.deepEqual(adds("access", "terminal"), { surfaces: ["terminal", "files"], views: [] });
  assert.deepEqual(adds("browser"), { surfaces: ["browser"], views: [] });
});

test("the computer's form is titled and ordered: which computer, where, how it's made, what it reaches, this computer's screen and browser, a browser", () => {
  const { form } = computerUnit(READY);
  const shown = (id: string) => form.find((field) => field.id === id)?.visible;
  assert.deepEqual(
    form.map(({ id, title }) => [id, title]),
    [
      ["kind", "Which computer"],
      ["workspace", "Where its work happens"],
      ["made", "Made as"],
      ["address", "Provider's address"],
      ["token", "Token"],
      ["path", "Workspace directory"],
      ["access", "What it reaches"],
      ["screen", "Screen"],
      ["ownBrowser", "Browser"],
      ["browser", "With a browser"],
    ],
  );
  const titles = (id: string) =>
    form.find((field) => field.id === id)?.options?.map((one) => one.title);
  assert.deepEqual(titles("kind"), ["This computer", "A new computer"]);
  assert.deepEqual(titles("made"), ["A container on this machine", "At another address"]);
  assert.deepEqual(titles("access"), [
    "Files and terminal",
    "Files",
    "Read-only files",
    "No files or terminal",
  ]);
  assert.equal(form.find((field) => field.id === "access")?.default, "terminal");
  // A made computer's own browser goes with it unless the person turns it off.
  assert.equal(form.find((field) => field.id === "browser")?.default, true);
  // Nobody fills in which computer but the person; where its work happens is this computer's,
  // a folder said to it and not a wall; a browser of its own is a made computer's.
  assert.equal(form.find((field) => field.id === "kind")?.default, undefined);
  assert.deepEqual(shown("workspace"), { field: "kind", in: ["this"] });
  assert.match(form.find((field) => field.id === "workspace")?.description ?? "", /Not a wall/);
  assert.deepEqual(shown("made"), { field: "kind", in: ["new"] });
  assert.deepEqual(shown("browser"), { field: "kind", in: ["new"] });
  assert.deepEqual(shown("screen"), { field: "kind", in: ["this"] });
  assert.deepEqual(shown("ownBrowser"), { field: "kind", in: ["this"] });
  assert.deepEqual(titles("screen"), ["Your screen", "No screen"]);
  assert.deepEqual(titles("ownBrowser"), ["Your browser", "No browser"]);
});

test("this computer's screen and the person's browser: on while they can be had, greyed with why while not, in the AgentOrg app's words for a switch", () => {
  const field = (found: Found, id: string) => computerUnit(found).form.find((one) => one.id === id);
  const here = (
    screen: { ready: boolean; reason?: string },
    own: { ready: boolean; reason?: string } | undefined,
    more: Partial<NonNullable<Found>> = {},
  ): Found => ({
    ...READY,
    thisComputer: {
      ready: true,
      capabilities: [
        { capability: "files", ready: true },
        { capability: "screen", ...screen },
      ],
      browsers: [{ kind: "headless", ready: true }, ...(own ? [{ kind: "own", ...own }] : [])],
    },
    ...more,
  });
  // Ready: on, and what each gives.
  const ready = here({ ready: true }, { ready: true });
  assert.equal(field(ready, "screen")?.default, "on");
  assert.equal(field(ready, "ownBrowser")?.default, "yours");
  assert.equal(option(ready, "screen", "on")?.unavailable, undefined);
  assert.equal(option(ready, "ownBrowser", "yours")?.caution, true);
  assert.deepEqual(option(ready, "screen", "on")?.adds, {
    slots: [{ name: "screen" }],
    skills: [{ name: "screen", files: ["SKILL.md"] }],
    surfaces: [{ surface: "screen", protocol: "screen@1" }],
  });
  assert.deepEqual(option(ready, "ownBrowser", "yours")?.adds?.slots, [{ name: "browser" }]);
  // Not ready, for what the service says: greyed with its words, and off.
  const driver = "Cua Driver isn't installed. Install it from cua.ai/download.";
  const debugging = "Chrome's remote debugging is off. Switch it on at chrome://inspect.";
  const missing = here({ ready: false, reason: driver }, { ready: false, reason: debugging });
  assert.equal(option(missing, "screen", "on")?.unavailable, driver);
  assert.equal(option(missing, "ownBrowser", "yours")?.unavailable, debugging);
  assert.equal(field(missing, "screen")?.default, "off");
  assert.equal(field(missing, "ownBrowser")?.default, "none");
  // Switched off in the AgentOrg app: its words, for each part alike.
  const off = here(
    { ready: false, reason: "The person turned off the screen for agents on this Mac." },
    { ready: false, reason: "The person turned off their own browser for agents on this Mac." },
    { mac: true, off: ["screen", "browser"] },
  );
  assert.equal(
    option(off, "screen", "on")?.unavailable,
    "Screen is turned off in the AgentOrg app. Turn it on there to choose it.",
  );
  assert.equal(
    option(off, "ownBrowser", "yours")?.unavailable,
    "Your browser is turned off in the AgentOrg app. Turn it on there to choose it.",
  );
  // A service that offers no browser of the person's says so; one that says nothing of the
  // machine yet, as before it starts, leaves both off and nothing greyed.
  assert.equal(
    option(here({ ready: true }, undefined), "ownBrowser", "yours")?.unavailable,
    "The provider here can't reach your own browser.",
  );
  // An older service, which lists no screen: greyed, and off.
  const older: Found = {
    ...READY,
    thisComputer: {
      ready: true,
      capabilities: [{ capability: "files", ready: true }],
      browsers: [],
    },
  };
  assert.equal(
    option(older, "screen", "on")?.unavailable,
    "The provider here can't give its screen.",
  );
  assert.equal(field(older, "screen")?.default, "off");
  assert.equal(
    option({ ...older, mac: true }, "screen", "on")?.unavailable,
    "The AgentOrg app on this Mac is older than this AgentOrg. Update it, and open it again.",
  );
  assert.equal(option({ made: [], starts: true }, "screen", "on")?.unavailable, undefined);
  assert.equal(field({ made: [], starts: true }, "screen")?.default, "off");
});
