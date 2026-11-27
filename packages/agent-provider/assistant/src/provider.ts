/**
 * The bundled agent provider: it offers one creatable, Assistant, and runs each agent in this
 * process as its own Actor on its own channel. A stopped agent stays on its channel, so its
 * conversations can be read, and runs no turn until it is started. Each agent's conversations and model choice are kept
 * in the provider's private folder.
 *
 * Management gives it what is mounted on each agent (`agent.provider@2`'s `mounted`), and it has
 * the agent hold that, keeping only the last list of each, in memory: management gives every list
 * again when this provider is back. It is also a capability provider for its own agents
 * (`capability.provider@1`, as `capabilities`): it offers the capabilities it carries that it is
 * given definitions of. What an agent holds is what its list names: management keeps what was
 * mounted, and gives the agent its list naming it before it asks, so this provider's `mount`
 * answers from what the agent holds then. It keeps no list of its own.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  agentProvider,
  type CapabilityDefinition,
  capability,
  capabilityProvider,
  chat,
  HELD_MAX,
  hubActors,
  llmSession,
  type SettingsRoot,
  tools,
} from "@agentorg/interfaces";
import { type Log, NotConnected, Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { z } from "zod";
import { connections } from "./capabilities/connections.js";
import { control } from "./capabilities/control.js";
import { instructions } from "./capabilities/instructions.js";
import { offered } from "./capabilities/offered.js";
import { skills } from "./capabilities/skills.js";
import { type AgentHub, type Channel, connector, model } from "./connector.js";
import { startEngine } from "./engine.js";
import { createLocalStore } from "./local-store.js";
import {
  type AgentContext,
  type AgentPlugin,
  type AgentPlugins,
  createPluginHost,
  type Without,
} from "./plugins.js";
import { head } from "./tools.js";
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
  /**
   * The capabilities it offers its agents, each by the name of a plugin it carries: a capability's
   * id and its plugin's name are one and the same. None unless given.
   */
  offers?: z.infer<typeof CapabilityDefinition>[];
  log?: Log;
}

export interface AgentProvider {
  /** Leave the Hub, every agent with it. They stay, and rejoin at the next start as each was left. */
  close(): Promise<void>;
}

/** An agent as it stands in this process. */
interface Held {
  state: "starting" | "running" | "stopped" | "down";
  /** Why it is down. */
  detail?: string;
  /** While it runs: the plugins its settings name that it runs without, and why, as its status says. */
  without?: string;
  channel?: { close(): void; readonly closed: Promise<void> };
  engine?: ReturnType<typeof startEngine>;
  /** The plugins it holds, loaded in its own context while it is open. */
  plugins?: AgentContext;
  /** What is mounted on it, as management last gave it: none until it does. */
  mounted?: z.infer<typeof SettingsRoot>[];
  /** What is being done to it: one thing at a time. */
  queue: Promise<unknown>;
}

const quiet: Log = { info() {}, warn() {}, error() {} };

/** What a status's detail may hold, as agent.provider@2 says. */
const DETAIL_MAX = 2000;
/**
 * What a running agent's status says of a plugin it runs without: one sentence, which and why;
 * for one that didn't load, what it said, its first word in lower case unless it is in capitals.
 */
const runsWithout = ({ name, why, said = "" }: Without) => {
  const reason =
    why === "not carried"
      ? "this provider doesn't carry it"
      : why === "needs a service"
        ? "it needs a service none of its plugins provides"
        : said.trim().replace(/^[A-Z](?![A-Z])/, (first) => first.toLowerCase());
  return `It runs without ${name}: ${/[.!?]$/.test(reason) ? reason : `${reason}.`}`;
};
/**
 * All of it, one sentence a line in the order named, as many as fit in a detail; none when it
 * runs with all it was named.
 */
export const withoutOf = (without: Without[]) => {
  let detail = "";
  for (const line of without.map(runsWithout)) {
    const next = detail ? `${detail}\n${line}` : line;
    if (next.length > DETAIL_MAX) return detail || head(line, DETAIL_MAX);
    detail = next;
  }
  return detail || undefined;
};

/** Run the bundled agent provider as an Actor exporting `agent.provider@2` as `provider`. */
export async function startAgentProvider(options: AgentProviderOptions): Promise<AgentProvider> {
  const log = options.log ?? quiet;
  const { hubUrl, dir } = options;
  const offers = options.offers ?? [];
  // Its own, then those it is given.
  const plugins = [
    instructions({ now: () => ASSISTANT_INSTRUCTIONS, earlier: EARLIER_INSTRUCTIONS }),
    skills(),
    offered(),
    control(),
    ...(options.plugins ?? []),
  ];
  const carried = new Set(plugins.map((plugin) => plugin.name));
  for (const { id } of offers)
    if (!carried.has(id)) throw new Error(`It offers ${id}, which it doesn't carry.`);
  /** Every agent's plugins, each agent in a context of its own. */
  const host = createPluginHost(log, plugins);
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
    delete one.without;
    // One whose connection ended joins again: what its plugins held before goes first.
    const earlier = one.plugins;
    delete one.plugins;
    await earlier?.close();
    const { stopped } = stored[agent] as z.infer<typeof Stored>;
    let engine: Held["engine"];
    let plugins: AgentPlugins | undefined;
    const store = createLocalStore(folderOf(agent));
    try {
      // Its context: it holds the plugins its list names once its engine reads it.
      const context = await host.open(agent, { store, provides: ["hub", "model"] });
      plugins = context;
      /**
       * A plugin its settings name that it can't hold, it runs without: its status says which, and
       * why, until a later hold holds it. A change is logged once.
       */
      const held: AgentPlugins = {
        ...context,
        hold: async (named, everything) => {
          const given = await context.hold(named, everything);
          const without = withoutOf(given.without);
          if (one.plugins === context && without !== one.without) {
            if (without) {
              one.without = without;
              log.warn("An agent runs without a plugin it can't hold.", { agent, without });
            } else {
              delete one.without;
              log.info("An agent holds all the plugins its settings name again.", { agent });
            }
          }
          return given;
        },
      };
      // Its channel to the Hub is its connector's, made with the identity kept for it here; its
      // engine starts as the channel opens. What refused it is what the provider is told.
      let channel: Channel | undefined;
      let refused: unknown;
      /** Settles once what every agent has is mounted: no turn of its goes on before. */
      let isMounted = () => {};
      const mounted = new Promise<void>((resolve) => {
        isMounted = resolve;
      });
      const join = (started: (hub: AgentHub) => void) =>
        connect({
          hubUrl,
          actorId: agent,
          credential: (stored[agent] as z.infer<typeof Stored>).credential,
          slots: { model: llmSession },
          exports: { chat, capability, tools },
          log,
          start(ctx) {
            started(ctx);
            engine = startEngine(ctx, {
              store,
              instructions: () => ASSISTANT_INSTRUCTIONS,
              mounted: () => one.mounted,
              self: options.actorId,
              ready: mounted,
              stopped,
              plugins: held,
            });
          },
        }).then(
          (joined) => (channel = joined),
          (error: unknown) => {
            refused = error;
            throw error;
          },
        );
      await context.mount(connector(join)).catch((error: unknown) => {
        throw refused ?? error;
      });
      if (!channel || !engine) throw new Error("Its channel opened with no engine.");
      // Its model, for its capabilities' own questions, with the model chosen for it; and its
      // connections, which offer the model what is exposed to it.
      const running = engine;
      try {
        await context.mount(model(() => running.chosen()));
        await context.mount(connections());
      } finally {
        isMounted();
      }
      one.channel = channel;
      one.engine = engine;
      one.plugins = context;
      one.state = stopped ? "stopped" : "running";
      const open = channel;
      void open.closed.then(() => {
        if (one.channel !== open) return;
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
    exports: { provider: agentProvider, capabilities: capabilityProvider },
    log,
    start(ctx) {
      /**
       * What the agent holds of its root `name` now, as its list last named: one it couldn't mount
       * says why; one its list doesn't name, it doesn't hold.
       */
      const holding = (one: Held, agent: string, name: string) => {
        // Off its channel, it can't say.
        engineOf(agent);
        return one.plugins?.list().find((held) => held.name === name && !held.parent);
      };
      ctx.exports.capabilities.implement({
        capabilities: () => ({ capabilities: offers }),
        // What it mounts it holds inside the agent: it makes no skills for management to copy.
        skill: ({ capability: name }) => {
          throw new Refused("unknown", `${name} makes no skills.`);
        },
        // What it mounts it holds inside the agent, which says how each stands itself.
        status: () => {
          throw new Refused("unimplemented", "The agent says how what it holds stands.");
        },
        mount: ({ agent, capability: name }) =>
          inTurn(agent, async (one) => {
            if (!offers.some((offer) => offer.id === name))
              throw new Refused("unknown", `This provider offers no ${name}.`);
            const held = holding(one, agent, name);
            if (!held)
              throw new Refused(
                "state",
                `What is mounted on it doesn't name ${name}: it is mounted through management, which keeps what is mounted.`,
              );
            if (held.state === "failed")
              return {
                problems: [{ message: head(held.detail ?? `${name} couldn't be mounted.`, 2000) }],
              };
            return { mounted: name };
          }),
        unmount: ({ agent, mounted }) =>
          inTurn(agent, async (one) => {
            const held = holding(one, agent, mounted);
            if (held && held.state !== "failed")
              throw new Refused("state", `What is mounted on it still names ${mounted}.`);
            return {};
          }),
      });
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
          return { agent, chat: "chat" };
        },
        // Kept in memory only, and held: an agent off its channel holds it when it joins again.
        mounted: ({ agent, mounted }) =>
          inTurn(agent, async (one) => {
            one.mounted = mounted;
            if (one.channel && one.engine) await one.engine.hold();
            return {};
          }),
        status: async ({ agent }) => {
          // Why it is down; or, running, what it runs without; and what it holds while it is open.
          const { state, detail, without, plugins } = held(agent);
          const said = state === "down" ? detail : state === "running" ? without : undefined;
          const mounted = plugins
            ?.list()
            .slice(0, HELD_MAX)
            .map(({ detail: why, ...one }) => ({
              ...one,
              ...(why ? { detail: head(why, DETAIL_MAX) } : {}),
            }));
          return { state, ...(said ? { detail: said } : {}), ...(mounted ? { mounted } : {}) };
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
