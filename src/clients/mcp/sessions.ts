/**
 * Which client session fills which position, kept in the home's `sessions/<session>/` so that a
 * resumed session fills it again. `position` holds the Actor ID, `waiter` the current waiter PID,
 * and `inbox` the client's separate Message/Form delivery positions. These are local delivery
 * bookkeeping, never public acknowledgements or evidence of user input.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home, privateDirectory } from "../../home.ts";

type Entry = "position" | "waiter" | "inbox";

export interface InboxPosition {
  messages: number;
  forms: number;
}

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
  inbox(session: string): InboxPosition {
    const kept = read(session, "inbox");
    if (kept === undefined) return { messages: 0, forms: 0 };
    const value = JSON.parse(kept) as InboxPosition;
    if (![value.messages, value.forms].every((n) => Number.isSafeInteger(n) && n >= 0))
      throw new Error("invalid local inbox position");
    return value;
  },
  advanceInbox: (session: string, position: InboxPosition) =>
    write(session, "inbox", JSON.stringify(position)),
};
