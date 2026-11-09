import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";
import { AgentStatus, Answers, Creatable, CreatableId } from "./agent-provider.js";
import { SKILL_FILE_MAX, SkillEntry, SkillName, SkillPath } from "./agent-settings.js";
import { Id, SlotName } from "./hub.js";
import {
  ConnectionKind,
  ConnectionParams,
  ConnectionSecrets,
  ConnectionState,
  ConnectionStatus,
  ConnectionTarget,
} from "./mcp-provider.js";

const Time = z.string().max(64);
const ActorName = z.string().min(1).max(128);
const OnAgent = z.object({ agent: Id });
const OnConnection = z.object({ connection: Id });
const OnSkill = z.object({ name: SkillName });

/** Where a connection came from, written once when it was made. */
export const ConnectionOrigin = z.object({
  provider: Id,
  kind: ConnectionKind,
  target: ConnectionTarget,
  /** The Actor that asked for it. */
  madeBy: Id,
  /** The agent it was made for, which it goes with; none when the person connected it. */
  madeFor: Id.optional(),
  at: Time,
});

/** An agent as the list shows it: its status is its provider's. */
const AgentEntry = z.object({
  agent: Id,
  name: ActorName,
  status: AgentStatus,
  provider: Id,
  creatable: CreatableId,
});

/**
 * `agents@1`: the agents the person has, each made from a creatable a connected agent provider
 * offers. What each agent is doing is read from the agent's own `chat@1`.
 */
export const agents = defineInterface({
  name: "agents",
  major: 1,
  kind: "rpc",
  methods: {
    /** What every connected agent provider offers. */
    creatable: method({
      input: z.object({}),
      output: z.object({ creatables: z.array(Creatable.extend({ provider: Id })) }),
    }),
    /** The agent providers connected now. */
    providers: method({
      input: z.object({}),
      output: z.object({ providers: z.array(z.object({ provider: Id, name: ActorName })) }),
    }),
    /**
     * Make an agent of a creatable, with what it asks and a connection for each of its `pick`
     * needs, by slot. All or none: if any step fails, what this creation made is removed. A skill
     * it comes with whose name is already here keeps the one here.
     */
    create: method({
      input: z.object({
        provider: Id,
        creatable: CreatableId,
        name: ActorName,
        answers: Answers,
        connections: z.record(SlotName, Id).optional(),
      }),
      output: OnAgent,
    }),
    list: method({ input: z.object({}), output: z.object({ agents: z.array(AgentEntry) }) }),
    /** What the agent is made of, in one read. */
    get: method({
      input: OnAgent,
      output: AgentEntry.extend({
        instructions: z.string().max(200_000),
        skills: z.array(SkillEntry),
        mcp: z.array(
          z.object({
            slot: SlotName,
            connection: Id,
            origin: ConnectionOrigin.optional(),
            status: ConnectionStatus,
          }),
        ),
      }),
    }),
    start: method({ input: OnAgent, output: z.object({}) }),
    /** Ends the agent's process, and a turn in progress with it; all else about it stays. */
    stop: method({ input: OnAgent, output: z.object({}) }),
    /** Expose a skill or a connection to the agent; `as` names a connection's slot. */
    expose: method({
      input: z.union([
        z.strictObject({ agent: Id, skill: SkillName }),
        z.strictObject({ agent: Id, connection: Id, as: SlotName.optional() }),
      ]),
      output: z.object({ slot: SlotName.optional() }),
    }),
    unexpose: method({
      input: z.union([
        z.strictObject({ agent: Id, skill: SkillName }),
        z.strictObject({ agent: Id, slot: SlotName }),
      ]),
      output: z.object({}),
    }),
    /** Final: removes the agent and the connections made for it. */
    remove: method({ input: OnAgent, output: z.object({}) }),
  },
});

/** A connection as the list shows it. */
const ConnectionEntry = z.object({
  connection: Id,
  name: ActorName,
  state: ConnectionState,
  origin: ConnectionOrigin.optional(),
});

/** `connections@1`: the person's connections to MCP servers, through the connected providers. */
export const connections = defineInterface({
  name: "connections",
  major: 1,
  kind: "rpc",
  methods: {
    /** The MCP providers connected now, each with the kinds it offers. */
    providers: method({
      input: z.object({}),
      output: z.object({
        providers: z.array(
          z.object({
            provider: Id,
            name: ActorName,
            kinds: z.array(
              z.object({
                kind: ConnectionKind,
                title: z.string().min(1).max(128),
                params: z.record(z.string(), z.json()),
                secrets: z.record(z.string(), z.json()),
              }),
            ),
          }),
        ),
      }),
    }),
    /** `secrets` go to the provider and nowhere else: they are never read back. */
    create: method({
      input: z.object({
        provider: Id,
        kind: ConnectionKind,
        params: ConnectionParams,
        secrets: ConnectionSecrets.optional(),
        name: ActorName,
      }),
      output: OnConnection,
    }),
    list: method({
      input: z.object({}),
      output: z.object({ connections: z.array(ConnectionEntry) }),
    }),
    get: method({
      input: OnConnection,
      output: ConnectionEntry.omit({ state: true }).extend({ status: ConnectionStatus }),
    }),
    /** Final: every exposure of it goes with it. */
    remove: method({ input: OnConnection, output: z.object({}) }),
  },
});

const SkillFiles = z.record(SkillPath, z.string().max(SKILL_FILE_MAX));

/** `skills@1`: the person's skills, each a `SKILL.md` folder. */
export const skills = defineInterface({
  name: "skills",
  major: 1,
  kind: "rpc",
  methods: {
    /**
     * Add a skill from a folder on the Hub's machine or as files; its name and description come
     * from `SKILL.md`. The same name replaces the skill, for every agent it's exposed to.
     */
    add: method({
      input: z.union([
        z.strictObject({ path: z.string().min(1).max(4096) }),
        z.strictObject({ files: SkillFiles }),
      ]),
      output: SkillEntry,
    }),
    list: method({ input: z.object({}), output: z.object({ skills: z.array(SkillEntry) }) }),
    /** The skill: its `SKILL.md`, the paths of its files, and the agents it's exposed to. */
    get: method({
      input: OnSkill,
      output: SkillEntry.extend({
        text: z.string().max(SKILL_FILE_MAX),
        files: z.array(SkillPath),
        agents: z.array(Id),
      }),
    }),
    /** Final: it is taken off every agent it's exposed to. */
    remove: method({ input: OnSkill, output: z.object({}) }),
  },
});
