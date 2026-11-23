import { defineInterface, method } from "@agentorg/sdk";
import { z } from "zod";
import { AgentStatus, HELD_MAX, HeldCapability } from "./agent-provider.js";
import { Arguments, CapabilityDefinition, Mounting } from "./capability-provider.js";
import { Id } from "./hub.js";
import { ActorName, MountedCapability, Purpose } from "./manager.js";
import { CapabilityId } from "./units.js";

const OnAgent = z.object({ agent: Id });

/** An agent as the list shows it: its status is its provider's. */
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
 * `agents@2`: what management offers a person, an agent and any program on the Hub alike, each
 * answered the same, with no gating of its own: an agent is made empty, and is what is mounted on
 * it.
 *
 * Management offers capabilities of its own, its templates, beside every provider's: `capabilities`
 * names management as their provider. Mounting a template mounts each capability it lists, with its
 * arguments, as its own, each naming the template's mount as `parent`; unmounting the template
 * takes them off. A template saved through `agents@1` is one from then on. `agents@1` is served
 * beside this until nothing reads it.
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
     * The agent, what was mounted on it through management, in the order it was, and, as
     * `composition`, everything it is made of, as the agent says it, while it can be asked.
     */
    get: method({
      input: OnAgent,
      output: AgentEntry.extend({
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
  },
});
