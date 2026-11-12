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
  capability,
  chat,
  connections,
  hubActors,
  hubBindings,
  hubGrants,
  skills,
  tools,
  unitProvider,
} from "@agentorg/interfaces";
import { defineInterface, type Interface, method, Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { z } from "zod";
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

const MODELS = [
  { id: "small", name: "Small" },
  { id: "large", name: "Large" },
];
const CREATABLES = [
  { id: "plain", title: "Plain", description: "No needs.", instructions: "Be plain.", asks: [] },
  {
    id: "asking",
    title: "Asking",
    description: "Asks one thing.",
    instructions: "Be asked.",
    asks: [{ id: "folder", title: "Folder" }],
  },
];

const NONE = { slots: [], skills: [] };
/** The stand-in provider's units: one with a form, one giving a result, one needing it. */
const UNITS = [
  {
    id: "files",
    title: "Files",
    description: "A folder.",
    form: [
      {
        id: "folder",
        authority: "setting",
        type: "directory",
        value: "string",
        title: "Folder",
        required: true,
      },
      { id: "token", type: "secret", value: "secret", title: "Token" },
      {
        id: "extra",
        authority: "setting",
        type: "toggle",
        value: "boolean",
        title: "Extra",
        adds: { slots: [{ name: "extra" }], skills: [] },
      },
    ],
    needs: [],
    gives: {
      slots: [{ name: "files" }],
      skills: [{ name: "notes", files: ["SKILL.md", "more/guide.md"] }],
      results: [],
    },
  },
  {
    id: "stand-in",
    title: "Stand-in",
    description: "Makes one connection, and is a kind of connection for that.",
    form: [
      { id: "url", type: "text", value: "string", title: "Address" },
      { id: "token", type: "secret", value: "secret", title: "Token" },
      { id: "slot", type: "text", value: "string", title: "Name", required: true },
    ],
    needs: [],
    gives: { slots: [{ field: "slot" }], skills: [], results: [] },
  },
  {
    id: "machine",
    title: "Machine",
    description: "Somewhere to work.",
    form: [],
    needs: [],
    gives: { ...NONE, results: ["computer"] },
  },
  {
    id: "desk",
    title: "Desk",
    description: "A desk the agent holds, with a side for the person.",
    capability: { id: "desk", title: "Desk" },
    form: [
      {
        id: "lamp",
        type: "toggle",
        value: "boolean",
        title: "Lamp",
        authority: "setting",
        adds: {
          slots: [],
          skills: [],
          surfaces: [{ surface: "lamp", protocol: "stand-in@1" }],
          views: [{ id: "glow", place: "column", kind: "meters", surface: "lamp" }],
        },
      },
    ],
    needs: [],
    gives: {
      slots: [{ name: "desk" }],
      skills: [],
      results: [],
      surfaces: [{ surface: "top", protocol: "stand-in@1" }],
      views: [
        { id: "where", place: "column", kind: "facts" },
        {
          id: "about",
          place: "column",
          kind: "facts",
          operation: "about",
          slot: "desk",
          rows: ["Wood"],
        },
        {
          id: "status",
          place: "frame",
          kind: "status",
          when: "reachable",
          operation: "status",
          slot: "desk",
        },
      ],
    },
  },
  {
    id: "askew",
    title: "Askew",
    description: "A unit whose views show what it doesn't give.",
    capability: { id: "askew", title: "Askew" },
    form: [],
    needs: [],
    gives: {
      slots: [{ name: "askew" }],
      skills: [],
      results: [],
      surfaces: [{ surface: "top", protocol: "stand-in@1" }],
      views: [
        { id: "glow", place: "column", kind: "meters", surface: "lamp" },
        { id: "about", place: "column", kind: "facts", operation: "about", slot: "elsewhere" },
      ],
    },
  },
  {
    id: "terminal",
    title: "Terminal",
    description: "A terminal on the computer.",
    form: [],
    needs: ["computer"],
    gives: { slots: [{ name: "terminal" }], skills: [], results: [] },
  },
  {
    id: "computer",
    title: "Computer",
    description: "A computer to share.",
    form: [
      { id: "service", type: "text", value: "string", title: "Service" },
      {
        id: "access",
        authority: "setting",
        type: "choice",
        value: "string",
        title: "Access",
        required: true,
        options: ["none", "read", "files", "terminal"].map((value) => ({ value, title: value })),
      },
      {
        id: "browser",
        authority: "setting",
        type: "toggle",
        value: "boolean",
        title: "Browser",
        adds: { slots: [{ name: "browser" }], skills: [] },
      },
    ],
    needs: [],
    gives: {
      slots: [{ name: "computer" }],
      skills: [{ name: "using-it", files: ["SKILL.md"] }],
      results: [],
    },
  },
  {
    id: "url",
    title: "A server at an address",
    description: "A kind, as the built-in provider has.",
    form: [
      { id: "url", authority: "contacts", type: "text", value: "string", title: "Address" },
      { id: "public", type: "toggle", value: "boolean", title: "Public addresses only" },
      { id: "slot", type: "text", value: "string", title: "Name", required: true },
    ],
    needs: [],
    gives: { slots: [{ field: "slot" }], skills: [], results: [] },
  },
  {
    id: "runner",
    title: "Runner",
    description: "Runs a program.",
    form: [{ id: "program", authority: "runs", type: "text", value: "string", title: "Program" }],
    needs: [],
    gives: { slots: [], skills: [], results: [] },
  },
  {
    id: "closed",
    title: "Closed",
    description: "Declares nothing, so an agent may set nothing of it.",
    form: [{ id: "mode", type: "text", value: "string", title: "Mode" }],
    needs: [],
    gives: { slots: [], skills: [], results: [] },
  },
  {
    id: "vault",
    title: "Vault",
    description: "Needs a secret no agent can give.",
    form: [{ id: "key", type: "secret", value: "secret", title: "Key", required: true }],
    needs: [],
    gives: { slots: [{ name: "vault" }], skills: [], results: [] },
  },
] as const;

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
  const startManagement = () =>
    startManager({
      hubUrl: server.url,
      actorId: management.actorId,
      credential: management.credential as string,
      dir,
    });
  let manager = await startManagement();
  leaving.push(() => manager.close());

  /** What the stand-ins should do wrong, and what they were given. */
  const script: {
    fail?: string;
    alsoFail?: string;
    settings?: string;
    chat?: string;
    /** Chats whose turn failed, by id. */
    failed?: string[];
    /** Whether an agent says it is working. */
    working?: boolean;
    noTools?: boolean;
    skillName?: string;
    /** The slot a unit says it made, instead of the one it declared. */
    wrongSlot?: string;
    /** A unit that gives no result, though it said it would. */
    noResults?: boolean;
    /** Problems the unit's own check finds. */
    problems?: { field?: string; message: string }[];
    /** Run while a unit is being applied, in the middle of a creation. */
    during?: () => Promise<void>;
    /** A unit that builds no capability, though it said it would. */
    noCapability?: boolean;
    /** The fixed rows a unit gives, by view, instead of those it declared. */
    rows?: Record<string, { label: string; value: string }[]>;
  } = {};
  const given: {
    secrets: unknown[];
    removed: string[];
    applied: { unit: string; values: object; secrets: object; needs: object; agent: string }[];
    checked: { unit: string; values: object; secrets: string[] }[];
  } = {
    secrets: [],
    removed: [],
    applied: [],
    checked: [],
  };
  const failing = (step: string) => {
    if (script.fail === step || script.alsoFail === step)
      throw new Refused("failed", `${step} failed on cue.`);
  };
  const running = new Map<string, { close(): void; slots: never; on?: never }>();
  const credentials = new Map<string, string>();
  const heard = new Map<string, number>();
  /** Every message sent to each agent, in the order they came, whichever chat it was in. */
  const chats = new Map<string, { text: string }[]>();
  /** Each agent's chats by id, the newest last: its title, when it started and where it is. */
  type Started = Map<string, { title: string; at: string; archived: boolean }>;
  const startedIn = new Map<string, Started>();
  /** Each agent's own side, to reach what is exposed to it as it would. */
  const contexts = new Map<
    string,
    { exposed(): { slot: string; provider: { actor: string }; call: unknown }[] }
  >();

  // A stand-in agent provider: each agent is an Actor on its own channel, as the bundled one's are.
  const agentActor = hub.state.createActor(PERSON, {
    name: "Agents",
    bindings: [{ slot: "actors", provider: "hub", export: "actors" }],
  });
  const stopped = new Set<string>();
  const chosen = new Map<string, string>();
  const agentsProvider = await connect({
    hubUrl: server.url,
    actorId: agentActor.actorId,
    credential: agentActor.credential as string,
    slots: { actors: hubActors },
    exports: { provider: agentProvider },
    start(ctx) {
      ctx.exports.provider.implement({
        creatable: () => ({ creatables: CREATABLES }),
        async create({ name }) {
          failing("agent");
          const { actorId, credential } = await ctx.slots.actors.call.create({ name });
          credentials.set(actorId, credential as string);
          const client = await connect({
            hubUrl: server.url,
            actorId,
            credential: credential as string,
            slots: { settings: agentSettings },
            exports: { chat },
            start(own) {
              contexts.set(actorId, own as never);
              const said: { id: string; role: "user"; text: string; at: string; chat: string }[] =
                [];
              chats.set(actorId, said);
              const started: Started = new Map();
              startedIn.set(actorId, started);
              const failed = (chat: string) => (script.failed ?? []).includes(chat);
              own.exports.chat.implement({
                // A message with no chat starts one, titled by its first line, as the engine does.
                send({ chat, text }) {
                  if (chat !== undefined && !started.has(chat))
                    throw new Refused("unknown", "This agent has no such chat.");
                  const at = new Date().toISOString();
                  const into = chat ?? `c${started.size + 1}`;
                  if (chat === undefined)
                    started.set(into, { title: text.split("\n")[0] ?? "", at, archived: false });
                  const id = `m-${said.length + 1}`;
                  said.push({ id, role: "user", text, at, chat: into });
                  return { chat: into, messageId: id };
                },
                history({ chat }) {
                  if (!started.has(chat))
                    throw new Refused("unknown", "This agent has no such chat.");
                  return {
                    messages: said
                      .filter((one) => one.chat === chat)
                      .map(({ chat: _, ...message }) => message),
                    more: false,
                  };
                },
                // The agent is working when a test says so.
                state: () => ({ state: script.working ? ("working" as const) : ("idle" as const) }),
                list({ archived = false, before }) {
                  const ids = [...started.keys()].reverse();
                  return {
                    chats: ids
                      .slice(before === undefined ? 0 : ids.indexOf(before) + 1)
                      .map((id) => ({
                        id,
                        ...(started.get(id) as { title: string; at: string; archived: boolean }),
                        // A chat a test names as failed has that problem.
                        ...(failed(id)
                          ? { problem: { code: "usage_limit", message: "Usage limit reached." } }
                          : {}),
                      }))
                      .filter((one) => one.archived === archived),
                    more: false,
                  };
                },
                // A title is one line: the first of what it is given.
                rename({ chat, title }) {
                  const one = started.get(chat);
                  if (one) one.title = title.split("\n")[0] ?? "";
                  return {};
                },
                archive({ chat, archived }) {
                  const one = started.get(chat);
                  if (one) one.archived = archived;
                  return {};
                },
              });
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
        // The models it offers, and the one chosen for the agent.
        models: ({ agent }) => ({
          models: MODELS,
          ...(chosen.has(agent) ? { current: chosen.get(agent) as string } : {}),
        }),
        setModel({ agent, model }) {
          if (model && !MODELS.some((one) => one.id === model))
            throw new Refused("unknown", `${model} isn't one of the models offered.`);
          if (model) chosen.set(agent, model);
          else chosen.delete(agent);
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

  // A stand-in unit provider: an instance holds the connections it made, each an Actor.
  const unitsActor = hub.state.createActor(PERSON, {
    name: "Units",
    bindings: [{ slot: "actors", provider: "hub", export: "actors" }],
  });
  const unitsClient = await connect({
    hubUrl: server.url,
    actorId: unitsActor.actorId,
    credential: unitsActor.credential as string,
    slots: { actors: hubActors },
    exports: { provider: unitProvider },
    start(ctx) {
      const held = new Map<
        string,
        { slot: string; connection: string; client: { close(): void } }[]
      >();
      ctx.exports.provider.implement({
        units: () => ({ units: UNITS as never }),
        skill: ({ path, name }) => {
          failing("skill");
          return { text: path === "SKILL.md" ? SKILL(script.skillName ?? name) : "A guide." };
        },
        check: (input) => {
          given.checked.push(input);
          return { problems: script.problems ?? [] };
        },
        async apply({ unit, values, secrets, needs, agent, name }) {
          await script.during?.();
          failing("apply");
          given.applied.push({ unit, values, secrets, needs, agent });
          given.secrets.push(secrets);
          const slots =
            unit === "files"
              ? ["files", ...(values.extra ? ["extra"] : [])]
              : unit === "terminal"
                ? ["terminal"]
                : unit === "stand-in" || unit === "url"
                  ? [values.slot as string]
                  : unit === "computer"
                    ? ["computer", ...(values.browser ? ["browser"] : [])]
                    : unit === "vault"
                      ? ["vault"]
                      : unit === "desk"
                        ? ["desk"]
                        : [];
          const made = [];
          for (const slot of slots) {
            const { actorId, credential } = await ctx.slots.actors.call.create({ name });
            const client = await connect({
              hubUrl: server.url,
              actorId,
              credential: credential as string,
              exports: script.noTools ? {} : { tools },
            });
            leaving.push(() => client.close());
            made.push({ slot: script.wrongSlot ?? slot, connection: actorId, client });
          }
          // What a desk is, on its own Actor: the built agent's side of it.
          let desk: string | undefined;
          if (unit === "desk" && !script.noCapability) {
            const { actorId, credential } = await ctx.slots.actors.call.create({ name });
            const client = await connect({
              hubUrl: server.url,
              actorId,
              credential: credential as string,
              exports: { capability },
              start(own) {
                own.exports.capability.implement({
                  state: () => ({
                    state: "connected" as const,
                    surfaces: [{ surface: "top", protocol: "stand-in@1", operate: true }],
                  }),
                  live: ({ surface }) => ({
                    url: `ws://127.0.0.1:9/${surface}`,
                    protocol: "stand-in@1",
                    expiresAt: new Date().toISOString(),
                  }),
                });
              },
            });
            leaving.push(() => client.close());
            made.push({ slot: "", connection: actorId, client });
            desk = actorId;
          }
          const instance = `inst-${crypto.randomUUID()}`;
          held.set(instance, made);
          // One made before units is known by its connection.
          for (const { connection } of made) held.set(connection, made);
          return {
            instance,
            ...(desk
              ? {
                  capability: {
                    actor: desk,
                    rows: script.rows ?? { where: [{ label: "Where", value: "By the window" }] },
                  },
                }
              : {}),
            connections: made
              .filter(({ connection }) => connection !== desk)
              .map(({ slot, connection }) => ({
                slot,
                connection,
                target: "a stand-in server",
              })),
            results:
              unit === "machine" && !script.noResults
                ? [{ kind: "computer", handle: "computer-handle" }]
                : [],
          };
        },
        status: ({ instance }) => {
          const made = held.get(instance);
          if (!made) throw new Refused("unknown", "Not held.");
          return {
            state: "connected" as const,
            surfaces: [{ surface: "screen", protocol: "stand-in@1", operate: true }],
            connections: made
              .filter(({ slot }) => slot !== "")
              .map(({ connection }) => ({
                connection,
                state: "connected" as const,
                tools: [{ name: "read" }],
              })),
          };
        },
        live: ({ instance, surface, mode }) => {
          if (!held.has(instance) || surface !== "screen")
            throw new Refused("unknown", "Nothing like that here.");
          return {
            url: `ws://127.0.0.1:9/live/${instance}/${mode}`,
            protocol: "stand-in@1",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        },
        async remove({ instance }) {
          const made = held.get(instance);
          if (!made) throw new Refused("unknown", "Not held.");
          failing("unit.remove");
          given.removed.push(instance);
          for (const { connection, client } of made) {
            client.close();
            await ctx.slots.actors.call.close({ actorId: connection });
          }
          held.delete(instance);
          for (const { connection } of made) held.delete(connection);
          return {};
        },
      });
    },
  });
  leaving.push(() => unitsClient.close());

  // A provider is connected by exposing its export to management; nothing else says so.
  for (const actor of [agentActor.actorId, unitsActor.actorId])
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
  for (
    let i = 0;
    (await caller.slots.agents.call.providers({})).providers.length < 1 ||
    (await caller.slots.agents.call.units({})).units.length < 1 + UNITS.length;
    i++
  ) {
    assert.ok(i < 300, "the providers never showed");
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
        provider: unitsActor.actorId,
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
  const base = { provider: agentActor.actorId, creatable: "plain" };
  const unit = (id: string, values?: Record<string, string | boolean>, more?: object) => ({
    provider: unitsActor.actorId,
    unit: id,
    ...(values ? { values } : {}),
    ...more,
  });
  const own = (id: string, values: object) => ({
    provider: management.actorId,
    unit: id,
    values,
  });
  const makeStack = async (units: object[], name = "Fay", more: object = {}) =>
    (await caller.slots.agents.call.create({ stack: { base, units }, name, ...more } as never))
      .agent;
  /** A unit that makes a connection and comes with a skill, and a connection the person made. */
  const makeFull = (connection: string, name = "Fay") =>
    makeStack(
      [unit("files", { folder: "/work" }), own("connection", { connection, slot: "search" })],
      name,
    );
  /** Management stopped and started on its records, as a new release would be. */
  const restart = async (edit: (kept: Record<string, never>) => void | Promise<void>) => {
    await manager.close();
    const path = join(dir, "manager.json");
    const kept = JSON.parse(readFileSync(path, "utf8"));
    await edit(kept);
    writeFileSync(path, JSON.stringify(kept));
    manager = await startManagement();
    await until(() => caller.slots.agents.bound);
    for (
      let i = 0;
      (await caller.slots.agents.call.units({})).units.length < 1 + UNITS.length;
      i++
    ) {
      assert.ok(i < 300, "the units never came back");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  /** An agent leaves and comes back offering its chats as `offered`, as a new release's would. */
  const rejoin = async (agent: string, offered: Interface) => {
    running.get(agent)?.close();
    const client = await connect({
      hubUrl: server.url,
      actorId: agent,
      credential: credentials.get(agent) as string,
      slots: { settings: agentSettings },
      exports: { chat: offered },
      start() {},
    });
    running.set(agent, client as never);
    leaving.push(() => client.close());
  };
  /** What is exposed to an agent at a slot, once it has heard of it. */
  const exposedTo = async <T>(agent: string, slot: string) => {
    await until(() =>
      Boolean(
        contexts
          .get(agent)
          ?.exposed()
          .some((one) => one.slot === slot),
      ),
    );
    return contexts
      .get(agent)
      ?.exposed()
      .find((one) => one.slot === slot)?.call as T;
  };
  /** One of the person's own slots made at run time, as a page would call it. */
  const personSlot = async <T>(slot: string) => {
    await until(() => person.exposed().some((one) => one.slot === slot));
    return person.exposed().find((one) => one.slot === slot)?.call as T;
  };
  return {
    restart,
    rejoin,
    exposedTo,
    personSlot,
    chats,
    startedIn,
    hub,
    person,
    dir,
    script,
    given,
    heard,
    agentActor,
    unitsActor,
    management,
    base,
    unit,
    own,
    makeStack,
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
      ["asking", s.agentActor.actorId],
    ],
  );
  const mcp = await s.calls.connections.providers({});
  assert.deepEqual(
    mcp.providers.map((p) => [p.provider, p.name, p.kinds.map((k) => k.kind)]),
    [[s.unitsActor.actorId, "Units", ["stand-in", "url"]]],
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

test("an agent that comes back offering its chats in another shape is reached again", async (t) => {
  const s = await setup(t);
  const agent = await s.makeFull(await s.picked());
  const reached = async () =>
    (await s.bindingsOf(PERSON)).filter((b) => b.provider === agent && b.export === "chat");
  const dropped = () =>
    s.hub.state.audit(0, 10_000).entries.filter((entry) => entry.kind === "binding.drop").length;
  const [before] = await reached();
  assert.ok(before);
  // The Hub drops a binding whose provider offers another interface under the same name.
  const reshaped = defineInterface({
    name: "chat",
    major: 1,
    kind: "rpc",
    methods: { ...chat.methods, more: method({ input: z.object({}), output: z.object({}) }) },
    events: chat.events,
  });
  await s.rejoin(agent, reshaped);
  assert.equal(dropped(), 1);
  for (let i = 0; (await reached()).length === 0; i++) {
    assert.ok(i < 300, "its chats never reached the person again");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Under the name it had, so what the person's pages keep by slot still holds.
  assert.deepEqual(
    (await reached()).map((b) => b.slot),
    [before.slot],
  );

  // And when the agent came back while management was away, as it does when the app starts.
  await s.restart(() => s.rejoin(agent, chat));
  assert.equal(dropped(), 2);
  for (let i = 0; (await reached()).length === 0; i++) {
    assert.ok(i < 300, "its chats never reached the person again");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});

test("a stack is made, bound, exposed and recorded, with its chat to the person", async (t) => {
  const s = await setup(t);
  const search = await s.picked();
  const agent = await s.makeFull(search);
  assert.deepEqual(s.given.applied.at(-1), {
    unit: "files",
    values: { folder: "/work" },
    secrets: {},
    needs: {},
    agent,
  });

  const read = await s.calls.agents.get({ agent });
  assert.equal(read.name, "Fay");
  assert.equal(read.provider, s.agentActor.actorId);
  assert.equal(read.creatable, "plain");
  assert.equal(read.instructions, "Be plain.");
  assert.deepEqual(read.status, { state: "running" });
  const files = read.units.find((one) => one.unit === "files");
  assert.deepEqual(read.skills, [
    { name: "notes", description: "The notes skill.", instance: files?.instance },
  ]);
  assert.deepEqual(files?.values, { folder: "/work" });
  assert.equal(files?.status.state, "connected");
  const bySlot = Object.fromEntries(read.mcp.map((m) => [m.slot, m]));
  assert.equal(bySlot.search?.connection, search);
  assert.equal(bySlot.search?.origin?.madeFor, undefined, "picked, so it isn't the agent's");
  assert.equal(bySlot.search?.instance, "slot:search");
  assert.equal(bySlot.files?.origin?.madeFor, agent);
  assert.equal(bySlot.files?.origin?.madeBy, s.callerActor.actorId);
  assert.equal(bySlot.files?.origin?.kind, "files");
  assert.equal(bySlot.files?.origin?.target, "a stand-in server");
  assert.equal(bySlot.files?.instance, files?.instance);
  assert.deepEqual(bySlot.files?.status, { state: "connected", tools: [{ name: "read" }] });
  assert.deepEqual(
    read.units.map((one) => one.unit),
    ["mcp", "files"],
  );
  // What a unit made goes with the unit.
  await assert.rejects(
    s.calls.connections.remove({ connection: bySlot.files?.connection as string }),
    refused("state"),
  );

  assert.ok((await s.bindingsOf(PERSON)).some((b) => b.provider === agent && b.export === "chat"));
  const held = await s.bindingsOf(agent);
  assert.ok(held.some((b) => b.slot === "settings" && b.provider === s.management.actorId));

  // The record is what only management knows: no status, no exposure of a connection.
  const kept = JSON.parse(readFileSync(join(s.dir, "manager.json"), "utf8"));
  assert.deepEqual(
    { ...kept.agents[agent], units: kept.agents[agent].units.length },
    {
      provider: s.agentActor.actorId,
      creatable: "plain",
      instructions: "Be plain.",
      skills: ["notes"],
      units: 1,
      capabilities: [],
      chat: "chat",
    },
  );
  assert.equal(kept.agents[agent].units[0].values.folder, "/work");
  assert.deepEqual(readdirSync(join(s.dir, "skills", "notes")).sort(), ["SKILL.md", "more"]);
  assert.equal(statSync(s.dir).mode & 0o777, 0o700);

  await s.calls.agents.stop({ agent });
  assert.deepEqual((await s.calls.agents.list({})).agents[0]?.status, { state: "stopped" });
  await s.calls.agents.start({ agent });
  assert.deepEqual((await s.calls.agents.list({})).agents[0]?.status, { state: "running" });
  // Its model is its provider's to tell and to keep: management passes both on.
  assert.deepEqual(await s.calls.agents.models({ agent }), { models: MODELS });
  await s.calls.agents.setModel({ agent, model: "large" });
  assert.deepEqual(await s.calls.agents.models({ agent }), { models: MODELS, current: "large" });
  await assert.rejects(s.calls.agents.setModel({ agent, model: "none" }), refused("unknown"));
  await s.calls.agents.setModel({ agent });
  assert.equal((await s.calls.agents.models({ agent })).current, undefined);
  await assert.rejects(s.calls.agents.models({ agent: "act_none" }), refused("unknown"));
  // A provider that can't answer shows its agent as down; nothing was stored to go stale.
  s.script.fail = "agent.status";
  assert.equal((await s.calls.agents.list({})).agents[0]?.status.state, "down");
});

const FAILURES: [string, (s: Awaited<ReturnType<typeof setup>>) => void][] = [
  ["the provider making the agent", (s) => (s.script.fail = "agent")],
  ["binding its settings", (s) => (s.script.settings = "nothing")],
  ["reading a skill's file", (s) => (s.script.fail = "skill")],
  ["applying the unit", (s) => (s.script.fail = "apply")],
  ["the unit making other connections than it said", (s) => (s.script.wrongSlot = "other")],
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
    stack: { base: s.base, units: [] },
    name: "Bystander",
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
  s.script.fail = "apply";
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
  s.script.fail = "apply";
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
    stack: { base: s.base, units: [] },
    name: "Other",
  });
  // The skill arrives with the first unit; the second is where it fails.
  s.script.during = async () => {
    s.script.during = async () => {
      delete s.script.during;
      await s.calls.agents.expose({ agent: other, skill: "notes" });
      throw new Refused("failed", "On cue.");
    };
  };
  await assert.rejects(s.makeStack([s.unit("files", { folder: "/a" }), s.unit("machine")]));
  assert.deepEqual((await s.calls.skills.get({ name: "notes" })).agents, [other]);
});

test("a connection or agent whose provider has gone can still be removed", async (t) => {
  const s = await setup(t);
  const connection = await s.picked();
  const agent = await s.makeFull(connection);
  for (const provider of [s.unitsActor.actorId, s.agentActor.actorId]) {
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

test("what can't be made refuses before anything is made", async (t) => {
  const s = await setup(t);
  const actors = await s.openActors();
  await assert.rejects(s.makeFull("act_nothing"), refused("invalid"));
  await assert.rejects(s.makeStack([s.unit("files")]), refused("invalid"));
  await assert.rejects(
    s.makeStack([{ provider: s.unitsActor.actorId, unit: "nothing" }]),
    refused("invalid"),
  );
  assert.deepEqual(await s.openActors(), actors);
  await assert.rejects(
    s.calls.agents.create({
      stack: { base: { ...s.base, creatable: "nothing" }, units: [] },
      name: "X",
    }),
    refused("unknown"),
  );
  await assert.rejects(
    s.calls.agents.create({
      stack: { base: { ...s.base, provider: "act_x" }, units: [] },
      name: "X",
    }),
    refused("unknown"),
  );
});

test("a unit's skill whose name is here keeps the one here, and survives a failure", async (t) => {
  const s = await setup(t);
  await s.calls.skills.add({ files: { "SKILL.md": SKILL("notes", "The person's own.") } });
  const search = await s.picked();
  s.script.fail = "apply";
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
    (await s.calls.agents.create({ stack: { base: s.base, units: [] }, name })).agent;
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

test("removing an agent takes its units last first, and leaves what it was given", async (t) => {
  const s = await setup(t);
  const search = await s.picked();
  const agent = await s.makeStack([
    s.unit("machine"),
    s.unit("terminal"),
    s.own("connection", { connection: search, slot: "search" }),
  ]);
  const read = await s.calls.agents.get({ agent });
  const made = read.mcp.find((m) => m.slot === "terminal")?.connection as string;
  assert.deepEqual(s.given.applied.at(-1)?.needs, { computer: "computer-handle" });
  const [computer, terminal] = read.units.filter((one) => one.provider === s.unitsActor.actorId);
  assert.deepEqual(terminal?.needs, { computer: computer?.instance });
  // A unit another needs can't go, and the one that needs it can.
  await assert.rejects(
    s.calls.agents.removeUnit({ agent, instance: computer?.instance as string }),
    refused("state"),
  );

  await s.calls.agents.remove({ agent });
  assert.equal(s.given.removed.length, 3);
  assert.equal(s.given.removed[2], agent, "the base goes last");
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

test("a unit that can't go leaves the agent to be tried again", async (t) => {
  const s = await setup(t);
  const agent = await s.makeStack([s.unit("machine"), s.unit("terminal")]);
  s.script.fail = "unit.remove";
  await assert.rejects(s.calls.agents.remove({ agent }));
  assert.equal((await s.calls.agents.get({ agent })).units.length, 2);
  delete s.script.fail;
  await s.calls.agents.remove({ agent });
  assert.deepEqual((await s.calls.agents.list({})).agents, []);
});

test("an agent is told what it's for", async (t) => {
  const s = await setup(t);
  const { agent } = await s.calls.agents.create({
    stack: { base: s.base, units: [] },
    name: "Pat",
    purpose: "Keeps the docs tidy.",
  });
  assert.equal((await s.calls.agents.get({ agent })).purpose, "Keeps the docs tidy.");
  assert.equal((await s.calls.agents.get({ agent })).instructions, "Be plain.");
  assert.equal((await s.calls.agents.list({})).agents[0]?.purpose, "Keeps the docs tidy.");
  const channel = s.agentChannel(agent);
  await until(() => channel.slots.settings.bound);
  assert.equal(
    (await channel.slots.settings.call.get({})).instructions,
    "Be plain.\n\nWhat you are for: Keeps the docs tidy.",
  );
});

test("one MCP unit stands for a connection there is or any kind on offer", async (t) => {
  const s = await setup(t);
  const mcp = (await s.calls.agents.units({})).units.find((one) => one.id === "mcp");
  const fields = Object.fromEntries((mcp?.form ?? []).map((field) => [field.id, field]));
  assert.deepEqual(
    fields.how?.options?.map((one) => one.value),
    ["connection", "stand-in", "url"],
  );
  assert.deepEqual(fields.connection?.visible, { field: "how", in: ["connection"] });
  assert.deepEqual(fields.url?.visible, { field: "how", in: ["stand-in", "url"] });
  // Shared by two kinds that say different things, it's closed to agents.
  assert.equal(fields.url?.authority, undefined);
  assert.equal(fields.token?.value, "secret");
  assert.deepEqual(Object.keys(fields), ["how", "connection", "url", "token", "public", "slot"]);

  const connection = await s.picked();
  const check = async (values: object) =>
    (
      await s.calls.agents.check({
        stack: { base: s.base, units: [s.own("mcp", values)] },
      } as never)
    ).problems.map((one) => one.field);
  assert.deepEqual(await check({ slot: "x" }), ["how"]);
  assert.deepEqual(await check({ how: "nothing", slot: "x" }), ["how"]);
  assert.deepEqual(await check({ how: "connection", slot: "x" }), ["connection"]);
  // A field that isn't shown has no value, whatever was sent.
  assert.deepEqual(await check({ how: "connection", connection, slot: "x", url: "y" }), []);

  const secret = `secret-${crypto.randomUUID()}`;
  const agent = await s.makeStack([
    s.own("mcp", { how: "connection", connection, slot: "search" }),
    { ...s.own("mcp", { how: "stand-in", url: "x", slot: "served" }), secrets: { token: secret } },
  ]);
  assert.deepEqual(s.given.applied.at(-1)?.values, { url: "x", slot: "served" });
  assert.deepEqual(s.given.applied.at(-1)?.secrets, { token: secret });
  const read = await s.calls.agents.get({ agent });
  assert.deepEqual(read.mcp.map((one) => one.slot).sort(), ["search", "served"]);
  assert.deepEqual(
    read.units.map((one) => [one.unit, one.title, one.provider, one.values]),
    [
      ["mcp", "MCP", s.management.actorId, { how: "connection", connection, slot: "search" }],
      ["mcp", "MCP", s.management.actorId, { how: "stand-in", url: "x", slot: "served" }],
    ],
  );
  assert.ok(!JSON.stringify(read).includes(secret));
  // A way not on offer can't be saved: nothing could tell which of its fields are secret.
  const on = { provider: "Agents", creatable: "plain" };
  const templated = (values: object) =>
    s.calls.agents.saveTemplate({
      id: "served",
      title: "Served",
      description: "",
      base: on,
      units: [{ provider: "Management", unit: "mcp", values }],
    } as never);
  await assert.rejects(templated({ how: "gone", slot: "x", token: "y" }), refused("unknown"));
  await assert.rejects(
    templated({ how: "stand-in", url: "x", slot: "y", token: "z" }),
    refused("invalid"),
  );
  await templated({ how: "stand-in", url: "x", slot: "y" });

  // The same name twice is the same conflict as for any unit.
  assert.deepEqual(
    (
      await s.calls.agents.check({
        agent,
        unit: s.own("mcp", { how: "connection", connection, slot: "served" }),
      } as never)
    ).problems.map((one) => one.message),
    ["The name served is already taken."],
  );
  for (const one of read.units) await s.calls.agents.removeUnit({ agent, instance: one.instance });
  assert.deepEqual((await s.calls.agents.get({ agent })).mcp, []);
  // And the person's own connection is still there, as the Connect page made it.
  assert.ok((await s.openActors()).includes(connection));
});

test("every unit on offer is listed, management's own among them", async (t) => {
  const s = await setup(t);
  const { bases, units } = await s.calls.agents.units({});
  assert.deepEqual(
    bases.map((one) => [one.id, one.providerName]),
    [
      ["plain", "Agents"],
      ["asking", "Agents"],
    ],
  );
  assert.deepEqual(
    units.map((one) => [one.id, one.providerName]),
    [
      ["mcp", "Management"],
      ["control", "Management"],
      ["skill", "Management"],
      ["files", "Units"],
      ["machine", "Units"],
      ["desk", "Units"],
      ["askew", "Units"],
      ["terminal", "Units"],
      ["computer", "Units"],
      ["runner", "Units"],
      ["closed", "Units"],
      ["vault", "Units"],
    ],
  );
  await s.calls.skills.add({ files: { "SKILL.md": SKILL("library-one") } });
  const again = (await s.calls.agents.units({})).units[2];
  assert.deepEqual(
    again?.form[0]?.options?.map((one) => one.value),
    ["library-one"],
  );
});

test("a stack is checked before anything runs, each problem on its unit", async (t) => {
  const s = await setup(t);
  const check = async (units: object[]) =>
    (await s.calls.agents.check({ stack: { base: s.base, units } } as never)).problems;
  assert.deepEqual(await check([s.unit("files", { folder: "/a" })]), []);
  assert.deepEqual(s.given.checked.at(-1), {
    unit: "files",
    values: { folder: "/a" },
    secrets: [],
  });

  // What the form says.
  assert.deepEqual(await check([s.unit("files")]), [
    { field: "folder", message: "Folder must be filled in.", unit: 0 },
  ]);
  assert.match(
    (await check([s.unit("files", { folder: "/a", token: "x" })]))[0]?.message as string,
    /secret/,
  );
  // The same connection from two units, and what an answer adds counts.
  assert.match(
    (
      await check([
        s.unit("files", { folder: "/a", extra: true }),
        s.own("connection", { connection: s.management.actorId, slot: "extra" }),
      ])
    )[0]?.message as string,
    /The name extra is already taken/,
  );
  // What a unit needs must come from above it.
  assert.match((await check([s.unit("terminal")]))[0]?.message as string, /from a unit above/);
  assert.match(
    (await check([s.unit("terminal"), s.unit("machine")]))[0]?.message as string,
    /from a unit above/,
  );
  assert.match(
    (await check([s.unit("machine"), s.unit("machine"), s.unit("terminal")]))[0]?.message as string,
    /pick which/,
  );
  assert.deepEqual(
    await check([
      s.unit("machine"),
      s.unit("machine"),
      s.unit("terminal", undefined, { needs: { computer: 1 } }),
    ]),
    [],
  );
  assert.match(
    (
      await check([
        s.unit("machine"),
        s.unit("files", { folder: "/a" }, { needs: { computer: 0 } }),
      ])
    )[0]?.message as string,
    /doesn't need computer/,
  );
  // The unit's own logic, by what it says; it sees a secret's name only.
  s.script.problems = [{ field: "folder", message: "No such folder." }];
  assert.deepEqual(
    await check([{ ...s.unit("files", { folder: "/a" }), secrets: { token: "hidden" } }]),
    [{ field: "folder", message: "No such folder.", unit: 0 }],
  );
  assert.deepEqual(s.given.checked.at(-1)?.secrets, ["token"]);
  delete s.script.problems;
  // And the base.
  assert.match(
    (
      await s.calls.agents.check({
        stack: { base: { ...s.base, creatable: "nothing" }, units: [] },
      })
    ).problems[0]?.message as string,
    /offers no/,
  );
});

test("what an answer adds is made, confirmed and recorded", async (t) => {
  const s = await setup(t);
  const agent = await s.makeStack([s.unit("files", { folder: "/a", extra: true })]);
  assert.deepEqual((await s.calls.agents.get({ agent })).mcp.map((m) => m.slot).sort(), [
    "extra",
    "files",
  ]);
});

test("a unit that doesn't give the result it declared undoes the creation", async (t) => {
  const s = await setup(t);
  const actors = await s.openActors();
  s.script.noResults = true;
  await assert.rejects(s.makeStack([s.unit("machine"), s.unit("terminal")]), refused("failed"));
  assert.deepEqual(await s.openActors(), actors);
});

test("the Skill and Connection units are exposures, and read back as units", async (t) => {
  const s = await setup(t);
  await s.calls.skills.add({ files: { "SKILL.md": SKILL("handy") } });
  const connection = await s.picked();
  const agent = await s.makeStack([
    s.own("skill", { skill: "handy" }),
    s.own("connection", { connection, slot: "search" }),
  ]);
  const read = await s.calls.agents.get({ agent });
  assert.deepEqual(
    read.units.map((one) => [one.instance, one.unit, one.values]),
    [
      ["skill:handy", "skill", { skill: "handy" }],
      ["slot:search", "mcp", { how: "connection", connection, slot: "search" }],
    ],
  );
  // No record of a unit: it is what is exposed. An exposure made by hand reads the same way.
  const kept = JSON.parse(readFileSync(join(s.dir, "manager.json"), "utf8"));
  assert.deepEqual(kept.agents[agent].units, []);

  await s.calls.agents.removeUnit({ agent, instance: "skill:handy" });
  await s.calls.agents.removeUnit({ agent, instance: "slot:search" });
  const after = await s.calls.agents.get({ agent });
  assert.deepEqual([after.units, after.skills, after.mcp], [[], [], []]);
  await assert.rejects(
    s.calls.agents.removeUnit({ agent, instance: "slot:settings" }),
    refused("unknown"),
    "its other slots aren't units",
  );
  assert.ok((await s.bindingsOf(agent)).some((b) => b.slot === "settings"));
  await assert.rejects(s.makeStack([s.own("skill", { skill: "nothing" })]), refused("invalid"));
});

test("a unit can be added to a living agent and removed, with what it made", async (t) => {
  const s = await setup(t);
  const agent = await s.makeStack([s.unit("machine")]);
  const channel = s.agentChannel(agent);
  await until(() => channel.slots.settings.bound);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const computer = (await s.calls.agents.get({ agent })).units[0]?.instance as string;

  const { instance } = await s.calls.agents.addUnit({
    agent,
    unit: s.unit("terminal"),
    needs: { computer },
  });
  assert.deepEqual(s.given.applied.at(-1)?.needs, { computer: "computer-handle" });
  const read = await s.calls.agents.get({ agent });
  assert.equal(read.mcp[0]?.slot, "terminal");
  assert.equal(read.mcp[0]?.instance, instance);
  await assert.rejects(
    s.calls.agents.addUnit({ agent, unit: s.unit("terminal") }),
    refused("invalid"),
    "that connection is already there",
  );
  assert.deepEqual(
    (await s.calls.agents.check({ agent, unit: s.unit("terminal") })).problems.map(
      (p) => p.message,
    ),
    ["The name terminal is already taken."],
  );

  const added = await s.calls.agents.addUnit({ agent, unit: s.unit("files", { folder: "/a" }) });
  await until(() => (s.heard.get(agent) ?? 0) >= 2);
  assert.deepEqual(
    (await channel.slots.settings.call.get({})).skills.map((one) => one.name),
    ["notes"],
  );
  const actors = await s.openActors();
  await s.calls.agents.removeUnit({ agent, instance: added.instance });
  assert.equal((await s.openActors()).length, actors.length - 1);
  assert.deepEqual((await channel.slots.settings.call.get({})).skills, []);
  await s.calls.agents.removeUnit({ agent, instance });
  await s.calls.agents.removeUnit({ agent, instance: computer });
  assert.deepEqual((await s.calls.agents.get({ agent })).units, []);
  await assert.rejects(s.calls.agents.removeUnit({ agent, instance }), refused("unknown"));
});

test("adding a unit is all or none on the living agent", async (t) => {
  const s = await setup(t);
  const agent = await s.makeStack([]);
  const actors = await s.openActors();
  const records = readFileSync(join(s.dir, "manager.json"), "utf8");
  s.script.noTools = true;
  await assert.rejects(s.calls.agents.addUnit({ agent, unit: s.unit("files", { folder: "/a" }) }));
  delete s.script.noTools;
  assert.deepEqual(await s.openActors(), actors);
  assert.equal(readFileSync(join(s.dir, "manager.json"), "utf8"), records);
  s.script.fail = "skill";
  await assert.rejects(s.calls.agents.addUnit({ agent, unit: s.unit("files", { folder: "/a" }) }));
  assert.deepEqual(await s.openActors(), actors);
  assert.equal(readFileSync(join(s.dir, "manager.json"), "utf8"), records);
  assert.deepEqual((await s.calls.agents.get({ agent })).units, []);
});

test("a template prefills a stack, nothing in it is locked, and it holds no secret", async (t) => {
  const s = await setup(t);
  const template = {
    id: "reader",
    title: "Reader",
    description: "Reads.",
    base: { provider: "Agents", creatable: "plain" },
    units: [{ provider: "Units", unit: "files", values: { folder: "/prefilled" } }],
  };
  await s.calls.agents.saveTemplate(template);
  assert.deepEqual((await s.calls.agents.templates({})).templates, [template]);

  const secret = `secret-${crypto.randomUUID()}`;
  const { agent } = await s.calls.agents.create({
    template: "reader",
    name: "From it",
    fill: [{ values: { extra: true }, secrets: { token: secret } }],
  });
  assert.deepEqual(s.given.applied.at(-1)?.values, { folder: "/prefilled", extra: true });
  assert.deepEqual(s.given.applied.at(-1)?.secrets, { token: secret });
  assert.equal((await s.calls.agents.get({ agent })).template, "reader");
  assert.equal((await s.calls.agents.list({})).agents[0]?.template, "reader");
  const { agent: changed } = await s.calls.agents.create({
    template: "reader",
    name: "Changed",
    fill: [{ values: { folder: "/mine" } }],
  });
  assert.deepEqual((await s.calls.agents.get({ agent: changed })).units[0]?.values, {
    folder: "/mine",
  });

  // A copy changes without its source being touched.
  await s.calls.agents.saveTemplate({ ...template, id: "copy", from: "reader", units: [] });
  await s.calls.agents.removeTemplate({ id: "reader" });
  assert.deepEqual(
    (await s.calls.agents.templates({})).templates.map((one) => [one.id, one.from]),
    [["copy", "reader"]],
  );
  await assert.rejects(s.calls.agents.removeTemplate({ id: "reader" }), refused("unknown"));

  await assert.rejects(
    s.calls.agents.saveTemplate({
      ...template,
      units: [{ provider: "Units", unit: "files", values: { token: "kept" } }],
    }),
    refused("invalid"),
  );
  await assert.rejects(
    s.calls.agents.saveTemplate({
      ...template,
      units: [{ provider: "Units", unit: "nothing" }],
    }),
    refused("unknown"),
  );
  await assert.rejects(
    s.calls.agents.create({ template: "nothing", name: "X" }),
    refused("unknown"),
  );
  await assert.rejects(
    s.calls.agents.create({ template: "copy", name: "X", fill: [{}] }),
    refused("invalid"),
  );

  const everything = [
    readFileSync(join(s.dir, "manager.json"), "utf8"),
    JSON.stringify(await s.calls.agents.get({ agent })),
    JSON.stringify(s.hub.state.audit(0, 100_000)),
  ].join("\n");
  assert.ok(!everything.includes(secret));
});

test("a problem with a long value still comes back", async (t) => {
  const s = await setup(t);
  const { problems } = await s.calls.agents.check({
    stack: {
      base: s.base,
      units: [s.own("connection", { connection: s.management.actorId, slot: "x".repeat(3000) })],
    },
  } as never);
  assert.ok(problems.length > 0);
  assert.ok(problems.every((one) => one.message.length <= 2000));
});

test("an empty name is no name", async (t) => {
  const s = await setup(t);
  const agent = await s.makeStack([]);
  const connection = await s.picked();
  const unit = s.own("connection", { connection, slot: "" });
  assert.deepEqual((await s.calls.agents.check({ agent, unit } as never)).problems, [
    { field: "slot", message: "Name must be filled in." },
  ]);
});

test("a name the agent already holds is refused in the check", async (t) => {
  const s = await setup(t);
  const agent = await s.makeStack([]);
  const connection = await s.picked();
  const unit = s.own("connection", { connection, slot: "settings" });
  assert.deepEqual(
    (await s.calls.agents.check({ agent, unit } as never)).problems.map((one) => one.message),
    ["The name settings is already taken."],
  );
});

test("changes to one agent happen one at a time", async (t) => {
  const s = await setup(t);
  await s.calls.skills.add({ files: { "SKILL.md": SKILL("handy") } });
  const agent = await s.makeStack([]);
  const skill = s.own("skill", { skill: "handy" });
  const [one, two] = await Promise.allSettled([
    s.calls.agents.addUnit({ agent, unit: skill } as never),
    s.calls.agents.addUnit({ agent, unit: skill } as never),
  ]);
  assert.equal(one.status, "fulfilled");
  assert.equal(two.status, "rejected");
  assert.equal((await s.calls.agents.get({ agent })).skills.length, 1);

  // Removing the agent waits for the unit being added, so the unit goes with it.
  const added = s.calls.agents.addUnit({ agent, unit: s.unit("machine") });
  await s.calls.agents.remove({ agent });
  await added;
  assert.equal(s.given.removed.length, 2);
  assert.equal(s.given.removed[1], agent);
});

test("a creation that fails leaves a skill another creation is using", async (t) => {
  const s = await setup(t);
  const stack = [s.unit("files", { folder: "/a" }), s.unit("machine")];
  let calls = 0;
  let held = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let second: Promise<string> | undefined;
  s.script.during = async () => {
    calls++;
    if (calls === 2) {
      second = s.makeStack(stack, "Second");
      await until(() => held);
      throw new Refused("failed", "On cue.");
    }
    if (calls === 4) {
      held = true;
      await gate;
    }
  };
  await assert.rejects(s.makeStack(stack, "First"));
  release();
  const agent = (await second) as string;
  assert.deepEqual((await s.calls.skills.get({ name: "notes" })).agents, [agent]);
});

test("what came with a unit goes with the unit", async (t) => {
  const s = await setup(t);
  const agent = await s.makeStack([s.unit("files", { folder: "/a" })]);
  await assert.rejects(s.calls.agents.unexpose({ agent, slot: "files" }), refused("state"));
  await assert.rejects(s.calls.agents.unexpose({ agent, skill: "notes" }), refused("state"));
  assert.equal((await s.calls.agents.get({ agent })).mcp.length, 1);
  // The library is the person's: a skill taken out of it leaves the unit's list too.
  await s.calls.skills.remove({ name: "notes" });
  const kept = JSON.parse(readFileSync(join(s.dir, "manager.json"), "utf8"));
  assert.deepEqual(kept.agents[agent].units[0].skills, []);
});

test("a Connection unit stands as its connection does", async (t) => {
  const s = await setup(t);
  const connection = await s.picked();
  const agent = await s.makeStack([s.own("connection", { connection, slot: "search" })]);
  assert.equal((await s.calls.agents.get({ agent })).units[0]?.status.state, "connected");
  const { bindings } = await s.person.slots.bindings.call.list({ actor: s.management.actorId });
  const slot = bindings.find((b) => b.provider === s.unitsActor.actorId)?.slot as string;
  await s.person.slots.grants.call.unexpose({ to: s.management.actorId, slot });
  for (let i = 0; (await s.calls.agents.get({ agent })).units[0]?.status.state !== "down"; i++) {
    assert.ok(i < 300, "it never read as down");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});

test("an agent from before units reads and goes as it did", async (t) => {
  const s = await setup(t);
  const { agent } = await s.calls.agents.create({
    stack: { base: s.base, units: [] },
    name: "Old",
  });
  const connection = await s.picked();
  await s.calls.agents.expose({ agent, connection, as: "search" });
  await s.restart((kept) => {
    delete kept.templates;
    delete kept.instances;
    delete (kept.agents as unknown as Record<string, { units?: unknown }>)[agent]?.units;
  });
  const read = await s.calls.agents.get({ agent });
  assert.deepEqual(
    read.units.map((one) => one.instance),
    ["slot:search"],
  );
  assert.deepEqual(read.units[0]?.status, { state: "connected" });
  assert.deepEqual((await s.calls.agents.templates({})).templates, []);
  await s.calls.agents.remove({ agent });
  assert.deepEqual((await s.calls.agents.list({})).agents, []);
  // A connection the person made before units goes through the provider, by its own id.
  await s.calls.connections.remove({ connection });
  assert.ok(s.given.removed.includes(connection));
  assert.ok(!(await s.openActors()).includes(connection));
});

test("a connection the person makes is a unit that makes one, with no agent yet", async (t) => {
  const s = await setup(t);
  const [provider] = (await s.calls.connections.providers({})).providers;
  assert.deepEqual(provider?.kinds.slice(0, 1), [
    {
      kind: "stand-in",
      title: "Stand-in",
      params: {
        type: "object",
        properties: { url: { type: "string", title: "Address" } },
        required: [],
      },
      secrets: { type: "object", properties: { token: { type: "string", title: "Token" } } },
    },
  ]);
  const { connection } = await s.calls.connections.create({
    provider: s.unitsActor.actorId,
    kind: "stand-in",
    params: { url: "x" },
    name: "Made",
  });
  assert.deepEqual(s.given.applied.at(-1), {
    unit: "stand-in",
    values: { url: "x", slot: "tools" },
    secrets: {},
    needs: {},
    agent: "person",
  });
  assert.equal((await s.calls.connections.get({ connection })).status.state, "connected");
  await assert.rejects(
    s.calls.connections.create({
      provider: s.unitsActor.actorId,
      kind: "files",
      params: { folder: "/a" },
      name: "Not a kind",
    }),
    refused("invalid"),
  );
  await assert.rejects(
    s.calls.connections.create({
      provider: s.unitsActor.actorId,
      kind: "stand-in",
      params: { unknown: "x" },
      name: "Unknown",
    }),
    refused("invalid"),
  );
  await s.calls.connections.remove({ connection });
  assert.equal(s.given.removed.length, 1);
  await assert.rejects(s.calls.connections.get({ connection }), refused("unknown"));
});

test("exposing a connection is a Hub binding and nothing else; removing one takes its exposures", async (t) => {
  const s = await setup(t);
  const { agent } = await s.calls.agents.create({
    stack: { base: s.base, units: [] },
    name: "Pat",
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
    provider: s.unitsActor.actorId,
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

type ToolCalls = {
  list(input: object): Promise<{
    tools: { name: string; inputSchema: Record<string, never> }[];
  }>;
  call(input: { name: string; arguments: object }): Promise<{ output: string; failed?: true }>;
};

/** Templates to delegate with, and a parent holding an agents unit filled in as asked. */
async function delegating(t: test.TestContext) {
  const s = await setup(t);
  const on = { provider: "Agents", creatable: "plain" };
  for (const [id, units] of Object.entries({
    helper: [],
    prefilled: [{ provider: "Units", unit: "files", values: { folder: "/prefilled" } }],
    worker: [{ provider: "Units", unit: "computer", values: { access: "terminal" } }],
    locked: [{ provider: "Units", unit: "vault" }],
    deputy: [
      {
        provider: "Management",
        unit: "control",
        values: { templates: ["helper", "worker"], limit: 8, depth: 3, access: "files" },
      },
    ],
  }))
    await s.calls.agents.saveTemplate({
      id,
      title: id,
      description: `The ${id}.`,
      base: on,
      units,
    });
  const agentsUnit = (values: object) => s.own("control", values);
  const parent = async (values: object, computer?: object, name = "Parent") => {
    const agent = await s.makeStack(
      [...(computer ? [s.unit("computer", computer as never)] : []), agentsUnit(values)],
      name,
    );
    return { agent, tools: await s.exposedTo<ToolCalls>(agent, "control") };
  };
  const made = async (tools: ToolCalls, name: string, args: object) => {
    const answer = await tools.call({ name, arguments: args });
    assert.equal(answer.failed, undefined, answer.output);
    return JSON.parse(answer.output).agent as string;
  };
  const names = async (tools: ToolCalls) => (await tools.list({})).tools.map((one) => one.name);
  return { ...s, agentsUnit, parent, made, names };
}

test("an agent creates, messages, reads, stops and removes an agent of its own", async (t) => {
  const s = await delegating(t);
  const { agent: parent, tools } = await s.parent({ templates: ["helper", "prefilled"] });
  assert.deepEqual(await s.names(tools), [
    "create_helper",
    "create_prefilled",
    "agent_list",
    "agent_get",
    "agent_send",
    "agent_chats",
    "agent_read",
    "agent_stop",
    "agent_start",
    "agent_remove",
    "agent_add_unit",
    "agent_remove_unit",
    "template_list",
    "unit_list",
  ]);
  const held = await s.calls.agents.get({ agent: parent });
  assert.deepEqual(
    held.skills.map((one) => one.name),
    ["delegating"],
  );
  assert.match((await s.calls.skills.get({ name: "delegating" })).text, /agents of your own/);

  const child = await s.made(tools, "create_helper", {
    name: "Kid",
    purpose: "Do the small part.",
  });
  const read = await s.calls.agents.get({ agent: child });
  assert.deepEqual(read.parent, { agent: parent, name: "Parent" });
  assert.equal(read.purpose, "Do the small part.");
  assert.equal(read.template, "helper");
  assert.equal((await s.calls.agents.list({})).agents.length, 2, "it is the person's too");

  const call = async (name: string, args: object) => {
    const answer = await tools.call({ name, arguments: args });
    assert.equal(answer.failed, undefined, answer.output);
    return JSON.parse(answer.output);
  };
  assert.deepEqual(
    (await call("agent_list", {})).agents.map((one: { agent: string }) => one.agent),
    [child],
  );
  const sent = await call("agent_send", { agent: child, text: "\nPlease start.\nThen report." });
  // It says who sent it, so it doesn't read as the person's.
  assert.equal(
    s.chats.get(child)?.[0]?.text,
    'An agent, "Parent", says:\n\n\nPlease start.\nThen report.',
  );
  // The message started a chat, called by what was asked and not by whose message it is.
  type Chat = { id: string; title: string; at: string };
  const chatsOf = async () => (await call("agent_chats", { agent: child })).chats as Chat[];
  assert.deepEqual(
    (await chatsOf()).map((one) => [one.id, one.title]),
    [[sent.chat, "Please start."]],
  );
  // And whether it is working now, which is the agent's to say, not a chat's.
  assert.equal((await call("agent_chats", { agent: child })).working, false);
  s.script.working = true;
  assert.equal((await call("agent_chats", { agent: child })).working, true);
  const saidIn = (chat: string) => call("agent_read", { agent: child, chat });
  assert.match((await saidIn(sent.chat)).messages[0].text, /Please start/);
  // It goes on in that chat by naming it, and starts another by naming none.
  const more = await call("agent_send", { agent: child, chat: sent.chat, text: "One more thing." });
  assert.equal(more.chat, sent.chat);
  const apart = await call("agent_send", { agent: child, text: "Something else." });
  assert.notEqual(apart.chat, sent.chat);
  assert.deepEqual(
    (await chatsOf()).map((one) => one.title),
    ["Something else.", "Please start."],
  );
  assert.equal((await saidIn(sent.chat)).messages.length, 2);
  assert.equal((await saidIn(apart.chat)).messages.length, 1);
  // A page follows the chat the one before ended on, and the archived are listed apart.
  const page = (input: object) => call("agent_chats", { agent: child, ...input });
  assert.deepEqual(
    (await page({ before: apart.chat })).chats.map((one: Chat) => one.id),
    [sent.chat],
  );
  (s.startedIn.get(child)?.get(sent.chat) as { archived: boolean }).archived = true;
  assert.deepEqual(
    (await chatsOf()).map((one) => one.id),
    [apart.chat],
  );
  assert.deepEqual(
    (await page({ archived: true })).chats.map((one: Chat) => one.id),
    [sent.chat],
  );
  // A message that got no answer is told with its chat, as its problem.
  s.script.failed = [apart.chat];
  assert.deepEqual((await chatsOf())[0], {
    id: apart.chat,
    title: "Something else.",
    at: (await chatsOf())[0]?.at,
    archived: false,
    problem: { code: "usage_limit", message: "Usage limit reached." },
  });
  // A refusal from the agent's chat is the tool's own: a chat it doesn't have.
  const none = await tools.call({
    name: "agent_send",
    arguments: { agent: child, chat: "no-such", text: "Hello." },
  });
  assert.equal(none.failed, true);
  assert.match(none.output, /no such chat/);
  const got = await call("agent_get", { agent: child });
  assert.equal(got.purpose, "Do the small part.");
  await call("agent_stop", { agent: child });
  assert.equal((await s.calls.agents.get({ agent: child })).status.state, "stopped");
  await call("agent_start", { agent: child });
  assert.equal((await s.calls.agents.get({ agent: child })).status.state, "running");

  // No agent holds any part of the Hub.
  for (const agent of [parent, child])
    assert.ok(
      !(await s.bindingsOf(agent)).some((b) => b.provider === "hub" && b.consumer === agent),
    );

  await call("agent_remove", { agent: child });
  assert.ok(!(await s.openActors()).includes(child));
  assert.deepEqual((await call("agent_list", {})).agents, []);
});

test("a template's values are the defaults of what an agent fills in", async (t) => {
  const s = await delegating(t);
  const { tools } = await s.parent({ templates: ["prefilled", "locked"] });
  const offered = (await tools.list({})).tools;
  assert.ok(!offered.some((one) => one.name === "create_locked"), "it needs a secret");
  const schema = offered.find((one) => one.name === "create_prefilled")?.inputSchema as never as {
    properties: { units: { properties: { files: Record<string, never> } }; place?: unknown };
    required: string[];
  };
  assert.deepEqual(schema.required, ["name", "purpose"]);
  assert.equal(schema.properties.place, undefined);
  const form = schema.properties.units.properties.files as never as {
    properties: Record<string, { default?: unknown }>;
    required: string[];
  };
  assert.equal(form.properties.folder?.default, "/prefilled");
  assert.deepEqual(form.required, [], "it has a value already");
  assert.equal(form.properties.token, undefined, "no secret passes through an agent");

  const child = await s.made(tools, "create_prefilled", {
    name: "Mine",
    purpose: "P.",
    units: { files: { extra: true } },
  });
  assert.deepEqual(s.given.applied.at(-1)?.values, { folder: "/prefilled", extra: true });
  assert.equal(s.given.applied.at(-1)?.agent, child);
  const refusedAs = async (args: object, pattern: RegExp) => {
    const answer = await tools.call({ name: "create_prefilled", arguments: args });
    assert.equal(answer.failed, true);
    assert.match(answer.output, pattern);
  };
  await refusedAs({ name: "X", purpose: "P.", units: { files: { token: "x" } } }, /secret/);
  await refusedAs({ name: "X", purpose: "P.", units: { other: {} } }, /no unit other/);
  await refusedAs({ purpose: "P." }, /name/);
});

test("an agent reaches only what it made, and only through its unit", async (t) => {
  const s = await delegating(t);
  const one = await s.parent({ templates: ["helper"] }, undefined, "One");
  const two = await s.parent({ templates: ["helper"] }, undefined, "Two");
  const child = await s.made(one.tools, "create_helper", { name: "Kid", purpose: "P." });
  for (const name of [
    "agent_get",
    "agent_send",
    "agent_chats",
    "agent_read",
    "agent_stop",
    "agent_start",
    "agent_remove",
    "agent_add_unit",
    "agent_remove_unit",
  ]) {
    const answer = await two.tools.call({
      name,
      arguments: {
        agent: child,
        text: "Hello",
        chat: "c1",
        provider: "x",
        unit: "y",
        instance: "i",
      },
    });
    assert.equal(answer.failed, true, name);
    assert.match(answer.output, /no agent/);
  }
  const output = (await two.tools.call({ name: "agent_list", arguments: {} })).output;
  assert.deepEqual(JSON.parse(output).agents, []);
  assert.equal((await one.tools.call({ name: "create_nothing", arguments: {} })).failed, true);

  // Exposing the person's own interface to an agent gives it nothing.
  const { slot } = await s.person.slots.grants.call.expose({
    provider: s.management.actorId,
    export: "agents",
    to: one.agent,
  });
  const manage = await s.exposedTo<{ list(input: object): Promise<unknown> }>(one.agent, slot);
  await assert.rejects(manage.list({}), refused("forbidden"));

  // Nor does holding its tools without the unit.
  const bare = await s.makeStack([], "Bare");
  await s.calls.agents.expose({ agent: bare, connection: s.management.actorId, as: "control" });
  const tools = await s.exposedTo<ToolCalls>(bare, "control");
  assert.deepEqual((await tools.list({})).tools, []);
  await assert.rejects(tools.call({ name: "agent_list", arguments: {} }), refused("unknown"));
});

test("an agent can't have more agents than its limit, or the home more than its cap", async (t) => {
  const s = await delegating(t);
  const { tools } = await s.parent({ templates: ["helper"], limit: 1 });
  const first = await s.made(tools, "create_helper", { name: "A", purpose: "P." });
  const twice = await tools.call({
    name: "create_helper",
    arguments: { name: "B", purpose: "P." },
  });
  assert.equal(twice.failed, true);
  assert.match(twice.output, /already have/);
  await tools.call({ name: "agent_remove", arguments: { agent: first } });
  await s.made(tools, "create_helper", { name: "C", purpose: "P." });

  // Two at once can't both take the last place.
  const roomy = await s.parent({ templates: ["helper"], limit: 1 }, undefined, "Roomy");
  const both = await Promise.all(
    ["D", "E"].map((name) =>
      roomy.tools.call({ name: "create_helper", arguments: { name, purpose: "P." } }),
    ),
  );
  assert.deepEqual(both.map((one) => one.failed === true).sort(), [false, true]);

  const free = await s.parent({ templates: ["helper"] }, undefined, "Free");
  await s.restart((kept) => {
    const agents = kept.agents as unknown as Record<string, unknown>;
    for (let i = 0; i < 24; i++)
      agents[`act_filler${i}`] = {
        provider: s.agentActor.actorId,
        creatable: "plain",
        instructions: "",
        skills: [],
      };
  });
  const capped = await free.tools.call({
    name: "create_helper",
    arguments: { name: "F", purpose: "P." },
  });
  assert.equal(capped.failed, true);
  assert.match(capped.output, /as many agents/);
});

test("a child's agents unit holds no more than its parent's, one level less deep", async (t) => {
  const s = await delegating(t);
  const flat = await s.parent({ templates: ["deputy"], depth: 1 }, undefined, "Flat");
  assert.ok(!(await s.names(flat.tools)).includes("create_deputy"), "depth 1 makes no managers");

  const { tools } = await s.parent(
    { templates: ["deputy", "helper"], limit: 2, depth: 2, access: "read", places: ["own"] },
    { access: "read" },
  );
  const deputy = await s.made(tools, "create_deputy", { name: "Deputy", purpose: "P." });
  const unit = (await s.calls.agents.get({ agent: deputy })).units.find(
    (u) => u.unit === "control",
  );
  // The template's values are brought within the parent's, whatever the template says.
  assert.deepEqual(unit?.values, {
    agents: "own",
    saveTemplates: false,
    connections: "none",
    skills: "none",
    templates: ["helper"],
    places: [],
    access: "none",
    browser: false,
    limit: 2,
    depth: 1,
  });
  const beyond = async (values: object, pattern: RegExp) => {
    const answer = await tools.call({
      name: "create_deputy",
      arguments: { name: "More", purpose: "P.", units: { control: values } },
    });
    assert.equal(answer.failed, true);
    assert.match(answer.output, pattern);
  };
  await beyond({ templates: ["worker"] }, /more templates/);
  await beyond({ limit: 3 }, /at most 2/);
  await beyond({ access: "terminal" }, /further/);
  await beyond({ browser: true }, /browser/);
  await beyond({ depth: 2 }, /can't set/);
  // At depth 1, it has no agents unit to pass on.
  const childTools = await s.exposedTo<ToolCalls>(deputy, "control");
  assert.deepEqual((await s.names(childTools)).slice(0, 2), ["create_helper", "agent_list"]);
});

test("a child shares its parent's computer only within the bounds, or goes to a listed place", async (t) => {
  const s = await delegating(t);
  const place = await s.picked();
  // A unit can't allow more than the computer beside it.
  const check = (values: object, computer: object) =>
    s.calls.agents.check({
      stack: { base: s.base, units: [s.unit("computer", computer as never), s.agentsUnit(values)] },
    } as never);
  assert.deepEqual(
    (await check({ templates: ["worker"], access: "terminal" }, { access: "files" })).problems.map(
      (p) => p.field,
    ),
    ["access"],
  );
  assert.deepEqual(
    (await check({ templates: ["worker"], browser: true }, { access: "files" })).problems.map(
      (p) => p.field,
    ),
    ["browser"],
  );

  const { agent: parent, tools } = await s.parent(
    { templates: ["worker"], places: ["own", place], access: "terminal", browser: true },
    { access: "terminal", browser: true },
  );
  const schema = (await tools.list({})).tools[0]?.inputSchema as never as {
    properties: { place: { enum: string[] }; units: { properties: object } };
    required: string[];
  };
  assert.deepEqual(schema.properties.place.enum, ["own", place]);
  assert.ok(schema.required.includes("place"));
  assert.deepEqual(schema.properties.units.properties, {}, "the computer is the place");

  const shared = await s.made(tools, "create_worker", { name: "S", purpose: "P.", place: "own" });
  const parentRead = await s.calls.agents.get({ agent: parent });
  const read = await s.calls.agents.get({ agent: shared });
  const bySlot = (agent: typeof read) =>
    Object.fromEntries(agent.mcp.map((m) => [m.slot, m.connection]));
  assert.deepEqual(bySlot(read), {
    computer: bySlot(parentRead).computer,
    browser: bySlot(parentRead).browser,
  });
  assert.deepEqual(
    read.skills.map((one) => one.name),
    ["using-it"],
  );
  assert.ok(!s.given.applied.some((one) => one.agent === shared), "no new computer is made");

  const listed = await s.made(tools, "create_worker", { name: "L", purpose: "P.", place });
  assert.deepEqual(bySlot(await s.calls.agents.get({ agent: listed })), { computer: place });
  const nowhere = await tools.call({
    name: "create_worker",
    arguments: { name: "N", purpose: "P.", place: "elsewhere" },
  });
  assert.equal(nowhere.failed, true);

  // The bound below its own reach: sharing would give more than allowed, so it isn't offered.
  const lower = await s.parent(
    { templates: ["worker"], places: ["own"], access: "files" },
    { access: "terminal" },
    "Lower",
  );
  assert.ok(!(await s.names(lower.tools)).includes("create_worker"));
  const none = await s.parent({ templates: ["worker"], places: ["own"] }, undefined, "None");
  assert.ok(!(await s.names(none.tools)).includes("create_worker"), "it has no computer");
});

test("a field no one declared is closed to an agent, and its template's value stands", async (t) => {
  const s = await delegating(t);
  await s.calls.agents.saveTemplate({
    id: "sealed",
    title: "Sealed",
    description: "",
    base: { provider: "Agents", creatable: "plain" },
    units: [{ provider: "Units", unit: "closed", values: { mode: "fixed" } }],
  });
  await s.calls.agents.saveTemplate({
    id: "unsealed",
    title: "Unsealed",
    description: "",
    base: { provider: "Agents", creatable: "plain" },
    units: [{ provider: "Units", unit: "closed" }],
  });
  const { tools } = await s.parent({ templates: ["sealed", "unsealed"] });
  const offered = (await tools.list({})).tools;
  const schema = offered.find((one) => one.name === "create_sealed")?.inputSchema as never as {
    properties: { units: { properties: object } };
  };
  assert.deepEqual(schema.properties.units.properties, {}, "nothing in it to set");
  assert.ok(
    offered.some((one) => one.name === "create_unsealed"),
    "nothing it must set",
  );
  const tried = await tools.call({
    name: "create_sealed",
    arguments: { name: "X", purpose: "P.", units: { closed: { mode: "mine" } } },
  });
  assert.equal(tried.failed, true);
  const child = await s.made(tools, "create_sealed", { name: "Y", purpose: "P." });
  assert.deepEqual(s.given.applied.find((one) => one.agent === child)?.values, { mode: "fixed" });
});

test("a place means nothing on a template with no computer", async (t) => {
  const s = await delegating(t);
  const { tools } = await s.parent(
    { templates: ["helper"] },
    { access: "terminal", browser: true },
  );
  const answer = await tools.call({
    name: "create_helper",
    arguments: { name: "X", purpose: "P.", place: "own" },
  });
  assert.equal(answer.failed, true);
  assert.match(answer.output, /can't work there/);
});

test("a value of the wrong kind can't get past a bound", async (t) => {
  const s = await delegating(t);
  const { tools } = await s.parent({ templates: ["deputy", "helper"], limit: 2, depth: 2 });
  for (const units of [{ limit: "abc" }, { templates: "helper" }, { depth: "1" }]) {
    const answer = await tools.call({
      name: "create_deputy",
      arguments: { name: "X", purpose: "P.", units: { control: units } },
    });
    assert.equal(answer.failed, true, JSON.stringify(units));
  }
  assert.ok(JSON.parse(readFileSync(join(s.dir, "manager.json"), "utf8")));
  assert.equal((await s.calls.agents.list({})).agents.length, 1);
});

test("what a unit runs or reaches is the template's to say, never an agent's", async (t) => {
  const s = await delegating(t);
  const connection = await s.picked();
  const other = await s.picked();
  const on = { provider: "Agents", creatable: "plain" };
  const connect = (values: Record<string, string>) => [
    { provider: "Management", unit: "connection", values },
  ];
  await s.calls.agents.saveTemplate({
    id: "connected",
    title: "Connected",
    description: "",
    base: on,
    units: connect({ connection, slot: "search" }),
  });
  await s.calls.agents.saveTemplate({
    id: "unfilled",
    title: "Unfilled",
    description: "",
    base: on,
    units: connect({ slot: "search" }),
  });
  const { tools } = await s.parent({ templates: ["connected", "unfilled"] });
  const offered = (await tools.list({})).tools;
  assert.ok(!offered.some((one) => one.name === "create_unfilled"));
  const schema = offered.find((one) => one.name === "create_connected")?.inputSchema as never as {
    properties: { units: { properties: object } };
  };
  assert.deepEqual(schema.properties.units.properties, {});
  const changed = await tools.call({
    name: "create_connected",
    arguments: { name: "X", purpose: "P.", units: { connection: { connection: other } } },
  });
  assert.equal(changed.failed, true);
  const child = await s.made(tools, "create_connected", { name: "Y", purpose: "P." });
  assert.equal((await s.calls.agents.get({ agent: child })).mcp[0]?.connection, connection);
});

test("a computer no longer held can't be shared", async (t) => {
  const s = await delegating(t);
  const top = await s.parent(
    { templates: ["deputy", "worker"], places: ["own"], access: "read", depth: 2 },
    { access: "read" },
  );
  await s.calls.agents.saveTemplate({
    id: "deputy",
    title: "Deputy",
    description: "",
    base: { provider: "Agents", creatable: "plain" },
    units: [
      { provider: "Units", unit: "computer", values: { access: "read" } },
      {
        provider: "Management",
        unit: "control",
        values: { templates: ["worker"], places: ["own"], access: "read" },
      },
    ],
  });
  const child = await s.made(top.tools, "create_deputy", {
    name: "Deputy",
    purpose: "P.",
    place: "own",
  });
  const tools = await s.exposedTo<ToolCalls>(child, "control");
  assert.ok((await s.names(tools)).includes("create_worker"));
  await s.calls.agents.removeUnit({ agent: child, instance: "slot:computer" });
  assert.ok(!(await s.names(tools)).includes("create_worker"), "it has nothing left to share");
});

test("a new computer is on its parent's service, and within its bounds", async (t) => {
  const s = await delegating(t);
  const { agent: parent, tools } = await s.parent(
    { templates: ["worker"], places: ["new"], access: "files", browser: false },
    { service: "local", access: "terminal", browser: true },
  );
  const schema = (await tools.list({})).tools[0]?.inputSchema as never as {
    properties: {
      place: { enum: string[] };
      units: { properties: { computer: { properties: Record<string, { enum?: string[] }> } } };
    };
  };
  assert.deepEqual(schema.properties.place.enum, ["new"]);
  const form = schema.properties.units.properties.computer.properties;
  assert.deepEqual(Object.keys(form), ["access"], "no service, folder or browser to choose");
  assert.deepEqual(form.access?.enum, ["none", "read", "files"]);

  const child = await s.made(tools, "create_worker", { name: "N", purpose: "P.", place: "new" });
  const applied = s.given.applied.find((one) => one.agent === child);
  // The template says terminal, and the bound brings it down.
  assert.deepEqual(applied?.values, { service: "local", access: "files", browser: false });
  const own = (await s.calls.agents.get({ agent: parent })).mcp[0]?.connection;
  assert.notEqual((await s.calls.agents.get({ agent: child })).mcp[0]?.connection, own);

  const beyond = async (computer: object, pattern: RegExp) => {
    const answer = await tools.call({
      name: "create_worker",
      arguments: { name: "X", purpose: "P.", place: "new", units: { computer } },
    });
    assert.equal(answer.failed, true);
    assert.match(answer.output, pattern);
  };
  await beyond({ access: "terminal" }, /options/);
  await beyond({ browser: true }, /browser/);
  await beyond({ service: "another" }, /no field service/);
  await beyond({ workspace: "/etc" }, /no field workspace/);

  // Its computer as it is now, not as it was when the unit was filled in.
  const parentUnits = (await s.calls.agents.get({ agent: parent })).units;
  const computer = parentUnits.find((one) => one.unit === "computer");
  await s.calls.agents.removeUnit({ agent: parent, instance: computer?.instance as string });
  await s.calls.agents.addUnit({
    agent: parent,
    unit: s.unit("computer", { service: "local", access: "read" }),
  } as never);
  await beyond({ access: "files" }, /options/);
  const lowered = (await tools.list({})).tools[0]?.inputSchema as never as {
    properties: {
      units: { properties: { computer: { properties: Record<string, { enum?: string[] }> } } };
    };
  };
  assert.deepEqual(lowered.properties.units.properties.computer.properties.access?.enum, [
    "none",
    "read",
  ]);

  // Only on a service here: the token for one elsewhere can't pass through an agent.
  const away = await s.parent(
    { templates: ["worker"], places: ["new"], access: "files" },
    { service: "another", access: "terminal" },
    "Away",
  );
  assert.ok(!(await s.names(away.tools)).includes("create_worker"));
});

test("what an agent can see of connections is what its scope says", async (t) => {
  const s = await delegating(t);
  const connection = await s.picked();
  const { tools } = await s.parent({ templates: ["helper"], agents: "all" }, undefined, "Nosy");
  const other = await s.makeStack([s.own("connection", { connection, slot: "search" })], "Other");
  const got = JSON.parse(
    (await tools.call({ name: "agent_get", arguments: { agent: other } })).output,
  );
  assert.deepEqual(Object.keys(got.mcp[0]).sort(), ["instance", "slot", "status"]);
  const units = JSON.parse((await tools.call({ name: "unit_list", arguments: {} })).output).units;
  const places = units
    .find((one: { id: string }) => one.id === "control")
    .form.find((field: { id: string }) => field.id === "places");
  assert.deepEqual(
    places.options.map((one: { value: string }) => one.value),
    ["own", "new"],
  );
});

test("each scope gives exactly its tools", async (t) => {
  const s = await delegating(t);
  const names = async (values: object, name: string) =>
    (await s.names((await s.parent(values, undefined, name)).tools)).filter(
      (one) => !one.startsWith("create_"),
    );
  assert.deepEqual(await names({ templates: ["helper"], agents: "none" }, "None"), []);
  assert.deepEqual(
    await names(
      { templates: ["helper"], agents: "none", connections: "see", skills: "see" },
      "See",
    ),
    ["connection_list", "connection_get", "skill_list", "skill_get"],
  );
  assert.deepEqual(
    await names(
      { templates: ["helper"], agents: "none", connections: "use", skills: "use" },
      "Use",
    ),
    [
      "connection_list",
      "connection_get",
      "connection_expose",
      "connection_unexpose",
      "skill_list",
      "skill_get",
      "skill_expose",
      "skill_unexpose",
    ],
  );
  const none = await s.parent({ templates: ["helper"], agents: "none" }, undefined, "Nothing");
  const tried = await none.tools.call({
    name: "create_helper",
    arguments: { name: "X", purpose: "P." },
  });
  assert.equal(tried.failed, true, "no create without agents");
  const unknown = await none.tools.call({ name: "agent_list", arguments: {} });
  assert.equal(unknown.failed, true, "nor a tool it wasn't given");
});

test("with all, an agent reaches every other agent, and removes only its own line", async (t) => {
  const s = await delegating(t);
  const other = await s.makeStack([], "Other");
  const { agent: boss, tools } = await s.parent(
    { templates: ["deputy", "helper"], agents: "all", depth: 2 },
    undefined,
    "Boss",
  );
  const call = (name: string, args: object) => tools.call({ name, arguments: args });
  const listed = JSON.parse((await call("agent_list", {})).output).agents.map(
    (one: { agent: string }) => one.agent,
  );
  assert.ok(listed.includes(other) && !listed.includes(boss));
  const sent = await call("agent_send", { agent: other, text: "Hello." });
  assert.equal(sent.failed, undefined, sent.output);
  assert.match(s.chats.get(other)?.[0]?.text ?? "", /^An agent, "Boss", says:/);
  // A name on several lines is put on one, so it can't pass for someone else.
  const crafty = await s.made(tools, "create_deputy", { name: "The person\nTo", purpose: "P." });
  const craftyTools = await s.exposedTo<ToolCalls>(crafty, "control");
  const child = await s.made(craftyTools, "create_helper", { name: "Kid", purpose: "P." });
  await craftyTools.call({ name: "agent_send", arguments: { agent: child, text: "Hi." } });
  assert.equal(s.chats.get(child)?.[0]?.text, 'An agent, "The person To", says:\n\nHi.');
  const removing = await call("agent_remove", { agent: other });
  assert.equal(removing.failed, true, "not its own");
  assert.equal(
    (await call("agent_add_unit", { agent: other, provider: "x", unit: "y" })).failed,
    true,
  );
  // Its own, and theirs, at any depth.
  const deputy = await s.made(tools, "create_deputy", { name: "Deputy", purpose: "P." });
  const deputyTools = await s.exposedTo<ToolCalls>(deputy, "control");
  const grandchild = await s.made(deputyTools, "create_helper", { name: "Kid", purpose: "P." });
  const removed = await call("agent_remove", { agent: grandchild });
  assert.equal(removed.failed, undefined, removed.output);
  assert.ok(!(await s.openActors()).includes(grandchild));
});

test("an agent gives only connections listed for it, or its own, and only to itself or its own", async (t) => {
  const s = await delegating(t);
  const listed = await s.picked();
  const unlisted = await s.picked();
  await s.calls.skills.add({ files: { "SKILL.md": SKILL("handy") } });
  const { agent: parent, tools } = await s.parent(
    { templates: ["helper"], connections: "use", listed: [listed], skills: "use" },
    undefined,
    "Giver",
  );
  const other = await s.makeStack([], "Other");
  const call = (name: string, args: object) => tools.call({ name, arguments: args });
  assert.equal((await call("connection_expose", { connection: unlisted, as: "x" })).failed, true);
  const given = await call("connection_expose", { connection: listed, as: "search" });
  assert.equal(given.failed, undefined, given.output);
  assert.ok((await s.bindingsOf(parent)).some((b) => b.slot === "search" && b.provider === listed));
  assert.equal(
    (await call("connection_expose", { agent: other, connection: listed, as: "x" })).failed,
    true,
    "not to another's agent",
  );
  const child = await s.made(tools, "create_helper", { name: "Kid", purpose: "P." });
  assert.equal(
    (await call("connection_expose", { agent: child, connection: listed, as: "s" })).failed,
    undefined,
  );
  assert.equal((await call("skill_expose", { agent: child, skill: "handy" })).failed, undefined);
  assert.deepEqual(
    (await s.calls.agents.get({ agent: child })).skills.map((one) => one.name),
    ["handy"],
  );
  // A skill's name is held to the interface's own, so it can't reach outside the library.
  for (const skill of ["../../../elsewhere", "..", "handy/../x"]) {
    assert.equal((await call("skill_expose", { skill })).failed, true, skill);
    assert.equal((await call("skill_get", { name: skill })).failed, true, skill);
  }
  // Its own control slot can't be taken away by it.
  assert.equal((await call("connection_unexpose", { slot: "control" })).failed, true);
  assert.equal((await call("connection_unexpose", { slot: "search" })).failed, undefined);
});

test("a unit an agent adds is held to what it may set", async (t) => {
  const s = await delegating(t);
  const { tools } = await s.parent({ templates: ["helper"] });
  const child = await s.made(tools, "create_helper", { name: "Kid", purpose: "P." });
  const add = (values: object, unit = "files") =>
    tools.call({
      name: "agent_add_unit",
      arguments: { agent: child, provider: s.unitsActor.actorId, unit, values },
    });
  assert.equal((await add({ folder: "/a" })).failed, undefined);
  assert.equal((await s.calls.agents.get({ agent: child })).units.length, 1);
  assert.match((await add({ mode: "x" }, "closed")).output, /can't set/);
  assert.match(
    (await add({ access: "terminal" }, "computer")).output,
    /only when an agent is made/,
  );
});

test("the control log keeps each change and each refusal, never what was said", async (t) => {
  const s = await delegating(t);
  const { agent: parent, tools } = await s.parent({ templates: ["helper"] });
  const child = await s.made(tools, "create_helper", { name: "Kid", purpose: "P." });
  const words = `words-${crypto.randomUUID()}`;
  await tools.call({ name: "agent_send", arguments: { agent: child, text: words } });
  await tools.call({ name: "agent_list", arguments: {} });
  await tools.call({ name: "agent_remove", arguments: { agent: "act_nobody" } });
  const { entries } = await s.calls.agents.activity({});
  assert.deepEqual(
    entries.map((one) => [one.caller, one.tool, one.target, one.outcome]),
    [
      [parent, "agent_remove", "act_nobody", "refused"],
      [parent, "agent_send", child, "done"],
      [parent, "create_helper", child, "done"],
    ],
  );
  assert.match(entries[0]?.reason ?? "", /no agent/);
  assert.ok(!JSON.stringify(entries).includes(words));
  assert.ok(!readFileSync(join(s.dir, "activity.jsonl"), "utf8").includes(words));
  assert.deepEqual(
    (await s.calls.agents.activity({ agent: child })).entries.map((one) => one.tool),
    ["agent_send", "create_helper"],
  );
  const page = await s.calls.agents.activity({ limit: 1 });
  assert.equal(page.more, true);
  assert.equal(
    (await s.calls.agents.activity({ before: page.entries[0]?.seq })).entries[0]?.tool,
    "agent_send",
  );
});

test("a child's control unit holds no more than its parent's, scope by scope", async (t) => {
  const s = await delegating(t);
  const { tools } = await s.parent(
    { templates: ["deputy", "helper"], depth: 2, connections: "see", skills: "use" },
    undefined,
    "Scoped",
  );
  const beyond = async (values: object) =>
    (
      await tools.call({
        name: "create_deputy",
        arguments: { name: "More", purpose: "P.", units: { control: values } },
      })
    ).failed;
  assert.equal(await beyond({ agents: "all" }), true);
  assert.equal(await beyond({ connections: "use" }), true);
  assert.equal(await beyond({ skills: "add" }), true);
  assert.equal(await beyond({ saveTemplates: true }), true);
  const deputy = await s.made(tools, "create_deputy", {
    name: "Deputy",
    purpose: "P.",
    units: { control: { skills: "see" } },
  });
  const values = (await s.calls.agents.get({ agent: deputy })).units.find(
    (one) => one.unit === "control",
  )?.values;
  assert.deepEqual([values?.connections, values?.skills], ["none", "see"]);
});

test("an agent adds a connection by public address only, and it goes with the agent", async (t) => {
  const s = await delegating(t);
  const { agent, tools } = await s.parent(
    { templates: ["helper"], connections: "add" },
    undefined,
    "Adder",
  );
  const call = async (name: string, args: object) => {
    const answer = await tools.call({ name, arguments: args });
    return { ...answer, value: answer.failed ? undefined : JSON.parse(answer.output) };
  };
  const added = await call("connection_add", { name: "Search", url: "https://mcp.example.com/" });
  assert.equal(added.failed, undefined, added.output);
  const { connection } = added.value;
  assert.deepEqual(s.given.applied.at(-1)?.values, {
    url: "https://mcp.example.com/",
    public: true,
    slot: "tools",
  });
  assert.deepEqual(s.given.applied.at(-1)?.secrets, {}, "no token");
  const origin = (await s.calls.connections.get({ connection })).origin;
  assert.deepEqual([origin?.madeBy, origin?.madeFor], [agent, agent]);
  // Its own, so it may give it, without its being listed.
  const given = await call("connection_expose", { connection, as: "search" });
  assert.equal(given.failed, undefined, given.output);
  // One it didn't make isn't its to remove.
  const theirs = await s.picked();
  assert.equal((await call("connection_remove", { connection: theirs })).failed, true);
  assert.ok((await s.openActors()).includes(theirs));
  // It goes with the agent.
  await s.calls.agents.remove({ agent });
  assert.ok(!(await s.openActors()).includes(connection));
  await assert.rejects(s.calls.connections.get({ connection }), refused("unknown"));
});

test("an agent's skill takes no name there is, and only it and its agents see it", async (t) => {
  const s = await delegating(t);
  await s.calls.skills.add({ files: { "SKILL.md": SKILL("terminal", "The person's.") } });
  const { tools } = await s.parent(
    { templates: ["deputy"], skills: "add", depth: 2 },
    undefined,
    "Writer",
  );
  const call = (name: string, args: object) => tools.call({ name, arguments: args });
  const taken = await call("skill_add", { files: { "SKILL.md": SKILL("terminal", "Mine now.") } });
  assert.equal(taken.failed, true);
  assert.match((await s.calls.skills.get({ name: "terminal" })).text, /The person's/);
  const written = await call("skill_add", { files: { "SKILL.md": SKILL("notes-of-mine") } });
  assert.equal(written.failed, undefined, written.output);
  const seen = async (agentTools: ToolCalls) =>
    JSON.parse((await agentTools.call({ name: "skill_list", arguments: {} })).output).skills.map(
      (one: { name: string }) => one.name,
    );
  assert.ok((await seen(tools)).includes("notes-of-mine"));
  const deputy = await s.made(tools, "create_deputy", {
    name: "Deputy",
    purpose: "P.",
    units: { control: { skills: "see" } },
  });
  assert.ok(
    (await seen(await s.exposedTo<ToolCalls>(deputy, "control"))).includes("notes-of-mine"),
  );
  const other = await s.parent({ templates: ["helper"], skills: "add" }, undefined, "Other");
  assert.ok(!(await seen(other.tools)).includes("notes-of-mine"));
  assert.equal(
    (await other.tools.call({ name: "skill_get", arguments: { name: "notes-of-mine" } })).failed,
    true,
  );
  assert.equal(
    (await other.tools.call({ name: "skill_remove", arguments: { name: "notes-of-mine" } })).failed,
    true,
  );
  assert.equal(
    (await other.tools.call({ name: "skill_remove", arguments: { name: "terminal" } })).failed,
    true,
  );
  // Nor can another give it to itself, by name.
  assert.equal(
    (await other.tools.call({ name: "skill_expose", arguments: { skill: "notes-of-mine" } }))
      .failed,
    true,
  );
  // The person sees everything.
  assert.ok((await s.calls.skills.list({})).skills.some((one) => one.name === "notes-of-mine"));
  // Replaced by the person, it's the person's: the agent can no longer remove it.
  await s.calls.skills.add({ files: { "SKILL.md": SKILL("notes-of-mine", "The person's now.") } });
  assert.equal((await call("skill_remove", { name: "notes-of-mine" })).failed, true);
  assert.ok((await seen(other.tools)).includes("notes-of-mine"), "and everyone sees it");
});

test("an agent's template is its own, runs nothing, and stays within its bounds", async (t) => {
  const s = await delegating(t);
  const { tools } = await s.parent(
    { templates: ["helper"], saveTemplates: true, depth: 2, limit: 2 },
    undefined,
    "Saver",
  );
  const save = (template: object) => tools.call({ name: "template_save", arguments: { template } });
  const on = { provider: "Agents", creatable: "plain" };
  const template = (id: string, units: object[] = []) => ({
    id,
    title: id,
    description: "",
    base: on,
    units,
  });
  assert.match((await save(template("helper"))).output, /already/);
  assert.match(
    (
      await save(
        template("runs", [{ provider: "Units", unit: "runner", values: { program: "x" } }]),
      )
    ).output,
    /can't set Program/,
  );
  // Its template holds only what it could have given itself.
  const connection = await s.picked();
  for (const units of [
    [
      {
        provider: "Management",
        unit: "mcp",
        values: { how: "url", url: "http://127.0.0.1:9", slot: "h" },
      },
    ],
    [{ provider: "Management", unit: "connection", values: { connection, slot: "theirs" } }],
    [{ provider: "Management", unit: "skill", values: { skill: "anything" } }],
  ])
    assert.match((await save(template("sneak", units))).output, /can't set/);
  assert.equal(
    (
      await save(
        template("bigger", [
          { provider: "Management", unit: "control", values: { templates: ["helper"], limit: 5 } },
        ]),
      )
    ).failed,
    true,
  );
  assert.equal(
    (
      await save(
        template("deeper", [
          { provider: "Management", unit: "control", values: { templates: ["helper"], depth: 2 } },
        ]),
      )
    ).failed,
    true,
  );
  const mine = await save(
    template("mine", [{ provider: "Units", unit: "files", values: { folder: "/m" } }]),
  );
  assert.equal(mine.failed, undefined, mine.output);
  // It can create from it, though the person didn't list it.
  assert.ok((await s.names(tools)).includes("create_mine"));
  await s.made(tools, "create_mine", { name: "M", purpose: "P." });
  // Not another's to remove, nor the person's.
  const other = await s.parent({ templates: ["helper"], saveTemplates: true }, undefined, "Other");
  for (const id of ["mine", "helper"])
    assert.equal(
      (await other.tools.call({ name: "template_remove", arguments: { id } })).failed,
      true,
      id,
    );
  assert.equal(
    (await tools.call({ name: "template_remove", arguments: { id: "mine" } })).failed,
    undefined,
  );
  // Without the scope, there's no such tool.
  const plain = await s.parent({ templates: ["helper"] }, undefined, "Plain");
  assert.ok(!(await s.names(plain.tools)).includes("template_save"));
});

test("a unit's surfaces show on its agent, and only the person gets a ticket to one", async (t) => {
  const s = await delegating(t);
  const agent = await s.makeStack([s.unit("machine")]);
  const [unit] = (await s.calls.agents.get({ agent })).units;
  assert.deepEqual(unit?.status.surfaces, [
    { surface: "screen", protocol: "stand-in@1", operate: true },
  ]);
  const ticket = await s.calls.agents.live({
    agent,
    instance: unit?.instance as string,
    surface: "screen",
    mode: "operate",
  });
  assert.equal(ticket.protocol, "stand-in@1");
  assert.match(ticket.url, /\/operate$/);
  await assert.rejects(
    s.calls.agents.live({ agent, instance: "uni_none", surface: "screen", mode: "watch" }),
    refused("unknown"),
  );
  await assert.rejects(
    s.calls.agents.live({
      agent,
      instance: unit?.instance as string,
      surface: "nothing",
      mode: "watch",
    }),
    refused("unknown"),
  );
  // No control scope gives an agent one.
  const { tools } = await s.parent(
    {
      templates: ["helper"],
      agents: "all",
      connections: "add",
      skills: "add",
      saveTemplates: true,
    },
    undefined,
    "Everything",
  );
  assert.ok(!(await s.names(tools)).some((name) => name.includes("live")));
});

test("a parent's agents stay when it goes, as the person's", async (t) => {
  const s = await delegating(t);
  const { agent: parent, tools } = await s.parent({ templates: ["helper"] });
  const child = await s.made(tools, "create_helper", { name: "Kid", purpose: "P." });
  await s.calls.agents.remove({ agent: parent });
  assert.ok((await s.openActors()).includes(child));
  assert.deepEqual((await s.calls.agents.get({ agent: child })).parent, {
    agent: parent,
    name: "Parent",
    gone: true,
  });
  const entry = (await s.calls.agents.list({})).agents.find((one) => one.agent === child);
  assert.equal(entry?.parent?.gone, true);
  await s.calls.agents.remove({ agent: child });
});

test("an agent that can't be made leaves nothing, and its unit goes alone", async (t) => {
  const s = await delegating(t);
  const { agent: parent, tools } = await s.parent({ templates: ["prefilled"] });
  const actors = await s.openActors();
  s.script.fail = "apply";
  const failed = await tools.call({
    name: "create_prefilled",
    arguments: { name: "X", purpose: "P." },
  });
  assert.equal(failed.failed, true);
  delete s.script.fail;
  assert.deepEqual(await s.openActors(), actors);
  const unit = (await s.calls.agents.get({ agent: parent })).units[0];
  await s.calls.agents.removeUnit({ agent: parent, instance: unit?.instance as string });
  const after = await s.calls.agents.get({ agent: parent });
  assert.deepEqual([after.units, after.mcp, after.skills], [[], [], []]);
  assert.ok((await s.openActors()).includes(s.management.actorId), "management stays");
});

test("an agent holds the capability its unit builds, and the person reaches it by slots of their own", async (t) => {
  const s = await setup(t);
  const { agent } = await s.calls.agents.create({
    stack: { base: s.base, units: [s.unit("desk", { lamp: true })] },
    name: "Holder",
  });
  const got = await s.calls.agents.get({ agent });
  const capabilities = got.capabilities ?? [];
  assert.equal(capabilities.length, 1);
  const [{ person, ...held }] = capabilities as [(typeof capabilities)[number]];
  // What it is, from what the unit says it gives and what was filled in: the views in the
  // order given, the one with neither an operation nor a surface with the rows fixed then.
  assert.deepEqual(held, {
    id: "desk",
    title: "Desk",
    from: got.units.find((unit) => unit.unit === "desk")?.instance,
    slots: ["desk"],
    surfaces: [
      { surface: "top", protocol: "stand-in@1" },
      { surface: "lamp", protocol: "stand-in@1" },
    ],
    views: [
      {
        id: "where",
        place: "column",
        kind: "facts",
        fixed: [{ label: "Where", value: "By the window" }],
      },
      {
        id: "about",
        place: "column",
        kind: "facts",
        operation: "about",
        slot: "desk",
        rows: ["Wood"],
      },
      {
        id: "status",
        place: "frame",
        kind: "status",
        when: "reachable",
        operation: "status",
        slot: "desk",
      },
      { id: "glow", place: "column", kind: "meters", surface: "lamp" },
    ],
  });
  // The person's own slots: one bound to the capability itself, which answers how it stands,
  // and one to each of its operations, which the agent has under its own slot.
  const itself = await s.personSlot<{
    state(input: object): Promise<{ state: string; surfaces: { surface: string }[] }>;
  }>(person.capability);
  assert.deepEqual(await itself.state({}), {
    state: "connected",
    surfaces: [{ surface: "top", protocol: "stand-in@1", operate: true }],
  });
  const bound = async (to: string) =>
    (await s.bindingsOf(to)).map((b) => `${b.slot} ${b.provider} ${b.export}`);
  const [operations] = (await s.bindingsOf(agent)).filter((b) => b.slot === "desk");
  assert.ok(operations);
  assert.ok(
    (await bound(PERSON)).includes(`${person.operations.desk} ${operations.provider} tools`),
  );
  assert.deepEqual(Object.keys(person.operations), ["desk"]);

  // An agent built from units that build none holds none.
  const { agent: plain } = await s.calls.agents.create({
    stack: { base: s.base, units: [s.unit("files", { folder: "/a" })] },
    name: "Plain",
  });
  assert.deepEqual((await s.calls.agents.get({ agent: plain })).capabilities, []);

  // Removing the unit takes the capability, and the person's slots to it.
  await s.calls.agents.removeUnit({ agent, instance: held.from });
  assert.deepEqual((await s.calls.agents.get({ agent })).capabilities, []);
  const left = (await s.bindingsOf(PERSON)).map((b) => b.slot);
  assert.equal(left.includes(person.capability), false);
  assert.equal(left.includes(person.operations.desk as string), false);
});

test("a unit that doesn't build the capability, or give the rows, it said it would is undone", async (t) => {
  const s = await setup(t);
  const before = await s.openActors();
  const slots = async () => (await s.bindingsOf(PERSON)).map((b) => b.slot).sort();
  const had = await slots();
  const create = () =>
    s.calls.agents.create({ stack: { base: s.base, units: [s.unit("desk")] }, name: "Holder" });
  const saying = (message: string) => (error: unknown) =>
    refused("failed")(error) && (error as Error).message === message;
  s.script.noCapability = true;
  await assert.rejects(create(), saying("Desk didn't build the Desk it said it would."));
  s.script.noCapability = false;
  // No rows for the view whose rows are fixed; then rows for a view that has an operation.
  s.script.rows = {};
  await assert.rejects(create(), saying('Desk gave no rows for its view "where".'));
  s.script.rows = {
    where: [{ label: "Where", value: "By the window" }],
    about: [{ label: "Wood", value: "Oak" }],
  };
  await assert.rejects(
    create(),
    saying('Desk gave rows for "about", which is not a view of its whose rows are fixed.'),
  );
  // Each time everything made is gone: the connection, the capability's Actor, the person's slots.
  assert.deepEqual([...(await s.openActors()).keys()].sort(), [...before.keys()].sort());
  assert.deepEqual(await slots(), had);
});

test("an agent holds one of a capability: a second is a problem before anything runs", async (t) => {
  const s = await setup(t);
  const twice = await s.calls.agents.check({
    stack: { base: s.base, units: [s.unit("desk"), s.unit("desk")] },
  });
  assert.ok(twice.problems.some((one) => one.message === "There is a Desk already."));
  const { agent } = await s.calls.agents.create({
    stack: { base: s.base, units: [s.unit("desk")] },
    name: "Holder",
  });
  const more = await s.calls.agents.check({ agent, unit: s.unit("desk") });
  assert.ok(more.problems.some((one) => one.message === "There is a Desk already."));
  await assert.rejects(s.calls.agents.addUnit({ agent, unit: s.unit("desk") }), refused("invalid"));
  assert.equal(s.given.applied.filter((one) => one.unit === "desk").length, 1, "applied once");
});

test("a unit that can't go keeps the person's slots to what it built; one whose provider won't undo it leaves no Actor", async (t) => {
  const s = await setup(t);
  const { agent } = await s.calls.agents.create({
    stack: { base: s.base, units: [s.unit("desk")] },
    name: "Holder",
  });
  const [held] = (await s.calls.agents.get({ agent })).capabilities ?? [];
  assert.ok(held);
  const slots = async () => (await s.bindingsOf(PERSON)).map((b) => b.slot);
  s.script.fail = "unit.remove";
  await assert.rejects(s.calls.agents.removeUnit({ agent, instance: held.from }));
  // It stays whole: the agent holds it, and the person still reaches it.
  assert.deepEqual((await s.calls.agents.get({ agent })).capabilities, [held]);
  const there = await slots();
  assert.ok(there.includes(held.person.capability));
  assert.ok(there.includes(held.person.operations.desk as string));
  delete s.script.fail;
  await s.calls.agents.removeUnit({ agent, instance: held.from });
  assert.equal((await slots()).includes(held.person.capability), false);

  // A creation undone while the provider refuses to remove what it made: management closes the
  // Actors itself, the capability's with the connection's.
  const before = [...(await s.openActors()).keys()].sort();
  s.script.rows = {};
  s.script.fail = "unit.remove";
  await assert.rejects(
    s.calls.agents.create({ stack: { base: s.base, units: [s.unit("desk")] }, name: "Undone" }),
    refused("failed"),
  );
  assert.deepEqual([...(await s.openActors()).keys()].sort(), before);
});

test("a view that shows a surface, or is at a slot, its unit doesn't give is a problem before anything runs", async (t) => {
  const s = await setup(t);
  const { problems } = await s.calls.agents.check({
    stack: { base: s.base, units: [s.unit("askew")] },
  });
  assert.deepEqual(
    problems.map((one) => one.message),
    [
      "Askew's view \"glow\" shows a surface it doesn't give: lamp.",
      "Askew's view \"about\" is at a slot it doesn't give: elsewhere.",
    ],
  );
  await assert.rejects(
    s.calls.agents.create({ stack: { base: s.base, units: [s.unit("askew")] }, name: "No" }),
    refused("invalid"),
  );
  assert.equal(s.given.applied.length, 0);
});

test("removing a unit takes off only the person's slots that are still its own", async (t) => {
  const s = await setup(t);
  const { agent } = await s.calls.agents.create({
    stack: { base: s.base, units: [s.unit("desk")] },
    name: "Holder",
  });
  const { agent: other } = await s.calls.agents.create({
    stack: { base: s.base, units: [s.unit("files", { folder: "/a" })] },
    name: "Other",
  });
  const [held] = (await s.calls.agents.get({ agent })).capabilities ?? [];
  assert.ok(held);
  // The Hub dropped the person's slot, and its name has since been given to another export.
  const [files] = (await s.bindingsOf(other)).filter((b) => b.slot === "files");
  assert.ok(files);
  await s.person.slots.grants.call.unexpose({ to: PERSON, slot: held.person.capability });
  await s.person.slots.grants.call.expose({
    provider: files.provider,
    export: "tools",
    to: PERSON,
    as: held.person.capability,
  });
  await s.calls.agents.removeUnit({ agent, instance: held.from });
  const left = (await s.bindingsOf(PERSON)).filter((b) => b.slot === held.person.capability);
  assert.deepEqual(
    left.map((b) => b.provider),
    [files.provider],
    "the other export keeps the name",
  );
});

test("the person's slots to what an agent holds are made again when the Hub has dropped one", async (t) => {
  const s = await setup(t);
  const { agent } = await s.calls.agents.create({
    stack: { base: s.base, units: [s.unit("desk")] },
    name: "Holder",
  });
  const [held] = (await s.calls.agents.get({ agent })).capabilities ?? [];
  assert.ok(held);
  await s.person.slots.grants.call.unexpose({ to: PERSON, slot: held.person.capability });
  await s.person.slots.grants.call.unexpose({
    to: PERSON,
    slot: held.person.operations.desk as string,
  });
  // Management looks at what agents hold when it comes back, as it does for their chats.
  await s.restart(() => {});
  const again = async () => {
    const [now] = (await s.calls.agents.get({ agent })).capabilities ?? [];
    const there = (await s.bindingsOf(PERSON)).map((b) => b.slot);
    return now &&
      there.includes(now.person.capability) &&
      there.includes(now.person.operations.desk as string)
      ? now
      : undefined;
  };
  let now = await again();
  for (let waited = 0; !now && waited < 15_000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    now = await again();
  }
  assert.ok(now, "both slots are the person's again");
  const itself = await s.personSlot<{ state(input: object): Promise<{ state: string }> }>(
    now?.person.capability as string,
  );
  assert.equal((await itself.state({})).state, "connected");
});
