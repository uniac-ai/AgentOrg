import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { rootCertificates } from "node:tls";
import { OutcomeUnknown, Refused } from "@agentorg/sdk";
import { ERROR_HEADER } from "@agentorg/sdk/http";
import { type HubState, NET } from "./state.js";

export interface NetOptions {
  /** Resolve a host name to every address it has. Tests give their own. */
  lookup?: (host: string) => Promise<LookupAddress[]>;
  /** A CA to trust beside the usual roots. Tests give their own. */
  ca?: string;
  /** How long a request may go without a byte either way. */
  idleMs?: number;
  /** Addresses refused: by default `blockedAddresses()`. Tests leave loopback out to reach their server. */
  blocked?: BlockList;
}

/**
 * Addresses that aren't the public internet: unspecified, loopback, private (RFC 1918, ULA),
 * shared (CGNAT), link-local (the cloud metadata address among them), multicast, and the reserved
 * and documentation ranges; in IPv6 also the IPv4-compatible range, Teredo and NAT64's local-use
 * prefix. An IPv4-mapped IPv6 address is checked by its IPv4 rules here; `isPublicAddress` checks
 * the other forms that carry an IPv4 address. Only tests leave IPv4 loopback out.
 */
export function blockedAddresses(options: { loopback?: boolean } = {}): BlockList {
  const blocked = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const)
    if (options.loopback !== false || network !== "127.0.0.0")
      blocked.addSubnet(network, prefix, "ipv4");
  for (const [network, prefix] of [
    // IPv4-compatible (deprecated), with :: and ::1 in it.
    ["::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 32],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
  ] as const)
    blocked.addSubnet(network, prefix, "ipv6");
  return blocked;
}

/** An IPv6 address's eight 16-bit groups; a zone and a dotted IPv4 tail are understood. */
function groupsOf(address: string): number[] | undefined {
  let text = address.toLowerCase().split("%")[0] ?? "";
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array<string>(Math.max(fill, 0)).fill("0"), ...right];
  return groups.length === 8 ? groups.map((group) => Number.parseInt(group, 16)) : undefined;
}

/**
 * The IPv4 address an IPv6 address carries, in the forms that reach it: NAT64's well-known
 * prefix (64:ff9b::/96), IPv4-translated (::ffff:0:0:0/96) and 6to4 (2002::/16).
 */
function carriedIPv4(address: string): string | undefined {
  const g = groupsOf(address);
  if (!g) return undefined;
  const v4 = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6] ?? 0, g[7] ?? 0);
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6] ?? 0, g[7] ?? 0);
  if (g[0] === 0x2002) return v4(g[1] ?? 0, g[2] ?? 0);
  return undefined;
}

/** Whether `net` may connect to an address: an IP address, not blocked, and carrying none that is. */
export function isPublicAddress(address: string, blocked = blockedAddresses()): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (blocked.check(address, family === 6 ? "ipv6" : "ipv4")) return false;
  const carried = family === 6 ? carriedIPv4(address) : undefined;
  return !carried || !blocked.check(carried, "ipv4");
}

/** Headers that describe one hop, not the message. */
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
  "host",
]);

/**
 * An upstream response's headers for the consumer: hop-by-hop ones dropped, and the SDK's error
 * header too, so no server out there can make the consumer's fetch throw.
 */
function responseHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    const lower = name.toLowerCase();
    if (HOP.has(lower) || lower === ERROR_HEADER) continue;
    if (Array.isArray(value)) for (const one of value) headers.append(name, one);
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

/**
 * The built-in `net` Actor's `http.egress@1`: a consumer's request, made from the Hub's process to
 * the public internet over HTTPS. The host is resolved and every address checked; the connection
 * goes to the checked address (with the name for SNI and the certificate), so a second resolution
 * can't move it. Redirects come back as they are. Each request's method, host and status are
 * audited; bodies never are.
 */
export class Net {
  readonly #state: HubState;
  readonly #lookup: (host: string) => Promise<LookupAddress[]>;
  readonly #ca: string[] | undefined;
  readonly #idleMs: number;
  readonly #blocked: BlockList;

  constructor(state: HubState, options: NetOptions = {}) {
    this.#state = state;
    this.#lookup = options.lookup ?? ((host) => dnsLookup(host, { all: true, verbatim: true }));
    this.#ca = options.ca ? [...rootCertificates, options.ca] : undefined;
    this.#idleMs = options.idleMs ?? 5 * 60_000;
    this.#blocked = options.blocked ?? blockedAddresses();
  }

  /** One request, for the consumer's slot. Refusals and failures throw the SDK's errors. */
  async handle(request: Request, by: { consumer: string; slot: string }): Promise<Response> {
    const url = new URL(request.url);
    const audit = (outcome: { status: number } | { error: string }) => {
      try {
        this.#state.auditHub(
          "net.request",
          { ...by, method: request.method, host: url.host, ...outcome },
          NET,
        );
      } catch {
        // The state is closed: the Hub is shutting down.
      }
    };
    try {
      const response = await this.#send(request, url);
      audit({ status: response.status });
      return response;
    } catch (error) {
      audit({ error: error instanceof Refused ? error.code : (error as Error).name });
      throw error;
    }
  }

  async #send(request: Request, url: URL): Promise<Response> {
    if (url.protocol !== "https:")
      throw new Refused("forbidden", `net reaches only https: URLs, not ${url.protocol}.`);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let addresses: LookupAddress[];
    if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
    else
      try {
        addresses = await this.#lookup(host);
      } catch {
        throw new Refused("unreachable", `${host} doesn't resolve.`);
      }
    if (!addresses.length) throw new Refused("unreachable", `${host} doesn't resolve.`);
    for (const { address } of addresses)
      if (!isPublicAddress(address, this.#blocked))
        throw new Refused(
          "forbidden",
          `${host} is at ${address}, which isn't on the public internet.`,
        );
    const target = addresses[0] as LookupAddress;
    const sendsBody =
      Boolean(request.body) && request.method !== "GET" && request.method !== "HEAD";
    const headers: Record<string, string | string[]> = {};
    request.headers.forEach((value, name) => {
      if (HOP.has(name) || name === "set-cookie") return;
      // The length comes from the body net sends, which is none for GET and HEAD.
      if (name === "content-length" || name === "expect") return;
      headers[name] = value;
    });
    headers.host = url.host;
    return new Promise((resolve, reject) => {
      /** Whether anything may have reached the server: from the TLS handshake on. */
      let connected = false;
      const options: RequestOptions = {
        host,
        port: Number(url.port || 443),
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        agent: false,
        ...(this.#ca ? { ca: this.#ca } : {}),
        // Every address was checked: the connection goes to one of them (node falls back between
        // them), never to a new lookup.
        lookup: (_name, options, callback) => {
          if ((options as { all?: boolean }).all)
            (callback as (error: null, addresses: LookupAddress[]) => void)(null, addresses);
          else callback(null, target.address, target.family);
        },
      };
      const outgoing = httpsRequest(options, (incoming) => {
        const status = incoming.statusCode ?? 0;
        // Whatever a server out there answers, it ends as a response or an error, never a throw
        // in this process.
        try {
          if (status < 200 || status > 599) throw new Error(`a status of ${status}`);
          const empty =
            request.method === "HEAD" || status === 204 || status === 205 || status === 304;
          const response = new Response(
            empty ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
            {
              status,
              statusText: incoming.statusMessage ?? "",
              headers: responseHeaders(incoming.headers),
            },
          );
          if (empty) incoming.resume();
          resolve(response);
        } catch (error) {
          incoming.destroy();
          reject(
            new OutcomeUnknown(
              `${url.host} answered what isn't an HTTP response net passes on: ${(error as Error).message}`,
            ),
          );
        }
      });
      // An upgrade nobody asked for: the request had reached the server.
      outgoing.on("upgrade", (_response, socket) => {
        socket.destroy();
        reject(new OutcomeUnknown(`${url.host} switched protocols, which net doesn't follow.`));
      });
      outgoing.on("socket", (socket) => socket.once("secureConnect", () => (connected = true)));
      // Before the TLS handshake is done nothing has been sent, so a quiet server is unreachable.
      outgoing.setTimeout(this.#idleMs, () =>
        outgoing.destroy(
          connected
            ? new OutcomeUnknown(`${url.host} sent nothing for ${this.#idleMs / 1000} s.`)
            : new Refused(
                "unreachable",
                `${url.host} didn't finish connecting within ${this.#idleMs / 1000} s.`,
              ),
        ),
      );
      outgoing.on("error", (error) =>
        reject(
          error instanceof OutcomeUnknown || error instanceof Refused
            ? error
            : connected
              ? new OutcomeUnknown(`The request to ${url.host} failed: ${error.message}`)
              : new Refused("unreachable", `${url.host} couldn't be reached: ${error.message}`),
        ),
      );
      const abort = () => outgoing.destroy(request.signal.reason ?? new Error("aborted"));
      if (request.signal.aborted) return abort();
      request.signal.addEventListener("abort", abort, { once: true });
      outgoing.once("close", () => request.signal.removeEventListener("abort", abort));
      if (!sendsBody || !request.body) return void outgoing.end();
      pipeline(Readable.fromWeb(request.body as NodeReadableStream), outgoing).catch((error) =>
        outgoing.destroy(error),
      );
    });
  }
}
