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
   * How long a provider has to answer a call; past it the caller gets OutcomeUnknown and the
   * provider's stream is reset.
   */
  answerTimeoutMs?: number;
  /** A different limit for the calls of some interfaces, by id (`name@major`). */
  answerTimeoutsMs?: Record<string, number>;
  /** The schema-check pool: its size and each check's budget (defaults in validate.ts). */
  checks?: { size?: number; budgetMs?: number; compileBudgetMs?: number };
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
/**
 * Where a subscription's events go: each in turn (with its encoded frame), then its end, with the
 * reason if any. `cutOff` is the Hub ending it because the subscriber stopped taking events.
 */
interface Sink {
  send(payload: unknown, frame: Uint8Array): Promise<void>;
  end(error?: WireError, cutOff?: boolean): void;
}
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

/**
 * A value as it would cross the wire: what the hub gives in-process is
 * checked and sent as a channel provider's would be, so a property left undefined is left out,
 * never a value that fails its schema.
 */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));

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
  /** Open subscriptions by the binding they run through, ended when it goes. */
  readonly #live = new Map<string, Set<(error?: WireError) => void>>();
  readonly #helloTimeoutMs: number;
  readonly #answerTimeoutMs: number;
  readonly #answerTimeoutsMs: Record<string, number>;
  /** Every channel's session, admitted or still in hello. */
  readonly #sessions = new Set<Session>();

  private constructor(home: string, options: HubOptions) {
    this.#helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
    this.#answerTimeoutMs = options.answerTimeoutMs ?? 60_000;
    this.#answerTimeoutsMs = options.answerTimeoutsMs ?? {};
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
      exportsChanged: (changed) => actor?.exportsChanged(changed),
      actorChanged: (changed) => actor?.actorChanged(changed),
      audited: (entry) => actor?.audited(entry),
    });
    actor = this.#actor = new HubActor(this.state, (id) => this.connected(id));
  }

  /** Open the Hub in its home. */
  static open(home: string, options: HubOptions = {}): Hub {
    return new Hub(home, options);
  }

  /** Whether an Actor has a channel now. */
  connected(actorId: string): boolean {
    return this.#connections.has(actorId);
  }

  /**
   * Take a channel. Its first stream must be `hello`, and nothing else may open before it is
   * admitted. A hello carries the Actor's credential, within the hello deadline. The handle settles
   * when the channel ends, and closes it.
   */
  accept(channel: Duplex): ChannelHandle {
    let conn: Connection | undefined;
    let helloSeen = false;
    let ended = false;
    const options: SessionOptions = {
      client: false,
      maxStreams: 1,
      onStream: (stream) => {
        if (conn) void this.#serve(conn, stream);
        else if (helloSeen) stream.reset();
        else {
          helloSeen = true;
          void this.#hello(stream, session, (actorId, replace) => {
            if (ended) throw new NotConnected("The channel");
            // Closed while its hello was on the way: a closed Actor is never admitted.
            if (this.state.actor(actorId).state === "closed")
              throw new Refused(
                "state",
                `${this.state.named(actorId)} is closed for good; make another.`,
              );
            // Checked again as the channel is admitted: one may have connected while declares
            // were checked.
            if (replace === false && this.#connections.has(actorId))
              throw new Refused(
                "connected",
                `${this.state.named(actorId)} already has a channel to this Hub; close that one first.`,
              );
            conn = this.#admit(actorId, session);
            options.maxStreams = MAX_STREAMS;
          });
        }
      },
    };
    const session = new Session(channel, options);
    this.#sessions.add(session);
    const timer = setTimeout(() => {
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
    this.#actor.actorChanged(actorId);
    // Its consumers' subscriptions ended when it went; a notice tells each slot it is usable again.
    // Its channel is new and learns its slots from hello.
    for (const binding of this.state.bindings(actorId))
      if (binding.consumer !== actorId) this.#notify(binding.consumer, binding.slot, true);
    return conn;
  }

  #dropped(conn: Connection) {
    if (this.#connections.get(conn.actorId) !== conn) return;
    this.#connections.delete(conn.actorId);
    this.#actor.actorChanged(conn.actorId);
  }

  async #hello(
    stream: YamuxStream,
    session: Session,
    admit: (actorId: string, replace?: false) => void,
  ) {
    const reader = new FrameReader(stream.readable);
    const writer = stream.writable.getWriter();
    try {
      const header = parseHeader(await reader.next());
      if (header.op !== "hello")
        throw new Refused("invalid", "A channel's first stream must be hello.");
      if (
        header.credential === undefined ||
        !this.state.authenticate(header.actorId, header.credential)
      )
        throw new Refused("forbidden", "No such Actor, or the credential is wrong.");
      if (header.replace === false && this.#connections.has(header.actorId))
        throw new Refused(
          "connected",
          `${this.state.named(header.actorId)} already has a channel to this Hub; close that one first.`,
        );
      if (header.declares !== undefined)
        this.state.declareExternal(
          header.actorId,
          await this.#declares(header.actorId, header.declares),
        );
      admit(header.actorId, header.replace);
      // Taken as the channel is admitted: every change after it reaches the channel as a notice.
      const mine = this.state.bindings(header.actorId).filter((b) => b.consumer === header.actorId);
      const bound = mine.map((b) => b.slot);
      await answer(writer, result({ actorId: header.actorId, bound }));
      // Each slot made at run time follows as its own notice, with its interface: one frame
      // each, however many there are.
      for (const b of mine) if (b.exposed) this.#notify(header.actorId, b.slot, true);
    } catch (error) {
      await answer(writer, errorBody(error));
      session.close(GO_AWAY.protocolError);
    }
  }

  /** Tell an Actor's channel that one of its slots was bound or unbound. */
  /** A slot made at run time, as its consumer is told of it: the export's interface, and whose it is. */
  #exposure(binding: BindingRecord) {
    return {
      interface: this.state.declaration(binding.consumer, "slot", binding.slot)?.iface,
      provider: { actor: binding.provider, export: binding.export },
    };
  }

  #notify(actorId: string, slot: string, bound: boolean) {
    const conn = this.#connections.get(actorId);
    if (!conn) return;
    if (conn.notices >= this.state.slotCount(actorId) + MAX_OPEN_NOTICES)
      return conn.session.close(GO_AWAY.protocolError);
    // A slot made at run time carries its exposure while bound; unbound, it is gone.
    const binding = bound ? this.state.binding(actorId, slot) : undefined;
    // Gone before it could be told: its unbinding is told instead.
    if (bound && !binding) return;
    const exposed = binding?.exposed ? { exposed: this.#exposure(binding) } : {};
    let frame: Uint8Array;
    try {
      frame = encodeFrame({ op: "slot", name: slot, bound, ...exposed });
    } catch {
      // An interface offered in one frame fits one; nothing else here can be too large.
      return;
    }
    try {
      const stream = conn.session.open();
      conn.notices++;
      const writer = stream.writable.getWriter();
      void writer
        .write(frame)
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
    const sides = (["slots", "exports"] as const).map((side) => {
      const members = value[side] ?? {};
      if (!isRecord(members)) throw new Refused("invalid", `declares.${side} must be an object.`);
      return [side, Object.entries(members)] as const;
    });
    // Counted before anything is compiled: an over-long hello costs the Hub no work.
    if (sides.reduce((n, [, members]) => n + members.length, 0) > MAX_DECLARED)
      throw new Refused("invalid", `A hello declares at most ${MAX_DECLARED} interfaces.`);
    for (const [side, members] of sides)
      for (const [name, iface] of members)
        out[side][name] = await this.#described(actor, iface, `declares.${side}.${name}`);
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
    // Any other kind could only come from a program built against an older SDK.
    if ((iface as { kind?: unknown }).kind !== "rpc")
      throw new Refused("invalid", `${iface.id} isn't an rpc interface.`);
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
        default:
          throw new Refused("invalid", `A ${header.op} stream can't be opened here.`);
      }
    } catch (error) {
      await answer(writer, errorBody(error));
      drain(reader);
    }
  }

  /** Keep an open subscription under its binding, so the binding's end ends it. */
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

  /** A consumer's slot, resolved through its binding to a live provider. */
  #resolve(caller: string, slot: string): Resolved {
    const resolved = this.state.resolveCall(caller, slot);
    if (!resolved) throw new NotConnected(slot);
    const { binding, target } = resolved;
    if (binding.mismatched)
      throw new Refused(
        "version_mismatch",
        `${slot} and ${this.state.named(binding.provider)}'s ${binding.export} are at different versions of ${binding.interface}; calls go through again once both declare the same version.`,
      );
    // The hub is served in this process; any other provider needs its channel.
    const builtin = binding.provider === HUB;
    const provider = builtin ? undefined : this.#connections.get(binding.provider);
    if (!builtin && !provider) throw new NotConnected(slot);
    return { binding, iface: target.iface, provider };
  }

  #audit(
    caller: string,
    slot: string,
    binding: BindingRecord | undefined,
    call: { op: "call" | "subscribe"; method?: string; outcome: CallOutcome },
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
    // Once the input is read, this watches the rest of the caller's stream (and so drains it).
    let cancelled: Promise<void> | undefined;
    const { frame } = await this.#invoke(conn.actorId, header.slot, header.method, async () => {
      const body = parseBody(await reader.next());
      cancelled = whenReset(reader);
      if (!("input" in body)) throw new Refused("invalid", "A call's body is {input}.");
      return { value: body.input, cancelled };
    });
    await answer(writer, frame);
    if (!cancelled) drain(reader);
  }

  /**
   * A call through a caller's slot: resolve it, check the input, reach the
   * provider, check the output, audit. `input` gives the value (and how the caller cancels) once
   * the slot is known to have the method.
   */
  async #invoke(
    caller: string,
    slot: string,
    method: string,
    input: () => Promise<{ value: unknown; cancelled: Promise<void> }>,
  ): Promise<{ body: Body; frame: Uint8Array }> {
    let binding: BindingRecord | undefined;
    let reply: Body;
    let outcome: CallOutcome = "ok";
    try {
      const resolved = this.#resolve(caller, slot);
      binding = resolved.binding;
      const { iface, provider } = resolved;
      const part: Part = { method, side: "input" };
      if (!this.#validators.has(iface, part))
        throw new Refused("invalid", `${iface.id} has no method ${method}.`);
      const { value, cancelled } = await input();
      await this.#validators.check(caller, iface, part, value, "invalid");
      reply = provider
        ? await this.#forward(provider, binding, caller, method, value, cancelled)
        : await this.#builtinCall(binding, method, caller, value);
      if ("error" in reply) outcome = "refused";
      else if ("result" in reply)
        await this.#validators.check(
          caller,
          iface,
          { method, side: "output" },
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
    this.#audit(caller, slot, binding, { op: "call", method, outcome });
    return encoded;
  }

  /** A call to the hub's own exports. */
  async #builtinCall(
    binding: BindingRecord,
    method: string,
    caller: string,
    value: unknown,
  ): Promise<Body> {
    try {
      return result(asJson(await this.#actor.call(binding.export, method, caller, value)));
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
        encodeFrame({
          op: "serve",
          kind: "call",
          export: binding.export,
          caller,
          slot: binding.slot,
          method,
        }),
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
      timer = setTimeout(
        () => resolve("late"),
        this.#answerTimeoutsMs[binding.interface] ?? this.#answerTimeoutMs,
      );
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
  #subscribe(
    conn: Connection,
    header: { slot: string; event: string },
    stream: YamuxStream,
    reader: FrameReader,
    writer: Writer,
  ) {
    const stop = this.#subscribeCore(conn.actorId, header.slot, header.event, {
      send: async (_, frame) => {
        await writer.write(frame);
      },
      end: (error, cutOff) => {
        // A subscriber that stops reading is cut off, not buffered for: its stream is reset.
        if (cutOff) return stream.reset();
        if (error) void answer(writer, error);
        else void writer.close().catch(() => {});
      },
    });
    if (!stop) return drain(reader);
    // A reset (or anything but a clean end of its side) from the subscriber ends it.
    reader.next().then(
      (more) =>
        more !== undefined && stop(wireError("Refused", "A subscriber sends nothing.", "invalid")),
      () => stop(),
    );
  }

  /**
   * Events of a caller's slot: each checked, then handed to `sink` in order, the
   * next waiting for the last to be taken, until the provider ends it, the binding goes, or the
   * returned `stop` runs. A refusal at the start ends the sink at once and returns nothing.
   */
  #subscribeCore(caller: string, slot: string, event: string, sink: Sink) {
    let resolved: Resolved | undefined;
    const part: Part = { event };
    try {
      resolved = this.#resolve(caller, slot);
      if (!this.#validators.has(resolved.iface, part))
        throw new Refused("invalid", `${resolved.iface.id} has no event ${event}.`);
    } catch (error) {
      const body = errorBody(error);
      this.#audit(caller, slot, resolved?.binding, {
        op: "subscribe",
        method: event,
        outcome: outcomeOf(body.error),
      });
      sink.end(body);
      return undefined;
    }
    const { binding, iface, provider } = resolved;
    this.#audit(caller, slot, binding, { op: "subscribe", method: event, outcome: "ok" });
    let stopProvider = () => {};
    let ended = false;
    let queued = 0;
    const untrack = this.#track(binding, (error) => end(error));
    const end = (error?: WireError, cutOff?: boolean) => {
      if (ended) return;
      ended = true;
      untrack();
      stopProvider();
      sink.end(error, cutOff);
    };
    // Events are checked off-thread, so each waits its turn here to keep them in order.
    let delivered = Promise.resolve();
    const deliver = (payload: unknown): Promise<void> => {
      if (ended) return delivered;
      const { frame } = frameOf(eventBody(payload));
      const size = frame.length;
      if (queued + size > MAX_QUEUED_BYTES) {
        end(wireError("Refused", "The subscriber stopped reading.", "slow"), true);
        return delivered;
      }
      queued += size;
      delivered = delivered.then(async () => {
        try {
          if (ended) return;
          await this.#validators.check(caller, iface, part, payload, "bad_output");
          if (ended) return;
          await sink.send(payload, frame);
        } catch (error) {
          // A refused event (bad_output) or the subscriber failing to take it.
          end(
            error instanceof Refused
              ? errorBody(error)
              : wireError(
                  "Refused",
                  error instanceof Error ? error.message : String(error),
                  "failed",
                ),
          );
        } finally {
          queued -= size;
        }
      });
      return delivered;
    };
    if (!provider) {
      stopProvider = this.#actor.subscribe(binding.export, event, {
        caller,
        emit: (payload) => {
          let value: unknown;
          try {
            value = asJson(payload);
          } catch (error) {
            return end(
              wireError("Refused", `An event that isn't JSON: ${String(error)}`, "bad_output"),
            );
          }
          void deliver(value);
        },
      });
      return end;
    }
    let out: YamuxStream;
    try {
      out = provider.session.open();
    } catch {
      end(errorBody(new NotConnected(slot)));
      return end;
    }
    stopProvider = () => out.reset();
    void (async () => {
      try {
        const upstream = out.writable.getWriter();
        await upstream.write(
          encodeFrame({
            op: "serve",
            kind: "subscribe",
            export: binding.export,
            caller,
            slot: binding.slot,
            event,
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
            : errorBody(new NotConnected(slot)),
        );
      }
    })();
    return end;
  }
}
