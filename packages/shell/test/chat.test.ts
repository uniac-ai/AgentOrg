// The chat page in a real browser, over the stand-in gateway.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;

const panel = (page: Page) => page.getByRole("complementary", { name: "Chats" });

/** A signed-in page with this agent's session open in the panel. */
async function open(gateway: Gateway, agent = "a-reviewer", width = 1440): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/a/${agent}`);
  await page.getByRole("main").getByRole("button", { name: "Chat", exact: true }).click();
  await panel(page).getByRole("textbox", { name: "Message" }).waitFor();
  await panel(page).getByText("Reviewed #482").first().waitFor();
  return page;
}
const input = (page: Page) => panel(page).getByRole("textbox", { name: "Message" });

const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
};
/** Waits for what the stand-in will see, which nothing on the page shows. */
async function until(seen: () => boolean) {
  for (let i = 0; i < 100 && !seen(); i++) await new Promise((done) => setTimeout(done, 20));
  assert.ok(seen(), "it never happened");
}
const reply = (id: string, text: string) => ({
  id,
  role: "assistant" as const,
  text,
  at: new Date().toISOString(),
});

test(
  "Enter sends and empties the box, and Shift+Enter makes a new line",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await input(page).fill("first line");
    await input(page).press("Shift+Enter");
    await input(page).pressSequentially("second line");
    assert.equal(await input(page).inputValue(), "first line\nsecond line");
    assert.equal(gateway.calls.filter((c) => c.method === "send").length, 0, "not sent yet");
    await input(page).press("Enter");
    assert.equal(await input(page).inputValue(), "");
    await panel(page)
      .getByText(/first line/)
      .waitFor();
    await page.close();
  }),
);

test(
  "a sent message shows at once, once, and stays where it is when the record has it",
  withGateway(async (gateway) => {
    gateway.delaySends(1200);
    const page = await open(gateway);
    await input(page).fill("slow to record");
    await input(page).press("Enter");
    const sent = panel(page).getByText("slow to record");
    await sent.waitFor();
    await page.waitForTimeout(400);
    const before = await sent.boundingBox();
    await page.waitForTimeout(1200);
    assert.equal(await sent.count(), 1, "never twice");
    assert.deepEqual(await sent.boundingBox(), before);
    await page.close();
  }),
);

test(
  "a refused send goes, and its text is back in the box",
  withGateway(async (gateway) => {
    gateway.refuseNext("chat.send", "busy", "A turn is running.");
    const page = await open(gateway);
    await input(page).fill("refuse this");
    await input(page).press("Enter");
    await panel(page).getByRole("alert").getByText("A turn is running.").waitFor();
    assert.equal(await input(page).inputValue(), "refuse this");
    await page.close();
  }),
);

test(
  "a reply reveals word by word, then settles as one message with no spans",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    // The agent works, and the newest thing said here is the person's: the chat awaits a reply.
    gateway.setChatStatus("a-reviewer", { state: "working" });
    gateway.addMessage("a-reviewer", {
      id: "u-ask",
      role: "user",
      text: "Why did it fail?",
      at: new Date().toISOString(),
    });
    await panel(page).getByText("Why did it fail?").waitFor();
    await panel(page).getByRole("status").getByText("Thinking").waitFor();
    gateway.delta("a-reviewer", "r1", "Three causes ");
    await panel(page).locator("[data-sd-animate]").first().waitFor();
    const thinking = panel(page).getByRole("status").filter({ hasText: "Thinking" });
    assert.equal(await thinking.count(), 0, "the first words take its place");
    gateway.delta("a-reviewer", "r1", "explain it.");
    await panel(page).getByText("explain it.").waitFor();
    gateway.addMessage("a-reviewer", reply("r1", "Three causes explain it."));
    gateway.setChatStatus("a-reviewer", { state: "idle" });
    await panel(page).getByText("Three causes explain it.").waitFor();
    assert.equal(await panel(page).getByText("Three causes explain it.").count(), 1);
    assert.equal(await panel(page).locator("[data-sd-animate]").count(), 0);
    await page.close();
  }),
);

test(
  "a tool call is one row that ends in place, and opens for what went in and came back",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const at = new Date().toISOString();
    const running = {
      id: "t1",
      role: "tool" as const,
      text: "github__get_issue",
      at,
      tool: { name: "github__get_issue", state: "running" as const, input: '{"n":1}' },
    };
    gateway.setChatStatus("a-reviewer", { state: "working" });
    gateway.addMessage("a-reviewer", running);
    const row = panel(page).getByRole("button", { name: /github__get_issue/ });
    await row.waitFor();
    const before = await row.boundingBox();
    gateway.addMessage("a-reviewer", {
      ...running,
      tool: { ...running.tool, state: "done", output: "the issue" },
    });
    await row.getByRole("img", { name: "done" }).or(page.getByLabel("done")).first().waitFor();
    assert.equal(await row.count(), 1);
    assert.deepEqual(await row.boundingBox(), before);
    await row.click();
    await panel(page).getByText("→ the issue").waitFor();
    await page.close();
  }),
);

test(
  "a chat is messages only: its button is always Send, with no Stop and no Retry, and a message goes while the agent works",
  withGateway(async (gateway) => {
    gateway.addMessage("a-reviewer", {
      id: "u1",
      role: "user",
      text: "Again",
      at: new Date().toISOString(),
    });
    gateway.addMessage("a-reviewer", reply("r2", "The old answer."));
    const page = await open(gateway);
    await panel(page).getByText("The old answer.").waitFor();
    // The agent works, but the newest thing said here is its reply: nothing here awaits one, even
    // once a tool's call of its shows.
    gateway.setChatStatus("a-reviewer", { state: "working" });
    gateway.addMessage("a-reviewer", {
      id: "t-elsewhere",
      role: "tool",
      text: "github__get_issue",
      at: new Date().toISOString(),
      tool: { name: "github__get_issue", state: "done", input: '{"n":1}', output: "the issue" },
    });
    await panel(page)
      .getByRole("button", { name: /github__get_issue/ })
      .waitFor();
    assert.equal(await panel(page).getByRole("status").filter({ hasText: "Thinking" }).count(), 0);
    await input(page).fill("One more thing");
    await panel(page).getByRole("button", { name: "Send", exact: true }).click();
    await panel(page).getByText("One more thing").waitFor();
    await panel(page).getByRole("status").getByText("Thinking").waitFor();
    assert.ok(gateway.calls.some((c) => c.method === "send" && c.input.text === "One more thing"));
    // Still Send while it awaits the reply, and nothing stops or retries.
    await panel(page).getByRole("button", { name: "Send", exact: true }).waitFor();
    for (const name of ["Stop", "Retry"])
      assert.equal(await panel(page).getByRole("button", { name, exact: true }).count(), 0, name);
    await page.close();
  }),
);

test(
  "a message that got no answer says why and offers what helps, until the chat's next reply",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    gateway.failChat("a-reviewer", { code: "usage_limit", message: "Limit." });
    const notice = panel(page).getByRole("alert");
    await notice.getByText("Usage limit reached").waitFor();
    await notice.getByRole("button", { name: "Manage usage" }).waitFor();
    await page.close();
    // The chat's list says it too: it is there on a page opened late.
    const late = await open(gateway);
    await panel(late).getByRole("alert").getByText("Usage limit reached").waitFor();
    // Asked again, the chat awaits a reply and says no problem; failing again, it says it again.
    await input(late).fill("Try again");
    await input(late).press("Enter");
    await panel(late).getByRole("status").getByText("Thinking").waitFor();
    await panel(late).getByRole("alert").waitFor({ state: "detached" });
    gateway.failChat("a-reviewer", { code: "usage_limit", message: "Limit." });
    await panel(late).getByRole("alert").getByText("Usage limit reached").waitFor();
    // Its next reply ends the problem.
    gateway.addMessage("a-reviewer", reply("r3", "Here it is."));
    await panel(late).getByText("Here it is.").waitFor();
    await panel(late).getByRole("alert").waitFor({ state: "detached" });
    await late.close();
  }),
);

test(
  "earlier messages load on asking, and the model isn't in the chat",
  withGateway(async (gateway) => {
    const chat = gateway.agents.get("a-reviewer");
    assert.ok(chat);
    const at = new Date(Date.now() - 86_400_000).toISOString();
    chat.chat.messages.unshift(
      ...Array.from({ length: 120 }, (_, i) => ({
        id: `old${i}`,
        role: "assistant" as const,
        text: `Old note ${i}`,
        at,
      })),
    );
    const page = await open(gateway);
    assert.equal(await panel(page).getByText("Old note 3", { exact: true }).count(), 0);
    await panel(page).getByRole("button", { name: "Earlier messages" }).click();
    await panel(page).getByText("Old note 3", { exact: true }).waitFor({ state: "attached" });
    assert.equal(await panel(page).getByRole("combobox", { name: "Model" }).count(), 0);
    await page.close();
  }),
);

test(
  "a stopped agent's session offers Start",
  withGateway(async (gateway) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript((s) => localStorage.setItem("agentorg.session", s), SESSION);
    await page.goto(`${gateway.url}/#/a/a-weekly`);
    await page.getByRole("main").getByRole("button", { name: "Chat", exact: true }).click();
    await panel(page).getByText("Weekly report is stopped.").waitFor();
    await panel(page).getByRole("button", { name: "Start" }).click();
    await input(page).waitFor();
    await page.close();
  }),
);

test(
  "the chat shows no scrollbar and doesn't overflow, wide or phone",
  withGateway(async (gateway) => {
    for (const width of [1440, 390]) {
      const page = await open(gateway, "a-reviewer", width);
      const bad = await page.evaluate(() => {
        const out: string[] = [];
        if (document.documentElement.scrollWidth > innerWidth) out.push("page overflows");
        for (const el of document.querySelectorAll<HTMLElement>("main, main *, aside, aside *"))
          if (
            /auto|scroll/.test(getComputedStyle(el).overflowY) &&
            el.offsetWidth - el.clientWidth > 0
          )
            out.push(el.className);
        return out;
      });
      assert.deepEqual(bad, [], String(width));
      await page.close();
    }
  }),
);

test(
  "a first message starts a chat, and the next goes on in it",
  withGateway(async (gateway) => {
    assert.equal(gateway.chatOf("a-triage").id, undefined, "Triage has no chat yet");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript(
      (session) => localStorage.setItem("agentorg.session", session),
      SESSION,
    );
    await page.goto(`${gateway.url}/#/a/a-triage`);
    await page.getByRole("main").getByRole("button", { name: "Chat", exact: true }).click();
    await input(page).fill("Route today's issues");
    await input(page).press("Enter");
    await panel(page).getByText("Route today's issues").waitFor();
    // What shows at once is the page's own; the chat exists when the agent has the message.
    await until(() => gateway.calls.some((c) => c.method === "send"));
    const { id } = gateway.chatOf("a-triage");
    assert.ok(id, "the message started a chat");
    gateway.addMessage("a-triage", reply("t1", "Routed seven."));
    gateway.setChatStatus("a-triage", { state: "idle" });
    await panel(page).getByText("Routed seven.").waitFor();
    await panel(page).getByRole("button", { name: "Send", exact: true }).waitFor();

    await input(page).fill("And yesterday's?");
    await input(page).press("Enter");
    await panel(page).getByText("And yesterday's?").waitFor();
    // A send that named no chat would have started another, with none of this in it.
    assert.deepEqual(gateway.chatOf("a-triage"), {
      id,
      messages: ["Route today's issues", "Routed seven.", "And yesterday's?"],
    });
    const sends = gateway.calls.filter((c) => c.method === "send").map((c) => c.input.chat);
    assert.deepEqual(
      sends,
      [undefined, id],
      "the first names no chat, the next names the one it made",
    );
    await page.close();
  }),
);

test(
  "a message sent before the page knows the agent's chat waits, and goes in that chat",
  withGateway(async (gateway) => {
    const { id } = gateway.chatOf("a-reviewer");
    const release = gateway.hold("chat.list");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript(
      (session) => localStorage.setItem("agentorg.session", session),
      SESSION,
    );
    await page.goto(`${gateway.url}/#/a/a-reviewer`);
    await page.getByRole("main").getByRole("button", { name: "Chat", exact: true }).click();
    await input(page).fill("Sent early");
    await input(page).press("Enter");
    await panel(page).getByText("Sent early").waitFor();
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(gateway.calls.filter((c) => c.method === "send").length, 0, "not sent yet");

    release();
    await until(() => gateway.calls.some((c) => c.method === "send"));
    // Sent with no chat named, it would have started a new one and left the record behind.
    assert.equal(gateway.calls.find((c) => c.method === "send")?.input.chat, id);
    await panel(page).getByText("Reviewed #482").first().waitFor();
    assert.equal(gateway.chatOf("a-reviewer").id, id);
    await page.close();
  }),
);

test(
  "what is said in another chat of the agent's stays out of this one",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const now = page.getByRole("main").getByRole("status", { name: "Now" });
    gateway.addMessage("a-reviewer", reply("r3", "Said in this one."));
    await panel(page).getByText("Said in this one.").waitFor();
    await now.getByText("Said in this one.").waitFor();
    // The other chat speaks last, then this one streams: by then both readers have heard it.
    gateway.addElsewhere("a-reviewer", reply("x1", "Said in another chat."));
    gateway.delta("a-reviewer", "r4", "Still writing");
    await panel(page).getByText("Still writing").waitFor();
    assert.equal(await panel(page).getByText("Said in another chat.").count(), 0);
    assert.match(
      (await now.textContent()) ?? "",
      /Said in this one\./,
      "the agent's page keeps to it too",
    );
    await page.close();
  }),
);
