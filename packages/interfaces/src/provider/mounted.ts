/**
 * What is mounted on an agent, as the program that runs it is given it: by management, in
 * `agent.provider@2`'s `mounted`, and as `agent.settings@2` answers it.
 */
import { z } from "zod";
import { Id } from "../base/names.js";
import { CapabilityId } from "../exposure/views.js";

/** The arguments a capability is mounted with, by property, as its `arguments` schema describes. */
export const Arguments = z.record(z.string().min(1).max(64), z.json());

/**
 * A capability mounted on an agent, as the program that runs the agent holds it. `mounted` is the
 * id it was mounted under. `capability` is what it is: the executor holds it by the plugin of the
 * same name. `arguments` are what it was mounted with, never a secret. `provider` is the Actor
 * whose `capability.provider@1` made it.
 *
 * Two roots are management's own, and name no provider: no caller mounts or unmounts them.
 * - `instructions`, whose arguments are `{ text }`: the words the agent is told of itself.
 * - `skills`, whose arguments are `{ skills }`: each skill exposed to it, by its name and
 *   description, whose files `agent.settings@2`'s `skill` reads.
 */
export const SettingsRoot = z.strictObject({
  mounted: Id,
  capability: CapabilityId,
  arguments: Arguments,
  provider: Id.optional(),
});

/**
 * The most roots an agent's tree has: management's own, and beside them what it holds, of which
 * its executor holds at most 64 plugins.
 */
export const ROOTS_MAX = 256;
