import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import { Duplex as NodeDuplex, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Duplex, Log } from "./module.js";

/**
 * HTTP/1.1 over one of the Hub's byte streams, with `node:http` on both ends, one request per
 * stream. `node:http` wants a socket; a stream adapted from the web pair, with the few socket
 * methods it calls, serves. Destroying it resets the Hub's stream.
 */
function socketOf(stream: Duplex): Socket {
  // Built by hand rather than with Duplex.fromWeb, whose destroy throws on Node 22.
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  const socket = new NodeDuplex({
    read() {
      reader.read().then(
        ({ value, done }) => {
          this.push(done ? null : value);
        },
        (error) => this.destroy(error),
      );
    },
    write(chunk: Uint8Array, _encoding, callback) {
      writer.write(chunk).then(() => callback(), callback);
    },
    final(callback) {
      writer.close().then(() => callback(), callback);
    },
    destroy(error, callback) {
      // Either half going resets the Hub's stream.
      reader.cancel(error ?? undefined).catch(() => {});
      writer.abort(error ?? undefined).catch(() => {});
      callback(error);
    },
  }) as NodeDuplex & Partial<Socket>;
  return Object.assign(socket, {
    setTimeout: () => socket,
    setNoDelay: () => socket,
    setKeepAlive: () => socket,
    // node:http ends a finished connection this way: our side closes once its writes are out,
    // and the other side, done reading, resets the stream.
    destroySoon: () => socket.end(),
    remoteAddress: "hub",
  }) as unknown as Socket;
}

/** Headers that describe one hop, not the message: node:http sets its own on each side. */
const HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
]);

function headersOf(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (HOP.has(name)) continue;
    if (Array.isArray(value)) for (const one of value) headers.append(name, one);
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

/** Headers to send: hop-by-hop ones dropped, each `set-cookie` kept apart. */
function outgoingHeaders(headers: Headers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  headers.forEach((value, name) => {
    if (!HOP.has(name) && name !== "set-cookie") out[name] = value;
  });
  const cookies = headers.getSetCookie();
  if (cookies.length) out["set-cookie"] = cookies;
  return out;
}

const noBody = (method: string) => method === "GET" || method === "HEAD";

/**
 * Send one request over the stream and read its response. Aborting the request's signal resets
 * the stream; once the response's body has ended, so is the stream, since nothing more is read.
 */
export function fetchOver(stream: Duplex, request: Request): Promise<Response> {
  const socket = socketOf(stream);
  const url = new URL(request.url);
  const headers = outgoingHeaders(request.headers);
  headers.host = url.host;
  headers.connection = "close";
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        // No agent: with createConnection, node:http uses this stream and pools nothing.
        createConnection: () => socket,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (incoming) => {
        const status = incoming.statusCode ?? 502;
        const empty = request.method === "HEAD" || status === 204 || status === 304;
        // The response is whole: an upload the provider never read stops here.
        incoming.once("end", () => socket.destroy());
        if (empty) incoming.resume();
        resolve(
          new Response(empty ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), {
            status,
            statusText: incoming.statusMessage ?? "",
            headers: headersOf(incoming.headers),
          }),
        );
      },
    );
    const abort = () => {
      const reason = request.signal.reason ?? new Error("The request was aborted.");
      outgoing.destroy(reason);
      socket.destroy();
      reject(reason);
    };
    if (request.signal.aborted) return abort();
    request.signal.addEventListener("abort", abort, { once: true });
    outgoing.once("close", () => request.signal.removeEventListener("abort", abort));
    outgoing.on("error", reject);
    if (!request.body || noBody(request.method)) return void outgoing.end();
    pipeline(Readable.fromWeb(request.body as NodeReadableStream), outgoing).catch(() => {});
  });
}

/**
 * Serve requests arriving on the stream with `handle`, until the stream ends. A handler that
 * throws before answering answers 500 with its message; a body that fails once sent ends the
 * response abruptly, so the consumer's read fails rather than looking complete. The handler's
 * request is aborted if the consumer goes before the response is done.
 */
export function serveOver(
  stream: Duplex,
  handle: (request: Request) => Promise<Response>,
  log: Log,
): Promise<void> {
  const server = createServer(async (incoming, outgoing) => {
    const method = incoming.method ?? "GET";
    const left = new AbortController();
    outgoing.once("close", () => {
      if (!outgoing.writableFinished) left.abort(new Error("The consumer went away."));
    });
    try {
      const request = new Request(
        `http://${incoming.headers.host ?? "actor"}${incoming.url ?? "/"}`,
        {
          method,
          headers: headersOf(incoming.headers),
          signal: left.signal,
          ...(noBody(method)
            ? {}
            : { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: "half" }),
        } as RequestInit,
      );
      const response = await handle(request);
      outgoing.writeHead(response.status, response.statusText, outgoingHeaders(response.headers));
      if (!response.body || method === "HEAD") return void outgoing.end();
      // Paced by the consumer: the next chunk is read once the last one is taken.
      await pipeline(Readable.fromWeb(response.body as NodeReadableStream), outgoing);
    } catch (error) {
      log.error("An http handler failed.", { error: String(error) });
      if (outgoing.headersSent) return void outgoing.destroy(error as Error);
      outgoing.writeHead(500, { "content-type": "text/plain" });
      outgoing.end(error instanceof Error ? error.message : String(error));
    }
  });
  const socket = socketOf(stream);
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
    socket.once("error", () => resolve());
    server.emit("connection", socket);
  });
}
