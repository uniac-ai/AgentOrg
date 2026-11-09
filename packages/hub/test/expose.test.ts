import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { hubActors, hubBindings, hubGrants } from "@agentorg/interfaces";
import {
  defineInterface,
  describeInterface,
  event,
  method,
  NotConnected,
  Refused,
} from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { z } from "zod";
import {
  exposedName,
  Hub,
  HubState,
  listen,
  PERSON,
  type RequestRecord,
  type StateEvents,
} from "../src/index.ts";

const quests = defineInterface({
  name: "quests",
  major: 1,
  kind: "rpc",
  methods: {
    get: method({ input: z.object({}), output: z.object({ quests: z.array(z.string()) }) }),
  },
  events: { changed: event(z.object({ count: z.number() })) },
});
const described = describeInterface(quests);
const pipe = describeInterface(
  defineInterface({
    name: "pipe",
    major: 1,
    kind: "stream",
    protocol: "bytes",
    open: z.object({}),
  }),
);
const refused = (code: string, text?: RegExp) => (error: unknown) =>
  error instanceof Refused && error.code === code && (!text || text.test(error.message));

function open(t: test.TestContext, events: StateEvents = {}) {
  const home = join(mkdtempSync(join(tmpdir(), "agentorg-expose-")), "home");
  t.after(() => rmSync(dirname(home), { recursive: true, force: true }));
  const state = HubState.open(home, events);
  t.after(() => state.close());
  return state;
}

/** An Actor offering quests@1, an agent to expose it to, and a stranger to neither. */
function cast(state: HubState) {
  const make = (name: string) => state.createActor(PERSON, { name }).actorId;
  const provider = make("Pocket Side Quests");
  const agent = make("Agent");
  const stranger = make("Stranger");
  state.declareExternal(provider, { slots: {}, exports: { quests: described, pipe } });
  for (const id of [agent, stranger]) state.declareExternal(id, { slots: {}, exports: {} });
  return { provider, agent, stranger };
}

test("the default name is the provider's name camelCased and the export's last part, within 48", () => {
  assert.equal(exposedName("Pocket Side Quests", "logic.quests"), "pocketSideQuests_quests");
  assert.equal(exposedName("ChatGPT", "model.model"), "chatgpt_model");
  assert.equal(exposedName("2048 game!", "board"), "game_board");
  assert.equal(exposedName("日本語", "logic.quests"), "quests");
  const long = exposedName("a very long name ".repeat(6), "logic.quests");
  assert.equal(long.length, 48);
  assert.match(long, /^[a-z][A-Za-z0-9_]*$/);
});

test("with both ends, expose makes a slot on the Actor, bound, listed as exposed, and gone with its binding", (t) => {
  const state = open(t);
  const { provider, agent } = cast(state);
  const wiring = { provider, export: "quests", to: agent };
  assert.deepEqual(state.expose(PERSON, wiring), {
    exposed: true,
    slot: "pocketSideQuests_quests",
  });
  assert.deepEqual(state.declaration(agent, "slot", "pocketSideQuests_quests")?.iface, described);
  const [binding] = state.bindings(agent).filter((b) => b.consumer === agent);
  assert.equal(binding?.exposed, true);
  assert.equal(binding?.provider, provider);
  // The same export again gives the same slot back.
  assert.deepEqual(state.expose(PERSON, wiring), {
    exposed: true,
    slot: "pocketSideQuests_quests",
  });
  assert.equal(state.bindings(agent).filter((b) => b.consumer === agent).length, 1);
  // Another name for it is another slot; a taken name is refused.
  assert.deepEqual(state.expose(PERSON, { ...wiring, as: "board" }), {
    exposed: true,
    slot: "board",
  });
  assert.throws(() => state.expose(PERSON, { ...wiring, provider: agent, as: "board" }), Refused);

  state.unexpose(PERSON, agent, "pocketSideQuests_quests");
  assert.equal(state.declaration(agent, "slot", "pocketSideQuests_quests"), undefined);
  assert.equal(state.binding(agent, "pocketSideQuests_quests"), undefined);
  // Unbinding is the same; and only a slot made by expose can be unexposed.
  state.unbind(PERSON, agent, "board");
  assert.equal(state.declaration(agent, "slot", "board"), undefined);
  assert.throws(() => state.unexpose(PERSON, agent, "board"), refused("unknown"));
});

test("an exposed slot goes when its provider withdraws the export or is closed", (t) => {
  const state = open(t);
  const { provider, agent } = cast(state);
  state.offer(provider, "extra", described);
  state.expose(PERSON, { provider, export: "extra", to: agent, as: "extra" });
  state.expose(PERSON, { provider, export: "quests", to: agent });
  state.withdraw(provider, "extra");
  assert.equal(state.declaration(agent, "slot", "extra"), undefined);
  assert.ok(state.declaration(agent, "slot", "pocketSideQuests_quests"));
  state.closeActor(PERSON, provider);
  assert.equal(state.declaration(agent, "slot", "pocketSideQuests_quests"), undefined);
  assert.deepEqual(
    state.bindings(agent).filter((b) => b.consumer === agent),
    [],
  );
});

test("a name already taken on the Actor gets the next suffix", (t) => {
  const state = open(t);
  const { provider, agent } = cast(state);
  state.declareExternal(agent, { slots: { pocketSideQuests_quests: described }, exports: {} });
  const made = state.expose(PERSON, { provider, export: "quests", to: agent });
  assert.deepEqual(made, { exposed: true, slot: "pocketSideQuests_quests_2" });
  assert.throws(
    () =>
      state.expose(PERSON, {
        provider,
        export: "quests",
        to: agent,
        as: "pocketSideQuests_quests",
      }),
    refused("conflict", /as/),
  );
});

test("with one end, expose is a request; the other end approves by exposing the same", (t) => {
  const requested: RequestRecord[] = [];
  const decided: [RequestRecord, string][] = [];
  const state = open(t, {
    requested: (request) => requested.push(request),
    decided: (request, status) => decided.push([request, status]),
  });
  const { provider, agent, stranger } = cast(state);

  // The agent holds its own slot side: it asks the provider's side.
  const asked = state.expose(agent, { provider, export: "quests", to: agent });
  assert.equal(asked.exposed, false);
  assert.equal(asked.slot, "pocketSideQuests_quests");
  assert.ok(!asked.exposed && asked.requestId);
  assert.equal(state.declaration(agent, "slot", asked.slot), undefined);
  const [request] = state.requests(provider);
  assert.equal(request?.exposed, true);
  assert.equal(request?.consumer, agent);
  assert.equal(request?.slot, asked.slot);
  assert.equal(request?.needs, "export");
  assert.deepEqual(state.requests(stranger), []);
  assert.equal(requested[0]?.exposed, true);
  // Asking again is the same request, with the same name.
  const again = state.expose(agent, { provider, export: "quests", to: agent });
  assert.deepEqual(again, asked);

  // The provider approves with the request's own fields.
  assert.deepEqual(
    state.expose(provider, { provider, export: "quests", to: agent, as: asked.slot }),
    { exposed: true, slot: asked.slot },
  );
  assert.equal(state.binding(agent, asked.slot)?.exposed, true);
  assert.deepEqual(
    state.mine(agent).map((r) => [r.exposed, r.status]),
    [[true, "approved"]],
  );
  assert.deepEqual(
    decided.map(([r, status]) => [r.slot, status]),
    [[asked.slot, "approved"]],
  );

  // The provider offering it to the stranger needs the stranger's yes, the same way.
  const offered = state.expose(provider, { provider, export: "quests", to: stranger });
  assert.equal(offered.exposed, false);
  assert.equal(state.requests(stranger)[0]?.needs, "slot");
  assert.equal(
    state.expose(stranger, { provider, export: "quests", to: stranger, as: offered.slot }).exposed,
    true,
  );
});

test("with neither end, expose is refused, naming the Actors and who could", (t) => {
  const state = open(t);
  const { provider, agent, stranger } = cast(state);
  assert.throws(
    () => state.expose(stranger, { provider, export: "quests", to: agent }),
    refused(
      "forbidden",
      /Stranger \(act_[0-9a-f]+\).*Pocket Side Quests \(act_.*Agent \(act_.*Ask one of them/,
    ),
  );
});

test("expose refuses the Hub's own Actors, a missing export, another kind and a bad name", (t) => {
  const state = open(t);
  const { provider, agent } = cast(state);
  assert.throws(
    () => state.expose(PERSON, { provider, export: "quests", to: "hub" }),
    refused("forbidden"),
  );
  assert.throws(
    () => state.expose(PERSON, { provider, export: "nope", to: agent }),
    refused("unknown"),
  );
  assert.throws(
    () => state.expose(PERSON, { provider, export: "pipe", to: agent }),
    refused("unsupported"),
  );
  for (const as of ["Board", "a.b", "x".repeat(49)])
    assert.throws(
      () => state.expose(PERSON, { provider, export: "quests", to: agent, as }),
      refused("invalid"),
    );
});

test("an Actor naming its own slot like an exposed one takes the name: the exposure yields", (t) => {
  const state = open(t);
  const { provider, agent } = cast(state);
  state.expose(PERSON, { provider, export: "quests", to: agent, as: "quests" });
  // A hello that doesn't name it keeps it: it isn't the Actor's to drop.
  state.declareExternal(agent, { slots: {}, exports: {} });
  assert.equal(state.binding(agent, "quests")?.exposed, true);
  // One that names it, as anything, has its own slot; the exposure and its binding go.
  state.declareExternal(agent, { slots: { quests: pipe }, exports: {} });
  assert.equal(state.binding(agent, "quests"), undefined);
  assert.equal(state.declaration(agent, "slot", "quests")?.dynamic, false);
  // A request to expose under a name the Actor then declares closes.
  const asked = state.expose(agent, { provider, export: "quests", to: agent, as: "later" });
  assert.equal(asked.exposed, false);
  state.declareExternal(agent, { slots: { quests: pipe, later: described }, exports: {} });
  assert.deepEqual(
    state.mine(agent).map((r) => [r.slot, r.status]),
    [["later", "closed"]],
  );
});

test("a request reserves no name, settles with the exposure it asked for, and is bounded", (t) => {
  const state = open(t);
  const { provider, agent, stranger } = cast(state);
  state.offer(stranger, "other", described);
  // The stranger asks to expose its export to the agent as "model"; the person exposes the
  // provider's under that name first: it has it, and the stranger's request closes.
  const asked = state.expose(stranger, {
    provider: stranger,
    export: "other",
    to: agent,
    as: "model",
  });
  assert.equal(asked.exposed, false);
  assert.deepEqual(state.expose(PERSON, { provider, export: "quests", to: agent, as: "model" }), {
    exposed: true,
    slot: "model",
  });
  assert.deepEqual(
    state.mine(stranger).map((r) => r.status),
    ["closed"],
  );
  // A request for an export closes when that export is exposed to the Actor under another name.
  const waiting = state.expose(agent, { provider: stranger, export: "other", to: agent });
  assert.equal(waiting.exposed, false);
  state.expose(PERSON, { provider: stranger, export: "other", to: agent, as: "elsewhere" });
  assert.equal(state.mine(agent)[0]?.status, "closed");
  // One Actor's open exposure requests toward another are bounded.
  for (let n = 0; n < 32; n++)
    state.expose(stranger, { provider: stranger, export: "other", to: provider, as: `ask${n}` });
  assert.throws(
    () =>
      state.expose(stranger, { provider: stranger, export: "other", to: provider, as: "one_more" }),
    refused("limit"),
  );
});

test("a caller with neither end learns nothing of what is exposed", (t) => {
  const state = open(t);
  const { provider, agent, stranger } = cast(state);
  state.expose(PERSON, { provider, export: "quests", to: agent });
  assert.throws(
    () => state.expose(stranger, { provider, export: "quests", to: agent }),
    refused("forbidden"),
  );
  assert.throws(
    () => state.expose(stranger, { provider, export: "nope", to: agent }),
    refused("forbidden"),
  );
});

test("a Hub export exposed to the person can be removed again", (t) => {
  const state = open(t);
  const made = state.expose(PERSON, { provider: "hub", export: "audit", to: PERSON });
  assert.equal(made.exposed, true);
  state.unexpose(PERSON, PERSON, made.slot);
  assert.equal(state.binding(PERSON, made.slot), undefined);
  // The person's own hub bindings still stay.
  assert.throws(() => state.unbind(PERSON, PERSON, "audit"), refused("forbidden"));
});

test("only a manager says whom an Actor is made for, and it is recorded, granting nothing", (t) => {
  const state = open(t);
  const { agent, stranger } = cast(state);
  const made = state.createActor(PERSON, { name: "Helper", for: agent });
  assert.equal(state.actor(made.actorId).installedFor, agent);
  assert.equal(state.actor(agent).installedFor, undefined);
  assert.deepEqual(state.bindings(made.actorId), []);
  // The stranger may create Actors, but isn't a manager.
  state.declareExternal(stranger, { slots: { actors: describeInterface(hubActors) }, exports: {} });
  state.bind(PERSON, { consumer: stranger, slot: "actors", provider: "hub", export: "actors" });
  assert.ok(state.createActor(stranger, { name: "Mine" }).actorId);
  assert.throws(
    () => state.createActor(stranger, { name: "Theirs", for: agent }),
    refused("forbidden"),
  );
});

test("an exposed slot reaches a connected Actor as ctx.exposed(), at hello and as it comes and goes", async (t) => {
  const home = join(mkdtempSync(join(tmpdir(), "agentorg-expose-")), "home");
  const hub = Hub.open(home);
  const server = await listen(hub);
  const clients: { close(): void }[] = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await server.close();
    hub.close();
    rmSync(dirname(home), { recursive: true, force: true });
  });
  const person = await connect({
    hubUrl: server.url,
    actorId: PERSON,
    credential: readFileSync(join(home, "person-credential"), "utf8").trim(),
    slots: { actors: hubActors, grants: hubGrants, bindings: hubBindings },
    declare: false,
  });
  clients.push(person);
  const make = async (name: string) => {
    const made = await person.slots.actors.call.create({ name });
    return { actorId: made.actorId, credential: made.credential ?? "" };
  };
  const p = await make("Pocket Side Quests");
  const a = await make("Agent");
  const provider = await connect({ hubUrl: server.url, ...p, exports: { quests } });
  clients.push(provider);
  provider.exports.quests.implement({ get: async () => ({ quests: ["walk"] }) });

  // Exposed before the agent connects: a notice follows its hello.
  const first = await person.slots.grants.call.expose({
    provider: p.actorId,
    export: "quests",
    to: a.actorId,
  });
  assert.deepEqual(first, { exposed: true, slot: "pocketSideQuests_quests" });
  const agent = await connect({ hubUrl: server.url, ...a });
  clients.push(agent);
  let changes = 0;
  agent.onExposed(() => changes++);
  const names = () => agent.exposed().map((slot) => slot.slot);
  for (let i = 0; i < 300 && names().length < 1; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(names(), ["pocketSideQuests_quests"]);
  changes = 0;
  const [slot] = agent.exposed();
  assert.deepEqual(slot?.provider, { actor: p.actorId, export: "quests" });
  assert.deepEqual(slot?.described, described);
  assert.deepEqual(await slot?.call.get?.({}), { quests: ["walk"] });

  // Made and removed while connected: notices.
  await person.slots.grants.call.expose({
    provider: p.actorId,
    export: "quests",
    to: a.actorId,
    as: "more",
  });
  for (let i = 0; i < 300 && names().length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(names(), ["pocketSideQuests_quests", "more"]);
  await person.slots.grants.call.unexpose({ to: a.actorId, slot: "pocketSideQuests_quests" });
  for (let i = 0; i < 300 && names().length > 1; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(names(), ["more"]);
  assert.equal(changes, 2);
  await assert.rejects(slot?.call.get?.({}) ?? Promise.resolve(), NotConnected);

  // hub.bindings says which are exposed; hub.actors says whom an Actor was made for.
  const { bindings } = await person.slots.bindings.call.list({ actor: a.actorId });
  assert.deepEqual(
    bindings.filter((b) => b.consumer === a.actorId).map((b) => [b.slot, b.exposed]),
    [["more", true]],
  );
  const helper = await person.slots.actors.call.create({ name: "Helper", for: a.actorId });
  assert.equal(
    (await person.slots.actors.call.get({ actorId: helper.actorId })).installedFor,
    a.actorId,
  );
});
