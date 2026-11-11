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

/** A signed-in page on an agent's page, with nothing open in the chat. */
async function visit(gateway: Gateway, agent: string, width = 1440): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/a/${agent}`);
  return page;
}
/** A signed-in page with Reviewer's chat open in the panel. */
async function open(gateway: Gateway, width = 1440): Promise<Page> {
  const page = await visit(gateway, "a-reviewer", width);
  await page.getByRole("button", { name: /^Chats/ }).click();
  await panel(page)
    .getByRole("list", { name: "Chats" })
    .getByRole("button")
    .filter({ hasText: "Reviewer" })
    .click();
  await panel(page).getByRole("textbox", { name: "Message" }).waitFor();
  await panel(page).getByRole("status").or(panel(page).locator(".prose-chat")).first().waitFor();
  return page;
}
const input = (page: Page) => panel(page).getByRole("textbox", { name: "Message" });
/** What the person said, in the thread: a chat's title may say the same words. */
const mine = (page: Page, text: string | RegExp) =>
  panel(page).locator(".whitespace-pre-wrap", { hasText: text });

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
    await mine(page, /first line/).waitFor();
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
    const sent = mine(page, "slow to record");
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
    await mine(page, "Why did it fail?").waitFor();
    const thinks = panel(page).getByRole("status").getByText("Thinking");
    await thinks.waitFor();
    // Once the agent has done something, it thinks under that, in the same reply.
    gateway.addMessage("a-reviewer", {
      id: "t-first",
      role: "tool",
      text: "github__get_issue",
      at: new Date().toISOString(),
      tool: { name: "github__get_issue", state: "done", input: '{"n":1}', output: "the issue" },
    });
    const call = panel(page).getByRole("button", { name: /github__get_issue/ });
    await call.waitFor();
    const [above, under] = [await call.boundingBox(), await thinks.boundingBox()];
    assert.ok(above && under);
    assert.equal(Math.round(under.y - (above.y + above.height)), 8);
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
    await mine(page, "One more thing").waitFor();
    await panel(page).getByRole("status").getByText("Thinking").waitFor();
    await until(() =>
      gateway.calls.some((c) => c.method === "send" && c.input.text === "One more thing"),
    );
    // Still Send while it awaits the reply, and nothing stops or retries.
    await panel(page).getByRole("button", { name: "Send", exact: true }).waitFor();
    for (const name of ["Stop", "Retry"])
      assert.equal(await panel(page).getByRole("button", { name, exact: true }).count(), 0, name);
    await page.close();
  }),
);

test(
  "a message that got no answer says why in one line, until the chat's next reply",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    gateway.failChat("a-reviewer", { code: "failed", message: "The model refused it." });
    // One line in the problem's colour, with nothing to press: nothing here can be done about it.
    const said = panel(page).getByRole("alert");
    await said.getByText("The model refused it.").waitFor();
    assert.equal(await said.getByRole("button").count(), 0);
    await page.close();
    // The chat's entry says it too: it is there on a page opened late.
    const late = await visit(gateway, "a-reviewer");
    await late.getByRole("button", { name: /^Chats/ }).click();
    await panel(late)
      .getByRole("list", { name: "Chats" })
      .getByText("The model refused it.")
      .click();
    await panel(late).getByRole("alert").getByText("The model refused it.").waitFor();
    // Asked again, the chat awaits a reply and says no problem; failing again, it says it again.
    await input(late).fill("Try again");
    await input(late).press("Enter");
    await panel(late).getByRole("status").getByText("Thinking").waitFor();
    await panel(late).getByRole("alert").waitFor({ state: "detached" });
    gateway.failChat("a-reviewer", { code: "failed", message: "The model refused it." });
    await panel(late).getByRole("alert").getByText("The model refused it.").waitFor();
    // Its next reply ends the problem.
    gateway.addMessage("a-reviewer", reply("r3", "Here it is."));
    await panel(late).getByText("Here it is.").waitFor();
    await panel(late).getByRole("alert").waitFor({ state: "detached" });
    await late.close();
  }),
);

test(
  "the plan's limit ends its line with the way to the plan's page; being signed out, or a refused send, with nothing",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const line = panel(page).getByRole("alert");
    gateway.failChat("a-reviewer", {
      code: "usage_limit",
      message: "You've reached your plan's limit.",
    });
    await line.getByText("You've reached your plan's limit.").waitFor();
    // The plan's page is ChatGPT's own: it is answered here, so the test goes nowhere else.
    await page
      .context()
      .route("https://chatgpt.com/**", (route) =>
        route.fulfill({ status: 200, contentType: "text/html", body: "<title>Usage</title>" }),
      );
    const opened = page.context().waitForEvent("page");
    await line.getByRole("button", { name: "Manage usage" }).click();
    await (await opened).waitForURL(/chatgpt\.com\/settings\/usage/);
    // Signing in isn't offered from the line.
    gateway.failChat("a-reviewer", { code: "not_signed_in", message: "Sign in to go on." });
    await line.getByText("Sign in to go on.").waitFor();
    assert.equal(await line.getByRole("button").count(), 0);
    // A send that was refused has no fix either, whatever the chat's problem is.
    gateway.failChat("a-reviewer", {
      code: "usage_limit",
      message: "You've reached your plan's limit.",
    });
    await line.getByRole("button", { name: "Manage usage" }).waitFor();
    gateway.refuseNext("chat.send", "unavailable", "It can't take that now.");
    await input(page).fill("Try again");
    await input(page).press("Enter");
    await line.getByText("It can't take that now.").waitFor();
    assert.equal(await line.getByRole("button").count(), 0);
    await page.close();
  }),
);

test(
  "a step that carries no call is its one line, with nothing to open",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    gateway.addMessage("a-reviewer", {
      id: "n1",
      role: "tool",
      text: "Looked at the pull request",
      at: new Date().toISOString(),
    });
    const note = panel(page).locator("p[data-call]", { hasText: "Looked at the pull request" });
    await note.waitFor();
    assert.equal(await note.getByRole("button").count(), 0);
    await page.close();
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
  "a stopped agent's chat is for reading: it has no composer until the agent starts",
  withGateway(async (gateway) => {
    gateway.addChat("a-weekly", {
      id: "c-weekly",
      title: "Numbers for last week",
      said: [reply("w1", "Signups were up 4%.")],
    });
    const page = await visit(gateway, "a-weekly");
    // Its own page still lists the chat; nothing can be started with it.
    await page
      .getByRole("main")
      .getByRole("list", { name: "Chats with Weekly report" })
      .getByText("Numbers for last week")
      .waitFor();
    const chat = page.getByRole("main").getByRole("button", { name: "Message" });
    assert.equal(await chat.isDisabled(), true);
    await page.getByRole("button", { name: /^Chats/ }).click();
    await panel(page)
      .getByRole("button", { name: /^Archived/ })
      .click();
    await panel(page).getByRole("list").getByText("Numbers for last week").click();
    await panel(page).getByText("Signups were up 4%.").waitFor();
    assert.equal(await input(page).count(), 0);
    // The panel lies over the page's right side: closed, the page's own controls are in reach.
    await panel(page).getByRole("button", { name: "Close chats" }).click();
    await page
      .getByRole("status", { name: "State" })
      .getByRole("button", { name: "Start" })
      .click();
    await page.getByRole("button", { name: /^Chats/ }).click();
    await panel(page).getByRole("heading", { name: "Numbers for last week" }).waitFor();
    await input(page).waitFor();
    await page.close();
  }),
);

test(
  "the chat shows no scrollbar and doesn't overflow, wide or phone",
  withGateway(async (gateway) => {
    for (const width of [1440, 390]) {
      const page = await open(gateway, width);
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
    // A page's Message is a chat about to be started with its agent.
    const page = await visit(gateway, "a-triage");
    await page.getByRole("main").getByRole("button", { name: "Message" }).click();
    await panel(page).getByRole("heading", { name: "New chat" }).waitFor();
    const who = panel(page).getByRole("list", { name: "Who with" });
    assert.equal(await who.getByRole("button", { pressed: true }).innerText(), "T\nTriage");
    // A stopped agent can't be picked.
    assert.equal(await who.getByRole("button", { name: /Weekly report/ }).isDisabled(), true);
    await input(page).fill("Route today's issues");
    await input(page).press("Enter");
    // Sent, it is a chat: its thread, called by its first line.
    await panel(page).getByRole("heading", { name: "Route today's issues" }).waitFor();
    await mine(page, "Route today's issues").waitFor();
    await until(() => !!gateway.chatOf("a-triage").id);
    const { id } = gateway.chatOf("a-triage");
    assert.ok(id, "the message started a chat");
    gateway.addMessage("a-triage", reply("t1", "Routed seven."));
    gateway.setChatStatus("a-triage", { state: "idle" });
    await panel(page).getByText("Routed seven.").waitFor();

    await input(page).fill("And yesterday's?");
    await input(page).press("Enter");
    await panel(page).getByText("And yesterday's?").waitFor();
    await until(() => gateway.calls.filter((c) => c.method === "send").length === 2);
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

    // Another chat with the same agent: its earlier chats are offered, and it starts its own.
    await panel(page).getByRole("button", { name: "Close chats" }).click();
    await page.getByRole("main").getByRole("button", { name: "Message" }).click();
    const earlier = panel(page).getByRole("list", { name: "Earlier chats with Triage" });
    await earlier.getByText("Route today's issues").waitFor();
    await input(page).fill("A second thing");
    await input(page).press("Enter");
    await panel(page).getByRole("heading", { name: "A second thing" }).waitFor();
    assert.notEqual(gateway.chatOf("a-triage").id, id);
    await panel(page).getByRole("button", { name: "All chats" }).click();
    const listed = panel(page).getByRole("list", { name: "Chats" });
    await listed.getByText("A second thing").first().waitFor();
    await listed.getByText("Route today's issues").first().waitFor();
    await page.close();
  }),
);

test(
  "a second first message waits for the first: one chat is started, not two",
  withGateway(async (gateway) => {
    const release = gateway.hold("chat.send");
    const page = await visit(gateway, "a-triage");
    await page.getByRole("main").getByRole("button", { name: "Message" }).click();
    await input(page).fill("Route today's issues");
    await input(page).press("Enter");
    await input(page).fill("And yesterday's");
    await input(page).press("Enter");
    // The second isn't sent: it stays in the box.
    assert.equal(await input(page).inputValue(), "And yesterday's");
    release();
    await panel(page).getByRole("heading", { name: "Route today's issues" }).waitFor();
    assert.equal(gateway.calls.filter((c) => c.method === "send").length, 1);
    await page.close();
  }),
);

test(
  "a first message that is refused stays in the box, with the reason",
  withGateway(async (gateway) => {
    gateway.refuseNext("chat.send", "busy", "It can't take that now.");
    const page = await visit(gateway, "a-triage");
    await page.getByRole("main").getByRole("button", { name: "Message" }).click();
    await input(page).fill("Route today's issues");
    await input(page).press("Enter");
    await panel(page).getByRole("alert").getByText("It can't take that now.").waitFor();
    assert.equal(await input(page).inputValue(), "Route today's issues");
    await panel(page).getByRole("heading", { name: "New chat" }).waitFor();
    await page.close();
  }),
);

test(
  "what is said in another chat of the agent's stays out of this one",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    gateway.addMessage("a-reviewer", reply("r3", "Said in this one."));
    await panel(page).getByText("Said in this one.").waitFor();
    // The other chat speaks last, then this one streams: by then both readers have heard it.
    gateway.addElsewhere("a-reviewer", reply("x1", "Said in another chat."));
    gateway.delta("a-reviewer", "r4", "Still writing");
    await panel(page).getByText("Still writing").waitFor();
    assert.equal(await panel(page).getByText("Said in another chat.").count(), 0);
    await page.close();
  }),
);

test(
  "a chat is renamed in place and archived from its options, and found again among the archived",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const options = panel(page).getByRole("button", { name: "Chat options" });
    await options.click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    // The title becomes a field where it stood, ready to type in.
    const title = panel(page).getByRole("textbox", { name: "Chat title" });
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "Chat title",
    );
    await title.fill("The review of #482");
    await title.press("Enter");
    await panel(page).getByRole("heading", { name: "The review of #482" }).waitFor();
    assert.deepEqual(gateway.calls.find((c) => c.method === "rename")?.input, {
      chat: gateway.chatOf("a-reviewer").id,
      title: "The review of #482",
    });
    // Escape leaves it as it was.
    await options.click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await title.fill("Something else");
    await title.press("Escape");
    await panel(page).getByRole("heading", { name: "The review of #482" }).waitFor();

    // A rename or an archive that is refused changes nothing, and says why where it was asked.
    gateway.refuseNext("chat.rename", "unavailable", "It can't be renamed now.");
    await options.click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await title.fill("Refused");
    await title.press("Enter");
    await panel(page).getByRole("alert").getByText("It can't be renamed now.").waitFor();
    // Two were asked for in all: the Escape asked for none.
    assert.deepEqual(
      gateway.calls.filter((c) => c.method === "rename").map((c) => c.input.title),
      ["The review of #482", "Refused"],
    );
    await panel(page).getByRole("heading", { name: "The review of #482" }).waitFor();
    gateway.refuseNext("chat.archive", "unavailable", "It can't be archived now.");
    await options.click();
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await panel(page).getByRole("alert").getByText("It can't be archived now.").waitFor();
    await panel(page).getByRole("heading", { name: "The review of #482" }).waitFor();

    // Archived, it leaves the list for the archived ones, and comes back from there.
    await options.click();
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await panel(page).getByRole("heading", { name: "Chats", exact: true }).waitFor();
    const listed = panel(page).getByRole("list").getByRole("button");
    await page.waitForFunction(
      () => !document.querySelector('ul[aria-label="Chats"]')?.textContent?.includes("#482"),
    );
    await panel(page)
      .getByRole("button", { name: /^Archived\s*1$/ })
      .click();
    await listed.filter({ hasText: "The review of #482" }).click();
    await options.click();
    await page.getByRole("menuitem", { name: "Unarchive" }).click();
    await panel(page).getByRole("button", { name: "All chats" }).click();
    await listed.filter({ hasText: "The review of #482" }).waitFor();
    await page.close();
  }),
);

test(
  "search in the bar finds chats by title, under the agents, and opens the one picked",
  withGateway(async (gateway) => {
    gateway.addChat("a-research", {
      id: "c-oldest",
      title: "Which issues are oldest?",
      said: [reply("o1", "The three oldest are #212, #240 and #251.")],
    });
    gateway.addChat("a-research", {
      id: "c-kept",
      title: "An old issue",
      said: [],
      archived: true,
    });
    const page = await visit(gateway, "a-reviewer");
    const bar = page.getByRole("navigation", { name: "Main" });
    assert.equal(await bar.getByRole("list", { name: "Chats found" }).count(), 0);
    await bar.getByRole("searchbox", { name: "Search" }).fill("issue");
    // Not the archived one.
    const found = bar.getByRole("list", { name: "Chats found" }).getByRole("button");
    await found.first().waitFor();
    assert.deepEqual(await found.allInnerTexts(), ["Which issues are oldest?"]);
    await found.click();
    await panel(page).getByRole("heading", { name: "Which issues are oldest?" }).waitFor();
    await panel(page).getByText("The three oldest are #212").waitFor();
    await page.close();
  }),
);

test(
  "the chat opens on what it showed last, its face goes to its agent's page, and the list starts a new chat",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await panel(page).getByRole("button", { name: "Close chats" }).click();
    await page.getByRole("button", { name: /^Chats/ }).click();
    await panel(page).getByRole("textbox", { name: "Message" }).waitFor();
    // The face in a chat's head is its agent: its page, with the chat out of the way.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Settings" })
      .click();
    await panel(page).getByRole("button", { name: "Reviewer's page" }).click();
    await page.waitForURL(/#\/a\/a-reviewer$/);
    await panel(page).waitFor({ state: "detached" });
    // From the list, a new chat has nobody picked yet, and nowhere to write until someone is.
    await page.getByRole("button", { name: /^Chats/ }).click();
    await panel(page).getByRole("button", { name: "All chats" }).click();
    await panel(page).getByRole("button", { name: "New chat" }).click();
    await panel(page).getByRole("heading", { name: "New chat" }).waitFor();
    const who = panel(page).getByRole("list", { name: "Who with" });
    assert.equal(await who.getByRole("button", { pressed: true }).count(), 0);
    assert.equal(await input(page).count(), 0);
    await who.getByRole("button", { name: /Research/ }).click();
    await input(page).waitFor();
    assert.equal(await input(page).getAttribute("placeholder"), "Message Research");
    await page.close();
  }),
);
