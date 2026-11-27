/**
 * The engine: the looper bound to one agent. Its conversations are the looper's threads, its model
 * is the agent's `model` slot, and what a request says and offers is what the agent's capabilities
 * give: those every agent has, and those the tree its `settings` give names. Its host says where
 * the records are kept and what the agent is told when no `settings` is bound.
 */
import type { agentSettings2, capability, chat, kv, llmSession, tools } from "@agentorg/interfaces";
import { type Conversed, type Model, type Part, Refusal } from "@agentorg/looper";
import { type Context, Refused, type Slot } from "@agentorg/sdk";
import { WORDS } from "./capabilities/instructions.js";
import { createChats } from "./chats.js";
import type { Model as AgentModel } from "./connector.js";
import { type AgentPlugins, NO_PLUGINS } from "./plugins.js";
import { MAX_INSTRUCTIONS } from "./settings.js";
import { type LeftOut, listsTools, offered, offeredName, relayed } from "./tools.js";
import { ACTIVITY, serveWork } from "./work.js";

/** Where the agent keeps the model chosen for it, beside its conversations in the store. */
const MODEL_KEY = "settings/model";
/** How a section a capability adds through `prompt` is owned. */
const SECTION = "plugin:";

type Host = Pick<
  Context<
    { model: typeof llmSession; settings: typeof agentSettings2 },
    { chat: typeof chat; capability: typeof capability; tools: typeof tools }
  >,
  "slots" | "exports" | "exposed" | "onExposed" | "log"
>;

export function startEngine(
  ctx: Host,
  options: {
    store: Slot<typeof kv>["call"];
    /** What the agent is told while no `settings` is bound. */
    instructions(): string;
    /**
     * Its executor's own id: of the tree its settings give, it holds the roots that name it as
     * their provider, and management's own, which name none.
     */
    self?: string;
    /** Settles once the capabilities every agent has are mounted: no turn goes on before. */
    ready?: Promise<unknown>;
    /** Whether it starts stopped, as it was left. */
    stopped?: boolean;
    /**
     * Its plugins, each with a part inside it: it holds those its settings name, of those its host
     * carries. None by default.
     */
    plugins?: AgentPlugins;
  },
) {
  const { store } = options;
  const plugins = options.plugins ?? NO_PLUGINS;
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
   * What a turn says and offers, and to which model, read afresh for each: none of it outlives it.
   * `leftOut` is what it couldn't offer, and why.
   */
  /**
   * Read its settings and hold the plugins they name, as one step: one at a time, in the order
   * asked, each reading only once the one before has held. So no hold applies settings older than
   * one already held, as a read over a slow channel otherwise could, after a later read named a
   * capability just mounted. With no settings bound, it reads nothing and holds what it holds.
   */
  let reading: Promise<unknown> = Promise.resolve();
  const readAndHold = () => {
    const done = reading.then(async () => {
      if (!ctx.slots.settings.bound) return undefined;
      const { mounted } = await ctx.slots.settings.call.get({});
      const named = mounted
        .filter(({ provider }) => provider === undefined || provider === options.self)
        .map(({ capability, arguments: settings }) => ({ name: capability, settings }));
      const everything = mounted.map(({ capability }) => capability);
      return { mounted, given: await plugins.hold(named, everything) };
    });
    reading = done.catch(() => {});
    return done;
  };
  const request = async (conversation?: Conversed) => {
    await options.ready;
    // It holds what its settings name and reads what they give in one step, which no other change
    // comes between: a turn is never behind its settings, whether or not it heard them change.
    const read = ctx.slots.settings.bound ? await readAndHold() : undefined;
    // What its capabilities read once a turn, then what they give. For a conversation's own loop,
    // they are passed the conversation, so a pass can tell whose it is.
    await plugins.turn(conversation);
    const given = plugins.pass({
      ...(conversation ? { loop: conversation } : {}),
      instructions: [],
      functions: [],
      input: [],
      leftOut: [],
    });
    // With no settings bound, it is told its host's words, first.
    const instructions: Part[] = read
      ? given.instructions
      : [
          { owner: WORDS, text: options.instructions(), max: MAX_INSTRUCTIONS },
          ...given.instructions,
        ];
    // Its own words: who its main loop speaks as, with nothing of its skills.
    const voice = instructions.find((part) => part.owner === WORDS)?.text ?? "";
    const fitted = offered(given.functions);
    // What each part of it added is said of what was offered, not what was left out.
    plugins.offered?.(fitted.tools.map(({ name }) => name));
    const leftOut = [...given.leftOut, ...fitted.leftOut];
    report(leftOut);
    // Its capabilities' sections: a worker is told them after its own words and its skills, the
    // front desk after who it speaks as. The functions they give through `tools`, of those
    // offered, are the front desk's too, and none other of its own.
    const blocks = instructions.filter((part) => part.owner.startsWith(SECTION));
    const theirs = new Set(plugins.tools().map(({ slot, name }) => offeredName(slot, name)));
    return {
      instructions,
      blocks,
      tools: fitted.tools,
      frontDesk: fitted.tools.filter(({ name }) => theirs.has(name)),
      model: await chosen(),
      voice,
      leftOut,
    };
  };
  /** Its model capability, which its loops ask through. */
  const asking = () => {
    const service = plugins.service?.("model") as AgentModel | undefined;
    if (!service) throw new Refusal("not_connected", "Its model isn't mounted.");
    return service;
  };
  /** The model as the looper asks it: what it refuses is told with its code. */
  const model: Model = {
    respond: async (asked) => relayed(asking().request(asked)),
    // With no model, there is nothing to stop.
    cancel: async (asked) => {
      const service = plugins.service?.("model") as AgentModel | undefined;
      return service ? service.cancel(asked) : {};
    },
  };
  const chats = createChats({
    store,
    stopped: options.stopped ?? false,
    model,
    request: (conversation) => relayed(request(conversation)),
    // Each request its loops make, passed through every capability's passes: what they change of
    // its input is sent.
    pass: (input, conversation) =>
      plugins.pass({
        ...(conversation ? { loop: conversation } : {}),
        instructions: [],
        functions: [],
        input: [...input],
        leftOut: [],
      }).input,
    // Asked of every tools slot: one that ran nothing of the group ends nothing. A provider
    // whose tools@1 has no `stop` isn't asked.
    stopGroup: (group) =>
      Promise.all(
        ctx
          .exposed()
          .filter((slot) => listsTools(slot.described))
          .map((slot) => {
            const stop = (
              slot.call as Record<string, ((input: object) => Promise<unknown>) | undefined>
            ).stop;
            return stop?.({ group }).catch((error: unknown) =>
              ctx.log.warn("A tools slot's stop failed.", {
                slot: slot.slot,
                error: String(error),
              }),
            );
          }),
      ),
    emit: {
      message: (message, to) => ctx.exports.chat.emit("message", message, { to }),
      delta: (delta, to) => ctx.exports.chat.emit("delta", delta, { to }),
      progress: (progress, to) => ctx.exports.chat.emit("progress", progress, { to }),
      status: (status) => ctx.exports.chat.emit("status", status),
      chat: (entry, to) => ctx.exports.chat.emit("chat", entry, { to }),
      worked: () => ctx.exports.capability.emit("changed", { view: ACTIVITY }),
    },
    life: plugins.life,
    log: ctx.log,
  });
  ctx.slots.model.on("delta", ({ requestId, text, call }) => chats.delta(requestId, text, call));
  ctx.slots.model.on("retrying", ({ requestId, attempt, of, at }) =>
    chats.retrying(requestId, { attempt, of, at }),
  );
  /**
   * The turns that were cut off when the agent last ran go on once the model is bound, the
   * settings answer, and no tools slot is away. As the agent starts, what it is bound to may not
   * be running yet, so this is looked at again whenever that may have changed: a slot's provider
   * is back, a tools slot is made or gone, or one says its tools changed. A tools slot that stays
   * away holds them back; a message in a conversation starts a turn anyway.
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
  /**
   * It holds the plugins its settings name from when its settings are bound, and again when they
   * say they changed, with no turn to wait for: a plugin may have work of its own between turns.
   * One it can't hold it runs without, as its host says, and it is tried again at the next hold.
   */
  const holdNamed = async () => {
    await readAndHold();
  };
  const hold = () =>
    void holdNamed().catch((error: unknown) =>
      ctx.log.warn("Its settings couldn't be read for its plugins.", {
        error: String(error),
      }),
    );
  ctx.slots.settings.onBind(hold);
  ctx.slots.settings.on("changed", hold);
  ctx.slots.model.onBind(look);
  ctx.slots.settings.onBind(look);
  ctx.onExposed(look);
  serveWork(ctx.exports, chats);
  // Each caller has its own conversation with the agent: the Hub names who calls.
  ctx.exports.chat.implement({
    send: (input, { caller }) => chats.send(input, caller),
    history: (input, { caller }) => chats.history(input, caller),
    state: () => chats.state(),
    list: (input, { caller }) => chats.list(input, caller),
  });
  return {
    /**
     * Hold the plugins its settings name now, and settle once it does: what a caller that has just
     * changed them waits for. Its settings unbound, it holds what it holds.
     */
    hold: holdNamed,
    /** The model chosen for it, if one is: the provider's default if none. */
    chosen,
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
    /** Stop the agent: its turns are cut and none starts until `start`. Its conversations stay readable. */
    async stop() {
      done();
      await chats.stop();
      // Said last, once its turns were cut.
      plugins.life("stopped");
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
    /** Settles when every piece of work's latest turn has written all it will. */
    async settled() {
      await looking;
      await chats.settled();
    },
  };
}
