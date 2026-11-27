// Memory in an agent's own context, as the Assistant's plugin host loads it, over a store in memory.
import assert from "node:assert/strict";
import test from "node:test";
import { type AgentPlugin, createPluginHost } from "assistant/plugins";
import type { Context } from "cordis";
import { type Line, MEMORY_MAX, memory, WORDS } from "../src/index.ts";

/** Where the plugin's lines are in the agent's store. */
const KEPT = "plugin/memory/lines";

/**
 * A kv store in memory, as an agent's own store answers: what is set is a copy, as a store on disk
 * keeps one. A test may have each `set` take a while (`takes`, one per call), or fail (`fails`).
 */
function storeOf() {
  const values = new Map<string, unknown>();
  const play = { takes: [] as number[], fails: false };
  return {
    play,
    /** What is kept of memory: its lines, and the number the next takes. */
    kept: () => values.get(KEPT) as { lines: Line[]; next: number } | undefined,
    store: {
      get: async ({ key }: { key: string }) =>
        values.has(key) ? { value: structuredClone(values.get(key)) as never } : {},
      set: async ({ key, value }: { key: string; value: unknown }) => {
        const copy = structuredClone(value);
        const wait = play.takes.shift();
        if (wait !== undefined) await new Promise((done) => setTimeout(done, wait));
        if (play.fails) throw new Error("ENOSPC: no space left on device, write '/a/home/path'");
        values.set(key, copy);
        return {};
      },
      delete: async ({ key }: { key: string }) => ({ deleted: values.delete(key) }),
      list: async ({ prefix = "" }: { prefix?: string }) => ({
        keys: [...values.keys()].filter((key) => key.startsWith(prefix)).sort(),
        next: null,
      }),
    },
  };
}
const quiet = { info() {}, warn() {}, error() {} };

/** An agent holding memory, on a host that carries it and `beside`. */
async function holding(store: ReturnType<typeof storeOf>["store"], beside: AgentPlugin[] = []) {
  const plugins = await createPluginHost(quiet, [memory, ...beside]).open("a", { store });
  const named = [{ name: "memory" }, ...beside.map(({ name }) => ({ name }))];
  const hold = () => plugins.hold(named);
  const [edit] = (await hold()).tools;
  assert.ok(edit);
  return {
    plugins,
    hold,
    /** The model's call of its function. */
    edit: (asked: unknown) => edit.run(asked, "g"),
    /** What it is told of its lines, as its section reads now. */
    told: () =>
      plugins
        .blocks()
        .map(({ text }) => text)
        .join("\n"),
  };
}
/** The words of the lines kept, in order. */
const texts = (s: ReturnType<typeof storeOf>) => s.kept()?.lines.map((line) => line.text);

test("the agent adds, replaces and removes a line by its id, and is told its lines", async () => {
  const s = storeOf();
  const { plugins, edit, told } = await holding(s.store);
  // One function, under the plugin's name.
  assert.deepEqual(
    plugins.tools().map(({ slot, name }) => `${slot}__${name}`),
    ["memory__edit"],
  );
  assert.deepEqual(await edit({ action: "add", text: "The person is called Sam." }), {
    output: "Kept as line 1.",
    ok: true,
  });
  // Kept on one line, however it was given; and a model may give an id as the number it reads.
  assert.equal((await edit({ action: "add", text: "  Sam is\nvegetarian. " })).ok, true);
  assert.deepEqual(await edit({ action: "replace", id: 2, text: "Sam eats fish, no meat." }), {
    output: "Line 2 replaced.",
    ok: true,
  });
  // Told each line with its id and the day it was written.
  const [first, second] = s.kept()?.lines ?? [];
  assert.match(first?.at ?? "", /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(
    told(),
    `${WORDS}\n\nWhat you remember:\n- [1] The person is called Sam. (${first?.at})\n- [2] Sam eats fish, no meat. (${second?.at})`,
  );
  assert.deepEqual(await edit({ action: "remove", id: "1" }), {
    output: "Line 1 removed.",
    ok: true,
  });
  assert.deepEqual(texts(s), ["Sam eats fish, no meat."]);
  assert.ok(!told().includes("called Sam"));
  // A line's id is never another's later: the next line is 3, though 1 has gone.
  assert.equal(
    (await edit({ action: "add", text: "Sam's sister is Ana." })).output,
    "Kept as line 3.",
  );
  assert.deepEqual(
    s.kept()?.lines.map((line) => line.id),
    ["2", "3"],
  );
  assert.equal(s.kept()?.next, 4);
  await plugins.close();
});

test("the agent is told what its memory is for and whose its lines are, before it holds a line, and each line's day is the day where it runs", async (t) => {
  // A zone far from UTC, where the day there and in UTC differ for half of each day.
  const zone = process.env.TZ;
  process.env.TZ = "Pacific/Kiritimati";
  t.after(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  const s = storeOf();
  const { plugins, edit, told } = await holding(s.store);
  assert.equal(told(), `${WORDS}\n\nYou remember nothing yet.`);
  const day = () => {
    const now = new Date();
    return [now.getFullYear(), now.getMonth() + 1, now.getDate()]
      .map((part) => String(part).padStart(2, "0"))
      .join("-");
  };
  // The day here before and after it is written: the same, unless midnight came between.
  const before = day();
  await edit({ action: "add", text: "The person is called Sam." });
  assert.ok([before, day()].includes(s.kept()?.lines[0]?.at ?? ""));
  await plugins.close();
});

test("its lines outlast its being unloaded and the agent's restart: the store keeps them", async () => {
  const s = storeOf();
  const first = await holding(s.store);
  await first.edit({ action: "add", text: "The person is called Sam." });
  // Unloaded, as when its capability is removed, nothing is told; held again, it finds them.
  await first.plugins.hold([]);
  assert.equal(first.told(), "");
  await first.hold();
  assert.ok(first.told().includes("[1] The person is called Sam."));
  // A restart: another host and another context, on the agent's same store.
  await first.plugins.close();
  const again = await holding(s.store);
  assert.ok(again.told().includes("[1] The person is called Sam."));
  assert.equal(
    (await again.edit({ action: "add", text: "Sam is vegetarian." })).output,
    "Kept as line 2.",
  );
  await again.plugins.close();
});

test("a change that can't be made is refused with why, and nothing changes", async () => {
  const s = storeOf();
  const { plugins, edit, told } = await holding(s.store);
  await edit({ action: "add", text: "The person is called Sam." });
  const before = s.kept();
  const refused = async (asked: unknown) => {
    const answer = await edit(asked);
    assert.equal(answer.ok, false);
    return answer.output;
  };
  assert.equal(await refused({ action: "add", text: "  \n " }), "A line needs words.");
  assert.equal(await refused({ action: "replace", id: "7", text: "Sam." }), "There is no line 7.");
  assert.equal(await refused({ action: "remove", id: "7" }), "There is no line 7.");
  for (const asked of [
    { action: "add" },
    { action: "replace", id: "1" },
    { action: "remove" },
    {},
    null,
  ])
    assert.equal(
      await refused(asked),
      "Give add with text, replace with id and text, or remove with id.",
    );
  assert.deepEqual(s.kept(), before);

  // The lines hold so much as they are told, ids and days with them: a line that fills what is
  // left to the last character is kept, and one more character is refused, added or replaced.
  const room = MEMORY_MAX - (told().split("What you remember:\n")[1] ?? "").length;
  const fills = room - "\n- [2]  (2026-01-01)".length;
  assert.equal((await edit({ action: "add", text: "y".repeat(fills) })).ok, true);
  const full = MEMORY_MAX + 1;
  assert.equal(
    await refused({ action: "add", text: "z" }),
    `Memory holds at most ${MEMORY_MAX} characters, and this would make ${full + "\n- [3]  (2026-01-01)".length}: replace or remove a line first.`,
  );
  assert.equal(
    await refused({ action: "replace", id: "2", text: "y".repeat(fills + 1) }),
    `Memory holds at most ${MEMORY_MAX} characters, and this would make ${full}: replace or remove a line first.`,
  );
  // A replacement no longer than what it replaces still fits, and a removal always does.
  assert.equal((await edit({ action: "replace", id: "2", text: "z".repeat(fills) })).ok, true);
  assert.equal((await edit({ action: "remove", id: "1" })).ok, true);
  await plugins.close();
});

test("changes asked at once are made one at a time, each kept before the next begins", async () => {
  const s = storeOf();
  const { plugins, edit } = await holding(s.store);
  // The agent's pieces of work each add a line at once, and the store keeps the first slowest.
  s.play.takes = [40, 20, 5];
  const answers = await Promise.all(
    ["One.", "Two.", "Three."].map((text) => edit({ action: "add", text })),
  );
  assert.deepEqual(
    answers.map(({ output }) => output),
    ["Kept as line 1.", "Kept as line 2.", "Kept as line 3."],
  );
  // What the store holds is what the last change left: every line, and the number the next takes.
  assert.deepEqual(texts(s), ["One.", "Two.", "Three."]);
  assert.equal(s.kept()?.next, 4);
  await plugins.close();
});

test("a change the store didn't keep is refused, and is neither told nor counted", async () => {
  const s = storeOf();
  const { plugins, edit, told } = await holding(s.store);
  await edit({ action: "add", text: "The person is called Sam." });
  s.play.fails = true;
  // Said plainly, with nothing of where the agent's files are.
  for (const asked of [
    { action: "add", text: "Sam is vegetarian." },
    { action: "replace", id: "1", text: "The person is called Ana." },
    { action: "remove", id: "1" },
  ])
    assert.deepEqual(await edit(asked), {
      output: "Memory couldn't be saved, so nothing changed.",
      ok: false,
    });
  assert.ok(told().endsWith(`[1] The person is called Sam. (${s.kept()?.lines[0]?.at})`));
  // Once the store keeps again, the next line takes the id the refused one would have had.
  s.play.fails = false;
  assert.equal(
    (await edit({ action: "add", text: "Sam is vegetarian." })).output,
    "Kept as line 2.",
  );
  await plugins.close();
});

test("the agent's other plugins reach its lines through its service", async () => {
  const reached: Context["memory"][] = [];
  /** A plugin that keeps lines by itself, as one that listens to the agent would. */
  const keeping: AgentPlugin = {
    name: "keeping",
    inject: ["memory"],
    apply(ctx: Context) {
      reached.push(ctx.memory);
    },
  };
  const s = storeOf();
  const { plugins, edit, told } = await holding(s.store, [keeping]);
  const [lines] = reached;
  assert.ok(lines);
  await edit({ action: "add", text: "The person is called Sam." });
  // It reads what the model wrote; what it adds, replaces and removes is kept, and told the model.
  assert.deepEqual(
    lines.read().map(({ id, text }) => [id, text]),
    [["1", "The person is called Sam."]],
  );
  assert.equal((await lines.add("Sam is vegetarian.")).id, "2");
  await lines.replace("1", "The person is called Samira.");
  await lines.remove("2");
  assert.deepEqual(texts(s), ["The person is called Samira."]);
  assert.ok(told().includes("[1] The person is called Samira."));
  // Refused as the model's are, with why.
  await assert.rejects(lines.replace("9", "Sam."), /^Error: There is no line 9\.$/);
  await assert.rejects(lines.add(" "), /^Error: A line needs words\.$/);
  await plugins.close();
});

test("lines that can't be read fail its load: the agent runs without it, with the reason and nothing of where they are", async () => {
  const s = storeOf();
  const unreadable = {
    ...s.store,
    get: async () => {
      throw new SyntaxError("Unexpected token in JSON at /a/home/path/kv/plugin%2Fmemory%2Flines");
    },
  };
  const plugins = await createPluginHost(quiet, [memory]).open("a", { store: unreadable });
  assert.deepEqual((await plugins.hold([{ name: "memory" }])).without, [
    { name: "memory", why: "didn't load", said: "Its lines couldn't be read." },
  ]);
  // Nothing of it is offered or told, and nothing was written over its lines.
  assert.deepEqual(plugins.tools(), []);
  assert.equal(s.kept(), undefined);
  await plugins.close();
});
