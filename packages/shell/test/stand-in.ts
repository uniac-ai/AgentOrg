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
  folders as foldersInterface,
  hubBindings,
  skills as skillsInterface,
} from "@agentorg/interfaces";
import { type WebSocket, WebSocketServer } from "ws";
import type { z } from "zod";

const DIST = new URL("../dist/", import.meta.url);
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};
export const SESSION = "stand-in-session";
const PERSON = "person";

type Message = z.output<typeof chatInterface.events.message.payload>;
type Status = z.output<typeof chatInterface.methods.state.output>;
type Creatable = z.output<typeof agentsInterface.methods.creatable.output>["creatables"][number];
type Units = z.output<typeof agentsInterface.methods.units.output>;
type Template = z.output<typeof agentsInterface.methods.templates.output>["templates"][number];
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
  units?: z.output<typeof agentsInterface.methods.get.output>["units"];
  chat: { status: Status; messages: Message[]; current?: string };
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
            status: { state: "tool" },
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
    needs: [],
    gives: { slots: [], skills: [], results: ["computer"] },
    form: [
      {
        id: "where",
        type: "choice",
        value: "string",
        title: "Where it runs",
        required: true,
        options: [
          { value: "local", title: "This computer", description: "It acts as you on this Mac." },
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
        title: "Files and commands",
        required: true,
        options: [
          { value: "none", title: "None", description: "No file tools and no terminal." },
          {
            value: "read",
            title: "Read files",
            description:
              "Reads files in the working directory. Cannot change them or run anything.",
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
        title: "Browser",
        default: false,
        description: "A browser of its own. It can open any site.",
        adds: { slots: [{ name: "browser" }], skills: SKILLS("browser") },
      },
      {
        id: "workspace",
        type: "directory",
        value: "string",
        title: "Working directory",
        required: true,
        description: "The folder it works in. It is never deleted.",
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

const FOLDERS: Record<string, string[]> = {
  "/": ["home"],
  "/home": ["me"],
  "/home/me": ["Agents", "Documents"],
  "/home/me/Agents": ["Foreman"],
  "/home/me/Agents/Foreman": [],
};

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
  const subscribers = new Set<{
    socket: WebSocket;
    sub: number;
    slot: string;
    event: string;
  }>();
  const creatables = options.creatables ?? CREATABLES;
  let problems: StackProblem[] = [];
  let templates = [...TEMPLATES];
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
  const entry = ({ agent, name, status, provider, creatable, purpose }: Agent) => ({
    agent,
    name,
    status,
    provider,
    creatable,
    ...(purpose ? { purpose } : {}),
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
        const { base, units } = input.stack as unknown as {
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
      stop: ({ agent }) => {
        agentOf(agent).status = { state: "stopped" };
        changed();
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

  const chatCall = (agent: Agent, method: string, input: Record<string, unknown>): unknown => {
    const models = [
      { id: "fast", name: "Fast" },
      { id: "deep", name: "Deep" },
    ];
    if (method === "state") return agent.chat.status;
    if (method === "history") {
      const all = agent.chat.messages;
      const end = input.before ? all.findIndex((m) => m.id === input.before) : all.length;
      const limit = Number(input.limit ?? 100);
      return { messages: all.slice(Math.max(0, end - limit), end), more: end > limit };
    }
    if (method === "send") {
      const refused = refusals.get("chat.send");
      if (refused) {
        refusals.delete("chat.send");
        throw refused;
      }
      const message = text(`u${agent.chat.messages.length}`, "user", String(input.text), 0);
      agent.chat.messages.push(message);
      agent.chat.status = { state: "thinking" };
      setTimeout(() => {
        emit(chatSlot(agent.agent), "message", message);
        emit(chatSlot(agent.agent), "status", agent.chat.status);
      }, sendDelayMs);
      return { messageId: message.id };
    }
    if (method === "cancel") {
      agent.chat.status = { state: "idle" };
      emit(chatSlot(agent.agent), "status", agent.chat.status);
      return {};
    }
    if (method === "retry") {
      const refused = refusals.get("chat.retry");
      if (refused) {
        refusals.delete("chat.retry");
        throw refused;
      }
      const at = agent.chat.messages.findLastIndex((m) => m.role === "user");
      agent.chat.messages = agent.chat.messages.slice(0, at + 1);
      agent.chat.status = { state: "thinking" };
      emit(chatSlot(agent.agent), "status", agent.chat.status);
      return { messageId: (agent.chat.messages[at] as Message).id };
    }
    if (method === "models")
      return { models, ...(agent.chat.current ? { current: agent.chat.current } : {}) };
    if (method === "setModel") {
      if (input.model) agent.chat.current = String(input.model);
      else delete agent.chat.current;
      return {};
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
      return spec.output.parse(run(parsed));
    }
    if (slot.startsWith("chat_")) {
      const agent = agentOf(slot.slice(5).replaceAll("_", "-"));
      if (agent.status.state !== "running") {
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
      const output = hubBindings.methods.list.output;
      return output.parse({
        bindings: [...agents.values()].map(({ agent }) => ({
          consumer: PERSON,
          slot: chatSlot(agent),
          provider: agent,
          export: "chat",
          interface: "chat@1",
          madeBy: "management",
          at: at(60),
          exposed: true,
        })),
      });
    }
    if (slot === "login") {
      if (method === "logout") return { revoked: true };
      return { state: "signed_in", account: { email: "sam@example.com", plan: "Plus" } };
    }
    if (slot === "folders") {
      const path = String(input.path ?? "/home/me");
      const under = FOLDERS[path];
      if (!under) throw new Refusal("unknown", "There's no such folder.");
      return foldersInterface.methods.list.output.parse({
        path,
        ...(path === "/" ? {} : { parent: path.split("/").slice(0, -1).join("/") || "/" }),
        folders: under.map((name) => ({ name })),
      });
    }
    if (slot === "store") {
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
  const sockets = new WebSocketServer({ server, path: "/api" });
  sockets.on("connection", (socket) => {
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
    /** A unit's form changes, as when what it depends on appears. */
    changeForm(id: string, change: (field: Units["units"][number]["form"][number]) => void) {
      units = structuredClone(units);
      for (const field of units.find((u) => u.id === id)?.form ?? []) change(field);
    },
    /** What `agents.check` finds wrong from now on. */
    findProblems: (found: StackProblem[]) => {
      problems = found;
    },
    /** The next call of `slot.method` is refused. */
    refuseNext: (name: string, code: string, reason: string) =>
      refusals.set(name, new Refusal(code, reason)),
    /** An agent's chat status, as its event says it and `state` will. */
    setChatStatus(agent: string, status: Status) {
      agentOf(agent).chat.status = chatInterface.events.status.payload.parse(status);
      emit(chatSlot(agent), "status", status);
    },
    /** How long the record takes to say what was sent. */
    delaySends: (ms: number) => {
      sendDelayMs = ms;
    },
    delta: (agent: string, id: string, text: string) =>
      emit(chatSlot(agent), "delta", chatInterface.events.delta.payload.parse({ id, text })),
    addMessage(agent: string, message: Message) {
      const { messages } = agentOf(agent).chat;
      const parsed = chatInterface.events.message.payload.parse(message);
      const known = messages.findIndex((m) => m.id === parsed.id);
      if (known === -1) messages.push(parsed);
      else messages[known] = parsed;
      emit(chatSlot(agent), "message", message);
    },
    changed,
    notes,
    close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise((done) => server.close(done));
    },
  };
}
