// The live browser (`screencast@1`) and the control log, over the stand-in.
import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { type Agent, SESSION, standIn } from "./stand-in.ts";

let browser: Browser;
test.before(async () => {
  browser = await chromium.launch();
});
test.after(() => browser.close());

type Gateway = Awaited<ReturnType<typeof standIn>>;
type Surface = { surface: string; protocol: string; operate: boolean; unavailable?: string };
const BROWSER: Surface = { surface: "browser", protocol: "screencast@1", operate: true };

function withSurfaces(gateway: Gateway, surfaces: Surface[]) {
  const research = gateway.agents.get("a-research") as Agent;
  research.units = [
    {
      instance: "i-computer",
      provider: "units",
      unit: "computer",
      title: "Computer",
      values: {},
      needs: {},
      status: { state: "connected", surfaces },
    },
  ];
}
async function open(gateway: Gateway, viewport = { width: 1440, height: 900 }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(8000);
  await page.addInitScript((session) => localStorage.setItem("agentorg.session", session), SESSION);
  await page.goto(`${gateway.url}/#/a/a-research`);
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
const until = async (check: () => boolean, what: string) => {
  for (let n = 0; n < 80 && !check(); n++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(check(), what);
};
const box = (page: Page, name: string) =>
  page.getByRole("region", { name }).evaluate((e) => JSON.stringify(e.getBoundingClientRect()));

test(
  "the page is watched until you take over, then your input drives it until you let go",
  withGateway(async (gateway) => {
    withSurfaces(gateway, [BROWSER]);
    const page = await open(gateway);
    const frame = page.getByRole("region", { name: "Browser" });
    await frame.waitFor();
    await page.waitForFunction(() => {
      const c = document.querySelector<HTMLCanvasElement>('canvas[aria-label="Page"]');
      if (!c || c.width !== 80) return false;
      // The picture is drawn: its blue bar is there.
      const [r, , b] = c.getContext("2d")?.getImageData(30, 35, 1, 1).data ?? [];
      return (b ?? 0) > 150 && (r ?? 255) < 120;
    });
    assert.equal(
      await frame.getByRole("tab", { name: "Checkout" }).getAttribute("aria-selected"),
      "true",
    );
    assert.equal(await frame.getByLabel("Address").inputValue(), "https://shop.example/checkout");
    assert.ok(
      await frame.getByRole("button", { name: "Back" }).isDisabled(),
      "watching, nothing to press",
    );
    assert.deepEqual(gateway.live.opened.at(-1)?.mode, "watch");
    const before = await box(page, "Browser");

    await frame.getByRole("button", { name: "Take over" }).click();
    await frame.getByRole("button", { name: "Let go" }).waitFor();
    assert.equal(gateway.live.opened.at(-1)?.mode, "operate");
    assert.equal(await box(page, "Browser"), before, "taking over moves nothing");

    // A click lands where it was made, in the page's own pixels.
    const canvas = frame.locator('canvas[aria-label="Page"]');
    const shown = await canvas.boundingBox();
    assert.ok(shown);
    await page.mouse.click(shown.x + shown.width / 4, shown.y + shown.height / 2);
    await until(
      () => gateway.live.input.some((i) => i.type === "mouse" && i.action === "up"),
      "the click",
    );
    const down = gateway.live.input.find((i) => i.type === "mouse" && i.action === "down");
    assert.equal(down?.button, "left");
    assert.ok(
      Math.abs(Number(down?.x) - 200) < 4 && Math.abs(Number(down?.y) - 250) < 4,
      JSON.stringify(down),
    );

    // The input made you the driver, so the agent's browser calls wait for you.
    gateway.agentWaits(true);
    await frame.getByText("Agent waiting").waitFor();
    await page
      .getByRole("status", { name: "Now" })
      .getByText("Waiting for you in the browser")
      .waitFor();
    assert.equal(await box(page, "Browser"), before, "driving moves nothing");

    await page.keyboard.type("ab");
    await page.keyboard.press("Enter");
    await until(
      () => gateway.live.input.some((i) => i.type === "key" && i.action === "up"),
      "Enter",
    );
    assert.deepEqual(
      gateway.live.input
        .filter((i) => i.type === "text" || i.type === "key")
        .map((i) => i.text ?? `${i.action} ${i.key}`),
      ["a", "b", "down Enter", "up Enter"],
    );

    await frame.getByLabel("Address").fill("https://shop.example/cart");
    await frame.getByLabel("Address").press("Enter");
    await frame.getByRole("button", { name: "Reload" }).click();
    await until(
      () => gateway.live.input.filter((i) => i.type === "navigate").length === 2,
      "navigate",
    );
    assert.deepEqual(
      gateway.live.input.filter((i) => i.type === "navigate").map((i) => i.to),
      ["https://shop.example/cart", "reload"],
    );

    gateway.screen({
      type: "tabs",
      tabs: [
        { id: 1, url: "https://shop.example/checkout", title: "Checkout" },
        { id: 2, url: "https://docs.example/retries", title: "Retries" },
      ],
      shown: 1,
    });
    await frame.getByRole("tab", { name: "Retries" }).click();
    await until(() => gateway.live.input.some((i) => i.type === "tab"), "the tab");
    assert.deepEqual(
      gateway.live.input.find((i) => i.type === "tab"),
      { type: "tab", action: "show", id: 2 },
    );

    await frame.getByRole("button", { name: "Let go" }).click();
    await frame.getByRole("button", { name: "Take over" }).waitFor();
    assert.ok(gateway.live.input.some((i) => i.type === "release"));
    await until(() => gateway.live.opened.at(-1)?.mode === "watch", "watching again");
    assert.equal(
      await page.getByRole("status", { name: "Now" }).getByText("Waiting for you").count(),
      0,
      "the Now line is the agent's again",
    );
    assert.equal(await box(page, "Browser"), before, "letting go moves nothing");
    await page.close();
  }),
);

test(
  "when the service lets go for you, the frame goes back to watching",
  withGateway(async (gateway) => {
    withSurfaces(gateway, [BROWSER]);
    const page = await open(gateway);
    const frame = page.getByRole("region", { name: "Browser" });
    await frame.getByRole("button", { name: "Take over" }).click();
    await frame.getByRole("button", { name: "Let go" }).waitFor();
    await frame.getByRole("button", { name: "Reload" }).click();
    await until(() => gateway.live.screen.driver !== undefined, "driving");
    // As after a minute with no input.
    gateway.live.screen.driver = undefined;
    gateway.agentWaits(false);
    await frame.getByRole("button", { name: "Take over" }).waitFor();
    await page.close();
  }),
);

test(
  "what the page asks is shown to whoever watches and answered by whoever drives",
  withGateway(async (gateway) => {
    withSurfaces(gateway, [BROWSER]);
    const page = await open(gateway);
    const frame = page.getByRole("region", { name: "Browser" });
    await frame.waitFor();
    await until(() => gateway.live.screens.size === 1, "watching");

    gateway.screen({ type: "dialog", open: true, kind: "confirm", message: "Leave this page?" });
    const asks = frame.getByRole("dialog", { name: "The page asks" });
    await asks.getByText("Leave this page?").waitFor();
    assert.equal(await asks.getByRole("button").count(), 0, "a watcher can't answer");

    await frame.getByRole("button", { name: "Take over" }).click();
    await frame.getByRole("button", { name: "Let go" }).waitFor();
    gateway.screen({
      type: "dialog",
      open: true,
      kind: "prompt",
      message: "Your name?",
      defaultValue: "Sam",
    });
    await asks.getByLabel("Answer").fill("Sam Lee");
    await asks.getByRole("button", { name: "OK" }).click();
    await until(() => gateway.live.input.some((i) => i.type === "dialog"), "the answer");
    assert.deepEqual(
      gateway.live.input.find((i) => i.type === "dialog"),
      {
        type: "dialog",
        accept: true,
        text: "Sam Lee",
      },
    );
    await asks.waitFor({ state: "detached" });

    gateway.screen({ type: "file-chooser", open: true, multiple: false });
    await asks.getByText("Choose a file").waitFor();
    await asks
      .getByLabel("Files")
      .setInputFiles({ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
    await until(() => gateway.live.input.some((i) => i.type === "files"), "the file");
    assert.deepEqual(
      gateway.live.input.find((i) => i.type === "files"),
      {
        type: "files",
        files: [
          { name: "a.txt", mimeType: "text/plain", data: Buffer.from("hi").toString("base64") },
        ],
      },
    );

    gateway.screen({
      type: "choice",
      multiple: true,
      options: [
        { value: "s", label: "Small", selected: true },
        { value: "m", label: "Medium", selected: false },
      ],
    });
    await asks.getByText("Medium").click();
    await asks.getByRole("button", { name: "Done" }).click();
    await until(() => gateway.live.input.some((i) => i.type === "choice"), "the choice");
    assert.deepEqual(
      gateway.live.input.find((i) => i.type === "choice"),
      { type: "choice", values: ["s", "m"] },
    );
    await page.close();
  }),
);

test(
  "a browser that can't open says why, in its frame",
  withGateway(async (gateway) => {
    withSurfaces(gateway, [{ ...BROWSER, unavailable: "The browser isn't installed." }]);
    const page = await open(gateway);
    await page.getByText("The browser isn't installed.").waitFor();
    assert.equal(gateway.live.opened.length, 0);
    await page.close();
  }),
);

test(
  "the control log lists what agents did about this one, refusals with their reasons",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    await page.getByRole("status", { name: "Now" }).waitFor();
    assert.equal(
      await page.getByRole("region", { name: "Control" }).count(),
      0,
      "nothing yet, nothing shown",
    );
    gateway.controlled({
      at: new Date(Date.now() - 120_000).toISOString(),
      caller: "a-triage",
      tool: "agents_message",
      target: "a-research",
      outcome: "done",
    });
    gateway.controlled({
      at: new Date().toISOString(),
      caller: "a-research",
      tool: "agents_create",
      outcome: "refused",
      reason: "Its control doesn't allow creating agents.",
    });
    await page.reload();
    const log = page.getByRole("region", { name: "Control" });
    await log.getByText("Its control doesn't allow creating agents.").waitFor({ timeout: 12000 });
    const lines = await log.getByRole("listitem").allInnerTexts();
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? "", /^agents_create/);
    assert.match(lines[1] ?? "", /Triage agents_message Research/);
    await page.close();
  }),
);
