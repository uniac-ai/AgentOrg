import { type ConnectionState, type ToolEntry, tools } from "@agentorg/interfaces";
import { type Log, Refused } from "@agentorg/sdk";
import { connect, type Client as HubClient } from "@agentorg/sdk/client";
import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { z } from "zod";
import type { Secrets, Spec } from "./kinds.js";

type Tool = z.infer<typeof ToolEntry>;
type State = z.infer<typeof ConnectionState>;
type Result = Awaited<ReturnType<Client["callTool"]>>;

/** How often a connection asks its server whether it is there, and how long it waits. */
const PING_EVERY_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;
const FIRST_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
/** A server up this long is well again: the next failure starts over from the first delay. */
const STEADY_MS = 10 * 60_000;
/** What `tools@1` carries: its limits, and room in one frame for a list. */
const NAME_MAX = 128;
const DESCRIPTION_MAX = 16_384;
const STATUS_DESCRIPTION_MAX = 512;
const OUTPUT_MAX = 200_000;
const LIST_ROOM = 900 * 1024;

const cut = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 40)}… [cut: ${text.length} characters]`;
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The tools a server lists, fitted to what `tools@1` can carry; what can't be is logged. */
function fit(listed: Awaited<ReturnType<Client["listTools"]>>["tools"], log: Log): Tool[] {
  const kept: Tool[] = [];
  let room = LIST_ROOM;
  for (const tool of listed) {
    const entry: Tool = {
      name: tool.name,
      ...(tool.description ? { description: cut(tool.description, DESCRIPTION_MAX) } : {}),
      inputSchema: tool.inputSchema as Tool["inputSchema"],
    };
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (tool.name.length < 1 || tool.name.length > NAME_MAX || size > room) {
      log.warn(`Left out the tool ${tool.name.slice(0, NAME_MAX)}: it doesn't fit tools@1.`);
      continue;
    }
    room -= size;
    kept.push(entry);
  }
  return kept;
}

/** A tool's result as text: its text blocks as they are, and what else it held by name. */
function textOf(result: Result): string {
  const parts = (result.content ?? []).map((block) => {
    switch (block.type) {
      case "text":
        return block.text;
      case "resource":
        return "text" in block.resource ? block.resource.text : `[resource ${block.resource.uri}]`;
      case "resource_link":
        return `[resource ${block.uri}]`;
      default:
        return `[${block.type}]`;
    }
  });
  if (parts.length === 0 && result.structuredContent)
    return JSON.stringify(result.structuredContent);
  return parts.join("\n");
}

function transportOf(spec: Spec, secrets: Secrets, log: Log) {
  if (spec.kind === "url") {
    const { token } = secrets;
    return new StreamableHTTPClientTransport(new URL(spec.url), {
      ...(token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}),
    });
  }
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env: { ...getDefaultEnvironment(), ...secrets },
    stderr: "pipe",
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
  });
  // By whole lines, so a secret the server prints can't be split past the log's scrubbing.
  let line = "";
  transport.stderr?.on("data", (chunk) => {
    const parts = (line + String(chunk)).split("\n");
    line = (parts.pop() ?? "").slice(-65_536);
    for (const part of parts) log.warn(part);
  });
  return transport;
}

/**
 * One connection to one MCP server, and its Actor. The Actor stays on the Hub while the server
 * comes and goes: the connection is kept up, tried again after a backoff when it ends, and says
 * `changed` whenever the tools it can offer change, that being up or down too.
 */
export interface Timing {
  pingEveryMs?: number;
  firstDelayMs?: number;
}

export class Connection {
  #state: State = "connecting";
  #detail: string | undefined;
  #tools: Tool[] = [];
  #mcp: Client | undefined;
  #hub: HubClient<Record<never, never>, { tools: typeof tools }> | undefined;
  #ended = false;
  #wake: (() => void) | undefined;
  /** Ends the current session at once, whatever its transport is still waiting for. */
  #lose: (() => void) | undefined;
  #running: Promise<void> | undefined;
  readonly #spec: Spec;
  readonly #hide: ReadonlySet<string>;
  readonly #secrets: Secrets;
  readonly #log: Log;
  readonly #scrub: (text: string) => string;
  readonly #pingEveryMs: number;
  readonly #firstDelayMs: number;

  /** `hide` names tools of the server that are never offered or run through this connection. */
  constructor(
    spec: Spec,
    secrets: Secrets,
    log: Log,
    timing: Timing = {},
    hide: readonly string[] = [],
  ) {
    this.#hide = new Set(hide);
    this.#spec = spec;
    this.#secrets = secrets;
    this.#pingEveryMs = timing.pingEveryMs ?? PING_EVERY_MS;
    this.#firstDelayMs = timing.firstDelayMs ?? FIRST_DELAY_MS;
    // What is secret never leaves in a log, a detail or an error: its values, and an address's query.
    const query = spec.kind === "url" ? new URL(spec.url).search : "";
    // A value that spans lines is also hidden line by line, as a server prints it; longest first.
    const hidden = [
      ...Object.values(secrets).flatMap((value) => [
        value,
        ...value.split(/\r?\n/).filter((line) => line.length > 0),
      ]),
      ...(query.length > 1 ? [query] : []),
    ].sort((a, b) => b.length - a.length);
    this.#scrub = (text) => hidden.reduce((out, value) => out.replaceAll(value, "[hidden]"), text);
    const clean = (message: string) => cut(this.#scrub(message), 4000);
    this.#log = {
      info: (message, fields) => log.info(clean(message), fields),
      warn: (message, fields) => log.warn(clean(message), fields),
      error: (message, fields) => log.error(clean(message), fields),
    };
  }

  /** Join the Hub as the connection's Actor, offering its tools. */
  async join(hub: { hubUrl: string; actorId: string; credential: string }) {
    this.#hub = await connect({
      ...hub,
      exports: { tools },
      log: this.#log,
      start: (ctx) => {
        ctx.exports.tools.implement({
          list: () => {
            this.#requireUp();
            return { tools: this.#tools };
          },
          call: ({ name, arguments: args }) => this.#call(name, args),
        });
      },
    });
  }

  /** Keep the server connected, from now until the connection ends. */
  run() {
    this.#running = this.#keepUp();
  }

  status() {
    return {
      state: this.#state,
      ...(this.#detail ? { detail: this.#detail } : {}),
      tools: this.#tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: cut(tool.description, STATUS_DESCRIPTION_MAX) } : {}),
      })),
    };
  }

  /** End it: the server is let go and the Actor leaves the Hub. */
  async end() {
    this.#ended = true;
    this.#wake?.();
    this.#lose?.();
    await this.#mcp?.close().catch(() => {});
    await this.#running;
    this.#hub?.close();
  }

  #requireUp() {
    if (this.#state !== "connected")
      throw new Refused("not_connected", this.#detail ?? "The server isn't connected yet.");
  }

  async #call(name: string, args: Record<string, unknown>) {
    this.#requireUp();
    if (!this.#tools.some((tool) => tool.name === name))
      throw new Refused("unknown", `This connection has no tool named ${name}.`);
    const mcp = this.#mcp as Client;
    try {
      const result = await mcp.callTool({ name, arguments: args });
      return {
        output: cut(textOf(result), OUTPUT_MAX),
        ...(result.isError ? { failed: true as const } : {}),
      };
    } catch (error) {
      if (this.#gone(error)) {
        this.#lose?.();
        throw new Refused("not_connected", `The server went away during ${name}.`);
      }
      return { output: cut(this.#scrub(messageOf(error)), 2000), failed: true as const };
    }
  }

  /** Whether an error says the server can't be reached, rather than that one request failed. */
  #gone(error: unknown) {
    if (error instanceof TypeError) return true;
    return (
      error instanceof SdkError &&
      (error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.NotConnected)
    );
  }

  #set(state: State, detail?: string) {
    const changed = state !== this.#state && (state === "connected" || this.#state === "connected");
    this.#state = state;
    this.#detail = detail === undefined ? undefined : cut(this.#scrub(detail), 2000);
    if (state !== "connected") this.#tools = [];
    if (changed) this.#changed();
  }

  #changed() {
    this.#hub?.exports.tools.emit("changed", {});
  }

  async #keepUp() {
    let delay = this.#firstDelayMs;
    while (!this.#ended) {
      const began = Date.now();
      const why = await this.#session();
      if (this.#ended) return;
      this.#set("down", why);
      if (Date.now() - began >= STEADY_MS) delay = this.#firstDelayMs;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }

  /** One connection to the server, for as long as it lasts; it resolves with why it ended. */
  async #session(): Promise<string> {
    const log = this.#log;
    const mcp: Client = new Client(
      { name: "agentorg", version: "0" },
      {
        listChanged: {
          tools: {
            autoRefresh: false,
            onChanged: () => {
              this.#refresh(mcp).then(
                () => this.#changed(),
                (error) => log.warn(`Listing the tools again didn't work: ${messageOf(error)}`),
              );
            },
          },
        },
      },
    );
    this.#mcp = mcp;
    let over = false;
    const closed = new Promise<void>((resolve) => {
      const done = () => {
        over = true;
        resolve();
      };
      mcp.onclose = done;
      this.#lose = done;
    });
    let pinging: NodeJS.Timeout | undefined;
    try {
      // A failed start closes before it rejects: what it rejects with is the reason to give.
      for (const step of [
        () => mcp.connect(transportOf(this.#spec, this.#secrets, log)),
        () => this.#refresh(mcp),
      ]) {
        const going = step();
        await Promise.race([going, closed]);
        if (this.#ended) return "";
        if (over) {
          await going;
          return "The connection to the server ended.";
        }
      }
      this.#set("connected");
      // An address's transport says nothing when its server dies: asking is how that's noticed.
      pinging = setInterval(() => {
        mcp.ping({ timeout: PING_TIMEOUT_MS }).catch((error) => {
          if (!(error instanceof ProtocolError)) this.#lose?.();
        });
      }, this.#pingEveryMs);
      await closed;
      return "The connection to the server ended.";
    } catch (error) {
      return messageOf(error);
    } finally {
      clearInterval(pinging);
      this.#mcp = undefined;
      this.#lose = undefined;
      await mcp.close().catch(() => {});
    }
  }

  async #refresh(mcp: Client) {
    const { tools: listed } = await mcp.listTools();
    this.#tools = fit(
      listed.filter((tool) => !this.#hide.has(tool.name)),
      this.#log,
    );
  }
}
