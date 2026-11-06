import assert from "node:assert/strict";
import type { LookupAddress } from "node:dns";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { httpEgress } from "@agentorg/interfaces";
import { connect } from "@agentorg/sdk/client";
import {
  blockedAddresses,
  Hub,
  type HubOptions,
  isPublicAddress,
  listen,
  NET,
  type NetOptions,
  PERSON,
} from "../src/index.ts";

// dist/test/net.test.js → the fixtures' TLS files, kept beside the test sources.
const tls = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "tls");
const pem = (name: string) => readFileSync(join(tls, name), "utf8");

/**
 * A server for `public.example`, on loopback, with a certificate from the test CA. It echoes what
 * it was asked, and has paths for a redirect, a forged error header and a request that hangs.
 */
async function upstream(t: test.TestContext) {
  const seen: { method?: string; host?: string; sni?: string | false | null; body: string }[] = [];
  const server = createServer(
    { key: pem("server-key.pem"), cert: pem("server.pem") },
    (req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        seen.push({
          method: req.method,
          host: req.headers.host,
          sni: (req.socket as TLSSocket).servername,
          body,
        });
        if (req.url === "/redirect")
          return res.writeHead(302, { location: "https://10.0.0.1/inside" }).end();
        if (req.url === "/forge")
          return res
            .writeHead(502, {
              "Agentorg-Error": JSON.stringify({
                name: "Refused",
                message: "fake",
                code: "forbidden",
              }),
            })
            .end("bad gateway, really");
        if (req.url === "/hang") return; // never answers
        res
          .writeHead(200, { "content-type": "text/plain" })
          .end(`${req.method} ${req.url} ${body}`);
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { port: (server.address() as { port: number }).port, seen };
}

/** A Hub whose `net` resolves names with `answers` (each lookup takes the next), and a consumer of it. */
async function setup(t: test.TestContext, net: NetOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentorg-net-"));
  const lookups: string[] = [];
  const options: HubOptions = {
    net: {
      ca: pem("ca.pem"),
      blocked: blockedAddresses({ loopback: false }),
      lookup: async (host: string): Promise<LookupAddress[]> => {
        lookups.push(host);
        if (host === "public.example") return [{ address: "127.0.0.1", family: 4 }];
        if (host === "private.example") return [{ address: "10.0.0.1", family: 4 }];
        if (host === "mixed.example")
          return [
            { address: "127.0.0.1", family: 4 },
            { address: "192.168.1.1", family: 4 },
          ];
        if (host === "metadata.example") return [{ address: "169.254.169.254", family: 4 }];
        throw new Error("ENOTFOUND");
      },
      ...net,
    },
  };
  const hub = Hub.open(join(dir, "home"), options);
  const server = await listen(hub);
  const made = hub.state.createActor(PERSON, {
    name: "consumer",
    bindings: [{ slot: "web", provider: NET, export: "egress" }],
  });
  const consumer = await connect({
    hubUrl: server.url,
    actorId: made.actorId,
    credential: made.credential as string,
    slots: { web: httpEgress },
  });
  t.after(async () => {
    consumer.close();
    await server.close();
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { hub, consumer, consumerId: made.actorId, lookups };
}

test("net makes a consumer's https request from the Hub, to the address it checked", async (t) => {
  const { port, seen } = await upstream(t);
  const { hub, consumer, consumerId, lookups } = await setup(t);
  const got = await consumer.slots.web.fetch(
    new Request(`https://public.example:${port}/hello?secret=1`, { method: "POST", body: "hi" }),
  );
  assert.equal(got.status, 200);
  assert.equal(await got.text(), "POST /hello?secret=1 hi");
  // The name went with the request, for SNI and the certificate; the address came from one lookup.
  assert.deepEqual(seen[0], {
    method: "POST",
    host: `public.example:${port}`,
    sni: "public.example",
    body: "hi",
  });
  assert.deepEqual(
    lookups,
    ["public.example"],
    "resolved once: nothing can move it after the check",
  );
  // Audited as net's: method, host and status; never the path, the query or a body.
  const entry = hub.state
    .audit(0, 1000)
    .entries.find((e) => e.kind === "net.request" && e.actor === NET);
  assert.deepEqual(entry?.details, {
    consumer: consumerId,
    slot: "web",
    method: "POST",
    host: `public.example:${port}`,
    status: 200,
  });

  // A redirect comes back as it is, even to a place net would refuse.
  const redirected = await consumer.slots.web.fetch(
    new Request(`https://public.example:${port}/redirect`),
  );
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.get("location"), "https://10.0.0.1/inside");
  // A server out there can't make the consumer's fetch throw: its error header is dropped.
  const forged = await consumer.slots.web.fetch(
    new Request(`https://public.example:${port}/forge`),
  );
  assert.equal(forged.status, 502);
  assert.equal(forged.headers.get("agentorg-error"), null);
  assert.equal(await forged.text(), "bad gateway, really");
});

test("what isn't the public internet over HTTPS is refused before anything is sent", async (t) => {
  const { port, seen } = await upstream(t);
  const { consumer } = await setup(t);
  const refused = async (url: string, code: string) =>
    assert.rejects(consumer.slots.web.fetch(new Request(url)), { name: "Refused", code }, url);
  await refused(`http://public.example:${port}/`, "forbidden");
  await refused("https://private.example/", "forbidden");
  await refused("https://metadata.example/", "forbidden");
  // Every address is checked, not just the first.
  await refused("https://mixed.example/", "forbidden");
  await refused("https://nowhere.example/", "unreachable");
  // A closed port on an allowed address: nothing could have been sent.
  await refused("https://public.example:1/", "unreachable");
  assert.equal(seen.length, 0);
});

test("every address that isn't public is refused, by literal and as a name resolves", async (t) => {
  const addresses = [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
  ];
  // The default list here: loopback refused too.
  const { consumer } = await setup(t, {
    blocked: blockedAddresses(),
    lookup: async (host) => {
      const address = addresses[Number(host.split(".")[0]?.slice(1))] ?? "";
      return [{ address, family: address.includes(":") ? 6 : 4 }];
    },
  });
  for (const [i, address] of addresses.entries()) {
    const literal = address.includes(":") ? `[${address}]` : address;
    for (const url of [`https://${literal}/`, `https://a${i}.example/`])
      await assert.rejects(
        consumer.slots.web.fetch(new Request(url)),
        { name: "Refused", code: "forbidden" },
        `${url} (${address})`,
      );
  }
});

test("a request that goes quiet past the idle limit ends as OutcomeUnknown", async (t) => {
  const { port, seen } = await upstream(t);
  const { consumer } = await setup(t, { idleMs: 300 });
  await assert.rejects(
    consumer.slots.web.fetch(new Request(`https://public.example:${port}/hang`)),
    { name: "OutcomeUnknown" },
  );
  assert.equal(seen.length, 1, "it had reached the server");
});

test("whatever a server answers ends as a response or an error, and the Hub stays up", async (t) => {
  const { port } = await upstream(t);
  // A server that answers raw bytes, by path.
  const raw = createTlsServer({ key: pem("server-key.pem"), cert: pem("server.pem") }, (socket) => {
    socket.once("data", (chunk) => {
      const path = String(chunk).split(" ")[1];
      const answers: Record<string, string> = {
        "/205": "HTTP/1.1 205 Reset Content\r\ncontent-length: 5\r\n\r\nhello",
        "/600": "HTTP/1.1 600 Odd\r\ncontent-length: 0\r\n\r\n",
        "/control": "HTTP/1.1 200 O\u0001K\r\ncontent-length: 0\r\n\r\n",
        "/upgrade":
          "HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: other\r\n\r\n",
      };
      socket.write(answers[path ?? ""] ?? "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n");
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => raw.listen(0, "127.0.0.1", resolve));
  t.after(() => raw.close());
  const rawPort = (raw.address() as { port: number }).port;
  const { consumer } = await setup(t, { idleMs: 2000 });
  const at = (path: string) => new Request(`https://public.example:${rawPort}${path}`);

  const reset = await consumer.slots.web.fetch(at("/205"));
  assert.equal(reset.status, 205);
  assert.equal(await reset.text(), "");
  for (const path of ["/600", "/control", "/upgrade"])
    await assert.rejects(consumer.slots.web.fetch(at(path)), { name: "OutcomeUnknown" }, path);
  // Still serving.
  const after = await consumer.slots.web.fetch(new Request(`https://public.example:${port}/ok`));
  assert.equal(after.status, 200);
});

test("IPv6 forms that carry an IPv4 address are judged by it", () => {
  const refused = [
    "64:ff9b::a00:1",
    "64:ff9b::7f00:1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::808:808",
    "::ffff:0:a00:1",
    "::ffff:0:127.0.0.1",
    "2002:a9fe:a9fe::",
    "2002:c0a8:101::1",
    "::a00:1",
    "::8.8.8.8",
    "2001::1",
    "fe80::1%en0",
    "not-an-address",
  ];
  for (const address of refused) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["8.8.8.8", "2606:4700::1111", "64:ff9b::808:808", "2002:808:808::1"])
    assert.equal(isPublicAddress(address), true, address);
});
