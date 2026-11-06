import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import { Duplex as NodeDuplex, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  type ErrorBody,
  errorBodyOf,
  errorFromBody,
  NotConnected,
  OutcomeUnknown,
  Refused,
} from "./errors.js";
import type { Duplex, Log } from "./module.js";

/**
 * The header that carries an SDK error a provider's handler threw, as its error body in JSON, on a
 * 502: the consumer's `fetch` throws that error instead of returning the response.
 */
export const ERROR_HEADER = "agentorg-error";
const ERROR_NAMES = new Set(["Refused", "NotConnected", "OutcomeUnknown"]);

/** The error a response carries, if it is a 502 whose error header is one of the SDK's three. */
function carriedError(
  status: number,
  header: string | string[] | undefined,
): ErrorBody | undefined {
  if (status !== 502 || typeof header !== "string") return undefined;
  try {
    const body = JSON.parse(header) as Partial<ErrorBody>;
    if (typeof body !== "object" || body === null || !ERROR_NAMES.has(String(body.name)))
      return undefined;
    return {
      name: body.name as ErrorBody["name"],
      message: String(body.message ?? ""),
      ...(typeof body.code === "string" ? { code: body.code } : {}),
    };
  } catch {
    return undefined;
  }
}

/** JSON with everything past ASCII escaped, so it fits in a header. */
const asciiJson = (value: unknown) =>
  JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

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
 * Send one request over the stream and read its response. The request line carries the request's
 * absolute URL, so the provider sees exactly what was asked for. Aborting the request's signal
 * resets the stream; once the response's body has ended, so is the stream, since nothing more is
 * read. A provider whose handler threw one of the SDK's errors makes this throw it (`target`
 * names the slot in a NotConnected).
 */
export function fetchOver(
  stream: Duplex,
  request: Request,
  target = "the http slot",
): Promise<Response> {
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
        path: url.href,
        headers,
      },
      (incoming) => {
        const status = incoming.statusCode ?? 502;
        const carried = carriedError(status, incoming.headers[ERROR_HEADER]);
        if (carried) {
          incoming.resume();
          socket.destroy();
          return reject(errorFromBody(carried, target));
        }
        const empty =
          request.method === "HEAD" || status === 204 || status === 205 || status === 304;
        // The response is whole: an upload the provider never read stops here.
        incoming.once("end", () => socket.destroy());
        // Whatever the provider answers, it ends as a response or an error, never a throw here.
        try {
          if (status < 200 || status > 599) throw new Error(`a status of ${status}`);
          const response = new Response(
            empty ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
            {
              status,
              statusText: incoming.statusMessage ?? "",
              headers: headersOf(incoming.headers),
            },
          );
          if (empty) incoming.resume();
          resolve(response);
        } catch (error) {
          socket.destroy();
          reject(
            new OutcomeUnknown(
              `The provider answered what isn't a response: ${(error as Error).message}`,
            ),
          );
        }
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
 * Serve requests arriving on the stream with `handle`, until the stream ends. The handler's
 * `request.url` is the consumer's absolute URL, from the request line; a request line that isn't
 * absolute, or whose host isn't the `Host` header's, is answered 400. A handler that throws one
 * of the SDK's errors before answering reaches the consumer's `fetch` as that error (a 502 with
 * the error header); any other throw answers 500 with its message. A body that fails once sent
 * ends the response abruptly, so the consumer's read fails rather than looking complete. The
 * handler's request is aborted if the consumer goes before the response is done.
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
    let target: URL | undefined;
    try {
      target = new URL(incoming.url ?? "");
    } catch {
      target = undefined;
    }
    if (
      !target ||
      (target.protocol !== "http:" && target.protocol !== "https:") ||
      target.host !== incoming.headers.host
    ) {
      outgoing.writeHead(400, { "content-type": "text/plain" });
      return void outgoing.end(
        "A request names its absolute URL, whose host is the Host header's.",
      );
    }
    try {
      const request = new Request(target.href, {
        method,
        headers: headersOf(incoming.headers),
        signal: left.signal,
        ...(noBody(method)
          ? {}
          : { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: "half" }),
      } as RequestInit);
      const response = await handle(request);
      outgoing.writeHead(response.status, response.statusText, outgoingHeaders(response.headers));
      if (!response.body || method === "HEAD") return void outgoing.end();
      // Paced by the consumer: the next chunk is read once the last one is taken.
      await pipeline(Readable.fromWeb(response.body as NodeReadableStream), outgoing);
    } catch (error) {
      if (outgoing.headersSent) {
        log.error("An http handler failed.", { error: String(error) });
        return void outgoing.destroy(error as Error);
      }
      if (
        error instanceof Refused ||
        error instanceof NotConnected ||
        error instanceof OutcomeUnknown
      ) {
        const body = errorBodyOf(error);
        body.message = body.message.slice(0, 1024);
        outgoing.writeHead(502, {
          "content-type": "text/plain",
          [ERROR_HEADER]: asciiJson(body),
        });
        return void outgoing.end(body.message);
      }
      log.error("An http handler failed.", { error: String(error) });
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
