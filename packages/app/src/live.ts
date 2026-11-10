// A live surface of an agent's unit, for a page: the page opens a socket here, same-origin, and
// this asks management for a one-time ticket, dials it, and pipes the bytes both ways. The ticket
// and every token stay out of the page.
import WebSocket from "ws";

/** What one live frame can be, either way. */
export const LIVE_MAX = 4 * 1024 * 1024;
/** The page didn't say its session, or the session is gone. */
const SIGN_IN_AGAIN = 4401;
/** The surface couldn't be opened; the reason says why. */
const NOT_OPENED = 4404;
const HELLO_TIMEOUT_MS = 10_000;
/** What a page may send before the surface opens; past it, the socket closes rather than drop. */
const WAITING_MAX = 1024 * 1024;
/** Past this much unsent to the page, the surface waits; it goes on below the lower mark. */
const BEHIND = 8 * 1024 * 1024;
const CAUGHT_UP = 1024 * 1024;

export interface Ticket {
  url: string;
  protocol: string;
}

/** A close code a page may be given: the peer's when it's an ordinary one. */
const codeOf = (code: number) =>
  code === 1000 || code === 1001 || (code >= 3000 && code <= 4999) ? code : 1011;
/** A close reason fits in 123 bytes. */
const reasonOf = (text: string) => {
  let reason = text;
  while (Buffer.byteLength(reason) > 123) reason = reason.slice(0, -1);
  return reason;
};

/**
 * Pipe a page's socket to a surface. A tab says its session first, as on `/api`, and is then
 * answered `{"op":"live","protocol"}`; after that every frame is the surface's own. The CLI is in
 * by its token.
 */
export function pipeLive(
  page: WebSocket,
  options: {
    cli: boolean;
    isSession(session: unknown): boolean;
    ticket(): Promise<Ticket>;
  },
) {
  let upstream: WebSocket | undefined;
  let opening = false;
  const waiting: [WebSocket.RawData, boolean][] = [];
  let waitingBytes = 0;
  const sizeOf = (data: WebSocket.RawData) =>
    Array.isArray(data)
      ? data.reduce((sum, one) => sum + one.length, 0)
      : (data as Buffer).byteLength;
  const open = async () => {
    opening = true;
    let ticket: Ticket;
    try {
      ticket = await options.ticket();
    } catch (error) {
      return page.close(
        NOT_OPENED,
        reasonOf(error instanceof Error ? error.message : "Not opened."),
      );
    }
    if (page.readyState !== WebSocket.OPEN) return;
    let socket: WebSocket;
    try {
      // A server's socket, dialled from here: no browser Origin goes with it.
      socket = new WebSocket(ticket.url, { maxPayload: LIVE_MAX });
    } catch {
      // Its message would hold the ticket.
      return page.close(NOT_OPENED, "The surface didn't open.");
    }
    upstream = socket;
    socket.on("open", () => {
      page.send(JSON.stringify({ op: "live", protocol: ticket.protocol }));
      for (const [data, binary] of waiting.splice(0)) socket.send(data, { binary });
    });
    socket.on("message", (data, binary) => {
      page.send(data, { binary }, () => {
        if (page.bufferedAmount < CAUGHT_UP) socket.resume();
      });
      // A page that can't keep up isn't sent more until it has.
      if (page.bufferedAmount > BEHIND) socket.pause();
    });
    socket.on("close", (code, reason) => page.close(codeOf(code), reasonOf(String(reason))));
    socket.on("error", () => page.close(NOT_OPENED, "The surface didn't open."));
  };
  const timer = options.cli
    ? undefined
    : setTimeout(() => page.close(SIGN_IN_AGAIN, "No session"), HELLO_TIMEOUT_MS);
  const opened = () => open().catch(() => page.close(NOT_OPENED, "The surface didn't open."));
  if (options.cli) void opened();
  page.on("message", (data, binary) => {
    if (!opening) {
      clearTimeout(timer);
      let hello: { op?: unknown; session?: unknown } | undefined;
      try {
        hello = binary ? undefined : JSON.parse(String(data));
      } catch {
        // Not a hello.
      }
      if (hello?.op !== "hello" || !options.isSession(hello.session))
        return page.close(SIGN_IN_AGAIN, "Sign in again");
      return void opened();
    }
    if (upstream?.readyState === WebSocket.OPEN) return upstream.send(data, { binary });
    waitingBytes += sizeOf(data);
    if (waitingBytes > WAITING_MAX) return page.close(1009, "Too much before the surface opened.");
    waiting.push([data, binary]);
  });
  page.on("close", () => {
    clearTimeout(timer);
    upstream?.close();
  });
  page.on("error", () => page.terminate());
}
