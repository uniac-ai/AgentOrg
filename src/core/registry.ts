/**
 * The actor registry: the organization's positions, the tree they form, and their credentials.
 *
 * Each actor has one credential, a random secret of which only the hash is kept; the credential is
 * shown once, when the actor is created. The root is the one actor without a manager. A closed
 * actor's credential no longer identifies it.
 */

import { createHash, randomBytes } from "node:crypto";
import type { z } from "zod";
import type { Actor, Status } from "../protocol/index.ts";
import { Conflict, NotFound } from "./errors.ts";
import type { ActorRow } from "./schema.ts";
import type { Store } from "./store.ts";

export type ActorRecord = z.output<typeof ActorRow>;
type Tool = ActorRecord["tools"][number];

export const newId = (prefix: string) => `${prefix}_${randomBytes(5).toString("hex")}`;
const digest = (credential: string) => createHash("sha256").update(credential).digest("hex");
const mintCredential = () => randomBytes(32).toString("base64url");

export class Registry {
  private readonly store: Store;
  private readonly now: () => string;

  constructor(store: Store, now: () => string) {
    this.store = store;
    this.now = now;
  }

  root(): ActorRecord | undefined {
    return this.store.select("actors", "manager IS NULL")[0];
  }

  /** Create the root, the user's position, and return its credential. */
  createRoot(): { root: ActorRecord; credential: string } {
    const { actor, credential } = this.insert(
      null,
      "root",
      "The user, at the organization's root.",
    );
    return { root: actor, credential };
  }

  /** Create a report of `manager` and return it with its credential. */
  create(
    manager: string,
    name: string,
    purpose: string,
  ): { actor: ActorRecord; credential: string } {
    const taken = this.store.count("actors", "manager = ? AND name = ? AND closed_at IS NULL", [
      manager,
      name,
    ]);
    if (taken > 0) throw new Conflict(`a report of ${manager} is already named ${name}`);
    return this.insert(manager, name, purpose);
  }

  private insert(manager: string | null, name: string, purpose: string) {
    const credential = mintCredential();
    const actor: ActorRecord = {
      id: newId("act"),
      name,
      purpose,
      manager,
      credential_hash: digest(credential),
      online: false,
      tools: [],
      status: null,
      created_at: this.now(),
      closed_at: null,
    };
    this.store.insert("actors", actor);
    return { actor, credential };
  }

  /** Replace an actor's credential, as when the root's file is lost, and return the new one. */
  rotateCredential(id: string): string {
    const credential = mintCredential();
    this.store.update("actors", { ...this.found(id), credential_hash: digest(credential) });
    return credential;
  }

  get(id: string): ActorRecord | undefined {
    return this.store.get("actors", id);
  }

  found(id: string): ActorRecord {
    const actor = this.get(id);
    if (!actor) throw new NotFound(`there is no actor ${id}`);
    return actor;
  }

  /** The open actor whose credential this is. */
  byCredential(credential: string): ActorRecord | undefined {
    return this.store.select("actors", "credential_hash = ? AND closed_at IS NULL", [
      digest(credential),
    ])[0];
  }

  /** The actor's open direct reports, oldest first. */
  reports(id: string): ActorRecord[] {
    return this.store.select("actors", "manager = ? AND closed_at IS NULL", [id]);
  }

  /** Every open actor, oldest first, so that managers come before their reports. */
  open(): ActorRecord[] {
    return this.store.select("actors", "closed_at IS NULL");
  }

  close(id: string): ActorRecord {
    const actor = { ...this.found(id), online: false, closed_at: this.now() };
    this.store.update("actors", actor);
    return actor;
  }

  setOnline(id: string, online: boolean): void {
    this.store.run("UPDATE actors SET online = ? WHERE id = ?", [online ? 1 : 0, id]);
  }

  /** Mark every actor offline, as at start, before any reverse connection is open. */
  setAllOffline(): void {
    this.store.run("UPDATE actors SET online = 0");
  }

  setTools(id: string, tools: Tool[]): void {
    this.store.run("UPDATE actors SET tools = ? WHERE id = ?", [JSON.stringify(tools), id]);
  }

  setStatus(id: string, status: z.output<typeof Status>): ActorRecord {
    const actor = { ...this.found(id), status };
    this.store.update("actors", actor);
    return actor;
  }

  /** The handles from the root's report down to the actor, joined by dots; empty for the root. */
  path(actor: ActorRecord): string {
    const handles: string[] = [];
    for (let at: ActorRecord | undefined = actor; at?.manager; at = this.get(at.manager)) {
      handles.unshift(at.name);
    }
    return handles.join(".");
  }

  /** The actor as tools return it: with its path, without its credential's hash. */
  asActor(actor: ActorRecord): z.output<typeof Actor> {
    const { credential_hash: _, ...fields } = actor;
    return { ...fields, path: this.path(actor) };
  }
}
