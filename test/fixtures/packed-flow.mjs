import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectClient } from "@agentorg/cli/actor";
import { Form, Message, Work } from "@agentorg/cli/contract";

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
  assert.equal(catalog.length, 9);
  assert.equal(catalog.flatMap((tool) => tool.interfaces).length, 23);
  assert.deepEqual(await owner.available(), catalog);
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
  owner = await client(url, ownerID, ownerRecord.credential);
  requester = await client(url, requesterID, requesterRecord.credential);
  assert.deepEqual(await done(requester.call("message_get", { messageID: sent.messageID })), sent);
  assert.deepEqual(await done(owner.call("form_get", { formID: form.formID })), form);
  assert.deepEqual(await done(owner.call("work_get", { ticketID: work.ticketID })), work);
  assert.deepEqual(await done(requester.call("message_list", { after: page.after })), {
    items: [],
    after: page.after,
  });
  await owner.close();
  await done(root.call("actor_close", { actor: ownerID }));
  assert.equal((await done(requester.call("actor_get", { actorID: ownerID }))).state, "closed");
  assert.equal((await done(root.call("actor_list"))).items.length, 2);
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
    toolCount: 9,
    interfaceCount: 23,
    workspaceSource: pin.source,
    workspaceSha256: digest,
    workspaceVersion: pin.version,
    workspaceBundled: true,
    publicWorkFormHistory: true,
    directedFilters: true,
    emptyResponseAnswered: true,
    restartPersistence: true,
    allWorkspaceOperations: true,
    standaloneForms: true,
    p2pPrivacy: true,
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
