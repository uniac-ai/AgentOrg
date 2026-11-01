/**
 * Which client session fills which position, kept in the home's `sessions/<session>/` so that a
 * resumed session fills it again. `position` holds the Actor ID, `waiter` the current waiter PID,
 * and `inbox` the `attention` position the session has been given everything before. This private
 * bookkeeping establishes neither public acknowledgements nor user input.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home, privateDirectory } from "../../home.ts";

type Entry = "position" | "waiter" | "inbox";

const SESSION = /^[A-Za-z0-9_-]{1,128}$/;

/** A client's conversation id, scoped to that client and safe as a session directory name. */
export function sessionName(client: string, id: string | undefined): string | undefined {
  const session = `${client}-${id}`;
  return id !== undefined && id.length > 0 && SESSION.test(session) ? session : undefined;
}

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
  /** The session's `attention` position; an earlier kind of position counts as none. */
  inbox(session: string): string | undefined {
    const kept = read(session, "inbox");
    return kept !== undefined && /^\d+$/.test(kept) ? kept : undefined;
  },
  advanceInbox(session: string, position: string): void {
    const directory = privateDirectory(named(session));
    const temporary = join(directory, `inbox.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${position}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temporary, join(directory, "inbox"));
    } finally {
      rmSync(temporary, { force: true });
    }
  },
};
