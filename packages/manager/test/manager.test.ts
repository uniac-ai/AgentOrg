import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hub, listen, PERSON } from "@agentorg/hub";
import {
  agentProvider,
  agentSettings,
  agents,
  chat,
  connections,
  hubActors,
  hubBindings,
  hubGrants,
  mcpProvider,
  skills,
  tools,
} from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { startManager } from "../src/index.ts";

const until = async (condition: () => boolean, ms = 15_000) => {
  for (let waited = 0; !condition(); waited += 10) {
    if (waited > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const refused = (code: string) => (error: unknown) =>
  error instanceof Refused && error.code === code;
const SKILL = (name: string, text = "Use it well.") =>
  `---\nname: ${name}\ndescription: The ${name} skill.\n---\n${text}\n`;

const CREATABLES = [
  {
    id: "plain",
    title: "Plain",
    description: "No needs.",
    instructions: "Be plain.",
    asks: [],
    skills: [],
    mcp: [],
  },
  {
    id: "full",
    title: "Full",
    description: "Every kind of need.",
    instructions: "Be full.",
    asks: [{ id: "folder", title: "Folder" }],
    skills: [{ name: "notes", files: ["SKILL.md", "more/guide.md"] }],
    mcp: [
      {
        how: "create" as const,
        slot: "files",
        title: "Files",
        kind: "stand-in",
        params: { fixed: "yes" },
        fromAnswers: { cwd: "folder" },
      },
      { how: "pick" as const, slot: "search", title: "Search" },
    ],
  },
];

/** A real Hub, management on it, one who calls it, and stand-in providers that can fail on cue. */
async function setup(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-manager-")));
  const home = join(root, "home");
  const dir = join(root, "manager");
  const hub = Hub.open(home);
  const server = await listen(hub);
  const leaving: (() => void | Promise<void>)[] = [];
  t.after(async () => {
    for (const leave of leaving.reverse()) await leave();
    await server.close();
    hub.close();
    rmSync(root, { recursive: true, force: true });
  });
  const person = await connect({
    hubUrl: server.url,
    actorId: PERSON,
    credential: readFileSync(join(home, "person-credential"), "utf8").trim(),
    slots: { actors: hubActors, grants: hubGrants, bindings: hubBindings },
    declare: false,
  });
  leaving.push(() => person.close());

  const management = hub.state.createActor(PERSON, {
    name: "Management",
    bindings: ["actors", "grants", "bindings"].map((slot) => ({
      slot,
      provider: "hub",
      export: slot,
    })),
  });
  const manager = await startManager({
    hubUrl: server.url,
    actorId: management.actorId,
    credential: management.credential as string,
    dir,
  });
  leaving.push(() => manager.close());

  /** What the stand-ins should do wrong, and what they were given. */
  const script: {
    fail?: string;
    alsoFail?: string;
    settings?: string;
    chat?: string;
    noTools?: boolean;
    skillName?: string;
    /** Run while a connection is being made, in the middle of a creation. */
    during?: () => Promise<void>;
  } = {};
  const given: { secrets: unknown[]; params: unknown[]; removed: string[] } = {
    secrets: [],
    params: [],
    removed: [],
  };
  const failing = (step: string) => {
    if (script.fail === step || script.alsoFail === step)
      throw new Refused("failed", `${step} failed on cue.`);
  };
  const running = new Map<string, { close(): void; slots: never; on?: never }>();
  const heard = new Map<string, number>();

  // A stand-in agent provider: each agent is an Actor on its own channel, as the bundled one's are.
  const agentActor = hub.state.createActor(PERSON, {
    name: "Agents",
    bindings: [{ slot: "actors", provider: "hub", export: "actors" }],
  });
  const stopped = new Set<string>();
  const agentsProvider = await connect({
    hubUrl: server.url,
    actorId: agentActor.actorId,
    credential: agentActor.credential as string,
    slots: { actors: hubActors },
    exports: { provider: agentProvider },
    start(ctx) {
      ctx.exports.provider.implement({
        creatable: () => ({ creatables: CREATABLES }),
        skill: ({ path }) => {
          failing("skill");
          return { text: path === "SKILL.md" ? SKILL(script.skillName ?? "notes") : "A guide." };
        },
        async create({ name }) {
          failing("agent");
          const { actorId, credential } = await ctx.slots.actors.call.create({ name });
          const client = await connect({
            hubUrl: server.url,
            actorId,
            credential: credential as string,
            slots: { settings: agentSettings },
            exports: { chat },
            start(own) {
              own.slots.settings.on("changed", () => {
                heard.set(actorId, (heard.get(actorId) ?? 0) + 1);
              });
            },
          });
          running.set(actorId, client as never);
          leaving.push(() => client.close());
          return {
            agent: actorId,
            settings: script.settings ?? "settings",
            chat: script.chat ?? "chat",
          };
        },
        status: ({ agent }) => {
          failing("agent.status");
          return { state: stopped.has(agent) ? ("stopped" as const) : ("running" as const) };
        },
        start: ({ agent }) => {
          stopped.delete(agent);
          return {};
        },
        stop: ({ agent }) => {
          stopped.add(agent);
          return {};
        },
        async remove({ agent }) {
          failing("agent.remove");
          given.removed.push(agent);
          running.get(agent)?.close();
          running.delete(agent);
          await ctx.slots.actors.call.close({ actorId: agent });
          return {};
        },
      });
    },
  });
  leaving.push(() => agentsProvider.close());

  // A stand-in MCP provider: each connection is an Actor offering tools.
  const mcpActor = hub.state.createActor(PERSON, {
    name: "MCP",
    bindings: [{ slot: "actors", provider: "hub", export: "actors" }],
  });
  const mcpClient = await connect({
    hubUrl: server.url,
    actorId: mcpActor.actorId,
    credential: mcpActor.credential as string,
    slots: { actors: hubActors },
    exports: { provider: mcpProvider },
    start(ctx) {
      const held = new Map<string, { close(): void }>();
      ctx.exports.provider.implement({
        kinds: () => ({
          kinds: [{ kind: "stand-in", title: "Stand-in", params: {}, secrets: {} }],
        }),
        async create({ params, secrets, name }) {
          await script.during?.();
          failing("connection");
          given.params.push(params);
          given.secrets.push(secrets);
          const { actorId, credential } = await ctx.slots.actors.call.create({ name });
          const client = await connect({
            hubUrl: server.url,
            actorId,
            credential: credential as string,
            exports: script.noTools ? {} : { tools },
          });
          held.set(actorId, client);
          leaving.push(() => client.close());
          return { connection: actorId, target: "a stand-in server" };
        },
        status: ({ connection }) => {
          if (!held.has(connection)) throw new Refused("unknown", "Not held.");
          return { state: "connected" as const, tools: [{ name: "read" }] };
        },
        async remove({ connection }) {
          if (!held.has(connection)) throw new Refused("unknown", "Not held.");
          given.removed.push(connection);
          held.get(connection)?.close();
          held.delete(connection);
          await ctx.slots.actors.call.close({ actorId: connection });
          return {};
        },
      });
    },
  });
  leaving.push(() => mcpClient.close());

  // A provider is connected by exposing its export to management; nothing else says so.
  for (const actor of [agentActor.actorId, mcpActor.actorId])
    await person.slots.grants.call.expose({
      provider: actor,
      export: "provider",
      to: management.actorId,
    });

  const callerActor = hub.state.createActor(PERSON, {
    name: "Caller",
    bindings: ["agents", "connections", "skills"].map((slot) => ({
      slot,
      provider: management.actorId,
      export: slot,
    })),
  });
  const caller = await connect({
    hubUrl: server.url,
    actorId: callerActor.actorId,
    credential: callerActor.credential as string,
    slots: { agents, connections, skills },
  });
  leaving.push(() => caller.close());
  await until(
    () => caller.slots.agents.bound && caller.slots.connections.bound && caller.slots.skills.bound,
  );
  for (let i = 0; (await caller.slots.agents.call.providers({})).providers.length < 1; i++) {
    assert.ok(i < 300, "the provider never showed");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const openActors = async () =>
    (await person.slots.actors.call.list({})).actors
      .filter((a) => a.state !== "closed")
      .map((a) => a.actorId)
      .sort();
  const bindingsOf = async (actor: string) =>
    (await person.slots.bindings.call.list({ actor })).bindings;
  /** A connection the person made, to pick. */
  const picked = async () =>
    (
      await caller.slots.connections.call.create({
        provider: mcpActor.actorId,
        kind: "stand-in",
        params: {},
        name: "Search",
      })
    ).connection;
  /** The agent's own channel, to read its settings as it would. */
  const agentChannel = (agent: string) =>
    running.get(agent) as unknown as {
      slots: {
        settings: {
          bound: boolean;
          call: {
            get(input: object): Promise<{ instructions: string; skills: { name: string }[] }>;
            skill(input: { name: string; path?: string }): Promise<{ text: string }>;
          };
        };
      };
    };
  const makeFull = async (connection: string, name = "Fay") =>
    (
      await caller.slots.agents.call.create({
        provider: agentActor.actorId,
        creatable: "full",
        name,
        answers: { folder: "/work" },
        connections: { search: connection },
      })
    ).agent;
  return {
    hub,
    person,
    dir,
    script,
    given,
    heard,
    agentActor,
    mcpActor,
    management,
    calls: {
      agents: caller.slots.agents.call,
      connections: caller.slots.connections.call,
      skills: caller.slots.skills.call,
    },
    openActors,
    bindingsOf,
    picked,
    agentChannel,
    makeFull,
    callerActor,
  };
}

test("a provider counts once it has exposed its export to management", async (t) => {
  const s = await setup(t);
  const { providers } = await s.calls.agents.providers({});
  assert.deepEqual(providers, [{ provider: s.agentActor.actorId, name: "Agents" }]);
  const { creatables } = await s.calls.agents.creatable({});
  assert.deepEqual(
    creatables.map((c) => [c.id, c.provider]),
    [
      ["plain", s.agentActor.actorId],
      ["full", s.agentActor.actorId],
    ],
  );
  const mcp = await s.calls.connections.providers({});
  assert.deepEqual(
    mcp.providers.map((p) => [p.provider, p.name, p.kinds.map((k) => k.kind)]),
    [[s.mcpActor.actorId, "MCP", ["stand-in"]]],
  );
  // Un-exposed, it is gone: the Hub's binding was the only record.
  const { bindings } = await s.person.slots.bindings.call.list({ actor: s.management.actorId });
  const slot = bindings.find((b) => b.provider === s.agentActor.actorId)?.slot as string;
  await s.person.slots.grants.call.unexpose({ to: s.management.actorId, slot });
  for (let i = 0; (await s.calls.agents.providers({})).providers.length > 0; i++) {
    assert.ok(i < 300);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});

test("creating with a create need and a pick: bound, exposed, recorded, chat to the person", async (t) => {
  const s = await setup(t);
  const search = await s.picked();
  const agent = await s.makeFull(search);
  assert.deepEqual(s.given.params.at(-1), { fixed: "yes", cwd: "/work" }, "fromAnswers");

  const read = await s.calls.agents.get({ agent });
  assert.equal(read.name, "Fay");
  assert.equal(read.provider, s.agentActor.actorId);
  assert.equal(read.creatable, "full");
  assert.equal(read.instructions, "Be full.");
  assert.deepEqual(read.status, { state: "running" });
  assert.deepEqual(read.skills, [{ name: "notes", description: "The notes skill." }]);
  const bySlot = Object.fromEntries(read.mcp.map((m) => [m.slot, m]));
  assert.equal(bySlot.search?.connection, search);
  assert.equal(bySlot.search?.origin?.madeFor, undefined, "picked, so it isn't the agent's");
  assert.equal(bySlot.files?.origin?.madeFor, agent);
  assert.equal(bySlot.files?.origin?.madeBy, s.callerActor.actorId);
  assert.equal(bySlot.files?.origin?.target, "a stand-in server");
  assert.deepEqual(bySlot.files?.status, { state: "connected", tools: [{ name: "read" }] });

  assert.ok((await s.bindingsOf(PERSON)).some((b) => b.provider === agent && b.export === "chat"));
  const held = await s.bindingsOf(agent);
  assert.ok(held.some((b) => b.slot === "settings" && b.provider === s.management.actorId));

  // The record is what only management knows: no status, no exposure of a connection.
  const kept = JSON.parse(readFileSync(join(s.dir, "manager.json"), "utf8"));
  assert.deepEqual(kept.agents[agent], {
    provider: s.agentActor.actorId,
    creatable: "full",
    instructions: "Be full.",
    skills: ["notes"],
  });
  assert.deepEqual(readdirSync(join(s.dir, "skills", "notes")).sort(), ["SKILL.md", "more"]);
  assert.equal(statSync(s.dir).mode & 0o777, 0o700);

  await s.calls.agents.stop({ agent });
  assert.deepEqual((await s.calls.agents.list({})).agents[0]?.status, { state: "stopped" });
  await s.calls.agents.start({ agent });
  assert.deepEqual((await s.calls.agents.list({})).agents[0]?.status, { state: "running" });
  // A provider that can't answer shows its agent as down; nothing was stored to go stale.
  s.script.fail = "agent.status";
  assert.equal((await s.calls.agents.list({})).agents[0]?.status.state, "down");
});

const FAILURES: [string, (s: Awaited<ReturnType<typeof setup>>) => void][] = [
  ["the provider making the agent", (s) => (s.script.fail = "agent")],
  ["binding its settings", (s) => (s.script.settings = "nothing")],
  ["reading a skill's file", (s) => (s.script.fail = "skill")],
  ["making the connection", (s) => (s.script.fail = "connection")],
  ["exposing a connection", (s) => (s.script.noTools = true)],
  ["exposing its chat", (s) => (s.script.chat = "nothing")],
];
for (const [step, arrange] of FAILURES)
  test(`a failure at ${step} leaves nothing behind`, async (t) => {
    const s = await setup(t);
    const search = await s.picked();
    const actors = await s.openActors();
    const records = readFileSync(join(s.dir, "manager.json"), "utf8");
    arrange(s);
    await assert.rejects(s.makeFull(search));
    assert.deepEqual(await s.openActors(), actors, "every Actor it made is closed");
    assert.deepEqual((await s.calls.agents.list({})).agents, []);
    assert.deepEqual(
      (await s.calls.connections.list({})).connections.map((c) => c.connection),
      [search],
    );
    assert.deepEqual((await s.calls.skills.list({})).skills, []);
    assert.equal(readFileSync(join(s.dir, "manager.json"), "utf8"), records);
    assert.deepEqual(readdirSync(join(s.dir, "skills")), [], "no skill, no scrap of one");
    assert.ok(!(await s.bindingsOf(PERSON)).some((b) => b.export === "chat"));
  });

test("mid-creation the agent can't be seen or saved, and its settings are already bound", async (t) => {
  const s = await setup(t);
  await s.calls.skills.add({ files: { "SKILL.md": SKILL("other") } });
  const { agent: bystander } = await s.calls.agents.create({
    provider: s.agentActor.actorId,
    creatable: "plain",
    name: "Bystander",
    answers: {},
  });
  const search = await s.picked();
  let listed: string[] | undefined;
  let settingsBound = false;
  s.script.during = async () => {
    delete s.script.during;
    listed = (await s.calls.agents.list({})).agents.map((a) => a.agent);
    // Something else that saves, while the creation is under way.
    await s.calls.agents.expose({ agent: bystander, skill: "other" });
    const making = (await s.openActors()).filter((a) => a !== bystander);
    for (const actor of making)
      if ((await s.bindingsOf(actor)).some((b) => b.consumer === actor && b.slot === "settings"))
        settingsBound = true;
  };
  s.script.fail = "connection";
  await assert.rejects(s.makeFull(search));
  assert.deepEqual(listed, [bystander]);
  assert.equal(settingsBound, true);
  const kept = JSON.parse(readFileSync(join(s.dir, "manager.json"), "utf8"));
  assert.deepEqual(Object.keys(kept.agents), [bystander]);
});

test("undoing closes the agent even when its provider won't remove it", async (t) => {
  const s = await setup(t);
  const search = await s.picked();
  const actors = await s.openActors();
  s.script.fail = "connection";
  s.script.alsoFail = "agent.remove";
  await assert.rejects(s.makeFull(search));
  assert.deepEqual(await s.openActors(), actors);
});

test("a skill that calls itself something else is refused before the one of that name is touched", async (t) => {
  const s = await setup(t);
  await s.calls.skills.add({ files: { "SKILL.md": SKILL("precious", "Keep me.") } });
  const search = await s.picked();
  s.script.skillName = "precious";
  await assert.rejects(s.makeFull(search), refused("invalid"));
  assert.match((await s.calls.skills.get({ name: "precious" })).text, /Keep me/);
});

test("a skill an undone creation added stays if another agent was given it meanwhile", async (t) => {
  const s = await setup(t);
  const { agent: other } = await s.calls.agents.create({
    provider: s.agentActor.actorId,
    creatable: "plain",
    name: "Other",
    answers: {},
  });
  const search = await s.picked();
  s.script.during = async () => {
    delete s.script.during;
    await s.calls.agents.expose({ agent: other, skill: "notes" });
  };
  s.script.fail = "connection";
  await assert.rejects(s.makeFull(search));
  assert.deepEqual((await s.calls.skills.get({ name: "notes" })).agents, [other]);
});

test("a connection or agent whose provider has gone can still be removed", async (t) => {
  const s = await setup(t);
  const connection = await s.picked();
  const agent = await s.makeFull(connection);
  for (const provider of [s.mcpActor.actorId, s.agentActor.actorId]) {
    const { bindings } = await s.person.slots.bindings.call.list({ actor: s.management.actorId });
    const slot = bindings.find((b) => b.provider === provider)?.slot as string;
    await s.person.slots.grants.call.unexpose({ to: s.management.actorId, slot });
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  await s.calls.agents.remove({ agent });
  await s.calls.connections.remove({ connection });
  const open = await s.openActors();
  assert.ok(!open.includes(agent) && !open.includes(connection));
  assert.deepEqual((await s.calls.connections.list({})).connections, []);
});

test("a pick that names no connection refuses before anything is made", async (t) => {
  const s = await setup(t);
  const actors = await s.openActors();
  await assert.rejects(
    s.calls.agents.create({
      provider: s.agentActor.actorId,
      creatable: "full",
      name: "Fay",
      answers: { folder: "/work" },
    }),
    refused("invalid"),
  );
  await assert.rejects(s.makeFull("act_nothing"));
  assert.deepEqual(await s.openActors(), actors);
  await assert.rejects(
    s.calls.agents.create({
      provider: s.agentActor.actorId,
      creatable: "nothing",
      name: "X",
      answers: {},
    }),
    refused("unknown"),
  );
  await assert.rejects(
    s.calls.agents.create({ provider: "act_x", creatable: "plain", name: "X", answers: {} }),
    refused("unknown"),
  );
});

test("a creatable's skill whose name is here keeps the one here, and survives a failure", async (t) => {
  const s = await setup(t);
  await s.calls.skills.add({ files: { "SKILL.md": SKILL("notes", "The person's own.") } });
  const search = await s.picked();
  s.script.fail = "connection";
  await assert.rejects(s.makeFull(search));
  assert.match((await s.calls.skills.get({ name: "notes" })).text, /person's own/);
  delete s.script.fail;
  const agent = await s.makeFull(search);
  assert.match((await s.calls.skills.get({ name: "notes" })).text, /person's own/);
  assert.deepEqual((await s.calls.skills.get({ name: "notes" })).agents, [agent]);
});

test("an agent sees only its own settings, and only it hears that they changed", async (t) => {
  const s = await setup(t);
  const make = async (name: string) =>
    (
      await s.calls.agents.create({
        provider: s.agentActor.actorId,
        creatable: "plain",
        name,
        answers: {},
      })
    ).agent;
  const [a, b] = [await make("A"), await make("B")];
  const [one, other] = [s.agentChannel(a), s.agentChannel(b)];
  await until(() => one.slots.settings.bound && other.slots.settings.bound);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await s.calls.skills.add({
    files: { "SKILL.md": SKILL("secret-sauce"), "more/deep.md": "Deep." },
  });
  await s.calls.agents.expose({ agent: a, skill: "secret-sauce" });
  await until(() => (s.heard.get(a) ?? 0) === 1);
  assert.equal(s.heard.get(b) ?? 0, 0);

  assert.deepEqual(await one.slots.settings.call.get({}), {
    instructions: "Be plain.",
    skills: [{ name: "secret-sauce", description: "The secret-sauce skill." }],
  });
  assert.deepEqual((await other.slots.settings.call.get({})).skills, []);
  assert.match((await one.slots.settings.call.skill({ name: "secret-sauce" })).text, /Use it well/);
  assert.equal(
    (await one.slots.settings.call.skill({ name: "secret-sauce", path: "more/deep.md" })).text,
    "Deep.",
  );
  await assert.rejects(
    other.slots.settings.call.skill({ name: "secret-sauce" }),
    refused("unknown"),
  );
  await assert.rejects(
    one.slots.settings.call.skill({ name: "secret-sauce", path: "nothing.md" }),
    refused("unknown"),
  );
  // Replacing it tells those who have it; removing it takes it off them.
  await s.calls.skills.add({ files: { "SKILL.md": SKILL("secret-sauce", "Better.") } });
  await until(() => (s.heard.get(a) ?? 0) === 2);
  assert.match((await one.slots.settings.call.skill({ name: "secret-sauce" })).text, /Better/);
  await s.calls.skills.remove({ name: "secret-sauce" });
  await until(() => (s.heard.get(a) ?? 0) === 3);
  assert.deepEqual((await one.slots.settings.call.get({})).skills, []);
  assert.equal(s.heard.get(b) ?? 0, 0);
});

test("removing an agent takes the connections made for it, and leaves those it was given", async (t) => {
  const s = await setup(t);
  const search = await s.picked();
  const agent = await s.makeFull(search);
  const made = (await s.calls.agents.get({ agent })).mcp.find((m) => m.slot === "files")
    ?.connection as string;
  await s.calls.agents.remove({ agent });
  assert.deepEqual(s.given.removed, [made, agent]);
  const open = await s.openActors();
  assert.ok(!open.includes(agent) && !open.includes(made) && open.includes(search));
  assert.deepEqual((await s.calls.agents.list({})).agents, []);
  assert.deepEqual(
    (await s.calls.connections.list({})).connections.map((c) => c.connection),
    [search],
  );
  await assert.rejects(s.calls.agents.get({ agent }), refused("unknown"));
  assert.ok(!(await s.bindingsOf(PERSON)).some((b) => b.provider === agent));
});

test("exposing a connection is a Hub binding and nothing else; removing one takes its exposures", async (t) => {
  const s = await setup(t);
  const { agent } = await s.calls.agents.create({
    provider: s.agentActor.actorId,
    creatable: "plain",
    name: "Pat",
    answers: {},
  });
  const connection = await s.picked();
  const before = readFileSync(join(s.dir, "manager.json"), "utf8");
  const { slot } = await s.calls.agents.expose({ agent, connection, as: "search" });
  assert.equal(slot, "search");
  assert.equal(readFileSync(join(s.dir, "manager.json"), "utf8"), before);
  assert.ok((await s.bindingsOf(agent)).some((b) => b.slot === "search" && b.exposed));
  assert.equal((await s.calls.agents.get({ agent })).mcp[0]?.connection, connection);
  await s.calls.agents.unexpose({ agent, slot: "search" });
  assert.deepEqual((await s.calls.agents.get({ agent })).mcp, []);

  await s.calls.agents.expose({ agent, connection, as: "search" });
  await s.calls.connections.remove({ connection });
  assert.deepEqual((await s.calls.agents.get({ agent })).mcp, []);
  await assert.rejects(s.calls.connections.get({ connection }), refused("unknown"));
  await assert.rejects(s.calls.agents.expose({ agent, skill: "nothing" }), refused("unknown"));
});

test("secrets pass through to the provider, and management keeps none", async (t) => {
  const s = await setup(t);
  const secret = `secret-${crypto.randomUUID()}`;
  const { connection } = await s.calls.connections.create({
    provider: s.mcpActor.actorId,
    kind: "stand-in",
    params: { url: "x" },
    secrets: { token: secret },
    name: "With a secret",
  });
  assert.deepEqual(s.given.secrets.at(-1), { token: secret });
  const read = await s.calls.connections.get({ connection });
  assert.equal(read.origin?.kind, "stand-in");
  const everything = [
    readFileSync(join(s.dir, "manager.json"), "utf8"),
    JSON.stringify(read),
    JSON.stringify(s.hub.state.audit(0, 100_000)),
  ].join("\n");
  assert.ok(!everything.includes(secret));
});

test("a skill comes from a folder or as files, with its name from its front matter", async (t) => {
  const s = await setup(t);
  const folder = join(s.dir, "..", "a-skill");
  mkdirSync(join(folder, "refs"), { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), SKILL("from-folder"));
  writeFileSync(join(folder, "refs", "a.md"), "A.");
  writeFileSync(join(folder, ".DS_Store"), Buffer.from([0xff, 0xfe, 0x00]));
  assert.deepEqual(await s.calls.skills.add({ path: folder }), {
    name: "from-folder",
    description: "The from-folder skill.",
  });
  const read = await s.calls.skills.get({ name: "from-folder" });
  assert.deepEqual(read.files, ["SKILL.md", "refs/a.md"]);
  assert.deepEqual(read.agents, []);
  assert.deepEqual(
    (await s.calls.skills.list({})).skills.map((one) => one.name),
    ["from-folder"],
  );
  await assert.rejects(s.calls.skills.add({ files: { "x.md": "x" } }), refused("invalid"));
  await assert.rejects(
    s.calls.skills.add({ files: { "SKILL.md": "No front matter." } }),
    refused("invalid"),
  );
  await assert.rejects(
    s.calls.skills.add({ files: { "SKILL.md": "---\nname: Not Valid\ndescription: x\n---\n" } }),
    refused("invalid"),
  );
  await assert.rejects(s.calls.skills.add({ path: join(folder, "nothing") }), refused("invalid"));
  // A link could reach outside the folder, so a folder holding one isn't taken.
  symlinkSync("/etc/hosts", join(folder, "refs", "hosts"));
  await assert.rejects(s.calls.skills.add({ path: folder }), refused("invalid"));
  writeFileSync(join(folder, "refs", "hosts2"), Buffer.from([0xff, 0xfe, 0x00]));
  rmSync(join(folder, "refs", "hosts"));
  await assert.rejects(s.calls.skills.add({ path: folder }), refused("invalid"));
  await s.calls.skills.remove({ name: "from-folder" });
  await assert.rejects(s.calls.skills.get({ name: "from-folder" }), refused("unknown"));
  await assert.rejects(s.calls.skills.remove({ name: "from-folder" }), refused("unknown"));
});
