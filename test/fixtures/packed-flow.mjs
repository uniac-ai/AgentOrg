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
  Status,
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
  assert.equal(catalog.length, 11);
  assert.equal(catalog.flatMap((tool) => tool.interfaces).length, 30);
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
    ["message_list", ["counterpartyID", "before", "after"]],
    ["work_list", ["ownerWithin", "requesterWithin", "updatedSince", "order"]],
    ["form_list", ["requesterWithin", "updatedSince", "order"]],
  ]) {
    const offer = catalog
      .flatMap((tool) => tool.interfaces)
      .find((item) => item.interface.name === name);
    assert.ok(offer);
    for (const filter of filters) assert.ok(offer.interface.input.properties[filter]);
  }
  const levels = Object.fromEntries(
    catalog.flatMap((tool) => tool.interfaces).map((offer) => [offer.call, offer.level]),
  );
  assert.deepEqual(
    ["status_set", "form_create", "form_respond", "message_send", "team", "actor_create"].map(
      (name) => levels[name],
    ),
    ["report", "report", "team", "team", "team", "organization"],
  );
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
  const status = Status.parse(
    await done(owner.call("status_set", { line: "Proving the packed SDK" })),
  );
  assert.deepEqual(await done(requester.call("status_get", { actorID: ownerID })), status);
  await deny(requester.call("status_get"), "not_found");
  let form = Form.parse(
    await done(
      requester.call("form_create", {
        title: "Publish the fixture?",
        approval: true,
        fields: [
          {
            name: "answer",
            label: "Answer",
            required: true,
            options: [{ value: "publish", detail: "After CI" }, { value: "hold" }],
            recommended: "publish",
          },
        ],
      }),
    ),
  );
  assert.equal("workID" in form, false);
  assert.deepEqual(await done(root.call("form_get", { formID: form.formID })), form);
  const listedAsks = await done(
    root.call("form_list", {
      requesterWithin: requesterID,
      requesterID: [requesterID, ownerID],
      status: ["open"],
      limit: 1,
    }),
  );
  assert.deepEqual(listedAsks.items, [form]);
  assert.deepEqual(listedAsks.actors, { [requesterID]: { name: "requester" } });
  await deny(
    owner.call("form_respond", { formID: form.formID, answers: { answer: "publish" } }),
    "forbidden",
  );
  await deny(
    requester.call("form_respond", { formID: form.formID, answers: { answer: "publish" } }),
    "forbidden",
  );
  form = Form.parse(
    await done(
      root.call("form_respond", {
        formID: form.formID,
        answers: { answer: "publish" },
        note: "Go",
      }),
    ),
  );
  assert.equal(form.status, "resolved");
  assert.deepEqual(form.responses[rootID].answers, { answer: "publish" });
  let question = Form.parse(
    await done(
      owner.call("form_create", {
        title: "Which lane?",
        fields: [{ name: "lane", label: "Lane", required: true }],
      }),
    ),
  );
  await deny(
    requester.call("form_close", {
      formID: question.formID,
      expectedRevision: question.revision,
      status: "resolved",
      resolution: "Not the asker",
    }),
    "forbidden",
  );
  question = Form.parse(
    await done(
      owner.call("form_close", {
        formID: question.formID,
        expectedRevision: question.revision,
        status: "resolved",
        resolution: "Answered in the session: the owned lane",
      }),
    ),
  );
  let work = Work.parse(
    await done(requester.call("work_create", { ownerID, title: "Prove packed public SDK" })),
  );
  assert.deepEqual(await done(root.call("work_get", { ticketID: work.ticketID })), work);
  assert.deepEqual(
    (await done(root.call("work_list", { ownerID, requesterID, status: ["open"] }))).items,
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
          status: ["open"],
        }),
      )
    ).items,
    [work],
  );
  for (const name of ["ownerWithin", "requesterWithin"])
    assert.deepEqual(await done(root.call("work_list", { [name]: "unknown" })), {
      items: [],
      next: null,
      actors: {},
    });
  assert.deepEqual(await done(root.call("form_list", { requesterWithin: "unknown" })), {
    items: [],
    next: null,
    actors: {},
  });
  await deny(
    root.call("work_update", { ticketID: work.ticketID, progress: "Not owner" }),
    "forbidden",
  );
  assert.equal((await done(root.call("actor_get"))).actorID, rootID);
  work = Work.parse(
    await done(
      owner.call("work_update", {
        ticketID: work.ticketID,
        status: "active",
        progress: "Checking the packed SDK.\n\n- [x] Install\n- [ ] Verify",
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
        result: "Verified",
        evidence: ["owned fixture"],
      }),
    ),
  );
  assert.equal(work.status, "submitted");
  work = Work.parse(
    await done(
      requester.call("work_review", {
        ticketID: work.ticketID,
        submissionID: work.submission.submissionID,
        verdict: "accepted",
      }),
    ),
  );
  assert.equal(work.status, "accepted");
  assert.ok(work.completedAt);
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
  assert.deepEqual(await done(requester.call("status_get", { actorID: ownerID })), status);
  assert.deepEqual(
    (await done(requester.call("message_list", { after: page.items[0].seq }))).items,
    [],
  );
  // Exercise selected conversations after the forward/restart assertions.
  for (let i = 0; i < 103; i++)
    await done(owner.call("message_send", { recipientID: ownerID, text: `owned noise ${i}` }));
  const incomingQuery = Message.parse(
    await done(requester.call("message_send", { recipientID: ownerID, text: "selected inbound" })),
  );
  const outgoingQuery = Message.parse(
    await done(owner.call("message_send", { recipientID: requesterID, text: "selected outbound" })),
  );
  assert.equal(incomingQuery.conversationID, outgoingQuery.conversationID);
  assert.equal(incomingQuery.conversationID, sent.conversationID);
  const recentQuery = await done(
    owner.call("message_list", { counterpartyID: requesterID, before: "latest", limit: 2 }),
  );
  assert.deepEqual(recentQuery.items, [incomingQuery, outgoingQuery]);
  assert.deepEqual(
    (
      await done(
        owner.call("message_list", { counterpartyID: requesterID, before: recentQuery.older }),
      )
    ).items,
    [sent],
  );
  assert.deepEqual(
    (
      await done(
        owner.call("message_list", {
          counterpartyID: requesterID,
          direction: "incoming",
          before: "latest",
        }),
      )
    ).items,
    [incomingQuery],
  );
  await deny(
    owner.call("message_list", { counterpartyID: requesterID, before: "latest", after: 1 }),
    "invalid",
  );
  assert.deepEqual((await done(owner.call("message_list", { before: "latest", limit: 1 }))).items, [
    outgoingQuery,
  ]);
  assert.deepEqual(
    (await done(root.call("message_list", { counterpartyID: ownerID, before: "latest" }))).items,
    [],
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
        owner.call("message_list", { counterpartyID: requesterID, after: outgoingQuery.seq }),
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
  assert.deepEqual((await done(root.call("form_list", { requesterWithin: ownerID }))).items, [
    question,
  ]);
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
    toolCount: 11,
    interfaceCount: 30,
    workspaceSource: pin.source,
    workspaceSha256: digest,
    workspaceVersion: pin.version,
    workspaceBundled: true,
    publicWorkFormHistory: true,
    levelTags: true,
    statusRecord: true,
    approvalManagerChain: true,
    askerClose: true,
    subtreeFilters: true,
    closedSubtreeHistory: true,
    discoverySubtreeSchemas: true,
    restartPersistence: true,
    systemStatusAndSchemas: true,
    systemConnectionAuthority: true,
    transientDetachAndReconnect: true,
    staleRunCursorRefused: true,
    allWorkspaceOperations: true,
    standaloneAsks: true,
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
