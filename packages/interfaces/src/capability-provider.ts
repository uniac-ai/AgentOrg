import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";
import { HeldCapability } from "./agent-provider.js";
import { SKILL_FILE_MAX, SkillName, SkillPath } from "./agent-settings.js";
import { ConnectionTarget } from "./connection.js";
import { Id, SlotName } from "./hub.js";
import { CapabilityId, FactRow, Surface, View } from "./units.js";

/**
 * What a capability is made with, as the JSON Schema of an object: a page draws a field from each
 * property, and an agent reads the same words. One mark is ours, `secret: true` on a property: its
 * value goes to the provider's `mount` and nowhere else. Management never saves it or reads it
 * back. The provider keeps what it was given under its `mounted` id until that is unmounted, so the
 * capability comes back after a restart with it.
 */
export const ArgumentsSchema = z.object({ type: z.literal("object") }).catchall(z.json());
/** The arguments a capability is mounted with, by property, as its `arguments` schema describes. */
export const Arguments = z.record(z.string().min(1).max(64), z.json());
/**
 * A problem with the arguments given: at `path`, a JSON Pointer into them (`/token`), or, with
 * none, with the whole.
 */
export const ArgumentProblem = z.strictObject({
  path: z
    .string()
    .regex(/^(\/([^~/]|~[01])*)*$/)
    .max(1024)
    .optional(),
  message: z.string().min(1).max(2000),
});
/** What a mount gives: what was mounted, by the provider's id for it; or why not, and nothing made. */
export const Mounting = z.union([
  z.strictObject({ mounted: Id }),
  z.strictObject({ problems: z.array(ArgumentProblem).min(1).max(64) }),
]);
/**
 * A capability a provider can make for an agent: what it is called, what it does, and what it is
 * made with. Its `id` is unique among the provider's. An agent holds one of it, or, with `many`, as
 * many as are mounted, each its own mount with its own arguments, such as one for each MCP server.
 */
export const CapabilityDefinition = z.strictObject({
  id: CapabilityId,
  title: z.string().min(1).max(128),
  description: z.string().max(2000),
  arguments: ArgumentsSchema,
  many: z.literal(true).optional(),
});

/**
 * What a provider outside the agent made in mounting a capability, for management to wire to the
 * agent and the person: none from one inside the agent, which holds what it makes itself.
 * - `connections`: each an Actor of the provider's that exports `tools@1` as `tools`, which
 *   management exposes to the agent at `slot`.
 * - `skills`: each by its name and its files, which management reads with `skill` and exposes to the
 *   agent.
 * - `capability`: the Actor that exports `capability@1` as `capability`, which management connects
 *   the person to; its title; its live surfaces and its views, as they are for the arguments it was
 *   mounted with, in the shapes an agent's capability is given to a page; and by view id the rows of
 *   each view whose rows are fixed now.
 * Management takes it all off when the capability is unmounted; the provider ends what it made.
 */
export const Made = z.strictObject({
  connections: z
    .array(z.strictObject({ slot: SlotName, connection: Id, target: ConnectionTarget }))
    .max(32)
    .optional(),
  skills: z
    .array(z.strictObject({ name: SkillName, files: z.array(SkillPath).min(1).max(64) }))
    .max(16)
    .optional(),
  capability: z
    .strictObject({
      actor: Id,
      title: CapabilityDefinition.shape.title,
      surfaces: z.array(Surface).max(16),
      views: z.array(View).max(32),
      rows: z.record(CapabilityId, z.array(FactRow).max(32)).optional(),
    })
    .optional(),
});
/** What a provider's mount gives: what was mounted, and what was made for it; or why not. */
export const ProviderMounting = z.union([
  z.strictObject({ mounted: Id, made: Made.optional() }),
  z.strictObject({ problems: z.array(ArgumentProblem).min(1).max(64) }),
]);
const OnMounted = z.object({ agent: Id, mounted: Id });

/**
 * `capability.provider@1`: a program that makes capabilities for agents. It lists what it can make,
 * makes one on a running agent from the arguments given, says how one it made stands, and takes one
 * it made off. The same
 * definition serves the person, the agent and any program on the Hub; management calls it, and
 * keeps what was mounted. Each call is refused `unknown` for an agent the provider can't mount on.
 */
export const capabilityProvider = defineInterface({
  name: "capability.provider",
  major: 1,
  kind: "rpc",
  methods: {
    capabilities: method({
      input: z.object({}),
      output: z.object({ capabilities: z.array(CapabilityDefinition).max(256) }),
    }),
    /**
     * Make the capability on the agent, from `arguments`. It takes effect from the agent's next
     * model request. Arguments that don't fit give each problem, and nothing is made. Refused
     * `unknown` for a capability it doesn't list, and `state` when the agent holds it already,
     * unless it is `many`.
     */
    mount: method({
      input: z.object({ agent: Id, capability: CapabilityId, arguments: Arguments }),
      output: ProviderMounting,
    }),
    /**
     * A file of a skill a mount of `capability` makes, as its `made` names it. `shipped` is the
     * sha256 of each text that file had in earlier versions the provider shipped. Refused `unknown`
     * for a skill or file it doesn't make.
     */
    skill: method({
      input: z.object({ capability: CapabilityId, name: SkillName, path: SkillPath }),
      output: z.object({
        text: z.string().max(SKILL_FILE_MAX),
        shipped: z
          .array(z.string().regex(/^[0-9a-f]{64}$/))
          .max(256)
          .optional(),
      }),
    }),
    /**
     * How a mount stands now, in the words an agent's own capabilities use: `mounted` once it
     * works, `down` while it can't for now (being made, or its server away) with why, and
     * `failed` when it won't without a change. Management asks it when a person or program reads
     * the agent, never in the agent's turn. Refused `unknown` for a mount it doesn't have, which
     * management shows as failed.
     */
    status: method({
      input: OnMounted,
      output: z.strictObject({
        state: HeldCapability.shape.state,
        detail: z.string().max(2000).optional(),
      }),
    }),
    /**
     * Final: it undoes what this mount made, and nothing the person pointed it at. Only a
     * capability taken off is unmounted, never one whose agent stops. Refused `unknown` for one
     * it doesn't hold.
     */
    unmount: method({ input: OnMounted, output: z.object({}) }),
  },
});
