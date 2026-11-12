// A stand-in for the gateway: it serves the built shell and speaks its `/api`, with management and
// each agent's chat scripted. Every call and event is checked against the real interfaces, so the
// pages can't drift from the contracts.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname } from "node:path";
import {
  agents as agentsInterface,
  chat as chatInterface,
  connections as connectionsInterface,
  hubBindings,
  skills as skillsInterface,
} from "@agentorg/interfaces";
import { type WebSocket, WebSocketServer } from "ws";
import type { z } from "zod";

const DIST = new URL("../dist/", import.meta.url);
/** A page's picture, 80 by 50, as `screencast@1` sends it. */
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAyAFADASIAAhEBAxEB/8QAGAABAQEBAQAAAAAAAAAAAAAAAAUHAwb/xAAmEAEAAAQEBgMBAAAAAAAAAAAAAQIEEQMFFlQGEjVBo9FhgrJx/8QAGQEBAQADAQAAAAAAAAAAAAAAAAIBAwQF/8QAJREAAgEDAAsBAAAAAAAAAAAAAAECAxETBBIUFVFSYWKRoeEx/9oADAMBAAIRAxEAPwDRgEmQAAAAAAAAAAn1WdZdSVE2BUVHJiSWvLyTRteF+0PlUYSk7RVzDkl+soCVqPKN345/RqPKN345/S8FXlfgnJDiiqJWo8o3fjn9Go8o3fjn9GCryvwMkOKKo40tTg1dPLj08/Phz3tNaML2jbv/AB2ammnZlp3AAA8BxP1+p+n4g9+N+j18Mta1zXVp5Fa5lY1Qdu8u338OfZOplY1QN5dvv4Nk6krhjoFN9/3FVB5tSWvJy4nXFaqSACTIAAAAAAAAAAAH/9k=",
  "base64",
);
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};
export const SESSION = "stand-in-session";
const PERSON = "person";

type Message = z.output<typeof chatInterface.methods.history.output>["messages"][number];
type Status = z.output<typeof chatInterface.methods.state.output>;
type ChatEntry = z.output<typeof chatInterface.events.chat.payload>;
type Problem = NonNullable<ChatEntry["problem"]>;
type ChatEvent = keyof typeof chatInterface.events;
export type Creatable = z.output<
  typeof agentsInterface.methods.creatable.output
>["creatables"][number];
export type Units = z.output<typeof agentsInterface.methods.units.output>;
export type Template = z.output<
  typeof agentsInterface.methods.templates.output
>["templates"][number];
type StackProblem = z.output<typeof agentsInterface.methods.check.output>["problems"][number];
type AgentStatus = z.output<typeof agentsInterface.methods.list.output>["agents"][number]["status"];
type Connection = {
  connection: string;
  name: string;
  origin?: z.output<typeof agentsInterface.methods.get.output>["mcp"][number]["origin"];
  status: z.output<typeof agentsInterface.methods.get.output>["mcp"][number]["status"];
};
export interface Agent {
  agent: string;
  name: string;
  status: AgentStatus;
  provider: string;
  creatable: string;
  skills: { name: string; description: string; instance?: string }[];
  mcp: { slot: string; connection: string; instance?: string }[];
  purpose?: string;
  /** The template it started from. */
  template?: string;
  units?: z.output<typeof agentsInterface.methods.get.output>["units"];
  /** The model chosen for it; none is its provider's default. */
  model?: string;
  /**
   * The chat a test speaks in through `addMessage`, with the agent's status: whether it works. It
   * has an `id` once something has been said in it; an agent with nothing said has no chat. Its
   * `problem` is why its last message got no answer, until its next reply. A message sent with
   * no chat named starts a new one here, and this one joins the others.
   */
  chat: {
    status: Status;
    messages: Message[];
    problem?: Problem;
    id?: string;
    /** What it was renamed to; until then its first message's first line. */
    title?: string;
    archived?: boolean;
  };
  /**
   * Its other chats: listed, read, sent in, renamed and archived like the one above. Each is what
   * a list says of it and what was said in it.
   */
  others?: { entry: ChatEntry; messages: Message[] }[];
}

const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const text = (id: string, role: "user" | "assistant", body: string, ago: number): Message => ({
  id,
  role,
  text: body,
  at: at(ago),
});
const tool = (id: string, name: string, state: "running" | "done", ago: number): Message => ({
  id,
  role: "tool",
  text: name,
  at: at(ago),
  tool: { name, state },
});

const GITHUB = [{ name: "search_issues" }, { name: "get_issue", description: "Reads one issue" }];
const ORIGIN = { provider: "local", madeBy: PERSON, at: at(600) };

function seed() {
  const connections = new Map<string, Connection>(
    [
      {
        connection: "c-github",
        name: "GitHub acme",
        origin: { ...ORIGIN, kind: "url", target: "https://api.githubcopilot.com/mcp" },
        status: { state: "connected" as const, tools: GITHUB },
      },
      {
        connection: "c-linear",
        name: "Linear",
        origin: { ...ORIGIN, kind: "url", target: "https://mcp.linear.app/mcp" },
        status: {
          state: "down" as const,
          detail: "The server didn't answer.",
          tools: [],
        },
      },
      {
        connection: "c-notes",
        name: "Notes for Research",
        origin: {
          ...ORIGIN,
          kind: "command",
          target: "notes-server ~/notes",
          madeBy: "management",
          madeFor: "a-research",
        },
        status: { state: "connected" as const, tools: [{ name: "read_note" }] },
      },
      {
        connection: "c-postgres",
        name: "Postgres analytics",
        origin: { ...ORIGIN, kind: "command", target: "postgres-mcp localhost:5432" },
        status: { state: "connected" as const, tools: [{ name: "query" }] },
      },
    ].map((c) => [c.connection, c]),
  );
  const base = { provider: "bundled", creatable: "assistant" };
  const running: AgentStatus = { state: "running" };
  const agents = new Map<string, Agent>(
    (
      [
        {
          ...base,
          agent: "a-research",
          name: "Research",
          status: running,
          skills: [{ name: "cite-sources", description: "Links every claim to its source" }],
          mcp: [
            { slot: "notes", connection: "c-notes" },
            { slot: "github", connection: "c-github" },
          ],
          chat: {
            status: { state: "working" },
            messages: [
              text("m1", "user", "Why are checkouts failing?", 8),
              tool("m2", "github__search_issues", "running", 6),
            ],
          },
        },
        {
          ...base,
          agent: "a-reviewer",
          name: "Reviewer",
          status: running,
          skills: [],
          mcp: [{ slot: "github", connection: "c-github" }],
          chat: {
            status: { state: "idle" },
            messages: [text("m3", "assistant", "**Reviewed** #482 with 3 comments\nMore", 12)],
          },
        },
        {
          ...base,
          agent: "a-triage",
          name: "Triage",
          status: running,
          skills: [],
          mcp: [{ slot: "linear", connection: "c-linear" }],
          chat: { status: { state: "idle" }, messages: [] },
        },
        {
          ...base,
          agent: "a-weekly",
          name: "Weekly report",
          status: { state: "stopped" },
          skills: [],
          mcp: [],
          chat: { status: { state: "idle" }, messages: [] },
        },
        {
          ...base,
          agent: "a-broken",
          name: "Broken",
          status: { state: "down", detail: "Its program exited." },
          skills: [],
          mcp: [],
          chat: { status: { state: "idle" }, messages: [] },
        },
      ] satisfies Agent[]
    ).map((a) => [a.agent, a]),
  );
  return { connections, agents };
}

const CREATABLES: Creatable[] = [
  {
    provider: "bundled",
    id: "assistant",
    title: "Assistant",
    description: "Chats and uses what you connect",
    instructions: "Help.",
    asks: [],
  },
  {
    provider: "bundled",
    id: "reviewer",
    title: "Code reviewer",
    description: "Reviews pull requests",
    instructions: "Review.",
    asks: [
      { id: "repo", title: "Repository", description: "Owner and name" },
      { id: "note", title: "Note", optional: true },
    ],
  },
];

const IDENTITY = { provider: "units", providerName: "AgentOrg" };
const SKILLS = (...names: string[]) => names.map((name) => ({ name, files: ["SKILL.md"] }));
const UNITS: Units["units"] = [
  {
    ...IDENTITY,
    id: "computer",
    title: "Computer",
    description: "Terminal, files and a browser",
    // A stack holds it once, as the service's own does.
    once: true,
    needs: [],
    gives: { slots: [], skills: [], results: ["computer"] },
    form: [
      {
        id: "where",
        type: "choice",
        value: "string",
        title: "Where it resides",
        description: "Where its computer runs.",
        required: true,
        options: [
          {
            value: "local",
            title: "This computer",
            description: "It acts as you on this Mac.",
            caution: true,
          },
          {
            value: "container",
            title: "Its own container",
            description: "Isolated from your files.",
          },
        ],
      },
      {
        id: "access",
        type: "choice",
        value: "string",
        title: "What it reaches",
        required: true,
        options: [
          {
            value: "none",
            title: "No files or terminal",
            description: "No file tools and no terminal.",
          },
          {
            value: "read",
            title: "Read-only files",
            description:
              "Reads files in the workspace directory. Cannot change them or run anything.",
            adds: { slots: [{ name: "computer" }], skills: SKILLS("files", "computer") },
          },
          {
            value: "terminal",
            title: "Files and terminal",
            description: "Runs any command, so it reaches every file and program you can.",
            adds: {
              slots: [{ name: "computer" }],
              skills: SKILLS("terminal", "files", "computer"),
            },
          },
        ],
      },
      {
        id: "browser",
        type: "toggle",
        value: "boolean",
        title: "With a browser",
        default: false,
        description: "A browser of its own. It can open any site.",
        adds: { slots: [{ name: "browser" }], skills: SKILLS("browser") },
      },
      {
        id: "workspace",
        type: "directory",
        value: "string",
        title: "Workspace directory",
        required: true,
        description: "The folder it works in. It is never deleted.",
        placeholder: "~/Agents/{name}",
        visible: { field: "where", in: ["local"] },
      },
      {
        id: "inside",
        type: "text",
        value: "string",
        title: "Path in the container",
        visible: { field: "where", in: ["container"] },
      },
      {
        id: "image",
        type: "text",
        value: "string",
        title: "Image",
        default: "agentorg/computer",
        visible: { field: "where", in: ["container"] },
      },
    ],
  },
  {
    ...IDENTITY,
    id: "web",
    title: "Web",
    description: "Search and fetch",
    needs: [],
    gives: { slots: [{ name: "web" }], skills: SKILLS("web-research"), results: [] },
    form: [
      {
        id: "service",
        type: "choice",
        value: "string",
        title: "Search service",
        default: "exa",
        options: [
          { value: "exa", title: "Exa", description: "No key needed." },
          { value: "tavily", title: "Tavily", description: "Needs your key." },
        ],
      },
      {
        id: "key",
        type: "secret",
        value: "secret",
        title: "Key",
        required: true,
        visible: { field: "service", in: ["tavily"] },
      },
    ],
  },
  {
    ...IDENTITY,
    id: "control",
    title: "Agent control",
    description: "Lets it make agents",
    needs: ["computer"],
    gives: { slots: [{ name: "agents" }], skills: [], results: [] },
    form: [
      {
        id: "limit",
        type: "number",
        value: "number",
        title: "Agents alive",
        min: 1,
        max: 20,
        default: 3,
        unit: "at once",
      },
      {
        id: "places",
        type: "choices",
        value: "strings",
        title: "Where they work",
        options: [
          { value: "own", title: "Its own computer" },
          { value: "new", title: "A new computer" },
        ],
      },
      {
        id: "shared",
        type: "connection",
        value: "string",
        title: "Place",
        visible: { field: "places", in: ["new"] },
      },
      { id: "colour", type: "colour-wheel", value: "string", title: "Colour" },
      { id: "ceiling", type: "dial", value: "number", title: "Ceiling" },
    ],
  },
];
const TEMPLATES: Template[] = [
  {
    id: "assistant",
    shipped: true,
    title: "Assistant",
    description: "Does what you ask on a computer",
    base: { provider: "AgentOrg", creatable: "assistant" },
    units: [
      { provider: "AgentOrg", unit: "computer", values: { access: "terminal", browser: true } },
      { provider: "AgentOrg", unit: "web" },
    ],
  },
  {
    id: "old",
    title: "From elsewhere",
    description: "Made on another home",
    base: { provider: "AgentOrg", creatable: "assistant" },
    units: [{ provider: "Gone", unit: "mystery" }],
  },
];

/** The models every agent here can use. */
const MODELS = [
  { id: "fast", name: "Fast" },
  { id: "deep", name: "Deep" },
];
interface Spec {
  input: z.ZodType;
  output: z.ZodType;
}
interface Interface {
  methods: Record<string, Spec>;
}
class Refusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Call {
  slot: string;
  method: string;
  input: Record<string, unknown>;
}

export async function standIn(options: { creatables?: Creatable[] } = {}) {
  let sendDelayMs = 0;
  const { agents, connections } = seed();
  const skills = [
    { name: "cite-sources", description: "Links every claim to its source" },
    { name: "weekly-numbers", description: "Writes the weekly summary" },
  ];
  const calls: Call[] = [];
  const notes = new Map<string, unknown>();
  const refusals = new Map<string, Refusal>();
  /** Calls refused every time, by `slot.method`, until a test answers them again. */
  const refusing = new Map<string, Refusal>();
  /** Calls that wait to be answered, by `slot.method`, until a test lets them go. */
  const holds = new Map<string, Promise<void>>();
  const subscribers = new Set<{
    socket: WebSocket;
    sub: number;
    slot: string;
    event: string;
  }>();
  let creatables = options.creatables ?? CREATABLES;
  /**
   * The model account: how it stands, and whether its own process has connected. Signed in,
   * unless a test says otherwise; with none, there is nothing to sign in to.
   */
  let account: { state: "signed_out" | "signed_in" | "ineligible"; started: boolean } | undefined =
    { state: "signed_in", started: true };
  let problems: StackProblem[] = [];
  let templates = [...TEMPLATES];
  /** What the live surfaces have heard and said. */
  const live = {
    opened: [] as { agent: string; instance: string; surface: string; mode: string }[],
    /** `terminal@1`: every event so far, its sockets, and what they sent. */
    terminal: {
      events: [] as Record<string, unknown>[],
      sockets: new Set<WebSocket>(),
      input: [] as Record<string, unknown>[],
      /** As many are running as may. */
      full: false,
    },
    /** `metrics@1`: the sockets watching, and the latest reading, which one that opens later gets at once. */
    load: { sockets: new Set<WebSocket>(), reading: undefined as string | undefined },
    /** `files@1`: the workspace's files by path, and every request made of it. */
    files: {
      held: new Map<string, { bytes: Buffer; modifiedAt: string }>(),
      asked: [] as Record<string, unknown>[],
      sockets: new Set<WebSocket>(),
      /** The workspace's own name, said with every folder's entries: none from an older service. */
      workspace: "Research" as string | undefined,
      /** What a walk for what changed comes to: its answer, none yet, or a refusal. */
      walks: "answered" as "answered" | "held" | "refused",
      /** The walks held, each to be answered when it is let go. */
      waiting: [] as (() => void)[],
      /** Whether a part of a file is given when it is asked for, or held until it is let go. */
      reads: "answered" as "answered" | "held",
      /** What a file brought in comes to: put there, or refused with these words. */
      writes: undefined as string | undefined,
      /** The parts held. */
      parts: [] as (() => void)[],
    },
    /** Browser sockets, each with the tab it is shown, and what the operating ones sent. */
    screens: new Map<WebSocket, { shown: number | null; chose: boolean }>(),
    input: [] as Record<string, unknown>[],
    /** The browser's tabs, shared by everyone. */
    tabs: [{ id: 1, url: "https://shop.example/checkout", title: "Checkout" }],
  };
  let units = UNITS;

  const emit = (slot: string, event: string, payload: unknown) => {
    for (const s of subscribers)
      if (s.slot === slot && s.event === event)
        s.socket.send(JSON.stringify({ sub: s.sub, payload }));
  };
  const changed = () => emit("actors", "changed", {});
  const agentOf = (id: unknown): Agent => {
    const agent = agents.get(String(id));
    if (!agent) throw new Refusal("unknown", "No such agent.");
    return agent;
  };
  const entry = ({ agent, name, status, provider, creatable, purpose, template }: Agent) => ({
    agent,
    name,
    status,
    provider,
    creatable,
    ...(purpose ? { purpose } : {}),
    ...(template ? { template } : {}),
  });
  const chatSlot = (agent: string) => `chat_${agent.replaceAll("-", "_")}`;

  type Input = Record<string, never> & Record<string, unknown>;
  const management: Record<string, Record<string, (input: Input) => unknown>> = {
    agents: {
      creatable: () => ({ creatables }),
      providers: () => ({ providers: [{ provider: "bundled", name: "AgentOrg" }] }),
      list: () => ({ agents: [...agents.values()].map(entry) }),
      get: ({ agent: id }) => {
        const agent = agentOf(id);
        return {
          ...entry(agent),
          instructions: "Help.",
          skills: agent.skills,
          mcp: agent.mcp.map(({ slot, connection, instance }) => {
            const found = connections.get(connection) as Connection;
            return {
              slot,
              connection,
              origin: found.origin,
              status: found.status,
              ...(instance ? { instance } : {}),
            };
          }),
          units: agent.units ?? [],
        };
      },
      units: () => ({
        bases: creatables.map((c) => ({ ...c, providerName: "AgentOrg" })),
        units,
      }),
      templates: () => ({ templates }),
      saveTemplate: (input) => {
        templates.push(input as unknown as Template);
        return {};
      },
      removeTemplate: ({ id }) => {
        templates = templates.filter((t) => t.id !== id);
        return {};
      },
      check: () => ({ problems }),
      create: (input) => {
        const made = `a-${agents.size + 1}`;
        const { base, units, template } = input.stack as unknown as {
          template?: string;
          base: { provider: string; creatable: string };
          units: { provider: string; unit: string; values: Record<string, string | boolean> }[];
        };
        agents.set(made, {
          agent: made,
          name: String(input.name),
          status: { state: "starting" },
          provider: base.provider,
          creatable: base.creatable,
          skills:
            units.length > 0
              ? [{ name: "files", description: "Works with files", instance: "i-0" }]
              : [],
          mcp:
            units.length > 0 ? [{ slot: "computer", connection: "c-notes", instance: "i-0" }] : [],
          ...(input.purpose ? { purpose: String(input.purpose) } : {}),
          ...(template ? { template } : {}),
          units: units.map((u, i) => ({
            instance: `i-${i}`,
            provider: u.provider,
            unit: u.unit,
            title: UNITS.find((c) => c.id === u.unit)?.title ?? u.unit,
            values: u.values,
            needs: {},
            status: { state: "connected" as const },
          })),
          chat: { status: { state: "idle" }, messages: [] },
        });
        changed();
        return { agent: made };
      },
      start: ({ agent }) => {
        agentOf(agent).status = { state: "running" };
        changed();
        return {};
      },
      // Stopping the agent ends whatever it was doing.
      stop: ({ agent }) => {
        const stopped = agentOf(agent);
        stopped.status = { state: "stopped" };
        if (stopped.chat.status.state === "working") {
          stopped.chat.status = { state: "idle" };
          say(stopped, "status", stopped.chat.status);
        }
        changed();
        return {};
      },
      models: ({ agent }) => {
        const { model } = agentOf(agent);
        return { models: MODELS, ...(model ? { current: model } : {}) };
      },
      setModel: ({ agent, model }) => {
        if (model) agentOf(agent).model = model;
        else delete agentOf(agent).model;
        return {};
      },
      expose: (input) => {
        const agent = agentOf(input.agent);
        if ("skill" in input) {
          agent.skills.push(skills.find((s) => s.name === input.skill) as (typeof skills)[number]);
          return {};
        }
        const slot = input.as ? String(input.as) : "generated_tools";
        agent.mcp.push({ slot, connection: String(input.connection) });
        return { slot };
      },
      unexpose: (input) => {
        const agent = agentOf(input.agent);
        if ("skill" in input) agent.skills = agent.skills.filter((s) => s.name !== input.skill);
        else agent.mcp = agent.mcp.filter((m) => m.slot !== input.slot);
        return {};
      },
      remove: ({ agent }) => {
        agents.delete(String(agent));
        changed();
        return {};
      },
    },
    connections: {
      providers: () => ({
        providers: [
          {
            provider: "local",
            name: "Local",
            // The two kinds' schemas as the built-in provider describes them.
            kinds: [
              {
                kind: "url",
                title: "A server at an address",
                params: {
                  type: "object",
                  properties: { url: { type: "string", format: "uri", title: "Address" } },
                  required: ["url"],
                  additionalProperties: false,
                },
                secrets: {
                  type: "object",
                  properties: { token: { type: "string" } },
                  additionalProperties: false,
                },
              },
              {
                kind: "command",
                title: "A local server this machine starts",
                params: {
                  type: "object",
                  properties: {
                    command: { type: "string" },
                    args: { type: "array", items: { type: "string" } },
                    cwd: { type: "string" },
                  },
                  required: ["command"],
                  additionalProperties: false,
                },
                secrets: {
                  type: "object",
                  propertyNames: { type: "string" },
                  additionalProperties: { type: "string" },
                },
              },
            ],
          },
        ],
      }),
      remove: ({ connection }) => {
        connections.delete(String(connection));
        for (const agent of agents.values())
          agent.mcp = agent.mcp.filter((m) => m.connection !== connection);
        changed();
        return {};
      },
      get: ({ connection }) => {
        const found = connections.get(String(connection));
        if (!found) throw new Refusal("unknown", "No such connection.");
        return {
          connection: found.connection,
          name: found.name,
          origin: found.origin,
          status: found.status,
        };
      },
      create: (input) => {
        const connection = `c-new-${connections.size}`;
        const params = input.params as unknown as Record<string, unknown>;
        connections.set(connection, {
          connection,
          name: String(input.name),
          origin: {
            provider: String(input.provider),
            kind: String(input.kind),
            target: String(params.url ?? params.command),
            madeBy: PERSON,
            at: at(0),
          },
          status: { state: "connected", tools: [{ name: "search" }, { name: "fetch" }] },
        });
        changed();
        return { connection };
      },
      list: () => ({
        connections: [...connections.values()].map(({ connection, name, origin, status }) => ({
          connection,
          name,
          state: status.state,
          origin,
        })),
      }),
    },
    skills: {
      list: () => ({ skills }),
      remove: ({ name }) => {
        skills.splice(
          skills.findIndex((s) => s.name === name),
          1,
        );
        for (const agent of agents.values())
          agent.skills = agent.skills.filter((s) => s.name !== name);
        return {};
      },
      add: ({ path }) => {
        const name = String(path).split("/").at(-1) as string;
        const added = { name, description: "Writes a changelog" };
        skills.push(added);
        return added;
      },
    },
  };
  const INTERFACES: Record<string, Interface> = {
    agents: agentsInterface as unknown as Interface,
    connections: connectionsInterface as unknown as Interface,
    skills: skillsInterface as unknown as Interface,
  };

  let chatsStarted = 0;
  /** How many messages were sent, so each has its own id. */
  let sent = 0;
  /** The id of an agent's chat, if anything has been said in it. A seeded record is a chat. */
  const chatId = (agent: Agent): string | undefined => {
    if (!agent.chat.id && agent.chat.messages.length > 0) agent.chat.id = `c-${agent.agent}`;
    return agent.chat.id;
  };
  /** The id of its chat, started now if it had none. */
  const startedChat = (agent: Agent): string => {
    agent.chat.id = chatId(agent) ?? `c-${agent.agent}-${++chatsStarted}`;
    return agent.chat.id;
  };
  const entryOf = (agent: Agent): ChatEntry => {
    const { messages, problem } = agent.chat;
    const first = messages.find((m) => m.role === "user");
    const latest = messages.findLast((m) => m.role === "assistant");
    return {
      id: startedChat(agent),
      title: agent.chat.title ?? first?.text.split("\n")[0]?.slice(0, 200) ?? "",
      at: messages[0]?.at ?? at(0),
      ...(latest ? { latest: { id: latest.id, at: latest.at } } : {}),
      ...(problem ? { problem } : {}),
      archived: !!agent.chat.archived,
    };
  };
  /**
   * One of the chat's events, as the real interface has it: a message and its text name their
   * chat, and the status is the agent's. A test may say a message of an agent nothing was sent
   * to; that starts its chat here, where a real agent's chat starts only with a `send`.
   */
  const say = (agent: Agent, event: ChatEvent, payload: object = {}) =>
    emit(
      chatSlot(agent.agent),
      event,
      chatInterface.events[event].payload.parse(
        event === "chat"
          ? entryOf(agent)
          : event === "status"
            ? payload
            : { ...payload, chat: startedChat(agent) },
      ),
    );

  const chatCall = (agent: Agent, method: string, input: Record<string, unknown>): unknown => {
    const refused = refusals.get(`chat.${method}`);
    if (refused) {
      refusals.delete(`chat.${method}`);
      throw refused;
    }
    // The status is the agent's: it names no chat.
    if (method === "state") return agent.chat.status;
    if (method === "list") {
      // The chat the stand-in plays in full comes first whatever was said elsewhere. The others
      // follow, newest first by their last message, a page at a time.
      const lastOf = (one: { entry: ChatEntry; messages: Message[] }) =>
        Date.parse(one.messages.findLast((m) => m.role !== "tool")?.at ?? one.entry.at);
      const own =
        chatId(agent) && !!agent.chat.archived === !!input.archived ? [entryOf(agent)] : [];
      const others = (agent.others ?? [])
        .filter((other) => other.entry.archived === !!input.archived)
        .sort((a, b) => lastOf(b) - lastOf(a))
        .map((other) => other.entry);
      const all = [...own, ...others];
      const from = input.before ? all.findIndex((entry) => entry.id === input.before) + 1 : 0;
      const end = from + Number(input.limit ?? 50);
      return { chats: all.slice(from, end), more: all.length > end };
    }
    // Every other call is on a chat. `send` alone may name none, and then starts one.
    const other = agent.others?.find((one) => one.entry.id === input.chat);
    const named = method !== "send" || input.chat !== undefined;
    if (named && !other && input.chat !== chatId(agent))
      throw new Refusal("unknown", "The agent has no such chat.");
    if (method === "history") {
      const all = other ? other.messages : agent.chat.messages;
      const end = input.before ? all.findIndex((m) => m.id === input.before) : all.length;
      const limit = Number(input.limit ?? 100);
      return { messages: all.slice(Math.max(0, end - limit), end), more: end > limit };
    }
    if (method === "rename" || method === "archive") {
      const change =
        method === "rename"
          ? { title: String(input.title).split("\n")[0] as string }
          : { archived: !!input.archived };
      if (other) other.entry = { ...other.entry, ...change };
      else Object.assign(agent.chat, change);
      emit(chatSlot(agent.agent), "chat", other ? other.entry : entryOf(agent));
      return {};
    }
    if (method === "send") {
      // With no chat named, it is a new chat. The one played in full until now is kept among the
      // others, and the new one's id is made here.
      if (input.chat === undefined) {
        if (chatId(agent))
          agent.others = [
            ...(agent.others ?? []),
            { entry: entryOf(agent), messages: agent.chat.messages },
          ];
        agent.chat = {
          status: agent.chat.status,
          messages: [],
          id: `c-${agent.agent}-${++chatsStarted}`,
        };
      }
      const record = other ? other.messages : agent.chat.messages;
      const message = text(`u${record.length}-${++sent}`, "user", String(input.text), 0);
      record.push(message);
      // The status is said when it changes: an agent already at work says nothing more.
      const idle = agent.chat.status.state === "idle";
      agent.chat.status = { state: "working" };
      const chat = other ? other.entry.id : startedChat(agent);
      const said = () => {
        if (other) {
          emit(chatSlot(agent.agent), "chat", other.entry);
          emit(
            chatSlot(agent.agent),
            "message",
            chatInterface.events.message.payload.parse({ ...message, chat }),
          );
        } else {
          say(agent, "chat");
          say(agent, "message", message);
        }
        if (idle) say(agent, "status", agent.chat.status);
      };
      // A real agent says these before it answers the call. A test may hold them back.
      if (sendDelayMs === 0) said();
      else setTimeout(said, sendDelayMs);
      return { chat, messageId: message.id };
    }
    throw new Refusal("invalid", `chat has no method ${method} here.`);
  };

  const person = (slot: string, method: string, input: Record<string, unknown>): unknown => {
    if (management[slot]) {
      const iface = INTERFACES[slot] as Interface;
      const spec = iface.methods[method] as Spec;
      const parsed = spec.input.parse(input) as Input;
      const run = management[slot]?.[method];
      if (!run) throw new Refusal("invalid", `${slot}.${method} isn't scripted.`);
      const refused = refusals.get(`${slot}.${method}`);
      if (refused) {
        refusals.delete(`${slot}.${method}`);
        throw refused;
      }
      const always = refusing.get(`${slot}.${method}`);
      if (always) throw always;
      return spec.output.parse(run(parsed));
    }
    if (slot.startsWith("chat_")) {
      const agent = agentOf(slot.slice(5).replaceAll("_", "-"));
      // A stopped agent stays connected: its chats are listed and read, and it takes no turn.
      if (agent.status.state === "stopped") {
        if (method === "send") throw new Refusal("busy", "It is stopped. Start it to go on.");
      } else if (agent.status.state !== "running") {
        const error = new Refusal("not_connected", "Not running.");
        error.name = "NotConnected";
        throw error;
      }
      const spec = (chatInterface as unknown as Interface).methods[method] as Spec;
      return spec.output.parse(
        chatCall(agent, method, spec.input.parse(input) as Record<string, unknown>),
      );
    }
    if (slot === "bindings") {
      const bound = (slot: string, provider: string, exported: string, iface: string) => ({
        consumer: PERSON,
        slot,
        provider,
        export: exported,
        interface: iface,
        madeBy: "management",
        at: at(60),
        exposed: true,
      });
      return hubBindings.methods.list.output.parse({
        bindings: [
          // The model account, where there is one to sign in to.
          ...(account ? [bound("login", "p-chatgpt", "login", "account.login@1")] : []),
          ...[...agents.values()].map(({ agent }) =>
            bound(chatSlot(agent), agent, "chat", "chat@1"),
          ),
        ],
      });
    }
    if (slot === "login") {
      const refused = refusals.get(`login.${method}`);
      if (refused) {
        refusals.delete(`login.${method}`);
        throw refused;
      }
      // Unbound, or its process not connected, it can't be asked anything.
      if (!account?.started) {
        const error = new Refusal("not_connected", "Not running.");
        error.name = "NotConnected";
        throw error;
      }
      if (method === "logout") return { revoked: true };
      if (method === "start") return { authorizeUrl: "https://auth.example/authorize" };
      return account.state === "signed_in"
        ? { state: "signed_in", account: { email: "sam@example.com", plan: "Plus" } }
        : { state: account.state };
    }
    // The model account's own process, which the person's `login` slot is bound to.
    if (slot === "actors") return { connected: account?.started ?? true };
    if (slot === "store") {
      // A refusal of the store is of one key: `store.get.<key>`.
      const refused = refusals.get(`store.${method}.${String(input.key)}`);
      if (refused) {
        refusals.delete(`store.${method}.${String(input.key)}`);
        throw refused;
      }
      if (method === "get")
        return notes.has(String(input.key)) ? { value: notes.get(String(input.key)) } : {};
      notes.set(String(input.key), input.value);
      return {};
    }
    throw new Refusal("invalid", `The stand-in has no ${slot}.${method}.`);
  };

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    try {
      const file = path === "/" ? "index.html" : path.slice(1);
      const body = readFileSync(new URL(file, DIST));
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "text/plain" });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  const sockets = new WebSocketServer({ noServer: true });
  const lives = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "/", "http://stand-in");
    const to = pathname === "/api" ? sockets : pathname === "/live" ? lives : undefined;
    if (!to) return socket.destroy();
    to.handleUpgrade(request, socket, head, (ws) => to.emit("connection", ws, request));
  });
  lives.on("connection", (socket: WebSocket, request: { url?: string }) => {
    const query = new URL(request.url ?? "/", "http://stand-in").searchParams;
    const target = {
      agent: query.get("agent") ?? "",
      instance: query.get("instance") ?? "",
      surface: query.get("surface") ?? "",
      mode: query.get("mode") ?? "",
    };
    socket.once("message", (data) => {
      const hello = JSON.parse(String(data)) as { op?: string; session?: string };
      if (hello.op !== "hello" || hello.session !== SESSION)
        return socket.close(4401, "Sign in again");
      const unit = agents.get(target.agent)?.units?.find((u) => u.instance === target.instance);
      const surface = unit?.status.surfaces?.find((one) => one.surface === target.surface);
      if (!surface) return socket.close(4404, "No such surface.");
      live.opened.push(target);
      socket.send(JSON.stringify({ op: "live", protocol: surface.protocol }));
      if (surface.protocol === "screencast@1") screencast(socket, target.mode);
      if (surface.protocol === "terminal@1") terminalSocket(socket, target.mode);
      if (surface.protocol === "files@1") filesSocket(socket);
      if (surface.protocol === "metrics@1") {
        live.load.sockets.add(socket);
        socket.on("close", () => live.load.sockets.delete(socket));
        if (live.load.reading) socket.send(live.load.reading);
      }
    });
  });
  /** A `files@1` socket: each request answered by its id, a file's bytes right after their answer. */
  const filesSocket = (socket: WebSocket) => {
    const { held, asked, sockets } = live.files;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    /** The write whose bytes are the next binary message, and the parts of the file so far. */
    let writing: { id: string; path: string; length: number; last: boolean } | undefined;
    let parts: Buffer[] = [];
    socket.on("message", (data: Buffer, binary: boolean) => {
      if (binary) {
        // A write's bytes are exactly as many as it said, right after it.
        if (!writing || data.length !== writing.length) return socket.close(1003, "No write.");
        const { id, path, last } = writing;
        writing = undefined;
        parts.push(data);
        if (!last) return;
        if (live.files.writes)
          return socket.send(JSON.stringify({ type: "refused", id, message: live.files.writes }));
        const bytes = Buffer.concat(parts);
        held.set(path, { bytes, modifiedAt: new Date().toISOString() });
        return socket.send(JSON.stringify({ type: "written", id, path, size: bytes.length }));
      }
      if (writing) return socket.close(1003, "A write's bytes follow it.");
      const request = JSON.parse(String(data)) as Record<string, unknown> & { id: string };
      asked.push(request);
      const send = (answer: Record<string, unknown>) =>
        socket.send(JSON.stringify({ id: request.id, ...answer }));
      const path = String(request.path ?? "");
      if (request.type === "list") {
        const within = path ? `${path}/` : "";
        const entries = new Map<string, Record<string, unknown>>();
        for (const [at, file] of held) {
          if (!at.startsWith(within)) continue;
          const [name, ...deeper] = at.slice(within.length).split("/") as [string, ...string[]];
          entries.set(
            name,
            deeper.length > 0
              ? { name, kind: "folder", size: 0, modifiedAt: file.modifiedAt }
              : { name, kind: "file", size: file.bytes.length, modifiedAt: file.modifiedAt },
          );
        }
        const kinds = ["folder", "file"];
        return send({
          type: "entries",
          path: path || ".",
          ...(live.files.workspace === undefined ? {} : { workspace: live.files.workspace }),
          entries: [...entries.values()].sort(
            (a, b) =>
              kinds.indexOf(String(a.kind)) - kinds.indexOf(String(b.kind)) ||
              String(a.name).localeCompare(String(b.name)),
          ),
          more: false,
        });
      }
      if (request.type === "changed") {
        const since = Date.parse(String(request.since));
        if (Number.isNaN(since)) return send({ type: "refused", message: "That isn't a time." });
        if (live.files.walks === "refused")
          return send({ type: "refused", message: "The walk took too long." });
        // What changed is what it is when the walk ends.
        const answer = () => {
          const changes = [...held]
            .filter(([, file]) => Date.parse(file.modifiedAt) > since)
            .map(([at, file]) => ({
              path: at,
              size: file.bytes.length,
              modifiedAt: file.modifiedAt,
            }))
            .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
          if (socket.readyState === socket.OPEN)
            send({ type: "changes", since: request.since, changes, more: false });
        };
        return live.files.walks === "held" ? void live.files.waiting.push(answer) : answer();
      }
      if (request.type === "read") {
        const file = held.get(path);
        if (!file) return send({ type: "refused", message: `There's no file at ${path}.` });
        const offset = Number(request.offset);
        const bytes = file.bytes.subarray(offset, offset + Number(request.length));
        const answer = () => {
          if (socket.readyState !== socket.OPEN) return;
          send({
            type: "data",
            path,
            offset,
            length: bytes.length,
            size: file.bytes.length,
            modifiedAt: file.modifiedAt,
          });
          socket.send(bytes);
        };
        return live.files.reads === "held" ? void live.files.parts.push(answer) : answer();
      }
      if (request.type === "write") {
        if (request.offset === 0) parts = [];
        writing = {
          id: request.id,
          path,
          length: Number(request.length),
          last: request.last === true,
        };
      }
    });
  };
  /** A `terminal@1` event, to every socket and to those that come later. */
  const terminal = (event: Record<string, unknown>) => {
    live.terminal.events.push(event);
    for (const ws of live.terminal.sockets) ws.send(JSON.stringify(event));
  };
  const terminalSocket = (socket: WebSocket, mode: string) => {
    const { events } = live.terminal;
    for (const event of events) socket.send(JSON.stringify(event));
    live.terminal.sockets.add(socket);
    socket.on("close", () => live.terminal.sockets.delete(socket));
    socket.on("message", (data) => {
      const input = JSON.parse(String(data)) as Record<string, unknown>;
      live.terminal.input.push(input);
      // Watchers' input is dropped, as the service drops it.
      if (mode !== "operate") return;
      const at = new Date().toISOString();
      const refuse = (message: string) => socket.send(JSON.stringify({ type: "refused", message }));
      if (input.type === "open") {
        if (live.terminal.full)
          return refuse("64 terminals are running, which is the most at once.");
        const id = `p${events.filter((e) => e.type === "start").length + 1}`;
        terminal({ type: "start", id, by: "person", cmd: "zsh", workdir: "/work", tty: true, at });
        return terminal({ type: "output", id, text: "work $ " });
      }
      const started = events.find((e) => e.type === "start" && e.id === input.id);
      if (!started) return refuse("That terminal isn't there.");
      if (events.some((e) => e.type === "exit" && e.id === input.id))
        return refuse("That terminal has ended.");
      if (input.type === "resize" && !started.tty) return refuse("A command has no size.");
      // A shell echoes what's typed; a command, on pipes, doesn't.
      if (input.type === "input" && started.tty)
        terminal({
          type: "output",
          id: input.id,
          text: String(input.text).replaceAll("\r", "\r\nwork $ "),
        });
    });
  };
  /** The tabs, to one browser socket or to all, each told which one it is shown. */
  const tabs = (only?: WebSocket) => {
    for (const [ws, viewer] of live.screens)
      if (!only || ws === only)
        ws.send(JSON.stringify({ type: "tabs", tabs: live.tabs, shown: viewer.shown }));
  };
  /** The newest tab's id: one is never given twice. */
  let lastTab = 1;
  /** A tab opens: sockets that haven't picked one are shown it, as the service follows the work. */
  const tabOpened = (tab: (typeof live.tabs)[number], by?: WebSocket) => {
    live.tabs.push(tab);
    lastTab = Math.max(lastTab, tab.id);
    // Shown to whoever opened it, and to those who picked none or are shown none.
    for (const [ws, viewer] of live.screens)
      if (ws === by || !viewer.chose || viewer.shown === null) {
        viewer.shown = tab.id;
        ws.send(JPEG);
      }
    tabs();
  };
  const screencast = (socket: WebSocket, mode: string) => {
    const viewer = { shown: live.tabs.at(-1)?.id ?? null, chose: false };
    live.screens.set(socket, viewer);
    tabs(socket);
    socket.send(JSON.stringify({ type: "viewport", width: 800, height: 500 }));
    socket.send(JPEG);
    socket.on("message", (data) => {
      // Watchers' input is dropped, as the service drops it.
      if (mode !== "operate") return;
      const input = JSON.parse(String(data)) as Record<string, unknown>;
      live.input.push(input);
      if (input.type !== "tab") return;
      // Showing or opening a tab makes the socket's page its own from then on.
      if (input.action === "open") {
        viewer.chose = true;
        const url = typeof input.url === "string" ? input.url : "about:blank";
        return tabOpened({ id: lastTab + 1, url, title: "" }, socket);
      }
      if (!live.tabs.some((t) => t.id === input.id)) return;
      if (input.action === "close") {
        // A closed tab's sockets are shown the newest that is left, or none.
        live.tabs = live.tabs.filter((t) => t.id !== input.id);
        for (const [ws, other] of live.screens)
          if (other.shown === input.id) {
            other.shown = live.tabs.at(-1)?.id ?? null;
            // The page now shown comes with its picture.
            if (other.shown !== null) ws.send(JPEG);
          }
        return tabs();
      }
      if (input.action !== "show") return;
      viewer.chose = true;
      viewer.shown = Number(input.id);
      tabs();
    });
    socket.on("close", () => live.screens.delete(socket));
  };
  /** While on, a page's connection is closed as it comes, as when the gateway is away. */
  let away = false;
  sockets.on("connection", (socket) => {
    if (away) return socket.close(1013, "Away");
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.op === "hello") return socket.send(JSON.stringify({ op: "hello" }));
      if (message.op === "subscribe") {
        subscribers.add({ socket, sub: message.sub, slot: message.slot, event: message.event });
        return;
      }
      if (message.op === "unsubscribe") {
        for (const s of subscribers)
          if (s.socket === socket && s.sub === message.sub) subscribers.delete(s);
        return;
      }
      if (message.op !== "call") return;
      const input = (message.input ?? {}) as Record<string, unknown>;
      calls.push({ slot: message.slot, method: message.method, input });
      const answer = () => {
        try {
          const result = person(message.slot, message.method, input);
          socket.send(JSON.stringify({ id: message.id, result }));
        } catch (error) {
          const refusal = error as Refusal;
          socket.send(
            JSON.stringify({
              id: message.id,
              error: {
                name: refusal.name,
                code: refusal.code ?? "failed",
                message: refusal.message,
              },
            }),
          );
        }
      };
      const slot = message.slot.startsWith("chat_") ? "chat" : message.slot;
      const held = holds.get(`${slot}.${message.method}`);
      if (held) void held.then(answer);
      else answer();
    });
    socket.on("close", () => {
      for (const s of subscribers) if (s.socket === socket) subscribers.delete(s);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    agents,
    connections,
    calls,
    /** What an agent can be built from comes to be this: its bases, units and templates. */
    setCatalog(next: { bases: Creatable[]; units: Units["units"]; templates: Template[] }) {
      creatables = next.bases;
      units = next.units;
      templates = [...next.templates];
    },
    /** Nothing is listed: no templates, no skills, no connections. */
    emptyLists() {
      templates = [];
      skills.splice(0);
      connections.clear();
    },
    /** A unit's form changes, as when what it depends on appears. */
    changeForm(id: string, change: (field: Units["units"][number]["form"][number]) => void) {
      units = structuredClone(units);
      for (const field of units.find((u) => u.id === id)?.form ?? []) change(field);
    },
    live,
    terminal,
    /** A `screencast@1` event, to every browser socket. */
    screen(event: Record<string, unknown>) {
      for (const [ws] of live.screens) ws.send(JSON.stringify(event));
    },
    /** The model account comes to stand this way, as its events say it. */
    setAccount(state: "signed_out" | "signed_in" | "ineligible" | "none", started = true) {
      const was = account?.state;
      account = state === "none" ? undefined : { state, started };
      // Its event says only that where it stands changed.
      if (was !== account?.state) emit("login", "changed", {});
      changed();
    },
    /** Every tab's AgentOrg sign-in ends, as when its session is revoked. */
    endSessions() {
      for (const socket of sockets.clients) socket.close(4401, "Sign in again");
    },
    /** The gateway goes away, and every page's connection with it, until it is back. */
    goAway(gone = true) {
      away = gone;
      if (gone) for (const socket of sockets.clients) socket.close(1013, "Away");
    },
    /** The walks held are answered, and those to come are too. */
    endWalks() {
      live.files.walks = "answered";
      for (const answer of live.files.waiting.splice(0)) answer();
    },
    /** The parts of files held are given, and those to come are too. */
    endReads() {
      live.files.reads = "answered";
      for (const answer of live.files.parts.splice(0)) answer();
    },
    /** A file in the workspace, last changed so many minutes ago. */
    putFile(path: string, content: string | Buffer, minutesAgo = 0) {
      live.files.held.set(path, {
        bytes: Buffer.from(content),
        modifiedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      });
    },
    /** A `metrics@1` reading, to every socket watching and to those that come later. */
    reading(reading: Record<string, unknown>) {
      live.load.reading = JSON.stringify({ type: "reading", scope: "machine", ...reading });
      for (const ws of live.load.sockets) ws.send(live.load.reading);
    },
    /** The agent opens a tab. */
    tabOpens: (tab: (typeof live.tabs)[number]) => tabOpened(tab),
    /** What `agents.check` finds wrong from now on. */
    findProblems: (found: StackProblem[]) => {
      problems = found;
    },
    /** Calls of `slot.method` aren't answered until what this returns is called. */
    hold(name: string): () => void {
      let release = () => {};
      holds.set(name, new Promise<void>((done) => (release = done)));
      return () => {
        holds.delete(name);
        release();
      };
    },
    /** The next call of `slot.method` is refused. */
    refuseNext: (name: string, code: string, reason: string) =>
      refusals.set(name, new Refusal(code, reason)),
    /** Every call of `slot.method` is refused, as by a service that is down, until answered again. */
    refuseEvery: (name: string, code: string, reason: string) =>
      refusing.set(name, new Refusal(code, reason)),
    answerAgain: (name: string) => refusing.delete(name),
    /** No agent has a chat. */
    noChats() {
      for (const agent of agents.values()) {
        agent.chat = { status: agent.chat.status, messages: [] };
        agent.others = [];
      }
    },
    /** Whether an agent works, as its event says it and `state` will. */
    setChatStatus(agent: string, status: Status) {
      agentOf(agent).chat.status = chatInterface.methods.state.output.parse(status);
      say(agentOf(agent), "status", status);
    },
    /**
     * An agent's chat got no answer, as the service says it: its entry with the problem, then the
     * agent idle. Its next reply ends the problem.
     */
    failChat(agent: string, problem: Problem) {
      const failed = agentOf(agent);
      failed.chat.problem = problem;
      say(failed, "chat");
      if (failed.chat.status.state === "idle") return;
      failed.chat.status = { state: "idle" };
      say(failed, "status", failed.chat.status);
    },
    /** How long the record takes to say what was sent. */
    delaySends: (ms: number) => {
      sendDelayMs = ms;
    },
    delta: (agent: string, id: string, text: string) => say(agentOf(agent), "delta", { id, text }),
    /** Another chat of the agent's, as its list will say it; told to whoever is listening. */
    addChat(
      agent: string,
      chat: { id: string; title: string; said: Message[]; archived?: boolean; problem?: Problem },
    ) {
      const latest = chat.said.findLast((m) => m.role === "assistant");
      const entry = chatInterface.events.chat.payload.parse({
        id: chat.id,
        title: chat.title,
        at: chat.said[0]?.at ?? at(0),
        ...(latest ? { latest: { id: latest.id, at: latest.at } } : {}),
        ...(chat.problem ? { problem: chat.problem } : {}),
        archived: !!chat.archived,
      });
      const held = agentOf(agent);
      held.others = [...(held.others ?? []), { entry, messages: chat.said }];
      emit(chatSlot(agent), "chat", entry);
    },
    /**
     * A message in another chat of the agent's, as the service says it: what a person or the agent
     * said tells the chat's entry first, with a reply as its latest; then the message.
     */
    sayIn(agent: string, chat: string, message: Message) {
      const other = agentOf(agent).others?.find((one) => one.entry.id === chat);
      if (!other) throw new Error(`${agent} has no chat ${chat}`);
      other.messages.push(message);
      if (message.role === "assistant")
        other.entry = { ...other.entry, latest: { id: message.id, at: message.at } };
      if (message.role !== "tool") emit(chatSlot(agent), "chat", other.entry);
      emit(
        chatSlot(agent),
        "message",
        chatInterface.events.message.payload.parse({ ...message, chat }),
      );
    },
    addMessage(agent: string, message: Message) {
      const { messages } = agentOf(agent).chat;
      const known = messages.findIndex((m) => m.id === message.id);
      if (known === -1) messages.push(message);
      else messages[known] = message;
      if (message.role === "assistant") delete agentOf(agent).chat.problem;
      // What a person or the agent said tells the chat's entry too, as the service does.
      if (message.role !== "tool") say(agentOf(agent), "chat");
      say(agentOf(agent), "message", message);
    },
    /** A message in another chat of the agent's: one this stand-in doesn't keep, and no view shows. */
    addElsewhere: (agent: string, message: Message) =>
      emit(
        chatSlot(agent),
        "message",
        chatInterface.events.message.payload.parse({ ...message, chat: "c-elsewhere" }),
      ),
    /** The agent's chat as the stand-in has it: which, and what was said in it. */
    chatOf: (agent: string) => ({
      id: chatId(agentOf(agent)),
      messages: agentOf(agent).chat.messages.map((m) => m.text),
    }),
    changed,
    notes,
    close: async () => {
      for (const ws of lives.clients) ws.terminate();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise((done) => server.close(done));
    },
  };
}
