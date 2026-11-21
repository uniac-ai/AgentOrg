/**
 * The bundled agent provider: it offers one creatable, Assistant, and runs each agent in this
 * process as its own Actor on its own channel. A stopped agent stays on its channel, so its
 * conversations can be read, and runs no turn until it is started. Each agent's conversations and model choice are kept
 * in the provider's private folder.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  agentProvider,
  agentSettings,
  capability,
  chat,
  hubActors,
  llmSession,
  tools,
} from "@agentorg/interfaces";
import { type Log, NotConnected, Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { z } from "zod";
import { startEngine } from "./engine.js";
import { createLocalStore } from "./local-store.js";
import { type AgentPlugin, type AgentPlugins, createPluginHost } from "./plugins.js";
import { ACTIVITY, WORK_TOOL } from "./work.js";

/** Who an agent made from the template is. How it works and speaks is the looper's frame. */
const ASSISTANT_INSTRUCTIONS = "You are an assistant in AgentOrg.";
/**
 * What the template said before the frame said it for every agent. An agent made then keeps these
 * words in its settings, and is told the template's words now in their place.
 */
const EARLIER_INSTRUCTIONS = `You are an assistant in AgentOrg, working for the person who created you.
You act only through your tools, and your tools are exactly the connections the person gave you. If something needs a connection you don't have, say which.
Before you promise to do something, check that one of your tools does it. A connection you are given later shows up as new tools at your next turn; until then, don't say you can use it.
Keep replies short and plain.`;

const ASSISTANT = {
  id: "assistant",
  title: "Assistant",
  description: "An agent that chats, and acts through the connections you give it.",
  instructions: ASSISTANT_INSTRUCTIONS,
  asks: [],
  // What each of its pieces of work did: its Activity, which the engine serves itself.
  capability: {
    id: "work",
    title: "Activity",
    views: [
      { id: ACTIVITY, place: "column", kind: "activity", operation: WORK_TOOL.name, slot: "work" },
    ],
  },
};

/** What is kept of an agent between runs, in the provider's private file. */
const Stored = z.object({ credential: z.string(), stopped: z.boolean() });
const FILE = "agents.json";

export interface AgentProviderOptions {
  hubUrl: string;
  /** The provider's own Actor, bound to `hub.actors@1` at `actors` and to the model at `model`. */
  actorId: string;
  credential: string;
  /** The export its `model` slot is bound to, which each agent it makes is bound to in turn. */
  model: { actor: string; export: string };
  /** A private folder of the provider's, which holds each agent's credential and record. */
  dir: string;
  /**
   * The plugins it carries, which an agent holds by name, as its settings say: none unless given.
   */
  // biome-ignore lint/suspicious/noExplicitAny: each plugin's settings are its own.
  plugins?: AgentPlugin<any>[];
  log?: Log;
}

export interface AgentProvider {
  /** Leave the Hub, every agent with it. They stay, and rejoin at the next start as each was left. */
  close(): Promise<void>;
}

/** An agent as it stands in this process. */
interface Held {
  state: "starting" | "running" | "stopped" | "down";
  detail?: string;
  channel?: { close(): void; readonly closed: Promise<void> };
  engine?: ReturnType<typeof startEngine>;
  /** The plugins it holds, loaded in its own context while it is open. */
  plugins?: AgentPlugins;
  /** What is being done to it: one thing at a time. */
  queue: Promise<unknown>;
}

const quiet: Log = { info() {}, warn() {}, error() {} };

/** Run the bundled agent provider as an Actor exporting `agent.provider@1` as `provider`. */
export async function startAgentProvider(options: AgentProviderOptions): Promise<AgentProvider> {
  const log = options.log ?? quiet;
  const { hubUrl, dir } = options;
  /** Every agent's plugins, each agent in a context of its own. */
  const host = createPluginHost(log, options.plugins);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, FILE);
  const folderOf = (agent: string) => join(dir, "agents", agent);
  /** The file; one that can't be read is set aside, so the agents in it can be recovered by hand. */
  const read = (): Record<string, z.infer<typeof Stored>> => {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    try {
      return z.record(z.string(), Stored).parse(JSON.parse(raw));
    } catch {
      renameSync(path, `${path}.unreadable-${Date.now()}`);
      log.error("The agents file can't be read: it is set aside and starts empty.");
      return {};
    }
  };
  const stored = read();
  const save = () => {
    writeFileSync(`${path}.tmp`, JSON.stringify(stored), { mode: 0o600, flush: true });
    renameSync(`${path}.tmp`, path);
  };

  const agents = new Map<string, Held>();
  let closing = false;
  const held = (agent: string) => {
    const found = agents.get(agent);
    if (!found) throw new Refused("unknown", `This provider made no agent ${agent}.`);
    return found;
  };
  /** An agent's engine, while it is on its channel: running, or stopped. */
  const engineOf = (agent: string) => {
    const { channel, engine, detail } = held(agent);
    if (!channel || !engine) throw new Refused("unavailable", detail ?? "It isn't running.");
    return engine;
  };
  /**
   * What an agent's model answered. A model that is away is refused as that, where the bare
   * error would reach the caller as its own slot being away.
   */
  const ofModel = <T>(asked: Promise<T>) =>
    asked.catch((error: unknown) => {
      if (error instanceof NotConnected)
        throw new Refused("not_connected", "Its model isn't connected.");
      throw error;
    });
  /** One thing at a time is done to an agent, in the order asked. */
  const queued = <T>(one: Held, work: (one: Held) => Promise<T>) => {
    const done = one.queue.then(() => work(one));
    one.queue = done.catch(() => {});
    return done;
  };
  const inTurn = <T>(agent: string, work: (one: Held) => Promise<T>) => queued(held(agent), work);

  /** Join the Hub as the agent, with its engine running, or stopped if it was left so. */
  const open = async (agent: string, one: Held) => {
    one.state = "starting";
    delete one.detail;
    // One whose connection ended joins again: what its plugins held before goes first.
    const earlier = one.plugins;
    delete one.plugins;
    await earlier?.close();
    const { stopped } = stored[agent] as z.infer<typeof Stored>;
    let engine: Held["engine"];
    let plugins: AgentPlugins | undefined;
    const store = createLocalStore(folderOf(agent));
    try {
      // Its context: it holds the plugins its settings name once its engine reads them.
      const context = await host.open(agent, { store });
      plugins = context;
      /**
       * A plugin its settings name that isn't carried, or doesn't load, leaves the agent down with
       * the reason, once what is being done to it is done: it runs with what its settings say it
       * holds, or not at all.
       */
      const held: AgentPlugins = {
        ...context,
        hold: (named) =>
          context.hold(named).catch((error: unknown) => {
            void queued(one, async () => {
              if (one.plugins !== context) return;
              await halt(one);
              one.state = "down";
              one.detail = error instanceof Error ? error.message : String(error);
            });
            throw error;
          }),
      };
      const channel = await connect({
        hubUrl,
        actorId: agent,
        credential: (stored[agent] as z.infer<typeof Stored>).credential,
        slots: { model: llmSession, settings: agentSettings },
        exports: { chat, capability, tools },
        log,
        start(ctx) {
          engine = startEngine(ctx, {
            store,
            instructions: () => ASSISTANT_INSTRUCTIONS,
            earlier: EARLIER_INSTRUCTIONS,
            stopped,
            plugins: held,
          });
        },
      });
      one.channel = channel;
      one.engine = engine;
      one.plugins = context;
      one.state = stopped ? "stopped" : "running";
      void channel.closed.then(() => {
        if (one.channel !== channel) return;
        delete one.channel;
        one.state = "down";
        one.detail = "Its connection to the Hub ended.";
      });
    } catch (error) {
      await plugins?.close();
      one.state = "down";
      one.detail = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };
  /**
   * Cut its turns, close its channel, wait until its engine has written all it will, and unload its
   * plugins.
   */
  const halt = async (one: Held) => {
    const { channel, engine, plugins } = one;
    delete one.channel;
    delete one.plugins;
    if (!channel || !engine) return void (await plugins?.close());
    await engine.close();
    channel.close();
    await channel.closed;
    await engine.settled();
    await plugins?.close();
  };

  await Promise.all(
    Object.keys(stored).map(async (agent) => {
      const one: Held = { state: "stopped", queue: Promise.resolve() };
      agents.set(agent, one);
      try {
        await queued(one, () => open(agent, one));
      } catch (error) {
        log.error(`Agent ${agent} didn't rejoin the Hub: ${String(error)}`);
        // The Hub no longer knows it: its Actor was closed while the provider was away.
        if (error instanceof Refused && error.code === "forbidden") {
          agents.delete(agent);
          delete stored[agent];
          save();
        }
      }
    }),
  );
  const haltAll = () =>
    Promise.all([...agents.keys()].map((agent) => inTurn(agent, halt).catch(() => {})));

  const provider = await connect({
    hubUrl,
    actorId: options.actorId,
    credential: options.credential,
    slots: { actors: hubActors, model: llmSession },
    exports: { provider: agentProvider },
    log,
    start(ctx) {
      ctx.exports.provider.implement({
        creatable: async () => ({ creatables: [ASSISTANT] }),
        async create({ creatable, name }) {
          if (creatable !== ASSISTANT.id)
            throw new Refused("unknown", `This provider offers no ${creatable}.`);
          // The provider is bound to the model's export, so it can give the agent that binding.
          const { actorId: agent, credential } = await ctx.slots.actors.call.create({
            name,
            bindings: [
              { slot: "model", provider: options.model.actor, export: options.model.export },
            ],
          });
          const one: Held = { state: "starting", queue: Promise.resolve() };
          try {
            stored[agent] = { credential: credential as string, stopped: false };
            await queued(one, () => open(agent, one));
            if (closing) throw new Refused("unavailable", "This provider is stopping.");
            agents.set(agent, one);
            save();
          } catch (error) {
            delete stored[agent];
            await halt(one);
            await ctx.slots.actors.call.close({ actorId: agent }).catch(() => {});
            await rm(folderOf(agent), { recursive: true, force: true });
            throw error;
          }
          return { agent, settings: "settings", chat: "chat" };
        },
        status: async ({ agent }) => {
          const { state, detail } = held(agent);
          return { state, ...(detail ? { detail } : {}) };
        },
        start: ({ agent }) =>
          inTurn(agent, async (one) => {
            if (one.state === "running") return {};
            (stored[agent] as z.infer<typeof Stored>).stopped = false;
            save();
            // One whose connection ended joins again; one that is only stopped goes on.
            if (!one.channel || !one.engine) await open(agent, one);
            else {
              one.engine.start();
              one.state = "running";
            }
            return {};
          }),
        stop: ({ agent }) =>
          inTurn(agent, async (one) => {
            (stored[agent] as z.infer<typeof Stored>).stopped = true;
            save();
            // One whose connection ended joins again, stopped, so that it can be read.
            if (!one.channel || !one.engine) await open(agent, one);
            else {
              await one.engine.stop();
              one.state = "stopped";
            }
            return {};
          }),
        models: ({ agent }) => ofModel(engineOf(agent).models()),
        // In the agent's turn, so a choice never lands after the agent is removed.
        setModel: ({ agent, model }) =>
          inTurn(agent, async () => {
            await ofModel(engineOf(agent).setModel(model));
            return {};
          }),
        remove: ({ agent }) =>
          inTurn(agent, async (one) => {
            await halt(one);
            one.state = "down";
            one.detail = "It is being removed.";
            await ctx.slots.actors.call.close({ actorId: agent });
            agents.delete(agent);
            delete stored[agent];
            save();
            await rm(folderOf(agent), { recursive: true, force: true });
            return {};
          }),
      });
    },
  }).catch(async (error) => {
    await haltAll();
    throw error;
  });

  return {
    async close() {
      closing = true;
      await haltAll();
      provider.close();
    },
  };
}
