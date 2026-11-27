/**
 * What the agent is connected to, offered to its model: every `tools@1` slot exposed to it, each
 * function as `<slot>__<name>`, and the conversations of the agents it talks to. A slot's tools
 * are listed once a turn; one that can't answer is left out, and says why, until it can. A tool
 * another capability already offers through its slot, in its own place, isn't offered again.
 */
import type { Context } from "cordis";
import { agentTools } from "../agents.js";
import type { Capability } from "../substrate.js";
import { type Candidate, type LeftOut, listedBy, listsTools } from "../tools.js";

/** Where the agents it talks to go among its functions: after its skills, before the rest. */
export const AGENTS_ORDER = -20;
/** Where its connections' functions go: after every other capability's. */
export const CONNECTIONS_ORDER = 10;

/** The `connections` capability, which every agent holds. */
export const connections = (): Capability => ({
  name: "connections",
  title: "Connections",
  inject: ["context", "hub"],
  apply(ctx: Context) {
    const { hub } = ctx;
    /**
     * A slot as exposed when a call runs, not when its tools were listed: a turn keeps what it
     * was offered, and a slot bound again meanwhile is reached through its new handle. One that
     * is gone answers through the handle it had, which refuses as it does.
     */
    const live = (slot: ReturnType<typeof hub.exposed>[number]) => ({
      get call() {
        return (hub.exposed().find((one) => one.slot === slot.slot) ?? slot).call;
      },
    });
    let listed: { candidates: Candidate[]; leftOut: LeftOut[] }[] = [];
    // In the order they came, each asked at once so one slow server delays only itself.
    ctx.context.turn(async () => {
      listed = await Promise.all(
        hub
          .exposed()
          .filter((slot) => listsTools(slot.described))
          .map((slot) => listedBy(slot.slot, live(slot))),
      );
    });
    ctx.context.pass(
      (request) => void request.functions.push(...agentTools(hub.exposed(), () => hub.exposed())),
      { order: AGENTS_ORDER },
    );
    ctx.context.pass(
      (request) => {
        const offered = new Set(request.functions.map(({ slot, name }) => `${slot}/${name}`));
        request.functions.push(
          ...listed
            .flatMap((one) => one.candidates)
            .filter(({ slot, name }) => !offered.has(`${slot}/${name}`)),
        );
        request.leftOut.push(...listed.flatMap((one) => one.leftOut));
      },
      { order: CONNECTIONS_ORDER },
    );
  },
});
