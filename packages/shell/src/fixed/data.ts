// What the fixed pages read: management's three slots and each agent's own chat.
import type { agents, chat, connections, hubBindings, skills } from "@agentorg/interfaces";
import { NotConnected, Refused } from "@agentorg/sdk";
import { useEffect, useState } from "react";
import type { z } from "zod";
import { api, useConnection, useLoad } from "../data.ts";
import { within } from "./words.ts";

type Out<M extends { output: z.ZodType }> = z.output<M["output"]>;

export type AgentEntry = Out<typeof agents.methods.list>["agents"][number];
export type AgentDetail = Out<typeof agents.methods.get>;
export type Creatable = Out<typeof agents.methods.creatable>["creatables"][number];
export type Mcp = AgentDetail["mcp"][number];
export type ConnectionEntry = Out<typeof connections.methods.list>["connections"][number];
export type McpProvider = Out<typeof connections.methods.providers>["providers"][number];
export type Skill = Out<typeof skills.methods.list>["skills"][number];
export type ChatMessage = Out<typeof chat.methods.history>["messages"][number];
export type ChatStatus = Out<typeof chat.methods.state>;
export type Conversation = z.output<typeof chat.events.chat.payload>;
type Binding = Out<typeof hubBindings.methods.list>["bindings"][number];

/** How often what has no event is read again: a server going down, say. */
export const REFRESH_MS = 5000;

/** A number that goes up every `ms`, for a read or a rendering to follow. */
export function useEvery(ms: number): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setCount((was) => was + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return count;
}

export const listAgents = () =>
  api.call<{ agents: AgentEntry[] }>("agents", "list").then((reply) => reply.agents);
export const getAgent = (agent: string) => api.call<AgentDetail>("agents", "get", { agent });
export const listSkills = () =>
  api.call<{ skills: Skill[] }>("skills", "list").then((reply) => reply.skills);
export const listMcpProviders = () =>
  api.call<{ providers: McpProvider[] }>("connections", "providers").then((r) => r.providers);
/** Every agent with what it's made of: what says which agents use a skill or a connection. */
export const listDetails = () =>
  listAgents().then((agents) => Promise.all(agents.map((a) => getAgent(a.agent))));
export const listConnections = () =>
  api
    .call<{ connections: ConnectionEntry[] }>("connections", "list")
    .then((reply) => reply.connections);

/** The slot each agent's chat is exposed to the person as, by agent. */
export function useChatSlots(): ReadonlyMap<string, string> {
  return (
    useLoad(
      () =>
        api
          .call<{ bindings: Binding[] }>("bindings", "list", { actor: "person" })
          .then(
            ({ bindings }) =>
              new Map(
                bindings
                  .filter((b) => b.consumer === "person" && b.export === "chat")
                  .map((b) => [b.provider, b.slot]),
              ),
          ),
      ["bindings", "actors"],
    ).value ?? new Map()
  );
}

/** Whether an agent works, in any chat, kept current while it runs. */
export function useWorking(slot: string | undefined, running: boolean): ChatStatus | undefined {
  const connection = useConnection();
  const [status, setStatus] = useState<ChatStatus>();
  useEffect(() => {
    setStatus(undefined);
    if (!slot || !running || connection !== "open") return;
    let live = true;
    // Not up yet, it is read again when its events are made again, or the agent changes.
    const read = () =>
      api.call<ChatStatus>(slot, "state", {}).then(
        (now) => live && setStatus(now),
        () => {},
      );
    void read();
    const stop = api.subscribe(slot, "status", (payload) => setStatus(payload as ChatStatus), {
      again: read,
    });
    return () => {
      live = false;
      stop();
    };
  }, [slot, running, connection]);
  return status;
}

/**
 * The first thing an agent holds that says it is down, kept current: each capability is asked how
 * it stands through the person's own slot to it, and again when it says it changed.
 */
export function useHeldDown(detail: AgentDetail | undefined): DownCapability | undefined {
  const connection = useConnection();
  const [down, setDown] = useState<DownCapability>();
  const held = detail?.capabilities ?? [];
  const key = JSON.stringify(
    held.map((c) => [c.person.capability, c.title, c.surfaces.length, c.slots.length]),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` says when what it holds changed.
  useEffect(() => {
    setDown(undefined);
    if (connection !== "open" || held.length === 0) return;
    let live = true;
    const states = new Map<string, { state: string; detail?: string }>();
    const say = () => {
      const first = held.find((c) => states.get(c.person.capability)?.state === "down");
      setDown(
        first && {
          title: first.title,
          windows: first.surfaces.length > 0,
          tools: first.slots.length > 0,
          detail: states.get(first.person.capability)?.detail,
        },
      );
    };
    /** Each capability's latest read: an answer to an earlier one comes too late to say. */
    const asked = new Map<string, number>();
    const stops = held.map(({ person }) => {
      const read = () => {
        const mine = (asked.get(person.capability) ?? 0) + 1;
        asked.set(person.capability, mine);
        const told = (now: { state: string; detail?: string }) => {
          if (!live || asked.get(person.capability) !== mine) return;
          states.set(person.capability, now);
          say();
        };
        return api.call<{ state: string; detail?: string }>(person.capability, "state", {}).then(
          told,
          // One that can't be reached is down, with nothing to say why; one that refused keeps
          // what it last said.
          (error: unknown) => {
            if (error instanceof NotConnected) told({ state: "down" });
          },
        );
      };
      void read();
      // A change with no view is its state's.
      return api.subscribe(
        person.capability,
        "changed",
        (payload) => {
          if (!(payload as { view?: string }).view) void read();
        },
        { again: read },
      );
    });
    return () => {
      live = false;
      for (const stop of stops) stop();
    };
  }, [key, connection]);
  return down;
}

export type Tone = "working" | "idle" | "starting" | "stopped" | "trouble";

/** An agent's state, in a word. */
export const WORD: Record<Tone, string> = {
  working: "Working",
  trouble: "Has a problem",
  idle: "Idle",
  starting: "Starting",
  stopped: "Stopped",
};

/** How an agent stands: its state, and what to say of it. */
export interface Now {
  tone: Tone;
  text: string;
}

/** Something an agent holds that is down: what it is called, what it gives, and why, if it says. */
export interface DownCapability {
  title: string;
  windows: boolean;
  tools: boolean;
  detail?: string | undefined;
}

/** Why, after what is down and what that leaves out, when it says: set inside the sentence. */
const why = (detail: string | undefined) => (detail ? `: ${within(detail)}` : "");

/** A capability's title inside a sentence: lower case at its start, unless it has capitals after. */
const named = (title: string) =>
  title.slice(1) === title.slice(1).toLowerCase()
    ? title.charAt(0).toLowerCase() + title.slice(1)
    : title;

/**
 * How an agent stands, of itself: what runs it first, then something it holds that is down, then
 * whether it works, then its connections. Each down thing is one sentence: what is down, what that
 * leaves out, and why. What went wrong in one of its chats is that chat's to say.
 */
export function nowOf(
  status: AgentEntry["status"],
  chatStatus: ChatStatus | undefined,
  mcp: readonly Mcp[] = [],
  held?: DownCapability,
): Now {
  if (status.state === "down") return { tone: "trouble", text: status.detail ?? "Down" };
  if (held && status.state === "running") {
    const out = [held.windows && "windows", held.tools && "tools"].filter(Boolean).join(" and ");
    return {
      tone: "trouble",
      text: `Its ${named(held.title)} is down${out ? `, so its ${out} are left out` : ""}${why(held.detail)}`,
    };
  }
  const down = mcp.find((m) => m.status.state === "down");
  const tone: Tone =
    status.state === "starting" || status.state === "stopped"
      ? status.state
      : chatStatus?.state === "working"
        ? "working"
        : down
          ? "trouble"
          : "idle";
  if (tone === "trouble" && down)
    return {
      tone,
      text: `${down.slot} is down, so its tools are left out${why(down.status.detail)}`,
    };
  return { tone, text: WORD[tone] };
}

/**
 * The slot a connection is exposed to an agent as, from its name: models read it as the prefix of
 * its tools. None if the name gives nothing usable, or the agent already has that slot: the Hub
 * then generates one.
 */
export function slotFor(name: string, taken: readonly string[]): string | undefined {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, 48)
    .replace(/_+$/, "");
  return slug && !taken.includes(slug) ? slug : undefined;
}

/** What a failed call says, for one line in place. */
export function reasonOf(error: unknown): string {
  if (error instanceof NotConnected) return "It isn't connected right now. Try again in a moment.";
  if (error instanceof Refused) return error.message;
  return "That didn't work. Try again.";
}

/** What can be created: it says what each agent is for. */
export function useCreatables(): Creatable[] | undefined {
  return useLoad(
    () => api.call<{ creatables: Creatable[] }>("agents", "creatable").then((r) => r.creatables),
    ["actors"],
  ).value;
}

/** A control's call: one at a time, and the reason it failed, if it did. */
export function useAct(onFailed?: (why?: string) => void) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const run = (call: () => Promise<unknown>, done?: () => void) => {
    if (busy) return;
    setBusy(true);
    setFailed(undefined);
    onFailed?.(undefined);
    call().then(
      () => {
        setBusy(false);
        done?.();
      },
      (error: unknown) => {
        setBusy(false);
        setFailed(reasonOf(error));
        onFailed?.(reasonOf(error));
      },
    );
  };
  return { busy, failed, run };
}
