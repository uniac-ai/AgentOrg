/**
 * An agent built as a stack of units on a base: checking one, applying it all or none, keeping its
 * instances, removing them last first, and the templates that prefill one.
 */
import { createHash } from "node:crypto";
import {
  AgentCapability,
  type agentProvider,
  type agents,
  ConnectionOrigin,
  type ConnectionStatus,
  type Creatable,
  FactRow,
  FieldValues,
  type LiveSurface,
  type OwnCapability,
  type Problem,
  ResultKind,
  SkillName,
  SlotName,
  Surface,
  Template,
  type Unit,
  UnitResult,
  type unitProvider,
  View,
} from "@agentorg/interfaces";
import { type Log, Refused, type Slot } from "@agentorg/sdk";
import { z } from "zod";
import {
  AGENTS_SLOT,
  AGENTS_UNIT,
  agentsUnit,
  managesAll,
  managesOwn,
  type Reach,
  reachOf,
  reachProblems,
  skillFile,
  skillShipped,
} from "./control.js";
import {
  formProblems,
  givesProblems,
  heldProblems,
  settle,
  type Worked,
  workedOut,
} from "./form.js";
import type { SkillFiles, Skills } from "./skills.js";

/** A unit an agent has: what its provider made, and what was filled in. Never a secret. */
const UnitRecord = z.object({
  /** Management's own id for it. */
  instance: z.string(),
  provider: z.string(),
  /** The provider's id for it. */
  providerInstance: z.string(),
  unit: z.string(),
  title: z.string(),
  values: FieldValues,
  /** By kind, the instance it took each result from. */
  needs: z.record(ResultKind, z.string()),
  results: z.array(UnitResult),
  connections: z.array(z.object({ slot: z.string(), connection: z.string() })),
  skills: z.array(z.string()),
  /** It was added as the MCP unit, and reads back as one. */
  viaMcp: z.literal(true).optional(),
});
/**
 * Something an agent holds, as it was built: what `agents.get` gives of it, and the Actor that
 * is it, which the person is connected to.
 */
/**
 * An agent's own capability, the one its creatable gives it, is kept with the agent itself as its
 * `from`: no unit is, and a manager from before own capabilities still reads the record.
 */
/**
 * What an agent holds, kept as written: its surfaces, its views and their rows keep members a
 * later version added, which this version doesn't know, so going back and forth loses none of
 * them. Only what this version knows is answered (`known`).
 */
const CapabilityRecord = z.looseObject(AgentCapability.shape).extend({
  actor: z.string(),
  surfaces: z.array(z.looseObject(Surface.shape)).max(16),
  views: z
    .array(
      z
        .looseObject(View.shape)
        .extend({ fixed: z.array(z.looseObject(FactRow.shape)).max(32).optional() }),
    )
    .max(32),
});
/** Of a kept object, the members `schema` knows. */
const knownTo = <T extends z.ZodObject>(schema: T, kept: object) =>
  Object.fromEntries(
    Object.entries(kept).filter(([key]) => Object.hasOwn(schema.shape, key)),
  ) as z.output<T>;
/** What a kept capability is, as this version answers it. */
const known = (kept: z.output<typeof CapabilityRecord>) => ({
  ...knownTo(AgentCapability, kept),
  surfaces: kept.surfaces.map((one) => knownTo(Surface, one)),
  views: kept.views.map(({ fixed, ...view }) => ({
    ...knownTo(View, view),
    ...(fixed ? { fixed: fixed.map((row) => knownTo(FactRow, row)) } : {}),
  })),
});
/** What only management knows of an agent: where it came from, what it is told, and its skills. */
export const AgentRecord = z.object({
  provider: z.string(),
  creatable: z.string(),
  instructions: z.string(),
  skills: z.array(z.string()),
  purpose: z.string().optional(),
  template: z.string().optional(),
  units: z.array(UnitRecord).default([]),
  /** What it holds, in its stack's order: one for each applied unit that builds one. */
  capabilities: z.array(CapabilityRecord).default([]),
  /** Its export that is its chats, as its provider named it; `chat` for one kept before this was. */
  chat: z.string().default("chat"),
  /** The agent that made it, which may be gone by now. */
  parent: z.object({ agent: z.string(), name: z.string() }).optional(),
  /** The parent's computer, when it shares one: its own reach, for agents it makes. */
  computer: z
    .object({
      access: z.string(),
      /** As an earlier version kept it: `local` is on this machine. */
      service: z.string().optional(),
      /** On this machine: this computer, or a container here. */
      here: z.literal(true).optional(),
      browser: z.boolean(),
      connections: z.array(z.object({ slot: z.string(), connection: z.string() })),
      skills: z.array(z.string()),
    })
    .optional(),
});
export const Records = z.object({
  agents: z.record(z.string(), AgentRecord),
  connections: z.record(z.string(), ConnectionOrigin),
  templates: z.record(z.string(), Template).default({}),
  /** A connection the person made, to its provider's id for it; none means they are the same. */
  instances: z.record(z.string(), z.string()).default({}),
  /**
   * Each skill a unit gave, as it was copied here: its unit's provider and unit, and the sha256 of
   * each of its files. It is replaced when its provider serves other text and it is as copied.
   */
  copies: z
    .record(
      z.string(),
      z.object({
        provider: z.string(),
        unit: z.string(),
        files: z.record(z.string(), z.string()),
      }),
    )
    .default({}),
  /**
   * The skills units gave in a home from before copies were kept, still to be taken as copies:
   * each is, once every file is its provider's text or one it shipped.
   */
  uncopied: z.array(z.string()).default([]),
  /** The agent that added a skill or saved a template, which only it may replace or remove. */
  authors: z
    .object({
      skills: z.record(z.string(), z.string()).default({}),
      templates: z.record(z.string(), z.string()).default({}),
    })
    .default({ skills: {}, templates: {} }),
});

type TheAgent = z.infer<typeof AgentRecord>;
type TheRecords = z.infer<typeof Records>;
type TheUnitRecord = z.infer<typeof UnitRecord>;
type TheTemplate = z.infer<typeof Template>;
type Origin = z.infer<typeof ConnectionOrigin>;
type TheUnit = z.infer<typeof Unit>;
type TheProblem = z.infer<typeof Problem>;
type Values = z.infer<typeof FieldValues>;
type Agents = Slot<typeof agentProvider>["call"];
type Units = Slot<typeof unitProvider>["call"];
type Applied = Awaited<ReturnType<Units["apply"]>>;
type AgentCalls = Slot<typeof agents>["call"];
type CreateInput = Parameters<AgentCalls["create"]>[0];
type CheckInput = Parameters<AgentCalls["check"]>[0];
type AddInput = Parameters<AgentCalls["addUnit"]>[0];
export type StackInput = Extract<CreateInput, { stack: unknown }>["stack"];
type FilledUnit = StackInput["units"][number];
type StackBase = StackInput["base"];
type Provided<T> = { actor: string; call: T };

/** Management's own units. They ask no provider: each is an exposure, and is read back as one, no unit. */
const SKILL_UNIT = "skill";
const CONNECTION_UNIT = "connection";
/** One exposure, however it's reached: it stands for the Connection unit or a kind of connection. */
const MCP_UNIT = "mcp";
const MCP_SLOT = "slot";
const MCP_HOW = "how";
const skillInstance = (name: string) => `skill:${name}`;
const slotInstance = (slot: string) => `slot:${slot}`;

const MAX_MESSAGE = 2000;
/** How many templates one agent may save. */
const AGENT_TEMPLATES = 32;
const MAX_OPTIONS = 256;
const MAX_PROBLEMS = 256;
const MAX_NAME = 128;
const TOOLS = "tools@1";

export interface Offer {
  unit: TheUnit;
  provider: string;
  providerName: string;
  /** None for management's own. */
  call?: Units;
}
/** What makes an agent an agent's: who made it, and what of its parent's it shares. */
interface Child {
  parent: { agent: string; name: string };
  reach: Reach;
  shares: { slot: string; connection: string }[];
  skills: string[];
  computer?: Reach;
}
/** A unit that passed its check, ready to apply. `needs` refers to earlier units by `Giver.ref`. */
interface Placed {
  offer: Offer;
  values: Values;
  secrets: Record<string, string>;
  worked: Worked;
  needs: Record<string, number | string>;
  viaMcp?: true;
}
/** An earlier unit: by position in a stack, by instance on a living agent. */
interface Giver {
  ref: number | string;
  provider: string;
  /** The provider's id for the unit. */
  unit: string;
  results: string[];
}
/** What the units so far already give. */
interface Taken {
  slots: Set<string>;
  skills: Set<string>;
  /** The capabilities held, by id. */
  capabilities: Set<string>;
  givers: Giver[];
}
/** One application under way: what it made goes in `undo`, and origins are kept at the end. */
interface Work {
  agent: string;
  name: string;
  caller: string;
  record: TheAgent;
  undo: (() => unknown)[];
  origins: Record<string, Origin>;
}

export interface StackParts {
  self: string;
  hub: {
    actors: {
      close(input: { actorId: string }): Promise<unknown>;
      get(input: { actorId: string }): Promise<{ connected: boolean }>;
    };
    grants: {
      bind(input: {
        consumer: string;
        slot: string;
        provider: string;
        export: string;
      }): Promise<unknown>;
      expose(input: {
        provider: string;
        export: string;
        to: string;
        as?: string;
      }): Promise<unknown>;
      unexpose(input: { to: string; slot: string }): Promise<unknown>;
    };
    bindings: {
      list(input: { actor: string }): Promise<{
        bindings: {
          consumer: string;
          interface: string;
          slot: string;
          provider: string;
          export: string;
          exposed?: true | undefined;
        }[];
      }>;
    };
  };
  records: TheRecords;
  save(): void;
  library: Skills;
  creating: Map<string, TheAgent>;
  log: Log;
  /** Shipped with the app; one the person saves under the same id is the one used. */
  shipped: TheTemplate[];
  agentProviders(): Provided<Agents>[];
  unitProviders(): Provided<Units>[];
  recordOf(agent: string): TheAgent;
  openActors(): Promise<Map<string, { name: string }>>;
  nameOf(actor: string): Promise<string>;
  changed(agent: string): void;
  fromEach<T, R>(list: T[], read: (one: T) => Promise<R>): Promise<R[]>;
  exposeConnection(agent: string, connection: string, as?: string): Promise<string>;
  /** Connect the person to an export of an Actor made for an agent; it gives the person's slot. */
  reachPerson(provider: string, exported: string): Promise<string>;
  /**
   * Take one of those slots off the person, if it is still bound to `provider`. One that has
   * gone, or whose name another Actor's export has since been given, is left alone.
   */
  unreachPerson(slot: string, provider: string): Promise<void>;
  closing(what: string, remove: () => Promise<void>): Promise<void>;
  removeAgent(agent: string, provider: string): Promise<void>;
}

/** What a capability's Actor exports as itself, and what each of its connections exports. */
const CAPABILITY_EXPORT = "capability";
const TOOLS_EXPORT = "tools";
/** The slot an agent's Work is reached at by the agent that made it: named by its id. */
const workSlot = (agent: string) => `work_${agent}`;
/** The slot an agent's conversations are reached at by another agent: named by its id. */
const chatSlot = (agent: string) => `chat_${agent}`;
/** What tells a binding that reaches one agent from another. */
type AgentBinding = { slot: string; provider: string; export: string };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** The sha256 of each file of a skill, by its path. */
const hashesOf = (files: SkillFiles) =>
  Object.fromEntries(
    Object.entries(files).map(([path, text]) => [
      path,
      createHash("sha256").update(text).digest("hex"),
    ]),
  );
/** Whether two lists name the same paths. */
const samePaths = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().every((path, i) => path === [...b].sort()[i]);
/** Whether two skills' files hash alike, path by path. */
const sameFiles = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([path, hash]) => b[path] === hash);
const alreadyGone = (error: unknown) => error instanceof Refused && error.code === "unknown";
const refusal = (problems: TheProblem[]) =>
  new Refused(
    "invalid",
    problems
      .map((p) => p.message)
      .join(" ")
      .slice(0, MAX_MESSAGE),
  );

/** A unit that makes one connection and nothing else, by the field that names it, is a kind. */
export const slotFieldOf = ({ needs, gives, form }: TheUnit) => {
  const [slot] = gives.slots;
  return slot &&
    "field" in slot &&
    gives.slots.length === 1 &&
    !needs.length &&
    !gives.skills.length &&
    !gives.results.length &&
    !form.some((field) => field.adds || field.options?.some((option) => option.adds))
    ? slot.field
    : undefined;
};

export function createStacks(parts: StackParts) {
  const { self, hub, records, save, library, creating, log, changed, recordOf } = parts;

  const queues = new Map<string, Promise<void>>();
  /** One change to an agent at a time, in the order they came: each spans many calls. */
  const serial = <T>(agent: string, work: () => T | Promise<T>): Promise<T> => {
    const running = (queues.get(agent) ?? Promise.resolve()).then(work);
    const done = () => {
      if (queues.get(agent) === settled) queues.delete(agent);
    };
    const settled: Promise<void> = running.then(done, done);
    queues.set(agent, settled);
    return running;
  };

  const isAgentsUnit = (offer: Offer) => offer.provider === self && offer.unit.id === AGENTS_UNIT;
  /** The connections the person made, which an agents unit can list as places. */
  const places = async () => {
    const actors = await parts.openActors();
    return Object.entries(records.connections).flatMap(([connection, origin]) => {
      const actor = actors.get(connection);
      return actor && !origin.madeFor ? [{ value: connection, title: actor.name }] : [];
    });
  };
  /** The MCP unit: a connection there is, or any kind on offer, each with its own fields. */
  const mcpUnit = (kinds: TheUnit[]): TheUnit => {
    const fields = new Map<string, TheUnit["form"][number]>();
    for (const kind of kinds)
      for (const field of kind.form) {
        if (
          field.id === slotFieldOf(kind) ||
          [MCP_HOW, MCP_SLOT, CONNECTION_UNIT].includes(field.id)
        )
          continue;
        const shared = fields.get(field.id);
        if (shared?.visible) {
          shared.visible.in.push(kind.id);
          // Shared, it's open to an agent only if every kind says so.
          if (shared.authority !== field.authority) delete shared.authority;
        } else fields.set(field.id, { ...field, visible: { field: MCP_HOW, in: [kind.id] } });
      }
    return {
      id: MCP_UNIT,
      title: "MCP",
      description: "A server's tools, for this agent to use.",
      form: [
        {
          id: MCP_HOW,
          type: "choice",
          value: "string",
          title: "How",
          required: true,
          options: [
            { value: CONNECTION_UNIT, title: "A connection you have" },
            ...kinds.map(({ id, title, description }) => ({ value: id, title, description })),
          ],
        },
        {
          id: CONNECTION_UNIT,
          type: "connection",
          value: "string",
          title: "Connection",
          authority: "holds",
          required: true,
          visible: { field: MCP_HOW, in: [CONNECTION_UNIT] },
        },
        ...fields.values(),
        { id: MCP_SLOT, type: "text", value: "string", title: "Name", required: true },
      ],
      needs: [],
      gives: { slots: [{ field: MCP_SLOT }], skills: [], results: [] },
    };
  };
  const ownUnits = async (kinds: TheUnit[]): Promise<TheUnit[]> => [
    mcpUnit(kinds),
    agentsUnit(
      templates()
        .slice(0, MAX_OPTIONS)
        .map(({ id, title, description }) => ({ value: id, title, description })),
      (await places()).slice(0, MAX_OPTIONS - 1),
    ),
    {
      id: SKILL_UNIT,
      title: "Skill",
      description: "A skill from the library.",
      form: [
        {
          id: "skill",
          authority: "holds",
          type: "choice",
          value: "string",
          title: "Skill",
          required: true,
          options: library
            .list()
            .slice(0, MAX_OPTIONS)
            .map(({ name, description }) => ({ value: name, title: name, description })),
        },
      ],
      needs: [],
      gives: { slots: [], skills: [{ field: "skill" }], results: [] },
    },
    {
      id: CONNECTION_UNIT,
      title: "Connection",
      description: "A connection that already exists, under a name the agent sees.",
      form: [
        {
          id: "connection",
          authority: "holds",
          type: "connection",
          value: "string",
          title: "Connection",
          required: true,
        },
        { id: "slot", type: "text", value: "string", title: "Name", required: true },
      ],
      needs: [],
      gives: { slots: [{ field: "slot" }], skills: [], results: [] },
    },
  ];

  /** Every unit on offer now; a provider that doesn't answer offers none. */
  const catalog = async (): Promise<Offer[]> => {
    const [providerName, others] = await Promise.all([
      parts.nameOf(self),
      parts.fromEach(parts.unitProviders(), async ({ actor, call }) => {
        const name = await parts.nameOf(actor);
        return (await call.units({})).units.map(
          (unit): Offer => ({ unit, provider: actor, providerName: name, call }),
        );
      }),
    ]);
    const offers = others.flat();
    const kinds = offers.map((offer) => offer.unit).filter((unit) => slotFieldOf(unit));
    return [
      ...(await ownUnits(kinds)).map((unit) => ({ unit, provider: self, providerName })),
      ...offers,
    ];
  };

  const baseOf = async (base: StackBase) => {
    const provider = parts.agentProviders().find((one) => one.actor === base.provider);
    if (!provider)
      throw new Refused("unknown", `${base.provider} isn't a connected agent provider.`);
    const { creatables } = await provider.call.creatable({});
    const creatable = creatables.find((one) => one.id === base.creatable);
    if (!creatable) throw new Refused("unknown", `${base.provider} offers no ${base.creatable}.`);
    return { provider, creatable };
  };

  /** The unit's own logic on what was filled in; one that can't say is a problem. */
  const unitProblems = async (
    offer: Offer,
    values: Values,
    secrets: string[],
  ): Promise<TheProblem[]> => {
    if (!offer.call) {
      if (offer.unit.id !== CONNECTION_UNIT) return [];
      return (await parts.openActors()).has(String(values.connection))
        ? []
        : [{ field: "connection", message: "That connection doesn't exist." }];
    }
    try {
      return (await offer.call.check({ unit: offer.unit.id, values, secrets })).problems;
    } catch (error) {
      return [
        { message: `This unit couldn't check it: ${messageOf(error)}`.slice(0, MAX_MESSAGE) },
      ];
    }
  };

  /** What the MCP unit stands for, as it was filled in: the unit that does the work. */
  const throughMcp = (
    asked: Pick<FilledUnit, "provider" | "unit" | "values" | "secrets">,
    offers: Offer[],
  ) => {
    const own = offers.find((one) => one.provider === self && one.unit.id === MCP_UNIT);
    if (asked.provider !== self || asked.unit !== MCP_UNIT || !own) return { filled: asked };
    const settled = settle(own.unit.form, asked.values ?? {}, Object.keys(asked.secrets ?? {}));
    if (settled.problems.length) return { problems: settled.problems };
    const { [MCP_HOW]: how, [MCP_SLOT]: slot, ...values } = settled.values;
    if (how === CONNECTION_UNIT)
      return {
        filled: {
          provider: self,
          unit: CONNECTION_UNIT,
          values: { connection: values.connection as string, slot: slot as string },
        },
      };
    const kind = offers.find(
      (one) => one.provider !== self && one.unit.id === how && slotFieldOf(one.unit),
    );
    if (!kind) return { problems: [{ field: MCP_HOW, message: "That way isn't on offer now." }] };
    return {
      viaMcp: true as const,
      filled: {
        provider: kind.provider,
        unit: kind.unit.id,
        values: { ...values, [slotFieldOf(kind.unit) as string]: slot as string },
        secrets: Object.fromEntries(
          Object.entries(asked.secrets ?? {}).filter(([name]) => settled.secrets.includes(name)),
        ),
      },
    };
  };

  /** Everything that can be known about one unit before anything runs. `taken` grows by it. */
  const place = async (
    asked: Pick<FilledUnit, "provider" | "unit" | "values" | "secrets">,
    picks: Record<string, number | string>,
    taken: Taken,
    offers: Offer[],
    ref: number | undefined,
  ): Promise<{ problems: TheProblem[]; placed?: Placed }> => {
    const through = throughMcp(asked, offers);
    if (!through.filled) return { problems: through.problems as TheProblem[] };
    const { filled } = through;
    const offer = offers.find(
      (one) => one.provider === filled.provider && one.unit.id === filled.unit,
    );
    if (!offer)
      return { problems: [{ message: `${filled.provider} offers no unit ${filled.unit}.` }] };
    const { unit } = offer;
    const malformed = [...formProblems(unit.form), ...givesProblems(unit)];
    if (malformed.length) return { problems: malformed.map((message) => ({ message })) };

    const given = filled.secrets ?? {};
    const settled = settle(unit.form, filled.values ?? {}, Object.keys(given));
    const problems = [...settled.problems];

    const needs: Placed["needs"] = {};
    for (const kind of Object.keys(picks))
      if (!unit.needs.includes(kind))
        problems.push({ message: `${unit.title} doesn't need ${kind}.` });
    for (const kind of unit.needs) {
      const able = taken.givers.filter(
        (giver) => giver.provider === offer.provider && giver.results.includes(kind),
      );
      const pick = picks[kind];
      const giver =
        pick === undefined
          ? able.length === 1
            ? able[0]
            : undefined
          : able.find((one) => one.ref === pick);
      if (giver) needs[kind] = giver.ref;
      else
        problems.push({
          message:
            pick !== undefined
              ? `${unit.title} can't take ${kind} from the unit picked.`
              : able.length
                ? `${unit.title} needs one ${kind}: pick which.`
                : `${unit.title} needs a ${kind} from a unit above it.`,
        });
    }

    const here = (one: Giver) => one.provider === offer.provider && one.unit === unit.id;
    // Held once by `once` and by its capability alike, a second is told so once. An agent made
    // before its unit built a capability has none on record, so `once` is what refuses it then.
    const twice = unit.once === true && taken.givers.some(here);
    if (twice) problems.push({ message: `There is a ${unit.title} already.` });

    const worked = workedOut(unit, settled.values);
    for (const slot of worked.slots) {
      if (!SlotName.safeParse(slot).success)
        problems.push({ message: `${slot} can't name a connection.` });
      if (taken.slots.has(slot)) problems.push({ message: `The name ${slot} is already taken.` });
      taken.slots.add(slot);
    }
    for (const skill of worked.skills) {
      if (!SkillName.safeParse(skill.name).success)
        problems.push({ message: `${skill.name} can't name a skill.` });
      else if (!skill.files && !library.has(skill.name))
        problems.push({ message: `There is no skill ${skill.name}.` });
      if (taken.skills.has(skill.name))
        problems.push({ message: `Two units give the skill ${skill.name}.` });
      taken.skills.add(skill.name);
    }
    if (unit.capability) {
      // An agent holds one of a capability; and a view shows what its capability has.
      const { id, title } = unit.capability;
      if (taken.capabilities.has(id) && !twice)
        problems.push({ message: `There is a ${title} already.` });
      taken.capabilities.add(id);
      problems.push(...heldProblems(unit, worked).map((message) => ({ message })));
    }
    if (ref !== undefined)
      taken.givers.push({
        ref,
        provider: offer.provider,
        unit: unit.id,
        results: unit.gives.results,
      });

    if (settled.problems.length === 0)
      problems.push(...(await unitProblems(offer, settled.values, settled.secrets)));
    const secrets = Object.fromEntries(
      Object.entries(given).filter(([name]) => settled.secrets.includes(name)),
    );
    return {
      problems: problems.map((one) => ({ ...one, message: one.message.slice(0, MAX_MESSAGE) })),
      placed: {
        offer,
        values: settled.values,
        secrets,
        worked,
        needs,
        ...(through.viaMcp ? { viaMcp: true as const } : {}),
      },
    };
  };

  /** Place `units` on an agent whose creatable gives it the capability `itself`, if one. */
  const plan = async (units: FilledUnit[], reach?: Reach, itself?: string) => {
    const offers = await catalog();
    const taken: Taken = {
      slots: new Set(),
      skills: new Set(),
      capabilities: new Set(itself === undefined ? [] : [itself]),
      givers: [],
    };
    const placed: Placed[] = [];
    const problems: (TheProblem & { unit: number })[] = [];
    for (const [position, unit] of units.entries()) {
      const one = await place(unit, unit.needs ?? {}, taken, offers, position);
      problems.push(...one.problems.map((problem) => ({ ...problem, unit: position })));
      if (one.placed) placed.push(one.placed);
    }
    const computer = placed.find((one) => one.offer.unit.id === "computer");
    const own = reach ?? {
      access: String(computer?.values.access ?? "none"),
      browser: computer?.values.browser === true,
    };
    for (const [position, one] of placed.entries())
      if (isAgentsUnit(one.offer))
        problems.push(...reachProblems(one.values, own).map((p) => ({ ...p, unit: position })));
    return { placed, problems };
  };

  /** The connections a living agent has now; what is exposed to it is the Hub's to say. */
  const toolsOf = async (agent: string) =>
    (await hub.bindings.list({ actor: agent })).bindings.filter(
      (binding) =>
        binding.consumer === agent && binding.interface === TOOLS && !madeWork(agent, binding),
    );
  /** Whether a binding of `maker`'s is the Work of an agent it made, which no page shows. */
  const madeWork = (maker: string, binding: AgentBinding) =>
    records.agents[binding.provider]?.parent?.agent === maker &&
    binding.slot === workSlot(binding.provider);
  /** Whether a binding of `holder`'s is one of its reach to another agent, as management made it. */
  const agentReach = (holder: string, binding: AgentBinding) =>
    madeWork(holder, binding) ||
    (binding.slot === chatSlot(binding.provider) &&
      binding.export === records.agents[binding.provider]?.chat);

  const placeOnAgent = async (input: AddInput) => {
    const record = recordOf(input.agent);
    const taken: Taken = {
      slots: new Set(
        (await hub.bindings.list({ actor: input.agent })).bindings
          .filter((binding) => binding.consumer === input.agent)
          .map((binding) => binding.slot),
      ),
      skills: new Set(record.skills),
      capabilities: new Set(record.capabilities.map((one) => one.id)),
      givers: record.units.map((unit) => ({
        ref: unit.instance,
        provider: unit.provider,
        unit: unit.unit,
        results: unit.results.map((result) => result.kind),
      })),
    };
    const placing = await place(input.unit, input.needs ?? {}, taken, await catalog(), undefined);
    if (placing.placed && isAgentsUnit(placing.placed.offer))
      placing.problems.push(...reachProblems(placing.placed.values, reachOf(record)));
    // Its place: never above a unit it needs.
    const { at } = input;
    if (placing.placed && at !== undefined) {
      const needed = Object.values(placing.placed.needs);
      const giver = record.units.find((one, index) => index >= at && needed.includes(one.instance));
      if (giver)
        placing.problems.push({ message: `It needs ${giver.title}, which is below that place.` });
    }
    return placing;
  };

  const unwind = async (undo: (() => unknown)[]) => {
    for (const step of undo.reverse())
      await Promise.resolve()
        .then(step)
        .catch((failed) => log.error(`Undoing a creation: ${messageOf(failed)}`));
  };

  const closeAll = async (connections: { connection: string }[]) => {
    for (const { connection } of connections) await hub.actors.close({ actorId: connection });
  };

  /**
   * Have the agent hold what its creatable gives it of itself: the person is connected to the
   * agent's own `capability` and `tools`, as to a unit's capability's Actor and connections.
   */
  const holdOwn = async (
    record: TheAgent,
    agent: string,
    own: z.infer<typeof OwnCapability>,
    undo?: Work["undo"],
  ) => {
    const reach = async (exported: string) => {
      const slot = await parts.reachPerson(agent, exported);
      undo?.push(() => parts.unreachPerson(slot, agent));
      return slot;
    };
    const capability = await reach(CAPABILITY_EXPORT);
    const operations: Record<string, string> = {};
    for (const slot of new Set(own.views.flatMap((view) => (view.slot ? [view.slot] : []))))
      operations[slot] = await reach(TOOLS_EXPORT);
    record.capabilities.push({
      id: own.id,
      title: own.title,
      from: agent,
      actor: agent,
      slots: [],
      surfaces: [],
      views: own.views,
      person: { capability, operations },
    });
  };
  /**
   * Have each agent that manages its own reach the agents it may talk to: those it made, and with
   * "all", every other. It talks to each from itself, through that agent's `chat` exposed to it
   * under the agent's id, so the agent knows who speaks. It reads the Work of each it made as the
   * person does, through that agent's own `tools`, while that agent is connected: a maker's turns
   * that go on after a restart wait for every tools slot that is away. `which` limits it to the
   * (agent, holder) pairs it is true of. Each holder's are done in its queue, so they never race
   * its agents unit, whose removal takes them off; holders go side by side, so a slow queue
   * holds up only its own.
   */
  const reachAgents = async (which: (reached: string, holder: string) => boolean = () => true) => {
    const warned = (error: unknown) => {
      // Closed, with its record still here, or already taken off: nothing to do.
      if (!alreadyGone(error) && !(error instanceof Refused && error.code === "state"))
        log.warn(`Reaching another agent: ${messageOf(error)}`);
    };
    /** The agents `holder` reaches of those `which` names, as the records stand now. */
    const reachedBy = (holder: string) => {
      const record = records.agents[holder];
      if (!managesOwn(self, record)) return [];
      const all = managesAll(self, record);
      return Object.entries(records.agents).filter(
        ([id, one]) => id !== holder && (all || one.parent?.agent === holder) && which(id, holder),
      );
    };
    const holders = Object.keys(records.agents).filter((holder) => reachedBy(holder).length > 0);
    const reachFrom = (holder: string) =>
      serial(holder, async () => {
        for (const [id, reached] of reachedBy(holder)) {
          // Each apart, so one that fails leaves the other as it should be.
          const work = async () => {
            if (reached.parent?.agent !== holder || !givesWork(id)) return;
            if ((await hub.actors.get({ actorId: id })).connected)
              await hub.grants.expose({
                provider: id,
                export: TOOLS_EXPORT,
                to: holder,
                as: workSlot(id),
              });
            else await unreach(holder, id, (binding) => madeWork(holder, binding));
          };
          await work().catch(warned);
          await hub.grants
            .expose({ provider: id, export: reached.chat, to: holder, as: chatSlot(id) })
            .catch(warned);
        }
      }).catch(warned);
    await Promise.all(holders.map(reachFrom));
  };
  /** The skills left as they are this start, each logged once. */
  const toldLeft = new Set<string>();
  const left = (name: string, why: string) => {
    if (!toldLeft.has(name)) log.info(`The skill ${name} ${why}, so it is left as it is.`);
    toldLeft.add(name);
  };
  /** The files a unit says a skill of its has, in what it gives or what an answer adds. */
  const unitSkillFiles = (unit: TheUnit, name: string) =>
    [
      ...unit.gives.skills,
      ...unit.form.flatMap((field) => [
        ...(field.adds?.skills ?? []),
        ...(field.options ?? []).flatMap((option) => option.adds?.skills ?? []),
      ]),
    ].find((skill) => "name" in skill && skill.name === name) as
      | { name: string; files: string[] }
      | undefined;
  /**
   * Bring each skill a unit gave up to the files its unit gives now. A skill is replaced only
   * while it is as it was copied, and the agents that hold it are told; then its new copy is kept.
   * It follows the provider it was copied from: while that isn't here, it waits. A skill still to
   * be taken as a copy (`uncopied`) is taken from the first unit that gives its files, when each
   * file is the text that unit's provider serves now or one it shipped, and is otherwise left. A
   * skill the person or an agent added has no copy, and is never replaced.
   */
  const refreshSkills = async () => {
    const offers = await catalog();
    const offerOf = (by: string, unit: string) =>
      offers.find((one) => one.provider === by && one.unit.id === unit);
    const pending = new Set(records.uncopied);
    /** For each skill: the unit it was copied from, or, still to be taken, those that give it. */
    const givers = new Map<string, Offer[]>();
    for (const [name, copy] of Object.entries(records.copies)) {
      const offer = offerOf(copy.provider, copy.unit);
      if (offer) givers.set(name, [offer]);
    }
    for (const record of Object.values(records.agents))
      for (const unit of record.units)
        for (const name of unit.skills) {
          const offer = offerOf(unit.provider, unit.unit);
          if (!offer || !pending.has(name) || records.copies[name]) continue;
          givers.set(name, [...(givers.get(name) ?? []), offer]);
        }
    for (const [name, all] of givers) {
      const copy = records.copies[name];
      const offer = all.find((one) => unitSkillFiles(one.unit, name));
      if (!offer) continue;
      const paths = unitSkillFiles(offer.unit, name)?.files as string[];
      try {
        if (!library.has(name)) continue;
        const herePaths = library.paths(name);
        const hereNow = () =>
          hashesOf(
            Object.fromEntries(herePaths.map((path) => [path, library.read(name, path) ?? ""])),
          );
        const here = hereNow();
        // Changed here since it was copied: nothing is asked of the provider.
        if (copy && !sameFiles(here, copy.files)) {
          left(name, "isn't as it was copied here");
          continue;
        }
        const served: SkillFiles = {};
        const shipped: Record<string, string[]> = {};
        for (const path of paths) {
          const got = offer.call
            ? await offer.call.skill({ unit: offer.unit.id, name, path })
            : { text: skillFile(path), shipped: skillShipped(path) };
          if (got.text === undefined) throw new Refused("unknown", `${name} has no ${path} now.`);
          served[path] = got.text;
          shipped[path] = got.shipped ?? [];
        }
        const now = hashesOf(served);
        const shippedHere =
          samePaths(herePaths, paths) &&
          paths.every(
            (path) =>
              here[path] === now[path] || shipped[path]?.includes(here[path] as string) === true,
          );
        if (!copy && !shippedHere) {
          left(name, "isn't the text its unit gives");
          continue;
        }
        // What changed here while the provider answered is left to the next refresh.
        const still =
          library.has(name) &&
          samePaths(library.paths(name), herePaths) &&
          sameFiles(hereNow(), here) &&
          records.copies[name] === copy &&
          (copy !== undefined || records.uncopied.includes(name));
        if (!still) continue;
        if (!sameFiles(here, now)) {
          library.add(served, name);
          for (const [agent, record] of Object.entries(records.agents))
            if (record.skills.includes(name)) parts.changed(agent);
        }
        if (!copy || !sameFiles(copy.files, now)) {
          records.copies[name] = { provider: offer.provider, unit: offer.unit.id, files: now };
          records.uncopied = records.uncopied.filter((one) => one !== name);
          save();
        }
      } catch (error) {
        log.warn(`A skill couldn't be brought up to date: ${messageOf(error)}`, { skill: name });
      }
    }
  };
  /** Whether an agent holds Work of its own with an operation to call. */
  const givesWork = (agent: string) =>
    records.agents[agent]?.capabilities.some(
      (one) => one.from === agent && Object.keys(one.person.operations).length > 0,
    ) === true;
  /**
   * Have each agent hold what its creatable gives it of itself where it doesn't yet, as an agent
   * made before its creatable gave one: once the agent is there to be reached. `agent` limits it
   * to that one. Each provider is asked once.
   */
  const holdOwns = async (agent?: string) => {
    const asked = new Map<string, Promise<z.infer<typeof Creatable>[]>>();
    const creatablesOf = (provider: Provided<Agents>) => {
      let creatables = asked.get(provider.actor);
      if (!creatables) {
        creatables = provider.call.creatable({}).then((one) => one.creatables);
        asked.set(provider.actor, creatables);
      }
      return creatables;
    };
    for (const id of Object.keys(records.agents)) {
      if (agent !== undefined && id !== agent) continue;
      await serial(id, async () => {
        const record = records.agents[id];
        if (!record || record.capabilities.some((one) => one.from === id)) return;
        const provider = parts.agentProviders().find((one) => one.actor === record.provider);
        if (!provider) return;
        try {
          const own = (await creatablesOf(provider)).find(
            (one) => one.id === record.creatable,
          )?.capability;
          if (!own || record.capabilities.some((one) => one.id === own.id)) return;
          await holdOwn(record, id, own);
          save();
        } catch (error) {
          // Not there to be reached now: it is held when it comes back.
          log.warn(`Holding what an agent gives itself: ${messageOf(error)}`);
        }
      });
    }
  };

  /**
   * Have the agent hold the capability an applied unit built. What `apply` gave is checked
   * against what the unit said it gives; then the person is connected to the capability's Actor
   * and to each of its connections, as to the agent's chats, and what it is is kept on the
   * agent. From then on a page asks the capability through the person's own slots, and nothing
   * asks the unit.
   */
  const hold = async (
    work: Work,
    unit: TheUnit,
    { id, title }: NonNullable<TheUnit["capability"]>,
    worked: Worked,
    instance: string,
    connections: { slot: string; connection: string }[],
    built: Applied["capability"],
  ) => {
    const { record, undo } = work;
    if (!built)
      throw new Refused("failed", `${unit.title} didn't build the ${title} it said it would.`);
    // A view with neither an operation nor a surface has its rows fixed now, and only such a one.
    const fixed = worked.views.filter((view) => !view.operation && !view.surface);
    const rows = built.rows ?? {};
    const missing = fixed.find((view) => !rows[view.id]);
    if (missing)
      throw new Refused("failed", `${unit.title} gave no rows for its view "${missing.id}".`);
    const extra = Object.keys(rows).find((view) => !fixed.some((one) => one.id === view));
    if (extra)
      throw new Refused(
        "failed",
        `${unit.title} gave rows for "${extra}", which is not a view of its whose rows are fixed.`,
      );
    const reach = async (provider: string, exported: string) => {
      const slot = await parts.reachPerson(provider, exported);
      undo.push(() => parts.unreachPerson(slot, provider));
      return slot;
    };
    const person = {
      capability: await reach(built.actor, CAPABILITY_EXPORT),
      operations: {} as Record<string, string>,
    };
    for (const { slot, connection } of connections)
      person.operations[slot] = await reach(connection, TOOLS_EXPORT);
    record.capabilities.push({
      id,
      title,
      from: instance,
      actor: built.actor,
      slots: connections.map(({ slot }) => slot),
      surfaces: worked.surfaces,
      views: worked.views.map((view) => {
        const given = rows[view.id];
        return given ? { ...view, fixed: given } : view;
      }),
      person,
    });
    undo.push(() => {
      record.capabilities = record.capabilities.filter((one) => one.from !== instance);
    });
  };

  /** Run one placed unit for the agent, and give it what it gives. */
  const run = async (
    work: Work,
    placed: Placed,
    earlier: (ref: number | string) => TheUnitRecord | undefined,
  ) => {
    const { offer, values, worked } = placed;
    const { agent, record, undo } = work;
    let made: TheUnitRecord | undefined;
    if (offer.call) {
      const { call } = offer;
      const needs: Record<string, string> = {};
      const handles: Record<string, string> = {};
      for (const [kind, ref] of Object.entries(placed.needs)) {
        const giver = earlier(ref);
        const handle = giver?.results.find((result) => result.kind === kind)?.handle;
        if (!giver || !handle)
          throw new Refused("failed", `The unit above didn't give ${kind} as it said it would.`);
        needs[kind] = giver.instance;
        handles[kind] = handle;
      }
      const applied = await call.apply({
        unit: offer.unit.id,
        values,
        secrets: placed.secrets,
        needs: handles,
        agent,
        name: `${work.name}: ${offer.unit.title}`.slice(0, MAX_NAME),
        // Not for a child: a folder by a name it chose could be another agent's.
        ...(record.parent ? {} : { agentName: work.name }),
      });
      undo.push(async () => {
        try {
          await call.remove({ instance: applied.instance });
        } catch (error) {
          log.warn(`Removing a unit: ${messageOf(error)}`);
          await closeAll([
            ...applied.connections,
            ...(applied.capability ? [{ connection: applied.capability.actor }] : []),
          ]);
        }
      });
      const slots = applied.connections.map((one) => one.slot).sort();
      if (slots.join() !== [...worked.slots].sort().join())
        throw new Refused(
          "failed",
          `${offer.unit.title} didn't give the connections it said it would.`,
        );
      const results = applied.results.map((result) => result.kind);
      if (offer.unit.gives.results.some((kind) => !results.includes(kind)))
        throw new Refused(
          "failed",
          `${offer.unit.title} didn't give the results it said it would.`,
        );
      for (const { slot, connection, target } of applied.connections) {
        await parts.exposeConnection(agent, connection, slot);
        work.origins[connection] = {
          provider: offer.provider,
          kind: offer.unit.id,
          target,
          madeBy: work.caller,
          madeFor: agent,
          at: new Date().toISOString(),
        };
      }
      const instance = `uni_${crypto.randomUUID().replaceAll("-", "")}`;
      if (offer.unit.capability)
        await hold(
          work,
          offer.unit,
          offer.unit.capability,
          worked,
          instance,
          applied.connections,
          applied.capability,
        );
      made = {
        instance,
        provider: offer.provider,
        providerInstance: applied.instance,
        unit: offer.unit.id,
        title: offer.unit.title,
        values,
        needs,
        results: applied.results,
        connections: applied.connections.map(({ slot, connection }) => ({ slot, connection })),
        skills: worked.skills.map((skill) => skill.name),
        ...(placed.viaMcp ? { viaMcp: true as const } : {}),
      };
    } else if (offer.unit.id === CONNECTION_UNIT) {
      const slot = values.slot as string;
      await parts.exposeConnection(agent, values.connection as string, slot);
      undo.push(() => hub.grants.unexpose({ to: agent, slot }));
    } else if (isAgentsUnit(offer)) {
      await parts.exposeConnection(agent, self, AGENTS_SLOT);
      undo.push(() => hub.grants.unexpose({ to: agent, slot: AGENTS_SLOT }));
      const instance = `uni_${crypto.randomUUID().replaceAll("-", "")}`;
      made = {
        instance,
        provider: self,
        providerInstance: instance,
        unit: offer.unit.id,
        title: offer.unit.title,
        values,
        needs: {},
        results: [],
        connections: [{ slot: AGENTS_SLOT, connection: self }],
        skills: worked.skills.map((skill) => skill.name),
      };
    }

    for (const { name, files } of worked.skills) {
      if (!library.has(name)) {
        if (!files) throw new Refused("unknown", `There is no skill ${name}.`);
        const copied: SkillFiles = {};
        for (const path of files)
          copied[path] = offer.call
            ? (await offer.call.skill({ unit: offer.unit.id, name, path })).text
            : (skillFile(path) as string);
        library.add(copied, name);
        records.copies[name] = {
          provider: offer.provider,
          unit: offer.unit.id,
          files: hashesOf(copied),
        };
        // Another agent may have been given it meanwhile, and then it stays.
        undo.push(() => {
          if (
            ![...Object.values(records.agents), ...creating.values()].some((one) =>
              one.skills.includes(name),
            )
          ) {
            library.remove(name);
            delete records.copies[name];
          }
        });
      }
      record.skills.push(name);
      undo.push(() => {
        record.skills = record.skills.filter((skill) => skill !== name);
      });
    }

    if (made) {
      const instance = made.instance;
      record.units.push(made);
      undo.push(() => {
        record.units = record.units.filter((unit) => unit.instance !== instance);
      });
    }
    return made;
  };

  /**
   * Put a unit of the agent's at `at` in its stack, from the top, and what the agent holds in the
   * stack's order: each unit's, then what its creatable gives it, as it was made.
   */
  const placeAt = (record: TheAgent, instance: string, at: number) => {
    const from = record.units.findIndex((one) => one.instance === instance);
    const [unit] = record.units.splice(from, 1);
    if (unit) record.units.splice(Math.min(at, record.units.length), 0, unit);
    const order = (ref = "") => {
      const index = record.units.findIndex((one) => one.instance === ref);
      return index < 0 ? record.units.length : index;
    };
    record.capabilities.sort((a, b) => order(a.from) - order(b.from));
  };

  const keepOrigins = (work: Work) => {
    Object.assign(records.connections, work.origins);
    work.undo.push(() => {
      for (const connection of Object.keys(work.origins)) delete records.connections[connection];
    });
  };

  /** What a stack is, whichever way the caller said it. */
  const stackOf = async (input: CreateInput): Promise<StackInput> => {
    if ("stack" in input) return input.stack;
    const template = templates().find((one) => one.id === input.template);
    if (!template) throw new Refused("unknown", `There is no template ${input.template}.`);
    const fill = input.fill ?? [];
    if (fill.length > template.units.length)
      throw new Refused("invalid", `The template has ${template.units.length} units.`);
    const offers = await catalog();
    const base = await baseProviderNamed(template.base.provider);
    return {
      base: {
        provider: base,
        creatable: template.base.creatable,
        answers: { ...template.base.answers, ...input.answers },
      },
      units: template.units.map((unit, position) => {
        const offer = offerNamed(offers, unit.provider, unit.unit);
        const filled = fill[position];
        return {
          provider: offer.provider,
          unit: unit.unit,
          values: { ...unit.values, ...filled?.values },
          ...(unit.needs ? { needs: unit.needs } : {}),
          ...(filled?.secrets ? { secrets: filled.secrets } : {}),
        };
      }),
      template: template.id,
    };
  };

  const baseProviderNamed = async (name: string) => {
    for (const { actor } of parts.agentProviders())
      if ((await parts.nameOf(actor)) === name) return actor;
    throw new Refused("unknown", `No connected agent provider is called ${name}.`);
  };
  const offerNamed = (offers: Offer[], providerName: string, unit: string) => {
    const offer = offers.find((one) => one.providerName === providerName && one.unit.id === unit);
    if (!offer) throw new Refused("unknown", `${providerName} offers no unit ${unit}.`);
    return offer;
  };
  const templates = () =>
    Object.values({
      ...Object.fromEntries(parts.shipped.map((one) => [one.id, one])),
      ...records.templates,
    });

  /**
   * Take back from `holder` its reach to other agents, or to `agent` alone: what `which` says, by
   * default their Work and their conversations.
   */
  const unreach = async (
    holder: string,
    agent?: string,
    which: (binding: AgentBinding) => boolean = (binding) => agentReach(holder, binding),
  ) => {
    for (const binding of (await hub.bindings.list({ actor: holder })).bindings)
      if (
        binding.consumer === holder &&
        which(binding) &&
        (agent === undefined || binding.provider === agent)
      )
        await hub.grants.unexpose({ to: holder, slot: binding.slot }).catch((error) => {
          if (!alreadyGone(error)) throw error;
        });
  };
  /** Remove a unit and what it made; a provider that has lost it leaves only the connections. */
  const dropUnit = async (agent: string, record: TheAgent, unit: TheUnitRecord) => {
    if (unit.provider === self) {
      await hub.grants.unexpose({ to: agent, slot: AGENTS_SLOT }).catch((error) => {
        if (!alreadyGone(error)) throw error;
      });
      await unreach(agent);
      record.skills = record.skills.filter((skill) => !unit.skills.includes(skill));
      record.units = record.units.filter((one) => one.instance !== unit.instance);
      save();
      return;
    }
    const built = record.capabilities.filter((one) => one.from === unit.instance);
    const provider = parts.unitProviders().find((one) => one.actor === unit.provider);
    let removed = false;
    try {
      if (provider) {
        await provider.call.remove({ instance: unit.providerInstance });
        removed = true;
      }
    } catch (error) {
      // A unit that can't go stays whole, the person's slots to it with it.
      if (!alreadyGone(error)) throw error;
    }
    // A provider that has lost it leaves the Actors: its connections, and what it built.
    if (!removed)
      await closeAll([...unit.connections, ...built.map(({ actor }) => ({ connection: actor }))]);
    // The person's slots to what it built went with the Actors. One that is left is taken off,
    // and only while it is still bound to what the unit made: a name the Hub has freed can be
    // another export's by now.
    for (const { actor, person } of built) {
      await parts.unreachPerson(person.capability, actor);
      for (const { slot, connection } of unit.connections) {
        const reached = person.operations[slot];
        if (reached) await parts.unreachPerson(reached, connection);
      }
    }
    for (const { connection } of unit.connections) delete records.connections[connection];
    record.skills = record.skills.filter((skill) => !unit.skills.includes(skill));
    record.units = record.units.filter((one) => one.instance !== unit.instance);
    record.capabilities = record.capabilities.filter((one) => one.from !== unit.instance);
    save();
  };

  /**
   * Make the person's slots to what agents hold again, where the Hub has dropped one, as it
   * does when an Actor stops offering its export or offers it as another interface. Nothing
   * changes where they are there. `actor` is the one that came back; with none, every one is
   * looked at.
   */
  const reachHeld = async (actor?: string) => {
    let changed = false;
    for (const [agent, record] of Object.entries(records.agents))
      for (const held of record.capabilities) {
        const unit = record.units.find((one) => one.instance === held.from);
        // One the agent holds of itself has its operations in the agent's own `tools`.
        const operations =
          held.from === agent
            ? Object.keys(held.person.operations).map((slot) => ({ slot, connection: held.actor }))
            : (unit?.connections ?? []);
        const ends = [
          {
            provider: held.actor,
            exported: CAPABILITY_EXPORT,
            was: held.person.capability,
            set(slot: string) {
              held.person.capability = slot;
            },
          },
          ...operations.map(({ slot, connection }) => ({
            provider: connection,
            exported: TOOLS_EXPORT,
            was: held.person.operations[slot],
            set(to: string) {
              held.person.operations[slot] = to;
            },
          })),
        ];
        for (const end of ends) {
          if (actor !== undefined && end.provider !== actor) continue;
          try {
            const slot = await parts.reachPerson(end.provider, end.exported);
            if (slot === end.was) continue;
            end.set(slot);
            changed = true;
          } catch (error) {
            // Not there to be reached now: it is made when it comes back.
            log.warn(`Reaching what an agent holds: ${messageOf(error)}`);
          }
        }
      }
    if (changed) save();
  };

  /** Which unit made a connection, if one did. */
  const unitMaking = (connection: string) => {
    for (const record of Object.values(records.agents))
      for (const unit of record.units)
        if (unit.connections.some((one) => one.connection === connection)) return unit;
    return undefined;
  };
  const statusOf = async (unit: Pick<TheUnitRecord, "provider" | "providerInstance">) =>
    unit.provider === self
      ? { state: "connected" as const, detail: undefined, connections: [] }
      : parts
          .unitProviders()
          .find((one) => one.actor === unit.provider)
          ?.call.status({ instance: unit.providerInstance });
  const DOWN = { state: "down" as const, detail: "Its provider can't be reached." };

  const fromUnit = (record: TheAgent, given: { slot: string } | { skill: string }) =>
    record.units.some((unit) =>
      "slot" in given
        ? unit.connections.some((one) => one.slot === given.slot)
        : unit.skills.includes(given.skill),
    );

  return {
    serial,
    fromUnit,
    reachHeld,
    holdOwns,
    reachAgents,
    refreshSkills,
    unitMaking,
    catalog,
    allTemplates: templates,
    baseProviderNamed,
    /** How one connection a unit made stands, as its unit says. */
    async connectionStatus(
      unit: Pick<TheUnitRecord, "provider" | "providerInstance">,
      connection: string,
    ): Promise<z.infer<typeof ConnectionStatus>> {
      if (unit.provider === self) return { state: "connected", tools: [] };
      try {
        const found = (await statusOf(unit))?.connections.find(
          (one) => one.connection === connection,
        );
        if (found) {
          const { connection: _, ...status } = found;
          return status;
        }
      } catch (error) {
        log.warn(`A unit's status: ${messageOf(error)}`);
      }
      return { ...DOWN, tools: [] };
    },

    /**
     * The agent's stack, top to bottom, as providers made it, and which unit gave each skill and
     * slot: none for one the person exposed.
     */
    async read(agent: string, record: TheAgent) {
      const tools = await toolsOf(agent);
      const instanceOfSkill = (name: string) =>
        record.units.find((unit) => unit.skills.includes(name))?.instance;
      const instanceOfSlot = (slot: string) =>
        record.units.find((unit) => unit.connections.some((one) => one.slot === slot))?.instance;
      const units = await Promise.all(
        record.units.map(async (unit) => {
          let status: {
            state: "connecting" | "connected" | "down";
            detail?: string;
            surfaces?: z.infer<typeof LiveSurface>[];
          } = DOWN;
          try {
            const answer = await statusOf(unit);
            if (answer)
              status = {
                state: answer.state,
                ...(answer.detail ? { detail: answer.detail } : {}),
                ...("surfaces" in answer && answer.surfaces ? { surfaces: answer.surfaces } : {}),
              };
          } catch (error) {
            log.warn(`A unit's status: ${messageOf(error)}`);
          }
          return {
            instance: unit.instance,
            ...(unit.viaMcp
              ? {
                  provider: self,
                  unit: MCP_UNIT,
                  title: "MCP",
                  values: { [MCP_HOW]: unit.unit, ...unit.values },
                }
              : {
                  provider: unit.provider,
                  unit: unit.unit,
                  title: unit.title,
                  values: unit.values,
                }),
            needs: unit.needs,
            status,
          };
        }),
      );
      // What it holds, from the record alone: no unit is asked, and nothing of how it stands.
      // Without its Actor's id: a page reaches it by the person's slots, which are in it.
      // Its own has no `from` for a page: no unit made it.
      const capabilities = record.capabilities.map((kept) => {
        const { from, ...held } = known(kept);
        return from === agent ? held : { ...held, from };
      });
      return { units, tools, instanceOfSkill, instanceOfSlot, capabilities };
    },

    async units() {
      const [bases, offers] = await Promise.all([
        parts.fromEach(parts.agentProviders(), async ({ actor, call }) => {
          const providerName = await parts.nameOf(actor);
          return (await call.creatable({})).creatables.map((one) => ({
            ...one,
            provider: actor,
            providerName,
          }));
        }),
        catalog(),
      ]);
      return {
        bases: bases.flat(),
        // What the MCP unit stands for isn't listed apart from it.
        units: offers
          .filter(
            ({ unit, provider }) =>
              !(provider === self ? unit.id === CONNECTION_UNIT : slotFieldOf(unit)),
          )
          .map(({ unit, provider, providerName }) => ({ ...unit, provider, providerName })),
      };
    },
    /** Each template, with `shipped` on one the app ships: one that is not a saved one. */
    templates: () => ({
      templates: templates().map((one) =>
        one === records.templates[one.id] ? one : { ...one, shipped: true as const },
      ),
    }),
    /** With `agent`, it's that agent's own: it replaces nothing, and starts no program. */
    async saveTemplate(template: TheTemplate, agent?: string) {
      if (agent && templates().some((one) => one.id === template.id))
        throw new Refused("state", `There is a template ${template.id} already.`);
      if (
        agent &&
        Object.values(records.authors.templates).filter((one) => one === agent).length >=
          AGENT_TEMPLATES
      )
        throw new Refused("limit", `An agent can save at most ${AGENT_TEMPLATES} templates.`);
      await baseProviderNamed(template.base.provider);
      const offers = await catalog();
      for (const unit of template.units) {
        const { form } = offerNamed(offers, unit.provider, unit.unit).unit;
        // A way not on offer now has fields no one can tell are secret, so it can't be kept.
        const how = form.find((field) => field.id === MCP_HOW);
        if (unit.unit === MCP_UNIT && !how?.options?.some((one) => one.value === unit.values?.how))
          throw new Refused("unknown", `${String(unit.values?.how)} isn't on offer now.`);
        for (const field of form) {
          if (field.value === "secret" && unit.values?.[field.id] !== undefined)
            throw new Refused("invalid", `${field.title} is a secret: a template holds none.`);
          if (agent && field.authority === "runs" && unit.values?.[field.id] !== undefined)
            throw new Refused("invalid", `An agent's template can't say what ${field.title} runs.`);
        }
      }
      records.templates[template.id] = template;
      // Saved by the person, it's the person's, whoever saved it first.
      if (agent) records.authors.templates[template.id] = agent;
      else delete records.authors.templates[template.id];
      save();
      return {};
    },
    removeTemplate({ id }: { id: string }, agent?: string) {
      if (!records.templates[id] || (agent && records.authors.templates[id] !== agent))
        throw new Refused("unknown", `No saved template ${id}.`);
      delete records.templates[id];
      delete records.authors.templates[id];
      save();
      return {};
    },

    async check(input: CheckInput) {
      const problems: (TheProblem & { unit?: number })[] = [];
      if ("stack" in input) {
        const based = await baseOf(input.stack.base).catch((error) => {
          problems.push({ message: messageOf(error).slice(0, MAX_MESSAGE) });
          return undefined;
        });
        const own = based?.creatable.capability?.id;
        problems.push(...(await plan(input.stack.units, undefined, own)).problems);
      } else problems.push(...(await placeOnAgent(input)).problems);
      return { problems: problems.slice(0, MAX_PROBLEMS) };
    },

    /** All or none: what this made is undone, last first, if a step fails. */
    async create(input: CreateInput, caller: string, child?: Child) {
      const stack = await stackOf(input);
      const { provider, creatable } = await baseOf(stack.base);
      const { placed, problems } = await plan(stack.units, child?.reach, creatable.capability?.id);
      if (problems.length) throw refusal(problems);

      const undo: Work["undo"] = [];
      try {
        const made = await provider.call.create({
          creatable: creatable.id,
          name: input.name,
          answers: stack.base.answers ?? {},
        });
        const { agent } = made;
        undo.push(() => parts.closing(agent, () => parts.removeAgent(agent, provider.actor)));
        const record: TheAgent = {
          provider: provider.actor,
          creatable: creatable.id,
          instructions: creatable.instructions,
          skills: [],
          units: [],
          capabilities: [],
          chat: made.chat,
          ...(input.purpose ? { purpose: input.purpose } : {}),
          ...(stack.template ? { template: stack.template } : {}),
          ...(child ? { parent: child.parent } : {}),
          ...(child?.computer ? { computer: child.computer } : {}),
        };
        creating.set(agent, record);
        undo.push(() => creating.delete(agent));
        await hub.grants.bind({
          consumer: agent,
          slot: made.settings,
          provider: self,
          export: "settings",
        });

        const work: Work = { agent, name: input.name, caller, record, undo, origins: {} };
        const applied = new Map<number | string, TheUnitRecord>();
        for (const [position, one] of placed.entries()) {
          const unit = await run(work, one, (ref) => applied.get(ref));
          if (unit) applied.set(position, unit);
        }

        if (child) {
          for (const { slot, connection } of child.shares)
            await parts.exposeConnection(agent, connection, slot);
          for (const name of child.skills)
            if (library.has(name) && !record.skills.includes(name)) record.skills.push(name);
        }
        await hub.grants.expose({ provider: agent, export: made.chat, to: "person" });
        if (creatable.capability) await holdOwn(record, agent, creatable.capability, undo);
        records.agents[agent] = record;
        undo.push(() => delete records.agents[agent]);
        keepOrigins(work);
        save();
        creating.delete(agent);
        // Its maker reaches it before this returns, as does it every other agent if it is at
        // "all"; any other agent at "all" reaches it in its own queue's time. The maker reaches its
        // Work once it is connected.
        const now = (reached: string, holder: string) =>
          holder === agent || (reached === agent && holder === child?.parent.agent);
        await reachAgents(now);
        void reachAgents((reached, holder) => reached === agent && !now(reached, holder));
        return { agent };
      } catch (error) {
        await unwind(undo);
        throw error;
      }
    },

    async addUnit(input: AddInput, caller: string) {
      const { agent, at } = input;
      const record = recordOf(agent);
      const { placed, problems } = await placeOnAgent(input);
      if (problems.length || !placed) throw refusal(problems);
      const undo: Work["undo"] = [];
      const work: Work = {
        agent,
        name: await parts.nameOf(agent),
        caller,
        record,
        undo,
        origins: {},
      };
      try {
        const unit = await run(work, placed, (ref) =>
          record.units.find((one) => one.instance === ref),
        );
        if (unit && at !== undefined) placeAt(record, unit.instance, at);
        keepOrigins(work);
        save();
        changed(agent);
        if (unit) return { instance: unit.instance };
        return {
          instance:
            placed.offer.unit.id === SKILL_UNIT
              ? skillInstance(placed.values.skill as string)
              : slotInstance(placed.values.slot as string),
        };
      } catch (error) {
        await unwind(undo);
        throw error;
      }
    },

    async removeUnit({ agent, instance }: { agent: string; instance: string }) {
      const record = recordOf(agent);
      const unit = record.units.find((one) => one.instance === instance);
      if (unit) {
        const needing = record.units.find((one) => Object.values(one.needs).includes(instance));
        if (needing) throw new Refused("state", `${needing.title} needs this unit.`);
        await dropUnit(agent, record, unit);
        changed(agent);
        return {};
      }
      // What a provider's unit gave isn't a unit of its own, so it can't be taken off alone.
      const skill = record.skills.find(
        (name) => skillInstance(name) === instance && !fromUnit(record, { skill: name }),
      );
      if (skill) {
        record.skills = record.skills.filter((name) => name !== skill);
        save();
        changed(agent);
        return {};
      }
      const tool = (await toolsOf(agent)).find(
        ({ slot }) => slotInstance(slot) === instance && !fromUnit(record, { slot }),
      );
      if (!tool) throw new Refused("unknown", `${agent} has no unit ${instance}.`);
      await hub.grants.unexpose({ to: agent, slot: tool.slot });
      return {};
    },

    /** Every unit, last first: if one can't go, what is left can be tried again. */
    async removeAll(agent: string, record: TheAgent) {
      for (const unit of [...record.units].reverse()) await dropUnit(agent, record, unit);
    },
  };
}
