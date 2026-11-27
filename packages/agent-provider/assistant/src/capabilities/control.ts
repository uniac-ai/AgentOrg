/**
 * The agent's control: what it may mount and take off, on itself and on the agents it made, of
 * what the capability providers connected to management list. What is on offer it is told by
 * `offered`. Its three functions are management's tools, exposed to it at `control` beside its
 * control unit's: offered here in their place, and run through that slot. Which agents it reaches,
 * and what it may mount, management decides.
 */
import type { Outcome } from "@agentorg/looper";
import type { Context } from "cordis";
import type { Capability } from "../substrate.js";
import { codeOf, listsTools } from "../tools.js";

/** Where management exposes the tools that answer control's functions. */
const SLOT = "control";

const AGENT = {
  type: "string",
  description: "The id of an agent you made; leave it out for yourself.",
};

/** The `control` capability, which an agent holding an AgentOrg control unit holds. */
export const control = (): Capability => ({
  name: "control",
  title: "Control",
  inject: ["tools", "hub"],
  apply(ctx: Context) {
    /** Run one of its functions through management's tools, as exposed to the agent now. */
    const through =
      (name: string) =>
      async (input: unknown, group: string): Promise<Outcome> => {
        const slot = ctx.hub
          .exposed()
          .find((one) => one.slot === SLOT && listsTools(one.described));
        if (!slot)
          return { output: "Management can't be reached now.", ok: false, code: "not_connected" };
        try {
          const call = slot.call.call as (input: object) => Promise<{
            output: string;
            failed?: true;
          }>;
          const { output, failed } = await call({ name, arguments: input, group });
          return failed ? { output, ok: false, code: "failed" } : { output, ok: true };
        } catch (error) {
          // What refuses it is told to the model.
          const { code, message } = codeOf(error);
          return { output: message, ok: false, code };
        }
      };

    ctx.tools.register({
      name: "capability_list",
      description:
        "List the capabilities you can mount, each with its provider, id, title, description and the arguments it takes, and what is mounted now on you, or on an agent you made.",
      parameters: {
        type: "object",
        properties: { agent: AGENT },
        additionalProperties: false,
      },
      run: through("capability_list"),
    });

    ctx.tools.register({
      name: "capability_mount",
      description:
        "Mount a capability capability_list gives on yourself, or on an agent you made, with the arguments it takes. It takes effect from your next message.",
      parameters: {
        type: "object",
        properties: {
          agent: AGENT,
          provider: { type: "string", description: "Its provider, as capability_list gives it." },
          capability: { type: "string", description: "Its id, as capability_list gives it." },
          arguments: { type: "object", description: "The arguments it takes." },
        },
        required: ["provider", "capability"],
        additionalProperties: false,
      },
      run: through("capability_mount"),
    });

    ctx.tools.register({
      name: "capability_unmount",
      description:
        "Take a capability off yourself, or off an agent you made, by the id capability_list gives it under mounted.",
      parameters: {
        type: "object",
        properties: {
          agent: AGENT,
          mounted: { type: "string", description: "Its id under mounted." },
        },
        required: ["mounted"],
        additionalProperties: false,
      },
      run: through("capability_unmount"),
    });
  },
});
