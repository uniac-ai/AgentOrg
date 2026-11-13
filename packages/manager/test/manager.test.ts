import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { defineInterface, type Interface, method, Refused, type Slot } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { z } from "zod";
import { SKILL_SHIPPED, skillFile } from "../src/control.ts";
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
/** What an agent of the `working` creatable holds of itself, served by the agent. */
const WORK = {
  id: "work",
  title: "Activity",
  views: [{ id: "activity", place: "column", kind: "activity", operation: "work", slot: "work" }],
};
const CREATABLES = [
  { id: "plain", title: "Plain", description: "No needs.", instructions: "Be plain.", asks: [] },
  {
    id: "asking",
    title: "Asking",
    description: "Asks one thing.",
    instructions: "Be asked.",
    asks: [{ id: "folder", title: "Folder" }],
  },
  {
    id: "working",
    title: "Working",
    description: "Holds its own work.",
    instructions: "Work.",
    asks: [],
    capability: WORK,
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
    once: true,
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
    id: "badge",
    title: "Badge",
    description: "Gives nothing, so only `once` keeps a second out.",
    once: true,
    form: [],
    needs: [],
    gives: { slots: [], skills: [], results: [] },
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
  /** What management logged as information. */
  const logged: string[] = [];
  const startManagement = () =>
    startManager({
      hubUrl: server.url,
      actorId: management.actorId,
      credential: management.credential as string,
      dir,
      log: { info: (line) => logged.push(line), warn: () => {}, error: () => {} },
    });
  let manager = await startManagement();
  leaving.push(() => manager.close());

  /** What the stand-ins should do wrong, and what they were given. */
  const script: {
    fail?: string;
    alsoFail?: string;
    settings?: string;
    chat?: string;
    /** Parties whose conversation's turn failed. */
    failed?: string[];
    /** Its agents refuse a message, as a stopped one does. */
    busy?: boolean;
    /** Whether an agent says it is working. */
    working?: boolean;
    noTools?: boolean;
    skillName?: string;
    /** The text of the skills it serves, and the sha256 of earlier texts it says it shipped. */
    skillText?: string;
    shipped?: string[];
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
  /** Every message sent to each agent, in the order they came, whoever sent it. */
  const chats = new Map<string, { text: string; with: string }[]>();
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
            // What a `working` agent holds of itself it serves as these.
            exports: { chat, capability, tools },
            start(own) {
              contexts.set(actorId, own as never);
              const said: { id: string; role: "user"; text: string; at: string; with: string }[] =
                [];
              chats.set(actorId, said);
              const failed = (party: string) => (script.failed ?? []).includes(party);
              own.exports.chat.implement({
                // A message is in the caller's conversation, as the engine keeps it.
                send({ text = "" }, { caller }) {
                  if (script.busy) throw new Refused("busy", "It is stopped.");
                  const id = `m-${said.length + 1}`;
                  said.push({ id, role: "user", text, at: new Date().toISOString(), with: caller });
                  return { messageId: id };
                },
                history({ with: party }, { caller }) {
                  const of = party ?? caller;
                  return {
                    messages: said
                      .filter((one) => one.with === of)
                      .map(({ with: _, ...message }) => message),
                    more: false,
                  };
                },
                // The agent is working when a test says so.
                state: () => ({ state: script.working ? ("working" as const) : ("idle" as const) }),
                list(_, { caller }) {
                  const parties = [...new Set(said.map((one) => one.with))]
                    .filter((party) => caller === "person" || party === caller)
                    .reverse();
                  return {
                    conversations: parties.map((party) => {
                      const theirs = said.filter((one) => one.with === party);
                      const last = theirs.at(-1) as (typeof said)[number];
                      return {
                        with: party,
                        at: theirs[0]?.at ?? last.at,
                        latest: {
                          id: last.id,
                          at: last.at,
                          role: "user" as const,
                          text: last.text.slice(0, 200),
                        },
                        // A party a test names as failed has that problem.
                        ...(failed(party)
                          ? { problem: { code: "usage_limit", message: "Usage limit reached." } }
                          : {}),
                      };
                    }),
                    more: false,
                  };
                },
              });
              own.slots.settings.on("changed", () => {
                heard.set(actorId, (heard.get(actorId) ?? 0) + 1);
              });
              // Its Work, as the Assistant serves it: one operation.
              own.exports.tools.implement({
                list: () => ({ tools: [{ name: "work", inputSchema: { type: "object" } }] }),
                call: () => ({ output: `The work of ${name}.` }),
                stop: () => ({}),
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
          return {
            text:
              path === "SKILL.md" ? SKILL(script.skillName ?? name, script.skillText) : "A guide.",
            ...(script.shipped ? { shipped: script.shipped } : {}),
          };
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
  const rejoin = async (
    agent: string,
    offered: Interface,
    more: Record<string, Interface> = {},
  ) => {
    running.get(agent)?.close();
    const client = await connect({
      hubUrl: server.url,
      actorId: agent,
      credential: credentials.get(agent) as string,
      slots: { settings: agentSettings },
      exports: { chat: offered, ...more },
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
    /** An agent's connection goes, as when its provider stops. */
    leave: (agent: string) => running.get(agent)?.close(),
    exposedTo,
    personSlot,
    chats,
    hub,
    person,
    dir,
    script,
    logged,
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
      ["working", s.agentActor.actorId],
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

test("an agent that comes back offering its chats in another shape keeps the person's slot to them", async (t) => {
  const s = await setup(t);
  const agent = await s.makeFull(await s.picked());
  const reached = async () =>
    (await s.bindingsOf(PERSON)).filter((b) => b.provider === agent && b.export === "chat");
  /** The person's exposures of the agent's chats in the audit: made once, never again. */
  const exposed = () =>
    s.hub.state
      .audit(0, 10_000)
      .entries.filter((entry) => entry.kind === "expose" && entry.details.provider === agent)
      .length;
  const [before] = await reached();
  assert.ok(before);
  const made = exposed();
  // The person's slot was made by expose, so it follows the chats' new shape: nothing is dropped.
  const reshaped = defineInterface({
    name: "chat",
    major: 1,
    kind: "rpc",
    methods: { ...chat.methods, more: method({ input: z.object({}), output: z.object({}) }) },
    events: chat.events,
  });
  await s.rejoin(agent, reshaped);
  // The same binding, under the name it had, so what the person's pages keep by slot still holds,
  // and whole: the person's slot took the chats' new shape.
  assert.deepEqual(
    (await reached()).map((b) => [b.slot, b.at, b.mismatched]),
    [[before.slot, before.at, undefined]],
  );
  assert.equal(exposed(), made, "nothing made again");

  // And when the agent came back while management was away, as it does when the app starts.
  await s.restart(() => s.rejoin(agent, chat));
  assert.deepEqual(
    (await reached()).map((b) => [b.slot, b.at, b.mismatched]),
    [[before.slot, before.at, undefined]],
  );
  assert.equal(exposed(), made, "nothing made again");
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
  assert.equal(bySlot.search?.instance, undefined, "the person's own: no unit gave it");
  assert.equal(bySlot.files?.origin?.madeFor, agent);
  assert.equal(bySlot.files?.origin?.madeBy, s.callerActor.actorId);
  assert.equal(bySlot.files?.origin?.kind, "files");
  assert.equal(bySlot.files?.origin?.target, "a stand-in server");
  assert.equal(bySlot.files?.instance, files?.instance);
  assert.deepEqual(bySlot.files?.status, { state: "connected", tools: [{ name: "read" }] });
  // The connection picked is the person's own, no unit of the stack.
  assert.deepEqual(
    read.units.map((one) => one.unit),
    ["files"],
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
  // The connection there is is an exposure, and no unit; the one made is.
  assert.deepEqual(
    read.units.map((one) => [one.unit, one.title, one.provider, one.values]),
    [["mcp", "MCP", s.management.actorId, { how: "stand-in", url: "x", slot: "served" }]],
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
  await s.calls.agents.unexpose({ agent, slot: "search" });
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
      ["working", "Agents"],
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
      ["badge", "Units"],
      ["terminal", "Units"],
      ["computer", "Units"],
      ["runner", "Units"],
      ["closed", "Units"],
      ["vault", "Units"],
    ],
  );
  // What a host reads to leave a unit out of a stack that has it.
  assert.deepEqual(
    units.filter((one) => one.once).map((one) => one.id),
    ["desk", "badge"],
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

test("the Skill and Connection units are exposures: no unit of the stack gave them, and they read back as the person's own", async (t) => {
  const s = await setup(t);
  await s.calls.skills.add({ files: { "SKILL.md": SKILL("handy") } });
  const connection = await s.picked();
  const agent = await s.makeStack([
    s.own("skill", { skill: "handy" }),
    s.own("connection", { connection, slot: "search" }),
  ]);
  const read = await s.calls.agents.get({ agent });
  assert.deepEqual(read.units, []);
  assert.deepEqual(
    read.skills.map((one) => [one.name, one.instance]),
    [["handy", undefined]],
  );
  assert.deepEqual(
    read.mcp.map((one) => [one.slot, one.connection, one.instance]),
    [["search", connection, undefined]],
  );
  // No record of a unit: it is what is exposed. An exposure made by hand reads the same way.
  const kept = JSON.parse(readFileSync(join(s.dir, "manager.json"), "utf8"));
  assert.deepEqual(kept.agents[agent].units, []);

  await s.calls.agents.unexpose({ agent, skill: "handy" });
  await s.calls.agents.unexpose({ agent, slot: "search" });
  const after = await s.calls.agents.get({ agent });
  assert.deepEqual([after.units, after.skills, after.mcp], [[], [], []]);
  // Added to a living agent, the instance it is given takes it off again.
  const { instance } = await s.calls.agents.addUnit({
    agent,
    unit: s.own("skill", { skill: "handy" }),
  } as never);
  assert.deepEqual(
    (await s.calls.agents.get({ agent })).skills.map((one) => [one.name, one.instance]),
    [["handy", undefined]],
  );
  await s.calls.agents.removeUnit({ agent, instance });
  assert.deepEqual((await s.calls.agents.get({ agent })).skills, []);
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
  // Two calls sent together reach management in either order: the Hub checks each on its own.
  // One is made; the other finds the skill already given and is refused.
  const both = await Promise.allSettled([
    s.calls.agents.addUnit({ agent, unit: skill } as never),
    s.calls.agents.addUnit({ agent, unit: skill } as never),
  ]);
  assert.deepEqual(both.map((one) => one.status).sort(), ["fulfilled", "rejected"]);
  const refusal = both.find((one) => one.status === "rejected")?.reason as Error;
  assert.equal(refusal.message, "Two units give the skill handy.");
  assert.equal((await s.calls.agents.get({ agent })).skills.length, 1);

  // Removing the agent waits for a unit being added, so the unit goes with it. The removal is
  // sent from inside the apply, so the addition is already under way; the apply stays open 50 ms
  // so the removal reaches management meanwhile. If it arrives later, the test passes without
  // showing the wait.
  let removing: Promise<unknown> | undefined;
  s.script.during = async () => {
    delete s.script.during;
    removing = s.calls.agents.remove({ agent });
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  await s.calls.agents.addUnit({ agent, unit: s.unit("machine") });
  await removing;
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

test("a connection the Connection unit gives stands as the connection does", async (t) => {
  const s = await setup(t);
  const connection = await s.picked();
  const agent = await s.makeStack([s.own("connection", { connection, slot: "search" })]);
  const state = async () => (await s.calls.agents.get({ agent })).mcp[0]?.status.state;
  assert.equal(await state(), "connected");
  const { bindings } = await s.person.slots.bindings.call.list({ actor: s.management.actorId });
  const slot = bindings.find((b) => b.provider === s.unitsActor.actorId)?.slot as string;
  await s.person.slots.grants.call.unexpose({ to: s.management.actorId, slot });
  for (let i = 0; (await state()) !== "down"; i++) {
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
  assert.deepEqual(read.units, []);
  assert.deepEqual(
    read.mcp.map((one) => [one.slot, one.instance, one.status.state]),
    [["search", undefined, "connected"]],
  );
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

/** An agent's conversations, as another agent reaches them. */
type ChatCalls = Slot<typeof chat>["call"];

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

test("an agent that manages its own talks to each it made, and reads its Work while it is connected", async (t) => {
  const s = await delegating(t);
  await s.calls.agents.saveTemplate({
    id: "workhand",
    title: "workhand",
    description: "The workhand.",
    base: { provider: "Agents", creatable: "working" },
    units: [],
  });
  const { agent: parent, tools: manages } = await s.parent({ templates: ["workhand", "helper"] });
  const kid = await s.made(manages, "create_workhand", { name: "Kid", purpose: "Do a part." });
  const slot = `work_${kid}`;
  /** The maker's slots to the agents it made, by kind: their Work, or their conversations. */
  const reachedBy = async (kind: "work_" | "chat_") =>
    (await s.bindingsOf(parent))
      .filter((one) => one.consumer === parent && one.slot.startsWith(kind))
      .map((one) => [one.slot, one.provider]);
  const reached = () => reachedBy("work_");
  // Reached once it is made, under its id.
  assert.deepEqual(await reached(), [[slot, kid]]);
  const work = await s.exposedTo<ToolCalls>(parent, slot);
  assert.deepEqual(
    (await work.list({})).tools.map((one) => one.name),
    ["work"],
  );
  assert.deepEqual(await work.call({ name: "work", arguments: {} }), {
    output: "The work of Kid.",
  });
  assert.match((await s.calls.skills.get({ name: "delegating" })).text, /`work_<its id>__work`/);
  // No page shows it as one of the maker's connections.
  assert.deepEqual(
    (await s.calls.agents.get({ agent: parent })).mcp.map((one) => one.slot),
    ["control"],
  );
  // One whose creatable gives it no Work isn't reached for it; every one is for its conversations.
  const plain = await s.made(manages, "create_helper", { name: "Plain", purpose: "Hold none." });
  assert.deepEqual(await reached(), [[slot, kid]]);
  const talks = [
    [`chat_${kid}`, kid],
    [`chat_${plain}`, plain],
  ];
  assert.deepEqual((await reachedBy("chat_")).sort(), talks.sort());
  // Its agents unit gone, it reaches none; back, at "own", it reaches them again.
  const control = (await s.calls.agents.get({ agent: parent })).units.find(
    (one) => one.unit === "control",
  )?.instance as string;
  await s.calls.agents.removeUnit({ agent: parent, instance: control });
  assert.deepEqual(await reached(), []);
  assert.deepEqual(await reachedBy("chat_"), []);
  const { instance } = await s.calls.agents.addUnit({
    agent: parent,
    unit: s.agentsUnit({ templates: ["workhand"], agents: "none" }),
  } as never);
  assert.deepEqual(await reached(), [], "it manages no agents");
  assert.deepEqual(await reachedBy("chat_"), []);
  await s.calls.agents.removeUnit({ agent: parent, instance });
  await s.calls.agents.addUnit({
    agent: parent,
    unit: s.agentsUnit({ templates: ["workhand"] }),
  } as never);
  assert.deepEqual(await reached(), [[slot, kid]]);
  assert.deepEqual((await reachedBy("chat_")).sort(), talks.sort());
  // Reached again when management starts, as for one made before this.
  await s.person.slots.grants.call.unexpose({ to: parent, slot });
  await s.person.slots.grants.call.unexpose({ to: parent, slot: `chat_${kid}` });
  await s.restart(() => {});
  for (let i = 0; (await reached()).length === 0 || (await reachedBy("chat_")).length < 2; i++) {
    assert.ok(i < 300, "it was never reached again");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(await reached(), [[slot, kid]]);
  assert.deepEqual((await reachedBy("chat_")).sort(), talks.sort());
  // While it is away, its maker doesn't reach its Work: no slot of its maker's waits for it. Its
  // conversations stay, the same binding throughout: a message to it is refused until it is back.
  const talkSince = async () =>
    (await s.bindingsOf(parent)).find((one) => one.slot === `chat_${kid}`)?.at;
  const since = await talkSince();
  s.leave(kid);
  for (let i = 0; (await reached()).length > 0; i++) {
    assert.ok(i < 300, "it was still reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await assert.rejects(
    (await s.exposedTo<ChatCalls>(parent, `chat_${kid}`)).send({ text: "Still there?" }),
    { name: "NotConnected" },
  );
  // Back, it is reached again.
  await s.rejoin(kid, chat, { tools });
  for (let i = 0; (await reached()).length === 0; i++) {
    assert.ok(i < 300, "it was never reached again once back");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await talkSince(), since);
  s.leave(kid);
  for (let i = 0; (await reached()).length > 0; i++) {
    assert.ok(i < 300, "it was still reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Nor once management starts while it is away, though the Hub kept its slot.
  await s.person.slots.grants.call.expose({ provider: kid, export: "tools", to: parent, as: slot });
  assert.deepEqual(await reached(), [[slot, kid]]);
  await s.restart(() => {});
  for (let i = 0; (await reached()).length > 0; i++) {
    assert.ok(i < 300, "it was still reached after the start");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual((await reachedBy("chat_")).sort(), talks.sort());
});

test("an agent creates, messages, reads, stops and removes an agent of its own", async (t) => {
  const s = await delegating(t);
  const { agent: parent, tools } = await s.parent({ templates: ["helper", "prefilled"] });
  assert.deepEqual(await s.names(tools), [
    "create_helper",
    "create_prefilled",
    "agent_list",
    "agent_get",
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
  const skill = (await s.calls.skills.get({ name: "delegating" })).text;
  assert.match(skill, /agents of your own/);
  // It says which of its unit's answers keeps a template out, and that its connections never do.
  for (const answer of ["Agents", "Templates", "Places", "Levels below it", "Connections"])
    assert.match(skill, new RegExp(`\\*\\*${answer}\\*\\*`));
  assert.match(skill, /Its \*\*Connections\*\* answer never keeps one out\./);

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
  // It talks to its agent from itself, through the agent's conversations exposed to it: the
  // agent knows the message is its maker's, and is told who that is. Management isn't bound to them.
  const talk = await s.exposedTo<ChatCalls>(parent, `chat_${child}`);
  assert.ok(
    !(await s.bindingsOf(child)).some(
      (b) => b.consumer === s.management.actorId && b.provider === child && b.export === "chat",
    ),
  );
  await talk.send({ text: "Please start." });
  assert.deepEqual(
    s.chats.get(child)?.map((one) => [one.with, one.text]),
    [[parent, "Please start."]],
  );
  assert.deepEqual(
    (await talk.history({})).messages.map((one) => one.text),
    ["Please start."],
  );
  assert.match(
    (await s.agentChannel(child).slots.settings.call.get({})).instructions,
    new RegExp(
      `You were made by the agent "Parent" \\(${parent}\\)\\. Its messages to you say they are from ${parent}\\.`,
    ),
  );
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
  // One whose maker is gone isn't told of it.
  const left = await s.made(tools, "create_helper", { name: "Left", purpose: "Stay." });
  await s.calls.agents.remove({ agent: parent });
  assert.doesNotMatch(
    (await s.agentChannel(left).slots.settings.call.get({})).instructions,
    /You were made/,
  );
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
  assert.deepEqual(Object.keys(got.mcp[0]).sort(), ["slot", "status"]);
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

test("with all, an agent talks to every other agent from itself, as agents come and go and its unit changes", async (t) => {
  const s = await delegating(t);
  // Agents that keep a record of their work: only its own gives it their Work.
  await s.calls.agents.saveTemplate({
    id: "workhand",
    title: "workhand",
    description: "The workhand.",
    base: { provider: "Agents", creatable: "working" },
    units: [],
  });
  const { agent: other } = await s.calls.agents.create({ template: "workhand", name: "Other" });
  const { agent: boss, tools } = await s.parent(
    { templates: ["workhand"], agents: "all" },
    undefined,
    "Boss",
  );
  const reachedBy = async (kind: string) =>
    (await s.bindingsOf(boss))
      .filter((one) => one.consumer === boss && one.slot.startsWith(kind))
      .map((one) => one.provider)
      .sort();
  const talksTo = async (want: string[], why: string) => {
    for (
      let i = 0;
      JSON.stringify(await reachedBy("chat_")) !== JSON.stringify([...want].sort());
      i++
    ) {
      assert.ok(i < 300, `${why}: ${JSON.stringify(await reachedBy("chat_"))}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  // Every other agent's conversations, and not its own, as it is made.
  await talksTo([other], "it never reached the other agent");
  // From itself: the other agent's conversation is with it.
  const talk = await s.exposedTo<ChatCalls>(boss, `chat_${other}`);
  await talk.send({ text: "Status?" });
  assert.deepEqual(
    s.chats.get(other)?.map((one) => [one.with, one.text]),
    [[boss, "Status?"]],
  );
  // One made later, by the person or by it, is reached too; Work only of its own.
  const later = await s.makeStack([], "Later");
  const kid = await s.made(tools, "create_workhand", { name: "Kid", purpose: "P." });
  await talksTo([other, later, kid], "it never reached the agents made later");
  for (let i = 0; JSON.stringify(await reachedBy("work_")) !== JSON.stringify([kid]); i++) {
    assert.ok(
      i < 300,
      `its own Work was never reached: ${JSON.stringify(await reachedBy("work_"))}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // One removed goes from it.
  await s.calls.agents.remove({ agent: later });
  await talksTo([other, kid], "a removed agent stayed");
  // With no agents unit it reaches none; at "own", only its own; at "all" again, every other.
  const control = (await s.calls.agents.get({ agent: boss })).units.find(
    (one) => one.unit === "control",
  )?.instance as string;
  await s.calls.agents.removeUnit({ agent: boss, instance: control });
  assert.deepEqual(await reachedBy("chat_"), []);
  assert.deepEqual(await reachedBy("work_"), []);
  const { instance } = await s.calls.agents.addUnit({
    agent: boss,
    unit: s.agentsUnit({ templates: ["workhand"] }),
  } as never);
  await talksTo([kid], "at own it never reached its own");
  await s.calls.agents.removeUnit({ agent: boss, instance });
  await s.calls.agents.addUnit({
    agent: boss,
    unit: s.agentsUnit({ templates: ["workhand"], agents: "all" }),
  } as never);
  await talksTo([other, kid], "at all again it never reached every other agent");
  for (let i = 0; JSON.stringify(await reachedBy("work_")) !== JSON.stringify([kid]); i++) {
    assert.ok(i < 300, "its own Work was never reached again");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

test("the control log keeps each change and each refusal", async (t) => {
  const s = await delegating(t);
  const { agent: parent, tools } = await s.parent({ templates: ["helper"] });
  const child = await s.made(tools, "create_helper", { name: "Kid", purpose: "P." });
  // Control's own changes reach the same handlers as the person's, and are kept once, as the
  // agent's.
  const added = await tools.call({
    name: "agent_add_unit",
    arguments: { agent: child, provider: s.unitsActor.actorId, unit: "machine", values: {} },
  });
  assert.equal(added.failed, undefined);
  const { instance } = JSON.parse(added.output) as { instance: string };
  await tools.call({ name: "agent_remove_unit", arguments: { agent: child, instance } });
  await tools.call({ name: "agent_stop", arguments: { agent: child } });
  await tools.call({ name: "agent_list", arguments: {} });
  await tools.call({ name: "agent_remove", arguments: { agent: "act_nobody" } });
  const { entries } = await s.calls.agents.activity({});
  assert.deepEqual(
    entries.map((one) => [one.tool, one.target, one.outcome]),
    [
      ["agent_remove", "act_nobody", "refused"],
      ["agent_stop", child, "done"],
      ["agent_remove_unit", child, "done"],
      ["agent_add_unit", child, "done"],
      ["create_helper", child, "done"],
      // The person made the parent.
      ["agent_create", parent, "done"],
    ],
  );
  assert.deepEqual(
    entries.map((one) =>
      one.caller === parent
        ? "parent"
        : one.caller === s.callerActor.actorId
          ? "person"
          : one.caller,
    ),
    ["parent", "parent", "parent", "parent", "parent", "person"],
  );
  assert.match(entries[0]?.reason ?? "", /no agent/);
  assert.deepEqual(
    (await s.calls.agents.activity({ agent: child })).entries.map((one) => one.tool),
    ["agent_stop", "agent_remove_unit", "agent_add_unit", "create_helper"],
  );
  const page = await s.calls.agents.activity({ limit: 1 });
  assert.equal(page.more, true);
  assert.equal(
    (await s.calls.agents.activity({ before: page.entries[0]?.seq })).entries[0]?.tool,
    "agent_stop",
  );
});

test("the person's own changes to an agent are kept in the control log, under control's names", async (t) => {
  const s = await setup(t);
  await s.calls.agents.saveTemplate({
    id: "reader",
    title: "Reader",
    description: "Reads.",
    base: { provider: "Agents", creatable: "plain" },
    units: [],
  });
  await s.calls.skills.add({ files: { "SKILL.md": SKILL("notes", "The person's own.") } });
  const { agent } = await s.calls.agents.create({ template: "reader", name: "Logged" });
  await s.calls.agents.stop({ agent });
  await s.calls.agents.start({ agent });
  const { instance } = await s.calls.agents.addUnit({ agent, unit: s.unit("machine") });
  await s.calls.agents.removeUnit({ agent, instance });
  await s.calls.agents.expose({ agent, skill: "notes" });
  await s.calls.agents.unexpose({ agent, skill: "notes" });
  await assert.rejects(s.calls.agents.expose({ agent, skill: "nothing-here" }));
  const stack = await s.calls.agents.create({ stack: { base: s.base, units: [] }, name: "Plain" });
  const said = (entries: { tool: string; target?: string; outcome: string }[]) =>
    entries.map((one) => [one.tool, one.target === agent ? "it" : one.target, one.outcome]);
  const { entries } = await s.calls.agents.activity({ agent });
  assert.deepEqual(said(entries), [
    ["skill_expose", "it", "refused"],
    ["skill_unexpose", "it", "done"],
    ["skill_expose", "it", "done"],
    ["agent_remove_unit", "it", "done"],
    ["agent_add_unit", "it", "done"],
    ["agent_start", "it", "done"],
    ["agent_stop", "it", "done"],
    ["create_reader", "it", "done"],
  ]);
  assert.ok(entries.every((one) => one.caller === s.callerActor.actorId));
  assert.match(entries[0]?.reason ?? "", /no skill nothing-here/);
  assert.deepEqual(said((await s.calls.agents.activity({ agent: stack.agent })).entries), [
    ["agent_create", stack.agent, "done"],
  ]);
  // A refusal that echoes a secret it was given keeps none of it.
  const secret = `secret-${crypto.randomUUID()}`;
  s.script.problems = [{ field: "token", message: `The token ${secret} won't do.` }];
  await assert.rejects(
    s.calls.agents.addUnit({
      agent,
      unit: { ...s.unit("files", { folder: "/a" }), secrets: { token: secret } },
    } as never),
  );
  delete s.script.problems;
  assert.ok(!readFileSync(join(s.dir, "activity.jsonl"), "utf8").includes(secret));
  // A creation refused is named by its template too, with why.
  await assert.rejects(s.calls.agents.create({ template: "reader", name: "" } as never));
  await assert.rejects(s.calls.agents.create({ template: "nowhere", name: "Lost" }));
  assert.deepEqual(said((await s.calls.agents.activity({ limit: 1 })).entries), [
    ["create_nowhere", undefined, "refused"],
  ]);
  // Removing is kept too, after the agent has gone.
  await s.calls.agents.remove({ agent });
  assert.deepEqual(said((await s.calls.agents.activity({ limit: 1 })).entries), [
    ["agent_remove", "it", "done"],
  ]);
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
  await s.calls.agents.removeUnit({ agent, instance: held.from as string });
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
  // A capability is held once by itself, without `once`.
  const doubled = await s.calls.agents.check({
    stack: { base: s.base, units: [s.unit("askew"), s.unit("askew")] },
  });
  assert.ok(doubled.problems.some((one) => one.message === "There is a Askew already."));
  // Held once by its capability and by `once`: told once.
  assert.equal(
    twice.problems.filter((one) => one.message === "There is a Desk already.").length,
    1,
  );
  const { agent } = await s.calls.agents.create({
    stack: { base: s.base, units: [s.unit("desk")] },
    name: "Holder",
  });
  const more = await s.calls.agents.check({ agent, unit: s.unit("desk") });
  assert.ok(more.problems.some((one) => one.message === "There is a Desk already."));
  await assert.rejects(s.calls.agents.addUnit({ agent, unit: s.unit("desk") }), refused("invalid"));
  assert.equal(s.given.applied.filter((one) => one.unit === "desk").length, 1, "applied once");
  // An agent whose record holds no capability, as one made before its unit built one: `once`
  // still refuses a second.
  const { agent: older } = await s.calls.agents.create({
    stack: { base: s.base, units: [s.unit("desk")] },
    name: "Older",
  });
  await s.restart((kept) => {
    const agents = kept.agents as unknown as Record<string, { capabilities: unknown[] }>;
    (agents[older] as { capabilities: unknown[] }).capabilities = [];
  });
  const again = await s.calls.agents.check({ agent: older, unit: s.unit("desk") });
  assert.equal(
    again.problems.filter((one) => one.message === "There is a Desk already.").length,
    1,
  );
});

test("a unit a stack holds once is a problem the second time, in a new stack and on a living agent", async (t) => {
  const s = await setup(t);
  const said = (problems: { message: string; unit?: number }[]) =>
    problems.filter((one) => one.message === "There is a Badge already.");
  const twice = await s.calls.agents.check({
    stack: { base: s.base, units: [s.unit("badge"), s.unit("machine"), s.unit("badge")] },
  });
  assert.deepEqual(
    said(twice.problems).map((one) => one.unit),
    [2],
    "the second is the problem",
  );
  // A unit that doesn't say so may be there twice, as before.
  const plain = await s.calls.agents.check({
    stack: { base: s.base, units: [s.unit("machine"), s.unit("machine")] },
  });
  assert.deepEqual(plain.problems, []);
  await assert.rejects(
    s.calls.agents.create({
      stack: { base: s.base, units: [s.unit("badge"), s.unit("badge")] },
      name: "Two badges",
    }),
    refused("invalid"),
  );
  const { agent } = await s.calls.agents.create({
    stack: { base: s.base, units: [s.unit("badge")] },
    name: "One badge",
  });
  assert.equal(
    said((await s.calls.agents.check({ agent, unit: s.unit("badge") })).problems).length,
    1,
  );
  await assert.rejects(
    s.calls.agents.addUnit({ agent, unit: s.unit("badge") }),
    refused("invalid"),
  );
  assert.equal(s.given.applied.filter((one) => one.unit === "badge").length, 1, "applied once");
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
  await assert.rejects(s.calls.agents.removeUnit({ agent, instance: held.from as string }));
  // It stays whole: the agent holds it, and the person still reaches it.
  assert.deepEqual((await s.calls.agents.get({ agent })).capabilities, [held]);
  const there = await slots();
  assert.ok(there.includes(held.person.capability));
  assert.ok(there.includes(held.person.operations.desk as string));
  delete s.script.fail;
  await s.calls.agents.removeUnit({ agent, instance: held.from as string });
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
  await s.calls.agents.removeUnit({ agent, instance: held.from as string });
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

test("an agent whose creatable gives it a capability holds it with no unit, the person reaching the agent's own exports", async (t) => {
  const s = await setup(t);
  const { agent } = await s.calls.agents.create({
    stack: { base: { ...s.base, creatable: "working" }, units: [] },
    name: "Worker",
  });
  const [held] = (await s.calls.agents.get({ agent })).capabilities ?? [];
  assert.ok(held);
  assert.deepEqual(
    { id: held.id, title: held.title, from: held.from, slots: held.slots, views: held.views },
    { id: "work", title: "Activity", from: undefined, slots: [], views: WORK.views },
  );
  const bound = async () =>
    (await s.bindingsOf(PERSON)).map((b) => `${b.slot} ${b.provider} ${b.export}`);
  assert.ok((await bound()).includes(`${held.person.capability} ${agent} capability`));
  assert.ok((await bound()).includes(`${held.person.operations.work} ${agent} tools`));
  // An agent of it made before its creatable gave one holds it once it is reached again: once.
  await s.restart((kept) => {
    const agents = kept.agents as unknown as Record<string, { capabilities: unknown[] }>;
    (agents[agent] as { capabilities: unknown[] }).capabilities = [];
  });
  let again: NonNullable<Awaited<ReturnType<typeof s.calls.agents.get>>["capabilities"]> = [];
  for (let i = 0; i < 300 && again.length === 0; i++) {
    again = (await s.calls.agents.get({ agent })).capabilities ?? [];
    if (again.length === 0) await new Promise((later) => setTimeout(later, 20));
  }
  // Every pass a restart makes has had its turn.
  await new Promise((later) => setTimeout(later, 200));
  again = (await s.calls.agents.get({ agent })).capabilities ?? [];
  assert.deepEqual(
    again.map((one) => [one.id, one.from]),
    [["work", undefined]],
  );
  const [now] = again;
  assert.ok((await bound()).includes(`${now?.person.capability} ${agent} capability`));
  assert.ok((await bound()).includes(`${now?.person.operations.work} ${agent} tools`));
});

/** A unit's skill "notes" as management keeps it, and a wait until it says `text`. */
const notesOf = (s: Awaited<ReturnType<typeof setup>>) => {
  const notes = async () => (await s.calls.skills.get({ name: "notes" })).text;
  const becomes = async (text: RegExp, why: string) => {
    for (let i = 0; !text.test(await notes()); i++) {
      assert.ok(i < 300, `${why}: ${await notes()}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  /** Wait until management logs `line`, as many times as `times`. */
  const logs = (line: string, times = 1) =>
    until(() => s.logged.filter((one) => one === line).length >= times);
  return { notes, becomes, logs };
};

test("a skill a unit gave is brought up to date with its provider while it is as copied", async (t) => {
  const s = await setup(t);
  const { notes, becomes, logs } = notesOf(s);
  await s.makeStack([s.unit("files", { folder: "/work" })]);
  assert.match(await notes(), /Use it well\./);
  // Its provider serves new text: management, started again, brings the copy here up to date.
  s.script.skillText = "Use it better.";
  await s.restart(() => {});
  await becomes(/Use it better\./, "the new text never came");
  // Changed here on disk, it is left as it is, and that is logged once at each start.
  const left = "The skill notes isn't as it was copied here, so it is left as it is.";
  writeFileSync(join(s.dir, "skills", "notes", "SKILL.md"), SKILL("notes", "Edited here."));
  s.script.skillText = "Use it best.";
  await s.restart(() => {});
  await logs(left);
  await s.restart(() => {});
  await logs(left, 2);
  assert.match(await notes(), /Edited here\./);
  // Replaced by the person, even with what was copied, it is theirs, and never brought up to date.
  await s.calls.skills.add({
    files: { "SKILL.md": SKILL("notes", "Use it better."), "more/guide.md": "A guide." },
  });
  assert.equal(
    JSON.parse(readFileSync(join(s.dir, "manager.json"), "utf8")).copies.notes,
    undefined,
    "no unit's copy any more",
  );
  await s.restart(() => {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.match(await notes(), /Use it better\./);
  assert.equal(s.logged.filter((one) => one === left).length, 2);
});

test("a skill in a home from before copies were kept is brought up to date only when its text is one its provider shipped", async (t) => {
  const s = await setup(t);
  const { notes, becomes, logs } = notesOf(s);
  await s.makeStack([s.unit("files", { folder: "/work" })]);
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const withoutCopies = (kept: Record<string, unknown>) => {
    delete kept.copies;
  };
  // Its text isn't one the provider shipped: it may be an edit, and is left.
  s.script.skillText = "Use it better.";
  await s.restart(withoutCopies);
  await logs("The skill notes isn't the text its unit gives, so it is left as it is.");
  assert.match(await notes(), /Use it well\./);
  // Still to be taken, at a later start, once the provider says it shipped that text: it is taken
  // as a copy, and brought up to date.
  s.script.shipped = [sha(SKILL("notes"))];
  await s.restart(() => {});
  await becomes(/Use it better\./, "it was never brought up to date");
});

test("the delegating skill's text is among the texts it says it shipped", () => {
  const now = createHash("sha256")
    .update(skillFile("SKILL.md") ?? "")
    .digest("hex");
  assert.ok(
    SKILL_SHIPPED.includes(now),
    `append ${now} to SKILL_SHIPPED in packages/manager/src/control.ts, and keep the others`,
  );
});
