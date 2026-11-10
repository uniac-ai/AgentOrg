/**
 * The engine: the looper bound to one agent. Its chats are the looper's threads, its model is the
 * agent's `model` slot, and what a request says and offers is read from what the agent is bound to.
 * Its host says where the records are kept and what the agent is told when no `settings` is bound.
 */
import type { agentSettings, chat, kv, llmSession } from "@agentorg/interfaces";
import type { Model } from "@agentorg/looper";
import { type Context, Refused, type Slot } from "@agentorg/sdk";
import { createChats } from "./chats.js";
import { instructionsWith, skillTool } from "./settings.js";
import { type Candidate, type LeftOut, listedBy, listsTools, offered, relayed } from "./tools.js";

/** Where the agent keeps the model chosen for it, beside its chats in the store. */
const MODEL_KEY = "settings/model";

type Host = Pick<
  Context<{ model: typeof llmSession; settings: typeof agentSettings }, { chat: typeof chat }>,
  "slots" | "exports" | "exposed" | "log"
>;

export function startEngine(
  ctx: Host,
  options: {
    store: Slot<typeof kv>["call"];
    /** What the agent is told while no `settings` is bound. */
    instructions(): string;
    /** Whether it starts stopped, as it was left. */
    stopped?: boolean;
  },
) {
  const { store } = options;
  /** The model chosen for this agent, if any; read for each request. */
  const chosen = async () => {
    const { value } = await store.get({ key: MODEL_KEY });
    return typeof value === "string" ? value : undefined;
  };
  /** What was last reported as left out, so a change is logged once. */
  let reported = "[]";
  const report = (leftOut: LeftOut[]) => {
    const now = JSON.stringify(leftOut);
    if (now === reported) return;
    reported = now;
    if (leftOut.length > 0) ctx.log.warn("Not everything is offered to the model.", { leftOut });
    else ctx.log.info("Everything is offered to the model again.");
  };
  /** What a request says and offers, and to which model, read afresh: none of it outlives it. */
  const request = async () => {
    const settings = ctx.slots.settings.bound ? await ctx.slots.settings.call.get({}) : undefined;
    const told = settings
      ? instructionsWith(settings.instructions, settings.skills)
      : { instructions: options.instructions(), leftOut: [] };
    const own: Candidate[] = settings?.skills.length ? [skillTool(ctx.slots.settings)] : [];
    // In the order they came, each asked at once so one slow server delays only itself.
    const exposed = await Promise.all(
      ctx
        .exposed()
        .filter((slot) => listsTools(slot.described))
        .map((slot) => listedBy(slot.slot, slot)),
    );
    const { tools, leftOut } = offered([...own, ...exposed.flatMap((one) => one.candidates)]);
    report([...told.leftOut, ...exposed.flatMap((one) => one.leftOut), ...leftOut]);
    return { instructions: told.instructions, tools, model: await chosen() };
  };
  /** The model slot as the looper asks it: what it refuses is told with its code. */
  const model: Model = {
    respond: (asked) => relayed(ctx.slots.model.call.respond(asked)),
    // A model that is gone has nothing to stop.
    cancel: async (asked) => (ctx.slots.model.bound ? ctx.slots.model.call.cancel(asked) : {}),
  };
  const chats = createChats({
    store,
    stopped: options.stopped ?? false,
    model,
    request: () => relayed(request()),
    emit: {
      message: (message) => ctx.exports.chat.emit("message", message),
      delta: (delta) => ctx.exports.chat.emit("delta", delta),
      status: (status) => ctx.exports.chat.emit("status", status),
      chat: (entry) => ctx.exports.chat.emit("chat", entry),
    },
    log: ctx.log,
  });
  ctx.slots.model.on("delta", ({ requestId, text }) => chats.delta(requestId, text));
  ctx.exports.chat.implement({
    send: (input) => chats.send(input),
    history: (input) => chats.history(input),
    cancel: (input) => chats.cancel(input),
    state: (input) => chats.state(input),
    retry: (input) => chats.retry(input),
    list: (input) => chats.list(input),
    rename: (input) => chats.rename(input),
    archive: (input) => chats.archive(input),
    models: async () => {
      const [{ models }, current] = await Promise.all([ctx.slots.model.call.models({}), chosen()]);
      return { models, ...(current ? { current } : {}) };
    },
    setModel: async ({ model }) => {
      if (!model) {
        await store.delete({ key: MODEL_KEY });
        return {};
      }
      const { models } = await ctx.slots.model.call.models({});
      if (!models.some((offered) => offered.id === model))
        throw new Refused("unknown", `${model} isn't one of the models offered.`);
      await store.set({ key: MODEL_KEY, value: model });
      return {};
    },
  });
  return {
    /** Stop the agent: its turns are cut and none starts until `start`. Its chats stay readable. */
    stop: () => chats.stop(),
    start: () => chats.start(),
    /** Close for good: its turns are cut, and none starts after. */
    close: () => chats.close(),
    /** Settles when every chat's latest turn has written all it will. */
    settled: () => chats.settled(),
  };
}
