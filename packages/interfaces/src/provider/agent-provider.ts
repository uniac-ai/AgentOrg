import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";
import { Id, Name } from "../base/names.js";
import { ModelId } from "../exposure/llm-session.js";
import { CapabilityId, View } from "../exposure/views.js";
import { ROOTS_MAX, SettingsRoot } from "./mounted.js";

const Title = z.string().min(1).max(128);
const Description = z.string().max(2000);
/** A creatable's id, unique within its provider. */
export const CreatableId = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(64);
const AskId = z
  .string()
  .regex(/^[a-z][A-Za-z0-9_]*$/)
  .max(64);
/** What the person gives at creation, by the id of each ask. Never a secret. */
export const Answers = z.record(AskId, z.string().max(4096));

/** One thing a creatable asks the person when an agent is made from it. */
const Ask = z.object({
  id: AskId,
  title: Title,
  description: Description.optional(),
  optional: z.literal(true).optional(),
});
/**
 * What an agent made from a creatable holds of itself, with no unit to build it: a capability the
 * agent's own Actor serves, `capability@1` as `capability` and, as `tools`, the `tools@1` that
 * each of its views' operations is in, which a view names by its `slot`. It is declared, as a
 * unit's is, so it is known with no call to the agent.
 */
export const OwnCapability = z.object({
  id: CapabilityId,
  title: Title,
  views: z
    .array(
      View.refine(
        (view) => view.operation !== undefined && view.slot !== undefined,
        "Each view reads an operation, by its slot.",
      ),
    )
    .max(32),
});
/**
 * What an agent is made on: the execution layer's instructions, what it asks the person, and what
 * an agent made from it holds of itself.
 */
export const Creatable = z.object({
  id: CreatableId,
  title: Title,
  description: Description,
  instructions: z.string().max(200_000),
  asks: z.array(Ask).max(32),
  capability: OwnCapability.optional(),
});

const OnAgent = z.object({ agent: Id });

/**
 * What one part of an agent registered, as it stands now: the functions it gives the model, by the
 * names they are offered under, and the sections it adds to what the model is told, by their names.
 */
export const Added = z.strictObject({
  functions: z.array(z.string().min(1).max(64)).max(128),
  sections: z.array(z.string().min(1).max(64)).max(64),
});

/**
 * A part of what an agent is made of, as the agent says it: by its name, unique in the agent, and
 * its title. `mounted`, it does its part. `down`, it is there and can't do its part now: it says
 * so, or it waits for a service it needs. `failed`, it couldn't be mounted or loaded, and the agent
 * runs without it. `detail` says why, in whole sentences. `parent` names the part it is under: the
 * capability that mounted it, or, for a plugin, the capability that loaded it; none for one
 * mounted on the agent from outside it.
 *
 * A capability by default. `kind: "plugin"` is a plugin a capability loaded directly, which isn't
 * a capability of its own; what it loads in turn is part of it. Its name is unique in the agent and
 * the same while it runs, and its title is the name its plugin gives itself.
 *
 * `added` is what it registered, while it is there: none from an agent that doesn't say.
 */
export const HeldCapability = z.strictObject({
  name: CapabilityId,
  title: Title,
  state: z.enum(["mounted", "down", "failed"]),
  detail: z.string().max(2000).optional(),
  parent: CapabilityId.optional(),
  kind: z.literal("plugin").optional(),
  added: Added.optional(),
});

/**
 * The most parts an agent says it is made of: what every agent holds, what its settings name, what
 * was mounted on it, and what each of those mounted and loaded.
 */
export const HELD_MAX = 256;

/**
 * How an agent stands now, as what runs it knows: `starting`, `running`, `stopped` by the person,
 * or `down`, which it didn't ask for. `detail` says why it is down; or, though it runs, what is
 * wrong with it: whole sentences, each on a line of its own.
 */
export const AgentStatus = z.object({
  state: z.enum(["starting", "running", "stopped", "down"]),
  detail: z.string().max(2000).optional(),
});
/**
 * The same, as the agent's provider says it, with `mounted`: every capability mounted on the
 * agent, each with its state, in the order they were mounted. None from a provider that doesn't
 * say.
 */
export const ProvidedStatus = AgentStatus.extend({
  mounted: z.array(HeldCapability).max(HELD_MAX).optional(),
});
/** The models an agent can use, and the one chosen; none chosen means the provider's default. */
export const AgentModels = z.object({
  models: z.array(z.object({ id: ModelId, name: z.string().max(256) })),
  current: ModelId.optional(),
});

/**
 * `agent.provider@2`: a program that makes agents: an execution system and its way of running one.
 * It says what it can create, and makes, starts, stops and removes the agents it made, and keeps
 * the model chosen for each; each is an Actor. It is given what is mounted on each, with
 * `mounted`. A call naming an agent it didn't make is refused `unknown`.
 */
export const agentProvider = defineInterface({
  name: "agent.provider",
  major: 2,
  kind: "rpc",
  methods: {
    creatable: method({
      input: z.object({}),
      output: z.object({ creatables: z.array(Creatable) }),
    }),
    /**
     * Make and start an agent of a creatable, named `name`. `chat` is its export typed `chat@1`.
     * It holds what is mounted on it once it is given that with `mounted`. Refused `unknown` for a
     * creatable it doesn't offer, and `invalid` when an ask with no `optional` has no answer.
     */
    create: method({
      input: z.object({
        creatable: CreatableId,
        name: Title,
        answers: Answers,
      }),
      output: z.object({ agent: Id, chat: Name }),
    }),
    /**
     * What is mounted on an agent now: every root, in order, as the agent is to hold it. Each is
     * the whole list, in place of the one before. It answers once the agent holds what the list
     * names; an agent off its channel holds it when it joins again.
     */
    mounted: method({
      input: OnAgent.extend({ mounted: z.array(SettingsRoot).max(ROOTS_MAX) }),
      output: z.object({}),
    }),
    status: method({ input: OnAgent, output: ProvidedStatus }),
    start: method({ input: OnAgent, output: z.object({}) }),
    /**
     * Stop an agent, keeping it: it does nothing until it is started. Its record, bindings and
     * connections stay. Whether its chats can be read meanwhile is the provider's to say.
     */
    stop: method({ input: OnAgent, output: z.object({}) }),
    /** The models an agent can use, and the one chosen. */
    models: method({ input: OnAgent, output: AgentModels }),
    /**
     * Choose the model for an agent's next requests, kept with the agent; with no `model`, go back
     * to the provider's default. Refused `unknown` when the model isn't one of `models`.
     */
    setModel: method({
      input: OnAgent.extend({ model: ModelId.optional() }),
      output: z.object({}),
    }),
    /** Final: the agent's Actor is closed. */
    remove: method({ input: OnAgent, output: z.object({}) }),
  },
});
