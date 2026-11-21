// The frame around the pages, wide and on a phone, in a real browser over the stand-in gateway:
// the bar of places, where the app opens, and where an agent's address leads.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";
import { noted } from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;
const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function open(gateway: Gateway, viewport: typeof WIDE, hash = "#/"): Promise<Page> {
  const page = await browser.newPage({ viewport });
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
/** Nothing runs off the side of the page. */
const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** A part's box as [x, y, width, height]. */
const boxOf = async (part: Locator) => {
  const box = await part.boundingBox();
  assert.ok(box, `${part} is on the page`);
  return [box.x, box.y, box.width, box.height] as [number, number, number, number];
};
const bar = (page: Page) => page.getByRole("navigation", { name: "Main" });
const place = (page: Page, name: string | RegExp) =>
  bar(page).getByRole("button", { name, exact: typeof name === "string" });
/** The label a place shows beside it. */
const label = (page: Page) => page.locator('[data-slot="tooltip-content"]');
const reply = (id: string, text: string) => ({
  id,
  role: "assistant" as const,
  text,
  at: new Date().toISOString(),
});

test(
  "the bar runs the page's height, 62 wide with no line at its edge: Search, Chat and Team in its middle, Settings at its foot, and no words, agents, search box or Create",
  withGateway(async (gateway) => {
    const page = await open(gateway, WIDE);
    await page.getByRole("main").getByRole("list", { name: "Chats" }).waitFor();
    assert.deepEqual(await boxOf(bar(page)), [0, 0, 62, 900]);
    assert.deepEqual(
      await bar(page).evaluate((nav) => {
        const style = getComputedStyle(nav);
        return [style.borderRightWidth, style.borderTopWidth];
      }),
      ["0px", "0px"],
    );
    // Four places, each an icon of 22 in a place of 44, with 9 at each side: the first three 10
    // apart, centred on the bar's height.
    assert.deepEqual(
      await bar(page)
        .getByRole("button")
        .evaluateAll((places) => places.map((one) => one.getAttribute("aria-label"))),
      ["Search", "Chat", "Team", "Settings"],
    );
    assert.deepEqual(await boxOf(place(page, "Search")), [9, 374, 44, 44]);
    assert.deepEqual(await boxOf(place(page, "Chat")), [9, 428, 44, 44]);
    assert.deepEqual(await boxOf(place(page, "Team")), [9, 482, 44, 44]);
    assert.deepEqual(await boxOf(place(page, "Settings")), [9, 844, 44, 44]);
    for (const name of ["Search", "Chat", "Team", "Settings"]) {
      const [x, y, width, height] = await boxOf(place(page, name).locator("svg"));
      const [px, py] = await boxOf(place(page, name));
      assert.deepEqual([width, height], [22, 22], name);
      assert.deepEqual([x - px, y - py], [11, 11], `${name}'s icon in the middle of its place`);
    }
    assert.equal(await bar(page).innerText(), "", "no words");
    assert.equal(await bar(page).getByRole("list").count(), 0, "no agents");
    assert.equal(await bar(page).getByRole("searchbox").count(), 0, "no search box");
    assert.equal(await bar(page).getByRole("button", { name: "Create" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Home" }).count(), 0, "no Home");
    // The page is everything beside the bar, inside the card: 6 in from the bar and the window's
    // edges, less the card's line.
    const main = page.locator("main");
    assert.deepEqual(await boxOf(main), [69, 7, 1364, 886]);
    assert.deepEqual(
      await main.evaluate((e) => {
        const style = getComputedStyle(e);
        return [style.backgroundColor, style.borderTopLeftRadius];
      }),
      ["rgba(0, 0, 0, 0)", "0px"],
    );
    await page.close();
  }),
);

test(
  "each place leads where it says and is marked while you are in it; Settings opens over the place, which stays marked",
  withGateway(async (gateway) => {
    const page = await open(gateway, WIDE);
    const main = page.getByRole("main");
    // Read with the pointer away, since a place under it has the hover's background; and by the
    // bar's markup, which an open window puts out of reach but leaves there.
    const current = async () => {
      await page.mouse.move(700, 450);
      return page
        .locator('nav[aria-label="Main"] [aria-current="page"]')
        .evaluateAll((places) =>
          places.map((one) => [
            one.getAttribute("aria-label"),
            getComputedStyle(one).backgroundColor,
          ]),
        );
    };
    await main.getByRole("list", { name: "Chats" }).waitFor();
    assert.deepEqual(await current(), [["Chat", "rgba(255, 255, 255, 0.08)"]]);
    const still = await boxOf(bar(page));
    await place(page, "Team").click();
    await page.waitForURL(/#\/team$/);
    await main.getByRole("region", { name: "Team" }).waitFor();
    assert.deepEqual(await current(), [["Team", "rgba(255, 255, 255, 0.08)"]]);
    await place(page, "Settings").click();
    await page.getByRole("dialog", { name: "Settings" }).waitFor();
    assert.deepEqual(await current(), [["Team", "rgba(255, 255, 255, 0.08)"]]);
    assert.match(page.url(), /#\/team$/, "the address is the place's");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Settings" }).waitFor({ state: "detached" });
    await place(page, "Chat").click();
    await page.waitForURL(/#\/chat$/);
    await main.getByRole("list", { name: "Chats" }).waitFor();
    assert.deepEqual(
      (await current()).map(([name]) => name),
      ["Chat"],
    );
    assert.deepEqual(await boxOf(bar(page)), still, "the bar doesn't move between places");
    // A place not current is plain until the pointer is on it.
    assert.equal(
      await place(page, "Team").evaluate((one) => getComputedStyle(one).backgroundColor),
      "rgba(0, 0, 0, 0)",
    );
    await page.close();
  }),
);

test(
  "a place's label shows beside it while the pointer rests on it or the keyboard is on it, fading in and out",
  withGateway(async (gateway) => {
    const page = await open(gateway, WIDE);
    await place(page, "Team").waitFor();
    assert.equal(await label(page).count(), 0, "no label at first");
    await place(page, "Team").hover();
    await label(page).waitFor();
    assert.equal(await label(page).innerText(), "Team");
    const animation = () => label(page).evaluate((one) => getComputedStyle(one).animationName);
    assert.equal(await animation(), "enter", "it fades in");
    // Once it has come in: beside its place, past its arrow, on the place's middle.
    await label(page).evaluate((one) =>
      Promise.all(one.getAnimations().map((moving) => moving.finished)),
    );
    const [x, y, , height] = await boxOf(label(page));
    assert.equal(Math.round(x * 10) / 10, 69);
    assert.ok(Math.abs(y + height / 2 - 504) < 1, "on the place's middle");
    // Away from it: the pointer leaves the place and goes on, as a hand moves it.
    await page.mouse.move(700, 450, { steps: 4 });
    await page.locator('[data-slot="tooltip-content"][data-state="closed"]').waitFor();
    assert.equal(await animation(), "exit", "it fades out");
    await label(page).waitFor({ state: "detached" });

    // From the keyboard: the place it is on shows its label, and only that one.
    await place(page, "Chat").focus();
    await label(page).getByText("Chat").waitFor();
    await page.keyboard.press("Tab");
    await label(page).filter({ hasText: "Team" }).waitFor();
    await label(page).filter({ hasText: "Chat" }).waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    await label(page).waitFor({ state: "detached" });
    await page.close();
  }),
);

test(
  "the Chat icon carries the count of conversations with something new, as the floating chat's button does",
  withGateway(async (gateway) => {
    const page = await open(gateway, WIDE, "#/team");
    const pill = page.getByRole("group", { name: "Chats, collapsed" });
    await pill.getByRole("button", { name: "Chats", exact: true }).waitFor();
    await noted(gateway);
    assert.equal(await place(page, "Chat").innerText(), "", "nothing new, no count");
    gateway.addMessage("a-reviewer", reply("r9", "All clear on #482."));
    await pill.getByRole("button", { name: "Chats, 1 new" }).waitFor();
    await place(page, "Chat, 1 new").waitFor();
    assert.equal(await place(page, "Chat, 1 new").innerText(), "1");
    gateway.addMessage("a-research", reply("s9", "Found it."));
    await pill.getByRole("button", { name: "Chats, 2 new" }).waitFor();
    assert.equal(await place(page, "Chat, 2 new").innerText(), "2");
    // The chat page opens on the newest, which is read there; then the other is read too.
    await place(page, "Chat, 2 new").click();
    const main = page.getByRole("main");
    await main
      .getByRole("region", { name: "Conversation with Research" })
      .getByText("Found it.")
      .waitFor();
    await place(page, "Chat, 1 new").waitFor();
    await main.getByRole("list", { name: "Chats" }).getByText("All clear on #482.").click();
    await main
      .getByRole("region", { name: "Conversation with Reviewer" })
      .getByText("All clear on #482.")
      .waitFor();
    await place(page, "Chat").waitFor();
    assert.equal(await place(page, "Chat").innerText(), "");
    await page.close();
  }),
);

test(
  "the app opens on Chat, and so does an address that names nothing",
  withGateway(async (gateway) => {
    for (const hash of ["", "#/", "#/nothing/here"]) {
      const page = await open(gateway, WIDE, hash);
      await page.getByRole("main").getByRole("list", { name: "Chats" }).waitFor();
      assert.equal(await place(page, "Chat").getAttribute("aria-current"), "page", hash);
      await page.close();
    }
  }),
);

test(
  "an agent's own address and its tabs show its details in Team",
  withGateway(async (gateway) => {
    const page = await open(gateway, WIDE, "#/a/a-reviewer");
    const main = page.getByRole("main");
    await main.getByRole("heading", { name: "Reviewer", level: 1 }).waitFor();
    await main.getByRole("region", { name: "Team" }).waitFor();
    assert.equal(await place(page, "Team").getAttribute("aria-current"), "page");
    assert.equal(
      await main
        .getByRole("list", { name: "Agents" })
        .getByRole("button", { name: /Reviewer/ })
        .getAttribute("aria-current"),
      "true",
    );
    await page.goto(`${gateway.url}/#/a/a-research/chats`);
    await main.getByRole("heading", { name: "Research", level: 1 }).waitFor();
    await main.getByRole("tab", { name: "Chats", selected: true }).waitFor();
    await main.getByRole("region", { name: "Team" }).waitFor();
    // Its tabs are Team's from there on.
    await main.getByRole("tab", { name: "Overview" }).click();
    await page.waitForURL(/#\/team\/a-research\/overview$/);
    await page.close();
  }),
);

test(
  "on a phone the places sit in a row along the foot under a 1 px line, with their labels, the current one in full colour, and the floating chat's button above them",
  withGateway(async (gateway) => {
    const page = await open(gateway, PHONE, "#/team");
    const main = page.getByRole("main");
    await main.getByRole("region", { name: "Team" }).waitFor();
    assert.deepEqual(await boxOf(bar(page)), [0, 788, 390, 56]);
    assert.deepEqual(
      await bar(page).evaluate((nav) => {
        const style = getComputedStyle(nav);
        return [style.borderTopWidth, style.borderTopColor, style.borderRightWidth];
      }),
      ["1px", "rgba(255, 255, 255, 0.08)", "0px"],
    );
    // Under the bar's 1 px line along its top.
    assert.deepEqual(await boxOf(place(page, "Search")), [0, 789, 97.5, 55]);
    assert.deepEqual(await boxOf(place(page, "Chat")), [97.5, 789, 97.5, 55]);
    assert.deepEqual(await boxOf(place(page, "Team")), [195, 789, 97.5, 55]);
    assert.deepEqual(await boxOf(place(page, "Settings")), [292.5, 789, 97.5, 55]);
    // Each label is under its icon.
    for (const name of ["Search", "Chat", "Team", "Settings"]) {
      assert.equal(await place(page, name).innerText(), name);
      const icon = await boxOf(place(page, name).locator("svg"));
      const words = await boxOf(place(page, name).getByText(name, { exact: true }));
      assert.ok(words[1] >= icon[1] + icon[3], `${name}'s label under its icon`);
      assert.equal(
        await place(page, name)
          .getByText(name)
          .evaluate((e) => getComputedStyle(e).fontSize),
        "10px",
      );
    }
    const colours = await bar(page)
      .getByRole("button")
      .evaluateAll((places) =>
        places.map((one) => [
          one.getAttribute("aria-label"),
          getComputedStyle(one).color,
          getComputedStyle(one).backgroundColor,
        ]),
      );
    assert.deepEqual(colours, [
      ["Search", "rgb(161, 161, 161)", "rgba(0, 0, 0, 0)"],
      ["Chat", "rgb(161, 161, 161)", "rgba(0, 0, 0, 0)"],
      ["Team", "rgb(250, 250, 250)", "rgba(0, 0, 0, 0)"],
      ["Settings", "rgb(161, 161, 161)", "rgba(0, 0, 0, 0)"],
    ]);
    // No menu button and no head: the page has the room above the row, to the window's edges.
    assert.equal(await page.getByRole("button", { name: "Menu" }).count(), 0);
    assert.equal(await page.getByRole("banner").filter({ visible: true }).count(), 0);
    assert.deepEqual(await boxOf(page.locator("main")), [0, 0, 390, 788]);
    // The floating chat's button sits above the row.
    const pill = await boxOf(page.getByRole("group", { name: "Chats, collapsed" }));
    assert.equal(pill[1] + pill[3], 788 - 20);
    // A label doesn't show beside a place here: it is under it already.
    await place(page, "Settings").hover();
    await page.waitForTimeout(300);
    assert.equal(await label(page).filter({ visible: true }).count(), 0);
    assert.equal(await fits(page), true);
    await page.close();
  }),
);

test(
  "the page's card is rgb(25, 25, 25) in dark and rgb(243, 243, 243) in light, on a ground a step darker",
  withGateway(async (gateway) => {
    const page = await open(gateway, WIDE);
    await bar(page).waitFor();
    /** The ground under the bar and around the card, and the card. */
    const backgrounds = () =>
      page.evaluate(() =>
        [
          document.querySelector("[data-shell]") as Element,
          document.querySelector("main")?.parentElement as Element,
        ].map((one) => getComputedStyle(one).backgroundColor),
      );
    assert.deepEqual(await backgrounds(), ["rgb(17, 17, 17)", "rgb(25, 25, 25)"]);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    assert.deepEqual(await backgrounds(), ["rgb(232, 232, 232)", "rgb(243, 243, 243)"]);
    await page.close();
  }),
);

test(
  "at phone width nothing runs off the side, and Create and Settings still work",
  withGateway(async (gateway) => {
    const page = await open(gateway, PHONE);
    // Chat, with its conversations on it.
    await page
      .getByRole("main")
      .getByRole("list", { name: "Chats" })
      .getByRole("listitem")
      .first()
      .waitFor();
    assert.equal(await fits(page), true, "Chat");
    // Create is on Team.
    await place(page, "Team").click();
    await page.getByRole("main").getByRole("button", { name: "Create" }).click();
    const stack = page.getByRole("dialog", { name: "Create" });
    await stack.getByRole("button", { name: /^Assistant/ }).click();
    await stack.getByLabel("Name").fill("Foreman");
    await page.waitForTimeout(250);
    const box = await stack.boundingBox();
    assert.ok(box);
    assert.ok(box.x >= 0 && box.x + box.width <= PHONE.width, "the popup fits across");
    assert.ok(box.y >= 0 && box.y + box.height <= PHONE.height, "and down");
    await stack.getByRole("button", { name: "Create", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await stack.waitFor({ state: "detached" });
    // Settings takes the screen, and a section's action is whole on its top line.
    await place(page, "Settings").click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
    assert.deepEqual(await boxOf(settings), [0, 0, PHONE.width, PHONE.height]);
    await settings
      .getByRole("navigation", { name: "Settings" })
      .getByRole("button", { name: "Skills" })
      .click();
    const add = settings.getByRole("button", { name: "Add skill" });
    assert.equal((await add.innerText()).trim(), "Add skill");
    const action = await add.boundingBox();
    assert.ok(action && action.x + action.width <= PHONE.width, "what it offers is in view");
    assert.equal(await fits(page), true, "settings");
    await page.close();
  }),
);
