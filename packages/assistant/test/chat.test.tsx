// First: the browser globals, before React and the kit load (imports below are sorted).
import "./globals.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { NotConnected, Refused } from "@agentorg/sdk";
import { createTestContext } from "@agentorg/sdk/testing";
import { act } from "react";
import view from "../src/chat.tsx";
import { MANAGE_USAGE, noticeOf } from "../src/notice.ts";
import { byRole, click, key, settle, type } from "./dom.ts";

const at = "2026-11-06T00:00:00.000Z";
type Message = { id: string; role: "user" | "assistant" | "tool"; text: string; at: string };
type Status = {
  state: "idle" | "thinking" | "tool" | "error";
  detail?: { code: string; message: string };
};

/** The chat view mounted in a document, with a fake chat and shell bound to its slots. */
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
  let refuseRetry: Refused | undefined;
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
        if (refuseRetry) throw refuseRetry;
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
  const root = document.createElement("main");
  document.body.replaceChildren(root);
  let mount: ReturnType<typeof context.mount> | undefined;
  await act(async () => {
    mount = context.mount("view", root, {
      theme: { "--canvas": "rgb(20, 20, 20)" },
      size: { width: 400, height: 600 },
    });
  });
  await settle();
  const alert = () => byRole("alert", undefined, root);
  return {
    root,
    get chat() {
      if (!chat) throw new Error("not bound");
      return chat;
    },
    /** An event from the chat, as its provider sends it. */
    emit: (event: string, payload: unknown) =>
      act(async () => {
        if (!chat) throw new Error("not bound");
        (chat.emit as (event: string, payload: unknown) => void)(event, payload);
      }),
    bindChat: async () => {
      await act(async () => {
        chat = bindChat();
      });
      await settle();
    },
    refuse: (error: Refused | undefined) => {
      refuse = error;
    },
    refuseRetry: (error: Refused | undefined) => {
      refuseRetry = error;
    },
    sent,
    shell,
    /** A button by its name, in the view, or in its notice with `inNotice`. */
    button: (name: string, inNotice = false) =>
      byRole("button", name, inNotice ? (alert() ?? root) : root) as HTMLButtonElement | null,
    alert,
    input: () => byRole("textbox", "Message", root) as HTMLTextAreaElement,
    unmount: () => act(async () => mount?.unmount()),
    /** What the conversation shows, in order: each row's role and text. */
    rows: () =>
      [...root.querySelectorAll(".kit-chat-user, .kit-chat-assistant .kit-md, .kit-chat-step")].map(
        (el) => [
          el.classList.contains("kit-chat-user")
            ? "user"
            : el.classList.contains("kit-chat-step")
              ? "tool"
              : "assistant",
          el.textContent,
        ],
      ),
    texts: () =>
      [...root.querySelectorAll(".kit-chat-user, .kit-chat-assistant .kit-md, .kit-chat-step")].map(
        (el) => el.textContent,
      ),
    cancels: () => cancels,
    retries: () => retries,
  };
}

test("the chat shows its history, then streams and settles each reply in place", async () => {
  const v = await mounted();
  assert.deepEqual(v.texts(), ["Earlier"]);
  assert.equal(v.alert(), null);
  await v.emit("message", { id: "2", role: "user", text: "Hello", at });
  await v.emit("delta", { id: "3", text: "Hi" });
  const streamed = v.root.querySelector(".kit-chat-assistant");
  await v.emit("delta", { id: "3", text: " there" });
  assert.deepEqual(v.texts(), ["Earlier", "Hello", "Hi there"]);
  await v.emit("message", { id: "3", role: "assistant", text: "Hi there.", at });
  await v.emit("message", { id: "4", role: "tool", text: "layout__place: done", at });
  assert.equal(v.root.querySelector(".kit-chat-assistant"), streamed, "settled in the same reply");
  assert.deepEqual(v.rows(), [
    ["user", "Earlier"],
    ["user", "Hello"],
    ["assistant", "Hi there."],
    ["tool", "layout__place: done"],
  ]);
  // A late delta for a settled reply changes nothing.
  await v.emit("delta", { id: "3", text: "ghost" });
  assert.equal(v.rows().length, 4);
  // The theme's tokens are the frame runtime's to set on the frame's document (the SDK's frame
  // entry test), and the document is transparent (the app's layout test, in a browser).
  await v.unmount();
});

test("history read late is put first, and outranks the order events came in", async () => {
  let answer: (messages: Message[]) => void = () => {};
  const v = await mounted({ history: () => new Promise((resolve) => (answer = resolve)) });
  await v.emit("message", { id: "5", role: "user", text: "M5", at });
  await act(async () =>
    answer([
      { id: "4", role: "user", text: "M4", at },
      { id: "5", role: "user", text: "M5", at },
      { id: "6", role: "assistant", text: "M6", at },
    ]),
  );
  await settle();
  assert.deepEqual(v.texts(), ["M4", "M5", "M6"]);
  await v.emit("message", { id: "6", role: "assistant", text: "M6", at });
  assert.deepEqual(v.texts(), ["M4", "M5", "M6"]);
  await v.unmount();
});

test("a chat bound after the view opens is read then, and a failed read shows a notice", async () => {
  const v = await mounted({ bind: false });
  assert.deepEqual(v.texts(), []);
  await v.bindChat();
  assert.deepEqual(v.texts(), ["Earlier"]);
  await v.unmount();
  const w = await mounted({
    history: () => {
      throw new Refused("failed", "The record couldn't be read.");
    },
  });
  assert.match(w.alert()?.textContent ?? "", /couldn't be read/);
  await w.unmount();
});

test("plan usage is shown beside the composer, with Manage usage", async () => {
  const v = await mounted();
  assert.match(
    v.root.querySelector(".kit-chat-composer-row")?.textContent ?? "",
    /Using ChatGPT plan/,
  );
  await click(v.button("Manage usage"));
  await settle();
  assert.deepEqual(v.shell.opened, [MANAGE_USAGE]);
  assert.equal(v.input().getAttribute("aria-label"), "Message");
  await v.unmount();
});

test("Enter sends, not while composing or with Shift, and Stop cancels a running turn", async () => {
  const v = await mounted();
  await type(v.input(), "   ");
  await key(v.input(), { key: "Enter" });
  await settle();
  assert.deepEqual(v.sent, [], "whitespace alone isn't sent");
  await type(v.input(), "候補");
  await key(v.input(), { key: "Enter", isComposing: true });
  await key(v.input(), { key: "Enter", shiftKey: true });
  await settle();
  assert.deepEqual(v.sent, []);
  await type(v.input(), "Place the board.");
  await key(v.input(), { key: "Enter" });
  await settle();
  assert.deepEqual(v.sent, ["Place the board."]);
  assert.equal(v.input().value, "");
  await v.emit("status", { state: "thinking" });
  await click(v.button("Stop"));
  await settle();
  assert.equal(v.cancels(), 1);
  await v.emit("status", { state: "idle" });
  assert.ok(v.button("Send"));
  await v.unmount();
});

test("a refused send keeps what was typed and says why", async () => {
  const v = await mounted();
  v.refuse(new Refused("busy", "A turn is running."));
  await type(v.input(), "Too soon.");
  await click(v.button("Send"));
  await settle();
  assert.equal(v.input().value, "Too soon.");
  assert.match(v.alert()?.textContent ?? "", /A turn is running/);
  await v.unmount();
});

test("a reply cut off by a cancel or an error goes, and a new turn clears the notice", async () => {
  const v = await mounted();
  await v.emit("delta", { id: "9", text: "partial" });
  await v.emit("status", { state: "idle" });
  assert.deepEqual(v.texts(), ["Earlier"]);
  // Nor does it come back when the record is read again.
  await v.bindChat();
  assert.deepEqual(v.texts(), ["Earlier"]);
  await v.emit("delta", { id: "10", text: "half" });
  await v.emit("status", { state: "error", detail: { code: "usage_limit", message: "x" } });
  assert.deepEqual(v.texts(), ["Earlier"]);
  assert.ok(v.alert());
  await v.emit("status", { state: "thinking" });
  assert.equal(v.alert(), null);
  await v.unmount();
});

test("each refusal shows its own action", async () => {
  const v = await mounted();
  await v.emit("status", {
    state: "error",
    detail: { code: "usage_limit", message: "Usage limit reached." },
  });
  assert.equal(v.alert()?.querySelector("b")?.textContent, "Usage limit reached");
  await click(v.button("Manage usage", true));
  await settle();
  assert.deepEqual(v.shell.opened, [MANAGE_USAGE]);

  await v.emit("status", { state: "error", detail: { code: "not_signed_in", message: "x" } });
  await click(v.button("Continue with ChatGPT", true));
  await settle();
  assert.equal(v.shell.signIns, 1);

  // Retry runs the last turn again; the message isn't sent a second time.
  await v.emit("message", { id: "2", role: "user", text: "Try this.", at });
  await v.emit("status", { state: "error", detail: { code: "unavailable", message: "x" } });
  await click(v.button("Retry", true));
  await settle();
  assert.equal(v.retries(), 1);
  assert.deepEqual(v.sent, []);
  assert.equal(v.alert(), null);
  await v.unmount();
});

test("Retry isn't offered when there is nothing to send again", async () => {
  const v = await mounted({ history: () => [] });
  await v.emit("status", { state: "error", detail: { code: "unavailable", message: "x" } });
  assert.ok(v.alert());
  assert.equal(v.button("Retry", true), null);
  await v.unmount();
});

test("after unmount, events change nothing", async () => {
  const v = await mounted();
  await v.unmount();
  await v.emit("message", { id: "2", role: "user", text: "Later", at });
  assert.deepEqual(v.texts(), []);
  assert.equal(v.root.childElementCount, 1, "the view's root, emptied");
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
  await v.emit("status", { state: "thinking" });
  await type(v.input(), "More.");
  await key(v.input(), { key: "Enter" });
  await settle();
  assert.equal(v.cancels(), 0);
  assert.deepEqual(v.sent, []);
  assert.equal(v.input().value, "More.");
  await v.unmount();
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
    await v.emit("message", message);
  }
  await v.bindChat();
  assert.deepEqual(
    v.texts(),
    Array.from({ length: 100 }, (_, i) => `M${i + 51}`),
  );
  await click(v.button("Earlier messages"));
  await settle();
  assert.deepEqual(
    v.texts(),
    Array.from({ length: 150 }, (_, i) => `M${i + 1}`),
  );
  assert.equal(v.button("Earlier messages"), null);
  await v.unmount();
});

test("a view opened mid-turn shows Stop, and one opened after an error shows its notice", async () => {
  const busy = await mounted({ state: { state: "tool" } });
  assert.ok(busy.button("Stop"));
  await busy.unmount();
  const failed = await mounted({
    state: { state: "error", detail: { code: "usage_limit", message: "x" } },
  });
  assert.equal(failed.alert()?.querySelector("b")?.textContent, "Usage limit reached");
  assert.ok(failed.button("Send"));
  await failed.unmount();
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
  await v.emit("message", { id: "t1", role: "tool", text: "layout__place: running", at });
  await v.emit("message", { id: "t1", role: "tool", text: "layout__place: done", at });
  assert.equal(v.texts().at(-1), "layout__place: done");
  // "Earlier messages" draws every row again from what the view holds.
  await click(v.button("Earlier messages"));
  await settle();
  assert.equal(v.texts().at(-1), "layout__place: done");
  assert.equal(v.texts().filter((t) => t?.startsWith("layout__place")).length, 1);
  await v.unmount();
});

test("a tool message that carries its call is a card, running then ended", async () => {
  const v = await mounted();
  const call = { name: "layout__place", input: '{"module":"panel"}' };
  await v.emit("message", {
    id: "t1",
    role: "tool",
    text: "Placing the board",
    at,
    tool: { ...call, state: "running" },
  });
  const card = () => v.root.querySelector(".kit-tool") as Element;
  assert.equal(card().querySelector(".kit-tool-name")?.textContent, "layout__place");
  assert.ok(byRole("status", "running", card()));
  await v.emit("message", {
    id: "t1",
    role: "tool",
    text: "Placed the board",
    at,
    tool: { ...call, state: "done", output: '{"id":"p1"}' },
  });
  assert.equal(v.root.querySelectorAll(".kit-tool").length, 1);
  assert.ok(byRole("img", "done", card()));
  await click(card().querySelector("button"));
  assert.equal(
    card().querySelector(".kit-tool-body")?.textContent,
    '{"module":"panel"}\n→ {"id":"p1"}',
  );
  await v.unmount();
});

test("a chat that isn't there yet says nothing, and is read when it arrives", async () => {
  let there = false;
  const v = await mounted({
    history: () => {
      if (!there) throw new NotConnected("chat");
      return [{ id: "1", role: "user" as const, text: "Earlier", at }];
    },
  });
  assert.equal(v.alert(), null, "a new agent's process is still starting: no notice");
  there = true;
  await v.bindChat();
  assert.deepEqual(v.texts(), ["Earlier"]);
  assert.equal(v.alert(), null);
  await v.unmount();
});

test("a good read ends what a failed read said, but not a refusal of a turn", async () => {
  let failing = true;
  const v = await mounted({
    history: () => {
      if (failing) throw new Refused("failed", "The record couldn't be read.");
      return [];
    },
  });
  assert.match(v.alert()?.textContent ?? "", /couldn't be read/);
  failing = false;
  await v.bindChat();
  assert.equal(v.alert(), null, "its cause is gone");
  // A send refused for lack of a chat goes the same way; one refused for a reason doesn't.
  v.refuse(new NotConnected("chat") as unknown as Refused);
  await type(v.input(), "Too early.");
  await click(v.button("Send"));
  await settle();
  assert.match(v.alert()?.textContent ?? "", /not connected/);
  v.refuse(undefined);
  await v.bindChat();
  assert.equal(v.alert(), null);
  v.refuse(new Refused("busy", "A turn is running."));
  await type(v.input(), "Too soon.");
  await click(v.button("Send"));
  await settle();
  await v.bindChat();
  assert.match(v.alert()?.textContent ?? "", /A turn is running/);
  await v.unmount();
});

test("what the person sends shows at once, and once, whichever of the record and the reply comes first", async () => {
  const v = await mounted({ history: () => [] });
  await type(v.input(), "Hello");
  await click(v.button("Send"));
  await settle();
  assert.deepEqual(v.texts(), ["Hello"], "before the record has it");
  // The reply came first (the send answered "2"): the record's entry takes its place.
  await v.emit("message", { id: "2", role: "user", text: "Hello", at });
  assert.deepEqual(v.texts(), ["Hello"]);
  // The event first: the same.
  await type(v.input(), "Again");
  await click(v.button("Send"));
  await settle();
  await v.emit("message", { id: "3", role: "user", text: "Again", at });
  assert.deepEqual(v.texts(), ["Hello", "Again"]);
  await v.unmount();
});

test("a refused send leaves the conversation, and Send is back", async () => {
  const v = await mounted({ history: () => [] });
  v.refuse(new Refused("busy", "A turn is running."));
  await type(v.input(), "Too soon.");
  await click(v.button("Send"));
  await settle();
  assert.deepEqual(v.texts(), []);
  assert.ok(v.button("Send"));
  await v.unmount();
});

test("Retry takes away what followed the person's message at once, and a refused one puts it back", async () => {
  const v = await mounted({
    history: () => [
      { id: "1", role: "user" as const, text: "Hello", at },
      { id: "2", role: "assistant" as const, text: "The first answer", at },
    ],
  });
  assert.deepEqual(v.texts(), ["Hello", "The first answer"]);
  await click(v.button("Retry"));
  await settle();
  assert.equal(v.retries(), 1);
  assert.deepEqual(v.texts(), ["Hello"], "the old reply is gone before the new one comes");
  await v.emit("message", { id: "3", role: "assistant", text: "The second answer", at });
  assert.deepEqual(v.texts(), ["Hello", "The second answer"]);
  v.refuseRetry(new Refused("busy", "A turn is running."));
  await click(v.button("Retry"));
  await settle();
  assert.deepEqual(v.texts(), ["Hello", "The second answer"]);
  assert.match(v.alert()?.textContent ?? "", /A turn is running/);
  await v.unmount();
});
