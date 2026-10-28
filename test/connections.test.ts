/** The connection layer: credentials, both endpoints, pairing, online state and exposed tools. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Core, rootCredential } from "../src/core/index.ts";
import { Store } from "../src/core/store.ts";
import {
  CLOSE_ACTOR_CLOSED,
  CLOSE_REPLACED,
  MCP_PATH,
  REVERSE_PATH,
  SUBPROTOCOL,
} from "../src/protocol/index.ts";
import { fakeActor, startCore, tool, until } from "./harness.ts";

test("the first start creates the root and its credential file, readable only by its owner", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentorg-root-"));
  try {
    const file = join(directory, "root-credential");
    const store = new Store(join(directory, "core.db"));
    const core = new Core(store);
    const credential = rootCredential(core.registry, file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const root = core.registry.root();
    assert.equal(root?.manager, null);
    assert.equal(core.registry.byCredential(credential)?.id, root?.id);
    // A later start reads the same credential.
    assert.equal(rootCredential(core.registry, file), credential);

    // Without the file, a new credential is minted and the old one stops working.
    rmSync(file);
    const minted = rootCredential(core.registry, file);
    assert.notEqual(minted, credential);
    assert.equal(core.registry.byCredential(credential), undefined);
    assert.equal(core.registry.root()?.id, root?.id);

    // A file that holds something else is refused rather than overwritten.
    writeFileSync(file, "not-the-credential\n", { mode: 0o600 });
    assert.throws(() => rootCredential(core.registry, file), /does not hold the root's credential/);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("both endpoints refuse a missing or wrong credential and any request from a web page", async () => {
  const core = await startCore();
  try {
    const post = (headers: Record<string, string>) =>
      fetch(`${core.url}${MCP_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ Authorization: "Bearer sentinel-not-a-credential" })).status, 401);
    const fromPage = await post({
      Authorization: `Bearer ${core.root}`,
      Origin: "http://evil.test",
    });
    assert.equal(fromPage.status, 403);

    const upgrade = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const url = `${core.url.replace("http", "ws")}${REVERSE_PATH}`;
        const socket = new WebSocket(url, {
          protocols: [SUBPROTOCOL],
          headers,
        } as unknown as string[]);
        socket.onopen = () => {
          socket.close();
          resolve(101);
        };
        socket.onerror = () => resolve(-1);
      });
    assert.equal(await upgrade({ Authorization: "Bearer sentinel-not-a-credential" }), -1);
    assert.equal(
      await upgrade({ Authorization: `Bearer ${core.root}`, Origin: "http://evil.test" }),
      -1,
    );
    assert.equal(await upgrade({ Authorization: `Bearer ${core.root}` }), 101);
  } finally {
    await core.close();
  }
});

test("an actor's client on /mcp acts as the actor its credential names", async () => {
  const core = await startCore();
  try {
    const client = new Client({ name: "probe", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(MCP_PATH, core.url), {
        requestInit: { headers: { Authorization: `Bearer ${core.root}` } },
      }),
    );
    assert.deepEqual(client.getServerVersion()?.name, "agentorg");
    assert.ok(Array.isArray((await client.listTools()).tools));
    await client.close();
  } finally {
    await core.close();
  }
});

test("the core lists an actor's tools over its reverse connection and marks it online", async () => {
  const core = await startCore();
  try {
    const { actor: storage, credential } = core.core.registry.create(
      core.rootId,
      "storage",
      "Storage",
    );
    assert.equal(core.core.registry.get(storage.id)?.online, false);
    const fake = fakeActor([tool("review"), tool("not.a.handle"), tool("archive")]);
    await core.connect(credential, fake);
    await until("storage online", () => core.core.registry.get(storage.id)?.online === true);
    const listed = core.core.registry.get(storage.id)?.tools.map((each) => each.name);
    assert.deepEqual(listed, ["review", "archive"], "a tool whose name has a dot is not listed");
    assert.ok(core.core.connections.peer(storage.id));

    // A list_changed notification makes the core list again.
    fake.tools.push(tool("restore"));
    await fake.server.sendToolListChanged();
    await until("restore listed", () =>
      (core.core.registry.get(storage.id)?.tools ?? []).some((each) => each.name === "restore"),
    );
  } finally {
    await core.close();
  }
});

test("a newer reverse connection replaces the older, which does not dial again", async () => {
  const core = await startCore();
  try {
    const { actor, credential } = core.core.registry.create(core.rootId, "web", "Web");
    const first = await core.connect(credential, fakeActor([tool("one")]));
    await until("first online", () => core.core.registry.get(actor.id)?.online === true);
    const firstPeer = core.core.connections.peer(actor.id);

    await core.connect(credential, fakeActor([tool("two")]));
    await until("first replaced", () => first.ended === CLOSE_REPLACED);
    await until("second's tools listed", () =>
      (core.core.registry.get(actor.id)?.tools ?? []).some((each) => each.name === "two"),
    );
    assert.notEqual(core.core.connections.peer(actor.id), firstPeer);
    assert.equal(core.core.registry.get(actor.id)?.online, true);
  } finally {
    await core.close();
  }
});

test("a closed actor's credential is refused and its reverse connection ends for good", async () => {
  const core = await startCore();
  try {
    const { actor, credential } = core.core.registry.create(core.rootId, "old", "Old");
    const connection = await core.connect(credential);
    await until("online", () => core.core.registry.get(actor.id)?.online === true);

    core.core.registry.close(actor.id);
    await core.core.connections.disconnect(actor.id);
    await until("ended", () => connection.ended === CLOSE_ACTOR_CLOSED);
    assert.equal(core.core.registry.get(actor.id)?.online, false);
    assert.equal(core.core.connections.identify(credential), undefined);
    const refused = await fetch(`${core.url}${MCP_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}` },
    });
    assert.equal(refused.status, 401);
  } finally {
    await core.close();
  }
});

test("an actor dials its reverse connection again after it drops", async () => {
  const core = await startCore();
  try {
    const { actor, credential } = core.core.registry.create(core.rootId, "batch", "Batch");
    await core.connect(credential, fakeActor([tool("run")]));
    await until("online", () => core.core.registry.get(actor.id)?.online === true);
    const before = core.core.connections.peer(actor.id);
    await core.core.connections.closeAll();
    await until("online again on a new connection", () => {
      const peer = core.core.connections.peer(actor.id);
      return (
        peer !== undefined && peer !== before && core.core.registry.get(actor.id)?.online === true
      );
    });
  } finally {
    await core.close();
  }
});
