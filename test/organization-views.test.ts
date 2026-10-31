/** Organization views through ordinary admitted Actor SDK calls. */
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

test("any active Actor reads deep and closed subtree Work/Form histories through the discovered schemas", async (t) => {
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
    requester.client.call("work_create", { ownerID: leaf.id, goal: "Retained deep work" }),
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
  const form = await done(leaf.client.call("form_create", { respondentIDs: [leaf.id], fields }));
  for (const client of [root, observer.client]) {
    const catalog = await client.available();
    assert.equal(catalog.length, 9);
    assert.equal(catalog.flatMap((tool) => tool.interfaces).length, 23);
    const interfaces = catalog.flatMap((tool) => tool.interfaces);
    for (const [name, filters] of [
      ["work_list", ["ownerWithin", "requesterWithin"]],
      ["form_list", ["requesterWithin", "respondentWithin", "awaitingWithin"]],
    ] as const) {
      const operation = interfaces.find((offer) => offer.interface.name === name);
      assert.ok(operation);
      const properties = operation.interface.input.properties as Record<string, unknown>;
      for (const filter of filters) assert.ok(properties[filter], `${name} exposes ${filter}`);
      assert.equal(operation.read_only, true);
    }
    assert.deepEqual((await done(client.call("work_list", { ownerWithin: lead.id }))).items, [
      work,
    ]);
    assert.deepEqual(
      (
        await done(
          client.call("form_list", {
            requesterWithin: lead.id,
            respondentWithin: lead.id,
            awaitingWithin: lead.id,
          }),
        )
      ).items,
      [form],
    );
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
    (
      await done(
        observer.client.call("form_list", { requesterWithin: lead.id, awaitingWithin: lead.id }),
      )
    ).items,
    [form],
  );
  assert.deepEqual(await done(observer.client.call("work_get", { ticketID: work.ticketID })), work);
  assert.deepEqual(await done(observer.client.call("form_get", { formID: form.formID })), form);
  assert.equal(work.history.length, 4);
  const closed = await core.org.invoke(
    leaf.id,
    "form_list",
    { awaitingWithin: lead.id },
    {
      signal: new AbortController().signal,
      progress: async () => {},
    },
  );
  assert.equal(await refused(closed), "forbidden");
  assert.equal(BUILTINS.work_list.request.parse({ ownerWithin: lead.id }).ownerWithin, lead.id);
  assert.equal(
    BUILTINS.form_list.request.parse({ awaitingWithin: lead.id }).awaitingWithin,
    lead.id,
  );
});

test("Work subtree and exact predicates intersect before sparse pages without granting review or owner roles", async (t) => {
  const { core, root, lead, worker, remote, requester, observer } = await organization();
  t.after(() => core.close());
  const create = (caller: Actor, ownerID: string, goal: string) =>
    done(caller.call("work_create", { ownerID, goal }));
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
    status: "open",
    limit: 1,
  };
  const page = await done(observer.client.call("work_list", filter));
  assert.deepEqual(page, { items: [first], after: first.cursor });
  const next = await done(observer.client.call("work_list", { ...filter, after: page.after }));
  assert.deepEqual(next, { items: [second], after: second.cursor });
  assert.deepEqual(
    await done(observer.client.call("work_list", { ...filter, after: next.after })),
    {
      items: [],
      after: next.after,
    },
  );
  for (const contradictory of [
    { ...filter, ownerID: observer.id },
    { ...filter, requesterWithin: lead.id },
    { ...filter, ownerWithin: "unknown" },
    { ...filter, requesterWithin: "unknown" },
  ])
    assert.deepEqual(await done(observer.client.call("work_list", contradictory)), {
      items: [],
      after: 0,
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
          status: "submitted",
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
  assert.deepEqual(await done(observer.client.call("work_list", filter)), { items: [], after: 0 });
  assert.equal(
    (await done(observer.client.call("work_get", { ticketID: second.ticketID }))).ownerID,
    observer.id,
  );
  for (const name of ["ownerWithin", "requesterWithin"])
    for (const value of ["", 7])
      assert.equal(await refused(root.call("work_list", { [name]: value })), "invalid");
});

test("Form subtree attention handles different respondents, empty answers and closed Forms before pagination", async (t) => {
  const { core, root, lead, worker, remote, requester, observer } = await organization();
  t.after(() => core.close());
  const create = (caller: Actor, respondentIDs: string[]) =>
    done(caller.call("form_create", { respondentIDs, fields }));
  await create(root, [worker.id, observer.id]);
  const answered = await create(requester.client, [worker.id, observer.id]);
  const response = await done(
    worker.client.call("form_respond", {
      formID: answered.formID,
      expectedRevision: 1,
      answers: {},
    }),
  );
  const closed = await create(requester.client, [worker.id, observer.id]);
  await done(
    requester.client.call("form_close", {
      formID: closed.formID,
      expectedRevision: 1,
      status: "resolved",
      resolution: "Decided",
    }),
  );
  for (let index = 0; index < 12; index += 1) await create(requester.client, [observer.id]);
  const first = await create(requester.client, [worker.id, observer.id]);
  const second = await create(requester.client, [worker.id, observer.id]);
  const filter = {
    requesterWithin: remote.id,
    respondentWithin: observer.id,
    awaitingWithin: lead.id,
    requesterID: requester.id,
    respondentID: worker.id,
    awaitingActorID: worker.id,
    status: "open",
    limit: 1,
  };
  const page = await done(root.call("form_list", filter));
  assert.deepEqual(page, { items: [first], after: first.cursor });
  const next = await done(root.call("form_list", { ...filter, after: page.after }));
  assert.deepEqual(next, { items: [second], after: second.cursor });
  assert.deepEqual(await done(root.call("form_list", { ...filter, after: next.after })), {
    items: [],
    after: next.after,
  });
  const differentRespondents = await done(
    root.call("form_list", {
      requesterWithin: remote.id,
      respondentWithin: lead.id,
      awaitingWithin: observer.id,
    }),
  );
  assert.deepEqual(differentRespondents.items, [response, first, second]);
  assert.deepEqual(
    (await done(root.call("form_get", { formID: answered.formID }))).responses[worker.id],
    {},
  );
  assert.equal(
    await refused(
      lead.client.call("form_respond", {
        formID: first.formID,
        expectedRevision: first.revision,
        answers: {},
      }),
    ),
    "forbidden",
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
  for (const name of ["requesterWithin", "respondentWithin", "awaitingWithin"]) {
    assert.deepEqual(await done(root.call("form_list", { [name]: "unknown" })), {
      items: [],
      after: 0,
    });
    for (const value of ["", 7])
      assert.equal(await refused(root.call("form_list", { [name]: value })), "invalid");
  }
});

test("subtree queries retain private Message and audit boundaries for managers and unrelated observers", async (t) => {
  const { core, root, lead, worker, requester, observer } = await organization();
  t.after(() => core.close());
  const work = await done(
    requester.client.call("work_create", { ownerID: worker.id, goal: "Public goal" }),
  );
  const privateText = "organization-view-private-message-sentinel";
  const sent = await done(
    worker.client.call("message_send", {
      recipientID: requester.id,
      workID: work.ticketID,
      text: privateText,
    }),
  );
  for (const client of [root, lead.client, observer.client]) {
    assert.deepEqual((await done(client.call("work_list", { ownerWithin: lead.id }))).items, [
      work,
    ]);
    assert.equal(
      await refused(client.call("message_get", { messageID: sent.messageID })),
      "not_found",
    );
    assert.deepEqual(await done(client.call("message_list")), { items: [], after: 0 });
    const activity = await done(client.call("activity"));
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
    assert.equal(
      (await done(client.call("actor_get"))).actorID,
      client === root ? core.rootId : client === lead.client ? lead.id : observer.id,
    );
    assert.equal(await refused(client.call("message_list", { ownerWithin: lead.id })), "invalid");
  }
});
