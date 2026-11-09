/**
 * The bundled agent provider: it offers one creatable, Assistant, and runs each agent in this
 * process as its own Actor on its own channel. Stopping an agent closes its channel; starting it
 * opens one. Each agent's record and model choice are kept in the provider's private folder.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { agentProvider, agentSettings, chat, hubActors, llmSession } from "@agentorg/interfaces";
import { type Log, Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { z } from "zod";
import { startEngine } from "./engine.js";
import { createLocalStore } from "./local-store.js";

const ASSISTANT_INSTRUCTIONS = `You are an assistant in AgentOrg, working for the person who created you.
You act only through your tools, and your tools are exactly the connections the person gave you. If something needs a connection you don't have, say which.
Before you promise to do something, check that one of your tools does it. A connection you are given later shows up as new tools at your next turn; until then, don't say you can use it.
Keep replies short and plain.`;

const ASSISTANT = {
  id: "assistant",
  title: "Assistant",
  description: "An agent that chats, and acts through the connections you give it.",
  instructions: ASSISTANT_INSTRUCTIONS,
  asks: [],
  skills: [],
  mcp: [],
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
  log?: Log;
}

export interface AgentProvider {
  /** Leave the Hub and stop every agent. They stay, and those not stopped resume at the next start. */
  close(): Promise<void>;
}

/** An agent as it stands in this process. */
interface Held {
  state: "starting" | "running" | "stopped" | "down";
  detail?: string;
  channel?: { close(): void; readonly closed: Promise<void> };
  engine?: ReturnType<typeof startEngine>;
  /** What is being done to it: one thing at a time. */
  queue: Promise<unknown>;
}

const quiet: Log = { info() {}, warn() {}, error() {} };

/** Run the bundled agent provider as an Actor exporting `agent.provider@1` as `provider`. */
export async function startAgentProvider(options: AgentProviderOptions): Promise<AgentProvider> {
  const log = options.log ?? quiet;
  const { hubUrl, dir } = options;
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
  const inTurn = <T>(agent: string, work: (one: Held) => Promise<T>) => {
    const one = held(agent);
    const done = one.queue.then(() => work(one));
    one.queue = done.catch(() => {});
    return done;
  };

  /** Join the Hub as the agent, with its engine running. */
  const open = async (agent: string, one: Held) => {
    one.state = "starting";
    delete one.detail;
    let engine: Held["engine"];
    try {
      const channel = await connect({
        hubUrl,
        actorId: agent,
        credential: (stored[agent] as z.infer<typeof Stored>).credential,
        slots: { model: llmSession, settings: agentSettings },
        exports: { chat },
        log,
        start(ctx) {
          engine = startEngine(ctx, {
            store: createLocalStore(folderOf(agent)),
            instructions: () => ASSISTANT_INSTRUCTIONS,
            ownTools: () => [],
          });
        },
      });
      one.channel = channel;
      one.engine = engine;
      one.state = "running";
      void channel.closed.then(() => {
        if (one.channel !== channel) return;
        delete one.channel;
        one.state = "down";
        one.detail = "Its connection to the Hub ended.";
      });
    } catch (error) {
      one.state = "down";
      one.detail = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };
  /** Cut its turn, close its channel, and wait until its engine has written all it will. */
  const halt = async (one: Held) => {
    const { channel, engine } = one;
    delete one.channel;
    if (!channel || !engine) return;
    await engine.cancel();
    channel.close();
    await channel.closed;
    await engine.settled();
  };

  await Promise.all(
    Object.entries(stored).map(async ([agent, { stopped }]) => {
      const one: Held = { state: "stopped", queue: Promise.resolve() };
      agents.set(agent, one);
      if (stopped) return;
      try {
        await open(agent, one);
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
        skill: async ({ creatable, name, path: file }) => {
          throw new Refused("unknown", `${creatable} has no file ${file} of a skill ${name}.`);
        },
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
            await open(agent, one);
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
            await open(agent, one);
            return {};
          }),
        stop: ({ agent }) =>
          inTurn(agent, async (one) => {
            (stored[agent] as z.infer<typeof Stored>).stopped = true;
            save();
            await halt(one);
            one.state = "stopped";
            delete one.detail;
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
