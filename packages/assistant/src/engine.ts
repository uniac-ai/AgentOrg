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
  "slots" | "exports" | "exposed" | "onExposed" | "log"
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
  /**
   * What a request says and offers, and to which model, read afresh: none of it outlives it.
   * `leftOut` is what it couldn't offer, and why.
   */
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
    const fitted = offered([...own, ...exposed.flatMap((one) => one.candidates)]);
    const leftOut = [...told.leftOut, ...exposed.flatMap((one) => one.leftOut), ...fitted.leftOut];
    report(leftOut);
    return { instructions: told.instructions, tools: fitted.tools, model: await chosen(), leftOut };
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
  /**
   * The turns that were cut off when the agent last ran go on once the model is bound, the
   * settings answer, and no tools slot is away. As the agent starts, what it is bound to may not
   * be running yet, so this is looked at again whenever that may have changed: a slot's provider
   * is back, a tools slot is made or gone, or one says its tools changed. A tools slot that stays
   * away holds them back; a message in a chat starts a turn anyway.
   */
  let wentOn = false;
  /** Each tools slot heard for its tools changing, with how to stop hearing it. */
  const heard = new Map<object, () => void>();
  const goOn = async () => {
    for (const slot of ctx.exposed())
      if (listsTools(slot.described) && !heard.has(slot)) heard.set(slot, slot.on("changed", look));
    if (!ctx.slots.model.bound) return;
    // Refused while the settings can't answer, as a turn's own request would be.
    const { leftOut } = await request();
    if (leftOut.some((one) => one.reason === "not_connected")) return;
    await chats.resume();
    done();
  };
  /** Nothing more is looked for: the turns have gone on, or the agent is stopped or closing. */
  const done = () => {
    wentOn = true;
    for (const stop of heard.values()) stop();
    heard.clear();
  };
  /** The look running now, and whether to look once more after it. */
  let looking: Promise<void> | undefined;
  let again = false;
  const look = () => {
    again = true;
    looking ??= (async () => {
      // A start binds its slots one after another in one go, and one not bound yet reads as one
      // the agent doesn't have: so it looks once they all are.
      await Promise.resolve();
      while (again && !wentOn) {
        again = false;
        await goOn().catch((error: unknown) =>
          ctx.log.info("Turns that were cut off aren't looked for yet.", { error: String(error) }),
        );
      }
      looking = undefined;
    })();
  };
  ctx.slots.model.onBind(look);
  ctx.slots.settings.onBind(look);
  ctx.onExposed(look);
  ctx.exports.chat.implement({
    send: (input) => chats.send(input),
    history: (input) => chats.history(input),
    state: () => chats.state(),
    list: (input) => chats.list(input),
    rename: (input) => chats.rename(input),
    archive: (input) => chats.archive(input),
  });
  return {
    /** The models the agent can use, and the one chosen for it. */
    async models() {
      const [{ models }, current] = await Promise.all([ctx.slots.model.call.models({}), chosen()]);
      return { models, ...(current ? { current } : {}) };
    },
    /** Choose the model for its next requests, kept with it; with none, the provider's default. */
    async setModel(model: string | undefined) {
      if (!model) {
        await store.delete({ key: MODEL_KEY });
        return;
      }
      const { models } = await ctx.slots.model.call.models({});
      if (!models.some((offered) => offered.id === model))
        throw new Refused("unknown", `${model} isn't one of the models offered.`);
      await store.set({ key: MODEL_KEY, value: model });
    },
    /** Stop the agent: its turns are cut and none starts until `start`. Its chats stay readable. */
    stop() {
      done();
      return chats.stop();
    },
    start: () => chats.start(),
    /**
     * Close for good: its turns are cut, and none starts after. They go on in the engine that
     * opens this store next.
     */
    close() {
      done();
      return chats.close();
    },
    /** Settles when every chat's latest turn has written all it will. */
    async settled() {
      await looking;
      await chats.settled();
    },
  };
}
