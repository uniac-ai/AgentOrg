import test from "node:test";
import { open, withBrowser, withGateway } from "./build-kit.ts";
import { looksRight, SHORT } from "./create-card-kit.ts";

withBrowser();

test(
  "on short pages 1280 and 800 wide the window is still whole, with Create in view: 720, 600 and 480 tall",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    for (const [width, height] of SHORT.filter(([width]) => width >= 768))
      await looksRight(page, width, height);
    await page.close();
  }),
);

test(
  "on a short phone the window is still whole, with Create in view, and scrolls for what it can do: 390 wide at 720, 600 and 480 tall",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    for (const [width, height] of SHORT.filter(([width]) => width < 768))
      await looksRight(page, width, height);
    await page.close();
  }),
);
