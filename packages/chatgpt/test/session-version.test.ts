import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hub, listen, PERSON } from "@agentorg/hub";
import { hubBindings, llmSession } from "@agentorg/interfaces";
import { defineInterface, describeInterface, type Interface } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";

/** `llm.session@1` as it was before `retrying`: its methods, and `delta` its one event. */
const before = defineInterface({
  name: "llm.session",
  major: 1,
  kind: "rpc",
  methods: llmSession.methods,
  events: { delta: llmSession.events.delta },
});
/** Its hash then, and now: the one hash `retrying` moves. */
const BEFORE = "sha256-71b7b45640682b691346fcbefd09c47969991b45a42ebe838d2c3279c3ec7340";
const NOW = "sha256-d976330362fb88e84ecedcf89b88a260a09e153efbcbdc6fafaa373447a7947b";

const until = async (condition: () => boolean | Promise<boolean>, what: string) => {
  for (let waited = 0; !(await condition()); waited += 10) {
    if (waited > 15_000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("a binding to llm.session@1 made before `retrying` is kept, and answers once both ends declare it; a consumer that doesn't hear it is answered as before", async (t) => {
  assert.equal(describeInterface(before).hash, BEFORE);
  assert.equal(describeInterface(llmSession).hash, NOW);

  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-session-version-")));
  const hub = Hub.open(join(root, "home"));
  const server = await listen(hub);
  const leaving: (() => void | Promise<void>)[] = [];
  t.after(async () => {
    for (const leave of leaving.reverse()) await leave();
    await server.close();
    hub.close();
    rmSync(root, { recursive: true, force: true });
  });
  const person = await connect({
    hubUrl: server.url,
    actorId: PERSON,
    credential: readFileSync(join(root, "home", "person-credential"), "utf8").trim(),
    slots: { bindings: hubBindings },
    declare: false,
  });
  leaving.push(() => person.close());

  // A model, as a provider of either version: each request is answered "ok", and with
  // `retrying`, its caller is first told a retry begins.
  const model = hub.state.createActor(PERSON, { name: "Model" });
  const provide = async (session: Interface, retrying: boolean) => {
    const client = await connect({
      hubUrl: server.url,
      actorId: model.actorId,
      credential: model.credential as string,
      exports: { session },
      start(ctx) {
        const exported = ctx.exports.session as unknown as {
          implement(handlers: Record<string, unknown>): void;
          emit(event: string, payload: unknown, options: { to: string }): void;
        };
        exported.implement({
          models: () => ({ models: [] }),
          respond: (input: { requestId: string }, { caller }: { caller: string }) => {
            if (retrying)
              exported.emit(
                "retrying",
                { requestId: input.requestId, attempt: 1, of: 10, at: new Date().toISOString() },
                { to: caller },
              );
            return { output: [{ type: "message", role: "assistant", content: "ok" }] };
          },
          cancel: () => ({}),
        });
      },
    });
    leaving.push(() => client.close());
    return client;
  };
  /** A consumer of either version, bound to the model, which hears `retrying` only if asked to. */
  const consumer = (name: string) => {
    const made = hub.state.createActor(PERSON, {
      name,
      bindings: [{ slot: "model", provider: model.actorId, export: "session" }],
    });
    return async (session: Interface, heard?: unknown[]) => {
      const client = await connect({
        hubUrl: server.url,
        actorId: made.actorId,
        credential: made.credential as string,
        slots: { model: session },
        start(ctx) {
          const slot = ctx.slots.model as unknown as {
            on(event: string, listener: (payload: unknown) => void): void;
          };
          if (heard) slot.on("retrying", (payload) => heard.push(payload));
        },
      });
      leaving.push(() => client.close());
      await until(() => client.slots.model.bound, `${name}'s model slot to be bound`);
      return {
        actorId: made.actorId,
        close: () => client.close(),
        ask: () =>
          (
            client.slots.model.call as unknown as {
              respond(input: unknown): Promise<{ output: unknown[] }>;
            }
          ).respond({ requestId: crypto.randomUUID(), instructions: "", input: [] }),
      };
    };
  };
  const binding = async (actor: string) =>
    (await person.slots.bindings.call.list({ actor })).bindings.find((one) => one.slot === "model");

  // Made before: both ends declare it as it was, and it answers.
  let provider = await provide(before, false);
  const plain = consumer("Plain");
  const hearing = consumer("Hearing");
  let old = await plain(before);
  const ok = [{ type: "message", role: "assistant", content: "ok" }];
  assert.deepEqual((await old.ask()).output, ok);
  const made = await binding(old.actorId);
  assert.ok(made);

  // The model comes back declaring it as it is now: the binding stays, said to differ meanwhile.
  provider.close();
  await provider.closed;
  provider = await provide(llmSession, true);
  await until(async () => (await binding(old.actorId))?.mismatched === true, "the ends to differ");
  assert.ok(await binding(old.actorId), "kept");
  // Meanwhile a consumer still declaring it as it was is refused, and nothing reaches the model.
  await assert.rejects(old.ask(), { code: "version_mismatch" });

  // The consumer comes back declaring it as it is now too: the same binding answers again, and
  // a consumer that doesn't hear `retrying` is answered as it was.
  await old.close();
  old = await plain(llmSession);
  const kept = await binding(old.actorId);
  assert.ok(kept);
  assert.equal(kept.mismatched, undefined);
  assert.equal(kept.at, made.at, "the binding made before, not one made anew");
  assert.deepEqual((await old.ask()).output, ok);

  // One that hears it is told, before its answer.
  const heard: unknown[] = [];
  const told = await hearing(llmSession, heard);
  assert.deepEqual((await told.ask()).output, ok);
  await until(() => heard.length === 1, "the retry to be heard");
  assert.match(JSON.stringify(heard[0]), /"attempt":1,"of":10/);

  // Made once, never unbound: of that binding, each end's new declaration is one line of the
  // audit.
  const lines = hub.state
    .audit(0, 1000)
    .entries.filter(
      (entry) =>
        (entry.details as { consumer?: string }).consumer === old.actorId &&
        (["bind", "unbind"].includes(entry.kind) || entry.kind.startsWith("binding.")),
    )
    .map((entry) => `${entry.kind}: ${(entry.details as { why?: string }).why ?? ""}`);
  assert.deepEqual(lines, [
    "bind: ",
    "binding.keep: its two ends declare different versions of its interface",
    "binding.keep: both ends declare the same interface again",
  ]);
});
