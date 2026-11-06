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
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  hubActors,
  hubAudit,
  hubBindings,
  hubExports,
  hubGrants,
  hubPackages,
} from "@agentorg/interfaces";
import {
  compareInterfaces,
  type DescribedInterface,
  describeInterface,
  hashInterface,
  type InterfaceSchemas,
  Refused,
} from "@agentorg/sdk";
import { type Manifest, readTar, treeHash, verifyArchive } from "@agentorg/sdk/manifest";

/** The built-in Actor that exports management. */
export const HUB = "hub";
/** The person's Actor, created at first start with every `hub.*` binding. */
export const PERSON = "person";
/** The hub's exports, each the authority for its own part of management. */
const HUB_EXPORTS = {
  packages: hubPackages,
  actors: hubActors,
  bindings: hubBindings,
  grants: hubGrants,
  exports: hubExports,
  audit: hubAudit,
};

export type ActorState = "created" | "running" | "stopped" | "closed";
/** How a process ended on its own: its exit code or signal, and when. */
export interface Exit {
  code: number | null;
  signal: string | null;
  at: string;
}
export interface ActorRecord {
  actorId: string;
  name: string;
  /** A package hash, `external` for a program that connects itself, or `builtin` for the hub. */
  package: string;
  state: ActorState;
  /** Times its process was restarted after a crash. */
  restarts: number;
  lastExit?: Exit;
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
}
/** The two ends of a binding: the export side gives the export, the slot side takes it. */
export type Side = "export" | "slot";
/**
 * How a request ended: `approved` (its binding was made), `declined`, or `closed` (its slot was
 * bound to something else, or one end went away).
 */
export type Decision = "approved" | "declined" | "closed";
export interface RequestRecord extends Wiring {
  requestId: string;
  /** The side the requester lacks, whose approvers decide. */
  needs: Side;
  reason: string;
  requestedBy: string;
  at: string;
}
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
  /** Bindings that ended, by unbind, withdrawal, redeclaration, disconnection or closing. */
  unbound?(bindings: BindingRecord[]): void;
  requested?(request: RequestRecord, approvers: string[]): void;
  /** A request was approved, declined or closed: to its approvers and its requester. */
  decided?(request: RequestRecord, status: Decision, approvers: string[]): void;
  exportsChanged?(actor: string): void;
  /** An Actor was closed for good: its channel should go too. */
  closed?(actorId: string): void;
  audited?(entry: AuditRecord): void;
}

const NAME = /^[a-z][A-Za-z0-9_]*$/;
const MEMBER = /^[a-z][A-Za-z0-9_]*(\.[a-z][A-Za-z0-9_]*)?$/;
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
type Pending = { request: RequestRecord; approvers: string[] };
const bindingOf = (row: Row): BindingRecord => ({
  consumer: String(row.consumer),
  slot: String(row.slot),
  provider: String(row.provider),
  export: String(row.export),
  interface: String(row.interface),
  madeBy: String(row.made_by),
  at: String(row.at),
});
const requestOf = (row: Row): RequestRecord => ({
  requestId: String(row.id),
  consumer: String(row.consumer),
  slot: String(row.slot),
  provider: String(row.provider),
  export: String(row.export),
  reason: String(row.reason),
  requestedBy: String(row.requested_by),
  at: String(row.at),
  needs: row.needs === "slot" ? "slot" : "export",
});
const other = (side: Side): Side => (side === "export" ? "slot" : "export");

/**
 * The core's state in its home folder: Actors, packages, declarations, bindings, binding requests
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
    mkdirSync(join(home, "packages"), { recursive: true, mode: 0o700 });
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
      .prepare("SELECT id, name, package, state, restarts, last_exit FROM actors WHERE id = ?")
      .get(actorId) as Row | undefined;
    return (
      row && {
        actorId: String(row.id),
        name: String(row.name),
        package: String(row.package),
        state: row.state as ActorState,
        restarts: Number(row.restarts),
        ...(row.last_exit ? { lastExit: JSON.parse(String(row.last_exit)) as Exit } : {}),
      }
    );
  }

  actor(actorId: string): ActorRecord {
    const actor = this.#actor(actorId);
    if (!actor) throw new Refused("unknown", `No Actor ${actorId}.`);
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
      throw new Refused("forbidden", `${caller} isn't bound to hub.${hubExport}@1.`);
  }

  /** Create an Actor: one that runs a package, or an external one, whose credential comes back once. */
  createActor(
    caller: string,
    input: {
      name: string;
      package?: string;
      /**
       * Initial bindings for the new Actor's slots, made with the caller's export-side authority;
       * the creation is the slot side's yes. An external Actor's slot is declared with the
       * export's interface, and its hello must declare it the same way to keep it.
       */
      bindings?: Omit<Wiring, "consumer">[];
    },
  ): { actorId: string; credential?: string } {
    this.#require(caller, "actors");
    const actorId = `act_${randomBytes(8).toString("hex")}`;
    const credential = input.package ? undefined : randomBytes(32).toString("base64url");
    const insert = this.#db.prepare(
      "INSERT INTO actors (id, name, package, state, credential, created_at) VALUES (?, ?, ?, 'created', ?, ?)",
    );
    this.#transaction(() => {
      if (input.package) {
        const { manifest } = this.package(input.package);
        insert.run(actorId, input.name, input.package, null, now());
        for (const [module, m] of Object.entries(manifest.modules))
          for (const [side, members] of [
            ["slot", m.slots],
            ["export", m.exports],
          ] as const)
            for (const [member, id] of Object.entries(members)) {
              const entry = manifest.interfaces[id];
              if (!entry) throw new Refused("invalid", `The package doesn't record ${id}.`);
              this.#declare(actorId, side, `${module}.${member}`, { id, ...entry }, false);
            }
        // A package's own wiring is applied as it is installed.
        for (const [slot, exported] of manifest.connections)
          this.#insertBinding(
            { consumer: actorId, slot, provider: actorId, export: exported },
            HUB,
          );
      } else insert.run(actorId, input.name, "external", digest(credential as string), now());
      this.#audit(caller, "actor.create", {
        actorId,
        name: input.name,
        package: input.package ?? "external",
      });
      for (const initial of input.bindings ?? []) {
        const wiring = { consumer: actorId, ...initial };
        if (!this.sides(caller, wiring).export)
          throw new Refused(
            "forbidden",
            `${caller} can't grant ${initial.provider}'s ${initial.export}.`,
          );
        if (!input.package && !this.declaration(actorId, "slot", initial.slot)) {
          if (!NAME.test(initial.slot))
            throw new Refused(
              "invalid",
              `${JSON.stringify(initial.slot)} isn't a valid slot name.`,
            );
          const offered = this.declaration(initial.provider, "export", initial.export);
          if (!offered)
            throw new Refused("unknown", `${initial.provider} offers no ${initial.export}.`);
          this.#declare(actorId, "slot", initial.slot, offered.iface, false);
        }
        this.#insertBinding(wiring, caller);
      }
    });
    return credential ? { actorId, credential } : { actorId };
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

  #packageActor(caller: string, actorId: string): ActorRecord {
    this.#require(caller, "actors");
    const actor = this.actor(actorId);
    if (actor.package === "external" || actor.package === "builtin")
      throw new Refused("state", `${actorId} isn't a package Actor; it connects itself.`);
    return actor;
  }

  /** Start a package Actor; its process is spawned from step 3. */
  start(caller: string, actorId: string): void {
    const actor = this.#packageActor(caller, actorId);
    if (actor.state !== "created" && actor.state !== "stopped")
      throw new Refused("state", `${actorId} is ${actor.state}.`);
    this.#transaction(() => {
      this.#db.prepare("UPDATE actors SET state = 'running' WHERE id = ?").run(actorId);
      this.#audit(caller, "actor.start", { actorId });
    });
  }

  stop(caller: string, actorId: string): void {
    const actor = this.#packageActor(caller, actorId);
    if (actor.state !== "running") throw new Refused("state", `${actorId} is ${actor.state}.`);
    this.#transaction(() => {
      this.#db.prepare("UPDATE actors SET state = 'stopped' WHERE id = ?").run(actorId);
      this.#audit(caller, "actor.stop", { actorId });
    });
  }

  /** Close an Actor for good: its bindings both ways, its declarations and its open requests go. */
  closeActor(caller: string, actorId: string): void {
    this.#require(caller, "actors");
    const actor = this.actor(actorId);
    if (actorId === HUB || actorId === PERSON)
      throw new Refused("forbidden", `${actorId} can't be closed.`);
    if (actor.state === "closed") return;
    this.#transaction(() => {
      const pending = this.#pending(
        "consumer = ? OR provider = ? OR requested_by = ?",
        actorId,
        actorId,
        actorId,
      );
      this.#db.prepare("UPDATE actors SET state = 'closed' WHERE id = ?").run(actorId);
      this.#removeBindings("consumer = ? OR provider = ?", actorId, actorId);
      this.#db.prepare("DELETE FROM declarations WHERE actor = ?").run(actorId);
      for (const open of pending) this.#decide(open, "closed");
      this.#audit(caller, "actor.close", { actorId });
      this.#emit(() => this.#events.exportsChanged?.(actorId));
      this.#emit(() => this.#events.closed?.(actorId));
    });
  }

  // ── Packages ────────────────────────────────────────────────────────────────

  /** Add a `.agentorg` archive from a path on this machine, verified; adding it again is a no-op. */
  addPackage(caller: string, path: string): { hash: string; manifest: Manifest } {
    this.#require(caller, "packages");
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(path));
    } catch {
      throw new Refused("unknown", `No package file at ${path}.`);
    }
    let expected = /^(sha256-[0-9a-f]{64})\.agentorg$/.exec(basename(path))?.[1];
    if (!expected)
      try {
        expected = treeHash(readTar(bytes));
      } catch (error) {
        throw new Refused("invalid", error instanceof Error ? error.message : String(error));
      }
    const verified = verifyArchive(bytes, expected);
    if (!verified.ok) throw new Refused("invalid", verified.problems.join("\n"));
    const { hash, manifest, files } = verified;
    if (this.#db.prepare("SELECT 1 FROM packages WHERE hash = ?").get(hash))
      return { hash, manifest };
    const dir = join(this.home, "packages", hash);
    for (const [file, data] of files) {
      const target = resolve(dir, file);
      // verifyArchive allows only agentorg.json and dist/<module>.js; this keeps it so.
      if (relative(dir, target).startsWith(`..${sep}`))
        throw new Refused("invalid", `Unsafe path ${file}.`);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, data, { mode: 0o600 });
    }
    this.#transaction(() => {
      this.#db
        .prepare(
          "INSERT INTO packages (hash, name, version, manifest, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(hash, manifest.name, manifest.version, JSON.stringify(manifest), caller, now());
      this.#audit(caller, "package.add", { hash, name: manifest.name, version: manifest.version });
    });
    return { hash, manifest };
  }

  packages(): { hash: string; name: string; version: string }[] {
    const rows = this.#db
      .prepare("SELECT hash, name, version FROM packages ORDER BY added_at, hash")
      .all() as Row[];
    return rows.map((row) => ({
      hash: String(row.hash),
      name: String(row.name),
      version: String(row.version),
    }));
  }

  package(hash: string): { hash: string; manifest: Manifest } {
    const row = this.#db.prepare("SELECT manifest FROM packages WHERE hash = ?").get(hash) as
      | Row
      | undefined;
    if (!row) throw new Refused("unknown", `No package ${hash}.`);
    return { hash, manifest: JSON.parse(String(row.manifest)) as Manifest };
  }

  /** Remove a package no live Actor runs. Its files stay until a later clean-up. */
  removePackage(caller: string, hash: string): void {
    this.#require(caller, "packages");
    this.package(hash);
    if (this.#db.prepare("SELECT 1 FROM actors WHERE package = ? AND state != 'closed'").get(hash))
      throw new Refused("in_use", `An Actor runs ${hash}.`);
    this.#transaction(() => {
      this.#db.prepare("DELETE FROM packages WHERE hash = ?").run(hash);
      this.#audit(caller, "package.remove", { hash });
    });
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
    if (actor.state === "closed") throw new Refused("state", `${actorId} is closed.`);
    return actor;
  }

  /**
   * An external Actor's slots and static exports, as it declares them when it connects; they
   * replace what it declared before. A bound name keeps its interface: redeclaring it as another is
   * refused. A name it no longer declares is dropped, with its bindings.
   */
  declareExternal(
    actorId: string,
    declares: {
      slots: Record<string, DescribedInterface>;
      exports: Record<string, DescribedInterface>;
    },
  ): void {
    const actor = this.#open(actorId);
    if (actor.package !== "external")
      throw new Refused("forbidden", `${actorId} declares through its package.`);
    this.#transaction(() => {
      for (const [side, members] of [
        ["slot", declares.slots],
        ["export", declares.exports],
      ] as const) {
        for (const [name, iface] of Object.entries(members)) {
          if (!NAME.test(name))
            throw new Refused("invalid", `${JSON.stringify(name)} isn't a valid name.`);
          this.#checked(iface);
          const known = this.declaration(actorId, side, name);
          if (
            known &&
            this.#isBound(actorId, side, name) &&
            compareInterfaces(known.iface, iface) !== "same"
          )
            throw new Refused(
              "conflict",
              `${name} is bound as ${known.iface.id}; it can't change while bound.`,
            );
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

  #isBound(actor: string, side: "slot" | "export", name: string): boolean {
    return !!this.#db
      .prepare(
        side === "slot"
          ? "SELECT 1 FROM bindings WHERE consumer = ? AND slot = ?"
          : "SELECT 1 FROM bindings WHERE provider = ? AND export = ?",
      )
      .get(actor, name);
  }

  /** A declaration gone, and the bindings through it. */
  #drop(actor: string, side: "slot" | "export", name: string) {
    this.#db
      .prepare("DELETE FROM declarations WHERE actor = ? AND side = ? AND name = ?")
      .run(actor, side, name);
    const where = side === "slot" ? "consumer = ? AND slot = ?" : "provider = ? AND export = ?";
    const pending = this.#pending(where, actor, name);
    this.#removeBindings(where, actor, name);
    for (const open of pending) this.#decide(open, "closed");
  }

  /** Offer an export at run time; it lasts until withdrawn or until the Actor disconnects. */
  offer(actorId: string, name: string, iface: DescribedInterface): void {
    this.#open(actorId);
    if (!MEMBER.test(name))
      throw new Refused("invalid", `${JSON.stringify(name)} isn't a valid export name.`);
    if (this.declaration(actorId, "export", name))
      throw new Refused("conflict", `${actorId} already offers ${name}.`);
    this.#checked(iface);
    this.#transaction(() => {
      this.#declare(actorId, "export", name, iface, true);
      this.#audit(actorId, "export.offer", { export: name, interface: iface.id });
      this.#emit(() => this.#events.exportsChanged?.(actorId));
    });
  }

  /** Withdraw an export offered at run time: the bindings to it end. */
  withdraw(actorId: string, name: string): void {
    const declared = this.declaration(actorId, "export", name);
    if (!declared?.dynamic)
      throw new Refused("unknown", `${actorId} offers no ${name} at run time to withdraw.`);
    this.#transaction(() => {
      this.#drop(actorId, "export", name);
      this.#audit(actorId, "export.withdraw", { export: name });
      this.#emit(() => this.#events.exportsChanged?.(actorId));
    });
  }

  /** An Actor's connection ended: what it offered at run time goes, with the bindings to it. */
  disconnected(actorId: string): void {
    this.#transaction(() => {
      const dynamic = this.#db
        .prepare(
          "SELECT name FROM declarations WHERE actor = ? AND side = 'export' AND dynamic = 1",
        )
        .all(actorId) as Row[];
      for (const row of dynamic) this.#drop(actorId, "export", String(row.name));
      if (dynamic.length) this.#emit(() => this.#events.exportsChanged?.(actorId));
    });
  }

  exports(actor?: string): {
    actor: string;
    export: string;
    interface: string;
    hash: string;
    dynamic: boolean;
  }[] {
    const rows = this.#db
      .prepare(
        `SELECT d.actor, d.name, d.iface, d.dynamic FROM declarations d JOIN actors a ON a.id = d.actor
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
        dynamic: !!row.dynamic,
      };
    });
  }

  // ── Bindings: a binding is the grant ────────────────────────────────────────

  binding(consumer: string, slot: string): BindingRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM bindings WHERE consumer = ? AND slot = ?")
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
          .prepare("SELECT * FROM bindings WHERE consumer = ? OR provider = ? ORDER BY rowid")
          .all(actor, actor)
      : this.#db.prepare("SELECT * FROM bindings ORDER BY rowid").all();
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

  /** Who can give the side a request needs: exactly the Actors `sides` grants it to. */
  approvers(request: Wiring & { needs: Side }): string[] {
    const managers = (
      this.#db
        .prepare(
          "SELECT DISTINCT consumer FROM bindings WHERE provider = ? AND export = 'bindings'",
        )
        .all(HUB) as Row[]
    ).map((m) => String(m.consumer));
    const own =
      request.needs === "slot"
        ? [request.consumer]
        : [
            request.provider,
            ...(
              this.#db
                .prepare("SELECT DISTINCT consumer FROM bindings WHERE provider = ? AND export = ?")
                .all(request.provider, request.export) as Row[]
            ).map((h) => String(h.consumer)),
          ];
    return [...new Set([...own, ...managers])];
  }

  /** The two ends exist, are live, and take and offer the same interface. */
  #ends(wiring: Wiring): string {
    this.#open(wiring.consumer);
    this.#open(wiring.provider);
    const slot = this.declaration(wiring.consumer, "slot", wiring.slot);
    if (!slot) throw new Refused("unknown", `${wiring.consumer} has no slot ${wiring.slot}.`);
    const exported = this.declaration(wiring.provider, "export", wiring.export);
    if (!exported) throw new Refused("unknown", `${wiring.provider} offers no ${wiring.export}.`);
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
        `${wiring.consumer}'s ${wiring.slot} is already bound; unbind it first.`,
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
      this.#db.prepare(`SELECT * FROM bindings WHERE ${where}`).all(...params) as Row[]
    ).map(bindingOf);
    if (!removed.length) return;
    if (removed.some((b) => b.consumer === PERSON && b.provider === HUB))
      throw new Refused(
        "forbidden",
        "The person's hub bindings stay, so someone can always manage the Hub.",
      );
    // Requests whose requester held its end through these bindings can't be approved any more.
    const open = this.#pending("1 = 1");
    this.#db.prepare(`DELETE FROM bindings WHERE ${where}`).run(...params);
    this.#emit(() => this.#events.unbound?.(removed));
    for (const pending of open)
      if (!this.#standing(pending.request)) this.#decide(pending, "closed");
  }

  /**
   * Bind a slot to an export. A caller with both ends binds. A caller with one end approves an
   * open request for this binding from the other end, if its requester still holds that end;
   * otherwise its call becomes a request to the other end's approvers. A caller with neither end
   * is refused.
   */
  bind(caller: string, wiring: Wiring): { bound: true } | { bound: false; requestId: string } {
    const sides = this.sides(caller, wiring);
    if (!sides.export && !sides.slot)
      throw new Refused("forbidden", `${caller} holds neither end of this binding.`);
    if (!(sides.export && sides.slot)) {
      const has: Side = sides.export ? "export" : "slot";
      if (!this.#asked(wiring, has))
        return { bound: false, requestId: this.#ask(caller, wiring, "", other(has)).requestId };
    }
    this.#transaction(() => {
      // Every open request for this slot is settled: the ones for this binding are approved, and
      // the rest can't be made any more.
      const pending = this.#pending("consumer = ? AND slot = ?", wiring.consumer, wiring.slot);
      this.#insertBinding(wiring, caller);
      for (const open of pending)
        this.#decide(
          open,
          open.request.provider === wiring.provider && open.request.export === wiring.export
            ? "approved"
            : "closed",
        );
    });
    return { bound: true };
  }

  /** Unbind a slot: its consumer, its provider or a manager may. */
  unbind(caller: string, consumer: string, slot: string): void {
    const binding = this.binding(consumer, slot);
    if (!binding) throw new Refused("unknown", `${consumer}'s ${slot} isn't bound.`);
    if (caller !== consumer && caller !== binding.provider && !this.isManager(caller))
      throw new Refused("forbidden", `${caller} can't unbind ${consumer}'s ${slot}.`);
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
   * Ask for a binding the caller holds one end of; it goes to the other end's approvers. Asking
   * again for the same wiring while a request is open returns that request.
   */
  request(caller: string, wiring: Wiring, reason: string): RequestRecord {
    const sides = this.sides(caller, wiring);
    if (!sides.export && !sides.slot)
      throw new Refused("forbidden", `${caller} holds neither end of this binding.`);
    if (sides.export && sides.slot)
      throw new Refused("state", `${caller} holds both ends: bind it instead.`);
    const has: Side = sides.export ? "export" : "slot";
    if (this.#asked(wiring, has))
      throw new Refused("state", "The other end has asked already: bind to approve.");
    return this.#ask(caller, wiring, reason, other(has));
  }

  /** Whether the other end has an open request for this binding that `has` would complete. */
  #asked(wiring: Wiring, has: Side): boolean {
    return (
      this.#db
        .prepare(
          "SELECT * FROM requests WHERE status = 'open' AND needs = ? AND consumer = ? AND slot = ? AND provider = ? AND export = ?",
        )
        .all(has, wiring.consumer, wiring.slot, wiring.provider, wiring.export) as Row[]
    )
      .map(requestOf)
      .some((request) => this.#standing(request));
  }

  #ask(caller: string, wiring: Wiring, reason: string, needs: Side): RequestRecord {
    this.#ends(wiring);
    if (this.binding(wiring.consumer, wiring.slot))
      throw new Refused("bound", `${wiring.consumer}'s ${wiring.slot} is already bound.`);
    const open = this.#db
      .prepare(
        "SELECT * FROM requests WHERE status = 'open' AND requested_by = ? AND consumer = ? AND slot = ? AND provider = ? AND export = ?",
      )
      .get(caller, wiring.consumer, wiring.slot, wiring.provider, wiring.export) as Row | undefined;
    if (open) return requestOf(open);
    const request: RequestRecord = {
      requestId: `req_${randomBytes(8).toString("hex")}`,
      ...wiring,
      needs,
      reason,
      requestedBy: caller,
      at: now(),
    };
    this.#transaction(() => {
      this.#db
        .prepare(
          "INSERT INTO requests (id, consumer, slot, provider, export, reason, requested_by, at, status, needs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
        )
        .run(
          request.requestId,
          wiring.consumer,
          wiring.slot,
          wiring.provider,
          wiring.export,
          reason,
          caller,
          request.at,
          needs,
        );
      this.#audit(caller, "request", { ...wiring, needs, requestId: request.requestId });
      const approvers = this.approvers(request).filter((a) => a !== caller);
      this.#emit(() => this.#events.requested?.(request, approvers));
    });
    return request;
  }

  /** The open requests the caller could approve. */
  requests(caller: string): RequestRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM requests WHERE status = 'open' ORDER BY at")
      .all() as Row[];
    return rows
      .map(requestOf)
      .filter(
        (request) =>
          request.requestedBy !== caller &&
          this.#standing(request) &&
          this.approvers(request).includes(caller),
      );
  }

  /** The caller's own requests with how each stands, newest first. */
  mine(caller: string, limit = 100): (RequestRecord & { status: "open" | Decision })[] {
    const rows = this.#db
      .prepare("SELECT * FROM requests WHERE requested_by = ? ORDER BY at DESC, rowid DESC LIMIT ?")
      .all(caller, limit) as Row[];
    return rows.map((row) => ({ ...requestOf(row), status: row.status as "open" | Decision }));
  }

  /** A request can still be approved only while its requester holds the end it brought. */
  #standing(request: RequestRecord): boolean {
    return this.sides(request.requestedBy, request)[other(request.needs)];
  }

  /**
   * Open requests matching a condition, each with the approvers it went to. Taken before bindings
   * change, so the decision reaches the same Actors as the request.
   */
  #pending(where: string, ...params: string[]): Pending[] {
    return (
      this.#db
        .prepare(`SELECT * FROM requests WHERE status = 'open' AND (${where})`)
        .all(...params) as Row[]
    ).map((row) => {
      const request = requestOf(row);
      return {
        request,
        approvers: this.approvers(request).filter((a) => a !== request.requestedBy),
      };
    });
  }

  #decide({ request, approvers }: Pending, status: Decision) {
    // A request is decided once; a later path that finds it again leaves it be.
    const { changes } = this.#db
      .prepare("UPDATE requests SET status = ? WHERE id = ? AND status = 'open'")
      .run(status, request.requestId);
    if (!changes) return;
    // The requester hears too; events are at most once, so it can also read the outcome in `mine`.
    const to = [...new Set([...approvers, request.requestedBy])];
    this.#emit(() => this.#events.decided?.(request, status, to));
  }

  decline(caller: string, requestId: string): void {
    const request = this.requests(caller).find((r) => r.requestId === requestId);
    if (!request)
      throw new Refused("unknown", `No open request ${requestId} for ${caller} to decide.`);
    this.#transaction(() => {
      const [pending] = this.#pending("id = ?", requestId);
      if (pending) this.#decide(pending, "declined");
      this.#audit(caller, "decline", { requestId });
    });
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
