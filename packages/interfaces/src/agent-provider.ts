import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";
import { Id, Name } from "./hub.js";

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
/** What an agent is made on: the execution layer's instructions and what it asks the person. */
export const Creatable = z.object({
  id: CreatableId,
  title: Title,
  description: Description,
  instructions: z.string().max(200_000),
  asks: z.array(Ask).max(32),
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

/**
 * `agent.provider@1`: a program that makes agents: an execution system and its way of running one.
 * It says what it can create, and makes, starts, stops and removes the agents it made; each is an
 * Actor. `status`, `start`, `stop` and `remove` are refused `unknown` for an agent it didn't make.
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
     * Stop an agent, keeping it: it runs no turn until it is started. Its record, bindings and
     * connections stay. Whether its chats can be read meanwhile is the provider's to say.
     */
    stop: method({ input: OnAgent, output: z.object({}) }),
    /** Final: the agent's Actor is closed. */
    remove: method({ input: OnAgent, output: z.object({}) }),
  },
});
