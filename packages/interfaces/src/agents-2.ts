import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";
import { AgentStatus, HELD_MAX, HeldCapability } from "./agent-provider.js";
import { Arguments, CapabilityDefinition, Mounting } from "./capability-provider.js";
import { Id } from "./hub.js";
import {
  ActorName,
  agents,
  MountedCapability,
  ProviderName,
  Purpose,
  TemplateId,
} from "./manager.js";
import { CapabilityId } from "./units.js";

const OnAgent = z.object({ agent: Id });

/** An agent as the list shows it, as in `agents@1`, but for the base and template it was built from. */
const AgentEntry = z.object({
  agent: Id,
  name: ActorName,
  status: AgentStatus,
  provider: Id,
  /** What it's for, as whoever made it said. */
  purpose: Purpose.optional(),
  /** The agent that made it; `gone` once that agent has been removed. It is the person's either way. */
  parent: z.object({ agent: Id, name: ActorName, gone: z.literal(true).optional() }).optional(),
});

/**
 * A capability mounted on an agent through management, as `agents@1` gives it, and `parent`: the
 * mount it came with, a template's, which mounted it as one of its own. None for one mounted on its
 * own.
 */
export const MountedCapability2 = MountedCapability.extend({ parent: Id.optional() });

/**
 * A template: capabilities to mount together, each by its provider's name, its capability and the
 * arguments it is mounted with, never a secret, which management refuses to keep. `from` is the
 * template it was made from, for display only.
 */
export const Template2 = z.strictObject({
  id: TemplateId,
  title: z.string().min(1).max(128),
  description: z.string().max(2000),
  from: TemplateId.optional(),
  capabilities: z
    .array(
      z.strictObject({ provider: ProviderName, capability: CapabilityId, arguments: Arguments }),
    )
    .max(64),
});
/**
 * A template as the listing gives it. `shipped` is on one that came with the app: it can't be
 * removed. A template saved under its id is listed in its place, and removing that one brings it
 * back.
 */
export const ListedTemplate2 = Template2.extend({ shipped: z.literal(true).optional() });

/** What `agents@1` gives of an agent, but its base, its template and its units. */
const Detail = agents.methods.get.output.omit({ creatable: true, template: true, units: true });

/**
 * `agents@2`: what management offers a person, an agent and any program on the Hub alike, each
 * answered the same, with no gating of its own: an agent is made empty, and is what is mounted on
 * it. Everything a page calls is here, so it reads nothing of `agents@1`, which is served beside
 * this until nothing reads it.
 *
 * Management offers capabilities of its own, its templates, beside every provider's: `capabilities`
 * names management as their provider. Mounting a template mounts each capability it lists, with
 * its arguments, as its own, each naming the template's mount as `parent`; unmounting the template
 * takes them off. Saving a template defines one.
 *
 * A template is filled as it is mounted, as a template was filled as an agent was created from it:
 * - Its definition's arguments have one property for each capability it lists, keyed by that
 *   capability's id, `-2`, `-3` and on for a repeat (`computer`, `web`, `memory-2`). Each is that
 *   capability's own argument schema, as its provider gives it, its secrets marked as they are.
 * - What is given under a key overrides the template's arguments for that capability. A secret
 *   among it goes to that capability's provider's mount and nowhere else, as any secret does.
 * - A required argument the template leaves empty, with none given, is a problem at
 *   `/<key>/<argument>`, and nothing of the template is mounted.
 *
 * Calls carried over from `agents@1` as they are: `start`, `stop`, `activity`, `live`, `models`,
 * `setModel`, `expose` and `unexpose`. Gone: `creatable`, `providers`, `units`, `check`, `addUnit`
 * and `removeUnit`, which are mounts now.
 */
export const agents2 = defineInterface({
  name: "agents",
  major: 2,
  kind: "rpc",
  methods: {
    /**
     * Make an agent holding only what every agent holds: its instructions, skills, connections and
     * model, with nothing mounted. What it is for, it is told.
     */
    create: method({
      input: z.object({ name: ActorName, purpose: Purpose.optional() }),
      output: OnAgent,
    }),
    /** Final: the agent goes, with everything mounted on it, each taken off first. */
    remove: method({ input: OnAgent, output: z.object({}) }),
    list: method({ input: z.object({}), output: z.object({ agents: z.array(AgentEntry) }) }),
    /**
     * What the agent is made of, in one read: what `agents@1` gives of it, but its base, its
     * template and its units; what was mounted on it through management, in the order it was; and,
     * as `composition`, everything it is made of, as the agent says it, while it can be asked.
     * `capabilities` are those whose views a page draws, filled from what each mount made.
     */
    get: method({
      input: OnAgent,
      output: Detail.extend({
        mounted: z.array(MountedCapability2).max(HELD_MAX),
        composition: z.array(HeldCapability).max(HELD_MAX).optional(),
      }),
    }),
    /** What every connected capability provider lists, and management's templates, each naming its provider. */
    capabilities: method({
      input: z.object({}),
      output: z.object({
        capabilities: z.array(CapabilityDefinition.extend({ provider: Id })).max(1024),
      }),
    }),
    /**
     * Mount a capability on the agent, from `arguments`, through its provider, as `agents@1` does.
     * Management keeps what was mounted, with its arguments but none that its schema marks
     * `secret`, and wires what the provider made for it.
     */
    mount: method({
      input: z.object({
        agent: Id,
        provider: Id,
        capability: CapabilityId,
        arguments: Arguments,
      }),
      output: Mounting,
    }),
    /** Final: what was mounted is taken off, with all that came with it, through its provider. */
    unmount: method({ input: z.object({ agent: Id, mounted: Id }), output: z.object({}) }),
    /** The templates, those that came with the app and those saved. */
    templates: method({
      input: z.object({}),
      output: z.object({ templates: z.array(ListedTemplate2) }),
    }),
    /** Save a template under its id, replacing one there; refused with a secret among its arguments. */
    saveTemplate: method({ input: Template2, output: z.object({}) }),
    /** Remove a saved template; one that came with the app can't be. */
    removeTemplate: method({ input: z.object({ id: TemplateId }), output: z.object({}) }),
    start: agents.methods.start,
    stop: agents.methods.stop,
    activity: agents.methods.activity,
    live: agents.methods.live,
    models: agents.methods.models,
    setModel: agents.methods.setModel,
    expose: agents.methods.expose,
    unexpose: agents.methods.unexpose,
  },
});
