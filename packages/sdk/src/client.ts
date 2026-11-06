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
import { type Binding, createRuntime } from "./runtime.js";

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
  hubUrl: string;
  actorId: string;
  credential: string;
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
  /** Where a notice handler's own failure is reported. */
  log?: Log;
}

/** A channel to the Hub as one Actor, at the wire's level: no local checks, no handles. */
export interface Channel {
  readonly actorId: string;
  /** The Actor's slots bound now, from hello's snapshot and the Hub's notices; empty once closed. */
  readonly bound: ReadonlySet<string>;
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
  /** Offer and withdraw run-time exports; they reach the Hub in the order they were made. */
  offer(name: string, iface: DescribedInterface): Promise<void>;
  withdraw(name: string): Promise<void>;
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
  // Notices arrive as streams; their headers are read in arrival order, after hello's snapshot.
  let ready!: () => void;
  let headers = new Promise<void>((resolve) => {
    ready = resolve;
  });
  try {
    const socket = new WebSocket(options.hubUrl);
    session = new Session(await webSocketChannel(socket as unknown as WebSocketLike), {
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
      if (header.bound) bound.add(header.name);
      else bound.delete(header.name);
      await stream.writable.close().catch(() => {});
      try {
        options.onSlot?.(header.name, header.bound);
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
  // Offers and withdrawals go one at a time, so the Hub sees them in the order they were made.
  let changes: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(work: () => Promise<T>): Promise<T> => {
    const next = changes.then(work, work);
    changes = next.catch(() => {});
    return next;
  };
  const closed = session.closed.then(() => bound.clear());

  return {
    actorId: options.actorId,
    bound,
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
    offer: (name, iface) =>
      inOrder(async () => {
        answered(await exchange({ op: "offer", name, interface: iface }, name), name);
      }),
    withdraw: (name) =>
      inOrder(async () => {
        answered(await exchange({ op: "withdraw", name }, name), name);
      }),
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
 * usable. `exports.add` and `withdraw()` offer and withdraw over the channel. `http` slots and
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
  /** The Hub's subscriptions to this Actor's exports: their senders by export and event. */
  const senders = new Map<string, Set<(payload: unknown) => void>>();
  /** The same subscriptions by export, each ended when its export is withdrawn. */
  const subscribers = new Map<string, Set<() => void>>();
  /** Slot events this program listens to, each with its live subscription, if any. */
  const listened = new Map<string, Map<string, (() => void) | undefined>>();
  const bindings = new Map<string, Binding>();
  /** Run-time exports by name, so a refused offer withdraws the right handle. */
  const added = new Map<string, { handle: { withdraw(): void }; iface: Interface }>();
  /** Offer a run-time export; one the Hub refuses is withdrawn here too. */
  const offer = (open: Channel, name: string, iface: Interface, handle: { withdraw(): void }) =>
    void open.offer(name, describeInterface(iface)).catch((error) => {
      log.error("The Hub refused an export.", { export: name, error: String(error) });
      if (added.get(name)?.handle === handle) handle.withdraw();
    });
  let channel: Channel | undefined;

  const subscribeSlot = (slot: string, event: string) => {
    const events = listened.get(slot) ?? new Map<string, (() => void) | undefined>();
    listened.set(slot, events);
    if (!events.has(event)) events.set(event, undefined);
    const binding = bindings.get(slot);
    if (!channel || !binding || events.get(event)) return;
    const stop = channel.subscribe(
      slot,
      event,
      (payload) => {
        try {
          binding.emit(event, payload);
        } catch (error) {
          log.warn("An event didn't fit its schema.", { slot, event, error: String(error) });
        }
      },
      // Ended by an unbind or the provider going: the interest stays for when it is usable again.
      () => {
        if (events.get(event) === stop) events.set(event, undefined);
      },
    );
    events.set(event, stop);
  };
  const resubscribe = (slot: string) => {
    const events = listened.get(slot);
    for (const [event, stop] of events ?? []) {
      stop?.();
      events?.set(event, undefined);
    }
    for (const event of events?.keys() ?? []) subscribeSlot(slot, event);
  };

  const runtime = createRuntime(definition, {
    self: { actorId: options.actorId, module: "client" },
    log,
    onEmit(exportName, event, payload) {
      // One subscriber's trouble never reaches the emitter or the other subscribers.
      for (const sendTo of [...(senders.get(`${exportName}\0${event}`) ?? [])])
        try {
          sendTo(payload);
        } catch (error) {
          log.error("Sending an event failed.", { export: exportName, error: String(error) });
        }
    },
    onListen: (slot, event) => subscribeSlot(slot, event),
    onAdd(name, iface, handle) {
      added.set(name, { handle, iface });
      // Added during start, before the channel opens: offered once it does.
      if (channel) offer(channel, name, iface, handle);
    },
    onWithdraw(name) {
      for (const end of [...(subscribers.get(name) ?? [])]) end();
      // Only exports offered at run time can be withdrawn at the Hub; static ones just stop here.
      if (!added.has(name)) return;
      added.delete(name);
      void channel?.withdraw(name).catch(() => {});
    },
  });

  const onSlot = (slot: string, isBound: boolean) => {
    if (!Object.hasOwn(slots, slot) || !channel) return;
    if (!isBound) {
      bindings.delete(slot);
      const events = listened.get(slot);
      for (const [event, stop] of events ?? []) {
        stop?.();
        events?.set(event, undefined);
      }
      return runtime.unbind(slot);
    }
    if (bindings.has(slot)) {
      // Its provider came back: what was missed is read again in onBind, and events resume.
      resubscribe(slot);
      return runtime.usable(slot);
    }
    const open = channel;
    bindings.set(
      slot,
      runtime.bind(slot, {
        call: (method, value) => open.call(slot, method, value),
        open: (params) => open.open(slot, params),
        fetch: async (request) => {
          // HTTP/1.1 is spoken with node:http, loaded only when an http slot is used.
          const { fetchOver } = await import("./client-http.js");
          const stream = await open.http(slot);
          try {
            return await fetchOver(stream, request);
          } catch (error) {
            // An abort keeps its own reason; a stream lost mid-request may have reached the provider.
            if (request.signal.aborted) throw error;
            throw new OutcomeUnknown(
              `The http request on ${slot} ended before its response: ${String(error)}`,
            );
          }
        },
      }),
    );
    resubscribe(slot);
  };

  // A module's start: exports implemented and handlers registered before the Hub can reach them.
  await runtime.start();

  const describeAll = (map: InterfaceMap) =>
    Object.fromEntries(
      Object.entries(map).map(([name, iface]) => [name, describeInterface(iface as Interface)]),
    );
  channel = await openChannel({
    hubUrl: options.hubUrl,
    actorId: options.actorId,
    credential: options.credential,
    log,
    ...(options.declare === false
      ? {}
      : { declares: { slots: describeAll(slots), exports: describeAll(exports) } }),
    onSlot,
    serve: {
      call: (serve, value) => runtime.call(serve.export, serve.method ?? "", value),
      subscribe(serve, sendTo, end) {
        if (runtime.withdrawn(serve.export)) throw new NotConnected(serve.export);
        const key = `${serve.export}\0${serve.event ?? ""}`;
        const set = senders.get(key) ?? new Set();
        senders.set(key, set);
        set.add(sendTo);
        const ends = subscribers.get(serve.export) ?? new Set();
        subscribers.set(serve.export, ends);
        const stop = () => {
          set.delete(sendTo);
          ends.delete(withdrawn);
        };
        const withdrawn = () => {
          stop();
          end(new NotConnected(serve.export));
        };
        ends.add(withdrawn);
        return stop;
      },
      accept: (serve) => runtime.accepting(serve.export, serve.params),
      serveHttp(serve) {
        const handle = runtime.serving(serve.export);
        return async (stream) => {
          const { serveOver } = await import("./client-http.js");
          await serveOver(stream, handle, log);
        };
      },
    },
  });
  const open = channel;
  for (const [name, { handle, iface }] of added) offer(open, name, iface, handle);
  for (const slot of open.bound) onSlot(slot, true);
  // A lost channel leaves nothing usable: every slot reads unbound, and its handlers hear so.
  void open.closed.then(() => {
    for (const slot of [...bindings.keys()]) onSlot(slot, false);
    for (const ends of subscribers.values()) for (const end of [...ends]) end();
  });
  return Object.assign(runtime.ctx, { close: () => open.close(), closed: open.closed });
}
