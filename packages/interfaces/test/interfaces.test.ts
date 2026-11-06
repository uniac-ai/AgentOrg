import assert from "node:assert/strict";
import test from "node:test";
import { defineActor, defineWidget, describeInterface } from "@agentorg/sdk";
import { createTestContext } from "@agentorg/sdk/testing";
import { z } from "zod";
import { chat, kv, llmSession, uiView } from "../src/index.ts";

test("each standard interface is named, versioned and describable", () => {
  assert.deepEqual(
    [kv, uiView, chat, llmSession].map((i) => describeInterface(i).id),
    ["kv@1", "ui.view@1", "chat@1", "llm.session@1"],
  );
  for (const i of [kv, uiView, chat, llmSession])
    assert.match(describeInterface(i).hash, /^sha256-[0-9a-f]{64}$/);
});

/** A small Actor that keeps notes in its `kv@1` state slot, and its widget. */
const Notes = z.array(z.string());
const logic = defineActor({
  slots: { store: kv },
  async start(ctx) {
    const read = async () =>
      ctx.slots.store.bound
        ? Notes.parse((await ctx.slots.store.call.get({ key: "notes" })).value ?? [])
        : [];
    ctx.slots.store.onBind(async () => {
      await ctx.slots.store.call.set({ key: "notes", value: [...(await read()), "bound"] });
    });
  },
});
const panel = defineWidget({
  exports: { view: uiView },
  start(ctx) {
    ctx.exports.view.implement({
      mount(el, { size }) {
        (el as Element).textContent = `${size.width}x${size.height}`;
      },
    });
  },
});

test("an Actor uses kv@1 through its slot, and a widget renders through ui.view@1", async () => {
  const values = new Map<string, unknown>();
  const t = createTestContext(logic);
  await t.start();
  t.bind("store", {
    get: ({ key }) => (values.has(key) ? { value: values.get(key) as never } : {}),
    set: ({ key, value }) => {
      values.set(key, value);
      return {};
    },
  });
  await new Promise(setImmediate);
  assert.deepEqual(values.get("notes"), ["bound"]);
  await assert.rejects(t.ctx.slots.store.call.get({ key: "" }), /key/);
  assert.deepEqual(await t.ctx.slots.store.call.get({ key: "missing" }), {});
  values.set("empty", null);
  assert.deepEqual(await t.ctx.slots.store.call.get({ key: "empty" }), { value: null });

  const view = createTestContext(panel);
  await view.start();
  const el = { textContent: "" } as Element;
  view.mount("view", el, { theme: {}, size: { width: 320, height: 240 } }).unmount();
  assert.equal(el.textContent, "320x240");
});
