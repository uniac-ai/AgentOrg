import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";
import { Id } from "./hub.js";
import { CapabilityId } from "./units.js";

/**
 * What a capability is made with, as the JSON Schema of an object: a page draws a field from each
 * property, and an agent reads the same words. One mark is ours, `secret: true` on a property: its
 * value goes to the provider's `mount` and nowhere else, and is never saved or read back.
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
 * made with. Its `id` is unique among the provider's, and an agent holds one of it.
 */
export const CapabilityDefinition = z.strictObject({
  id: CapabilityId,
  title: z.string().min(1).max(128),
  description: z.string().max(2000),
  arguments: ArgumentsSchema,
});

const OnMounted = z.object({ agent: Id, mounted: Id });

/**
 * `capability.provider@1`: a program that makes capabilities for agents. It lists what it can make,
 * makes one on a running agent from the arguments given, and takes one it made off. The same
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
     * `unknown` for a capability it doesn't list, and `state` when the agent holds it already.
     */
    mount: method({
      input: z.object({ agent: Id, capability: CapabilityId, arguments: Arguments }),
      output: Mounting,
    }),
    /**
     * Final: it undoes what this mount made, and nothing the person pointed it at. Only a
     * capability taken off is unmounted, never one whose agent stops. Refused `unknown` for one
     * it doesn't hold.
     */
    unmount: method({ input: OnMounted, output: z.object({}) }),
  },
});
