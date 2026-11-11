// A computer's files window (`files@1`): its folders, a file's words, bringing one in and taking
// one out. Over the stand-in's `/live`.
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
    assert.equal(await where(page), "");
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
    assert.equal(await where(page), "storefront");
    await files(page).getByRole("button", { name: "src" }).click();
    await files(page).getByRole("button", { name: "checkout" }).click();
    await files(page)
      .getByRole("button", { name: /form\.ts/ })
      .waitFor();
    assert.equal(await where(page), "storefront/src/checkout");
    await up(page).click();
    await up(page).click();
    await files(page)
      .getByRole("button", { name: /README\.md/ })
      .waitFor();
    assert.equal(await where(page), "storefront");
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
    assert.equal(await where(page), "notes.txt");
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
