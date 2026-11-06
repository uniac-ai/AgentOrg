import {
  type DescribedInterface,
  hashInterface,
  type InterfaceSchemas,
  NotConnected,
  OutcomeUnknown,
  Refused,
} from "@agentorg/sdk";
import {
  type Body,
  type Duplex,
  encodeFrame,
  eventBody,
  FrameError,
  FrameReader,
  GO_AWAY,
  HeaderError,
  input,
  parseBody,
  parseHeader,
  result,
  Session,
  type SessionOptions,
  type WireError,
  wireError,
  type YamuxStream,
} from "@agentorg/wire";
import { HubActor } from "./hub-actor.js";
import { type BindingRecord, type CallOutcome, HUB, HubState, type Wiring } from "./state.js";
import { type Part, Validators } from "./validate.js";

/** Streams an admitted channel may have open at once. Before admission it may have one: hello. */
const MAX_STREAMS = 256;
/** Interfaces one hello may declare. */
const MAX_DECLARED = 256;
/**
 * Slot notices an Actor may leave unclosed beyond one per slot it declares (one change, such as its
 * provider closing, can unbind every slot at once). Past that its channel is closed with a
 * protocol error: the Hub holds each until the Actor closes it, and its next hello carries the state.
 */
const MAX_OPEN_NOTICES = 64;
/**
 * Event bytes queued for a subscriber that has stopped reading, before it is cut off. Events from
 * a provider wait for each delivery, so this bounds the hub Actor's own events.
 */
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;

export interface HubOptions {
  /** How long a new channel has to finish hello before it is closed. */
  helloTimeoutMs?: number;
  /**
   * How long a provider has to answer a call, or to accept or refuse an open or http stream; past
   * it the caller gets OutcomeUnknown and the provider's stream is reset.
   */
  answerTimeoutMs?: number;
  /** The schema-check pool: its size and each check's budget (defaults in validate.ts). */
  checks?: { size?: number; budgetMs?: number };
}

/** A channel the Hub took: `closed` settles when it ends. */
export interface ChannelHandle {
  closed: Promise<void>;
  close(): void;
}

interface Connection {
  actorId: string;
  session: Session;
  /** Slot notices sent that the Actor hasn't closed yet. */
  notices: number;
}
type Writer = WritableStreamDefaultWriter<Uint8Array>;
interface Resolved {
  binding: BindingRecord;
  iface: DescribedInterface;
  /** The provider's channel; none for the hub, served in-process. */
  provider?: Connection;
}

const bindingKey = (b: Pick<Wiring, "consumer" | "slot">) => `${b.consumer}\0${b.slot}`;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function errorBody(error: unknown): WireError {
  if (error instanceof Refused) return wireError("Refused", error.message, error.code);
  if (error instanceof NotConnected) return wireError("NotConnected", error.message);
  if (error instanceof OutcomeUnknown) return wireError("OutcomeUnknown", error.message);
  if (error instanceof HeaderError || error instanceof FrameError)
    return wireError("Refused", error.message, "invalid");
  return wireError("Refused", "The Hub couldn't handle this stream.", "internal");
}

/** The outcome of a call the Hub ended itself; a provider's own error is always `refused`. */
function outcomeOf(error: WireError["error"]): CallOutcome {
  if (error.name === "NotConnected") return "not_connected";
  if (error.name === "OutcomeUnknown") return "outcome_unknown";
  return error.code === "invalid" || error.code === "bad_output" || error.code === "cancelled"
    ? error.code
    : "refused";
}

/**
 * Read and drop whatever the opener still sends. A stream is forgotten only once both sides end
 * and nothing is left unread, so a refused stream's leftover bytes would otherwise hold it open.
 */
const drain = (reader: FrameReader) =>
  void reader
    .rest()
    .pipeTo(new WritableStream())
    .catch(() => {});

/** Settles when the opener resets its stream; a clean end of its side is not a reset. */
const whenReset = (reader: FrameReader) =>
  reader.next().then(
    () => new Promise<void>(() => {}),
    () => undefined,
  );

/** A body encoded for the wire; one over the frame limit becomes a refusal saying so. */
function frameOf(body: Body): { body: Body; frame: Uint8Array } {
  try {
    return { body, frame: encodeFrame(body) };
  } catch (error) {
    const refusal = wireError(
      "Refused",
      error instanceof Error ? error.message : String(error),
      "too_large",
    );
    return { body: refusal, frame: encodeFrame(refusal) };
  }
}

async function answer(writer: Writer, frame: Uint8Array | Body) {
  try {
    await writer.write(frame instanceof Uint8Array ? frame : frameOf(frame).frame);
    await writer.close();
  } catch {
    // The other side is gone; make sure the stream is too.
    await writer.abort().catch(() => {});
  }
}

/**
 * The core as a router. Each connected Actor has one channel, a yamux session; every stream on it
 * starts with a header. The Hub resolves a consumer's slot through its binding, validates what
 * crosses in both directions against the interface's JSON Schemas, opens a stream toward the
 * provider naming its export and the caller, and audits the call. The `hub` Actor's exports are
 * served in-process, through the same path.
 */
export class Hub {
  readonly state: HubState;
  readonly #actor: HubActor;
  readonly #validators: Validators;
  readonly #connections = new Map<string, Connection>();
  /** Open subscriptions and splices by the binding they run through, ended when it goes. */
  readonly #live = new Map<string, Set<(error?: WireError) => void>>();
  readonly #helloTimeoutMs: number;
  readonly #answerTimeoutMs: number;
  /** Every channel's session, admitted or still in hello. */
  readonly #sessions = new Set<Session>();

  private constructor(home: string, options: HubOptions) {
    this.#helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
    this.#answerTimeoutMs = options.answerTimeoutMs ?? 60_000;
    this.#validators = new Validators(options.checks);
    let actor: HubActor | undefined;
    this.state = HubState.open(home, {
      bound: (binding) => this.#notify(binding.consumer, binding.slot, true),
      unbound: (bindings) => {
        for (const binding of bindings) {
          for (const end of [...(this.#live.get(bindingKey(binding)) ?? [])])
            end(errorBody(new NotConnected(binding.slot)));
          this.#notify(binding.consumer, binding.slot, false);
        }
      },
      closed: (actorId) => this.#connections.get(actorId)?.session.close(),
      requested: (request, approvers) => actor?.requested(request, approvers),
      decided: (request, status, approvers) => actor?.decided(request, status, approvers),
      exportsChanged: (changed) => actor?.exportsChanged(changed),
      audited: (entry) => actor?.audited(entry),
    });
    actor = this.#actor = new HubActor(this.state);
  }

  static open(home: string, options: HubOptions = {}): Hub {
    return new Hub(home, options);
  }

  /** Whether an Actor has a channel now. */
  connected(actorId: string): boolean {
    return this.#connections.has(actorId);
  }

  /**
   * Take a channel. An external client's first stream must be `hello` with its credential, within
   * the hello deadline, and nothing else may open before it is admitted. A channel the Hub made
   * itself, a pipe to a package Actor's process it spawned, is admitted by that: pass its
   * `actorId`. The handle settles when the channel ends, and closes it.
   */
  accept(channel: Duplex, admitted?: { actorId: string }): ChannelHandle {
    if (admitted) {
      const actor = this.state.actor(admitted.actorId);
      if (actor.package === "external" || actor.package === "builtin" || actor.state === "closed")
        throw new Refused("state", `${actor.actorId} isn't a live package Actor.`);
    }
    let conn: Connection | undefined;
    let helloSeen = false;
    let ended = false;
    const options: SessionOptions = {
      client: false,
      maxStreams: admitted ? MAX_STREAMS : 1,
      onStream: (stream) => {
        if (conn) void this.#serve(conn, stream);
        else if (helloSeen) stream.reset();
        else {
          helloSeen = true;
          void this.#hello(stream, session, (actorId) => {
            if (ended) throw new NotConnected("The channel");
            conn = this.#admit(actorId, session);
            options.maxStreams = MAX_STREAMS;
          });
        }
      },
    };
    const session = new Session(channel, options);
    this.#sessions.add(session);
    if (admitted) conn = this.#admit(admitted.actorId, session);
    const timer = admitted
      ? undefined
      : setTimeout(() => {
          if (!conn) session.close(GO_AWAY.protocolError);
        }, this.#helloTimeoutMs);
    const closed = session.closed.then(() => {
      ended = true;
      clearTimeout(timer);
      this.#sessions.delete(session);
      if (conn) this.#dropped(conn);
    });
    return { closed, close: () => session.close() };
  }

  /** Close every channel, admitted or not, then the state. */
  close(): void {
    for (const session of [...this.#sessions]) session.close();
    this.#connections.clear();
    this.#validators.close();
    this.state.close();
  }

  #admit(actorId: string, session: Session): Connection {
    const old = this.#connections.get(actorId);
    if (old) {
      // A newer channel for the same Actor wins; the old one is closed.
      this.#dropped(old);
      old.session.close();
    }
    const conn = { actorId, session, notices: 0 };
    this.#connections.set(actorId, conn);
    return conn;
  }

  #dropped(conn: Connection) {
    if (this.#connections.get(conn.actorId) !== conn) return;
    this.#connections.delete(conn.actorId);
    try {
      this.state.disconnected(conn.actorId);
    } catch {
      // The state is closed: the Hub is shutting down.
    }
  }

  async #hello(stream: YamuxStream, session: Session, admit: (actorId: string) => void) {
    const reader = new FrameReader(stream.readable);
    const writer = stream.writable.getWriter();
    try {
      const header = parseHeader(await reader.next());
      if (header.op !== "hello")
        throw new Refused("invalid", "A channel's first stream must be hello.");
      if (!this.state.authenticate(header.actorId, header.credential))
        throw new Refused("forbidden", "No such Actor, or the credential is wrong.");
      if (header.declares !== undefined)
        this.state.declareExternal(
          header.actorId,
          await this.#declares(header.actorId, header.declares),
        );
      admit(header.actorId);
      // Taken as the channel is admitted: every change after it reaches the channel as a notice.
      const bound = this.state
        .bindings(header.actorId)
        .filter((b) => b.consumer === header.actorId)
        .map((b) => b.slot);
      await answer(writer, result({ actorId: header.actorId, bound }));
    } catch (error) {
      await answer(writer, errorBody(error));
      session.close(GO_AWAY.protocolError);
    }
  }

  /** Tell an Actor's channel that one of its slots was bound or unbound. */
  #notify(actorId: string, slot: string, bound: boolean) {
    const conn = this.#connections.get(actorId);
    if (!conn) return;
    if (conn.notices >= this.state.slotCount(actorId) + MAX_OPEN_NOTICES)
      return conn.session.close(GO_AWAY.protocolError);
    try {
      const stream = conn.session.open();
      conn.notices++;
      const writer = stream.writable.getWriter();
      void writer
        .write(encodeFrame({ op: "slot", name: slot, bound }))
        .then(() => writer.close())
        .catch(() => {});
      // Nothing comes back; the Actor closing its side ends the read and frees the notice.
      void stream.readable
        .pipeTo(new WritableStream())
        .catch(() => {})
        .finally(() => {
          conn.notices--;
        });
    } catch {
      // The channel is going; its next hello carries the state.
    }
  }

  /** What a hello declares, checked: shapes, hashes, and schemas that compile. */
  async #declares(
    actor: string,
    value: unknown,
  ): Promise<{
    slots: Record<string, DescribedInterface>;
    exports: Record<string, DescribedInterface>;
  }> {
    if (!isRecord(value)) throw new Refused("invalid", "declares must be {slots, exports}.");
    const out = { slots: {}, exports: {} } as Record<
      "slots" | "exports",
      Record<string, DescribedInterface>
    >;
    let count = 0;
    for (const side of ["slots", "exports"] as const) {
      const members = value[side] ?? {};
      if (!isRecord(members)) throw new Refused("invalid", `declares.${side} must be an object.`);
      for (const [name, iface] of Object.entries(members)) {
        if (++count > MAX_DECLARED)
          throw new Refused("invalid", `A hello declares at most ${MAX_DECLARED} interfaces.`);
        out[side][name] = await this.#described(actor, iface, `declares.${side}.${name}`);
      }
    }
    return out;
  }

  /** A described interface from the wire: its shape, then its hash, then schemas that compile. */
  async #described(actor: string, iface: unknown, where: string): Promise<DescribedInterface> {
    if (!isRecord(iface) || typeof iface.id !== "string" || typeof iface.hash !== "string")
      throw new Refused("invalid", `${where} isn't a described interface.`);
    const { hash, ...schemas } = iface;
    let recomputed: string | undefined;
    try {
      recomputed = hashInterface(schemas as InterfaceSchemas);
    } catch {
      recomputed = undefined;
    }
    // The hash keys the compiled schemas, so it is checked before anything is compiled.
    if (recomputed !== hash)
      throw new Refused("invalid", `${iface.id}'s hash doesn't match its schemas.`);
    await this.#validators.prepare(actor, iface as DescribedInterface);
    return iface as DescribedInterface;
  }

  // ── Streams from an admitted Actor ─────────────────────────────────────────

  async #serve(conn: Connection, stream: YamuxStream) {
    const reader = new FrameReader(stream.readable);
    const writer = stream.writable.getWriter();
    try {
      const header = parseHeader(await reader.next());
      switch (header.op) {
        case "call":
          return await this.#call(conn, header, reader, writer);
        case "subscribe":
          return await this.#subscribe(conn, header, stream, reader, writer);
        case "open":
        case "http":
          return await this.#splice(conn, header, stream, reader, writer);
        case "offer":
          this.state.offer(
            conn.actorId,
            header.name,
            await this.#described(conn.actorId, header.interface, "interface"),
          );
          await answer(writer, result({}));
          return drain(reader);
        case "withdraw":
          this.state.withdraw(conn.actorId, header.name);
          await answer(writer, result({}));
          return drain(reader);
        default:
          throw new Refused("invalid", `A ${header.op} stream can't be opened here.`);
      }
    } catch (error) {
      await answer(writer, errorBody(error));
      drain(reader);
    }
  }

  /** Keep an open subscription or splice under its binding, so the binding's end ends it. */
  #track(binding: BindingRecord, end: (error?: WireError) => void): () => void {
    const key = bindingKey(binding);
    const ends = this.#live.get(key) ?? new Set();
    this.#live.set(key, ends);
    ends.add(end);
    return () => {
      ends.delete(end);
      if (!ends.size) this.#live.delete(key);
    };
  }

  // Every schema check runs in the turn of the Actor the work is for: a call's input and output in
  // the caller's, a subscription's events in the subscriber's, a hello's or offer's compile in the
  // declaring Actor's. A slow provider so delays only the callers using it, each in its own turn.

  /** A consumer's slot, resolved through its binding to a live provider of the right kind. */
  #resolve(conn: Connection, slot: string, kind: DescribedInterface["kind"]): Resolved {
    const resolved = this.state.resolveCall(conn.actorId, slot);
    if (!resolved) throw new NotConnected(slot);
    const { binding, target } = resolved;
    if (target.iface.kind !== kind)
      throw new Refused("invalid", `${slot} is an ${target.iface.kind} slot, not ${kind}.`);
    const provider = binding.provider === HUB ? undefined : this.#connections.get(binding.provider);
    if (binding.provider !== HUB && !provider) throw new NotConnected(slot);
    return { binding, iface: target.iface, provider };
  }

  #audit(
    caller: string,
    slot: string,
    binding: BindingRecord | undefined,
    call: { op: "call" | "subscribe" | "open" | "http"; method?: string; outcome: CallOutcome },
  ) {
    const { consumer, provider, export: exported } = binding ?? { consumer: caller };
    try {
      this.state.auditCall(caller, { consumer, slot, provider, export: exported }, call);
    } catch {
      // The state is closed: the Hub is shutting down.
    }
  }

  async #call(
    conn: Connection,
    header: { slot: string; method: string },
    reader: FrameReader,
    writer: Writer,
  ) {
    let binding: BindingRecord | undefined;
    let reply: Body;
    let outcome: CallOutcome = "ok";
    // Once the input is read, this watches the rest of the caller's stream (and so drains it).
    let cancelled: Promise<void> | undefined;
    try {
      const resolved = this.#resolve(conn, header.slot, "rpc");
      binding = resolved.binding;
      const { iface, provider } = resolved;
      const part: Part = { method: header.method, side: "input" };
      if (!this.#validators.has(iface, part))
        throw new Refused("invalid", `${iface.id} has no method ${header.method}.`);
      const body = parseBody(await reader.next());
      cancelled = whenReset(reader);
      if (!("input" in body)) throw new Refused("invalid", "A call's body is {input}.");
      await this.#validators.check(conn.actorId, iface, part, body.input, "invalid");
      reply = provider
        ? await this.#forward(provider, binding, conn.actorId, header.method, body.input, cancelled)
        : this.#hubCall(binding.export, header.method, conn.actorId, body.input);
      if ("error" in reply) outcome = "refused";
      else if ("result" in reply)
        await this.#validators.check(
          conn.actorId,
          iface,
          { method: header.method, side: "output" },
          reply.result,
          "bad_output",
        );
      else if (!("error" in reply))
        throw new Refused("bad_output", "The provider's reply is neither a result nor an error.");
    } catch (error) {
      reply = errorBody(error);
      outcome = outcomeOf(reply.error);
    }
    const encoded = frameOf(reply);
    if (encoded.body !== reply) outcome = "refused";
    this.#audit(conn.actorId, header.slot, binding, {
      op: "call",
      method: header.method,
      outcome,
    });
    await answer(writer, encoded.frame);
    if (!cancelled) drain(reader);
  }

  #hubCall(exported: string, method: string, caller: string, value: unknown): Body {
    try {
      // Through JSON, as a reply from any other provider would be.
      const out = this.#actor.call(exported, method, caller, value);
      return result(JSON.parse(JSON.stringify(out ?? null)));
    } catch (error) {
      return errorBody(error);
    }
  }

  /** A call sent on to its provider. Once anything is sent, a lost channel is OutcomeUnknown. */
  async #forward(
    provider: Connection,
    binding: BindingRecord,
    caller: string,
    method: string,
    value: unknown,
    cancelled: Promise<void>,
  ): Promise<Body> {
    const out = this.#openTo(provider, binding);
    try {
      const writer = out.writable.getWriter();
      await writer.write(
        encodeFrame({ op: "serve", kind: "call", export: binding.export, caller, method }),
      );
      await writer.write(encodeFrame(input(value)));
      await writer.close();
    } catch {
      out.reset();
      throw new OutcomeUnknown(`${binding.provider} went away before answering.`);
    }
    return this.#answerFrom(out, new FrameReader(out.readable), binding, cancelled);
  }

  #openTo(provider: Connection, binding: BindingRecord): YamuxStream {
    try {
      return provider.session.open();
    } catch {
      throw new NotConnected(binding.slot);
    }
  }

  /**
   * The one body a provider answers with, within the answer deadline. Past it, or if the provider
   * goes, it is OutcomeUnknown; if the caller resets first, `cancelled`. Either way the provider's
   * stream is reset.
   */
  async #answerFrom(
    out: YamuxStream,
    reader: FrameReader,
    binding: BindingRecord,
    cancelled: Promise<void>,
  ): Promise<Body> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), this.#answerTimeoutMs);
    });
    let first: unknown;
    try {
      first = await Promise.race([reader.next(), late, cancelled.then(() => "cancelled" as const)]);
    } catch (error) {
      out.reset();
      if (error instanceof FrameError) throw new Refused("bad_output", error.message);
      throw new OutcomeUnknown(`${binding.provider} went away before answering.`);
    } finally {
      clearTimeout(timer);
    }
    if (first === "late" || first === "cancelled") {
      out.reset();
      if (first === "cancelled") throw new Refused("cancelled", "The caller went away.");
      throw new OutcomeUnknown(`${binding.provider} didn't answer in time.`);
    }
    if (first === undefined) {
      out.reset();
      throw new OutcomeUnknown(`${binding.provider} closed the stream without answering.`);
    }
    try {
      return parseBody(first);
    } catch (error) {
      out.reset();
      throw new Refused("bad_output", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Events from the provider, each validated, until the subscriber resets the stream, the
   * provider ends it, or the binding goes.
   */
  async #subscribe(
    conn: Connection,
    header: { slot: string; event: string },
    stream: YamuxStream,
    reader: FrameReader,
    writer: Writer,
  ) {
    let resolved: Resolved | undefined;
    const part: Part = { event: header.event };
    try {
      resolved = this.#resolve(conn, header.slot, "rpc");
      if (!this.#validators.has(resolved.iface, part))
        throw new Refused("invalid", `${resolved.iface.id} has no event ${header.event}.`);
    } catch (error) {
      const body = errorBody(error);
      this.#audit(conn.actorId, header.slot, resolved?.binding, {
        op: "subscribe",
        method: header.event,
        outcome: outcomeOf(body.error),
      });
      await answer(writer, body);
      return drain(reader);
    }
    const { binding, iface, provider } = resolved;
    this.#audit(conn.actorId, header.slot, binding, {
      op: "subscribe",
      method: header.event,
      outcome: "ok",
    });
    let stop = () => {};
    let ended = false;
    let queued = 0;
    const untrack = this.#track(binding, (error) => end(error));
    const end = (error?: WireError) => {
      if (ended) return;
      ended = true;
      untrack();
      stop();
      if (error) void answer(writer, error);
      else void writer.close().catch(() => {});
    };
    // Events are checked off-thread, so each waits its turn here to keep them in order.
    let delivered = Promise.resolve();
    const deliver = (payload: unknown): Promise<void> => {
      if (ended) return delivered;
      const { frame } = frameOf(eventBody(payload));
      // A subscriber that stops reading is cut off, not buffered for: its stream is reset.
      if (queued + frame.length > MAX_QUEUED_BYTES) {
        stream.reset();
        end();
        return delivered;
      }
      queued += frame.length;
      delivered = delivered.then(async () => {
        try {
          if (ended) return;
          await this.#validators.check(conn.actorId, iface, part, payload, "bad_output");
          if (ended) return;
          await writer.write(frame);
        } catch (error) {
          end(error instanceof Refused ? errorBody(error) : undefined);
        } finally {
          queued -= frame.length;
        }
      });
      return delivered;
    };
    // A reset (or anything but a clean end of its side) from the subscriber ends it.
    reader.next().then(
      (more) =>
        more !== undefined && end(wireError("Refused", "A subscriber sends nothing.", "invalid")),
      () => end(),
    );
    if (!provider) {
      stop = this.#actor.subscribe(binding.export, header.event, {
        caller: conn.actorId,
        emit: deliver,
      });
      return;
    }
    let out: YamuxStream;
    try {
      out = provider.session.open();
    } catch {
      return end(errorBody(new NotConnected(header.slot)));
    }
    stop = () => out.reset();
    try {
      const upstream = out.writable.getWriter();
      await upstream.write(
        encodeFrame({
          op: "serve",
          kind: "subscribe",
          export: binding.export,
          caller: conn.actorId,
          event: header.event,
        }),
      );
      await upstream.close();
      const events = new FrameReader(out.readable);
      for (;;) {
        const frame = await events.next();
        if (frame === undefined) return end();
        const body = parseBody(frame);
        // Backpressure: the provider's next event is read once this one is delivered.
        if ("event" in body) await deliver(body.event);
        else if ("error" in body) return end(body);
        else return end(wireError("Refused", "A subscription carries events.", "bad_output"));
        if (ended) return;
      }
    } catch (error) {
      end(
        error instanceof HeaderError || error instanceof FrameError
          ? wireError("Refused", error.message, "bad_output")
          : errorBody(new NotConnected(header.slot)),
      );
    }
  }

  /**
   * `open` and `http`: validated, then the provider accepts or refuses with one body, which the Hub
   * passes on; after an accept, raw bytes both ways until either side ends them.
   */
  async #splice(
    conn: Connection,
    header: { op: "open" | "http"; slot: string; params?: unknown },
    stream: YamuxStream,
    reader: FrameReader,
    writer: Writer,
  ) {
    let binding: BindingRecord | undefined;
    let out: YamuxStream | undefined;
    let upstream: FrameReader | undefined;
    let answered: Body;
    let outcome: CallOutcome = "ok";
    let unbound = false;
    let untrack = () => {};
    try {
      const resolved = this.#resolve(conn, header.slot, header.op === "open" ? "stream" : "http");
      binding = resolved.binding;
      // Tracked from here, so a binding that goes while the provider decides ends it too.
      untrack = this.#track(binding, () => {
        unbound = true;
        out?.reset();
        stream.reset();
      });
      if (header.op === "open")
        await this.#validators.check(
          conn.actorId,
          resolved.iface,
          { open: true },
          header.params,
          "invalid",
        );
      // The hub's own exports are all rpc, so #resolve refused it already; this is for the types.
      if (!resolved.provider) throw new NotConnected(header.slot);
      const opened = this.#openTo(resolved.provider, binding);
      out = opened;
      try {
        const head = opened.writable.getWriter();
        await head.write(
          encodeFrame({
            op: "serve",
            kind: header.op,
            export: binding.export,
            caller: conn.actorId,
            ...(header.op === "open" ? { params: header.params } : {}),
          }),
        );
        head.releaseLock();
      } catch {
        throw new OutcomeUnknown(`${binding.provider} went away before answering.`);
      }
      upstream = new FrameReader(opened.readable);
      const body = await this.#answerFrom(opened, upstream, binding, new Promise(() => {}));
      if (unbound) throw new NotConnected(header.slot);
      if ("error" in body) {
        outcome = "refused";
        answered = body;
      } else if ("result" in body) answered = result({});
      else throw new Refused("bad_output", "A provider answers an open with {result} or {error}.");
    } catch (error) {
      answered = errorBody(unbound ? new NotConnected(header.slot) : error);
      outcome = outcomeOf(answered.error);
    }
    this.#audit(conn.actorId, header.slot, binding, { op: header.op, outcome });
    if (!("result" in answered) || !out || !upstream) {
      untrack();
      out?.reset();
      await answer(writer, answered);
      return drain(reader);
    }
    const provider = out;
    try {
      await writer.write(encodeFrame(answered));
    } catch {
      untrack();
      return provider.reset();
    }
    writer.releaseLock();
    await Promise.all([
      reader
        .rest()
        .pipeTo(provider.writable)
        .catch(() => provider.reset()),
      upstream
        .rest()
        .pipeTo(stream.writable)
        .catch(() => stream.reset()),
    ]);
    untrack();
  }
}
