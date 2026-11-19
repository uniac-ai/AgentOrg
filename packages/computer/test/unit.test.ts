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

test("this computer's screen and the person's browser: off unless chosen, greyed with why while they can't be had, in the AgentOrg app's words for a switch; a screen lacking only grants there can be chosen", () => {
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
  // Ready: offered, off unless chosen until it has been checked on a real Mac, and what each gives.
  const ready = here({ ready: true }, { ready: true });
  assert.equal(field(ready, "screen")?.default, "off");
  assert.equal(field(ready, "ownBrowser")?.default, "none");
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
  // On in the AgentOrg app, with only a grant macOS hasn't given it: it can be chosen, and the
  // computer starts without that grant.
  const needs =
    "Screen Recording and Accessibility are needed, and AgentOrg is missing Accessibility. Set it up in AgentOrg.";
  const grants = (ungranted: string[], more: Partial<NonNullable<Found>> = {}) =>
    option(
      here(
        { ready: false, reason: needs },
        { ready: true },
        { mac: true, off: [], ungranted, ...more },
      ),
      "screen",
      "on",
    )?.unavailable;
  assert.equal(grants(["accessibility"]), undefined);
  assert.equal(grants(["screen-recording", "accessibility"]), undefined);
  // The switch off is said first; and with no app, or no grant missing, the service's words.
  assert.equal(
    grants(["accessibility"], { off: ["screen"] }),
    "Screen is turned off in the AgentOrg app. Turn it on there to choose it.",
  );
  assert.equal(grants(["accessibility"], { mac: undefined }), needs);
  assert.equal(grants([]), needs);
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
    "The AgentOrg app on this Mac is older than this AgentOrg. Run agentorg update, which updates both.",
  );
  assert.equal(option({ made: [], starts: true }, "screen", "on")?.unavailable, undefined);
  assert.equal(field({ made: [], starts: true }, "screen")?.default, "off");
});

/** This machine as a service that says its name finds it, every part ready, on a Mac with AgentOrg Mac. */
const NAMED: Found = {
  machine: "Studio Mac",
  thisComputer: {
    ready: true,
    capabilities: [
      { capability: "files", ready: true },
      { capability: "screen", ready: true },
    ],
    browsers: [{ kind: "own", ready: true }],
  },
  made: [],
  mac: true,
};
const stated = (found: Found) => computerUnit(found, false);
const fieldOf = (found: Found, id: string) => stated(found).form.find((one) => one.id === id);

test("where no provider that makes is there, it states this computer in a line and asks only its own", () => {
  const unit = stated(NAMED);
  assert.equal(
    unit.description,
    "Studio Mac, whole: your files and apps, its screen and your signed-in browser. It acts as you, with everything you can reach.",
  );
  // Which computer isn't asked, nor anything of a new one's; nothing waits on which it is.
  assert.deepEqual(
    unit.form.map((one) => one.id),
    ["workspace", "access", "screen", "ownBrowser"],
  );
  assert.ok(unit.form.every((one) => one.visible === undefined));
  // What each answer is, and what it gives, are today's.
  const asked = computerUnit(NAMED);
  for (const field of unit.form) {
    const { visible: _, ...was } = asked.form.find((one) => one.id === field.id) ?? {};
    assert.deepEqual(field, was);
  }
  assert.deepEqual({ ...unit, description: "", form: [] }, { ...asked, description: "", form: [] });
});

test("a service that doesn't say its machine's name is called this computer", () => {
  const { machine: _, ...older } = NAMED as NonNullable<Found>;
  assert.match(stated(older).description, /^This computer, whole: your files and apps, /);
});

test("a part that can't be had isn't asked: the line says why, and a value for it is dropped", () => {
  const off = "Screen is turned off in the AgentOrg app. Turn it on there to choose it.";
  const found: Found = {
    ...(NAMED as NonNullable<Found>),
    thisComputer: {
      ready: true,
      capabilities: [
        { capability: "files", ready: true },
        { capability: "screen", ready: false, reason: "It's off." },
      ],
      browsers: [{ kind: "own", ready: true }],
    },
    off: ["screen"],
  };
  assert.equal(
    stated(found).description,
    `Studio Mac, whole: your files and apps and your signed-in browser. It acts as you, with everything you can reach. ${off}`,
  );
  // Never shown, as it shows only after itself; the reason stays on its answer.
  const screen = fieldOf(found, "screen");
  assert.deepEqual(screen?.visible, { field: "screen", in: ["on"] });
  assert.equal(screen?.options?.find((one) => one.value === "on")?.unavailable, off);
  assert.equal(fieldOf(found, "ownBrowser")?.visible, undefined);
  // Only macOS's grants missing, the screen is had: the computer starts without them.
  const ungranted: Found = {
    ...found,
    off: [],
    ungranted: ["accessibility"],
  };
  assert.equal(fieldOf(ungranted, "screen")?.visible, undefined);
  assert.match(stated(ungranted).description, /its screen and your signed-in browser\.[^.]*\.$/);
});

test("where this computer can't be had, the line is why, alone", () => {
  assert.equal(stated(undefined).description, INSTALL_STEPS);
  assert.equal(stated({ made: [], why: "Update it." }).description, "Update it.");
  assert.equal(
    stated({ thisComputer: { ready: false, reason: "Its user can't be found." }, made: [] })
      .description,
    "Its user can't be found.",
  );
  // None runs yet: one is started when a computer is added, and it is stated as this computer.
  assert.match(stated({ made: [], starts: true }).description, /^This computer, whole: /);
});
