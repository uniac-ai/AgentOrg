/** Identity on one flat level and lifecycle transitions, with credentials hashed by Web Crypto. */

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
  /** The person: the first Actor this Hub made, the one place that says so. */
  const root = () => actors.first();
  const get = (id: string) => actors.get(id);
  const open = () => actors.open();

  /** The Actor while it is open; once it is closed, the person, who takes its part. */
  function standIn(actorID: string): string | undefined {
    const actor = get(actorID);
    return actor === undefined ? undefined : actor.closed_at === null ? actor.id : root()?.id;
  }

  /** Create the person, the user's Actor, and return its credential. */
  async function createRoot(): Promise<{ root: ActorRow; credential: string }> {
    const { credential, hash } = await mint();
    return {
      root: insert("root", "The user: the person these Actors work for.", hash),
      credential,
    };
  }

  /** Create an Actor and return it with its credential. */
  async function create(
    name: string,
    purpose: string,
  ): Promise<{ actor: ActorRow; credential: string }> {
    // Hashing waits, so it comes first: the check and the insert then run with nothing between.
    const { credential, hash } = await mint();
    if (open().some((actor) => actor.name === name)) {
      throw new Conflict(`an open Actor is already named ${name}`);
    }
    return { actor: insert(name, purpose, hash), credential };
  }

  async function mint(): Promise<{ credential: string; hash: string }> {
    const credential = mintCredential();
    return { credential, hash: await digest(credential) };
  }

  function insert(name: string, purpose: string, hash: string): ActorRow {
    const actor: ActorRow = {
      id: newId("act"),
      name,
      purpose,
      credential_hash: hash,
      created_at: now(),
      closed_at: null,
    };
    actors.insert(actor);
    return actor;
  }

  /** Replace an actor's credential, as when the person's file is lost, and return the new one. */
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

  /** Close another Actor, never the person; repeat closure leaves its timestamp unchanged. */
  function close(caller: ActorRow, id: string): { actor: ActorRow; changed: boolean } {
    const target = found(id);
    if (target.id === root()?.id) throw new Invalid("the person is never closed");
    if (target.id === caller.id) throw new Forbidden("an Actor closes others, not itself");
    if (target.closed_at !== null) return { actor: target, changed: false };
    const actor = { ...target, closed_at: now() };
    actors.update(actor);
    return { actor, changed: true };
  }

  /** Each of these actors by id: its handle. */
  function names(ids: Iterable<string>): Record<string, string> {
    const named: Record<string, string> = {};
    for (const id of new Set(ids)) {
      const actor = get(id);
      if (actor) named[id] = actor.name;
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
    open,
    standIn,
    close,
    names,
  };
}

export type Registry = ReturnType<typeof registry>;
