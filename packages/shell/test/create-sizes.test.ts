import test from "node:test";
import { open, withBrowser, withGateway } from "./build-kit.ts";
import { looksRight, WIDTHS } from "./create-card-kit.ts";

withBrowser();

test(
  "from 768 wide the window has what it can do beside the card, whole and in the page's middle at each width: 1920, 1440, 1280, 1100, 1024, 900 and 800",
  withGateway(async (gateway) => {
    const page = await open(gateway);
    for (const [width, height] of WIDTHS.filter(([width]) => width >= 768))
      await looksRight(page, width, height);
    await page.close();
  }),
);
