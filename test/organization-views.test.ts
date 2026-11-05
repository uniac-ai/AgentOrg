/**
 * Organization views through ordinary admitted Actor SDK calls on one flat level: every active
 * Actor reads all Work and asks, a closed Actor's included, through exact filters that grant no
 * write role; an approval is answered only by the Actor it routes to; Messages are open to every
 * Actor.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Actor } from "../src/actor/index.ts";
import { BUILTINS } from "../src/contract/index.ts";
import { done, refused, startCore } from "./harness.ts";

async function organization() {
  const core = await startCore();
  const root = await core.client(core.root);
  const make = async (name: string) => {
    const created = await done(root.call("actor_create", { name, purpose: name }));
    return { id: created.actor.id as string, client: await core.client(created.credential) };
  };
  const worker = await make("worker");
  const helper = await make("helper");
  const requester = await make("requester");
  const observer = await make("observer");
  return { core, root, worker, helper, requester, observer };
}

type Member = Awaited<ReturnType<typeof organization>>["worker"];

const fields = [{ name: "answer", label: "Optional answer", required: false }];

test("any active Actor reads Work and ask histories, a closed Actor's included, through the discovered schemas", async (t) => {
  const { core, root, worker, helper, requester, observer } = await organization();
  t.after(() => core.close());
  let work = await done(
    requester.client.call("work_create", { ownerID: worker.id, title: "Retained work" }),
  );
  work = await done(
    worker.client.call("work_update", {
      ticketID: work.ticketID,
      expectedRevision: work.revision,
      progress: "Complete retained progress",
    }),
  );
  work = await done(
    worker.client.call("work_submit", {
      ticketID: work.ticketID,
      expectedRevision: work.revision,
      result: "Retained result",
      evidence: ["Retained evidence"],
    }),
  );
  work = await done(
    requester.client.call("work_answer", {
      ticketID: work.ticketID,
      askID: work.submission.submissionID,
      answers: { verdict: "accepted" },
      note: "Reviewed by actual requester",
    }),
  );
  const asks = await done(worker.client.call("work_create", { title: "Own asks" }));
  const ask = (input: object) =>
    done(worker.client.call("work_update", { ticketID: asks.ticketID, ask: { fields, ...input } }));
  const form = await ask({ title: "Own ask" });
  // Its asker requested this Work itself, so the approval routes to the person.
  let approval = await ask({ title: "Own approval", approval: true });
  for (const outside of [observer.client, requester.client, worker.client])
    assert.equal(
      await refused(
        outside.call("work_answer", { askID: approval.formID, answers: { answer: "No" } }),
      ),
      "forbidden",
    );
  approval = await done(
    root.call("work_answer", { askID: approval.formID, answers: { answer: "Approved" } }),
  );
  assert.equal(approval.status, "resolved");
  assert.deepEqual(Object.keys(approval.responses), [core.rootId]);
  // work_list carries each Work's open asks, and work_get all of them.
  const listed = [
    { ...work, asks: [] },
    { ...asks, asks: [form] },
  ];
  for (const client of [root, observer.client]) {
    const catalog = await client.available();
    assert.equal(catalog.length, 8);
    assert.equal(catalog.flatMap((tool) => tool.interfaces).length, 21);
    const list = catalog
      .flatMap((tool) => tool.interfaces)
      .find((offer) => offer.interface.name === "work_list");
    assert.ok(list);
    const properties = list.interface.input.properties as Record<string, unknown>;
    for (const filter of ["ownerID", "requesterID"])
      assert.ok(properties[filter], `work_list exposes ${filter}`);
    for (const filter of ["ownerWithin", "requesterWithin"])
      assert.equal(properties[filter], undefined, filter);
    assert.equal(list.read_only, true);
    assert.deepEqual((await done(client.call("work_list", { ownerID: worker.id }))).items, listed);
    assert.deepEqual((await done(client.call("work_get", { ticketID: asks.ticketID }))).asks, [
      form,
      approval,
    ]);
  }
  for (const actor of [worker, requester])
    await done(root.call("actor_close", { actor: actor.id }));
  assert.deepEqual(
    (await done(observer.client.call("team", {}))).positions.map(
      (position: { id: string }) => position.id,
    ),
    [core.rootId, helper.id, observer.id],
  );
  const closedView = await done(observer.client.call("actor_view", { actorID: worker.id }));
  assert.equal(typeof closedView.actor.closed_at, "string");
  assert.deepEqual(closedView.completed, [{ ...work, asks: [] }]);
  assert.deepEqual(
    (await done(observer.client.call("work_list", { ownerID: worker.id }))).items,
    listed,
  );
  assert.deepEqual(await done(observer.client.call("work_get", { ticketID: work.ticketID })), {
    ...work,
    asks: [],
  });
  assert.deepEqual(await done(observer.client.call("work_get", { askID: form.formID })), {
    ...asks,
    asks: [form, approval],
  });
  assert.equal(
    (await done(observer.client.call("work_get", { ticketID: work.ticketID, history: true })))
      .history.length,
    4,
  );
  const closed = await core.org.invoke(
    worker.id,
    "work_list",
    { ownerID: worker.id },
    {
      signal: new AbortController().signal,
      progress: async () => {},
    },
  );
  assert.equal(await refused(closed), "forbidden");
  assert.deepEqual(
    BUILTINS.work_list.request.parse({ ownerID: [worker.id, requester.id] }).ownerID,
    [worker.id, requester.id],
  );
  assert.equal(BUILTINS.work_list.request.safeParse({ ownerWithin: worker.id }).success, false);
});

test("exact Work filters intersect before sparse pages without granting review or owner roles", async (t) => {
  const { core, root, worker, helper, requester, observer } = await organization();
  t.after(() => core.close());
  const create = (caller: Actor, ownerID: string, title: string) =>
    done(caller.call("work_create", { ownerID, title }));
  await create(root, worker.id, "Different requester");
  const first = await create(requester.client, worker.id, "First match");
  for (let index = 0; index < 12; index += 1)
    await create(requester.client, observer.id, `Outside owner list ${index}`);
  const started = await create(requester.client, worker.id, "Already started");
  await done(worker.client.call("work_update", { ticketID: started.ticketID, status: "active" }));
  const second = await create(requester.client, helper.id, "Second match");
  const filter = {
    ownerID: [worker.id, helper.id],
    requesterID: [requester.id, observer.id],
    status: ["open"],
    limit: 1,
  };
  const page = await done(observer.client.call("work_list", filter));
  assert.deepEqual(page.items, [{ ...first, asks: [] }]);
  assert.equal(typeof page.next, "string");
  assert.deepEqual(await done(observer.client.call("work_list", { ...filter, after: page.next })), {
    items: [{ ...second, asks: [] }],
    next: null,
    actors: { [requester.id]: { name: "requester" }, [helper.id]: { name: "helper" } },
  });
  // A position continues only the filter that issued it.
  for (const other of [{ ownerID: worker.id }, { requesterID: requester.id }])
    assert.equal(
      await refused(observer.client.call("work_list", { ...filter, ...other, after: page.next })),
      "invalid",
    );
  for (const contradictory of [
    { ...filter, ownerID: observer.id, requesterID: core.rootId },
    { ...filter, requesterID: core.rootId, status: ["active"] },
    { ...filter, ownerID: "unknown" },
    { ...filter, requesterID: "unknown" },
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
          requesterID: requester.id,
          status: ["submitted"],
        }),
      )
    ).items,
    [{ ...submitted, asks: [] }],
  );
  // While its requester is open, neither a reader nor the person answers a submission.
  for (const other of [observer.client, root])
    assert.equal(
      await refused(
        other.call("work_answer", {
          ticketID: submitted.ticketID,
          askID: submitted.submission.submissionID,
          answers: { verdict: "accepted" },
          note: "Not requester",
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
  for (const invalid of [
    { ownerWithin: worker.id },
    { requesterWithin: requester.id },
    { ownerID: [] },
    { requesterID: "" },
  ])
    assert.equal(await refused(root.call("work_list", invalid)), "invalid");
});

test("an approval is answered only by the Actor it routes to, never its asker, and only the asker closes its ask", async (t) => {
  const { core, root, worker, helper, requester, observer } = await organization();
  t.after(() => core.close());
  /** Work the caller requests of its owner, with the owner's ask on it. */
  const ask = async (caller: Actor, owner: Member, title: string, input: object = {}) => {
    const work = await done(caller.call("work_create", { ownerID: owner.id, title }));
    return done(
      owner.client.call("work_update", {
        ticketID: work.ticketID,
        ask: { title, fields, ...input },
      }),
    );
  };
  const answered = await ask(requester.client, requester, "Answered");
  await done(worker.client.call("work_answer", { askID: answered.formID, answers: {} }));
  assert.deepEqual(
    (await done(root.call("work_get", { askID: answered.formID }))).asks[0].responses[worker.id]
      .answers,
    {},
  );
  const open = await ask(requester.client, requester, "Open");
  for (const other of [observer.client, root])
    assert.equal(
      await refused(
        other.call("work_update", {
          close: { askID: open.formID, status: "resolved", resolution: "Not asker" },
        }),
      ),
      "forbidden",
    );
  // The Work's requester answers its owner's approval.
  let approval = await ask(requester.client, worker, "Approve", { approval: true, collect: true });
  const outsiders = [worker, helper, observer];
  for (const outside of [...outsiders.map((member) => member.client), root])
    assert.equal(
      await refused(
        outside.call("work_answer", {
          askID: approval.formID,
          answers: { answer: "Not routed here" },
        }),
      ),
      "forbidden",
    );
  approval = await done(
    requester.client.call("work_answer", {
      askID: approval.formID,
      answers: { answer: "Approved" },
    }),
  );
  assert.deepEqual(Object.keys(approval.responses), [requester.id]);
  // Once that requester is closed, the approval routes to the person.
  await done(observer.client.call("actor_close", { actor: requester.id }));
  for (const outside of outsiders)
    assert.equal(
      await refused(
        outside.client.call("work_answer", {
          askID: approval.formID,
          answers: { answer: "Not routed here" },
        }),
      ),
      "forbidden",
    );
  approval = await done(
    root.call("work_answer", { askID: approval.formID, answers: { answer: "Approved" } }),
  );
  assert.deepEqual(Object.keys(approval.responses).sort(), [core.rootId, requester.id].sort());
  for (const other of [observer.client, root])
    assert.equal(
      await refused(
        other.call("work_update", {
          close: { askID: approval.formID, status: "resolved", resolution: "Not asker" },
        }),
      ),
      "forbidden",
    );
  approval = await done(
    worker.client.call("work_update", {
      close: {
        askID: approval.formID,
        status: "resolved",
        resolution: "Approved by the requester and the person",
      },
    }),
  );
  assert.equal(approval.status, "resolved");
});

test("the person and unrelated observers read Work, Messages, activity and the team openly", async (t) => {
  const { core, root, worker, helper, requester, observer } = await organization();
  t.after(() => core.close());
  const work = await done(
    requester.client.call("work_create", { ownerID: worker.id, title: "Public goal" }),
  );
  const messageText = "organization-view-private-message-sentinel";
  const sent = await done(
    worker.client.call("message_send", { recipientID: requester.id, text: messageText }),
  );
  const empty = { items: [], next: null, older: null, actors: {} };
  const conversation = {
    items: [sent],
    next: null,
    older: null,
    actors: { [worker.id]: { name: "worker" }, [requester.id]: { name: "requester" } },
  };
  for (const client of [root, helper.client, observer.client]) {
    assert.deepEqual((await done(client.call("work_list", { ownerID: worker.id }))).items, [
      { ...work, asks: [] },
    ]);
    assert.deepEqual(await done(client.call("message_get", { messageID: sent.messageID })), sent);
    assert.deepEqual(await done(client.call("message_list", { of: worker.id })), conversation);
    assert.deepEqual(
      await done(
        client.call("message_list", { between: [worker.id, requester.id], before: "latest" }),
      ),
      conversation,
    );
    for (const counterpartyID of [worker.id, requester.id])
      assert.deepEqual(
        await done(client.call("message_list", { counterpartyID, before: "latest" })),
        empty,
      );
    const activity = await done(client.call("activity"));
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
    assert.equal(JSON.stringify(activity).includes(messageText), false);
    assert.deepEqual(
      (await done(client.call("team", {}))).positions.map(
        (position: { id: string }) => position.id,
      ),
      [core.rootId, worker.id, helper.id, requester.id, observer.id],
    );
    assert.equal(
      await refused(
        client.call("message_list", { counterpartyID: worker.id, ownerWithin: worker.id }),
      ),
      "invalid",
    );
  }
});
