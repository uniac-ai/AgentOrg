/**
 * What an agent holding control is given of what it can mount: the text of what is on offer, which
 * its `offered` root carries, and three tools management answers beside its control unit's at
 * `control`, through which it lists, mounts and unmounts on itself and on the agents it made.
 * Which agents those are is management's rule, by whose each one is.
 *
 * Each answer is what `agents@1` gave the agent when it called it itself: its input checked as the
 * agent's own slot checked it, a mount or unmount kept in the control log as one, and its output as
 * the contract carries it. What is refused is refused with its code and words.
 *
 * The agent holds no key. A capability that needs a secret isn't mounted by it: it is told to tell
 * the person that it needs their key, which is given in Setup, and nothing else asks for one.
 */
import { agents, type ToolEntry } from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import type { z } from "zod";
import { fitted } from "./settings.js";

type Json = Record<string, unknown>;
type Tool = z.infer<typeof ToolEntry>;
/** A capability on offer, as the agent is told it. */
export type Offered = { id: string; title: string; description: string };

/** The most characters of the list of what it can mount, told in every request. */
export const OFFERED_MAX = 4_000;

/**
 * What the agent is told it can mount: each capability on offer by its id and description, and
 * whether it holds it now, as its skills are named. Nothing when none is on offer.
 */
export function offeredText(capabilities: Offered[], mounted: string[]): string | undefined {
  if (capabilities.length === 0) return undefined;
  const lines = capabilities.map(
    ({ id, title, description }) =>
      `- ${id} (${title}${mounted.includes(id) ? ", mounted" : ""}): ${description}`,
  );
  return `## Capabilities
A capability gives you more to do and know, from your next message. Mount one on yourself with control__capability_mount when what you're asked needs it, and take it off with control__capability_unmount.
${lines.join("\n")}`;
}

/**
 * What an agent is told it can mount, given every capability its tree names: cut, where a character
 * ends, to what it is told of it.
 */
export const offeredOf = (onOffer: Offered[]) => (named: string[]) => {
  const said = offeredText(onOffer, named);
  if (said === undefined) return undefined;
  const cut = said.slice(0, OFFERED_MAX);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
};

const AGENT = {
  type: "string",
  description: "The id of an agent you made; leave it out for yourself.",
};

/** The three tools, as the agent's model is offered them. */
export const OFFER_TOOLS: Tool[] = [
  {
    name: "capability_list",
    description:
      "List the capabilities you can mount, each with its provider, id, title, description and the arguments it takes, and what is mounted now on you, or on an agent you made.",
    inputSchema: {
      type: "object",
      properties: { agent: AGENT },
      additionalProperties: false,
    },
  },
  {
    name: "capability_mount",
    description:
      "Mount a capability capability_list gives on yourself, or on an agent you made, with the arguments it takes. It takes effect from your next message.",
    inputSchema: {
      type: "object",
      properties: {
        agent: AGENT,
        provider: { type: "string", description: "Its provider, as capability_list gives it." },
        capability: { type: "string", description: "Its id, as capability_list gives it." },
        arguments: { type: "object", description: "The arguments it takes." },
      },
      required: ["provider", "capability"],
      additionalProperties: false,
    },
  },
  {
    name: "capability_unmount",
    description:
      "Take a capability off yourself, or off an agent you made, by the id capability_list gives it under mounted.",
    inputSchema: {
      type: "object",
      properties: {
        agent: AGENT,
        mounted: { type: "string", description: "Its id under mounted." },
      },
      required: ["mounted"],
      additionalProperties: false,
    },
  },
];

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The properties a capability's arguments mark `secret`, and whether any of them is required. */
const secretsOf = (schema: Json) => {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const secret = Object.keys(properties).filter((name) => {
    const property = properties[name];
    return isObject(property) && property.secret === true;
  });
  return { secret, required: secret.some((name) => required.includes(name)) };
};

/**
 * A value checked against a schema, as an Actor's own slot checks a call: an input that doesn't
 * fit is refused `invalid`, an output `bad_output`.
 */
const checked = <T extends z.ZodType>(
  schema: T,
  value: unknown,
  where: string,
  code: "invalid" | "bad_output" = "invalid",
): z.output<T> => {
  const read = schema.safeParse(value);
  if (read.success) return read.data;
  const issue = read.error.issues[0];
  throw new Refused(
    code,
    `${where}: ${issue ? `${issue.path.map(String).join(".") || "value"} ${issue.message}` : "invalid"}`,
  );
};

type Method = "get" | "capabilities" | "mount" | "unmount";
type Answer<M extends Method> = z.output<(typeof agents)["methods"][M]["output"]>;

export interface OfferParts {
  /** Whether the agent holds control. */
  holds(agent: string): boolean;
  /** Who made an agent management has, if an agent did; `false` for one it doesn't have. */
  makerOf(agent: string): string | undefined | false;
  /** `agents@1`'s own handler of `method`, a change kept in the control log as the person's are. */
  handler(method: Method): (input: unknown, context: { caller: string }) => Promise<unknown>;
}

export function createOffers(parts: OfferParts) {
  /** `agents@1`'s answer, as the agent calling it was answered. */
  const ask = async <M extends Method>(
    method: M,
    input: object,
    caller: string,
  ): Promise<Answer<M>> => {
    const spec = agents.methods[method];
    const given = checked(spec.input, input, `agents.${method} input`);
    return checked(
      spec.output,
      await parts.handler(method)(given, { caller }),
      `agents.${method} output`,
      "bad_output",
    ) as Answer<M>;
  };
  /** The agent itself, or one it made: what else it names is refused. */
  const targetOf = (caller: string, agent: unknown) => {
    const target = typeof agent === "string" && agent ? agent : caller;
    if (target === caller) return target;
    const { agent: named } = checked(
      agents.methods.get.input,
      { agent: target },
      "agents.get input",
    );
    const maker = parts.makerOf(named);
    if (maker === false) throw new Refused("unknown", `Management has no agent ${named}.`);
    if (maker !== caller)
      throw new Refused(
        "forbidden",
        `You can mount and unmount only on yourself and on agents you made, and you didn't make ${named}.`,
      );
    return named;
  };
  /** An answer as a call's output: one too long keeps its start and its end. */
  const answer = (output: unknown) => ({ output: fitted(JSON.stringify(output)) });

  const run: Record<string, (caller: string, input: Json) => Promise<{ output: string }>> = {
    async capability_list(caller, input) {
      const target = targetOf(caller, input.agent);
      const [{ capabilities }, { mounted = [], composition }] = await Promise.all([
        ask("capabilities", {}, caller),
        ask("get", { agent: target }, caller),
      ]);
      return answer({
        capabilities: capabilities.map(({ provider, id, title, description, arguments: a }) => ({
          provider,
          id,
          title,
          description,
          arguments: a,
        })),
        mounted: mounted.map(
          ({ mounted: id, provider, capability, title, arguments: a, by, state }) => ({
            mounted: id,
            provider,
            capability,
            title,
            arguments: a,
            by,
            ...(state ? { state } : {}),
          }),
        ),
        // Everything it is made of, as `get` gives it: each capability and the plugins each
        // loaded, naming the part each is under.
        ...(composition ? { composition } : {}),
      });
    },
    async capability_mount(caller, input) {
      const { agent, provider, capability, arguments: given = {} } = input;
      const target = targetOf(caller, agent);
      const defined = (await ask("capabilities", {}, caller)).capabilities.find(
        (one) => one.provider === provider && one.id === capability,
      );
      if (!defined)
        throw new Refused(
          "unknown",
          `No capability ${String(capability)} of ${String(provider)} is on offer.`,
        );
      const { secret, required } = secretsOf(defined.arguments as Json);
      if (required || (isObject(given) && secret.some((name) => name in given)))
        throw new Refused(
          "needs_key",
          `${defined.title} needs a key, which you don't hold and can't be given here: only the person gives it, in Setup. Nothing was mounted. Tell them, in your own words, that you need their key for ${defined.title}, given in Setup.`,
        );
      const made = await ask(
        "mount",
        {
          agent: target,
          provider: defined.provider,
          capability: defined.id,
          arguments: isObject(given) ? given : {},
        },
        caller,
      );
      if ("problems" in made) throw new Refused("invalid", JSON.stringify(made));
      return answer({ mounted: made.mounted });
    },
    async capability_unmount(caller, input) {
      const target = targetOf(caller, input.agent);
      await ask("unmount", { agent: target, mounted: String(input.mounted) }, caller);
      return answer({});
    },
  };

  return {
    /** Whether a tool's name is one of these. */
    has: (name: string) => Object.hasOwn(run, name),
    /** The three, to an agent holding control; to anyone else, none. */
    list: (caller: string) => (parts.holds(caller) ? OFFER_TOOLS : []),
    /** Run one for an agent holding control: what refuses it is refused with its code. */
    call(caller: string, name: string, input: Json) {
      const tool = run[name];
      if (!tool || !parts.holds(caller)) throw new Refused("unknown", `There is no tool ${name}.`);
      return tool(caller, input);
    },
  };
}
