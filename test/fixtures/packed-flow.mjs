import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectClient } from "@agentorg/cli/actor";
import {
  ConnectionPage,
  Form,
  Message,
  ProviderPage,
  SystemStatus,
  Work,
} from "@agentorg/cli/contract";

const rootDirectory = process.cwd();
const home = mkdtempSync(join(tmpdir(), "agentorg-packed-home-"));
const serverBin = join(rootDirectory, "node_modules/@agentorg/cli/dist/src/server/bin.js");
let server, closed;
let clients = [];
let lastLog = "";
const launch = async () => {
  server = spawn(process.execPath, [serverBin, "--port", "0"], {
    env: { PATH: process.env.PATH ?? "", AGENTORG_HOME: home },
    stdio: ["ignore", "ignore", "pipe"],
  });
  closed = once(server, "exit");
  lastLog = "";
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("owned Hub startup timeout")), 15000);
    server.stderr.on("data", (chunk) => {
      lastLog += chunk;
      const match = /serving on (http:\/\/[\d.:]+)/.exec(lastLog);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`owned Hub exited ${code}`));
    });
  });
  return url;
};
const stop = async () => {
  await Promise.allSettled(clients.map((client) => client.close()));
  clients = [];
  if (server?.exitCode === null) {
    server.kill("SIGTERM");
    await closed;
  }
};
const client = async (url, actorId, credential) => {
  const item = await connectClient({ url, actorId, credential });
  clients.push(item);
  return item;
};
const done = async (promise) => {
  const result = await promise;
  assert.equal(result.state, "done", JSON.stringify(result));
  return result.value;
};
const deny = async (promise, code) => {
  const result = await promise;
  assert.equal(result.state, "refused");
  assert.equal(result.code, code);
};
try {
  let url = await launch();
  const rootID = readFileSync(join(home, "root-actor"), "utf8").trim();
  const rootCredential = readFileSync(join(home, "root-credential"), "utf8").trim();
  let root = await client(url, rootID, rootCredential);
  const ownerRecord = await done(
    root.call("actor_create", { name: "owner", purpose: "Own fixture work" }),
  );
  const requesterRecord = await done(
    root.call("actor_create", { name: "requester", purpose: "Review fixture work" }),
  );
  const ownerID = ownerRecord.actor.id,
    requesterID = requesterRecord.actor.id;
  let owner = await client(url, ownerID, ownerRecord.credential);
  let requester = await client(url, requesterID, requesterRecord.credential);
  const catalog = await root.available();
  assert.equal(catalog.length, 10);
  assert.equal(catalog.flatMap((tool) => tool.interfaces).length, 27);
  assert.deepEqual(await owner.available(), catalog);
  const system = catalog.find((tool) => tool.id === "hub:system");
  assert.deepEqual(
    system.interfaces.map((offer) => [offer.call, offer.read_only]),
    [
      ["system_status", true],
      ["connection_list", true],
      ["provider_list", true],
      ["connection_disconnect", false],
    ],
  );
  const systemStatus = SystemStatus.parse(await done(root.call("system_status")));
  assert.equal(systemStatus.nodeVersion, process.version);
  assert.equal(systemStatus.state, "serving");
  assert.equal(systemStatus.actorConnections, 3);
  assert.deepEqual(
    ProviderPage.parse(await done(owner.call("provider_list", { connected: false }))).items,
    [],
  );
  const rootConnection = ConnectionPage.parse(
    await done(root.call("connection_list", { actorId: rootID })),
  ).items[0];
  assert.equal(rootConnection.blockedBy, "current_connection");
  await deny(
    root.call("connection_disconnect", {
      instanceId: systemStatus.instanceId,
      connectionId: rootConnection.connectionId,
    }),
    "conflict",
  );
  await deny(
    owner.call("connection_disconnect", {
      instanceId: systemStatus.instanceId,
      connectionId: rootConnection.connectionId,
    }),
    "forbidden",
  );
  const otherOwner = await client(url, ownerID, ownerRecord.credential);
  const beforeDetach = ConnectionPage.parse(
    await done(otherOwner.call("connection_list", { actorId: ownerID })),
  );
  const target = beforeDetach.items.find((entry) => entry.blockedBy === "current_connection");
  const detached = await done(
    root.call("connection_disconnect", {
      instanceId: systemStatus.instanceId,
      connectionId: target.connectionId,
    }),
  );
  assert.equal(detached.closed, true);
  const deadline = Date.now() + 15000;
  let reconnected = false;
  while (!reconnected) {
    try {
      const rows = ConnectionPage.parse(
        await done(otherOwner.call("connection_list", { actorId: ownerID })),
      );
      reconnected = rows.items.some(
        (entry) =>
          entry.blockedBy === "current_connection" && entry.connectionId !== target.connectionId,
      );
    } catch {}
    assert.ok(Date.now() < deadline, "detached packed SDK reconnects with a new connection ID");
    if (!reconnected) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(otherOwner.ended, undefined);
  await otherOwner.close();
  for (const [name, filters] of [
    ["message_list", ["counterpartyID", "before"]],
    ["work_list", ["ownerWithin", "requesterWithin"]],
    ["form_list", ["requesterWithin", "respondentWithin", "awaitingWithin"]],
  ]) {
    const offer = catalog
      .flatMap((tool) => tool.interfaces)
      .find((item) => item.interface.name === name);
    assert.ok(offer);
    for (const filter of filters) assert.ok(offer.interface.input.properties[filter]);
  }
  assert.equal((await done(owner.call("actor_get"))).actorID, ownerID);
  assert.equal((await done(root.call("actor_list"))).items.length, 3);
  const sent = Message.parse(
    await done(
      owner.call("message_send", { recipientID: requesterID, text: "Immutable P2P fixture" }),
    ),
  );
  assert.equal(sent.senderID, ownerID);
  await deny(root.call("message_get", { messageID: sent.messageID }), "not_found");
  assert.deepEqual(await done(requester.call("message_get", { messageID: sent.messageID })), sent);
  const page = await done(requester.call("message_list", { direction: "incoming", limit: 1 }));
  assert.deepEqual(page.items, [sent]);
  let form = Form.parse(
    await done(
      requester.call("form_create", {
        respondentIDs: [ownerID],
        fields: [{ name: "answer", label: "Answer", required: false }],
      }),
    ),
  );
  assert.equal("workID" in form, false);
  assert.deepEqual(await done(root.call("form_get", { formID: form.formID })), form);
  assert.deepEqual((await done(root.call("form_list", { awaitingActorID: ownerID }))).items, [
    form,
  ]);
  assert.deepEqual(
    (
      await done(
        root.call("form_list", {
          requesterWithin: requesterID,
          respondentWithin: ownerID,
          awaitingWithin: ownerID,
          requesterID,
          respondentID: ownerID,
          status: "open",
          limit: 1,
        }),
      )
    ).items,
    [form],
  );
  await deny(
    root.call("form_respond", {
      formID: form.formID,
      expectedRevision: form.revision,
      answers: { answer: "Not designated" },
    }),
    "forbidden",
  );
  assert.equal((await done(owner.call("form_list"))).items[0].formID, form.formID);
  form = Form.parse(
    await done(
      owner.call("form_respond", {
        formID: form.formID,
        expectedRevision: form.revision,
        answers: {},
      }),
    ),
  );
  assert.deepEqual(await done(root.call("form_list", { awaitingActorID: ownerID })), {
    items: [],
    after: 0,
  });
  assert.deepEqual(form.responses[ownerID], {});
  assert.deepEqual(await done(root.call("form_list", { awaitingWithin: ownerID })), {
    items: [],
    after: 0,
  });
  form = Form.parse(
    await done(
      requester.call("form_close", {
        formID: form.formID,
        expectedRevision: form.revision,
        status: "resolved",
        resolution: "Fixture decided",
      }),
    ),
  );
  let work = Work.parse(
    await done(requester.call("work_create", { ownerID, goal: "Prove packed public SDK" })),
  );
  assert.deepEqual(await done(root.call("work_get", { ticketID: work.ticketID })), work);
  assert.deepEqual(
    (await done(root.call("work_list", { ownerID, requesterID, status: "open" }))).items,
    [work],
  );
  assert.deepEqual(
    (
      await done(
        root.call("work_list", {
          ownerWithin: ownerID,
          requesterWithin: requesterID,
          ownerID,
          requesterID,
          status: "open",
        }),
      )
    ).items,
    [work],
  );
  for (const name of ["ownerWithin", "requesterWithin"])
    assert.deepEqual(await done(root.call("work_list", { [name]: "unknown" })), {
      items: [],
      after: 0,
    });
  for (const name of ["requesterWithin", "respondentWithin", "awaitingWithin"])
    assert.deepEqual(await done(root.call("form_list", { [name]: "unknown" })), {
      items: [],
      after: 0,
    });
  await deny(
    root.call("work_update", {
      ticketID: work.ticketID,
      expectedRevision: work.revision,
      progress: "Not owner",
    }),
    "forbidden",
  );
  assert.equal((await done(root.call("actor_get"))).actorID, rootID);
  work = Work.parse(
    await done(
      owner.call("work_update", {
        ticketID: work.ticketID,
        expectedRevision: work.revision,
        status: "active",
        progress: "Checking",
      }),
    ),
  );
  await deny(
    owner.call("work_update", { ticketID: work.ticketID, expectedRevision: 1, progress: "Stale" }),
    "conflict",
  );
  assert.equal((await done(owner.call("work_list"))).items[0].ticketID, work.ticketID);
  work = Work.parse(
    await done(
      owner.call("work_submit", {
        ticketID: work.ticketID,
        expectedRevision: work.revision,
        result: "Verified",
        evidence: ["owned fixture"],
      }),
    ),
  );
  work = Work.parse(
    await done(
      requester.call("work_review", {
        ticketID: work.ticketID,
        expectedRevision: work.revision,
        submissionID: work.submission.submissionID,
        verdict: "accepted",
        comment: "Accepted fixture",
      }),
    ),
  );
  await done(owner.call("claim", { resource: "owned-lane", note: "Verification" }));
  await deny(requester.call("claim", { resource: "owned-lane", note: "Competing" }), "conflict");
  await done(owner.call("release", { resource: "owned-lane" }));
  const team = await done(owner.call("team", { depth: 0 }));
  assert.deepEqual(Object.keys(team).sort(), ["positions", "root"]);
  assert.equal(team.positions[0].online, true);
  const audit = await done(root.call("activity"));
  assert.equal(JSON.stringify(audit).includes(sent.text), false);
  assert.equal(JSON.stringify([work, form, audit]).includes("read_at"), false);
  for (const retired of [
    "messages",
    "message_read",
    "progress",
    "progress_set",
    "question_ask",
    "questions",
  ])
    await deny(owner.call(retired, {}), "not_found");
  await stop();
  url = await launch();
  root = await client(url, rootID, rootCredential);
  const restartedSystem = SystemStatus.parse(await done(root.call("system_status")));
  assert.notEqual(restartedSystem.instanceId, systemStatus.instanceId);
  await deny(
    root.call("connection_list", {
      instanceId: systemStatus.instanceId,
      after: beforeDetach.after,
    }),
    "conflict",
  );
  owner = await client(url, ownerID, ownerRecord.credential);
  requester = await client(url, requesterID, requesterRecord.credential);
  assert.deepEqual(await done(requester.call("message_get", { messageID: sent.messageID })), sent);
  assert.deepEqual(await done(owner.call("form_get", { formID: form.formID })), form);
  assert.deepEqual(await done(owner.call("work_get", { ticketID: work.ticketID })), work);
  assert.deepEqual(await done(requester.call("message_list", { after: page.after })), {
    items: [],
    after: page.after,
  });
  // Exercise selected conversations after the unchanged old forward/restart assertions.
  for (let i = 0; i < 103; i++)
    await done(owner.call("message_send", { recipientID: ownerID, text: `owned noise ${i}` }));
  const incomingQuery = Message.parse(
    await done(requester.call("message_send", { recipientID: ownerID, text: "selected inbound" })),
  );
  const outgoingQuery = Message.parse(
    await done(owner.call("message_send", { recipientID: requesterID, text: "selected outbound" })),
  );
  const recentQuery = await done(
    owner.call("message_list", { counterpartyID: requesterID, before: "latest", limit: 2 }),
  );
  assert.deepEqual(recentQuery, {
    items: [incomingQuery, outgoingQuery],
    after: outgoingQuery.cursor,
  });
  assert.deepEqual(
    await done(
      owner.call("message_list", { counterpartyID: requesterID, before: incomingQuery.cursor }),
    ),
    { items: [sent], after: sent.cursor },
  );
  assert.deepEqual(
    (
      await done(
        owner.call("message_list", {
          counterpartyID: requesterID,
          direction: "incoming",
          before: Number.MAX_SAFE_INTEGER,
        }),
      )
    ).items,
    [incomingQuery],
  );
  await deny(
    owner.call("message_list", { counterpartyID: requesterID, before: "latest", after: 1 }),
    "invalid",
  );
  await deny(owner.call("message_list", { before: "latest" }), "invalid");
  assert.deepEqual(
    await done(root.call("message_list", { counterpartyID: ownerID, before: "latest" })),
    { items: [], after: 0 },
  );
  const unseenQuery = Message.parse(
    await done(requester.call("message_send", { recipientID: ownerID, text: "unseen inbound" })),
  );
  const ownQuery = Message.parse(
    await done(owner.call("message_send", { recipientID: requesterID, text: "own send gap" })),
  );
  assert.deepEqual(
    (
      await done(
        owner.call("message_list", { counterpartyID: requesterID, after: recentQuery.after }),
      )
    ).items,
    [unseenQuery, ownQuery],
  );
  await owner.close();
  await done(root.call("actor_close", { actor: ownerID }));
  assert.equal((await done(requester.call("actor_get", { actorID: ownerID }))).state, "closed");
  assert.deepEqual(
    (
      await done(
        requester.call("message_list", { counterpartyID: ownerID, before: "latest", limit: 2 }),
      )
    ).items,
    [unseenQuery, ownQuery],
  );
  assert.equal((await done(root.call("actor_list"))).items.length, 2);
  assert.deepEqual(
    (await done(root.call("work_list", { ownerWithin: ownerID, requesterWithin: requesterID })))
      .items,
    [work],
  );
  assert.deepEqual(
    (
      await done(
        root.call("form_list", { respondentWithin: ownerID, requesterWithin: requesterID }),
      )
    ).items,
    [form],
  );
  const pin = JSON.parse(
    readFileSync(join(rootDirectory, "node_modules/@agentorg/cli/vendor/workspace.json"), "utf8"),
  );
  const digest = createHash("sha256")
    .update(readFileSync(join(rootDirectory, "node_modules/@agentorg/cli/vendor", pin.archive)))
    .digest("hex");
  assert.equal(digest, pin.sha256);
  const lock = JSON.parse(readFileSync(join(rootDirectory, "package-lock.json"), "utf8"));
  const bundled = Object.entries(lock.packages).filter(([name]) =>
    name.endsWith("/@uniac/agentic-workspace"),
  );
  assert.equal(bundled.length, 1);
  assert.equal(bundled[0][1].inBundle, true);
  const installed = JSON.parse(
    readFileSync(join(rootDirectory, bundled[0][0], "package.json"), "utf8"),
  );
  assert.equal(installed.version, pin.version);
  const result = {
    ok: true,
    node: process.version,
    toolCount: 10,
    interfaceCount: 27,
    workspaceSource: pin.source,
    workspaceSha256: digest,
    workspaceVersion: pin.version,
    workspaceBundled: true,
    publicWorkFormHistory: true,
    directedFilters: true,
    subtreeFilters: true,
    closedSubtreeHistory: true,
    discoverySubtreeSchemas: true,
    emptyResponseAnswered: true,
    restartPersistence: true,
    systemStatusAndSchemas: true,
    systemConnectionAuthority: true,
    transientDetachAndReconnect: true,
    staleRunCursorRefused: true,
    allWorkspaceOperations: true,
    standaloneForms: true,
    p2pPrivacy: true,
    selectedMessageQueries: true,
    discoveryMessageQuerySchemas: true,
    privateRecentAndExclusiveOlder: true,
    closedPeerConversation: true,
    ownSendKeepsUnseenInbound: true,
    revisionConflict: true,
    ownedResourcesCleaned: true,
  };
  writeFileSync(
    process.env.PROOF_OUTPUT ?? "/tmp/agentorg-packed-proof.json",
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(JSON.stringify(result));
} finally {
  await stop();
  rmSync(home, { recursive: true, force: true });
}
