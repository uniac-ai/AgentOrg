import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";
import { AgentModels, AgentStatus, Answers, Creatable, CreatableId } from "./agent-provider.js";
import { SKILL_FILE_MAX, SkillEntry, SkillName, SkillPath } from "./agent-settings.js";
import {
  ConnectionKind,
  ConnectionParams,
  ConnectionSecrets,
  ConnectionState,
  ConnectionStatus,
  ConnectionTarget,
} from "./connection.js";
import { Id, SlotName } from "./hub.js";
import { ModelId } from "./llm-session.js";
import {
  FieldValues,
  LiveMode,
  LiveSurface,
  LiveTicket,
  Problem,
  ResultKind,
  Unit,
  UnitId,
} from "./units.js";

const Time = z.string().max(64);
const ActorName = z.string().min(1).max(128);
const OnAgent = z.object({ agent: Id });
const OnConnection = z.object({ connection: Id });
const OnSkill = z.object({ name: SkillName });
const Purpose = z.string().max(2000);

/** A template's id. */
export const TemplateId = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(64);
/** What a stack starts on: one base from an agent provider, with what it asks. */
export const StackBase = z.strictObject({
  provider: Id,
  creatable: CreatableId,
  answers: Answers.optional(),
});
/**
 * One unit of a stack, top to bottom. `needs` picks, by kind, which earlier unit (its position in
 * `units`) gives what this one needs; a kind exactly one earlier unit gives needs no pick.
 */
export const StackUnit = z.strictObject({
  provider: Id,
  unit: UnitId,
  values: FieldValues.optional(),
  needs: z.record(ResultKind, z.number().int().min(0)).optional(),
});
/** A stack as it is created: each unit may also carry secrets, used once and never saved. */
const FilledUnit = StackUnit.extend({ secrets: ConnectionSecrets.optional() });
/** `template` notes the template it started from, for display only. */
export const Stack = z.strictObject({
  base: StackBase,
  units: z.array(FilledUnit).max(64),
  template: TemplateId.optional(),
});
/** A provider in a template: by its Actor's name, so a template works on another home. */
const ProviderName = z.string().min(1).max(128);
/**
 * A saved stack of prefills: nothing in it is locked, and no secret is in it; management refuses a
 * value for a secret field. A required field with no value must still be filled at creation.
 * `from` notes the template it was copied from, for display only: later changes to that one don't
 * reach this one.
 */
export const Template = z.strictObject({
  id: TemplateId,
  title: z.string().min(1).max(128),
  description: z.string().max(2000),
  from: TemplateId.optional(),
  base: StackBase.extend({ provider: ProviderName }),
  units: z.array(StackUnit.extend({ provider: ProviderName })).max(64),
});
/**
 * A template as the listing gives it. `shipped` is on one that came with the app: it can't be
 * removed. A template saved under its id is listed in its place, and removing that one brings it
 * back.
 */
export const ListedTemplate = Template.extend({ shipped: z.literal(true).optional() });
/** What is filled in for one unit of a template, by its position: prefills it replaces, and secrets. */
const Fill = z.strictObject({
  values: FieldValues.optional(),
  secrets: ConnectionSecrets.optional(),
});
/** A unit to add to a living agent: `needs` names, by kind, the instance to take each result from. */
const AddUnit = {
  agent: Id,
  unit: FilledUnit.omit({ needs: true }),
  needs: z.record(ResultKind, Id).optional(),
};
/** A problem with a stack: on one unit (its position), or, with neither, on the whole. */
const StackProblem = Problem.extend({ unit: z.number().int().min(0).optional() });
/**
 * One unit as an agent has it: what was filled in, never a secret. `instance` is management's own
 * id for it, and `needs` names, by kind, the instance it took each result from.
 */
const AppliedUnit = z.object({
  instance: Id,
  provider: Id,
  unit: UnitId,
  title: z.string().min(1).max(128),
  values: FieldValues,
  needs: z.record(ResultKind, Id),
  status: z.object({
    state: ConnectionState,
    detail: z.string().max(2000).optional(),
    /** What of it can be opened live, through `agents.live`. */
    surfaces: z.array(LiveSurface).max(16).optional(),
  }),
});

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

/** One call an agent made through its control unit that changed something, or was refused. */
const ActivityEntry = z.object({
  /** Its place in the log, newest highest. */
  seq: z.number().int().min(0),
  at: Time,
  /** The agent that called. */
  caller: Id,
  tool: z.string().min(1).max(128),
  /** What it was about: an agent, a connection, a skill or a unit's instance. */
  target: z.string().max(256).optional(),
  outcome: z.enum(["done", "refused"]),
  /** Why it was refused. Never a message an agent sent, or a secret. */
  reason: z.string().max(2000).optional(),
});

/** An agent as the list shows it: its status is its provider's. */
const AgentEntry = z.object({
  agent: Id,
  name: ActorName,
  status: AgentStatus,
  provider: Id,
  creatable: CreatableId,
  /** What it's for, as whoever made it said. */
  purpose: Purpose.optional(),
  /** The template it started from, for display only. */
  template: TemplateId.optional(),
  /** The agent that made it; `gone` once that agent has been removed. It is the person's either way. */
  parent: z.object({ agent: Id, name: ActorName, gone: z.literal(true).optional() }).optional(),
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
    /** Every base and unit the connected providers offer, each naming its provider. */
    units: method({
      input: z.object({}),
      output: z.object({
        bases: z.array(Creatable.extend({ provider: Id, providerName: ActorName })),
        units: z.array(Unit.extend({ provider: Id, providerName: ActorName })),
      }),
    }),
    /** The templates: what the app ships, each marked `shipped`, and what the person saved. */
    templates: method({
      input: z.object({}),
      output: z.object({ templates: z.array(ListedTemplate) }),
    }),
    /** Save a template, replacing the one of its id. A saved template holds no secret. */
    saveTemplate: method({ input: Template, output: z.object({}) }),
    removeTemplate: method({ input: z.object({ id: TemplateId }), output: z.object({}) }),
    /** Check a stack, or a unit to add to a living agent, before anything runs. It changes nothing. */
    check: method({
      input: z.union([z.strictObject({ stack: Stack }), z.strictObject(AddUnit)]),
      output: z.object({ problems: z.array(StackProblem).max(256) }),
    }),
    /**
     * Make an agent, from a stack, or from a template with what is filled in for each of its units
     * by position; nothing in a template is locked, so a caller changing more sends the stack. All
     * or none: if any step fails, what this creation made is removed, last first.
     */
    create: method({
      input: z.union([
        z.strictObject({ stack: Stack, name: ActorName, purpose: Purpose.optional() }),
        z.strictObject({
          template: TemplateId,
          fill: z.array(Fill).max(64).optional(),
          answers: Answers.optional(),
          name: ActorName,
          purpose: Purpose.optional(),
        }),
      ]),
      output: OnAgent,
    }),
    list: method({ input: z.object({}), output: z.object({ agents: z.array(AgentEntry) }) }),
    /** What the agent is made of, in one read. */
    get: method({
      input: OnAgent,
      output: AgentEntry.extend({
        instructions: z.string().max(200_000),
        /** Which unit gave each is its `instance`. */
        skills: z.array(SkillEntry.extend({ instance: Id.optional() })),
        mcp: z.array(
          z.object({
            slot: SlotName,
            connection: Id,
            origin: ConnectionOrigin.optional(),
            status: ConnectionStatus,
            instance: Id.optional(),
          }),
        ),
        /** Its stack, top to bottom. */
        units: z.array(AppliedUnit),
      }),
    }),
    start: method({ input: OnAgent, output: z.object({}) }),
    /**
     * Stops the agent: whatever it was doing ends, and it does nothing until started; all else
     * stays.
     */
    stop: method({ input: OnAgent, output: z.object({}) }),
    /** The models the agent can use, and the one chosen, as its provider says. */
    models: method({ input: OnAgent, output: AgentModels }),
    /**
     * Choose the model for the agent's next requests; with no `model`, go back to its provider's
     * default. Refused `unknown` when the model isn't one of `models`.
     */
    setModel: method({
      input: OnAgent.extend({ model: ModelId.optional() }),
      output: z.object({}),
    }),
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
    /** Add a unit to a living agent, below those it has; it takes effect at the next request. */
    addUnit: method({ input: z.strictObject(AddUnit), output: z.object({ instance: Id }) }),
    /** Remove a unit from a living agent: what it made goes. Refused `state` while another needs it. */
    removeUnit: method({ input: z.object({ agent: Id, instance: Id }), output: z.object({}) }),
    /**
     * What agents did through their control units, newest first: each call that changed something,
     * and each refusal. With `agent`, those it made or that were about it.
     */
    activity: method({
      input: z.object({
        agent: Id.optional(),
        before: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      output: z.object({ entries: z.array(ActivityEntry), more: z.boolean() }),
    }),
    /**
     * A one-time ticket to open one of a unit's surfaces live. For the person's gateway, which dials
     * it and pipes the bytes to a page; it never reaches a page itself. No agent can ask for one.
     */
    live: method({
      input: z.object({ agent: Id, instance: Id, surface: UnitId, mode: LiveMode }),
      output: LiveTicket,
    }),
    /** Final: removes the units, last first, then the agent, and the connections made for it. */
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
