/**
 * The agents unit: what lets an agent make and manage agents of its own, within what the person
 * allowed. The agent holds no authority of the Hub's. It calls management's tools, and management,
 * which holds that authority, works out who is calling and what that caller's unit allows.
 */
import type { Field, FieldValues, Problem, Template, ToolEntry, Unit } from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import { z } from "zod";
import { schemaOf, settle } from "./form.js";
import type { AgentRecord, Offer, StackInput } from "./stack.js";

export const AGENTS_UNIT = "agents";
export const AGENTS_SLOT = "agents";
const COMPUTER = "computer";
/** The place that is the parent's own computer; every other place is a connection's id. */
const OWN = "own";
/** A new computer for the child, on the service its parent's computer runs on. */
const NEW = "new";
/** The only service a child's computer can go on: elsewhere needs a token no agent may pass on. */
const LOCAL_SERVICE = "local";
const LEVELS = ["none", "read", "files", "terminal"];

/** How many agents one agent may have alive at once, at most and unless the person says. */
export const LIMIT_MAX = 8;
const LIMIT_DEFAULT = 3;
/** How many levels below an agent may exist, at most. */
export const DEPTH_MAX = 3;
/** Above this many agents in the home, none is made by an agent. They share one plan. */
export const HOME_CAP = 24;
const HOME = "home";

const OUTPUT_MAX = 200_000;
const READ_DEFAULT = 20;
const READ_MAX = 200;

const SKILL = "delegating";
const SKILL_FILE = "SKILL.md";
const SKILL_TEXT = `---
name: ${SKILL}
description: How to hand work to agents of your own and see it through. Use it before creating an agent, and whenever you have work that can run apart from yours.
---
You can create agents and manage the ones you created, with the tools of your \`agents\` connection.

## Before you create one

Do the work yourself when it is short. An agent costs model usage from the plan everyone here shares, and you have a limit on how many you can have. Use one when work can run apart from yours, or needs a shape you were not given.

There is one create tool per template you may use. Read its description and fields. Give the agent a plain name and a purpose: one sentence on what it is for, which it will be told. Fields you leave out keep the template's value.

## Working with it

- \`send\` gives it a message and returns at once. It works on its own after that.
- \`status\` says whether it is thinking or idle. \`read\` shows what it said. Check back when you need the result, rather than after every step.
- Say what you want back and in what form. It knows only what you send it and its purpose.
- You cannot see or reach any agent you did not create.

## When it is done

\`remove\` it when its work is finished, so your limit is free for the next one. \`stop\` it to keep it for later. The person sees every agent you create on their Agents page, and can stop or remove any of them.
`;
export const skillFile = (path: string) => (path === SKILL_FILE ? SKILL_TEXT : undefined);

type Values = z.infer<typeof FieldValues>;
type Value = Values[string];
type TheUnit = z.infer<typeof Unit>;
type TheAgent = z.infer<typeof AgentRecord>;
type TheTemplate = z.infer<typeof Template>;
type TheProblem = z.infer<typeof Problem>;
type TheField = z.infer<typeof Field>;

/** The agents unit's form, with what can be chosen today. */
export function agentsUnit(
  templates: { value: string; title: string; description?: string }[],
  places: { value: string; title: string }[],
): TheUnit {
  return {
    id: AGENTS_UNIT,
    title: "Agents",
    description: "It can create and manage agents of its own, within what you allow here.",
    form: [
      {
        id: "templates",
        authority: "setting",
        type: "choices",
        value: "strings",
        title: "Templates",
        description: "What its agents can be made from.",
        required: true,
        options: templates,
      },
      {
        id: "places",
        authority: "setting",
        type: "choices",
        value: "strings",
        title: "Places",
        description: "Where its agents can work, when their template has a computer.",
        options: [
          { value: OWN, title: "Its own computer" },
          { value: NEW, title: "A new computer on the same service" },
          ...places,
        ],
      },
      {
        id: "access",
        authority: "setting",
        type: "choice",
        value: "string",
        title: "Most a computer can do",
        description: "Never more than its own computer can.",
        default: "none",
        options: LEVELS.map((value) => ({ value, title: value })),
      },
      {
        id: "browser",
        authority: "setting",
        type: "toggle",
        value: "boolean",
        title: "A computer can have a browser",
        description: "Only if its own computer has one.",
        default: false,
      },
      {
        id: "limit",
        authority: "setting",
        type: "number",
        value: "number",
        title: "How many at once",
        default: LIMIT_DEFAULT,
        min: 1,
        max: LIMIT_MAX,
      },
      {
        id: "depth",
        type: "number",
        value: "number",
        title: "Levels below it",
        description: "1 means its agents can't create agents.",
        default: 1,
        min: 1,
        max: DEPTH_MAX,
      },
    ],
    needs: [],
    gives: {
      slots: [{ name: AGENTS_SLOT }],
      skills: [{ name: SKILL, files: [SKILL_FILE] }],
      results: [],
    },
  };
}

const rank = (level: unknown) => Math.max(LEVELS.indexOf(String(level)), 0);

/** A computer's reach: how far it can act, and what an agent sharing it is given. */
export interface Reach {
  access: string;
  browser: boolean;
  connections: { slot: string; connection: string }[];
  skills: string[];
  /** Which service it is on, when it says. */
  service?: string;
}
const NOWHERE: Reach = { access: "none", browser: false, connections: [], skills: [] };

/** How far an agent's own computer reaches now. */
export function reachOf(record: TheAgent): Reach {
  const unit = record.units.find((one) => one.unit === COMPUTER);
  if (!unit) return record.computer ?? NOWHERE;
  return {
    access: String(unit.values.access ?? "none"),
    browser: unit.values.browser === true,
    connections: unit.connections,
    skills: unit.skills,
    ...(typeof unit.values.service === "string" ? { service: unit.values.service } : {}),
  };
}

/** What an agents unit may not ask for, given the computer of the agent that holds it. */
export function reachProblems(
  values: Values,
  reach: { access: string; browser: boolean },
): TheProblem[] {
  const problems: TheProblem[] = [];
  if (rank(values.access) > rank(reach.access))
    problems.push({ field: "access", message: "Its agents can't do more than its own computer." });
  if (values.browser === true && !reach.browser)
    problems.push({ field: "browser", message: "It has no browser of its own to allow." });
  return problems;
}

interface Bound {
  templates: string[];
  places: string[];
  access: string;
  browser: boolean;
  limit: number;
  depth: number;
}
const boundOf = (values: Values): Bound => ({
  templates: (values.templates ?? []) as string[],
  places: (values.places ?? []) as string[],
  access: String(values.access ?? "none"),
  browser: values.browser === true,
  limit: Number(values.limit ?? LIMIT_DEFAULT),
  depth: Number(values.depth ?? 1),
});

/** A template as a parent may use it: the units it applies, and the places it may go. */
interface Shape {
  units: {
    key: string;
    position: number;
    offer: Offer;
    values: Values;
    needs?: object;
  }[];
  /** None when the template has no computer, so no place is asked for. */
  places?: string[];
  /** The template's computer, which is applied only for a new one. */
  computer?: { offer: Offer; values: Values };
}

const isAgentsUnit = (self: string, offer: Offer) =>
  offer.provider === self && offer.unit.id === AGENTS_UNIT;

/**
 * How a parent may make a child from a template, or nothing if it can't. The units are the
 * template's: one that can't be applied as it stands rules out the template, not just the unit. A
 * computer isn't applied: the child goes to one of the places allowed.
 */
function shapeOf(
  self: string,
  template: TheTemplate,
  offers: Offer[],
  bound: Bound,
  reach: Reach,
): Shape | undefined {
  const units: Shape["units"] = [];
  const positions = new Map<number, number>();
  let computer: Shape["computer"];
  const seen = new Map<string, number>();
  for (const [position, unit] of template.units.entries()) {
    const offer = offers.find(
      (one) => one.providerName === unit.provider && one.unit.id === unit.unit,
    );
    if (!offer) return undefined;
    if (unit.unit === COMPUTER) {
      computer = { offer, values: unit.values ?? {} };
      continue;
    }
    if (isAgentsUnit(self, offer) && bound.depth <= 1) return undefined;
    // What an agent can't set must already be there. That includes any secret it would need.
    const { form } = offer.unit;
    const settled = settle(form, unit.values ?? {}, []);
    if (settled.problems.some((one) => !form.find((f) => f.id === one.field && settable(f))))
      return undefined;
    for (const needed of Object.values(unit.needs ?? {}))
      if (!positions.has(needed)) return undefined;
    positions.set(position, units.length);
    const count = (seen.get(unit.unit) ?? 0) + 1;
    seen.set(unit.unit, count);
    units.push({
      key: count === 1 ? unit.unit : `${unit.unit}_${count}`,
      position,
      offer,
      values: unit.values ?? {},
      ...(unit.needs
        ? {
            needs: Object.fromEntries(
              Object.entries(unit.needs).map(([kind, from]) => [kind, positions.get(from)]),
            ),
          }
        : {}),
    });
  }
  if (!computer) return { units };
  // Sharing its own computer gives the child exactly its reach, so the bound must allow that.
  const own =
    reach.connections.length > 0 &&
    rank(reach.access) <= rank(bound.access) &&
    (!reach.browser || bound.browser);
  // A new one is made within the bounds, on the service its parent is on.
  const fresh = reach.service === LOCAL_SERVICE;
  const places = bound.places.filter((place) => (place !== OWN || own) && (place !== NEW || fresh));
  return places.length ? { units, places, computer } : undefined;
}

const settable = (field: TheField) => field.authority === "setting";

/** A field with what may be chosen cut to a limit, by its type; gone if nothing is left. */
function cutToLimit(field: TheField, limit: unknown): TheField[] {
  if (limit === undefined) return [field];
  const within = (option: { value: string }) => {
    if (field.type === "choice") return indexIn(field, option.value) <= indexIn(field, limit);
    return (limit as string[]).includes(option.value);
  };
  switch (field.type) {
    case "toggle":
      return limit === true ? [field] : [];
    case "number":
      return [{ ...field, max: Math.min(field.max ?? Number(limit), Number(limit)) }];
    case "choice":
    case "choices":
    case "connection":
      return [{ ...field, ...(field.options ? { options: field.options.filter(within) } : {}) }];
    default:
      return [field];
  }
}
const indexIn = (field: TheField, value: unknown) =>
  Math.max(field.options?.findIndex((option) => option.value === value) ?? 0, 0);

/** Why a value given for a field is more than a limit allows, if it is. */
function overLimit(field: TheField, given: unknown, limit: unknown) {
  if (given === undefined || limit === undefined) return undefined;
  switch (field.type) {
    case "toggle":
      return given === true && limit !== true ? `This agent may not allow ${field.id}.` : undefined;
    case "number":
      return Number(given) > Number(limit) ? `This agent may allow at most ${limit}.` : undefined;
    case "choice":
      return indexIn(field, given) > indexIn(field, limit)
        ? "That reaches further than this agent may allow."
        : undefined;
    case "choices":
    case "connection":
      return [given].flat().some((one) => !(limit as string[]).includes(String(one)))
        ? `That is more ${field.id} than this agent has.`
        : undefined;
    default:
      return undefined;
  }
}

/** A value brought within a limit, by the field's type. */
function withinLimit(field: TheField, value: Value | undefined, limit: unknown): Value {
  if (limit === undefined) return value as Value;
  switch (field.type) {
    case "toggle":
      return value === true && limit === true;
    case "number":
      return Math.min(Number(value ?? limit), Number(limit));
    case "choice":
      return field.options?.[Math.min(indexIn(field, value), indexIn(field, limit))]
        ?.value as string;
    case "choices":
    case "connection":
      return [value ?? []]
        .flat()
        .map(String)
        .filter((one) => (limit as string[]).includes(one));
    default:
      return value as Value;
  }
}

/** The form an agent fills for one unit: what it may set, with the template's values as defaults. */
function formFor(self: string, unit: Shape["units"][number], bound: Bound) {
  const fields = unit.offer.unit.form.filter(settable);
  const narrowed = isAgentsUnit(self, unit.offer)
    ? fields.flatMap((field) => cutToLimit(field, limitOf(bound, field)))
    : fields;
  return narrowed.map((field) =>
    unit.values[field.id] === undefined ? field : { ...field, default: unit.values[field.id] },
  );
}
const limitOf = (bound: Limits, field: TheField) =>
  Object.hasOwn(bound, field.id)
    ? (bound as unknown as Record<string, unknown>)[field.id]
    : undefined;
/** What bounds a field, by its id: an agents unit's own, or a new computer's reach. */
type Limits = Bound | { access: string; browser: boolean };
/** A new computer is held by how far it reaches, and by nothing else of the unit's bounds. */
const reachLimits = ({ access, browser }: Bound) => ({ access, browser });

/** The bounds on a new computer: those of the unit, and of its holder's computer as it is now. */
const withinReach = (bound: Bound, reach: Reach): Bound => ({
  ...bound,
  access: LEVELS[Math.min(rank(bound.access), rank(reach.access))] as string,
  browser: bound.browser && reach.browser,
});

/** What an agent fills for a new computer: what it may set, within the bounds. */
function newComputerForm(computer: NonNullable<Shape["computer"]>, bound: Bound) {
  return computer.offer.unit.form
    .filter(settable)
    .flatMap((field) => cutToLimit(field, limitOf(reachLimits(bound), field)));
}

/** A new computer's values: the template's, within the bounds, on the parent's service. */
function newComputer(
  computer: NonNullable<Shape["computer"]>,
  given: Values,
  bound: Bound,
  service: string,
) {
  const asked = settle(newComputerForm(computer, bound), given, []).problems;
  const values: Values = { ...computer.values, service };
  for (const field of computer.offer.unit.form.filter(settable))
    values[field.id] =
      given[field.id] ??
      withinLimit(field, computer.values[field.id], limitOf(reachLimits(bound), field));
  return { problems: asked.filter((one) => given[one.field ?? ""] !== undefined), values };
}

/**
 * A child's agents unit holds no more than its parent's, by each field's type. What was given
 * beyond `bound` is a problem; a template's value is brought within `caps`.
 */
function narrowedForChild(
  form: TheField[],
  given: Values,
  merged: Values,
  bound: Bound,
  caps: Bound,
) {
  const problems: TheProblem[] = [];
  const values: Values = { ...merged };
  for (const field of form.filter(settable)) {
    const message = overLimit(field, given[field.id], limitOf(bound, field));
    if (message) problems.push({ field: field.id, message });
    values[field.id] = withinLimit(field, merged[field.id], limitOf(caps, field));
  }
  return { problems, values };
}

const Target = z.object({ agent: z.string().min(1).max(128) });
const CreateArgs = z.object({
  name: z.string().min(1).max(128),
  purpose: z.string().min(1).max(2000),
  place: z.string().max(128).optional(),
  units: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});
const SendArgs = Target.extend({ text: z.string().min(1).max(100_000).regex(/\S/) });
const ReadArgs = Target.extend({
  limit: z.number().int().min(1).max(READ_MAX).optional(),
  before: z.string().min(1).max(128).optional(),
});

type Tool = z.infer<typeof ToolEntry>;
const TARGET = {
  type: "object",
  properties: { agent: { type: "string", description: "The agent's id, from `list`." } },
  required: ["agent"],
};
const FIXED_TOOLS: Tool[] = [
  {
    name: "list",
    description: "The agents you created, each with what it's for and how it stands.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "status",
    description: "How one of your agents stands, and whether it is working.",
    inputSchema: TARGET,
  },
  {
    name: "send",
    description: "Send one of your agents a message. It returns at once; the agent works after.",
    inputSchema: {
      type: "object",
      properties: { ...TARGET.properties, text: { type: "string" } },
      required: ["agent", "text"],
    },
  },
  {
    name: "read",
    description: "What was said with one of your agents, oldest first.",
    inputSchema: {
      type: "object",
      properties: {
        ...TARGET.properties,
        limit: { type: "number", maximum: READ_MAX, default: READ_DEFAULT },
        before: { type: "string", description: "Read messages before this one." },
      },
      required: ["agent"],
    },
  },
  { name: "stop", description: "Stop one of your agents, keeping it.", inputSchema: TARGET },
  { name: "start", description: "Start one of your agents again.", inputSchema: TARGET },
  {
    name: "remove",
    description: "Remove one of your agents, for good. Agents it made stay, as the person's.",
    inputSchema: TARGET,
  },
];

interface ChatCalls {
  send(input: { text: string }): Promise<{ messageId: string }>;
  history(input: { before?: string; limit?: number }): Promise<{
    messages: { id: string; role: string; text: string; at: string }[];
    more: boolean;
  }>;
  state(input: object): Promise<{ state: string }>;
}

export interface ControlParts {
  self: string;
  records: { agents: Record<string, TheAgent> };
  creatingCount(): number;
  catalog(): Promise<Offer[]>;
  /** What is bound to an agent now, each as its slot and provider. */
  boundTo(agent: string): Promise<Set<string>>;
  templates(): TheTemplate[];
  baseProviderNamed(name: string): Promise<string>;
  serial<T>(key: string, work: () => T | Promise<T>): Promise<T>;
  create(
    input: { stack: StackInput; name: string; purpose: string },
    caller: string,
    child: {
      parent: { agent: string; name: string };
      reach: Reach;
      shares: { slot: string; connection: string }[];
      skills: string[];
      computer?: Reach;
    },
  ): Promise<{ agent: string }>;
  nameOf(actor: string): Promise<string>;
  /** A child's chat, once the Hub has told management of it. */
  chatOf(agent: string): Promise<ChatCalls>;
  statusOf(agent: string, provider: string): Promise<{ state: string; detail?: string }>;
  start(agent: string): Promise<unknown>;
  stop(agent: string): Promise<unknown>;
  remove(agent: string): Promise<unknown>;
}

/** Text that fits a tool's output, saying so when it was cut. */
const fit = (value: unknown) => {
  const text = JSON.stringify(value);
  const notice = "\n[cut to fit]";
  return text.length > OUTPUT_MAX ? `${text.slice(0, OUTPUT_MAX - notice.length)}${notice}` : text;
};

export function createControl(parts: ControlParts) {
  const { self, records } = parts;

  /** Its computer's reach, if it still holds that computer: all of it, or it has none. */
  const reachNow = async (agent: string, record: TheAgent) => {
    const reach = reachOf(record);
    if (!reach.connections.length) return reach;
    const bound = await parts.boundTo(agent);
    return reach.connections.every((one) => bound.has(`${one.slot} ${one.connection}`))
      ? reach
      : NOWHERE;
  };
  const holdingOf = (caller: string) => {
    const record = records.agents[caller];
    const unit = record?.units.find((one) => one.provider === self && one.unit === AGENTS_UNIT);
    return record && unit ? { record, bound: boundOf(unit.values) } : undefined;
  };
  const childrenOf = (caller: string) =>
    Object.entries(records.agents).filter(([, record]) => record.parent?.agent === caller);
  /** The same refusal whether the agent doesn't exist or isn't the caller's to reach. */
  const childOf = (caller: string, agent: string) => {
    const record = records.agents[agent];
    if (record?.parent?.agent !== caller)
      throw new Refused("unknown", `You have no agent ${agent}.`);
    return record;
  };

  const createTool = (template: TheTemplate, shape: Shape, bound: Bound, reach: Reach): Tool => ({
    name: `create_${template.id}`,
    description:
      `Create an agent from the template "${template.title}". ${template.description}`.slice(
        0,
        16_384,
      ),
    inputSchema: JSON.parse(
      JSON.stringify({
        type: "object",
        properties: {
          name: { type: "string", maxLength: 128 },
          purpose: { type: "string", maxLength: 2000, description: "What it's for; it is told." },
          ...(shape.places
            ? { place: { type: "string", enum: shape.places, description: "Where it works." } }
            : {}),
          units: {
            type: "object",
            description: "Only what should differ from the template.",
            properties: Object.fromEntries(
              shape.units
                .filter((unit) => unit.offer.unit.form.some(settable))
                .map((unit) => [unit.key, schemaOf(formFor(self, unit, bound))])
                .concat(
                  shape.computer && shape.places?.includes(NEW)
                    ? [
                        [
                          COMPUTER,
                          schemaOf(newComputerForm(shape.computer, withinReach(bound, reach))),
                        ],
                      ]
                    : [],
                ),
            ),
          },
        },
        required: ["name", "purpose", ...(shape.places ? ["place"] : [])],
      }),
    ),
  });

  const list = async (caller: string) => {
    const holding = holdingOf(caller);
    if (!holding) return [];
    const { record, bound } = holding;
    const offers = await parts.catalog();
    const reach = await reachNow(caller, record);
    const creates = parts.templates().flatMap((template) => {
      if (!bound.templates.includes(template.id)) return [];
      const shape = shapeOf(self, template, offers, bound, reach);
      return shape ? [createTool(template, shape, bound, reach)] : [];
    });
    return [...creates, ...FIXED_TOOLS];
  };

  const create = (caller: string, id: string, input: unknown) =>
    // One at a time across the home, or two at once could each find one place left.
    parts.serial(HOME, async () => {
      const args = CreateArgs.parse(input);
      const holding = holdingOf(caller);
      const template = parts.templates().find((one) => one.id === id);
      if (!holding || !template || !holding.bound.templates.includes(id))
        throw new Refused("unknown", `You can't create from ${id}.`);
      const { record, bound } = holding;
      if (childrenOf(caller).length >= bound.limit)
        throw new Refused("limit", `You already have the ${bound.limit} agents you can have.`);
      if (Object.keys(records.agents).length + parts.creatingCount() >= HOME_CAP)
        throw new Refused("limit", "This home has as many agents as agents can make.");

      const reach = await reachNow(caller, record);
      const offers = await parts.catalog();
      const shape = shapeOf(self, template, offers, bound, reach);
      if (!shape) throw new Refused("unknown", `You can't create from ${id}.`);

      // Where it works: its computer is shared, or is a connection the person listed.
      if (shape.places && !args.place)
        throw new Refused("invalid", `Choose a place: ${shape.places.join(", ")}.`);
      if (args.place && !shape.places?.includes(args.place))
        throw new Refused("invalid", "It can't work there.");
      const problems: TheProblem[] = [];
      const shared = args.place === OWN ? reach : undefined;
      const fresh =
        args.place === NEW && shape.computer
          ? newComputer(
              shape.computer,
              (args.units?.[COMPUTER] ?? {}) as Values,
              withinReach(bound, reach),
              reach.service as string,
            )
          : undefined;
      if (fresh) problems.push(...fresh.problems);
      const childReach: Reach =
        shared ??
        (fresh
          ? {
              access: String(fresh.values.access),
              browser: fresh.values.browser === true,
              connections: [],
              skills: [],
              service: reach.service as string,
            }
          : NOWHERE);
      const shares = shared
        ? shared.connections
        : args.place && !fresh
          ? [{ slot: COMPUTER, connection: args.place }]
          : [];

      const known = new Set(
        shape.units.filter((unit) => unit.offer.unit.form.some(settable)).map((unit) => unit.key),
      );
      if (fresh) known.add(COMPUTER);
      for (const key of Object.keys(args.units ?? {}))
        if (!known.has(key)) throw new Refused("invalid", `This template has no unit ${key}.`);
      const units = shape.units.map((unit) => {
        const given = (args.units?.[unit.key] ?? {}) as Values;
        const { form } = unit.offer.unit;
        // A secret is refused for what it is when the stack is checked.
        for (const id of Object.keys(given)) {
          const field = form.find((one) => one.id === id);
          if (field && !settable(field) && field.value !== "secret")
            problems.push({ field: id, message: `An agent can't set ${field.title}.` });
        }
        let values: Values = { ...unit.values, ...given };
        if (isAgentsUnit(self, unit.offer)) {
          // Held to the form first: what follows compares numbers and lists.
          const typed = settle(form, values, []);
          problems.push(...typed.problems);
          if (typed.problems.length === 0) {
            const caps = withinReach(bound, childReach);
            const narrowed = narrowedForChild(form, given, typed.values, bound, caps);
            problems.push(...narrowed.problems);
            values = { ...narrowed.values, depth: bound.depth - 1 };
          }
        }
        return {
          provider: unit.offer.provider,
          unit: unit.offer.unit.id,
          values,
          ...(unit.needs ? { needs: unit.needs as Record<string, number> } : {}),
        };
      });
      if (problems.length)
        throw new Refused(
          "invalid",
          problems
            .map((one) => one.message)
            .join(" ")
            .slice(0, 2000),
        );

      const { base } = template;
      return parts.create(
        {
          stack: {
            base: {
              provider: await parts.baseProviderNamed(base.provider),
              creatable: base.creatable,
              ...(base.answers ? { answers: base.answers } : {}),
            },
            units: [
              ...units,
              ...(fresh && shape.computer
                ? [
                    {
                      provider: shape.computer.offer.provider,
                      unit: COMPUTER,
                      values: fresh.values,
                    },
                  ]
                : []),
            ],
            template: template.id,
          },
          name: args.name,
          purpose: args.purpose,
        },
        caller,
        {
          parent: { agent: caller, name: await parts.nameOf(caller) },
          reach: childReach,
          shares,
          skills: shared?.skills ?? [],
          ...(shared ? { computer: shared } : {}),
        },
      );
    });

  const run = async (caller: string, name: string, input: unknown) => {
    if (name.startsWith("create_")) return create(caller, name.slice("create_".length), input);
    switch (name) {
      case "list":
        return {
          agents: await Promise.all(
            childrenOf(caller).map(async ([agent, record]) => ({
              agent,
              name: await parts.nameOf(agent),
              purpose: record.purpose,
              template: record.template,
              status: await parts.statusOf(agent, record.provider),
            })),
          ),
        };
      case "status": {
        const { agent } = Target.parse(input);
        const record = childOf(caller, agent);
        const [status, chat] = await Promise.all([
          parts.statusOf(agent, record.provider),
          parts
            .chatOf(agent)
            .then((one) => one.state({}))
            .catch(() => undefined),
        ]);
        return { status, ...(chat ? { chat } : {}) };
      }
      case "send": {
        const { agent, text } = SendArgs.parse(input);
        childOf(caller, agent);
        return (await parts.chatOf(agent)).send({ text });
      }
      case "read": {
        const { agent, limit, before } = ReadArgs.parse(input);
        childOf(caller, agent);
        const { messages, more } = await (await parts.chatOf(agent)).history({
          limit: limit ?? READ_DEFAULT,
          ...(before ? { before } : {}),
        });
        return {
          messages: messages.map(({ id, role, text, at }) => ({ id, role, text, at })),
          more,
        };
      }
      case "stop":
      case "start":
      case "remove": {
        const { agent } = Target.parse(input);
        childOf(caller, agent);
        await parts[name](agent);
        return {};
      }
      default:
        throw new Refused("unknown", `There is no tool ${name}.`);
    }
  };

  return {
    list,
    /** A tool that ran and failed answers `failed`, for the caller's model to read. */
    async call(caller: string, name: string, input: unknown) {
      if (!holdingOf(caller)) throw new Refused("unknown", `There is no tool ${name}.`);
      try {
        return { output: fit(await run(caller, name, input)) };
      } catch (error) {
        const text =
          error instanceof z.ZodError
            ? z.prettifyError(error)
            : error instanceof Error
              ? error.message
              : String(error);
        return { output: text.slice(0, OUTPUT_MAX), failed: true as const };
      }
    },
  };
}
