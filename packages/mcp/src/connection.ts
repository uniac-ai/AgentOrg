import {
  type ConnectionState,
  PICTURE_MAX,
  PICTURES_MAX,
  Picture,
  type ToolEntry,
  tools,
} from "@agentorg/interfaces";
import { type Log, Refused } from "@agentorg/sdk";
import { connect, type Client as HubClient } from "@agentorg/sdk/client";
import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import type { Secrets, Spec } from "./kinds.js";
import { publicFetch } from "./public.js";

type Tool = z.infer<typeof ToolEntry>;
/** A server's own names for a call's group, in its `_meta`, and for the request that stops one. */
export interface Groups {
  meta: string;
  stop: string;
}
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
/** What a server that can't be reached is said to be, in place of the transport's words. */
const UNREACHED = "The server can't be reached.";
/** What a fetch that failed for its server not being reached gives as its cause's code. */
const NOT_REACHED = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "ECONNABORTED",
  "EADDRNOTAVAIL",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * What an error says. A server's HTTP answer whose body is JSON with a `message`, such as
 * `{"code":409,"message":"It has stopped."}`, says that message alone. A fetch that failed says
 * plainly that the server can't be reached when that is why, and its cause's own words when it
 * was reached but something else failed, such as a certificate it doesn't trust.
 */
const messageOf = (error: unknown) => {
  if (error instanceof TypeError && error.message === "fetch failed") {
    const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
    if (!cause || NOT_REACHED.has(String(cause.code))) return UNREACHED;
    if (typeof cause.message === "string" && cause.message.trim() !== "") return cause.message;
    return UNREACHED;
  }
  if (error instanceof SdkHttpError && typeof error.data.text === "string") {
    try {
      const { message } = JSON.parse(error.data.text) as { message?: unknown };
      if (typeof message === "string" && message.trim() !== "") return message;
    } catch {
      // Not JSON: the transport's own words, with the body as it came.
    }
  }
  return error instanceof Error ? error.message : String(error);
};

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

/** A result stays under this many bytes of JSON, a little below the frame that carries it. */
const RESULT_BUDGET = 1_000_000;
/**
 * A result's pictures of kinds a model reads, as many as a message carries and as fit `room`
 * together, within one picture's cap; each one left out, said in a line.
 */
function picturesOf(result: Result, room: number) {
  const images: z.infer<typeof Picture>[] = [];
  const leftOut: string[] = [];
  let left = Math.min(room, PICTURE_MAX);
  for (const block of result.content ?? []) {
    if (block.type !== "image" || block.data === "") continue;
    const mediaType = Picture.shape.mediaType.safeParse(block.mimeType);
    if (!mediaType.success)
      leftOut.push(
        `(A picture, left out: ${block.mimeType.slice(0, 64)} isn't one a model reads.)`,
      );
    else if (images.length === PICTURES_MAX) leftOut.push("(A picture, left out: too many.)");
    else if (block.data.length > left) leftOut.push("(A picture, left out: too large.)");
    else {
      left -= block.data.length;
      images.push({ mediaType: mediaType.data, data: block.data });
    }
  }
  return { images, leftOut };
}

/** A tool's result as text: its text blocks as they are, and what else it held by name. */
function textOf(result: Result): string {
  const parts = (result.content ?? [])
    // Its pictures go apart.
    .filter((block) => block.type !== "image")
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "resource":
          return "text" in block.resource
            ? block.resource.text
            : `[resource ${block.resource.uri}]`;
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
      // Checked at each request, so a name that later points home is refused then.
      ...(spec.public ? { fetch: publicFetch } : {}),
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
  /** Whether the server answered the last try in its own words, as a refusal does. */
  #answered = false;
  /** Asked to try again now: the waits after start over. */
  #again = false;
  /** Ends the current session at once, whatever its transport is still waiting for. */
  #lose: (() => void) | undefined;
  #running: Promise<void> | undefined;
  readonly #spec: Spec;
  readonly #hide: ReadonlySet<string>;
  readonly #groups: Groups | undefined;
  readonly #where: (() => string | undefined) | undefined;
  readonly #secrets: Secrets;
  readonly #log: Log;
  readonly #scrub: (text: string) => string;
  readonly #pingEveryMs: number;
  readonly #firstDelayMs: number;

  /**
   * `hide` names tools of the server that are never offered or run through this connection.
   * `groups` is how its server puts what a call starts in a caller's group and stops a group, an
   * extension of the server's own, named by whoever makes the connection: with none, a call's
   * group is not passed on and a stop ends nothing.
   */
  constructor(
    spec: Spec,
    secrets: Secrets,
    log: Log,
    timing: Timing = {},
    hide: readonly string[] = [],
    groups?: Groups,
    /** For a url: where its server is now, looked at again at each try, for one that moves. */
    where?: () => string | undefined,
  ) {
    this.#hide = new Set(hide);
    this.#groups = groups;
    this.#where = where;
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
          call: ({ name, arguments: args, group }) => this.#call(name, args, group),
          stop: ({ group }) => this.#stop(group),
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

  /**
   * Try again now, as when its server is known to be back: if it is down and waiting to, at once,
   * waiting the first wait again after a try that fails; if it is connected, by asking its server
   * now, as its next ping would, and trying again at once if it has gone.
   */
  retry() {
    if (this.#state === "connected") {
      const mcp = this.#mcp;
      mcp?.ping({ timeout: PING_TIMEOUT_MS }).catch((error) => {
        if (error instanceof ProtocolError || this.#mcp !== mcp) return;
        this.#again = true;
        this.#lose?.();
      });
      return;
    }
    if (this.#state !== "down") return;
    this.#again = true;
    this.#wake?.();
  }

  /** Whether it is down for its server not answering, or its connection ending, not a refusal. */
  get unreached() {
    return this.#state === "down" && !this.#answered;
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

  async #call(name: string, args: Record<string, unknown>, group?: string) {
    this.#requireUp();
    if (!this.#tools.some((tool) => tool.name === name))
      throw new Refused("unknown", `This connection has no tool named ${name}.`);
    const mcp = this.#mcp as Client;
    const meta = group && this.#groups ? { _meta: { [this.#groups.meta]: group } } : {};
    try {
      const result = await mcp.callTool({ name, arguments: args, ...meta });
      const text = textOf(result);
      // Its pictures have what its words leave of the frame; the lines for those left out go
      // first, so no cut takes them.
      const words = Buffer.byteLength(JSON.stringify(cut(text, OUTPUT_MAX)));
      const { images, leftOut } = picturesOf(result, RESULT_BUDGET - words);
      return {
        output: cut([...leftOut, text].filter((line) => line !== "").join("\n"), OUTPUT_MAX),
        ...(result.isError ? { failed: true as const } : {}),
        ...(images.length > 0 ? { images } : {}),
      };
    } catch (error) {
      if (this.#gone(error)) {
        this.#lose?.();
        throw new Refused("not_connected", `The server went away during ${name}.`);
      }
      return { output: cut(this.#scrub(messageOf(error)), 2000), failed: true as const };
    }
  }

  /**
   * Ask the server to end what calls made under `group` left running. While the server is away
   * it can't be asked, and what it runs is left running.
   */
  async #stop(group: string) {
    if (!this.#groups) return {};
    if (this.#state !== "connected") {
      this.#log.warn("A group's stop wasn't sent: the server isn't connected.");
      return {};
    }
    try {
      await (this.#mcp as Client).request(
        { method: this.#groups.stop, params: { group } },
        z.object({}),
      );
    } catch (error) {
      // A server that has no such request keeps nothing in a group.
      if (error instanceof ProtocolError && error.code === ProtocolErrorCode.MethodNotFound)
        return {};
      this.#log.warn(`A group's stop wasn't taken: ${this.#scrub(messageOf(error))}`);
    }
    return {};
  }

  /**
   * Whether an error says the server can't be reached, rather than that one request failed. A
   * server that keeps sessions and forgot the one held, as when it started again, is one too: MCP
   * has the client start a new one. It says so with any 404, or, with no session begun yet, in the
   * MCP SDK's words, that it isn't initialized.
   */
  #gone(error: unknown) {
    if (error instanceof TypeError) return true;
    if (
      error instanceof SdkHttpError &&
      (error.status === 404 ||
        (error.status === 400 && String(error.data.text).includes("Server not initialized")))
    )
      return true;
    return (
      error instanceof SdkError &&
      (error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.NotConnected)
    );
  }

  #set(state: State, detail?: string) {
    const before = this.#state;
    this.#state = state;
    this.#detail = detail === undefined ? undefined : cut(this.#scrub(detail), 2000);
    if (state !== "connected") this.#tools = [];
    if (state !== before && (state === "connected" || before === "connected")) this.#changed();
    if (state !== before) this.#onState?.();
  }

  #onState: (() => void) | undefined;
  /**
   * Tell `listener` each time its state changes: connected, connecting or down. One listener:
   * setting it again replaces it.
   */
  onState(listener: () => void) {
    this.#onState = listener;
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
      // Told to try again while it was trying: no wait.
      if (!this.#again)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          this.#wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      this.#wake = undefined;
      delay = this.#again ? this.#firstDelayMs : Math.min(delay * 2, MAX_DELAY_MS);
      this.#again = false;
    }
  }

  /** One connection to the server, for as long as it lasts; it resolves with why it ended. */
  async #session(): Promise<string> {
    const log = this.#log;
    // With nowhere it is now, nothing is tried: its token goes to no other address.
    const spec = this.#now();
    if (!spec) {
      this.#answered = false;
      return "Its server isn't anywhere it can be reached now.";
    }
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
    // Whether the server refused it, in its own words: kept once the try is over, so a try under
    // way doesn't change what the last one said.
    let answered = false;
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
        () => mcp.connect(transportOf(spec, this.#secrets, log)),
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
      answered = error instanceof SdkHttpError;
      return messageOf(error);
    } finally {
      this.#answered = answered;
      clearInterval(pinging);
      this.#mcp = undefined;
      this.#lose = undefined;
      await mcp.close().catch(() => {});
    }
  }

  /** What it connects to now: a url where its server is now, or nothing if it is nowhere now. */
  #now(): Spec | undefined {
    const spec = this.#spec;
    if (spec.kind !== "url" || !this.#where) return spec;
    const url = this.#where();
    return url ? { ...spec, url } : undefined;
  }

  async #refresh(mcp: Client) {
    const { tools: listed } = await mcp.listTools();
    this.#tools = fit(
      listed.filter((tool) => !this.#hide.has(tool.name)),
      this.#log,
    );
  }
}
