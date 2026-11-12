import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";
import { Id, Name } from "./hub.js";
import { ModelId } from "./llm-session.js";
import { CapabilityId, View } from "./units.js";

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
 * How an agent stands now, as what runs it knows: `starting`, `running`, `stopped` by the person,
 * or `down`, which it didn't ask for. `detail` says why it is down.
 */
export const AgentStatus = z.object({
  state: z.enum(["starting", "running", "stopped", "down"]),
  detail: z.string().max(2000).optional(),
});
/** The models an agent can use, and the one chosen; none chosen means the provider's default. */
export const AgentModels = z.object({
  models: z.array(z.object({ id: ModelId, name: z.string().max(256) })),
  current: ModelId.optional(),
});

/**
 * `agent.provider@1`: a program that makes agents: an execution system and its way of running one.
 * It says what it can create, and makes, starts, stops and removes the agents it made, and keeps
 * the model chosen for each; each is an Actor. A call naming an agent it didn't make is refused
 * `unknown`.
 */
export const agentProvider = defineInterface({
  name: "agent.provider",
  major: 1,
  kind: "rpc",
  methods: {
    creatable: method({
      input: z.object({}),
      output: z.object({ creatables: z.array(Creatable) }),
    }),
    /**
     * Make and start an agent of a creatable, named `name`. `settings` is the agent's slot typed
     * `agent.settings@1`, for whoever serves it to bind, and `chat` its export typed `chat@1`.
     * Refused `unknown` for a creatable it doesn't offer, and `invalid` when an ask with no
     * `optional` has no answer.
     */
    create: method({
      input: z.object({
        creatable: CreatableId,
        name: Title,
        answers: Answers,
      }),
      output: z.object({ agent: Id, settings: Name, chat: Name }),
    }),
    status: method({ input: OnAgent, output: AgentStatus }),
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
