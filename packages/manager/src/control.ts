/**
 * AgentOrg control: what lets an agent reach what the person's own surface reaches, within the
 * scopes the person set on its unit. The agent holds no authority of the Hub's. It calls
 * management's tools, and management, which holds that authority, works out who is calling, what
 * that caller's unit allows, and whether the target is within its reach.
 */
import { createHash } from "node:crypto";
import type { Field, FieldValues, Problem, Template, ToolEntry, Unit } from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import { z } from "zod";
import { schemaOf, settle } from "./form.js";
import type { AgentRecord, Offer, StackInput } from "./stack.js";

export const AGENTS_UNIT = "control";
export const AGENTS_SLOT = "control";
/** Each scope's answers, each containing the one before. */
const AGENTS = ["none", "own", "all"];
const REACH = ["none", "see", "use", "add"];
const atLeast = (answers: string[], value: string, least: string) =>
  answers.indexOf(value) >= answers.indexOf(least);
const COMPUTER = "computer";
/** The kind of connection an agent may add: one at an address. */
const URL_KIND = "url";
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

const SKILL = "delegating";
const SKILL_FILE = "SKILL.md";
const SKILL_TEXT = `---
name: ${SKILL}
description: How to hand work to agents of your own and see it through, and what else your control tools reach. Use it before creating an agent, and whenever you have work that can run apart from yours.
---
Your \`control\` connection's tools reach what the person allowed you: agents, and perhaps connections, skills and templates. A tool you don't have is one you weren't given.

## Before you create an agent

Do the work yourself when it is short. An agent costs model usage from the plan everyone here shares, and you have a limit on how many you can have. Use one when work can run apart from yours, or needs a shape you were not given.

There is one create tool per template you may use. Read its description and fields. Give the agent a plain name and a purpose: one sentence on what it is for, which it will be told. Fields you leave out keep the template's value.

If a template you expected has no create tool, or you have none, tell the person why, using the titles in bold and quotes. In your AgentOrg control unit, in your Setup:
- **Agents** is "None".
- **Templates** doesn't tick it.
- **Places**, for a template with a computer: nothing you can use is ticked. "Its own computer" needs the computer you hold now, **Most a computer can do** at least what it reaches, and **A computer can have a browser** on if it has one. "A new computer on the same service" needs your computer's **Where it resides** to be "This computer". A computer the person connected, ticked there, can always be used.
- **Levels below it** is 1, for a template whose agents get an AgentOrg control unit.

Otherwise it is the template: a unit's provider isn't connected, or a unit lacks an answer you can't give. The person fills that in on the template. A token can't be kept in a template, so the person creates that agent themselves.

Its **Connections** answer never keeps one out.

## Working with it

- You have one conversation with each agent you made, and, if the person let you reach every agent, with every other agent too. \`agents__send\` says a message in it, naming the agent by its id, and returns at once; it works on its own after that, and answers there. It knows the message is yours.
- \`agents__read\` shows that conversation, whether the agent is working, and, if a message got no answer, its \`problem\`: send it another once the problem is dealt with. Check back when you need the result, rather than after every step.
- An agent you made that keeps a record of its work also gives you a tool \`work_<its id>__work\` while it is connected: what each of its pieces of work is doing and did. Read it to see how its work goes, without messaging it.
- Say what you want back and in what form. It knows only what you send it and its purpose.

## When it is done

\`agent_remove\` it when its work is finished, so your limit is free for the next one. \`agent_stop\` it to keep it for later. You can remove only agents you made, and theirs. The person sees every agent you create: it is listed with the person's own agents, and has a page of its own. The person also sees every change you make through these tools, and can undo any of it.
`;
export const skillFile = (path: string) => (path === SKILL_FILE ? SKILL_TEXT : undefined);
/**
 * The sha256 of every text `delegating`'s SKILL.md has had in a version shipped, the current one
 * among them: a change of the text appends its new hash and keeps the old ones.
 */
export const SKILL_SHIPPED = [
  "b487e0efa6046b7e8562c7077f9b3ace72becce770de28e659c830ffbbdeb312",
  "c4c8ec80c821466939cd6de8074bc9199a032c297c7f81e19396c28bbfe1e8cc",
  "76aa0d9d1c275925377946143e129d8c5b8af002b5109fd97c06cd292a1e7997",
  "f588cd6b3c5296510e5faf67ddfd853e396f5b3f101beef999e485bac3466c9d",
  "b35596138c01eb176fcf6ac4fcc1ebc98c74269b5bd87506a523659a1d8bd4b3",
  "583bb3b732747ef805ee176e8c598e0086b289c36b6949c4382afd4a1ea69784",
  "1fd777f2c3bd101c93d34a1753564e90a5ed6e0b5fd4271c648f7bcf7b351277",
  "0243df48c66b8c70ddc262f3fd720e35133c9dfdb1b95fdebf48d98858348654",
  "8b199ea52a14241b9c0345190a40bebf4bc4150186a2eb6e737792dea8a95850",
  "c8398d20782eae4c52bb043f03385d8b219883a572c8aade8b53c82e8ca7272b",
  "dc702fb7e319e148a0ec617af453f29d70b3717654f10096f87f9e623b20cfb4",
];
/** The sha256 of each earlier text of a file of the skill, so a copy of one is told from an edit. */
export const skillShipped = (path: string) => {
  if (path !== SKILL_FILE) return [];
  const now = createHash("sha256").update(SKILL_TEXT).digest("hex");
  return SKILL_SHIPPED.filter((hash) => hash !== now);
};

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
    title: "AgentOrg control",
    description:
      "It can reach what you reach in AgentOrg, as far as you allow here. Each answer says what it grants.",
    form: [
      {
        id: "agents",
        authority: "setting",
        type: "choice",
        value: "string",
        title: "Agents",
        default: "own",
        options: [
          { value: "none", title: "None", description: "It can't create or manage agents." },
          { value: "own", title: "Its own", description: "It creates and manages its own agents." },
          {
            value: "all",
            title: "All",
            description: "It also sees, messages, stops and starts every other agent.",
          },
        ],
      },
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
        id: "saveTemplates",
        authority: "setting",
        type: "toggle",
        value: "boolean",
        title: "Save templates of its own",
        default: false,
      },
      {
        id: "connections",
        authority: "setting",
        type: "choice",
        value: "string",
        title: "Connections",
        default: "none",
        options: [
          { value: "none", title: "None" },
          { value: "see", title: "See", description: "It lists them." },
          {
            value: "use",
            title: "Use",
            description: "It gives those listed below to itself and its agents.",
          },
          { value: "add", title: "Add", description: "It adds new ones by public address." },
        ],
      },
      {
        id: "listed",
        authority: "setting",
        type: "connection",
        value: "strings",
        title: "Connections it may use",
        visible: { field: "connections", in: ["use", "add"] },
      },
      {
        id: "skills",
        authority: "setting",
        type: "choice",
        value: "string",
        title: "Skills",
        default: "none",
        options: [
          { value: "none", title: "None" },
          { value: "see", title: "See", description: "It lists and reads them." },
          { value: "use", title: "Use", description: "It gives them to itself and its agents." },
          { value: "add", title: "Add", description: "It writes new ones." },
        ],
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
  agents: string;
  saveTemplates: boolean;
  connections: string;
  listed: string[];
  skills: string;
  templates: string[];
  places: string[];
  access: string;
  browser: boolean;
  limit: number;
  depth: number;
}
const boundOf = (values: Values): Bound => ({
  agents: String(values.agents ?? "own"),
  saveTemplates: values.saveTemplates === true,
  connections: String(values.connections ?? "none"),
  listed: (values.listed ?? []) as string[],
  skills: String(values.skills ?? "none"),
  templates: (values.templates ?? []) as string[],
  places: (values.places ?? []) as string[],
  access: String(values.access ?? "none"),
  browser: values.browser === true,
  limit: Number(values.limit ?? LIMIT_DEFAULT),
  depth: Number(values.depth ?? 1),
});
/** Whether a bound lets an agent create and manage agents of its own. */
const own = (bound: Bound) => atLeast(AGENTS, bound.agents, "own");
/** What an agent's agents unit allows it, if it holds management's. */
const agentsBound = (self: string, record: TheAgent | undefined) => {
  const unit = record?.units.find((one) => one.provider === self && one.unit === AGENTS_UNIT);
  return unit && boundOf(unit.values);
};
/** Whether an agent manages the agents it made: it holds management's agents unit, at "own" or more. */
export function managesOwn(self: string, record: TheAgent | undefined): boolean {
  const bound = agentsBound(self, record);
  return bound !== undefined && own(bound);
}
/** Whether an agent sees and talks to every other agent: its agents unit is at "all". */
export function managesAll(self: string, record: TheAgent | undefined): boolean {
  return agentsBound(self, record)?.agents === "all";
}

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
function formFor(
  self: string,
  unit: Shape["units"][number],
  bound: Bound,
  opens: (field: TheField) => boolean = settable,
) {
  const fields = unit.offer.unit.form.filter(opens);
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

const Id = z.string().min(1).max(128);
const Target = z.object({ agent: Id.describe("An agent's id, from agent_list.") });
const CreateArgs = z.object({
  name: z.string().min(1).max(128),
  purpose: z.string().min(1).max(2000),
  place: z.string().max(128).optional(),
  units: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});
/** One of its own agents, or itself when none is named. */
const OnWhom = z.object({ agent: Id.optional().describe("One of your agents; you, if none.") });

type Tool = z.infer<typeof ToolEntry>;
/** What management's own interfaces answer, called as the person would. */
type Person = (
  iface: "agents" | "connections" | "skills",
  method: string,
  input: object,
  /** Who it's made as: the agent, so what it makes is recorded as its own. */
  caller?: string,
) => Promise<
  // biome-ignore lint/suspicious/noExplicitAny: each method answers its own shape.
  any
>;

/**
 * One line of the control log: a control call or a change of the person's that changed something,
 * or was refused. Never a message or a secret.
 */
export interface Activity {
  caller: string;
  tool: string;
  target?: string;
  outcome: "done" | "refused";
  reason?: string;
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
  statusOf(agent: string, provider: string): Promise<{ state: string; detail?: string }>;
  start(agent: string): Promise<unknown>;
  stop(agent: string): Promise<unknown>;
  remove(agent: string): Promise<unknown>;
  /** Management's interfaces, as the person reaches them. */
  person: Person;
  /** Where each connection came from, to know which an agent made. */
  madeBy(connection: string): string | undefined;
  /** Whether the library has a skill of this name that this agent may see. */
  hasSkill(name: string, caller: string): boolean;
  /** The agent that saved a template, if one did. */
  templateAuthor(id: string): string | undefined;
  /** Keep a line of the control log. */
  log(entry: Activity): void;
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
  /**
   * Why a template an agent saved has a value it may not set itself, if one does: the agent's own
   * template is held to what it could have given, at saving and again at creating.
   */
  const notItsOwn = (caller: string, bound: Bound, template: TheTemplate, offers: Offer[]) => {
    if (Object.keys(template.base.answers ?? {}).length)
      return "An agent's template answers nothing of its base.";
    for (const unit of template.units) {
      const offer = offers.find(
        (one) => one.providerName === unit.provider && one.unit.id === unit.unit,
      );
      if (!offer) return `${unit.provider} offers no unit ${unit.unit}.`;
      for (const [id, value] of Object.entries(unit.values ?? {})) {
        const field = offer.unit.form.find((one) => one.id === id);
        if (field && !mayFill(caller, bound, field, value))
          return `An agent can't set ${field.title}.`;
      }
    }
    return undefined;
  };
  /** A template it may create from: one listed for it, or one it saved. */
  const allowed = (caller: string, bound: Bound, id: string) =>
    bound.templates.includes(id) || parts.templateAuthor(id) === caller;
  const holdingOf = (caller: string) => {
    const record = records.agents[caller];
    const unit = record?.units.find((one) => one.provider === self && one.unit === AGENTS_UNIT);
    return record && unit ? { record, bound: boundOf(unit.values) } : undefined;
  };
  const childrenOf = (caller: string) =>
    Object.entries(records.agents).filter(([, record]) => record.parent?.agent === caller);
  const nobody = (agent: string) => new Refused("unknown", `You have no agent ${agent}.`);
  /** One of the agents it made: the same refusal whether it doesn't exist or isn't its own. */
  const ownChild = (caller: string, agent: string) => {
    if (records.agents[agent]?.parent?.agent !== caller) throw nobody(agent);
    return agent;
  };
  /** An agent it may see and talk to: its own, or with `all`, any other. */
  const reachable = (caller: string, bound: Bound, agent: string) => {
    if (agent === caller || !records.agents[agent]) throw nobody(agent);
    return bound.agents === "all" ? agent : ownChild(caller, agent);
  };
  /** One it made, or one they made, at any depth: what removing can reach. */
  const descendant = (caller: string, agent: string) => {
    const seen = new Set<string>();
    for (let at = records.agents[agent]?.parent?.agent; at && !seen.has(at); ) {
      if (at === caller) return agent;
      seen.add(at);
      at = records.agents[at]?.parent?.agent;
    }
    throw nobody(agent);
  };
  /** Itself, or one of its own: where it may give what it holds. */
  const selfOrOwn = (caller: string, agent?: string) =>
    agent === undefined || agent === caller ? caller : ownChild(caller, agent);
  /** Whether it may fill a field: one that is how something works, or what it already holds. */
  const mayFill = (caller: string, bound: Bound, field: TheField, value: unknown) => {
    if (settable(field)) return true;
    if (field.authority !== "holds") return false;
    // What it holds is a connection, by the field's type, or else a skill there is.
    if (field.type !== "connection")
      return (
        atLeast(REACH, bound.skills, "use") &&
        [value ?? []].flat().every((one) => parts.hasSkill(String(one), caller))
      );
    return (
      atLeast(REACH, bound.connections, "use") &&
      [value ?? []]
        .flat()
        .every((one) => bound.listed.includes(String(one)) || parts.madeBy(String(one)) === caller)
    );
  };

  const createTool = (
    template: TheTemplate,
    shape: Shape,
    bound: Bound,
    reach: Reach,
    opens: (field: TheField) => boolean,
  ): Tool => ({
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
                .filter((unit) => unit.offer.unit.form.some(opens))
                .map((unit) => [unit.key, schemaOf(formFor(self, unit, bound, opens))])
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

  const createTools = async (caller: string, record: TheAgent, bound: Bound) => {
    if (!atLeast(AGENTS, bound.agents, "own")) return [];
    const offers = await parts.catalog();
    const reach = await reachNow(caller, record);
    const opens = (field: TheField) => mayFill(caller, bound, field, undefined);
    return parts.templates().flatMap((template) => {
      if (!allowed(caller, bound, template.id)) return [];
      const shape = shapeOf(self, template, offers, bound, reach);
      return shape ? [createTool(template, shape, bound, reach, opens)] : [];
    });
  };

  const create = (caller: string, id: string, input: unknown) =>
    // One at a time across the home, or two at once could each find one place left.
    parts.serial(HOME, async () => {
      const args = CreateArgs.parse(input);
      const holding = holdingOf(caller);
      const template = parts.templates().find((one) => one.id === id);
      if (!holding || !template || !allowed(caller, holding.bound, id))
        throw new Refused("unknown", `You can't create from ${id}.`);
      const { record, bound } = holding;
      if (!atLeast(AGENTS, bound.agents, "own"))
        throw new Refused("unknown", `You can't create from ${id}.`);
      if (childrenOf(caller).length >= bound.limit)
        throw new Refused("limit", `You already have the ${bound.limit} agents you can have.`);
      if (Object.keys(records.agents).length + parts.creatingCount() >= HOME_CAP)
        throw new Refused("limit", "This home has as many agents as agents can make.");

      const reach = await reachNow(caller, record);
      const offers = await parts.catalog();
      const shape = shapeOf(self, template, offers, bound, reach);
      if (!shape) throw new Refused("unknown", `You can't create from ${id}.`);
      const theirs =
        parts.templateAuthor(id) === caller
          ? notItsOwn(caller, bound, template, offers)
          : undefined;
      if (theirs) throw new Refused("invalid", theirs);

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

      const opens = (field: TheField) => mayFill(caller, bound, field, undefined);
      const known = new Set(
        shape.units.filter((unit) => unit.offer.unit.form.some(opens)).map((unit) => unit.key),
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
          if (field && !mayFill(caller, bound, field, given[id]) && field.value !== "secret")
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

  /**
   * The tools, one per verb of the person's interfaces, each with the scope it needs. Apart from
   * creating, each calls what the person's surface calls, after the checks here.
   */
  interface Verb<T extends z.ZodType> {
    name: string;
    description: string;
    input: T;
    needs(bound: Bound): boolean;
    /** Whether it changes anything, and so goes in the control log. */
    changes: boolean;
    run(caller: string, bound: Bound, args: z.infer<T>): Promise<unknown>;
  }
  const verb = <T extends z.ZodType>(one: Verb<T>) => one as unknown as Verb<z.ZodType>;
  const sees = (scope: "connections" | "skills", least: string) => (bound: Bound) =>
    atLeast(REACH, bound[scope], least);
  /** Something to give: a connection or a skill, to itself or one of its own, as the person would. */
  const giving = {
    connection: z.object({
      agent: OnWhom.shape.agent,
      connection: Id,
      as: z.string().min(1).max(129).optional().describe("The name it is known by."),
    }),
    skill: z.object({ agent: OnWhom.shape.agent, skill: z.string().min(1).max(64) }),
  };
  const VERBS: Verb<z.ZodType>[] = [
    verb({
      name: "agent_list",
      description: "The agents you can reach, each with what it's for and how it stands.",
      input: z.object({}),
      needs: own,
      changes: false,
      async run(caller, bound) {
        const { agents } = await parts.person("agents", "list", {});
        return {
          agents: (agents as { agent: string }[]).filter(
            ({ agent }) =>
              agent !== caller &&
              (bound.agents === "all" || records.agents[agent]?.parent?.agent === caller),
          ),
        };
      },
    }),
    verb({
      name: "agent_get",
      description: "What an agent is made of and how it stands.",
      input: Target,
      needs: own,
      changes: false,
      async run(caller, bound, { agent }) {
        reachable(caller, bound, agent);
        const read = await parts.person("agents", "get", { agent });
        // Its connections are what `connections` may see, and no more.
        const mcp = atLeast(REACH, bound.connections, "see")
          ? read.mcp
          : (read.mcp as { slot: string; status: unknown; instance?: string }[]).map(
              ({ slot, status, instance }) => ({ slot, status, ...(instance ? { instance } : {}) }),
            );
        return { ...read, mcp };
      },
    }),
    verb({
      name: "agent_stop",
      description: "Stop an agent, keeping it.",
      input: Target,
      needs: own,
      changes: true,
      run: async (caller, bound, { agent }) => parts.stop(reachable(caller, bound, agent)),
    }),
    verb({
      name: "agent_start",
      description: "Start an agent again.",
      input: Target,
      needs: own,
      changes: true,
      run: async (caller, bound, { agent }) => parts.start(reachable(caller, bound, agent)),
    }),
    verb({
      name: "agent_remove",
      description:
        "Remove an agent you made, or one they made, for good. Agents it made stay, as the person's.",
      input: Target,
      needs: own,
      changes: true,
      run: async (caller, _, { agent }) => parts.remove(descendant(caller, agent)),
    }),
    verb({
      name: "agent_add_unit",
      description:
        "Add a unit to one of your agents, from unit_list. Only fields you may set can be given.",
      input: Target.extend({
        provider: Id,
        unit: z.string().min(1).max(64),
        values: z.record(z.string(), z.unknown()).optional(),
      }),
      needs: own,
      changes: true,
      async run(caller, bound, { agent, provider, unit, values = {} }) {
        ownChild(caller, agent);
        const offer = (await parts.catalog()).find(
          (one) => one.provider === provider && one.unit.id === unit,
        );
        if (!offer) throw new Refused("unknown", `${provider} offers no unit ${unit}.`);
        // Each comes only at creation, where its bounds are applied.
        if (offer.unit.id === COMPUTER || isAgentsUnit(self, offer))
          throw new Refused("invalid", `${offer.unit.title} comes only when an agent is made.`);
        for (const [id, value] of Object.entries(values)) {
          const field = offer.unit.form.find((one) => one.id === id);
          if (field && !mayFill(caller, bound, field, value))
            throw new Refused("invalid", `An agent can't set ${field.title}.`);
        }
        return parts.person(
          "agents",
          "addUnit",
          { agent, unit: { provider, unit, values } },
          caller,
        );
      },
    }),
    verb({
      name: "agent_remove_unit",
      description: "Remove a unit from one of your agents, by its instance, from agent_get.",
      input: Target.extend({ instance: Id }),
      needs: own,
      changes: true,
      run: async (caller, _, { agent, instance }) =>
        parts.person("agents", "removeUnit", { agent: ownChild(caller, agent), instance }),
    }),
    verb({
      name: "template_list",
      description:
        "The templates there are. One with `shipped` came with the app: it can't be removed.",
      input: z.object({}),
      needs: own,
      changes: false,
      run: async () => parts.person("agents", "templates", {}),
    }),
    verb({
      name: "unit_list",
      description: "The units there are, each with its form.",
      input: z.object({}),
      needs: own,
      changes: false,
      async run(_, bound) {
        const listed = await parts.person("agents", "units", {});
        if (atLeast(REACH, bound.connections, "see")) return listed;
        // The places its own unit could list are the person's connections, which it may not see.
        return {
          ...listed,
          units: (listed.units as { id: string; provider: string; form: TheField[] }[]).map(
            (unit) =>
              unit.provider === self && unit.id === AGENTS_UNIT
                ? {
                    ...unit,
                    form: unit.form.map((field) =>
                      field.id === "places"
                        ? {
                            ...field,
                            options: field.options?.filter((one) => [OWN, NEW].includes(one.value)),
                          }
                        : field,
                    ),
                  }
                : unit,
          ),
        };
      },
    }),
    verb({
      name: "connection_list",
      description: "The person's connections to MCP servers.",
      input: z.object({}),
      needs: sees("connections", "see"),
      changes: false,
      run: async () => parts.person("connections", "list", {}),
    }),
    verb({
      name: "connection_get",
      description: "One connection: where it came from and how it stands.",
      input: z.object({ connection: Id }),
      needs: sees("connections", "see"),
      changes: false,
      run: async (_, __, { connection }) => parts.person("connections", "get", { connection }),
    }),
    verb({
      name: "connection_expose",
      description: "Give a connection you may use to yourself or one of your agents.",
      input: giving.connection,
      needs: sees("connections", "use"),
      changes: true,
      async run(caller, bound, { agent, connection, as }) {
        if (!bound.listed.includes(connection) && parts.madeBy(connection) !== caller)
          throw new Refused("unknown", `You may not use ${connection}.`);
        return parts.person(
          "agents",
          "expose",
          { agent: selfOrOwn(caller, agent), connection, ...(as ? { as } : {}) },
          caller,
        );
      },
    }),
    verb({
      name: "connection_unexpose",
      description: "Take a connection back from yourself or one of your agents, by its name.",
      input: z.object({ agent: OnWhom.shape.agent, slot: z.string().min(1).max(129) }),
      needs: sees("connections", "use"),
      changes: true,
      run: async (caller, _, { agent, slot }) =>
        parts.person("agents", "unexpose", { agent: selfOrOwn(caller, agent), slot }),
    }),
    verb({
      name: "skill_list",
      description: "The skills there are.",
      input: z.object({}),
      needs: sees("skills", "see"),
      changes: false,
      run: async (caller) => parts.person("skills", "list", {}, caller),
    }),
    verb({
      name: "skill_get",
      description: "One skill's text and files.",
      input: z.object({ name: z.string().min(1).max(64) }),
      needs: sees("skills", "see"),
      changes: false,
      run: async (caller, _, { name }) => parts.person("skills", "get", { name }, caller),
    }),
    verb({
      name: "skill_expose",
      description: "Give a skill to yourself or one of your agents.",
      input: giving.skill,
      needs: sees("skills", "use"),
      changes: true,
      run: async (caller, _, { agent, skill }) =>
        parts.person("agents", "expose", { agent: selfOrOwn(caller, agent), skill }, caller),
    }),
    verb({
      name: "skill_unexpose",
      description: "Take a skill back from yourself or one of your agents.",
      input: giving.skill,
      needs: sees("skills", "use"),
      changes: true,
      run: async (caller, _, { agent, skill }) =>
        parts.person("agents", "unexpose", { agent: selfOrOwn(caller, agent), skill }, caller),
    }),
    verb({
      name: "connection_add",
      description:
        "Add a connection to an MCP server at a public https address. It takes no token, reaches nothing on this machine or its network, and goes when you do. Give it to yourself or your agents with connection_expose.",
      input: z.object({
        name: z.string().min(1).max(128),
        url: z.string().min(1).max(4096).describe("An https address on the public internet."),
      }),
      needs: sees("connections", "add"),
      changes: true,
      async run(caller, _, { name, url }) {
        const { providers } = await parts.person("connections", "providers", {});
        const at = (providers as { provider: string; kinds: { kind: string }[] }[]).find((one) =>
          one.kinds.some((kind) => kind.kind === URL_KIND),
        );
        if (!at) throw new Refused("unavailable", "Nothing here connects to an address now.");
        return parts.person(
          "connections",
          "create",
          { provider: at.provider, kind: URL_KIND, params: { url, public: true }, name },
          caller,
        );
      },
    }),
    verb({
      name: "connection_remove",
      description: "Remove a connection you added, for good.",
      input: z.object({ connection: Id }),
      needs: sees("connections", "add"),
      changes: true,
      run: async (caller, _, { connection }) =>
        parts.person("connections", "remove", { connection }, caller),
    }),
    verb({
      name: "skill_add",
      description:
        "Write a new skill: its SKILL.md, with front matter naming it, and any other files. Its name mustn't be one there is. You and your agents see it.",
      input: z.object({
        files: z
          .record(z.string(), z.string())
          .describe("By path inside the skill, such as SKILL.md."),
      }),
      needs: sees("skills", "add"),
      changes: true,
      run: async (caller, _, { files }) => parts.person("skills", "add", { files }, caller),
    }),
    verb({
      name: "skill_remove",
      description: "Remove a skill you wrote.",
      input: z.object({ name: z.string().min(1).max(64) }),
      needs: sees("skills", "add"),
      changes: true,
      run: async (caller, _, { name }) => parts.person("skills", "remove", { name }, caller),
    }),
    verb({
      name: "template_save",
      description:
        "Save a template of your own, from units on unit_list, providers named as there. Its id mustn't be one there is, it can't say what program to run, and a control unit in it stays within yours. You can create from it.",
      input: z.object({ template: z.record(z.string(), z.unknown()) }),
      needs: (bound) => own(bound) && bound.saveTemplates,
      changes: true,
      async run(caller, bound, { template }) {
        const wrong = notItsOwn(
          caller,
          bound,
          template as unknown as TheTemplate,
          await parts.catalog(),
        );
        if (wrong) throw new Refused("invalid", wrong);
        const units = (template.units ?? []) as {
          provider?: string;
          unit?: string;
          values?: Values;
        }[];
        const offers = await parts.catalog();
        for (const unit of units) {
          const offer = offers.find(
            (one) => one.providerName === unit.provider && one.unit.id === unit.unit,
          );
          if (!offer || !isAgentsUnit(self, offer)) continue;
          // What it would let an agent do stays within what this one may.
          for (const field of offer.unit.form.filter(settable)) {
            const message = overLimit(field, unit.values?.[field.id], limitOf(bound, field));
            if (message) throw new Refused("invalid", message);
          }
          if (Number(unit.values?.depth ?? 1) >= bound.depth)
            throw new Refused("invalid", "A control unit in it goes less deep than yours.");
        }
        return parts.person("agents", "saveTemplate", template, caller);
      },
    }),
    verb({
      name: "template_remove",
      description: "Remove a template you saved.",
      input: z.object({ id: z.string().min(1).max(64) }),
      needs: (bound) => own(bound) && bound.saveTemplates,
      changes: true,
      run: async (caller, _, { id }) => parts.person("agents", "removeTemplate", { id }, caller),
    }),
  ];
  const toolOf = (one: Verb<z.ZodType>): Tool => ({
    name: one.name,
    description: one.description,
    inputSchema: JSON.parse(JSON.stringify(z.toJSONSchema(one.input))),
  });
  /** What a call is about, for the log. */
  const targetOf = (input: unknown) => {
    if (!input || typeof input !== "object") return undefined;
    const { agent, connection, skill, instance } = input as Record<string, unknown>;
    const found = [agent, connection, skill, instance].find((one) => typeof one === "string");
    return found === undefined ? undefined : String(found).slice(0, 256);
  };

  return {
    async list(caller: string) {
      const holding = holdingOf(caller);
      if (!holding) return [];
      const { record, bound } = holding;
      return [
        ...(await createTools(caller, record, bound)),
        ...VERBS.filter((one) => one.needs(bound)).map(toolOf),
      ];
    },
    /** A tool that ran and failed answers `failed`, for the caller's model to read. */
    async call(caller: string, name: string, input: unknown) {
      // The log mustn't turn a call that was done into one that failed.
      const note = (entry: Activity) => {
        try {
          parts.log(entry);
        } catch {
          // Its failure is the log's own.
        }
      };
      const holding = holdingOf(caller);
      if (!holding) throw new Refused("unknown", `There is no tool ${name}.`);
      const creates = name.startsWith("create_");
      const one = VERBS.find((each) => each.name === name);
      const target = targetOf(input);
      try {
        let output: unknown;
        if (creates) output = await create(caller, name.slice("create_".length), input);
        else {
          if (!one?.needs(holding.bound)) throw new Refused("unknown", `There is no tool ${name}.`);
          output = await one.run(caller, holding.bound, one.input.parse(input));
        }
        if (creates || one?.changes)
          note({
            caller,
            tool: name,
            outcome: "done",
            ...(creates
              ? { target: (output as { agent: string }).agent }
              : target
                ? { target }
                : {}),
          });
        return { output: fit(output ?? {}) };
      } catch (error) {
        const text =
          error instanceof z.ZodError
            ? z.prettifyError(error)
            : error instanceof Error
              ? error.message
              : String(error);
        note({
          caller,
          tool: name.slice(0, 128),
          outcome: "refused",
          ...(target ? { target } : {}),
          reason: text.slice(0, 2000),
        });
        return { output: text.slice(0, OUTPUT_MAX), failed: true as const };
      }
    },
  };
}
