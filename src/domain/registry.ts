/**
 * The actor registry: the organization's positions, the tree they form, and their credentials.
 *
 * Each actor has one credential, a random secret of which only the hash is kept; the credential is
 * shown once, when the actor is created. The root is the one actor without a manager. A closed
 * actor's credential no longer identifies it.
 */

import { createHash, randomBytes } from "node:crypto";
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

export const newId = (prefix: string) => `${prefix}_${randomBytes(5).toString("hex")}`;
const digest = (credential: string) => createHash("sha256").update(credential).digest("hex");
const mintCredential = () => randomBytes(32).toString("base64url");

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
  createRoot(): { root: ActorRow; credential: string } {
    const { actor, credential } = this.insert(
      null,
      "root",
      "The user, at the organization's root.",
    );
    return { root: actor, credential };
  }

  /** Create a report of `manager` and return it with its credential. */
  create(manager: string, name: string, purpose: string): { actor: ActorRow; credential: string } {
    if (this.reports(manager).some((report) => report.name === name)) {
      throw new Conflict(`a report of ${manager} is already named ${name}`);
    }
    return this.insert(manager, name, purpose);
  }

  private insert(manager: string | null, name: string, purpose: string) {
    const credential = mintCredential();
    const actor: ActorRow = {
      id: newId("act"),
      name,
      purpose,
      manager,
      credential_hash: digest(credential),
      online: false,
      interfaces: [],
      status: null,
      created_at: this.now(),
      closed_at: null,
    };
    this.actors.insert(actor);
    return { actor, credential };
  }

  /** Replace an actor's credential, as when the root's file is lost, and return the new one. */
  rotateCredential(id: string): string {
    const credential = mintCredential();
    this.actors.update({ ...this.found(id), credential_hash: digest(credential) });
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
  byCredential(credential: string): ActorRow | undefined {
    return this.actors.byCredentialHash(digest(credential));
  }

  /** The id of the open actor whose credential this is: who a connection is. */
  identify(credential: string): string | undefined {
    return this.byCredential(credential)?.id;
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

  /** The actor as built-ins return it: with its path, without its credential's hash. */
  asActor(actor: ActorRow): z.output<typeof Actor> {
    const { credential_hash: _, ...fields } = actor;
    return { ...fields, path: this.path(actor) };
  }
}
