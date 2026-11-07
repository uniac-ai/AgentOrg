import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Refused } from "@agentorg/sdk";
import WebSocket from "ws";
import type { PersonSide } from "../src/api.ts";
import { startApp } from "../src/index.ts";
import { exposureOf, RULES_KEY, Rules } from "../src/rules.ts";

const tick = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};
const RULE = "agents-use-what-they-install";
type Request = Record<string, unknown> & { requestId: string };

/**
 * The person's side with a Hub in memory: Actors with `installedFor`, open requests that an approval
 * closes, a store, and every `expose` the rules make.
 */
function person() {
  const store = new Map<string, unknown>();
  const actors = new Map<string, { state: string; installedFor?: string }>([
    ["act_quests", { state: "running", installedFor: "act_agent" }],
    ["act_other", { state: "running", installedFor: "act_someone" }],
    ["act_closed", { state: "closed", installedFor: "act_agent" }],
    ["act_plain", { state: "running" }],
  ]);
  let open: Request[] = [];
  const exposed: unknown[] = [];
  let requested: ((payload: unknown) => void) | undefined;
  let refuseExpose: Refused | undefined;
  let failRequests = false;
  /** Runs when the rule reads an Actor: the moment a person could act meanwhile. */
  let duringGet: (() => void) | undefined;
  const side: PersonSide = {
    async call(slot, method, input) {
      const at = `${slot}.${method}`;
      const i = input as Record<string, unknown>;
      if (at === "store.get")
        return store.has(String(i.key)) ? { value: store.get(String(i.key)) } : {};
      if (at === "store.set") {
        store.set(String(i.key), i.value);
        return {};
      }
      if (at === "actors.get") {
        duringGet?.();
        const actor = actors.get(String(i.actorId));
        if (!actor) throw new Refused("unknown", "No such Actor.");
        return actor;
      }
      if (at === "grants.requests") {
        if (failRequests) throw new Refused("unavailable", "The Hub is busy.");
        return { requests: [...open] };
      }
      if (at === "grants.expose") {
        if (refuseExpose) throw refuseExpose;
        exposed.push(input);
        // Approved: the request it settles is closed.
        open = open.filter(
          (r) => !(r.provider === i.provider && r.export === i.export && r.consumer === i.to),
        );
        return { exposed: true, slot: String(i.as) };
      }
      throw new Error(`unexpected ${at}`);
    },
    subscribe(slot, event, send) {
      assert.equal(`${slot}.${event}`, "grants.requested");
      requested = send;
      return () => {
        requested = undefined;
      };
    },
  };
  /** An agent's request to use `provider`'s quests: it holds its slot side, lacks the export side. */
  const exposure = (requestId: string, provider: string, to = "act_agent"): Request => ({
    requestId,
    exposed: true,
    provider,
    export: "logic.quests",
    consumer: to,
    slot: "quests_quests",
    needs: "export",
    reason: "",
    requestedBy: to,
    at: "2026-11-07T00:00:00.000Z",
  });
  return {
    side,
    store,
    exposed,
    exposure,
    open: () => open,
    /** A request filed now: open, and told to the person. */
    ask: (request: Request) => {
      open.push(request);
      requested?.(request);
    },
    /** A request filed while nobody listened. */
    waiting: (request: Request) => {
      open.push(request);
    },
    decline: (requestId: string) => {
      open = open.filter((r) => r.requestId !== requestId);
    },
    listening: () => requested !== undefined,
    refuse: (error: Refused | undefined) => {
      refuseExpose = error;
    },
    failRequests: (fail: boolean) => {
      failRequests = fail;
    },
    duringGet: (fn: (() => void) | undefined) => {
      duringGet = fn;
    },
  };
}

test("an exposure request is read from the Hub's request, and a binding request is not one", () => {
  const p = person();
  assert.deepEqual(exposureOf(p.exposure("r1", "act_quests")), {
    provider: "act_quests",
    export: "logic.quests",
    to: "act_agent",
    as: "quests_quests",
    requestedBy: "act_agent",
    needs: "export",
  });
  const { exposed: _, ...binding } = p.exposure("r2", "act_quests");
  assert.equal(exposureOf(binding as Request), undefined);
});

test("the rule is off until the person turns it on, and off approves nothing", async () => {
  const p = person();
  const rules = new Rules({ person: p.side });
  assert.deepEqual(await rules.list(), {
    rules: [
      {
        id: RULE,
        name: "Let an agent use what it installs",
        says: "When an agent asks to use an Actor it installed, approve it.",
        on: false,
      },
    ],
  });
  await rules.start();
  assert.ok(p.listening());
  p.ask(p.exposure("r1", "act_quests"));
  await tick();
  assert.deepEqual(p.exposed, []);
  rules.close();
  assert.equal(p.listening(), false);
});

test("on, it approves exactly an agent's own request for what it installed", async () => {
  const p = person();
  const logged: string[] = [];
  const rules = new Rules({ person: p.side, log: (m) => logged.push(m) });
  await rules.start();
  await rules.set({ id: RULE, on: true });
  assert.deepEqual(p.store.get(RULES_KEY), { [RULE]: { on: true } });
  assert.equal((await rules.list()).rules[0]?.on, true);
  for (const request of [
    p.exposure("r1", "act_other"), // installed for another Actor
    p.exposure("r2", "act_closed"), // closed
    p.exposure("r3", "act_plain"), // no provenance at all
    p.exposure("r4", "act_quests", "act_someone"), // to an Actor that didn't install it
    { ...p.exposure("r5", "act_quests"), exposed: undefined }, // a binding, not an exposure
    { ...p.exposure("r6", "act_quests"), requestedBy: "act_quests", needs: "slot" }, // the agent didn't ask
    { ...p.exposure("r7", "act_quests"), needs: "slot" }, // not the side the agent lacks
    { ...p.exposure("r9", "act_quests"), requestedBy: "act_quests" }, // asked by someone else
  ])
    p.ask(request);
  await tick();
  assert.deepEqual(p.exposed, []);
  p.ask(p.exposure("r8", "act_quests"));
  await tick();
  // Exactly what the request asked for, nothing of how it was asked.
  assert.deepEqual(p.exposed, [
    { provider: "act_quests", export: "logic.quests", to: "act_agent", as: "quests_quests" },
  ]);
  assert.match(logged.join("\n"), /Let an agent use what it installs.*act_quests/);
});

test("turning the rule on settles what already waits, and a restart settles what came meanwhile", async () => {
  const p = person();
  const rules = new Rules({ person: p.side });
  await rules.start();
  p.waiting(p.exposure("r1", "act_quests"));
  p.waiting(p.exposure("r2", "act_other"));
  await rules.set({ id: RULE, on: true });
  assert.equal(p.exposed.length, 1);
  assert.deepEqual(
    p.open().map((r) => r.requestId),
    ["r2"],
  );
  rules.close();

  // Down while a request came: the next start goes through what's open, once.
  p.waiting(p.exposure("r3", "act_quests"));
  const again = new Rules({ person: p.side });
  await again.start();
  await again.sweep();
  assert.equal(p.exposed.length, 2);
  // Turned off, nothing more is approved.
  await again.set({ id: RULE, on: false });
  p.waiting(p.exposure("r4", "act_quests"));
  await again.sweep();
  assert.equal(p.exposed.length, 2);
});

test("a request the person declines while a rule reads it is left declined", async () => {
  const p = person();
  const rules = new Rules({ person: p.side });
  await rules.set({ id: RULE, on: true });
  p.waiting(p.exposure("r1", "act_quests"));
  p.duringGet(() => p.decline("r1"));
  await rules.sweep();
  assert.deepEqual(p.exposed, []);
  // Heard by an event and a sweep at once, it is approved once.
  p.duringGet(undefined);
  await rules.start();
  p.ask(p.exposure("r2", "act_quests"));
  await rules.sweep();
  await tick();
  assert.equal(p.exposed.length, 1);
});

test("turning rules on and off is one at a time, and each says changed", async () => {
  const p = person();
  let changed = 0;
  const rules = new Rules({ person: p.side, changed: () => changed++ });
  await Promise.all([
    rules.set({ id: RULE, on: true }),
    rules.set({ id: RULE, on: false }),
    rules.set({ id: RULE, on: true }),
  ]);
  assert.equal(changed, 3);
  assert.equal((await rules.list()).rules[0]?.on, true);
  // A sweep that fails after the rule is on leaves it on, and says why.
  const logged: string[] = [];
  const other = new Rules({ person: p.side, log: (m) => logged.push(m) });
  p.failRequests(true);
  await other.set({ id: RULE, on: true });
  assert.match(logged.join("\n"), /couldn't go through what waits: The Hub is busy/);
  p.failRequests(false);
});

test("closed, the rules approve nothing more and hear nothing", async () => {
  const p = person();
  const rules = new Rules({ person: p.side });
  await rules.set({ id: RULE, on: true });
  rules.close();
  p.waiting(p.exposure("r1", "act_quests"));
  await rules.sweep();
  await rules.set({ id: RULE, on: true });
  assert.deepEqual(p.exposed, []);
  assert.equal(p.listening(), false);
});

test("an approval the Hub refuses is logged, and an unknown rule is refused", async () => {
  const p = person();
  const logged: string[] = [];
  const rules = new Rules({ person: p.side, log: (m) => logged.push(m) });
  await rules.set({ id: RULE, on: true });
  p.refuse(new Refused("forbidden", "The person can't grant that."));
  p.waiting(p.exposure("r1", "act_quests"));
  await rules.sweep();
  assert.match(logged.join("\n"), /couldn't settle request r1: The person can't grant that/);
  await assert.rejects(rules.set({ id: "no-such-rule", on: true }), { code: "unknown" });
});

test("the gateway serves the rules on /api: list, set, and changed", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "agentorg-rules-"));
  const app = await startApp({ home, firstRun: false });
  const socket = new WebSocket(`${app.url.replace("http", "ws")}/api`, {
    headers: {
      Authorization: `Bearer ${readFileSync(join(home, "cli-token"), "utf8").trim()}`,
    },
  });
  t.after(async () => {
    socket.close();
    await app.close();
    rmSync(home, { recursive: true, force: true });
  });
  await new Promise((done) => socket.once("open", done));
  const replies = new Map<number, (reply: Record<string, unknown>) => void>();
  const events: unknown[] = [];
  socket.on("message", (data) => {
    const reply = JSON.parse(String(data)) as Record<string, unknown>;
    if (typeof reply.id === "number") replies.get(reply.id)?.(reply);
    else if (reply.sub === 1 && "payload" in reply) events.push(reply.payload);
  });
  let id = 0;
  const call = (method: string, input: unknown) =>
    new Promise<Record<string, unknown>>((done) => {
      replies.set(++id, done);
      socket.send(JSON.stringify({ id, op: "call", slot: "rules", method, input }));
    });
  socket.send(JSON.stringify({ sub: 1, op: "subscribe", slot: "rules", event: "changed" }));

  const listed = (await call("list", {})).result as { rules: { id: string; on: boolean }[] };
  assert.deepEqual(
    listed.rules.map((r) => [r.id, r.on]),
    [[RULE, false]],
  );
  assert.deepEqual((await call("set", { id: RULE, on: true })).result, {});
  assert.deepEqual(
    ((await call("list", {})).result as { rules: { on: boolean }[] }).rules[0]?.on,
    true,
  );
  assert.deepEqual(events, [{}]);
  const refused = (await call("set", { id: "Not A Rule", on: true })).error as { code: string };
  assert.equal(refused.code, "invalid");
});
