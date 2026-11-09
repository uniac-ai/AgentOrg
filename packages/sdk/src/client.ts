import {
  type Body,
  encodeFrame,
  eventBody,
  FrameError,
  FrameReader,
  type Header,
  HeaderError,
  input,
  parseBody,
  parseHeader,
  result,
  Session,
  type WebSocketLike,
  type WireError,
  webSocketChannel,
  wireError,
  type YamuxStream,
} from "@agentorg/wire";
import { errorBodyOf, errorFromBody, NotConnected, OutcomeUnknown, Refused } from "./errors.js";
import { type DescribedInterface, describeInterface, type Interface } from "./interface.js";
import {
  type Context,
  type Duplex,
  defineActor,
  type ExportMap,
  type InterfaceMap,
  type Log,
} from "./module.js";
import { ModuleHost } from "./module-host.js";
import { createRuntime } from "./runtime.js";

/** A stream the Hub opens toward this Actor's exports, naming the export and who is calling. */
export type Serve = Extract<Header, { op: "serve" }>;

/** How this Actor answers the Hub's `serve` streams. Each throws a refusal to refuse. */
export interface ServeHandlers {
  call(serve: Serve, input: unknown): Promise<unknown>;
  /** Start sending an export's events; `end` stops them from this side. Returns how to stop. */
  subscribe(
    serve: Serve,
    send: (payload: unknown) => void,
    end: (error?: unknown) => void,
  ): () => void;
  /** Check that the export takes the stream (throwing a refusal if not), then return what runs it. */
  accept(serve: Serve): (stream: Duplex) => Promise<void>;
  /** The same for an `http` export: the stream carries HTTP/1.1 once accepted. */
  serveHttp(serve: Serve): (stream: Duplex) => Promise<void>;
}

export interface ChannelOptions {
  /** The Hub's WebSocket address. */
  hubUrl: string;
  credential: string;
  actorId: string;
  /**
   * Whether this channel may replace one the Actor already has (the default). With `false`, a
   * live channel makes the hello refused, code `connected`.
   */
  replace?: boolean;
  /** The Actor's slots and static exports. Without it, the Actor keeps what it declared before. */
  declares?: {
    slots: Record<string, DescribedInterface>;
    exports: Record<string, DescribedInterface>;
  };
  /** How to serve the Hub's streams; without it, they are refused. */
  serve?: ServeHandlers;
  /**
   * Each slot notice after hello's snapshot, in order: `bound` false when unbound, true when bound
   * or, for a slot already bound, when its provider came back.
   */
  onSlot?(name: string, bound: boolean): void;
  /**
   * Each notice for a slot made at run time, in the same order: its exposure when bound (or
   * usable again), `undefined` when it is gone. These don't reach `onSlot`.
   */
  onExposed?(name: string, exposure: ChannelExposure | undefined): void;
  /** Where a notice handler's own failure is reported. */
  log?: Log;
}

/** A slot made at run time, as the channel keeps it: the export's interface, and whose it is. */
export interface ChannelExposure {
  interface: DescribedInterface;
  provider: { actor: string; export: string };
}

/** A channel to the Hub as one Actor, at the wire's level: no local checks, no handles. */
export interface Channel {
  readonly actorId: string;
  /** The Actor's slots bound now, from hello's snapshot and the Hub's notices; empty once closed. */
  readonly bound: ReadonlySet<string>;
  /**
   * The slots made for it at run time and bound now, from the notices: hello names them among
   * `bound`, and a notice with each one's exposure follows.
   */
  readonly exposed: ReadonlyMap<string, ChannelExposure>;
  call(slot: string, method: string, value: unknown): Promise<unknown>;
  /** Events from a slot's provider until it ends (`onEnd`) or is stopped; returns how to stop. */
  subscribe(
    slot: string,
    event: string,
    onEvent: (payload: unknown) => void,
    onEnd?: (error?: Error) => void,
  ): () => void;
  open(slot: string, params: unknown): Promise<Duplex>;
  /** A stream to an `http` slot's provider, carrying HTTP/1.1 once it accepts. */
  http(slot: string): Promise<Duplex>;
  close(): void;
  /** Settles when the channel ends. */
  readonly closed: Promise<void>;
}

/** A wire error as the SDK's error: `NotConnected`, `Refused(code)` or `OutcomeUnknown`. */
export const errorOf = (error: WireError["error"], target: string): Error =>
  errorFromBody(error, target);

/** Anything a handler throws, as one wire error body: a non-SDK error is the provider failing. */
function bodyOf(error: unknown): WireError {
  const body = errorBodyOf(error);
  return wireError(body.name, body.message, body.code);
}

/** Write bodies and close our side. Each is encoded first, so a frame too large fails cleanly. */
async function send(stream: YamuxStream, ...bodies: unknown[]) {
  const frames = bodies.map((body) => encodeFrame(body));
  const writer = stream.writable.getWriter();
  try {
    for (const frame of frames) await writer.write(frame);
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}

/** Answer with one body; a body that can't go (too large) goes as a refusal instead. */
async function answer(stream: YamuxStream, body: unknown) {
  try {
    await send(stream, body);
  } catch (error) {
    if (!(error instanceof FrameError)) return stream.reset();
    await send(stream, wireError("Refused", error.message, "bad_output")).catch(() =>
      stream.reset(),
    );
  }
}

/** Read and drop what the other side still sends, so the stream can be forgotten. */
const drain = (reader: FrameReader) =>
  void reader
    .rest()
    .pipeTo(new WritableStream())
    .catch(() => {});

/**
 * Open a channel to the Hub as one Actor: a WebSocket, a yamux session and `hello`. Refusals come
 * back as the SDK's errors: a Hub that can't be reached is `NotConnected`, and a channel lost
 * mid-call is `OutcomeUnknown`.
 */
export async function openChannel(options: ChannelOptions): Promise<Channel> {
  let session: Session;
  const bound = new Set<string>();
  const exposed = new Map<string, ChannelExposure>();
  /** Set as the session ends: a notice read before then but handled after is dropped. */
  let ended = false;
  // Notices arrive as streams; their headers are read in arrival order, after hello's snapshot.
  let ready!: () => void;
  let headers = new Promise<void>((resolve) => {
    ready = resolve;
  });
  try {
    const bytes = await webSocketChannel(new WebSocket(options.hubUrl) as unknown as WebSocketLike);
    session = new Session(bytes, {
      client: true,
      onStream(stream) {
        const reader = new FrameReader(stream.readable);
        const header = headers.then(() => reader.next());
        headers = header.then(
          () => {},
          () => {},
        );
        void header
          .then((frame) => serveStream(parseHeader(frame), stream, reader))
          .catch(() => stream.reset());
      },
    });
  } catch {
    throw new NotConnected(`the Hub at ${options.hubUrl}`);
  }

  async function serveStream(header: Header, stream: YamuxStream, reader: FrameReader) {
    if (header.op === "slot") {
      if (ended) return;
      if (header.bound) bound.add(header.name);
      else bound.delete(header.name);
      // A slot made at run time is its exposure while bound, and gone when unbound.
      const wasExposed = exposed.delete(header.name);
      const exposure = header.exposed as ChannelExposure | undefined;
      if (exposure) exposed.set(header.name, exposure);
      // Told before closing our side, which may wait behind other frames: a channel that ends
      // meanwhile must not hear of a slot after its close has cleared them.
      void stream.writable.close().catch(() => {});
      try {
        if (exposure || wasExposed) options.onExposed?.(header.name, exposure);
        else options.onSlot?.(header.name, header.bound);
      } catch (error) {
        options.log?.error("A slot notice's handler threw.", {
          slot: header.name,
          error: String(error),
        });
      }
      return;
    }
    if (header.op !== "serve") return stream.reset();
    const handlers = options.serve;
    try {
      if (!handlers) throw new Refused("unimplemented", `${options.actorId} serves nothing.`);
      if (header.kind === "call") {
        const body = parseBody(await reader.next());
        if (!("input" in body)) throw new Refused("invalid", "A call's body is {input}.");
        return await answer(stream, result(await handlers.call(header, body.input)));
      }
      if (header.kind === "subscribe") return subscribeStream(handlers, header, stream);
      if (header.kind === "open" || header.kind === "http") {
        const run = header.kind === "open" ? handlers.accept(header) : handlers.serveHttp(header);
        const writer = stream.writable.getWriter();
        await writer.write(encodeFrame(result({})));
        writer.releaseLock();
        // Accepted: from here the stream is raw bytes, so a failing handler can only reset it.
        return await run({ readable: reader.rest(), writable: stream.writable }).catch(() =>
          stream.reset(),
        );
      }
      return stream.reset();
    } catch (error) {
      await answer(stream, bodyOf(error));
      drain(reader);
    }
  }

  function subscribeStream(handlers: ServeHandlers, header: Serve, stream: YamuxStream) {
    const writer = stream.writable.getWriter();
    let stopped = false;
    let stop = () => {};
    const halt = () => {
      if (stopped) return;
      stopped = true;
      stop();
    };
    const end = (error?: unknown) => {
      halt();
      void (error ? writer.write(encodeFrame(bodyOf(error))) : Promise.resolve())
        .then(() => writer.close())
        .catch(() => {});
    };
    stop = handlers.subscribe(
      header,
      (payload) => {
        if (stopped) return;
        let frame: Uint8Array;
        try {
          frame = encodeFrame(eventBody(payload));
        } catch (error) {
          // An event too large for a frame ends this subscription; the emitter isn't thrown at.
          options.log?.error("An event was too large to send.", { export: header.export });
          return end(
            new Refused("bad_output", error instanceof Error ? error.message : String(error)),
          );
        }
        writer.write(frame).catch(halt);
      },
      end,
    );
    // The Hub resets the stream to unsubscribe, which errors our side of it.
    writer.closed.catch(halt);
    if (stopped) stop();
  }

  /** Open a stream, send a header (and a body), and read the one body that answers. */
  async function exchange(header: unknown, target: string, body?: Body): Promise<Body> {
    let sent = false;
    try {
      const stream = session.open();
      await send(stream, ...(body ? [header, body] : [header]));
      sent = true;
      const reply = await new FrameReader(stream.readable).next();
      if (reply === undefined) throw new Error("no answer");
      return parseBody(reply);
    } catch (error) {
      // Too large to send: nothing ran. Malformed or too large to read: the answer broke.
      if (!sent && error instanceof FrameError) throw new Refused("invalid", error.message);
      if (error instanceof HeaderError || error instanceof FrameError)
        throw new Refused("bad_output", error.message);
      throw sent
        ? new OutcomeUnknown("The channel to the Hub dropped before the answer came.")
        : new NotConnected(target);
    }
  }

  const hello = await exchange(
    {
      op: "hello",
      actorId: options.actorId,
      credential: options.credential,
      ...(options.declares ? { declares: options.declares } : {}),
      ...(options.replace === false ? { replace: false } : {}),
    },
    "the Hub",
  );
  if ("error" in hello) {
    session.close();
    throw errorOf(hello.error, options.actorId);
  }
  for (const slot of (hello as { result: { bound?: string[] } }).result.bound ?? [])
    bound.add(slot);
  ready();

  const answered = (body: Body, target: string) => {
    if ("error" in body) throw errorOf(body.error, target);
    if (!("result" in body)) throw new Refused("bad_output", "The Hub's answer isn't a result.");
    return body.result;
  };
  const closed = session.closed.then(() => {
    ended = true;
    bound.clear();
    exposed.clear();
  });

  return {
    actorId: options.actorId,
    bound,
    exposed,
    async call(slot, method, value) {
      return answered(await exchange({ op: "call", slot, method }, slot, input(value)), slot);
    },
    subscribe(slot, event, onEvent, onEnd) {
      let ended = false;
      const end = (error?: Error) => {
        if (ended) return;
        ended = true;
        onEnd?.(error);
      };
      let stream: YamuxStream;
      try {
        stream = session.open();
      } catch {
        queueMicrotask(() => end(new NotConnected(slot)));
        return () => {};
      }
      void (async () => {
        try {
          const writer = stream.writable.getWriter();
          await writer.write(encodeFrame({ op: "subscribe", slot, event }));
          writer.releaseLock();
          const reader = new FrameReader(stream.readable);
          for (;;) {
            const frame = await reader.next();
            if (frame === undefined) return end();
            const body = parseBody(frame);
            if ("event" in body) onEvent(body.event);
            else if ("error" in body) return end(errorOf(body.error, slot));
          }
        } catch {
          end(new NotConnected(slot));
        }
      })();
      return () => {
        ended = true;
        stream.reset();
      };
    },
    open: (slot, params) => splice({ op: "open", slot, params }, slot),
    http: (slot) => splice({ op: "http", slot }, slot),
    close: () => session.close(),
    closed,
  };

  /** Open a raw stream: send its header, read the one body that answers, then hand over the bytes. */
  async function splice(header: unknown, slot: string): Promise<Duplex> {
    let stream: YamuxStream | undefined;
    try {
      stream = session.open();
      const writer = stream.writable.getWriter();
      await writer.write(encodeFrame(header));
      writer.releaseLock();
      const reader = new FrameReader(stream.readable);
      const first = await reader.next();
      if (first === undefined) throw new NotConnected(slot);
      answered(parseBody(first), slot);
      return { readable: reader.rest(), writable: stream.writable };
    } catch (error) {
      stream?.reset();
      if (
        error instanceof Refused ||
        error instanceof NotConnected ||
        error instanceof OutcomeUnknown
      )
        throw error;
      throw new NotConnected(slot);
    }
  }
}

export interface ConnectOptions<S extends InterfaceMap, X extends ExportMap> {
  hubUrl: string;
  actorId: string;
  credential: string;
  /** The slots this program uses, with their interfaces. */
  slots?: S;
  /** The exports it offers from the start. */
  exports?: X;
  /**
   * Whether hello declares `slots` and `exports` (the default). With `false`, the Actor keeps what
   * it declared before, and the handles here only shape and check calls locally.
   */
  declare?: boolean;
  /**
   * Runs and is awaited before the channel opens, as a module's start does: implement exports and
   * register `onBind` and `on` handlers here. Every slot reads unbound meanwhile; each bound slot's
   * `onBind` runs once the Hub admits the channel.
   */
  start?(ctx: Context<S, X>): void | Promise<void>;
  log?: Log;
}

/** A program connected to the Hub as an Actor: a module's handles, and a way to leave. */
export interface Client<S extends InterfaceMap, X extends InterfaceMap> extends Context<S, X> {
  close(): void;
  /** Settles when the channel ends; by then every slot reads unbound. */
  readonly closed: Promise<void>;
}

const quiet: Log = { info() {}, warn() {}, error() {} };
type None = Record<never, Interface>;

/**
 * Connect a program outside the Hub as an Actor. It gets the same handles as a module's `ctx`, on
 * the same runtime, so a call is checked here as the Hub checks it. As in a module: implement in
 * `start`, and use slots from `onBind`. `start` runs before the channel opens, so the Hub never
 * reaches an export before it is implemented. A slot is bound when the Hub says so; `onBind` runs
 * when it becomes usable (bound, or its provider back), and `on` handlers subscribe while it is
 * usable. `http` slots and
 * exports speak HTTP/1.1 over the Hub's stream, one request per stream, with `node:http`.
 */
export async function connect<
  const S extends InterfaceMap = None,
  const X extends ExportMap = None,
>(options: ConnectOptions<S, X>): Promise<Client<S, X>> {
  const slots = (options.slots ?? {}) as S;
  const exports = (options.exports ?? {}) as X;
  const log = options.log ?? quiet;
  // defineActor checks the names, as it does for a module.
  const definition = defineActor<S, X>({ slots, exports, start: options.start ?? (() => {}) });
  const host = new ModuleHost(slots, log);
  const runtime = createRuntime(definition, {
    self: { actorId: options.actorId, module: "client" },
    log,
    ...host.hooks(),
  });
  host.runtime = runtime as unknown as ModuleHost["runtime"];

  // A module's start: exports implemented and handlers registered before the Hub can reach them.
  await runtime.start();

  const describeAll = (map: InterfaceMap) =>
    Object.fromEntries(
      Object.entries(map).map(([name, iface]) => [name, describeInterface(iface as Interface)]),
    );
  const channel = await openChannel({
    hubUrl: options.hubUrl,
    actorId: options.actorId,
    credential: options.credential,
    log,
    ...(options.declare === false
      ? {}
      : { declares: { slots: describeAll(slots), exports: describeAll(exports) } }),
    onSlot: (slot, bound) => host.onSlot(slot, bound),
    onExposed: (slot, exposure) => host.onExposed(slot, exposure),
    serve: host.serve,
  });
  host.attach(channel);
  return Object.assign(runtime.ctx, { close: () => channel.close(), closed: channel.closed });
}
