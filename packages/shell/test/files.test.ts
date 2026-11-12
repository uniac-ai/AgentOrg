// A computer's files window (`files@1`): its folders, a file's words, bringing one in and taking
// one out, and what changed lately. Over the stand-in's `/live`.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { computer } from "./design/samples.ts";
import { SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;
const withGateway =
  (run: (gateway: Gateway) => Promise<void>, operate = true) =>
  async () => {
    const gateway = await standIn();
    try {
      computer(gateway, [
        { surface: "browser", protocol: "screencast@1", operate },
        { surface: "terminal", protocol: "terminal@1", operate },
        { surface: "files", protocol: "files@1", operate },
      ]);
      gateway.putFile("notes.txt", "Remember the milk.", 3);
      gateway.putFile("storefront/README.md", "# Storefront\n\nThe shop's web app.", 125);
      gateway.putFile("storefront/package.json", `{ "name": "storefront" }`, 60 * 30);
      gateway.putFile("storefront/src/checkout/form.ts", "export const form = 1;", 1);
      await run(gateway);
    } finally {
      await gateway.close();
    }
  };
/** Research's page with its files in front. */
async function open(gateway: Gateway): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/a/a-research`);
  await page
    .getByRole("navigation", { name: "Dock" })
    .getByRole("button", { name: "Files" })
    .click();
  await files(page).getByRole("list", { name: "Files" }).getByRole("button").first().waitFor();
  return page;
}
const files = (page: Page) => page.getByRole("main").getByRole("group", { name: "Files" });
/** The rows shown, each as its words in order. */
const rows = async (page: Page) =>
  (await files(page).getByRole("list", { name: "Files" }).getByRole("button").allInnerTexts()).map(
    (row) =>
      row
        .split("\n")
        .filter((word) => word.trim())
        .join(" | "),
  );
const where = (page: Page) => files(page).getByRole("group", { name: "Folder" }).innerText();
/** Whether a row, by its name, is marked as changed lately. */
const marked = async (page: Page, name: string | RegExp) => {
  const row = files(page)
    .getByRole("button")
    .filter({ has: page.getByText(name, { exact: true }) });
  assert.equal(await row.count(), 1, `one row named ${name}`);
  return (await row.getByRole("img", { name: "Changed" }).count()) > 0;
};
/** Waits, for no longer than a test's own waits, until something outside the page is so. */
async function until(so: () => boolean, what: string) {
  for (const end = Date.now() + 8000; !so(); ) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}
/** Research's page with its files in front, on a clock the test moves. */
async function openOnClock(gateway: Gateway): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.clock.install();
  await page.addInitScript((s) => localStorage.setItem("agentorg.session", s), SESSION);
  await page.goto(`${gateway.url}/#/a/a-research`);
  await page
    .getByRole("navigation", { name: "Dock" })
    .getByRole("button", { name: "Files" })
    .click();
  await files(page)
    .getByRole("button", { name: /notes\.txt/ })
    .waitFor();
  return page;
}
/** How often a folder was read. */
const lists = (gateway: Gateway) =>
  gateway.live.files.asked.filter((one) => one.type === "list").length;
/** The folder is read once more, as it is every so often. */
async function nextRead(page: Page, gateway: Gateway) {
  const before = lists(gateway);
  await page.clock.fastForward(5000);
  await until(() => lists(gateway) > before, "the folder to be read again");
}
const which = (page: Page, name: string | RegExp) =>
  files(page).getByRole("tablist", { name: "Which files" }).getByRole("tab", { name });
/** What was asked of the surface about what changed, each with the time it was asked from. */
const walks = (gateway: Gateway) =>
  gateway.live.files.asked.filter((one) => one.type === "changed").map((one) => String(one.since));
const up = (page: Page) => files(page).getByRole("button", { name: "Up", exact: true });

test(
  "Files is the third window: a folder's entries, folders first, walked into and back up",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const dock = page.getByRole("navigation", { name: "Dock" }).getByRole("button");
    assert.deepEqual(
      await dock.evaluateAll((all) => all.map((b) => b.getAttribute("aria-label"))),
      ["Browser", "Terminal", "Files"],
    );
    // A folder has its name alone; a file its size and how long ago it changed.
    assert.deepEqual(await rows(page), ["storefront", "notes.txt | 18 B | 3 min"]);
    assert.equal(await where(page), "Research");
    assert.equal(await up(page).isDisabled(), true);
    await files(page).getByRole("button", { name: "storefront" }).click();
    await files(page)
      .getByRole("button", { name: /README\.md/ })
      .waitFor();
    assert.deepEqual(await rows(page), [
      "src",
      "package.json | 24 B | 1 d",
      "README.md | 33 B | 2 h",
    ]);
    assert.equal(await where(page), "Research/storefront");
    await files(page).getByRole("button", { name: "src" }).click();
    await files(page).getByRole("button", { name: "checkout" }).click();
    await files(page)
      .getByRole("button", { name: /form\.ts/ })
      .waitFor();
    assert.equal(await where(page), "Research/storefront/src/checkout");
    await up(page).click();
    await up(page).click();
    await files(page)
      .getByRole("button", { name: /README\.md/ })
      .waitFor();
    assert.equal(await where(page), "Research/storefront");
    // What appears there while it is shown is listed without asking.
    gateway.putFile("storefront/CHANGELOG.md", "# Changes");
    await files(page)
      .getByRole("button", { name: /CHANGELOG\.md/ })
      .waitFor();
    await up(page).click();
    await files(page)
      .getByRole("button", { name: /notes\.txt/ })
      .waitFor();
    assert.equal(await up(page).isDisabled(), true);
    await page.close();
  }),
);

test(
  "a file opens to its words, and Download hands the whole of it over however large; what isn't text has no words",
  withGateway(async (gateway) => {
    // Its first part ends inside a letter of two bytes.
    const big = Buffer.concat([
      Buffer.alloc(1_048_575, "abcdefghij"),
      Buffer.from("é".repeat(700_000)),
    ]);
    gateway.putFile("big.txt", big);
    gateway.putFile("picture.bin", Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]));
    const page = await open(gateway);
    await files(page)
      .getByRole("button", { name: /notes\.txt/ })
      .click();
    const words = files(page).locator("pre");
    await words.getByText("Remember the milk.").waitFor();
    assert.equal(await where(page), "Research/notes.txt");
    // Open, it has Download where Upload was, and Up closes it.
    assert.equal(await files(page).getByRole("button", { name: "Upload" }).count(), 0);
    const saved = page.waitForEvent("download");
    await files(page).getByRole("button", { name: "Download" }).click();
    const small = await saved;
    assert.equal(small.suggestedFilename(), "notes.txt");
    assert.equal(await readFile(await small.path(), "utf8"), "Remember the milk.");
    await up(page).click();
    await files(page)
      .getByRole("button", { name: /big\.txt/ })
      .click();
    await words.getByText("abcdefghij").first().waitFor();
    const again = page.waitForEvent("download");
    await files(page).getByRole("button", { name: "Download" }).click();
    assert.ok((await readFile(await (await again).path())).equals(big), "every byte, in order");
    // A file that is gone by the time it is asked for is not handed over empty.
    await up(page).click();
    await files(page)
      .getByRole("button", { name: /notes\.txt/ })
      .click();
    await words.getByText("Remember the milk.").waitFor();
    gateway.live.files.held.delete("notes.txt");
    let handed = false;
    page.once("download", () => {
      handed = true;
    });
    await files(page).getByRole("button", { name: "Download" }).click();
    await page.waitForTimeout(400);
    assert.equal(handed, false);
    await up(page).click();
    await files(page)
      .getByRole("button", { name: /picture\.bin/ })
      .click();
    // Once it has been read: what it holds is not text, so there are no words.
    const read = () =>
      gateway.live.files.asked.some((one) => one.type === "read" && one.path === "picture.bin");
    while (!read()) await page.waitForTimeout(20);
    await page.waitForTimeout(100);
    assert.equal(await words.innerText(), "");
    await page.close();
  }),
);

test(
  "Upload puts the files chosen in the folder shown, a part at a time, and lists them",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await files(page).getByRole("button", { name: "storefront" }).click();
    await files(page)
      .getByRole("button", { name: /README\.md/ })
      .waitFor();
    const large = Buffer.alloc(1_600_000, "0123456789");
    await files(page)
      .getByLabel("Files to upload")
      .setInputFiles([
        { name: "data.csv", mimeType: "text/csv", buffer: large },
        { name: "todo.txt", mimeType: "text/plain", buffer: Buffer.from("Ship it.") },
      ]);
    // They are listed as soon as they are there, not when the folder is next read.
    await files(page)
      .getByRole("button", { name: /todo\.txt/ })
      .waitFor({ timeout: 2500 });
    await files(page)
      .getByRole("button", { name: /data\.csv/ })
      .waitFor();
    const { held, asked } = gateway.live.files;
    assert.ok(held.get("storefront/data.csv")?.bytes.equals(large), "whole, in order");
    assert.equal(String(held.get("storefront/todo.txt")?.bytes), "Ship it.");
    assert.deepEqual(
      asked
        .filter((one) => one.type === "write")
        .map((one) => [one.path, one.offset, one.length, one.last]),
      [
        ["storefront/data.csv", 0, 1_048_576, false],
        ["storefront/data.csv", 1_048_576, 1_600_000 - 1_048_576, true],
        ["storefront/todo.txt", 0, 8, true],
      ],
    );
    await page.close();
  }),
);

test(
  "files you may only watch are opened to watch, and nothing can be brought in",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    assert.equal(await files(page).getByRole("button", { name: "Upload" }).isDisabled(), true);
    assert.deepEqual(
      gateway.live.opened.filter((o) => o.surface === "files").map((o) => o.mode),
      ["watch"],
    );
    await page.close();
  }, false),
);

test(
  "a files view that closes is opened again, and a file opened meanwhile is read once it is",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    const sockets = () => gateway.live.opened.filter((o) => o.surface === "files").length;
    assert.equal(sockets(), 1);
    for (const socket of gateway.live.files.sockets) socket.close(1001);
    for (const end = Date.now() + 9000; sockets() < 2 && Date.now() < end; )
      await page.waitForTimeout(50);
    assert.equal(sockets(), 2, "opened again");
    await files(page)
      .getByRole("button", { name: /notes\.txt/ })
      .click();
    await files(page).locator("pre").getByText("Remember the milk.").waitFor();
    await page.close();
  }),
);

test(
  "what changed in the last 24 hours is marked, and so is a folder that holds one, counted from when the window opened",
  withGateway(async (gateway) => {
    gateway.putFile("storefront/old.txt", "Kept.", 24 * 60 + 5);
    gateway.putFile("storefront/recent.txt", "Kept.", 24 * 60 - 5);
    gateway.putFile("storefront/sr/old.txt", "Kept.", 60 * 24 * 7);
    const before = Date.now();
    const page = await open(gateway);
    const after = Date.now();
    // The workspace: a folder that holds a changed file, and a changed file.
    await which(page, /^Changed/)
      .getByText("4", { exact: true })
      .waitFor();
    assert.deepEqual(
      [await marked(page, "storefront"), await marked(page, /notes\.txt/)],
      [true, true],
    );
    await files(page).getByRole("button", { name: "storefront" }).click();
    await files(page)
      .getByRole("button", { name: /README\.md/ })
      .waitFor();
    // A day and five minutes isn't lately; five minutes short of a day is. A folder is marked
    // for what is in it, not for a name that starts as its does.
    assert.deepEqual(
      {
        src: await marked(page, "src"),
        sr: await marked(page, "sr"),
        readme: await marked(page, /README\.md/),
        package: await marked(page, /package\.json/),
        old: await marked(page, /old\.txt/),
        recent: await marked(page, /recent\.txt/),
      },
      { src: true, sr: false, readme: true, package: false, old: false, recent: true },
    );
    // It is asked from a day before the window opened, and from then again each time.
    const [first] = walks(gateway);
    assert.ok(first);
    const from = Date.parse(first) + 24 * 60 * 60 * 1000;
    assert.ok(before <= from && from <= after, "a day before it opened");
    // What changes while the window is open is marked without asking.
    gateway.putFile("storefront/package.json", `{ "name": "shop" }`);
    await files(page)
      .getByRole("button", { name: /package\.json/ })
      .getByRole("img", { name: "Changed" })
      .waitFor();
    assert.deepEqual([...new Set(walks(gateway))], [first], "from the same time");
    await page.close();
  }),
);

test(
  "Changed lists what changed lately by its path, in the order of their paths, with how many; a file opens from it and nothing is brought in there",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await files(page).getByRole("button", { name: "storefront" }).click();
    await files(page)
      .getByRole("button", { name: /README\.md/ })
      .waitFor();
    const changed = which(page, /^Changed/);
    await changed.getByText("3", { exact: true }).waitFor();
    assert.equal(await changed.getAttribute("aria-selected"), "false");
    await changed.click();
    assert.deepEqual(
      [
        await changed.getAttribute("aria-selected"),
        await which(page, "All").getAttribute("aria-selected"),
      ],
      ["true", "false"],
    );
    const list = files(page).getByRole("list", { name: "Changed files" });
    const listed = async () =>
      (await list.getByRole("button").allInnerTexts()).map((row) =>
        row
          .split("\n")
          .filter((word) => word.trim())
          .join(" | "),
      );
    assert.deepEqual(await listed(), [
      "notes.txt | 18 B | 3 min",
      "storefront/README.md | 33 B | 2 h",
      "storefront/src/checkout/form.ts | 22 B | 1 min",
    ]);
    assert.equal(await list.getByRole("img", { name: "Changed" }).count(), 3, "each is marked");
    assert.equal(
      await files(page).getByRole("list", { name: "Files", exact: true }).count(),
      0,
      "in place of the folder's rows",
    );
    // It is no folder: nowhere to go up to, and nowhere to bring a file in.
    assert.equal(await where(page), "Research");
    assert.equal(await up(page).isDisabled(), true);
    assert.equal(await files(page).getByRole("button", { name: "Upload" }).isDisabled(), true);

    // A file opens from it, and Up comes back to it.
    await list.getByRole("button", { name: /notes\.txt/ }).click();
    await files(page).locator("pre").getByText("Remember the milk.").waitFor();
    assert.equal(await where(page), "Research/notes.txt");
    await files(page).getByRole("button", { name: "Download" }).waitFor();
    await up(page).click();
    await list.getByRole("button").first().waitFor();
    assert.equal(await changed.getAttribute("aria-selected"), "true");

    // One that changes while it is shown joins the list, in its place, and is counted.
    gateway.putFile("storefront/CHANGELOG.md", "# Changes");
    await changed.getByText("4", { exact: true }).waitFor();
    assert.equal((await listed())[1], "storefront/CHANGELOG.md | 9 B | Now");

    // A file open under Changed closes when All is picked, which is where it was left.
    await list.getByRole("button", { name: /notes\.txt/ }).click();
    await files(page).locator("pre").getByText("Remember the milk.").waitFor();
    await which(page, "All").click();
    await files(page)
      .getByRole("button", { name: /README\.md/ })
      .waitFor();
    assert.equal(await where(page), "Research/storefront");
    assert.equal(await files(page).getByRole("button", { name: "Upload" }).isDisabled(), false);
    await page.close();
  }),
);

test(
  "the workspace is walked for what changed one walk at a time, however long a walk takes",
  withGateway(async (gateway) => {
    gateway.live.files.walks = "held";
    const page = await openOnClock(gateway);
    await until(() => walks(gateway).length === 1, "the first walk to be asked for");
    // Two more readings of the folder go by with the walk unanswered.
    await nextRead(page, gateway);
    await nextRead(page, gateway);
    assert.equal(walks(gateway).length, 1, "nothing more is asked while one is out");
    assert.equal(
      (await which(page, /^Changed/).innerText()).trim(),
      "Changed",
      "and no number is said before there is one",
    );
    // Answered at last, it is taken, and the next reading asks again.
    gateway.endWalks();
    await which(page, /^Changed/)
      .getByText("3", { exact: true })
      .waitFor();
    await nextRead(page, gateway);
    await until(() => walks(gateway).length === 2, "the next walk to be asked for");
    await page.close();
  }),
);

test(
  "a walk the surface refuses isn't asked for again by itself, and is when a file is brought in",
  withGateway(async (gateway) => {
    gateway.live.files.walks = "refused";
    const page = await openOnClock(gateway);
    await until(() => walks(gateway).length === 1, "the first walk to be asked for");
    await nextRead(page, gateway);
    await nextRead(page, gateway);
    assert.equal(walks(gateway).length, 1, "the folder is read again; the walk isn't asked for");
    assert.equal((await which(page, /^Changed/).innerText()).trim(), "Changed");
    assert.equal(await marked(page, "notes.txt"), false, "nothing is marked on a guess");

    // Something brought in asks again, and from then it is asked as often as the folder is read.
    gateway.live.files.walks = "answered";
    await files(page)
      .getByLabel("Files to upload")
      .setInputFiles([{ name: "todo.txt", mimeType: "text/plain", buffer: Buffer.from("x") }]);
    await which(page, /^Changed/)
      .getByText("4", { exact: true })
      .waitFor();
    assert.equal(walks(gateway).length, 2);
    await nextRead(page, gateway);
    await until(() => walks(gateway).length === 3, "a walk with the next reading");
    await page.close();
  }),
);

test(
  "a view that closes with a walk out asks again once it is open again",
  withGateway(async (gateway) => {
    gateway.live.files.walks = "held";
    const page = await openOnClock(gateway);
    await until(() => walks(gateway).length === 1, "the first walk to be asked for");
    for (const socket of gateway.live.files.sockets) socket.close(1001);
    gateway.live.files.walks = "answered";
    const sockets = () => gateway.live.opened.filter((o) => o.surface === "files").length;
    await page.clock.fastForward(5000);
    await until(() => sockets() === 2, "the view to be opened again");
    await which(page, /^Changed/)
      .getByText("3", { exact: true })
      .waitFor();
    assert.equal(walks(gateway).length, 2, "asked of the new one, once");
    await page.close();
  }),
);

test(
  "the folder's field starts with the workspace's own name where the surface says it, and is the path alone where it doesn't",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    assert.equal(await where(page), "Research", "at the top it is the name alone");
    await files(page).getByRole("button", { name: "storefront" }).click();
    await files(page)
      .getByRole("button", { name: /README\.md/ })
      .waitFor();
    assert.equal(await where(page), "Research/storefront");
    await files(page)
      .getByRole("button", { name: /README\.md/ })
      .click();
    await files(page).locator("pre").getByText("Storefront").waitFor();
    assert.equal(await where(page), "Research/storefront/README.md");
    await page.close();

    // An older service says no name, and the top of a disk has none: the path alone.
    for (const none of [undefined, ""]) {
      gateway.live.files.workspace = none;
      const older = await open(gateway);
      assert.equal(await where(older), "");
      await files(older).getByRole("button", { name: "storefront" }).click();
      await files(older)
        .getByRole("button", { name: /README\.md/ })
        .waitFor();
      assert.equal(await where(older), "storefront");
      await older.close();
    }
  }),
);
