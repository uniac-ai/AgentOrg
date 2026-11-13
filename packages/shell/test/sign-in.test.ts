// The model account's states, wherever they show: Home's place for what is left to set up, the
// bar's mark, an agent's line, a chat's composer, the create window; and a tab that is no longer
// signed in to AgentOrg. Over the stand-in gateway.
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
const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
};
async function open(gateway: Gateway, hash = "#/", session: string | null = SESSION) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  // ChatGPT's page is answered here: nothing leaves this computer.
  await page
    .context()
    .route("https://auth.example/**", (route) => route.fulfill({ status: 200, body: "ChatGPT" }));
  if (session)
    await page.addInitScript((s) => localStorage.setItem("agentorg.session", s), session);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
const SENTENCE = "Agents can't work until you sign in with ChatGPT.";
const setUp = (page: Page) => page.getByRole("main").getByRole("region", { name: "Set up" });
/** Whether Home's row in the bar is marked. */
const marked = (page: Page) =>
  page
    .getByRole("navigation", { name: "Main" })
    .getByRole("button", { name: "Home", exact: true })
    .locator("span.relative > span")
    .count();

test(
  "signed out of ChatGPT a person is in the app all the same: Home holds what is left to set up, and the way in",
  withGateway(async (gateway) => {
    gateway.setAccount("signed_out");
    const page = await open(gateway);
    const place = setUp(page);
    await place.getByRole("heading", { name: "Sign in with ChatGPT" }).waitFor();
    await place.getByText("Your agents can't work until you do.", { exact: false }).waitFor();
    // Their agents and chats are there, and Home's row says something is left.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: /Reviewer/ })
      .waitFor();
    await page.getByRole("main").getByRole("region", { name: "Recent" }).waitFor();
    assert.equal(await marked(page), 1);
    const before = await place.boundingBox();
    const popup = page.context().waitForEvent("page");
    await place.getByRole("button", { name: "Continue with ChatGPT" }).click();
    assert.match((await popup).url(), /^https:\/\/auth\.example\/authorize/);
    // While it waits it says what to do, in the same place, and can't be pressed again.
    const waiting = place.getByRole("button", { name: "Waiting for ChatGPT…" });
    await waiting.waitFor();
    assert.equal(await waiting.isDisabled(), true);
    await place.getByText("Approve AgentOrg on ChatGPT's page, then come back here.").waitFor();
    assert.deepEqual(await place.boundingBox(), before, "nothing moves");
    assert.ok(
      gateway.calls.some(
        (c) =>
          c.slot === "login" &&
          c.method === "start" &&
          String(c.input.redirectUri).endsWith("/oauth/chatgpt"),
      ),
    );
    // Signed in, the place and the mark are gone.
    gateway.setAccount("signed_in");
    await place.waitFor({ state: "detached" });
    assert.equal(await marked(page), 0);
    await page.close();
  }),
);

test(
  "every place an agent would have worked says the one sentence: its line, a chat's composer, the create window",
  withGateway(async (gateway) => {
    gateway.setAccount("signed_out");
    const page = await open(gateway, "#/a/a-reviewer");
    const main = page.getByRole("main");
    const state = main.getByRole("status", { name: "State" });
    await state.getByText(SENTENCE).waitFor();
    // A chat with it has the way in where a message would be written.
    await main.getByRole("button", { name: "Message", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Chats" });
    const place = panel.getByRole("group", { name: "Sign in to send" });
    await place.getByText(SENTENCE).waitFor();
    await place.getByRole("button", { name: "Continue with ChatGPT" }).waitFor();
    assert.equal(await panel.getByRole("textbox", { name: "Message" }).count(), 0);
    await panel.getByRole("button", { name: "Close chats" }).click();
    // The create window says it at its foot.
    await page
      .getByRole("button", { name: /^Create/ })
      .first()
      .click();
    const create = page.getByRole("dialog", { name: "Create" });
    await create.getByRole("button", { name: /^Assistant/ }).click();
    await create.getByText(SENTENCE).waitFor();
    await page.keyboard.press("Escape");
    // The line's way in is Home, where everything left to set up is.
    await state.getByRole("button", { name: "Set up" }).click();
    await page.waitForURL(/#\/$/);
    await setUp(page).waitFor();
    // An agent that isn't running says that, and how to start it: the sentence is for one that would work.
    await page.goto(`${gateway.url}/#/a/a-weekly`);
    await state.getByText("Stopped", { exact: true }).waitFor();
    assert.equal(await state.getByText(SENTENCE).count(), 0);
    await state.getByRole("button", { name: "Start" }).waitFor();
    await page.close();
  }),
);

test(
  "while ChatGPT is starting the way in waits; an account that isn't eligible is told so, with another to use",
  withGateway(async (gateway) => {
    gateway.setAccount("signed_out", false);
    const page = await open(gateway);
    const place = setUp(page);
    const starting = place.getByRole("button", { name: "ChatGPT is starting…" });
    await starting.waitFor();
    assert.equal(await starting.isDisabled(), true);
    const before = await place.boundingBox();
    gateway.setAccount("signed_out");
    await place.getByRole("button", { name: "Continue with ChatGPT" }).waitFor();
    gateway.setAccount("ineligible");
    await place.getByRole("heading", { name: "This ChatGPT account can't be used" }).waitFor();
    await place.getByRole("button", { name: "Use another account" }).waitFor();
    assert.deepEqual(await place.boundingBox(), before, "nothing moves from one state to the next");
    await page.goto(`${gateway.url}/#/a/a-reviewer`);
    await page
      .getByRole("main")
      .getByRole("status", { name: "State" })
      .getByText("This ChatGPT account isn't eligible to use its plan in this app.")
      .waitFor();
    await page.close();
  }),
);

test(
  "a tab that is no longer signed in to AgentOrg says so, with the command for a new link",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/", null);
    const main = page.getByRole("main", { name: "Signed out" });
    await main.getByRole("heading", { name: "AgentOrg" }).waitFor();
    await main
      .getByText("This tab is no longer signed in. Run this for a new sign-in link.")
      .waitFor();
    assert.equal(await main.locator("code").innerText(), "agentorg open");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await main.getByRole("button", { name: "Copy the command" }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "agentorg open");
    assert.equal(await page.getByRole("navigation").count(), 0);
    await page.close();
  }),
);

test(
  "the wait for ChatGPT ends when the account says where it stands, with no way in shown in between",
  withGateway(async (gateway) => {
    gateway.setAccount("signed_out");
    const page = await open(gateway);
    const place = setUp(page);
    await place.getByRole("button", { name: "Continue with ChatGPT" }).click();
    await place.getByRole("button", { name: "Waiting for ChatGPT…" }).waitFor();
    // The account changes, and is not yet read again.
    const release = gateway.hold("login.status");
    gateway.setAccount("signed_in");
    await page.waitForTimeout(400);
    assert.equal(await place.getByRole("button", { name: "Waiting for ChatGPT…" }).count(), 1);
    release();
    await place.waitFor({ state: "detached" });
    // It ends as well when the account that was approved turns out not to be eligible.
    gateway.setAccount("signed_out");
    await place.getByRole("button", { name: "Continue with ChatGPT" }).click();
    await place.getByRole("button", { name: "Waiting for ChatGPT…" }).waitFor();
    gateway.setAccount("ineligible");
    await place.getByRole("button", { name: "Use another account" }).waitFor();
    await page.close();
  }),
);

test(
  "someone signed in stays so while ChatGPT's process isn't connected; with no account at all nothing is left to set up",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-reviewer");
    const main = page.getByRole("main");
    await main.getByRole("button", { name: "Message", exact: true }).click();
    const box = page
      .getByRole("complementary", { name: "Chats" })
      .getByRole("textbox", { name: "Message" });
    await box.fill("half typed");
    // Its process goes: the account can't be asked, and nothing changes for someone signed in.
    gateway.setAccount("signed_in", false);
    await page.waitForTimeout(500);
    assert.equal(await box.inputValue(), "half typed");
    assert.equal(await page.getByRole("group", { name: "Sign in to send" }).count(), 0);
    // Signed out, the place takes the box's place; signed in again, what was half typed is there.
    gateway.setAccount("signed_out");
    await page.getByRole("group", { name: "Sign in to send" }).waitFor();
    gateway.setAccount("signed_in");
    await box.waitFor();
    assert.equal(await box.inputValue(), "half typed");
    // No account bound at all: there is nothing to sign in to, so nothing says to.
    gateway.setAccount("none");
    await page.waitForTimeout(500);
    assert.equal(await page.getByRole("group", { name: "Sign in to send" }).count(), 0);
    assert.equal(await marked(page), 0);
    await page.close();
  }),
);

test(
  "a tab whose AgentOrg sign-in ends while it is open shows only that, and nothing of the home",
  withGateway(async (gateway) => {
    const page = await open(gateway, "#/a/a-reviewer");
    await page.getByRole("main").getByRole("heading", { name: "Reviewer", level: 1 }).waitFor();
    gateway.endSessions();
    await page.getByRole("main", { name: "Signed out" }).getByText("agentorg open").waitFor();
    assert.equal(await page.getByRole("navigation").count(), 0);
    assert.equal(await page.getByText("Reviewer").count(), 0);
    await page.close();
  }),
);
