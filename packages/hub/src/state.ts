import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hubActors, hubAudit, hubBindings, hubExports, hubGrants } from "@agentorg/interfaces";
import {
  compareInterfaces,
  type DescribedInterface,
  describeInterface,
  hashInterface,
  type InterfaceSchemas,
  Refused,
} from "@agentorg/sdk";

/** The built-in Actor that exports management. */
export const HUB = "hub";
/** The person's Actor, created at first start with every `hub.*` binding. */
export const PERSON = "person";
/** The hub's exports, each the authority for its own part of management. */
const HUB_EXPORTS = {
  actors: hubActors,
  bindings: hubBindings,
  grants: hubGrants,
  exports: hubExports,
  audit: hubAudit,
};

export type ActorState = "created" | "running" | "stopped" | "closed";
export interface ActorRecord {
  actorId: string;
  name: string;
  /** `external` for a program that connects itself, `builtin` for the hub; an earlier release's package Actor keeps its hash. */
  package: string;
  state: ActorState;
}
export interface Wiring {
  consumer: string;
  slot: string;
  provider: string;
  export: string;
}
export interface BindingRecord extends Wiring {
  interface: string;
  madeBy: string;
  at: string;
  /** Its slot was made at run time by `expose`, and goes with it. */
  exposed?: true;
}
/** The two ends of a binding: the export side gives the export, the slot side takes it. */
export type Side = "export" | "slot";
export interface AuditRecord {
  seq: number;
  at: string;
  actor: string;
  kind: string;
  details: Record<string, unknown>;
}
/** A slot or export of an Actor, with the interface it takes or offers. */
export interface Declaration {
  actor: string;
  side: "slot" | "export";
  name: string;
  iface: DescribedInterface;
  dynamic: boolean;
}
/** How a call through a binding ended, for the audit trail. */
export type CallOutcome =
  | "ok"
  | "invalid"
  | "bad_output"
  | "refused"
  | "not_connected"
  | "outcome_unknown"
  /** The caller reset the stream before the provider answered. */
  | "cancelled";

/**
 * What the router listens for. Each is sent after the change commits, never for a change that
 * rolled back, and a listener that throws can't undo it.
 */
export interface StateEvents {
  bound?(binding: BindingRecord): void;
  /** Bindings that ended, by unbind, redeclaration or closing. */
  unbound?(bindings: BindingRecord[]): void;
  exportsChanged?(actor: string): void;
  /** An Actor's record changed: it was made or closed. */
  actorChanged?(actorId: string): void;
  /** An Actor was closed for good: its channel should go too. */
  closed?(actorId: string): void;
  audited?(entry: AuditRecord): void;
}

const NAME = /^[a-z][A-Za-z0-9_]*$/;
/** The longest name of a slot made at run time, so a tool named `<slot>__<method>` fits. */
const EXPOSED_MAX = 48;

/**
 * The default name of a slot exposing `exportName` of the Actor named `providerName`: the name's
 * ASCII words camelCased, `_`, and the export's last part; the export's part alone when the name
 * has no ASCII letters.
 */
export function exposedName(providerName: string, exportName: string): string {
  const words = (providerName.match(/[A-Za-z0-9]+/g) ?? []).map((word) => word.toLowerCase());
  const joined = words
    .map((word, i) => (i ? word[0]?.toUpperCase() + word.slice(1) : word))
    .join("");
  const letters = joined.replace(/^[^A-Za-z]+/, "");
  const camel = letters && (letters[0] ?? "").toLowerCase() + letters.slice(1);
  const part = exportName.slice(exportName.lastIndexOf(".") + 1);
  return (camel ? `${camel}_${part}` : part).slice(0, EXPOSED_MAX);
}
const now = () => new Date().toISOString();
const digest = (secret: string) => createHash("sha256").update(secret).digest();

/** Each entry moves the home's database up one version; `user_version` records where it is. */
const MIGRATIONS = [
  `CREATE TABLE actors (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, package TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('created', 'running', 'stopped', 'closed')),
     credential BLOB, created_at TEXT NOT NULL,
     restarts INTEGER NOT NULL DEFAULT 0, last_exit TEXT);
   CREATE TABLE packages (
     hash TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL,
     manifest TEXT NOT NULL, added_by TEXT NOT NULL, added_at TEXT NOT NULL);
   CREATE TABLE declarations (
     actor TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('slot', 'export')), name TEXT NOT NULL,
     iface TEXT NOT NULL, dynamic INTEGER NOT NULL, PRIMARY KEY (actor, side, name));
   CREATE TABLE bindings (
     consumer TEXT NOT NULL, slot TEXT NOT NULL, provider TEXT NOT NULL, export TEXT NOT NULL,
     interface TEXT NOT NULL, made_by TEXT NOT NULL, at TEXT NOT NULL,
     PRIMARY KEY (consumer, slot));
   CREATE INDEX bindings_by_provider ON bindings (provider, export);
   CREATE TABLE requests (
     id TEXT PRIMARY KEY, consumer TEXT NOT NULL, slot TEXT NOT NULL, provider TEXT NOT NULL,
     export TEXT NOT NULL, reason TEXT NOT NULL, requested_by TEXT NOT NULL, at TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('open', 'approved', 'declined', 'closed')),
     needs TEXT NOT NULL CHECK (needs IN ('export', 'slot')));
   CREATE TABLE audit (
     seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL,
     kind TEXT NOT NULL, details TEXT NOT NULL);`,
  // Exposure: an Actor made for another (provenance only), and requests to expose.
  `ALTER TABLE actors ADD COLUMN installed_for TEXT;
   ALTER TABLE requests ADD COLUMN exposed INTEGER NOT NULL DEFAULT 0;`,
  // The built-in storage and network and the package store are gone; an earlier home's records
  // of them go too. The packages table stays, unread.
  `DELETE FROM bindings WHERE provider IN ('storage', 'net');
   DELETE FROM bindings WHERE provider = 'hub' AND export = 'packages';
   DELETE FROM declarations WHERE actor = 'hub' AND side = 'export' AND name = 'packages';
   DELETE FROM declarations WHERE actor = 'person' AND side = 'slot' AND name = 'packages';
   DELETE FROM declarations WHERE actor IN ('storage', 'net');
   UPDATE actors SET state = 'closed' WHERE id IN ('storage', 'net');`,
];

/** Whether a process with this pid runs now. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take the home for this process: `hub.lock` holds the pid of the one Hub open in it. A lock left
 * by a process that is gone is taken over; one held by a live process is refused.
 */
function lock(home: string) {
  const file = join(home, "hub.lock");
  for (let attempt = 0; ; attempt++)
    try {
      writeFileSync(file, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw error;
      const pid = Number.parseInt(readFileSync(file, "utf8"), 10);
      if (pid > 0 && alive(pid)) throw new Error(`Another Hub has ${home} open (process ${pid}).`);
      rmSync(file, { force: true });
    }
}

function unlock(home: string) {
  const file = join(home, "hub.lock");
  try {
    if (Number.parseInt(readFileSync(file, "utf8"), 10) === process.pid) rmSync(file);
  } catch {
    // Already gone.
  }
}

type Row = Record<string, unknown>;
const bindingOf = (row: Row): BindingRecord => ({
  consumer: String(row.consumer),
  slot: String(row.slot),
  provider: String(row.provider),
  export: String(row.export),
  interface: String(row.interface),
  madeBy: String(row.made_by),
  at: String(row.at),
  ...(row.exposed ? { exposed: true as const } : {}),
});
/** A binding's columns, with whether its slot was made at run time. */
const BINDING = `b.*, (SELECT d.dynamic FROM declarations d
  WHERE d.actor = b.consumer AND d.side = 'slot' AND d.name = b.slot) AS exposed`;
/**
 * The core's state in its home folder: Actors, declarations, bindings
 * and the audit trail, in `node:sqlite`. Every method that changes something takes its caller, and
 * each is checked against bindings: there is no other authority.
 */
export class HubState {
  readonly home: string;
  readonly #db: DatabaseSync;
  readonly #events: StateEvents;
  /** Events waiting for the transaction they belong to; sent after it commits. */
  #outbox?: (() => void)[];

  private constructor(home: string, events: StateEvents) {
    this.home = home;
    this.#events = events;
    chmodSync(home, 0o700);
    const file = join(home, "hub.db");
    this.#db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    const { user_version: version } = this.#db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (version > MIGRATIONS.length)
      throw new Error(
        `The Hub home is from a newer version (${version}); it can't be opened here.`,
      );
    for (let next = version; next < MIGRATIONS.length; next++)
      this.#transaction(() => {
        this.#db.exec(MIGRATIONS[next] as string);
        this.#db.exec(`PRAGMA user_version = ${next + 1}`);
      });
    for (const suffix of ["-wal", "-shm"])
      try {
        chmodSync(file + suffix, 0o600);
      } catch {
        // Not created yet.
      }
  }

  /**
   * Open the Hub home. Each start makes sure the `hub` Actor declares every management export and
   * the person is bound to each; the first also creates the person, with its credential in
   * `person-credential` (0600).
   */
  static open(home: string, events: StateEvents = {}): HubState {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    lock(home);
    try {
      const state = new HubState(home, events);
      state.#bootstrap();
      return state;
    } catch (error) {
      unlock(home);
      throw error;
    }
  }

  close(): void {
    if (!this.#db.isOpen) return;
    this.#db.close();
    unlock(this.home);
  }

  #bootstrap() {
    this.#transaction(() => {
      if (!this.#actor(HUB)) {
        const at = now();
        this.#db
          .prepare(
            "INSERT INTO actors (id, name, package, state, credential, created_at) VALUES (?, 'hub', 'builtin', 'running', NULL, ?)",
          )
          .run(HUB, at);
        const credential = randomBytes(32).toString("base64url");
        this.#db
          .prepare(
            "INSERT INTO actors (id, name, package, state, credential, created_at) VALUES (?, 'person', 'external', 'created', ?, ?)",
          )
          .run(PERSON, digest(credential), at);
        // The file is on disk before the row commits, so a crash can't leave a person no one can sign in as.
        const file = join(this.home, "person-credential");
        const fd = openSync(`${file}.tmp`, "w", 0o600);
        try {
          writeSync(fd, `${credential}\n`);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(`${file}.tmp`, file);
        const dir = openSync(this.home, "r");
        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
        this.#audit(HUB, "bootstrap", { person: PERSON });
      }
      for (const [name, iface] of Object.entries(HUB_EXPORTS)) {
        const described = describeInterface(iface);
        this.#declare(HUB, "export", name, described, false);
        this.#declare(PERSON, "slot", name, described, false);
        const bound = this.binding(PERSON, name);
        if (bound && (bound.provider !== HUB || bound.export !== name)) {
          this.#removeBindings("consumer = ? AND slot = ?", PERSON, name);
          this.#insertBinding({ consumer: PERSON, slot: name, provider: HUB, export: name }, HUB);
        } else if (!bound)
          this.#insertBinding({ consumer: PERSON, slot: name, provider: HUB, export: name }, HUB);
        else if (bound.interface !== described.id)
          this.#db
            .prepare("UPDATE bindings SET interface = ? WHERE consumer = ? AND slot = ?")
            .run(described.id, PERSON, name);
      }
    });
  }

  #transaction<T>(work: () => T): T {
    if (this.#outbox) return work();
    this.#db.exec("BEGIN IMMEDIATE");
    const sends: (() => void)[] = [];
    this.#outbox = sends;
    let out: T;
    try {
      out = work();
      this.#db.exec("COMMIT");
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // SQLite already rolled back.
      }
      throw error;
    } finally {
      this.#outbox = undefined;
    }
    for (const send of sends)
      try {
        send();
      } catch {
        // A listener's failure is its own; the change stands.
      }
    return out;
  }

  /** Send an event once the current transaction commits. */
  #emit(send: () => void) {
    if (this.#outbox) this.#outbox.push(send);
    else send();
  }

  #audit(actor: string, kind: string, details: Record<string, unknown>) {
    const at = now();
    const { lastInsertRowid } = this.#db
      .prepare("INSERT INTO audit (at, actor, kind, details) VALUES (?, ?, ?, ?)")
      .run(at, actor, kind, JSON.stringify(details));
    // Subscribers hear it through JSON, as the router sends every in-process event: as stored.
    const entry = { seq: Number(lastInsertRowid), at, actor, kind, details };
    this.#emit(() => this.#events.audited?.(entry));
  }

  /** Record a call's metadata: who, through which binding, which method, and how it ended. */
  auditCall(
    caller: string,
    /** The binding the call went through; an unbound slot has only its consumer and slot. */
    binding: Pick<Wiring, "consumer" | "slot"> & Partial<Wiring>,
    call: { op: "call" | "subscribe" | "open" | "http"; method?: string; outcome: CallOutcome },
  ): void {
    this.#transaction(() => this.#audit(caller, "call", { ...binding, ...call }));
  }

  // ── Actors ──────────────────────────────────────────────────────────────────

  #actor(actorId: string): ActorRecord | undefined {
    const row = this.#db
      .prepare("SELECT id, name, package, state FROM actors WHERE id = ?")
      .get(actorId) as Row | undefined;
    return (
      row && {
        actorId: String(row.id),
        name: String(row.name),
        package: String(row.package),
        state: row.state as ActorState,
      }
    );
  }

  /** An Actor as a refusal names it: "Name (id)", or the id alone when there's no such Actor. */
  named(actorId: string): string {
    const actor = this.#actor(actorId);
    return actor ? `${actor.name} (${actor.actorId})` : actorId;
  }

  actor(actorId: string): ActorRecord {
    const actor = this.#actor(actorId);
    if (!actor) throw new Refused("unknown", `No Actor ${actorId}; hub.actors.list lists them.`);
    return actor;
  }

  actors(): ActorRecord[] {
    const rows = this.#db.prepare("SELECT id FROM actors ORDER BY created_at, id").all() as Row[];
    return rows.map((row) => this.actor(String(row.id)));
  }

  /** Whether the caller is bound to one of the hub's exports: the authority for that part. */
  holds(caller: string, hubExport: keyof typeof HUB_EXPORTS): boolean {
    return !!this.#db
      .prepare("SELECT 1 FROM bindings WHERE consumer = ? AND provider = ? AND export = ?")
      .get(caller, HUB, hubExport);
  }

  #require(caller: string, hubExport: keyof typeof HUB_EXPORTS) {
    if (!this.holds(caller, hubExport))
      throw new Refused(
        "forbidden",
        `${this.named(caller)} isn't bound to hub.${hubExport}@1; a manager (the person) can bind it, or do this for it.`,
      );
  }

  /** Create an Actor: a program that connects itself, with a credential that comes back once. */
  createActor(
    caller: string,
    input: {
      name: string;
      /**
       * Initial bindings for the new Actor's slots, made with the caller's export-side authority;
       * the creation is the slot side's yes. An external Actor's slot is declared with the
       * export's interface, and its hello must declare it the same way to keep it.
       */
      bindings?: Omit<Wiring, "consumer">[];
    },
  ): { actorId: string; credential: string } {
    this.#require(caller, "actors");
    const actorId = `act_${randomBytes(8).toString("hex")}`;
    const credential = randomBytes(32).toString("base64url");
    const insert = this.#db.prepare(
      "INSERT INTO actors (id, name, package, state, credential, created_at) VALUES (?, ?, 'external', 'created', ?, ?)",
    );
    this.#transaction(() => {
      insert.run(actorId, input.name, digest(credential), now());
      this.#audit(caller, "actor.create", {
        actorId,
        name: input.name,
      });
      this.#emit(() => this.#events.actorChanged?.(actorId));
      for (const initial of input.bindings ?? []) {
        const wiring = { consumer: actorId, ...initial };
        if (!this.sides(caller, wiring).export)
          throw new Refused(
            "forbidden",
            `${this.named(caller)} can't grant ${this.named(initial.provider)}'s ${initial.export}: only a manager, the provider or an Actor bound to that export can.`,
          );
        if (!this.declaration(actorId, "slot", initial.slot)) {
          if (!NAME.test(initial.slot))
            throw new Refused(
              "invalid",
              `${JSON.stringify(initial.slot)} isn't a valid slot name.`,
            );
          const offered = this.declaration(initial.provider, "export", initial.export);
          if (!offered)
            throw new Refused(
              "unknown",
              `${this.named(initial.provider)} offers no ${initial.export}; hub.exports.list lists what it offers.`,
            );
          this.#declare(actorId, "slot", initial.slot, offered.iface, false);
        }
        this.#insertBinding(wiring, caller);
      }
    });
    return { actorId, credential };
  }

  /** Whether an external Actor's credential is right, compared in constant time. */
  authenticate(actorId: string, credential: string): boolean {
    const row = this.#db
      .prepare("SELECT credential, state FROM actors WHERE id = ? AND package = 'external'")
      .get(actorId) as { credential: Uint8Array | null; state: ActorState } | undefined;
    if (!row?.credential || row.state === "closed") return false;
    // Both sides are SHA-256 digests, so the lengths always match.
    return timingSafeEqual(Buffer.from(row.credential), digest(credential));
  }

  /** Close an Actor for good: its bindings both ways and its declarations go. */
  closeActor(caller: string, actorId: string): void {
    this.#require(caller, "actors");
    const actor = this.actor(actorId);
    if (actorId === HUB || actorId === PERSON)
      throw new Refused("forbidden", `${this.named(actorId)} is built in and can't be closed.`);
    if (actor.state === "closed") return;
    this.#transaction(() => {
      this.#db.prepare("UPDATE actors SET state = 'closed' WHERE id = ?").run(actorId);
      this.#removeBindings("consumer = ? OR provider = ?", actorId, actorId);
      this.#db.prepare("DELETE FROM declarations WHERE actor = ?").run(actorId);
      this.#audit(caller, "actor.close", { actorId });
      this.#emit(() => this.#events.exportsChanged?.(actorId));
      this.#emit(() => this.#events.actorChanged?.(actorId));
      this.#emit(() => this.#events.closed?.(actorId));
    });
  }

  /**
   * Drop the bindings through one of an Actor's slots or exports, its interface having changed,
   * but those `keeps` says still match: each is audited as `binding.drop`. Dropping only takes
   * access away. Returns what was dropped.
   */
  #dropBindingsOf(
    actorId: string,
    side: Side,
    name: string,
    by: string,
    keeps: (binding: Wiring) => boolean = () => false,
  ): Wiring[] {
    const dropped = this.bindings(actorId).filter(
      (b) =>
        (side === "slot"
          ? b.consumer === actorId && b.slot === name
          : b.provider === actorId && b.export === name) && !keeps(b),
    );
    for (const b of dropped) this.#removeBindings("consumer = ? AND slot = ?", b.consumer, b.slot);
    const wirings = dropped.map(({ consumer, slot, provider, export: exported }) => ({
      consumer,
      slot,
      provider,
      export: exported,
    }));
    for (const wiring of wirings)
      this.#audit(by, "binding.drop", { ...wiring, why: "its interface changed" });
    return wirings;
  }

  // ── Declarations: what each Actor takes and offers ──────────────────────────

  #declare(
    actor: string,
    side: "slot" | "export",
    name: string,
    iface: DescribedInterface,
    dynamic: boolean,
  ) {
    this.#db
      .prepare(
        "INSERT OR REPLACE INTO declarations (actor, side, name, iface, dynamic) VALUES (?, ?, ?, ?, ?)",
      )
      .run(actor, side, name, JSON.stringify(iface), dynamic ? 1 : 0);
  }

  /** How many slots an Actor declares. */
  slotCount(actor: string): number {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n FROM declarations WHERE actor = ? AND side = 'slot'")
      .get(actor) as { n: number };
    return Number(row.n);
  }

  declaration(actor: string, side: "slot" | "export", name: string): Declaration | undefined {
    const row = this.#db
      .prepare("SELECT iface, dynamic FROM declarations WHERE actor = ? AND side = ? AND name = ?")
      .get(actor, side, name) as Row | undefined;
    return (
      row && { actor, side, name, iface: JSON.parse(String(row.iface)), dynamic: !!row.dynamic }
    );
  }

  /** An interface as declared by an Actor, checked: its hash must be its schemas'. */
  #checked(iface: DescribedInterface): DescribedInterface {
    const { hash, ...schemas } = iface;
    let recomputed: string | undefined;
    try {
      recomputed = hashInterface(schemas as InterfaceSchemas);
    } catch {
      recomputed = undefined;
    }
    if (recomputed !== hash)
      throw new Refused("invalid", `${iface.id}'s hash doesn't match its schemas.`);
    return iface;
  }

  #open(actorId: string): ActorRecord {
    const actor = this.actor(actorId);
    if (actor.state === "closed")
      throw new Refused("state", `${this.named(actorId)} is closed for good; make another.`);
    return actor;
  }

  /**
   * An external Actor's slots and static exports, as it declares them when it connects; they
   * replace what it declared before. A name redeclared as another interface loses its bindings
   * (audited as `binding.drop`), since a binding holds only while both ends declare the same one.
   * A name it no longer declares is dropped, with its bindings.
   */
  declareExternal(
    actorId: string,
    declares: {
      slots: Record<string, DescribedInterface>;
      exports: Record<string, DescribedInterface>;
    },
  ): void {
    this.#open(actorId);
    this.#transaction(() => {
      for (const [side, members] of [
        ["slot", declares.slots],
        ["export", declares.exports],
      ] as const) {
        for (const [name, iface] of Object.entries(members)) {
          if (!NAME.test(name))
            throw new Refused("invalid", `${JSON.stringify(name)} isn't a valid name.`);
          this.#checked(iface);
          if (side === "slot") {
            // The Actor's own slots are its to name: an exposure under the same name yields,
            // with its binding.
            if (this.declaration(actorId, side, name)?.dynamic) this.#drop(actorId, side, name);
          }
          // A binding holds while both ends declare the same interface: redeclared as another,
          // the name's bindings whose other end doesn't declare it are dropped.
          const known = this.declaration(actorId, side, name);
          if (known && compareInterfaces(known.iface, iface) !== "same") {
            this.#dropBindingsOf(actorId, side, name, actorId, (b) => {
              const other =
                side === "slot"
                  ? this.declaration(b.provider, "export", b.export)?.iface
                  : this.declaration(b.consumer, "slot", b.slot)?.iface;
              return !!other && compareInterfaces(iface, other) === "same";
            });
          }
          this.#declare(actorId, side, name, iface, false);
        }
        const kept = Object.keys(members);
        const stale = (
          this.#db
            .prepare("SELECT name FROM declarations WHERE actor = ? AND side = ? AND dynamic = 0")
            .all(actorId, side) as Row[]
        )
          .map((row) => String(row.name))
          // The person's hub slots aren't its to drop.
          .filter(
            (name) =>
              !kept.includes(name) && !(actorId === PERSON && Object.hasOwn(HUB_EXPORTS, name)),
          );
        for (const name of stale) this.#drop(actorId, side, name);
      }
      this.#emit(() => this.#events.exportsChanged?.(actorId));
    });
  }

  /** A declaration gone, and the bindings through it. */
  #drop(actor: string, side: "slot" | "export", name: string) {
    this.#db
      .prepare("DELETE FROM declarations WHERE actor = ? AND side = ? AND name = ?")
      .run(actor, side, name);
    const where = side === "slot" ? "consumer = ? AND slot = ?" : "provider = ? AND export = ?";
    this.#removeBindings(where, actor, name);
  }

  exports(actor?: string): {
    actor: string;
    export: string;
    interface: string;
    hash: string;
  }[] {
    const rows = this.#db
      .prepare(
        `SELECT d.actor, d.name, d.iface FROM declarations d JOIN actors a ON a.id = d.actor
         WHERE d.side = 'export' AND a.state != 'closed' ${actor ? "AND d.actor = ?" : ""}
         ORDER BY d.actor, d.name`,
      )
      .all(...(actor ? [actor] : [])) as Row[];
    return rows.map((row) => {
      const iface = JSON.parse(String(row.iface)) as DescribedInterface;
      return {
        actor: String(row.actor),
        export: String(row.name),
        interface: iface.id,
        hash: iface.hash,
      };
    });
  }

  // ── Bindings: a binding is the grant ────────────────────────────────────────

  binding(consumer: string, slot: string): BindingRecord | undefined {
    const row = this.#db
      .prepare(`SELECT ${BINDING} FROM bindings b WHERE consumer = ? AND slot = ?`)
      .get(consumer, slot) as Row | undefined;
    return row && bindingOf(row);
  }

  /**
   * What a call through a consumer's slot reaches: its binding and the provider's export, with the
   * schemas to validate against. Nothing when the slot is unbound.
   */
  resolveCall(
    consumer: string,
    slot: string,
  ): { binding: BindingRecord; target: Declaration } | undefined {
    const binding = this.binding(consumer, slot);
    if (!binding) return undefined;
    const target = this.declaration(binding.provider, "export", binding.export);
    return target && { binding, target };
  }

  bindings(actor?: string): BindingRecord[] {
    const rows = actor
      ? this.#db
          .prepare(
            `SELECT ${BINDING} FROM bindings b WHERE consumer = ? OR provider = ? ORDER BY b.rowid`,
          )
          .all(actor, actor)
      : this.#db.prepare(`SELECT ${BINDING} FROM bindings b ORDER BY b.rowid`).all();
    return (rows as Row[]).map(bindingOf);
  }

  /** A manager is bound to the hub's `hub.bindings@1`; there is no other role. */
  isManager(actor: string): boolean {
    return this.holds(actor, "bindings");
  }

  /**
   * The binding authority rule, in one place. A binding needs both ends: the export side is its
   * provider, an Actor already bound to that export, or a manager; the slot side is the consumer
   * itself, or a manager.
   */
  sides(caller: string, wiring: Wiring): Record<Side, boolean> {
    const manager = this.isManager(caller);
    return {
      export:
        manager ||
        caller === wiring.provider ||
        !!this.#db
          .prepare("SELECT 1 FROM bindings WHERE consumer = ? AND provider = ? AND export = ?")
          .get(caller, wiring.provider, wiring.export),
      slot: manager || caller === wiring.consumer,
    };
  }

  /** The two ends exist, are live, and take and offer the same interface. */
  #ends(wiring: Wiring): string {
    this.#open(wiring.consumer);
    this.#open(wiring.provider);
    const slot = this.declaration(wiring.consumer, "slot", wiring.slot);
    if (!slot)
      throw new Refused(
        "unknown",
        `${this.named(wiring.consumer)} has no slot ${wiring.slot}; hub.grants.expose makes one at run time.`,
      );
    const exported = this.declaration(wiring.provider, "export", wiring.export);
    if (!exported)
      throw new Refused(
        "unknown",
        `${this.named(wiring.provider)} offers no ${wiring.export}; hub.exports.list lists what it offers.`,
      );
    const fit = compareInterfaces(slot.iface, exported.iface);
    if (fit === "unrelated")
      throw new Refused(
        "conflict",
        `${wiring.slot} takes ${slot.iface.id}; ${wiring.export} offers ${exported.iface.id}.`,
      );
    if (fit === "conflict")
      throw new Refused("conflict", `Both are ${slot.iface.id}, but their schemas differ.`);
    return slot.iface.id;
  }

  #insertBinding(wiring: Wiring, madeBy: string) {
    const iface = this.#ends(wiring);
    if (this.binding(wiring.consumer, wiring.slot))
      throw new Refused(
        "bound",
        `${this.named(wiring.consumer)}'s ${wiring.slot} is already bound; unbind it first.`,
      );
    const at = now();
    this.#db
      .prepare(
        "INSERT INTO bindings (consumer, slot, provider, export, interface, made_by, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(wiring.consumer, wiring.slot, wiring.provider, wiring.export, iface, madeBy, at);
    this.#audit(madeBy, "bind", { ...wiring, interface: iface });
    const record = { ...wiring, interface: iface, madeBy, at };
    this.#emit(() => this.#events.bound?.(record));
  }

  #removeBindings(where: string, ...params: string[]) {
    const removed = (
      this.#db.prepare(`SELECT ${BINDING} FROM bindings b WHERE ${where}`).all(...params) as Row[]
    ).map(bindingOf);
    if (!removed.length) return;
    if (removed.some((b) => b.consumer === PERSON && b.provider === HUB && !b.exposed))
      throw new Refused(
        "forbidden",
        "The person's hub bindings stay, so someone can always manage the Hub.",
      );
    this.#db.prepare(`DELETE FROM bindings WHERE ${where}`).run(...params);
    // A slot made at run time goes with its binding.
    const dropExposed = this.#db.prepare(
      "DELETE FROM declarations WHERE actor = ? AND side = 'slot' AND name = ? AND dynamic = 1",
    );
    for (const binding of removed)
      if (binding.exposed) dropExposed.run(binding.consumer, binding.slot);
    this.#emit(() => this.#events.unbound?.(removed));
  }

  /** Bind a slot to an export: the caller must hold both ends. */
  bind(caller: string, wiring: Wiring): { bound: true } {
    const sides = this.sides(caller, wiring);
    if (!(sides.export && sides.slot))
      throw new Refused(
        "forbidden",
        `${this.named(caller)} doesn't hold both ends of this binding: the export side is ${this.named(wiring.provider)}, the slot side ${this.named(wiring.consumer)}. A manager can bind it.`,
      );
    this.#transaction(() => this.#insertBinding(wiring, caller));
    return { bound: true };
  }

  /** Unbind a slot: its consumer, its provider or a manager may. */
  unbind(caller: string, consumer: string, slot: string): void {
    const binding = this.binding(consumer, slot);
    if (!binding) throw new Refused("unknown", `${this.named(consumer)}'s ${slot} isn't bound.`);
    if (caller !== consumer && caller !== binding.provider && !this.isManager(caller))
      throw new Refused(
        "forbidden",
        `${this.named(caller)} can't unbind ${this.named(consumer)}'s ${slot}: its consumer, its provider or a manager can.`,
      );
    this.#transaction(() => {
      this.#removeBindings("consumer = ? AND slot = ?", consumer, slot);
      this.#audit(caller, "unbind", {
        consumer,
        slot,
        provider: binding.provider,
        export: binding.export,
      });
    });
  }

  /**
   * Expose an export to one Actor: a slot made on `to` at run time, typed by the export's
   * interface and bound to it, in one step. The caller must hold both ends, with `to` as the
   * consumer. The same export already exposed to `to` gives that slot back.
   */
  expose(
    caller: string,
    input: { provider: string; export: string; to: string; as?: string },
  ): { exposed: true; slot: string } {
    const to = this.#open(input.to);
    const provider = this.#open(input.provider);
    // Authority first: a caller without it learns nothing more.
    const ends = { consumer: to.actorId, provider: provider.actorId, export: input.export };
    const sides = this.sides(caller, { ...ends, slot: "" });
    if (!(sides.export && sides.slot))
      throw new Refused(
        "forbidden",
        `${this.named(caller)} can't expose ${input.export} of ${this.named(provider.actorId)} to ${this.named(to.actorId)}: a manager can.`,
      );
    if (to.actorId === HUB)
      throw new Refused(
        "forbidden",
        `${this.named(to.actorId)} is the Hub itself and takes no slots.`,
      );
    const offered = this.declaration(provider.actorId, "export", input.export);
    if (!offered)
      throw new Refused("unknown", `${this.named(provider.actorId)} offers no ${input.export}.`);
    if (offered.iface.kind !== "rpc")
      throw new Refused(
        "unsupported",
        `Only an rpc export can be exposed; ${input.export} is ${offered.iface.kind}.`,
      );
    const already = this.bindings(to.actorId).find(
      (b) =>
        b.consumer === to.actorId &&
        b.exposed &&
        b.provider === provider.actorId &&
        b.export === input.export,
    );
    if (already && (input.as === undefined || input.as === already.slot))
      return { exposed: true, slot: already.slot };
    const slot = input.as ?? this.#freeName(to.actorId, exposedName(provider.name, input.export));
    if (!NAME.test(slot) || slot.length > EXPOSED_MAX)
      throw new Refused(
        "invalid",
        `${JSON.stringify(slot)} isn't a slot name: one word of letters, digits and _, at most ${EXPOSED_MAX}.`,
      );
    if (this.declaration(to.actorId, "slot", slot))
      throw new Refused(
        "conflict",
        `${this.named(to.actorId)} already has a slot ${slot}; name another with as.`,
      );
    const wiring = { ...ends, slot };
    this.#transaction(() => {
      this.#declare(to.actorId, "slot", slot, offered.iface, true);
      this.#insertBinding(wiring, caller);
      this.#audit(caller, "expose", { ...wiring });
    });
    return { exposed: true, slot };
  }

  /** A name free on `to`: `base`, else `base_2`, `base_3`…, each within the longest name. */
  #freeName(to: string, base: string): string {
    const taken = (name: string) => !!this.declaration(to, "slot", name);
    for (let n = 1; ; n++) {
      const suffix = n === 1 ? "" : `_${n}`;
      const name = base.slice(0, EXPOSED_MAX - suffix.length) + suffix;
      if (!taken(name)) return name;
    }
  }

  /** Remove a slot made by `expose`, with its binding: its consumer, its provider or a manager may. */
  unexpose(caller: string, to: string, slot: string): void {
    const binding = this.binding(to, slot);
    if (!binding?.exposed)
      throw new Refused(
        "unknown",
        `${this.named(to)} has no slot ${slot} made by expose; unbind a declared slot instead.`,
      );
    this.unbind(caller, to, slot);
  }

  // ── Audit ───────────────────────────────────────────────────────────────────

  audit(since = 0, limit = 100): { entries: AuditRecord[]; next: number } {
    const rows = this.#db
      .prepare("SELECT * FROM audit WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(since, limit) as Row[];
    const entries = rows.map((row) => ({
      seq: Number(row.seq),
      at: String(row.at),
      actor: String(row.actor),
      kind: String(row.kind),
      details: JSON.parse(String(row.details)) as Record<string, unknown>,
    }));
    return { entries, next: entries.at(-1)?.seq ?? since };
  }
}
