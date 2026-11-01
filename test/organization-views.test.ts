/**
 * Organization views through ordinary admitted Actor SDK calls: deep and closed subtree filters
 * and approval asks both use the Hub registry's `within`, and grant no write role or Message access.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Actor } from "../src/actor/index.ts";
import { BUILTINS } from "../src/contract/index.ts";
import { done, refused, startCore } from "./harness.ts";

async function organization() {
  const core = await startCore();
  const root = await core.client(core.root);
  const make = async (name: string, manager: Actor = root) => {
    const created = await done(manager.call("actor_create", { name, purpose: name }));
    return { id: created.actor.id as string, client: await core.client(created.credential) };
  };
  const lead = await make("lead");
  const worker = await make("worker", lead.client);
  const remote = await make("remote");
  const requester = await make("requester", remote.client);
  const observer = await make("observer");
  return { core, root, make, lead, worker, remote, requester, observer };
}

const fields = [{ name: "answer", label: "Optional answer", required: false }];

test("any active Actor reads deep and closed subtree Work/ask histories through the discovered schemas", async (t) => {
  const { core, root, make, lead, requester, observer } = await organization();
  t.after(() => core.close());
  const chain = [lead];
  for (let depth = 1; depth < 25; depth += 1) {
    const previous = chain.at(-1);
    assert.ok(previous);
    chain.push(await make(`depth-${depth}`, previous.client));
  }
  const leaf = chain.at(-1);
  assert.ok(leaf);
  const team = await done(observer.client.call("team", { actor: lead.id, depth: 20 }));
  assert.equal(
    team.positions.some((position: { id: string }) => position.id === leaf.id),
    false,
  );
  let work = await done(
    requester.client.call("work_create", { ownerID: leaf.id, title: "Retained deep work" }),
  );
  work = await done(
    leaf.client.call("work_update", {
      ticketID: work.ticketID,
      expectedRevision: work.revision,
      progress: "Complete retained progress",
    }),
  );
  work = await done(
    leaf.client.call("work_submit", {
      ticketID: work.ticketID,
      expectedRevision: work.revision,
      result: "Retained result",
      evidence: ["Retained evidence"],
    }),
  );
  work = await done(
    requester.client.call("work_review", {
      ticketID: work.ticketID,
      expectedRevision: work.revision,
      submissionID: work.submission.submissionID,
      verdict: "accepted",
      comment: "Reviewed by actual requester",
    }),
  );
  const form = await done(leaf.client.call("form_create", { title: "Deep ask", fields }));
  let approval = await done(
    leaf.client.call("form_create", { title: "Deep approval", approval: true, fields }),
  );
  for (const outside of [observer.client, leaf.client])
    assert.equal(
      await refused(
        outside.call("form_respond", { formID: approval.formID, answers: { answer: "No" } }),
      ),
      "forbidden",
    );
  approval = await done(
    lead.client.call("form_respond", { formID: approval.formID, answers: { answer: "Approved" } }),
  );
  assert.equal(approval.status, "resolved");
  assert.deepEqual(Object.keys(approval.responses), [lead.id]);
  for (const client of [root, observer.client]) {
    const catalog = await client.available();
    assert.equal(catalog.length, 11);
    assert.equal(catalog.flatMap((tool) => tool.interfaces).length, 30);
    const interfaces = catalog.flatMap((tool) => tool.interfaces);
    for (const [name, filters, removed] of [
      ["work_list", ["ownerWithin", "requesterWithin"], []],
      ["form_list", ["requesterWithin"], ["respondentWithin", "awaitingWithin"]],
    ] as const) {
      const operation = interfaces.find((offer) => offer.interface.name === name);
      assert.ok(operation);
      const properties = operation.interface.input.properties as Record<string, unknown>;
      for (const filter of filters) assert.ok(properties[filter], `${name} exposes ${filter}`);
      for (const filter of removed) assert.equal(properties[filter], undefined, filter);
      assert.equal(operation.read_only, true);
    }
    assert.deepEqual((await done(client.call("work_list", { ownerWithin: lead.id }))).items, [
      work,
    ]);
    assert.deepEqual((await done(client.call("form_list", { requesterWithin: lead.id }))).items, [
      form,
      approval,
    ]);
  }
  // Close the fixture's other direct report before closing the retained anchor.
  const directReports = await done(root.call("team", { actor: lead.id, depth: 1 }));
  const deepChild = chain[1];
  assert.ok(deepChild);
  for (const position of directReports.positions.slice(1))
    if (position.id !== deepChild.id) await done(root.call("actor_close", { actor: position.id }));
  for (const actor of [...chain].reverse())
    await done(root.call("actor_close", { actor: actor.id }));
  assert.deepEqual(
    (await done(observer.client.call("work_list", { ownerWithin: lead.id }))).items,
    [work],
  );
  assert.deepEqual(
    (await done(observer.client.call("form_list", { requesterWithin: lead.id }))).items,
    [form, approval],
  );
  assert.deepEqual(await done(observer.client.call("work_get", { ticketID: work.ticketID })), work);
  assert.deepEqual(await done(observer.client.call("form_get", { formID: form.formID })), form);
  assert.equal(
    (await done(observer.client.call("work_get", { ticketID: work.ticketID, history: true })))
      .history.length,
    4,
  );
  const closed = await core.org.invoke(
    leaf.id,
    "form_list",
    { requesterWithin: lead.id },
    {
      signal: new AbortController().signal,
      progress: async () => {},
    },
  );
  assert.equal(await refused(closed), "forbidden");
  assert.equal(BUILTINS.work_list.request.parse({ ownerWithin: lead.id }).ownerWithin, lead.id);
  assert.equal(
    BUILTINS.form_list.request.parse({ requesterWithin: lead.id }).requesterWithin,
    lead.id,
  );
});

test("Work subtree and exact predicates intersect before sparse pages without granting review or owner roles", async (t) => {
  const { core, root, lead, worker, remote, requester, observer } = await organization();
  t.after(() => core.close());
  const create = (caller: Actor, ownerID: string, title: string) =>
    done(caller.call("work_create", { ownerID, title }));
  await create(root, worker.id, "Different requester");
  const first = await create(requester.client, worker.id, "First match");
  for (let index = 0; index < 12; index += 1)
    await create(requester.client, observer.id, `Outside owner scope ${index}`);
  const second = await create(requester.client, worker.id, "Second match");
  const filter = {
    ownerWithin: lead.id,
    requesterWithin: remote.id,
    ownerID: worker.id,
    requesterID: requester.id,
    status: ["open"],
    limit: 1,
  };
  const actors = { [requester.id]: { name: "requester" }, [worker.id]: { name: "worker" } };
  const page = await done(observer.client.call("work_list", filter));
  assert.deepEqual(page.items, [first]);
  assert.equal(typeof page.next, "string");
  assert.deepEqual(await done(observer.client.call("work_list", { ...filter, after: page.next })), {
    items: [second],
    next: null,
    actors,
  });
  for (const other of [{ ownerWithin: worker.id }, { requesterWithin: requester.id }])
    assert.equal(
      await refused(observer.client.call("work_list", { ...filter, ...other, after: page.next })),
      "invalid",
    );
  for (const contradictory of [
    { ...filter, ownerID: observer.id },
    { ...filter, requesterWithin: lead.id },
    { ...filter, ownerWithin: "unknown" },
    { ...filter, requesterWithin: "unknown" },
  ])
    assert.deepEqual(await done(observer.client.call("work_list", contradictory)), {
      items: [],
      next: null,
      actors: {},
    });
  assert.equal(
    await refused(
      root.call("work_update", {
        ticketID: first.ticketID,
        expectedRevision: first.revision,
        progress: "Not owner",
      }),
    ),
    "forbidden",
  );
  const submitted = await done(
    worker.client.call("work_submit", {
      ticketID: first.ticketID,
      expectedRevision: first.revision,
      result: "For review",
      evidence: [],
    }),
  );
  assert.deepEqual(
    (
      await done(
        observer.client.call("work_list", {
          requesterWithin: remote.id,
          status: ["submitted"],
        }),
      )
    ).items,
    [submitted],
  );
  assert.equal(
    await refused(
      remote.client.call("work_review", {
        ticketID: submitted.ticketID,
        expectedRevision: submitted.revision,
        submissionID: submitted.submission.submissionID,
        verdict: "accepted",
        comment: "Not requester",
      }),
    ),
    "forbidden",
  );
  await done(
    requester.client.call("work_update", {
      ticketID: second.ticketID,
      expectedRevision: second.revision,
      ownerID: observer.id,
    }),
  );
  assert.deepEqual(await done(observer.client.call("work_list", filter)), {
    items: [],
    next: null,
    actors: {},
  });
  assert.equal(
    (await done(observer.client.call("work_get", { ticketID: second.ticketID }))).ownerID,
    observer.id,
  );
  for (const name of ["ownerWithin", "requesterWithin"])
    for (const value of ["", 7])
      assert.equal(await refused(root.call("work_list", { [name]: value })), "invalid");
});

test("ask subtree and exact predicates intersect before sparse pages; approvals are answered only up the manager chain", async (t) => {
  const { core, root, lead, worker, remote, requester, observer } = await organization();
  t.after(() => core.close());
  const create = (caller: Actor, title: string) =>
    done(caller.call("form_create", { title, fields }));
  await create(root, "Different requester");
  await create(remote.client, "Inside scope, different requester");
  const answered = await create(requester.client, "Answered");
  await done(
    worker.client.call("form_respond", {
      formID: answered.formID,
      expectedRevision: 1,
      answers: {},
    }),
  );
  const closed = await create(requester.client, "Closed");
  await done(
    requester.client.call("form_close", {
      formID: closed.formID,
      expectedRevision: 1,
      status: "resolved",
      resolution: "Decided",
    }),
  );
  for (let index = 0; index < 12; index += 1)
    await create(observer.client, `Outside requester scope ${index}`);
  const first = await create(requester.client, "First match");
  const second = await create(requester.client, "Second match");
  const filter = {
    requesterWithin: remote.id,
    requesterID: requester.id,
    status: ["open"],
    limit: 1,
  };
  const page = await done(root.call("form_list", filter));
  assert.deepEqual(page.items, [first]);
  assert.equal(typeof page.next, "string");
  assert.deepEqual(await done(root.call("form_list", { ...filter, after: page.next })), {
    items: [second],
    next: null,
    actors: { [requester.id]: { name: "requester" } },
  });
  assert.equal(
    await refused(
      root.call("form_list", { ...filter, requesterWithin: requester.id, after: page.next }),
    ),
    "invalid",
  );
  for (const contradictory of [
    { ...filter, requesterWithin: lead.id },
    { ...filter, requesterWithin: "unknown" },
  ])
    assert.deepEqual(await done(root.call("form_list", contradictory)), {
      items: [],
      next: null,
      actors: {},
    });
  assert.deepEqual(
    (await done(root.call("form_list", { requesterWithin: remote.id, status: ["resolved"] })))
      .items,
    [
      await done(root.call("form_get", { formID: answered.formID })),
      await done(root.call("form_get", { formID: closed.formID })),
    ],
  );
  assert.deepEqual(
    (await done(root.call("form_get", { formID: answered.formID }))).responses[worker.id].answers,
    {},
  );
  assert.equal(
    await refused(
      remote.client.call("form_close", {
        formID: first.formID,
        expectedRevision: first.revision,
        status: "resolved",
        resolution: "Not requester",
      }),
    ),
    "forbidden",
  );
  let approval = await done(
    worker.client.call("form_create", {
      title: "Approve",
      approval: true,
      collect: true,
      fields,
    }),
  );
  for (const outside of [worker, observer, remote, requester])
    assert.equal(
      await refused(
        outside.client.call("form_respond", {
          formID: approval.formID,
          answers: { answer: "Not a manager" },
        }),
      ),
      "forbidden",
    );
  for (const manager of [lead.client, root])
    approval = await done(
      manager.call("form_respond", { formID: approval.formID, answers: { answer: "Approved" } }),
    );
  assert.deepEqual(Object.keys(approval.responses).sort(), [core.rootId, lead.id].sort());
  approval = await done(
    worker.client.call("form_close", {
      formID: approval.formID,
      expectedRevision: approval.revision,
      status: "resolved",
      resolution: "Approved by both managers",
    }),
  );
  assert.equal(approval.status, "resolved");
  for (const value of ["", 7])
    assert.equal(await refused(root.call("form_list", { requesterWithin: value })), "invalid");
  for (const removed of [{ respondentWithin: lead.id }, { awaitingWithin: lead.id }])
    assert.equal(await refused(root.call("form_list", removed)), "invalid");
});

test("subtree queries retain private Message and audit boundaries for managers and unrelated observers", async (t) => {
  const { core, root, lead, worker, requester, observer } = await organization();
  t.after(() => core.close());
  const work = await done(
    requester.client.call("work_create", { ownerID: worker.id, title: "Public goal" }),
  );
  const privateText = "organization-view-private-message-sentinel";
  const sent = await done(
    worker.client.call("message_send", { recipientID: requester.id, text: privateText }),
  );
  const empty = { items: [], next: null, older: null, actors: {} };
  for (const client of [root, lead.client, observer.client]) {
    assert.deepEqual((await done(client.call("work_list", { ownerWithin: lead.id }))).items, [
      work,
    ]);
    assert.equal(
      await refused(client.call("message_get", { messageID: sent.messageID })),
      "not_found",
    );
    assert.deepEqual(await done(client.call("message_list")), empty);
    assert.deepEqual(await done(client.call("message_list", { before: "latest" })), empty);
    for (const counterpartyID of [worker.id, requester.id])
      assert.deepEqual(
        await done(client.call("message_list", { counterpartyID, before: "latest" })),
        empty,
      );
    if (client !== root) assert.equal(await refused(client.call("activity")), "forbidden");
    assert.equal(
      (await done(client.call("actor_get"))).actorID,
      client === root ? core.rootId : client === lead.client ? lead.id : observer.id,
    );
    assert.equal(await refused(client.call("message_list", { ownerWithin: lead.id })), "invalid");
  }
  const activity = await done(root.call("activity"));
  assert.equal(
    activity.entries.some(
      (entry: { operation: string; target: string }) =>
        entry.operation === "message_send" && entry.target === sent.messageID,
    ),
    true,
  );
  for (const entry of activity.entries)
    assert.deepEqual(Object.keys(entry).sort(), [
      "actor",
      "at",
      "id",
      "operation",
      "outcome",
      "target",
    ]);
  assert.equal(JSON.stringify(activity).includes(privateText), false);
});
