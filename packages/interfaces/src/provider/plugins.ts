import { z } from "zod";

/** A slug, as a capability's id is (`CapabilityId` in `exposure/views.ts`). */
export const Slug = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/)
  .max(64);
/** A plugin's name: the executor loads the plugin it carries of that name. */
export const PluginName = Slug;
/**
 * A plugin a capability is made of, loaded inside the agent that holds the capability: by its name,
 * with the settings it is loaded with. The settings are the plugin's own to read, any JSON, not
 * only what a unit's form gives.
 */
export const CapabilityPlugin = z.strictObject({
  name: PluginName,
  settings: z.record(z.string().max(64), z.json()).optional(),
});
