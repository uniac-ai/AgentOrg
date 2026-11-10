// The design and the built shell side by side at the same size and theme, the design on the left.
//
//   node --experimental-strip-types test/design/pairs.ts <design.html> <out dir>
//
// Build the shell first. A part added to the shell adds its screens here.
import { chromium, type Page } from "@playwright/test";
import { type Agent, SESSION, standIn } from "../stand-in.ts";
import { noted, readChat, unreadReply } from "./unread.ts";

const [design, out] = process.argv.slice(2);
if (!design || !out) throw new Error("usage: pairs.ts <design.html> <out dir>");

/** The design's page has a bar of its own controls above its shell. */
const CONTROLS = 33;
const SIZES = { wide: [1440, 900], rail: [800, 900], phone: [390, 844] } as const;
type Size = keyof typeof SIZES;
type Theme = "dark" | "light";
/** What to do on a page before it is shot, and what of it to shoot: all of it, or one part. */
interface Screen {
  name: string;
  sizes: Size[];
  themes: Theme[];
  hash?: string;
  /** The built side's computer has a browser. */
  browser?: boolean;
  /** Three of the built side's agents have said something you haven't read. */
  unread?: boolean;
  /** Terminals the built side is given, as the design's sample has them. */
  terminals?: { cmd: string; running: boolean }[];
  design(page: Page): Promise<unknown>;
  built(page: Page): Promise<unknown>;
  part?: (page: Page) => ReturnType<Page["locator"]>;
}
const railSearch = (page: Page) =>
  page
    .getByRole("navigation", { name: "Main" })
    .getByRole("button", { name: "Search", exact: true });
const terminalWindow = (page: Page) =>
  page.getByRole("tablist", { name: "Terminals" }).locator("xpath=../../..");
const browserWindow = (page: Page) =>
  page.getByRole("tablist", { name: "Tabs" }).locator("xpath=../../..");
const ownTab = async (page: Page) => {
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await page.getByRole("tab", { name: "New tab", selected: true }).waitFor();
};
/** The design's own control makes one more chat say something. */
const twoMoreReplies = async (page: Page) => {
  for (let n = 0; n < 2; n++) await page.getByRole("button", { name: "A reply arrives" }).click();
  await page.getByRole("button", { name: "Chats, 3 new" }).waitFor();
};
const SCREENS: Screen[] = [
  {
    name: "frame",
    sizes: ["wide", "rail", "phone"],
    themes: ["dark", "light"],
    design: async () => {},
    built: async () => {},
  },
  {
    name: "frame-drawer",
    sizes: ["rail", "phone"],
    themes: ["dark"],
    design: (page) =>
      (page.viewportSize()?.width === 390
        ? page.getByRole("button", { name: "Menu" })
        : railSearch(page)
      ).click(),
    built: (page) =>
      (page.viewportSize()?.width === 390
        ? page.getByRole("button", { name: "Menu" })
        : railSearch(page)
      ).click(),
  },
  {
    name: "chat-collapsed",
    sizes: ["wide", "phone"],
    themes: ["dark", "light"],
    unread: true,
    design: twoMoreReplies,
    built: (page) => page.getByRole("button", { name: "Chats, 3 new" }).waitFor(),
  },
  {
    name: "chat-panel",
    sizes: ["wide", "phone"],
    themes: ["dark", "light"],
    unread: true,
    design: async (page) => {
      await twoMoreReplies(page);
      await page.getByRole("button", { name: "Chats, 3 new" }).click();
    },
    built: (page) => page.getByRole("button", { name: "Chats, 3 new" }).click(),
  },
  {
    name: "terminal",
    sizes: ["wide"],
    themes: ["dark", "light"],
    hash: "#/a/a-research",
    terminals: [
      { cmd: "zsh", running: false },
      { cmd: "npm run dev", running: true },
      { cmd: "npm test -- checkout", running: true },
    ],
    design: async (page) => {
      await page
        .getByRole("navigation", { name: "Main" })
        .getByRole("button", { name: "Research", exact: true })
        .click();
      await page.getByRole("button", { name: "Terminal", exact: true }).click();
    },
    built: async () => {},
    part: terminalWindow,
  },
  {
    name: "browser",
    sizes: ["wide"],
    themes: ["dark", "light"],
    hash: "#/a/a-research",
    browser: true,
    design: async (page) => {
      await page
        .getByRole("navigation", { name: "Main" })
        .getByRole("button", { name: "Research", exact: true })
        .click();
      await page.getByRole("button", { name: "Browser", exact: true }).click();
      await ownTab(page);
    },
    built: ownTab,
    part: browserWindow,
  },
];

const browser = await chromium.launch();
for (const screen of SCREENS)
  for (const size of screen.sizes)
    for (const theme of screen.themes) {
      const [width, height] = SIZES[size];
      const shots: string[] = [];
      for (const side of ["design", "built"] as const) {
        const gateway = side === "built" ? await standIn() : undefined;
        const page = await browser.newPage({
          viewport: { width, height: side === "design" ? height + CONTROLS : height },
        });
        if (gateway) {
          if (screen.browser)
            (gateway.agents.get("a-research") as Agent).units = [
              {
                instance: "i-computer",
                provider: "units",
                unit: "computer",
                title: "Computer",
                values: {},
                needs: {},
                status: {
                  state: "connected",
                  surfaces: [{ surface: "browser", protocol: "screencast@1", operate: true }],
                },
              },
            ];
          if (screen.terminals) {
            (gateway.agents.get("a-research") as Agent).units = [
              {
                instance: "i-computer",
                provider: "units",
                unit: "computer",
                title: "Computer",
                values: {},
                needs: {},
                status: {
                  state: "connected",
                  surfaces: [{ surface: "terminal", protocol: "terminal@1", operate: true }],
                },
              },
            ];
            const at = "2026-01-01T10:00:00Z";
            screen.terminals.forEach(({ cmd, running }, i) => {
              const id = `t${i}`;
              gateway.terminal({
                type: "start",
                id,
                by: "agent",
                cmd,
                workdir: "/home/sam/Agents/Research",
                tty: false,
                at,
              });
              gateway.terminal({ type: "output", id, text: "ready\n" });
              if (!running) gateway.terminal({ type: "exit", id, exitCode: 0, at });
            });
          }
          await page.addInitScript(
            (session) => localStorage.setItem("agentorg.session", session),
            SESSION,
          );
          await page.goto(`${gateway.url}/${screen.hash ?? "#/"}`);
          await page
            .getByRole("button", { name: "Dismiss" })
            .click({ timeout: 3000 })
            .catch(() => {});
          if (theme === "light")
            await page.evaluate(() => {
              document.documentElement.dataset.theme = "light";
            });
          if (screen.unread) {
            await noted(gateway);
            for (const n of [1, 2, 3]) unreadReply(gateway, n);
            readChat(gateway);
          }
          await screen.built(page);
        } else {
          await page.goto(`file://${design}`);
          if (theme === "light") await page.getByRole("button", { name: "Light" }).click();
          await screen.design(page);
        }
        await page.mouse.move(width - 3, height / 2);
        await page.waitForTimeout(900);
        const shot = screen.part
          ? await screen.part(page).screenshot()
          : await page.screenshot({
              clip: { x: 0, y: side === "design" ? CONTROLS : 0, width, height },
            });
        shots.push(`data:image/png;base64,${shot.toString("base64")}`);
        await page.close();
        await gateway?.close();
      }
      const pair = await browser.newPage({ viewport: { width: 400, height: 300 } });
      await pair.setContent(
        `<body style="margin:0;background:#808080"><div id="pair" style="display:inline-flex;gap:8px;padding:8px;align-items:flex-start">${shots.map((src) => `<img src="${src}">`).join("")}</div></body>`,
      );
      await pair
        .locator("#pair")
        .screenshot({ path: `${out}/${screen.name}-${size}-${theme}-design-left-built-right.png` });
      await pair.close();
    }
await browser.close();
