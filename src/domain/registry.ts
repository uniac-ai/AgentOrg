/**
 * The actor registry: the organization's positions, the tree they form, and their credentials.
 *
 * Each actor has one credential, a random secret of which only the hash is kept; the credential is
 * shown once, when the actor is created. The root is the one actor without a manager. A closed
 * actor's credential no longer identifies it. Secrets and hashes come from Web Crypto, so the
 * domain runs wherever that does.
 */

import type { z } from "zod";
import { Conflict, NotFound } from "./errors.ts";
import {
  type Actor,
  INTERFACE_NAME,
  type InterfaceDescriptor,
  type Status,
} from "./model/index.ts";
import type { ActorRow, Store } from "./ports.ts";

export type { ActorRow };

const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const newId = (prefix: string) => `${prefix}_${hex(random(5))}`;

/** A credential's SHA-256 hash, in hex: all the registry keeps of it. */
async function digest(credential: string): Promise<string> {
  const bytes = new TextEncoder().encode(credential);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** 32 random bytes, in base64url. */
const mintCredential = () =>
  btoa(String.fromCharCode(...random(32)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

export class Registry {
  private readonly actors: Store["actors"];
  private readonly now: () => string;

  constructor(store: Store, now: () => string) {
    this.actors = store.actors;
    this.now = now;
  }

  root(): ActorRow | undefined {
    return this.actors.root();
  }

  /** Create the root, the user's position, and return its credential. */
  async createRoot(): Promise<{ root: ActorRow; credential: string }> {
    const { credential, hash } = await this.mint();
    return {
      root: this.insert(null, "root", "The user, at the organization's root.", hash),
      credential,
    };
  }

  /**
   * Create a report of `manager` and return it with its credential; `createdAtAttach` marks one
   * created as a session the user started attaches to it.
   */
  async create(
    manager: string,
    name: string,
    purpose: string,
    createdAtAttach = false,
  ): Promise<{ actor: ActorRow; credential: string }> {
    // Hashing waits, so it comes first: the check and the insert then run with nothing between.
    const { credential, hash } = await this.mint();
    if (this.reports(manager).some((report) => report.name === name)) {
      throw new Conflict(`a report of ${manager} is already named ${name}`);
    }
    return { actor: this.insert(manager, name, purpose, hash, createdAtAttach), credential };
  }

  private async mint(): Promise<{ credential: string; hash: string }> {
    const credential = mintCredential();
    return { credential, hash: await digest(credential) };
  }

  private insert(
    manager: string | null,
    name: string,
    purpose: string,
    hash: string,
    createdAtAttach = false,
  ): ActorRow {
    const actor: ActorRow = {
      id: newId("act"),
      name,
      purpose,
      manager,
      credential_hash: hash,
      online: false,
      interfaces: [],
      status: null,
      created_at_attach: createdAtAttach,
      created_at: this.now(),
      closed_at: null,
    };
    this.actors.insert(actor);
    return actor;
  }

  /** Replace an actor's credential, as when the root's file is lost, and return the new one. */
  async rotateCredential(id: string): Promise<string> {
    const { credential, hash } = await this.mint();
    this.actors.update({ ...this.found(id), credential_hash: hash });
    return credential;
  }

  get(id: string): ActorRow | undefined {
    return this.actors.get(id);
  }

  found(id: string): ActorRow {
    const actor = this.get(id);
    if (!actor) throw new NotFound(`there is no actor ${id}`);
    return actor;
  }

  /** The open actor whose credential this is. */
  async byCredential(credential: string): Promise<ActorRow | undefined> {
    return this.actors.byCredentialHash(await digest(credential));
  }

  /** The id of the open actor whose credential this is: who a connection is. */
  async identify(credential: string): Promise<string | undefined> {
    return (await this.byCredential(credential))?.id;
  }

  /** The actor's open direct reports, oldest first. */
  reports(id: string): ActorRow[] {
    return this.actors.reports(id);
  }

  /** Every open actor, oldest first, so that managers come before their reports. */
  open(): ActorRow[] {
    return this.actors.open();
  }

  close(id: string): ActorRow {
    const actor = { ...this.found(id), online: false, closed_at: this.now() };
    this.actors.update(actor);
    return actor;
  }

  setOnline(id: string, online: boolean): void {
    this.actors.setOnline(id, online);
  }

  /** Mark every actor offline, as at start, before any can be reached. */
  setAllOffline(): void {
    this.actors.setAllOffline();
  }

  /** Keep the interfaces whose names can join a handle, as the actor's exposed ones. */
  setInterfaces(id: string, interfaces: InterfaceDescriptor[]): void {
    this.actors.setInterfaces(
      id,
      interfaces.filter((each) => INTERFACE_NAME.test(each.name)),
    );
  }

  setStatus(id: string, status: z.output<typeof Status>): ActorRow {
    const actor = { ...this.found(id), status };
    this.actors.update(actor);
    return actor;
  }

  /** The handles from the root's report down to the actor, joined by dots; empty for the root. */
  path(actor: ActorRow): string {
    const handles: string[] = [];
    for (let at: ActorRow | undefined = actor; at?.manager; at = this.get(at.manager)) {
      handles.unshift(at.name);
    }
    return handles.join(".");
  }

  /** Each of these actors by id: its path, or for the root its name. */
  names(ids: Iterable<string>): Record<string, string> {
    const named: Record<string, string> = {};
    for (const id of new Set(ids)) {
      const actor = this.get(id);
      if (actor) named[id] = this.path(actor) || actor.name;
    }
    return named;
  }

  /** The actor as built-ins return it: with its path, without its credential's hash. */
  asActor(actor: ActorRow): z.output<typeof Actor> {
    const { credential_hash: _, ...fields } = actor;
    return { ...fields, path: this.path(actor) };
  }
}
