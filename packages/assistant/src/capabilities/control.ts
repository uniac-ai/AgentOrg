/**
 * The agent's control: what it may mount and take off, on itself and on the agents it made, of
 * what the capability providers connected to management list. It reaches management's `agents@1`,
 * exposed to it at `agents` beside its control unit's tools. Which agents it reaches is its own
 * rule, checked by whose each one is: management gates nothing.
 *
 * The agent holds no key. A capability that needs a secret isn't mounted by it: it is told to tell
 * the person that it needs their key, which is given in Setup, and nothing else asks for one.
 */
import { agents } from "@agentorg/interfaces";
import type { Outcome } from "@agentorg/looper";
import { describeInterface, type Slot } from "@agentorg/sdk";
import type { Context } from "cordis";
import type { Capability } from "../substrate.js";
import { codeOf } from "../tools.js";

/** Where management's `agents@1` is exposed to an agent holding control. */
const SLOT = "agents";
const AGENTS_ID = describeInterface(agents).id;
type Agents = Slot<typeof agents>["call"];
type Json = Record<string, unknown>;

const answer = (output: unknown): Outcome => ({ output: JSON.stringify(output), ok: true });
const refusal = (output: string, code: string): Outcome => ({ output, ok: false, code });
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

const AGENT = {
  type: "string",
  description: "The id of an agent you made; leave it out for yourself.",
};

/** The `control` capability, which an agent holding an AgentOrg control unit holds. */
export const control = (): Capability => ({
  name: "control",
  title: "Control",
  inject: ["tools", "hub", "agent"],
  apply(ctx: Context) {
    const self = ctx.agent.id;
    /** Management's `agents@1` as exposed to the agent now, if it is. */
    const management = () =>
      ctx.hub.exposed().find((one) => one.slot === SLOT && one.described.id === AGENTS_ID)
        ?.call as unknown as Agents | undefined;
    /**
     * Run `work` on management for `agent` (the agent itself if none), once it is the agent itself
     * or one it made; what refuses it is told to the model.
     */
    const on = async (
      agent: unknown,
      work: (calls: Agents, target: string) => Promise<Outcome>,
    ): Promise<Outcome> => {
      const calls = management();
      if (!calls) return refusal("Management can't be reached now.", "not_connected");
      const target = typeof agent === "string" && agent ? agent : self;
      try {
        if (target !== self && (await calls.get({ agent: target })).parent?.agent !== self)
          return refusal(
            `You can mount and unmount only on yourself and on agents you made, and you didn't make ${target}.`,
            "forbidden",
          );
        return await work(calls, target);
      } catch (error) {
        const { code, message } = codeOf(error);
        return refusal(message, code);
      }
    };

    ctx.tools.register({
      name: "capability_list",
      description:
        "List the capabilities you can mount, each with its provider, id, title, description and the arguments it takes, and what is mounted now on you, or on an agent you made.",
      parameters: {
        type: "object",
        properties: { agent: AGENT },
        additionalProperties: false,
      },
      run: (input) =>
        on((input as Json).agent, async (calls, target) => {
          const [{ capabilities }, { mounted = [] }] = await Promise.all([
            calls.capabilities({}),
            calls.get({ agent: target }),
          ]);
          return answer({
            capabilities: capabilities.map(
              ({ provider, id, title, description, arguments: a }) => ({
                provider,
                id,
                title,
                description,
                arguments: a,
              }),
            ),
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
          });
        }),
    });

    ctx.tools.register({
      name: "capability_mount",
      description:
        "Mount a capability capability_list gives on yourself, or on an agent you made, with the arguments it takes. It takes effect from the next model request.",
      parameters: {
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
      run: (input) => {
        const { agent, provider, capability, arguments: given = {} } = input as Json;
        return on(agent, async (calls, target) => {
          const defined = (await calls.capabilities({})).capabilities.find(
            (one) => one.provider === provider && one.id === capability,
          );
          if (!defined)
            return refusal(
              `No capability ${String(capability)} of ${String(provider)} is on offer.`,
              "unknown",
            );
          const { secret, required } = secretsOf(defined.arguments);
          if (required || (isObject(given) && secret.some((name) => name in given)))
            return refusal(
              `${defined.title} needs a key, which you don't hold and can't be given here: only the person gives it, in Setup. Nothing was mounted. Tell them, in your own words, that you need their key for ${defined.title}, given in Setup.`,
              "needs_key",
            );
          const made = await calls.mount({
            agent: target,
            provider: defined.provider,
            capability: defined.id,
            arguments: (isObject(given) ? given : {}) as never,
          });
          return "problems" in made
            ? refusal(JSON.stringify(made), "invalid")
            : answer({ mounted: made.mounted });
        });
      },
    });

    ctx.tools.register({
      name: "capability_unmount",
      description:
        "Take a capability off yourself, or off an agent you made, by the id capability_list gives it under mounted.",
      parameters: {
        type: "object",
        properties: {
          agent: AGENT,
          mounted: { type: "string", description: "Its id under mounted." },
        },
        required: ["mounted"],
        additionalProperties: false,
      },
      run: (input) => {
        const { agent, mounted } = input as Json;
        return on(agent, async (calls, target) => {
          await calls.unmount({ agent: target, mounted: String(mounted) });
          return answer({});
        });
      },
    });
  },
});
