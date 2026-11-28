/**
 * The engine: the looper bound to one agent. Its conversations are the looper's threads, its model
 * is the agent's `model` slot, a work's summary is written by what its `summary` capability
 * offers, and what a request says and offers is what the agent's capabilities give: those every
 * agent has, and those the tree of what is mounted on it names, as its host was last given it. Its
 * host says where the records are kept and what the agent is told when it gives no tree.
 */
import type { capability, chat, kv, llmSession, SettingsRoot, tools } from "@agentorg/interfaces";
import { type Conversed, type Model, type Part, Refusal, type Summarizer } from "@agentorg/looper";
import { type Context, Refused, type Slot } from "@agentorg/sdk";
import type { z } from "zod";
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
    { model: typeof llmSession },
    { chat: typeof chat; capability: typeof capability; tools: typeof tools }
  >,
  "slots" | "exports" | "exposed" | "onExposed" | "log"
>;

export function startEngine(
  ctx: Host,
  options: {
    store: Slot<typeof kv>["call"];
    /** What the agent is told when its host gives no tree. */
    instructions(): string;
    /**
     * The tree of what is mounted on it, as its host was last given it: none before the first,
     * which a turn waits for. With no `mounted`, its host gives none.
     */
    mounted?(): z.infer<typeof SettingsRoot>[] | undefined;
    /**
     * Its executor's own id: of the tree, it holds the roots that name it as their provider, and
     * management's own, which name none.
     */
    self?: string;
    /** Settles once the capabilities every agent has are mounted: no turn goes on before. */
    ready?: Promise<unknown>;
    /** Whether it starts stopped, as it was left. */
    stopped?: boolean;
    /**
     * Its plugins, each with a part inside it: it holds those its tree names, of those its host
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
   * Read the tree it was last given and hold the plugins it names, as one step: one at a time, in
   * the order asked, each reading only once the one before has held. So no hold applies a tree
   * older than one already held. With no tree given, it reads nothing and holds what it holds.
   */
  let reading: Promise<unknown> = Promise.resolve();
  const readAndHold = () => {
    const done = reading.then(async () => {
      const mounted = options.mounted?.();
      if (!mounted) return undefined;
      const named = mounted
        .filter(({ provider }) => provider === undefined || provider === options.self)
        .map(({ capability, arguments: settings }) => ({ name: capability, settings }));
      const everything = mounted.map(({ capability }) => capability);
      return { mounted, given: await plugins.hold(named, everything) };
    });
    reading = done.catch(() => {});
    return done;
  };
  /** Counts its stops and closes: a turn asked for before one was cut by it. */
  let cuts = 0;
  /** The turns waiting for its host's first tree, each with how to end its wait. */
  const waiting = new Set<() => void>();
  /**
   * Settles once its host has given a tree, at once if it has: or is refused once a stop or a
   * close since `at` cut the turn that waits.
   */
  const treeGiven = (at: number) =>
    new Promise<void>((resolve, reject) => {
      const end = () => {
        waiting.delete(end);
        if (at !== cuts) reject(new Refused("cancelled", "The turn was stopped."));
        else resolve();
      };
      if (at !== cuts || options.mounted?.()) end();
      else waiting.add(end);
    });
  /** End each wait for a tree: one was given, or its turn was cut. */
  const endWaits = () => {
    for (const end of [...waiting]) end();
  };
  /**
   * What a turn says and offers, and to which model, read afresh for each: none of it outlives it.
   * `leftOut` is what it couldn't offer, and why. With `waits`, one asked for before its host gave
   * a tree waits for it, as a turn cut off by a restart does; without, it is refused.
   */
  const request = async (conversation?: Conversed, waits = false) => {
    const at = cuts;
    await options.ready;
    // It holds what its tree names and reads what it gives in one step, which no other change
    // comes between: a turn is never behind the tree it was last given.
    let read = options.mounted ? await readAndHold() : undefined;
    // Its host gives a tree, and none has come yet: no turn runs without its instructions.
    while (options.mounted && !read) {
      if (!waits)
        throw new Refused("not_connected", "What is mounted on it hasn't been given to it yet.");
      await treeGiven(at);
      read = await readAndHold();
    }
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
    // With no tree from its host, it is told its host's words, first.
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
    // Read at each summary due, as its model is at each request: with no summary capability, none
    // is written, and what is over the budget is cut. It is asked with the looper's own way to ask,
    // so its requests are the turn's, which a stop cancels.
    summarizer: () => {
      const service = plugins.service?.("summary") as Summarizer | undefined;
      if (!service) return undefined;
      return (ask, compacting, files) => service.summarize(ask, compacting, files);
    },
    // A turn asked for before its host gave a tree waits for it.
    request: (conversation) => relayed(request(conversation, true)),
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
   * The turns that were cut off when the agent last ran go on once the model is bound, its tree
   * is given, and no tools slot is away. As the agent starts, what it is bound to may not
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
    // Refused while no tree is given: they are looked for again once one is.
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
   * It holds the plugins its tree names each time it is given one, with no turn to wait for: a
   * plugin may have work of its own between turns. One it can't hold it runs without, as its host
   * says, and it is tried again at the next hold. Turns cut off wait for a tree, so they are
   * looked for again; and turns that wait for one go on.
   */
  const holdNamed = async () => {
    try {
      await readAndHold();
    } finally {
      look();
      endWaits();
    }
  };
  // A tree given before it started, as to an agent that joins again, it holds once what every
  // agent has is mounted.
  if (options.mounted?.())
    void Promise.resolve(options.ready)
      .then(holdNamed)
      .catch((error: unknown) =>
        ctx.log.warn("It couldn't hold the plugins its tree names.", { error: String(error) }),
      );
  ctx.slots.model.onBind(look);
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
     * Hold the plugins the tree it was last given names, and settle once it does: what its host,
     * just given one, waits for. With no tree given, it holds what it holds.
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
      const stopping = chats.stop();
      // A turn waiting for its tree is cut with the rest.
      cuts++;
      endWaits();
      await stopping;
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
      const closing = chats.close();
      cuts++;
      endWaits();
      return closing;
    },
    /** Settles when every piece of work's latest turn has written all it will. */
    async settled() {
      await looking;
      await chats.settled();
    },
  };
}
