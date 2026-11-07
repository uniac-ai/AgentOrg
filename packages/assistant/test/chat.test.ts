import assert from "node:assert/strict";
import test from "node:test";
import { Refused } from "@agentorg/sdk";
import { createTestContext } from "@agentorg/sdk/testing";
import view from "../src/chat.ts";
import { MANAGE_USAGE, noticeOf } from "../src/notice.ts";
import { FakeDocument, type FakeElement } from "./fake-dom.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const at = "2026-11-06T00:00:00.000Z";
type Message = { id: string; role: "user" | "assistant" | "tool"; text: string; at: string };

/** The chat view mounted on a fake DOM, with a fake chat and shell bound to its slots. */
type Status = {
  state: "idle" | "thinking" | "tool" | "error";
  detail?: { code: string; message: string };
};
async function mounted(
  options: {
    history?: () => Promise<Message[]> | Message[];
    /** A paged record, used instead of `history` when given. */
    page?: (input: { before?: string; limit?: number }) => { messages: Message[]; more: boolean };
    bind?: boolean;
    state?: Status;
  } = {},
) {
  const context = createTestContext(view, { actorId: "assistant", module: "chat" });
  await context.start();
  const sent: string[] = [];
  const shell = { opened: [] as string[], signIns: 0 };
  let cancels = 0;
  let retries = 0;
  let refuse: Refused | undefined;
  const history =
    options.history ?? (() => [{ id: "1", role: "user" as const, text: "Earlier", at }]);
  const bindChat = () =>
    context.bind("chat", {
      history: async (input) =>
        options.page ? options.page(input) : { messages: await history(), more: false },
      send: ({ text }) => {
        if (refuse) throw refuse;
        sent.push(text);
        return { messageId: String(sent.length + 1) };
      },
      cancel: () => {
        cancels++;
        return {};
      },
      state: () => options.state ?? { state: "idle" },
      retry: () => {
        retries++;
        return { messageId: "1" };
      },
    });
  let chat = options.bind === false ? undefined : bindChat();
  context.bind("shell", {
    openExternal: ({ url }) => {
      shell.opened.push(url);
      return {};
    },
    signIn: () => {
      shell.signIns++;
      return {};
    },
  });
  const root = new FakeDocument().createElement("main");
  const mount = context.mount("view", root as unknown as Element, {
    theme: { "--canvas": "rgb(20, 20, 20)" },
    size: { width: 400, height: 600 },
  });
  await tick();
  const button = (label: string) =>
    root.find((el) => el.tagName === "BUTTON" && el.textContent === label);
  const log = root.find((el) => el.attributes.get("role") === "log") as FakeElement;
  const box = root.find((el) => el.attributes.get("role") === "alert") as FakeElement;
  const input = root.find((el) => el.tagName === "TEXTAREA") as FakeElement;
  return {
    context,
    root,
    get chat() {
      if (!chat) throw new Error("not bound");
      return chat;
    },
    bindChat: () => {
      chat = bindChat();
    },
    refuse: (error: Refused | undefined) => {
      refuse = error;
    },
    sent,
    shell,
    button,
    log,
    box,
    input,
    mount,
    texts: () => log.children.map((el) => el.textContent),
    cancels: () => cancels,
    retries: () => retries,
  };
}

test("the chat shows its history, then streams and settles each reply in place", async () => {
  const v = await mounted();
  assert.deepEqual(v.texts(), ["Earlier"]);
  assert.equal(v.box.hidden, true);
  v.chat.emit("message", { id: "2", role: "user", text: "Hello", at });
  v.chat.emit("delta", { id: "3", text: "Hi" });
  const streamed = v.log.children.at(-1);
  v.chat.emit("delta", { id: "3", text: " there" });
  assert.deepEqual(v.texts(), ["Earlier", "Hello", "Hi there"]);
  v.chat.emit("message", { id: "3", role: "assistant", text: "Hi there.", at });
  v.chat.emit("message", { id: "4", role: "tool", text: "layout__place: done", at });
  assert.equal(v.log.children[2], streamed, "the streamed row becomes the reply's row");
  assert.deepEqual(
    v.log.children.map((el) => [el.className, el.textContent]),
    [
      ["msg user", "Earlier"],
      ["msg user", "Hello"],
      ["msg assistant", "Hi there."],
      ["msg tool", "layout__place: done"],
    ],
  );
  // A late delta for a settled reply changes nothing.
  v.chat.emit("delta", { id: "3", text: "ghost" });
  assert.equal(v.log.children.length, 4);
  const frame = v.root.find((el) => el.className === "chat");
  assert.equal(frame?.style.values.get("--canvas"), "rgb(20, 20, 20)");
});

test("history read late is put first, and outranks the order events came in", async () => {
  let answer: (messages: Message[]) => void = () => {};
  const v = await mounted({ history: () => new Promise((resolve) => (answer = resolve)) });
  v.chat.emit("message", { id: "5", role: "user", text: "M5", at });
  answer([
    { id: "4", role: "user", text: "M4", at },
    { id: "5", role: "user", text: "M5", at },
    { id: "6", role: "assistant", text: "M6", at },
  ]);
  await tick();
  assert.deepEqual(v.texts(), ["M4", "M5", "M6"]);
  v.chat.emit("message", { id: "6", role: "assistant", text: "M6", at });
  assert.deepEqual(v.texts(), ["M4", "M5", "M6"]);
});

test("a chat bound after the view opens is read then, and a failed read shows a notice", async () => {
  const v = await mounted({ bind: false });
  assert.deepEqual(v.texts(), []);
  v.bindChat();
  await tick();
  assert.deepEqual(v.texts(), ["Earlier"]);
  const w = await mounted({
    history: () => {
      throw new Refused("failed", "The record couldn't be read.");
    },
  });
  assert.equal(w.box.hidden, false);
  assert.match(w.box.textContent, /couldn't be read/);
});

test("plan usage is shown beside the composer, with Manage usage", async () => {
  const v = await mounted();
  assert.ok(v.root.find((el) => el.textContent === "Using ChatGPT plan"));
  v.button("Manage usage")?.click();
  await tick();
  assert.deepEqual(v.shell.opened, [MANAGE_USAGE]);
  assert.equal(v.input.attributes.get("aria-label"), "Message");
});

test("Enter sends, not while composing or with Shift, and Stop cancels a running turn", async () => {
  const v = await mounted();
  v.input.value = "   ";
  v.button("Send")?.click();
  assert.deepEqual(v.sent, []);
  const enter = (extra: object) =>
    v.input.dispatch("keydown", {
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      preventDefault() {},
      ...extra,
    });
  v.input.value = "候補";
  enter({ isComposing: true });
  enter({ shiftKey: true });
  await tick();
  assert.deepEqual(v.sent, []);
  v.input.value = "Place the board.";
  enter({});
  await tick();
  assert.deepEqual(v.sent, ["Place the board."]);
  assert.equal(v.input.value, "");
  v.chat.emit("status", { state: "thinking" });
  v.button("Stop")?.click();
  await tick();
  assert.equal(v.cancels(), 1);
  v.chat.emit("status", { state: "idle" });
  assert.ok(v.button("Send"));
});

test("a refused send keeps what was typed and says why", async () => {
  const v = await mounted();
  v.refuse(new Refused("busy", "A turn is running."));
  v.input.value = "Too soon.";
  v.button("Send")?.click();
  await tick();
  assert.equal(v.input.value, "Too soon.");
  assert.match(v.box.textContent, /A turn is running/);
});

test("a reply cut off by a cancel or an error goes, and a new turn clears the notice", async () => {
  const v = await mounted();
  v.chat.emit("delta", { id: "9", text: "partial" });
  v.chat.emit("status", { state: "idle" });
  assert.deepEqual(v.texts(), ["Earlier"]);
  // Nor does it come back when the record is read again.
  v.bindChat();
  await tick();
  assert.deepEqual(v.texts(), ["Earlier"]);
  v.chat.emit("delta", { id: "10", text: "half" });
  v.chat.emit("status", { state: "error", detail: { code: "usage_limit", message: "x" } });
  assert.deepEqual(v.texts(), ["Earlier"]);
  assert.equal(v.box.hidden, false);
  v.chat.emit("status", { state: "thinking" });
  assert.equal(v.box.hidden, true);
});

test("each refusal shows its own action", async () => {
  const v = await mounted();
  v.chat.emit("status", {
    state: "error",
    detail: { code: "usage_limit", message: "Usage limit reached." },
  });
  assert.ok(v.box.find((el) => el.textContent === "Usage limit reached"));
  v.box.find((el) => el.tagName === "BUTTON" && el.textContent === "Manage usage")?.click();
  await tick();
  assert.deepEqual(v.shell.opened, [MANAGE_USAGE]);

  v.chat.emit("status", { state: "error", detail: { code: "not_signed_in", message: "x" } });
  v.button("Continue with ChatGPT")?.click();
  await tick();
  assert.equal(v.shell.signIns, 1);

  // Retry runs the last turn again; the message isn't sent a second time.
  v.chat.emit("message", { id: "2", role: "user", text: "Try this.", at });
  v.chat.emit("status", { state: "error", detail: { code: "unavailable", message: "x" } });
  v.button("Retry")?.click();
  await tick();
  assert.equal(v.retries(), 1);
  assert.deepEqual(v.sent, []);
  assert.equal(v.box.hidden, true);
});

test("Retry isn't offered when there is nothing to send again", async () => {
  const v = await mounted({ history: () => [] });
  v.chat.emit("status", { state: "error", detail: { code: "unavailable", message: "x" } });
  assert.equal(v.button("Retry"), undefined);
  assert.equal(v.box.hidden, false);
});

test("after unmount, events change nothing", async () => {
  const v = await mounted();
  v.mount.unmount();
  v.chat.emit("message", { id: "2", role: "user", text: "Later", at });
  assert.deepEqual(v.texts(), ["Earlier"]);
});

test("each refusal code maps to OpenAI's words and action", () => {
  assert.deepEqual(noticeOf({ code: "usage_limit", message: "" }), {
    title: "Usage limit reached",
    text: "Review your plan or this app's limit in ChatGPT settings.",
    action: { label: "Manage usage", run: "manage" },
  });
  assert.equal(
    noticeOf({ code: "not_signed_in", message: "" }).action?.label,
    "Continue with ChatGPT",
  );
  assert.equal(noticeOf({ code: "unavailable", message: "" }).action?.run, "retry");
  assert.equal(noticeOf({ code: "ineligible", message: "" }).action, undefined);
  assert.deepEqual(noticeOf({ code: "limit", message: "Stopped after 20 calls." }), {
    text: "Stopped after 20 calls.",
  });
});

test("Enter does nothing while a turn runs", async () => {
  const v = await mounted();
  v.chat.emit("status", { state: "thinking" });
  v.input.value = "More.";
  v.input.dispatch("keydown", {
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    preventDefault() {},
  });
  await tick();
  assert.equal(v.cancels(), 0);
  assert.deepEqual(v.sent, []);
  assert.equal(v.input.value, "More.");
});

test("a message sent again under its id replaces the first, after any redraw too", async () => {
  const all: Message[] = Array.from({ length: 101 }, (_, i) => ({
    id: String(i + 1).padStart(4, "0"),
    role: "user" as const,
    text: `M${i + 1}`,
    at,
  }));
  const page = ({ before, limit = 100 }: { before?: string; limit?: number }) => {
    const end = before === undefined ? all.length : all.findIndex((m) => m.id === before);
    const start = Math.max(0, end - limit);
    return { messages: all.slice(start, end), more: start > 0 };
  };
  const v = await mounted({ page });
  v.chat.emit("message", { id: "t1", role: "tool", text: "layout__place: running", at });
  v.chat.emit("message", { id: "t1", role: "tool", text: "layout__place: done", at });
  assert.equal(v.texts().at(-1), "layout__place: done");
  // "Earlier messages" draws every row again from what the view holds.
  v.button("Earlier messages")?.click();
  await tick();
  assert.equal(v.texts().at(-1), "layout__place: done");
  assert.equal(v.texts().filter((t) => t.startsWith("layout__place")).length, 1);
});

test("after a rebind the newest page shows in order, and earlier pages come on request", async () => {
  const all: Message[] = Array.from({ length: 100 }, (_, i) => ({
    id: String(i + 1).padStart(4, "0"),
    role: "user" as const,
    text: `M${i + 1}`,
    at,
  }));
  const page = ({ before, limit = 100 }: { before?: string; limit?: number }) => {
    const end = before === undefined ? all.length : all.findIndex((m) => m.id === before);
    const start = Math.max(0, end - limit);
    return { messages: all.slice(start, end), more: start > 0 };
  };
  const v = await mounted({ page });
  for (let i = 101; i <= 150; i++) {
    const message = { id: String(i).padStart(4, "0"), role: "user" as const, text: `M${i}`, at };
    all.push(message);
    v.chat.emit("message", message);
  }
  v.bindChat();
  await tick();
  const shown = () => v.texts().filter((t) => t !== "Earlier messages");
  assert.deepEqual(
    shown(),
    Array.from({ length: 100 }, (_, i) => `M${i + 51}`),
  );
  v.button("Earlier messages")?.click();
  await tick();
  assert.deepEqual(
    shown(),
    Array.from({ length: 150 }, (_, i) => `M${i + 1}`),
  );
  assert.equal(v.button("Earlier messages"), undefined);
});

test("a view opened mid-turn shows Stop, and one opened after an error shows its notice", async () => {
  const busy = await mounted({ state: { state: "tool" } });
  assert.ok(busy.button("Stop"));
  const failed = await mounted({
    state: { state: "error", detail: { code: "usage_limit", message: "x" } },
  });
  assert.ok(failed.box.find((el) => el.textContent === "Usage limit reached"));
  assert.ok(failed.button("Send"));
});
