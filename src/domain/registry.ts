/** Identity, actor tree and authorized lifecycle transitions, with credentials hashed by Web Crypto. */

import { Conflict, Forbidden, Invalid, NotFound } from "./errors.ts";
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

export function registry(actors: Store["actors"], now: () => string) {
  const root = () => actors.root();
  const get = (id: string) => actors.get(id);
  const reports = (manager: string) => actors.reports(manager);
  const open = () => actors.open();
  function directory(after: number, limit: number) {
    const page = actors.directory(after, limit);
    if (after > page.head) throw new Invalid("after: beyond the Actor directory cursor");
    return { items: page.items, after: page.after };
  }

  /** Create the root, the user's position, and return its credential. */
  async function createRoot(): Promise<{ root: ActorRow; credential: string }> {
    const { credential, hash } = await mint();
    return {
      root: insert(null, "root", "The user, at the organization's root.", hash),
      credential,
    };
  }

  /** Create a report of `manager` and return it with its credential. */
  async function create(
    manager: string,
    name: string,
    purpose: string,
  ): Promise<{ actor: ActorRow; credential: string }> {
    // Hashing waits, so it comes first: the check and the insert then run with nothing between.
    const { credential, hash } = await mint();
    if (reports(manager).some((report) => report.name === name)) {
      throw new Conflict(`a report of ${manager} is already named ${name}`);
    }
    return { actor: insert(manager, name, purpose, hash), credential };
  }

  async function mint(): Promise<{ credential: string; hash: string }> {
    const credential = mintCredential();
    return { credential, hash: await digest(credential) };
  }

  function insert(manager: string | null, name: string, purpose: string, hash: string): ActorRow {
    const actor: ActorRow = {
      id: newId("act"),
      name,
      purpose,
      manager,
      credential_hash: hash,
      created_at: now(),
      closed_at: null,
    };
    actors.insert(actor);
    return actor;
  }

  /** Replace an actor's credential, as when the root's file is lost, and return the new one. */
  async function rotateCredential(id: string): Promise<string> {
    const { credential, hash } = await mint();
    actors.update({ ...found(id), credential_hash: hash });
    return credential;
  }

  function found(id: string): ActorRow {
    const actor = get(id);
    if (!actor) throw new NotFound(`there is no actor ${id}`);
    return actor;
  }

  /** The open actor whose credential this is. */
  async function byCredential(credential: string): Promise<ActorRow | undefined> {
    return actors.byCredentialHash(await digest(credential));
  }

  /** The id of the open actor whose credential this is: who a connection is. */
  async function identify(credential: string): Promise<string | undefined> {
    return (await byCredential(credential))?.id;
  }

  /** Close an authorized leaf position; repeat closure leaves its timestamp unchanged. */
  function close(caller: ActorRow, id: string): { actor: ActorRow; changed: boolean } {
    const target = found(id);
    if (target.manager === null) throw new Invalid("the root is never closed");
    if (target.manager !== caller.id && caller.manager !== null) {
      throw new Forbidden(`only its manager or the root closes ${target.name}`);
    }
    if (target.closed_at !== null) return { actor: target, changed: false };
    const children = reports(id);
    if (children.length > 0) {
      const names = children.map((report) => report.name).join(", ");
      throw new Conflict(`${target.name} has open reports (${names}); close them first`);
    }
    const actor = { ...target, closed_at: now() };
    actors.update(actor);
    return { actor, changed: true };
  }

  /** The handles from the root's report down to the actor, joined by dots; empty for the root. */
  function path(actor: ActorRow): string {
    const handles: string[] = [];
    for (let at: ActorRow | undefined = actor; at?.manager; at = get(at.manager)) {
      handles.unshift(at.name);
    }
    return handles.join(".");
  }

  /** Each of these actors by id: its path, or for the root its name. */
  function names(ids: Iterable<string>): Record<string, string> {
    const named: Record<string, string> = {};
    for (const id of new Set(ids)) {
      const actor = get(id);
      if (actor) named[id] = path(actor) || actor.name;
    }
    return named;
  }
  return {
    root,
    createRoot,
    create,
    rotateCredential,
    get,
    found,
    byCredential,
    identify,
    reports,
    open,
    directory,
    close,
    path,
    names,
  };
}

export type Registry = ReturnType<typeof registry>;
