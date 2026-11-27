/**
 * The agent's control: what it may mount and take off, on itself and on the agents it made, of
 * what the capability providers connected to management list. What is on offer it is told by
 * `offered`. Its three functions are management's tools, exposed to it at `control` beside its
 * control unit's, which connections offers as it does every slot's. This capability adds nothing
 * itself: it is what the agent holds while it has control. Which agents it reaches, and what it
 * may mount, management decides.
 */
import type { Capability } from "../substrate.js";

/** The `control` capability, which an agent holding an AgentOrg control unit holds. */
export const control = (): Capability => ({
  name: "control",
  title: "Control",
  inject: [],
  apply() {},
});
