/**
 * Which client session fills which position, kept in the home's `sessions/<session>/` so that a
 * resumed session fills it again: `position` holds the actor id, `waiter` the process id of the
 * session's current waiter, and `cursor` the newest message the waiters have delivered. Each file
 * has one writer: the agent actor writes `position`, a starting waiter `waiter`, and a delivering
 * waiter `cursor`.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home, privateDirectory } from "../home.ts";

type Entry = "position" | "waiter" | "cursor";

const SESSION = /^[A-Za-z0-9_-]{1,128}$/;

function named(session: string): string {
  if (!SESSION.test(session)) throw new Error(`not a session name: ${session}`);
  return join("sessions", session);
}

const directory = (session: string) => join(home(), named(session));

function read(session: string, entry: Entry): string | undefined {
  const path = join(directory(session), entry);
  return existsSync(path) ? readFileSync(path, "utf8").trim() || undefined : undefined;
}

/** Only writing creates a session's directory, so a session that never attaches leaves none. */
function write(session: string, entry: Entry, value: string): void {
  writeFileSync(join(privateDirectory(named(session)), entry), `${value}\n`, { mode: 0o600 });
}

export const sessions = {
  position: (session: string) => read(session, "position"),
  fill: (session: string, actor: string) => write(session, "position", actor),
  /** Forget the session, as when its position closed. */
  forget: (session: string) => rmSync(directory(session), { recursive: true, force: true }),
  waiter: (session: string) => Number(read(session, "waiter") ?? 0),
  claimWaiter: (session: string, pid: number) => write(session, "waiter", String(pid)),
  cursor: (session: string) => read(session, "cursor"),
  advance: (session: string, cursor: string) => write(session, "cursor", cursor),
};
