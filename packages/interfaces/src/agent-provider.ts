import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";
import { SKILL_FILE_MAX, SkillName, SkillPath } from "./agent-settings.js";
import { Id, Name, SlotName } from "./hub.js";
import { ConnectionKind, ConnectionParams } from "./mcp-provider.js";

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
 * An MCP connection an agent of this creatable needs, exposed to it as `slot`. With `pick`, the
 * person picks one they have. With `create`, one is made for the agent through a connected provider
 * offering `kind`, with `params`, each top-level parameter in `fromAnswers` set to the answer it
 * names.
 */
const McpNeed = z.discriminatedUnion("how", [
  z.object({ how: z.literal("pick"), slot: SlotName, title: Title }),
  z.object({
    how: z.literal("create"),
    slot: SlotName,
    title: Title,
    kind: ConnectionKind,
    params: ConnectionParams,
    fromAnswers: z.record(z.string(), AskId).optional(),
  }),
]);
/**
 * A predefined set an agent is made from. Its skills are listed by name and files, `SKILL.md` among
 * them; `skill` reads each file.
 */
export const Creatable = z.object({
  id: CreatableId,
  title: Title,
  description: Description,
  instructions: z.string().max(200_000),
  asks: z.array(Ask).max(32),
  skills: z.array(z.object({ name: SkillName, files: z.array(SkillPath).min(1).max(256) })).max(64),
  mcp: z.array(McpNeed).max(32),
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
    /** A file of a skill a creatable comes with. Refused `unknown` when there is no such file. */
    skill: method({
      input: z.object({ creatable: CreatableId, name: SkillName, path: SkillPath }),
      output: z.object({ text: z.string().max(SKILL_FILE_MAX) }),
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
    /** It ends the agent's process; its record, bindings and connections stay. */
    stop: method({ input: OnAgent, output: z.object({}) }),
    /** Final: the agent's Actor is closed. */
    remove: method({ input: OnAgent, output: z.object({}) }),
  },
});
