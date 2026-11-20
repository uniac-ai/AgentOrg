// A computer's files window (`files@1`): what changed lately, marked and listed, and the workspace walked
// for it one walk at a time. Over the stand-in's `/live`.
import assert from "node:assert/strict";
import test from "node:test";
import { withBrowser } from "./build-kit.ts";
import {
  files,
  marked,
  nextRead,
  open,
  openOnClock,
  until,
  up,
  walks,
  where,
  which,
  withGateway,
} from "./files-kit.ts";

withBrowser();

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
