// The chat page in a real browser, over the stand-in gateway: sending, and what a message sent says
// when it is refused, too long, or gets no answer.
import assert from "node:assert/strict";
import test from "node:test";
import { withBrowser } from "./build-kit.ts";
import {
  input,
  mine,
  nothingUnder,
  open,
  panel,
  reply,
  until,
  visit,
  withGateway,
} from "./chat-kit.ts";

withBrowser();

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
    // What the record says of it waits until the test lets it go.
    const release = gateway.holdSends();
    const page = await open(gateway);
    await input(page).fill("slow to record");
    await input(page).press("Enter");
    const sent = mine(page, "slow to record");
    await sent.waitFor();
    await page.waitForTimeout(400);
    const working = page
      .getByRole("main")
      .getByRole("status", { name: "State" })
      .getByText("Working");
    assert.equal(await working.count(), 0, "the record hasn't said it yet");
    const before = await sent.boundingBox();
    release();
    // The record says the message, then the agent at work: once that shows, the message is in it.
    await working.waitFor();
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
  "a message longer than a message's text may be isn't sent: the box keeps it as it is, the line says why, and the next send clears it",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    // Its words are counted once trimmed, as the chat counts them.
    const long = `  ${"a".repeat(100_001)}\n`;
    await input(page).fill(long);
    await input(page).evaluate((box: HTMLTextAreaElement) => box.setSelectionRange(7, 7));
    await input(page).press("Enter");
    await panel(page)
      .getByRole("alert")
      .getByText(
        "That's too long to send: a message can be at most 100,000 characters. This one has 100,001.",
      )
      .waitFor();
    assert.equal(gateway.calls.filter((c) => c.method === "send").length, 0, "nothing sent");
    assert.equal(await input(page).inputValue(), long);
    // The box is as tall as two fifths of the chat at most, scrolling inside, so the line is seen.
    const box = await input(page).boundingBox();
    assert.ok(box && box.height <= 900 * 0.4 + 1, `the box is ${box?.height} tall`);
    assert.equal(await panel(page).getByRole("alert").isVisible(), true);
    // One line, cut where the chat is narrow; pointing at it shows the whole of it.
    assert.equal(
      await panel(page).getByRole("alert").locator("span").first().getAttribute("title"),
      "That's too long to send: a message can be at most 100,000 characters. This one has 100,001.",
    );
    const line = await panel(page).getByRole("alert").boundingBox();
    assert.ok(
      line && line.y >= 0 && line.y + line.height <= (box?.y ?? 0),
      "the line is above the box, in view",
    );
    assert.deepEqual(
      await input(page).evaluate((box: HTMLTextAreaElement) => [
        box.selectionStart,
        box.selectionEnd,
      ]),
      [7, 7],
    );
    // Shortened and sent, the line goes.
    await input(page).fill("a".repeat(100_000));
    await input(page).press("Enter");
    await panel(page).getByRole("alert").waitFor({ state: "detached" });
    await until(() => gateway.calls.some((c) => c.method === "send"));
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
    // The agent works elsewhere: the newest thing said here is its reply, and nothing awaits one.
    gateway.setChatStatus("a-reviewer", { state: "working" });
    await input(page).fill("One more thing");
    await panel(page).getByRole("button", { name: "Send", exact: true }).click();
    await mine(page, "One more thing").waitFor();
    await nothingUnder(page, "One more thing");
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
    await panel(late).getByRole("alert").waitFor({ state: "detached" });
    // Recorded, it still awaits its reply while the agent works: the problem stays away.
    await until(() =>
      gateway.calls.some((c) => c.method === "send" && c.input.text === "Try again"),
    );
    await panel(late).locator(".whitespace-pre-wrap", { hasText: "Try again" }).waitFor();
    await late.waitForTimeout(400);
    assert.equal(await panel(late).getByRole("alert").count(), 0);
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
  "a message its work didn't answer says so, whatever the agent then does elsewhere",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await input(page).fill("Is the branch pushed?");
    await input(page).press("Enter");
    await mine(page, "Is the branch pushed?").waitFor();
    // Its turn ends without a reply.
    gateway.failChat("a-reviewer", { code: "not_answered", message: "Not answered" });
    const line = panel(page).getByRole("alert");
    await line.getByText("Not answered").waitFor();
    // The agent works again, on something else: this conversation still says its message wasn't answered.
    gateway.setChatStatus("a-reviewer", { state: "working" });
    await page
      .getByRole("main")
      .getByRole("status", { name: "State" })
      .getByText("Working")
      .waitFor();
    await page.waitForTimeout(300);
    await line.getByText("Not answered").waitFor();
    await page.close();
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
