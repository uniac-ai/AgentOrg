// First: the browser globals, before React and the kit load (imports below are sorted).
import "./globals.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { Chat, type ChatEntry, type ChatProps } from "../src/index.ts";
import { byRole, click, key, render, settle, type } from "./dom.ts";

const base: ChatProps = {
  messages: [],
  running: false,
  onSend: async () => {},
  onCancel: () => {},
  name: "Planner",
};
const said = (host: Element) =>
  [
    ...host.querySelectorAll(
      ".kit-chat-user, .kit-chat-assistant .kit-md, .kit-chat-step, .kit-tool-title",
    ),
  ].map((element) => element.textContent);

test("a chat shows the person's messages and each run of replies as one reply, in markdown, its tools in place", async () => {
  const messages: ChatEntry[] = [
    { id: "u1", role: "user", text: "Make me a quest picker" },
    { id: "a1", role: "assistant", text: "I'll build it." },
    {
      id: "t1",
      role: "tool",
      text: "Built pocket-quests 0.0.1",
      tool: { name: "hub.packages.build", state: "done", input: '{ "files": 3 }', output: "{}" },
    },
    { id: "t2", role: "tool", text: "layout__place: ok" },
    { id: "a2", role: "assistant", text: "Your quest: **dumplings**" },
  ];
  const view = await render(<Chat {...base} messages={messages} />);
  await settle();
  assert.deepEqual(said(view.host), [
    "Make me a quest picker",
    "I'll build it.",
    "Built pocket-quests 0.0.1",
    "layout__place: ok",
    "Your quest: dumplings",
  ]);
  // One reply: the agent's name once, over all of it.
  assert.equal(view.host.querySelectorAll(".kit-chat-assistant").length, 1);
  assert.equal(view.host.querySelector(".kit-chat-who")?.textContent, "Planner");
  assert.equal(view.host.querySelector(".kit-md strong")?.textContent, "dumplings");
  // A tool that says what ran is a card, opened for its input and output; one that doesn't is a line.
  const card = view.host.querySelector(".kit-tool") as Element;
  assert.equal(card.querySelector(".kit-tool-name")?.textContent, "hub.packages.build");
  assert.ok(byRole("img", "done", card));
  assert.equal(card.querySelector(".kit-tool-body"), null);
  await click(card.querySelector("button"));
  assert.equal(card.querySelector(".kit-tool-body")?.textContent, '{ "files": 3 }\n→ {}');
  assert.equal(card.querySelector("button")?.getAttribute("aria-expanded"), "true");
  await view.unmount();
});

test("Enter sends what was typed and clears it; a refused send puts it back", async () => {
  const sent: string[] = [];
  let refuse = false;
  const view = await render(
    <Chat
      {...base}
      onSend={async (text) => {
        sent.push(text);
        if (refuse) throw new Error("busy");
      }}
    />,
  );
  const input = byRole("textbox", "Message") as HTMLTextAreaElement;
  assert.equal(input.placeholder, "Message Planner");
  await type(input, "hello");
  await key(input, { key: "Enter" });
  await settle();
  assert.deepEqual(sent, ["hello"]);
  assert.equal((byRole("textbox", "Message") as HTMLTextAreaElement).value, "");

  refuse = true;
  await type(byRole("textbox", "Message") as Element, "again");
  await key(byRole("textbox", "Message") as Element, { key: "Enter" });
  await settle();
  assert.deepEqual(sent, ["hello", "again"]);
  assert.equal((byRole("textbox", "Message") as HTMLTextAreaElement).value, "again");
  await view.unmount();
});

test("while a turn runs: dots until it has something, Stop cancels, Enter keeps the text", async () => {
  let cancels = 0;
  const sent: string[] = [];
  const asked: ChatEntry[] = [{ id: "u1", role: "user", text: "Hi" }];
  const props = {
    ...base,
    running: true,
    onCancel: () => void cancels++,
    onSend: async (text: string) => void sent.push(text),
  };
  const view = await render(<Chat {...props} messages={asked} />);
  await settle();
  assert.ok(byRole("status", "Thinking"), "dots before the reply has anything");
  assert.equal(byRole("button", "Send"), null);
  await click(byRole("button", "Stop"));
  await settle();
  assert.equal(cancels, 1);
  const input = byRole("textbox", "Message") as HTMLTextAreaElement;
  await type(input, "wait");
  await key(input, { key: "Enter" });
  await settle();
  assert.deepEqual(sent, [], "Enter sends nothing while a turn runs");
  assert.equal((byRole("textbox", "Message") as HTMLTextAreaElement).value, "wait");

  // Its reply streams in: the dots go, and the reply's buttons wait, keeping their room.
  await view.rerender(
    <Chat {...props} messages={[...asked, { id: "a1", role: "assistant", text: "Hel" }]} />,
  );
  await settle();
  assert.equal(byRole("status", "Thinking"), null);
  assert.ok(view.host.querySelector(".kit-chat-bar[data-hidden]"));
  // Back to idle: Send, and the bar shows.
  await view.rerender(
    <Chat
      {...props}
      running={false}
      messages={[...asked, { id: "a1", role: "assistant", text: "Hello" }]}
    />,
  );
  await settle();
  assert.ok(byRole("button", "Send"));
  assert.equal(view.host.querySelector(".kit-chat-bar[data-hidden]"), null);
  await view.unmount();
});

test("Earlier messages loads the page before, Retry runs the last turn again, and a notice sits over the composer", async () => {
  let earlier = 0;
  let retries = 0;
  const messages: ChatEntry[] = [
    { id: "u0", role: "user", text: "Before" },
    { id: "a0", role: "assistant", text: "An earlier reply" },
    { id: "u1", role: "user", text: "Hi" },
    { id: "a1", role: "assistant", text: "Hello" },
  ];
  const view = await render(
    <Chat
      {...base}
      messages={messages}
      hasEarlier
      onEarlier={async () => void earlier++}
      onRetry={() => void retries++}
      notice={<b>Usage limit reached</b>}
      footer={<span>Using ChatGPT plan</span>}
    />,
  );
  await settle();
  await click(byRole("button", "Earlier messages"));
  await settle();
  assert.equal(earlier, 1);
  // Only the last reply offers Retry: it runs the last turn again, whichever reply it's under.
  const retry = [...view.host.querySelectorAll('[aria-label="Retry"]')];
  assert.equal(retry.length, 1);
  assert.ok(view.host.querySelectorAll(".kit-chat-assistant")[1]?.contains(retry[0] as Node));
  await click(byRole("button", "Retry"));
  await settle();
  assert.equal(retries, 1);
  assert.equal(byRole("alert")?.textContent, "Usage limit reached");
  assert.match(
    view.host.querySelector(".kit-chat-composer-row")?.textContent ?? "",
    /Using ChatGPT plan/,
  );
  await view.rerender(<Chat {...base} messages={messages} />);
  await settle();
  assert.equal(byRole("button", "Earlier messages"), null, "nothing earlier, no button");
  assert.equal(byRole("button", "Retry"), null, "no retry offered without onRetry");
  await view.unmount();
});
