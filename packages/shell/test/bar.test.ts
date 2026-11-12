// The shell's one bar, and what a window or a place says when something pressed in it is refused.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";
import { computer } from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;

async function open(gateway: Gateway, hash = "#/", width = 1440): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/${hash}`);
  return page;
}
const withGateway = (run: (gateway: Gateway) => Promise<void>) => async () => {
  const gateway = await standIn();
  try {
    await run(gateway);
  } finally {
    await gateway.close();
  }
};
const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  assert.ok(box);
  return box;
};
/** What is under the middle of a part: the part, or what lies over it. */
const pressable = (locator: Locator) =>
  locator.evaluate((e) => {
    const b = e.getBoundingClientRect();
    return e.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2));
  });
const bar = (page: Page) =>
  page.getByRole("status").filter({ hasText: /ChatGPT plan|Reconnecting/ });

test(
  "the plan's notice is the bar at the foot of the page beside the left bar; beside an open chat it ends short of it, its link and close whole",
  withGateway(async (gateway) => {
    for (const width of [1440, 1024, 820]) {
      const page = await open(gateway, "#/", width);
      const notice = bar(page);
      await notice.getByText("You're using your ChatGPT plan").waitFor();
      const left = await boxOf(page.getByRole("navigation", { name: "Main" }));
      const box = await boxOf(notice);
      assert.equal(box.x, left.x + left.width + 20, `${width}: an inset from the left bar`);
      assert.equal(box.y + box.height, 900 - 20, `${width}: an inset from the foot`);
      assert.equal(
        await notice.getByRole("link", { name: "Manage usage" }).getAttribute("href"),
        "https://chatgpt.com/settings/usage",
      );
      // With a chat open, the bar ends one gap short of the panel, and nothing of it is under it.
      await page.getByRole("button", { name: /^Chats/ }).click();
      const panel = await boxOf(page.getByRole("complementary", { name: "Chats" }));
      const beside = await boxOf(notice);
      assert.ok(
        beside.x + beside.width <= panel.x - 12 + 0.5,
        `${width}: ends at ${beside.x + beside.width}, the panel starts at ${panel.x}`,
      );
      for (const part of [
        notice.getByRole("link", { name: "Manage usage" }),
        notice.getByRole("button", { name: "Dismiss" }),
      ])
        assert.ok(await pressable(part), `${width}: ${await part.innerText()} can be pressed`);
      await notice.getByRole("button", { name: "Dismiss" }).click();
      await notice.waitFor({ state: "detached" });
      await page.close();
      // It is shown once: shown again on the next page only as if it never was.
      gateway.notes.delete("ui/plan-notice");
    }
  }),
);

test(
  "while the shell is reconnecting the same bar says so, and it goes once it is connected",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const notice = bar(page);
    await notice.getByRole("button", { name: "Dismiss" }).click();
    await notice.waitFor({ state: "detached" });
    gateway.goAway();
    await notice.getByText("Reconnecting…", { exact: true }).waitFor();
    const left = await boxOf(page.getByRole("navigation", { name: "Main" }));
    const box = await boxOf(notice);
    assert.equal(box.x, left.x + left.width + 20);
    assert.equal(box.y + box.height, 900 - 20);
    assert.equal(await notice.getByRole("link").count(), 0, "nothing to press in it");
    gateway.goAway(false);
    await notice.waitFor({ state: "detached", timeout: 15_000 });
    await page.close();
  }),
);

test(
  "a Start refused in a stopped agent's computer is one red line at that window's foot, gone when Start is pressed again",
  withGateway(async (gateway) => {
    computer(gateway, [{ surface: "files", protocol: "files@1", operate: true }]);
    const research = gateway.agents.get("a-research");
    assert.ok(research);
    research.status = { state: "stopped" };
    const page = await open(gateway, "#/a/a-research");
    const frame = page.getByRole("main").getByRole("region", { name: "Research's computer" });
    await frame.getByText("Research is stopped").waitFor();
    gateway.refuseNext("agents.start", "unavailable", "Its provider isn't connected.");
    await frame.getByRole("button", { name: "Start" }).click();
    const line = frame.getByRole("alert");
    await line.getByText("It couldn't be started: its provider isn't connected.").waitFor();
    const [window, said] = [
      await boxOf(frame.getByText("Research is stopped").locator("xpath=../..")),
      await boxOf(line),
    ];
    assert.equal(said.y + said.height, window.y + window.height - 8, "at the window's foot");
    // The page's own line says only how it stands.
    const state = page.getByRole("main").getByRole("status", { name: "State" });
    assert.equal((await state.innerText()).trim().split("\n")[0], "Stopped");
    // Pressed again, the line goes at once, and Start can't be pressed while it is asked.
    const holding = gateway.hold("agents.start");
    await frame.getByRole("button", { name: "Start" }).click();
    await line.waitFor({ state: "detached" });
    assert.equal(await frame.getByRole("button", { name: "Start" }).isDisabled(), true);
    gateway.refuseNext("agents.start", "unavailable", "Its provider isn't connected.");
    holding();
    await line.waitFor();
    // Started some other way, and stopped again: nothing is said until Start is pressed here.
    research.status = { state: "running" };
    gateway.agents.set("a-research", research);
    await frame.getByText("Research is stopped").waitFor({ state: "detached", timeout: 15_000 });
    research.status = { state: "stopped" };
    await frame.getByText("Research is stopped").waitFor({ timeout: 15_000 });
    assert.equal(await line.count(), 0);
    await page.close();
  }),
);

test(
  "a file refused in Files is one red line at the window's foot: taken out, changed on the way, or brought in",
  withGateway(async (gateway) => {
    computer(gateway, [{ surface: "files", protocol: "files@1", operate: true }]);
    gateway.putFile("notes.txt", "Remember the milk.", 3);
    gateway.putFile("big.bin", Buffer.alloc(2_600_000, "0123456789abcdef"), 3);
    const page = await open(gateway, "#/a/a-research");
    const frame = page.getByRole("main").getByRole("region", { name: "Research's computer" });
    await frame
      .getByRole("navigation", { name: "Dock" })
      .getByRole("button", { name: "Files" })
      .click();
    const files = frame.getByRole("group", { name: "Files" });
    const line = files.getByRole("alert");
    // Gone by the time it is taken out.
    await files.getByRole("button", { name: /notes\.txt/ }).click();
    await files.getByText("Remember the milk.").waitFor();
    gateway.live.files.held.delete("notes.txt");
    await files.getByRole("button", { name: "Download" }).click();
    await line
      .getByText(/^notes\.txt wasn't taken out: there's no file at notes\.txt\.$/)
      .waitFor();
    const [window, said] = [await boxOf(files), await boxOf(line)];
    assert.equal(said.y + said.height, window.y + window.height - 8, "at the window's foot");
    // Changed between two of its parts.
    await files.getByRole("button", { name: "Up", exact: true }).click();
    await files.getByRole("button", { name: /big\.bin/ }).click();
    gateway.live.files.reads = "held";
    await files.getByRole("button", { name: "Download" }).click();
    await line.waitFor({ state: "detached" });
    for (let tries = 0; gateway.live.files.parts.length === 0; tries++) {
      assert.ok(tries < 100, "its first part is asked for");
      await page.waitForTimeout(50);
    }
    gateway.endReads();
    gateway.putFile("big.bin", Buffer.alloc(2_600_000, "fedcba9876543210"), 0);
    await line.getByText("big.bin wasn't taken out: it changed on the way.").waitFor();
    // Brought in, and refused.
    await files.getByRole("button", { name: "Up", exact: true }).click();
    gateway.live.files.writes = "There's no room for it.";
    await files
      .getByLabel("Files to upload")
      .setInputFiles([
        { name: "todo.txt", mimeType: "text/plain", buffer: Buffer.from("Call the bank.") },
      ]);
    await line.getByText("todo.txt wasn't brought in: there's no room for it.").waitFor();
    await page.close();
  }),
);

test(
  "a sign-in that didn't start is said in Home's place, in red, until the way in is pressed again",
  withGateway(async (gateway) => {
    gateway.setAccount("signed_out");
    const page = await open(gateway);
    const place = page.getByRole("main").getByRole("region", { name: "Set up" });
    const words = place.getByText("Your agents can't work until you do.", { exact: false });
    await words.waitFor();
    const before = await boxOf(place);
    gateway.refuseNext("login.start", "unavailable", "Not answering.");
    await place.getByRole("button", { name: "Continue with ChatGPT" }).click();
    const said = place.getByRole("alert");
    await said
      .getByText("ChatGPT's page couldn't be opened. Try again.", { exact: true })
      .waitFor();
    assert.equal(await words.isVisible(), false, "in the words' place");
    assert.deepEqual(await boxOf(place), before, "nothing moves");
    const popup = page.context().waitForEvent("page");
    await place.getByRole("button", { name: "Continue with ChatGPT" }).click();
    await popup;
    await said.waitFor({ state: "detached" });
    await page.close();
  }),
);

test("a refusal's words end a sentence: a word that only starts one is lower case, and a name keeps its capital", async () => {
  const { clause } = await import("../src/fixed/words.ts");
  assert.equal(clause("Its provider isn't connected."), "its provider isn't connected.");
  assert.equal(clause("There's no file at notes.txt."), "there's no file at notes.txt.");
  assert.equal(clause("A service isn't answering"), "a service isn't answering.");
  assert.equal(clause("Report.pdf is open elsewhere."), "Report.pdf is open elsewhere.");
  assert.equal(clause("OpenAI said no!"), "OpenAI said no.");
});
