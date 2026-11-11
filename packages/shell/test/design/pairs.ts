// The design and the built shell side by side at the same size and theme, the design on the left.
//
//   node --experimental-strip-types test/design/pairs.ts <design.html> <out dir>
//
// Build the shell first. A part added to the shell adds its screens here.
import { chromium, type Page } from "@playwright/test";
import { SESSION, standIn } from "../stand-in.ts";
import {
  ASKED,
  ASKS,
  type ChatCase,
  closeEveryTab,
  computerWith,
  cpuOf,
  inDesign,
  newChatWithFirst,
  noted,
  openDesignAgent,
  openFiles,
  openSampleChat,
  openSetup,
  openWindow,
  readChat,
  refuseSend,
  SIGN_INS,
  type SignIn,
  sampleAgents,
  sampleChats,
  sampleLoad,
  signInAccount,
  signInHash,
  signInState,
  startTerminals,
  stopAgent,
  unreadReply,
} from "./samples.ts";

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
  /** The built side's computer may only be watched. */
  watch?: boolean;
  /** Three of the built side's agents have said something you haven't read. */
  unread?: boolean;
  /** The built side has the design's sample chats to open. */
  chats?: boolean;
  /** The built side's agents are the design's sample: what each is for, and Research's computer. */
  agents?: boolean;
  /** The state of the two sign-ins the built side is in. */
  signIn?: SignIn;
  /** A case the built side's sample chat is given. */
  given?: ChatCase;
  /** Terminals the built side is given, as the design's sample has them. */
  terminals?: { cmd: string; running: boolean }[];
  design(page: Page): Promise<unknown>;
  built(page: Page, gateway: Gateway): Promise<unknown>;
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
type Gateway = Awaited<ReturnType<typeof standIn>>;
/**
 * An agent's page: Research's with its computer and with its chats, and the agents that are
 * idle, have a problem, and are stopped. The computer's column is also shot alone: the frame
 * beside it is the computer's own screen, not this page's.
 */
const AGENT_PAGES: {
  name: string;
  agent: string;
  id: string;
  tab?: "Computer" | "Chats";
  sizes: Size[];
  part?: (page: Page) => ReturnType<Page["locator"]>;
}[] = [
  {
    name: "agent-computer",
    agent: "Research",
    id: "a-research",
    tab: "Computer",
    sizes: ["wide", "phone"],
  },
  {
    name: "agent-computer-column",
    agent: "Research",
    id: "a-research",
    tab: "Computer",
    sizes: ["wide"],
    part: (page) => page.getByRole("complementary", { name: "About this computer" }),
  },
  {
    name: "agent-chats",
    agent: "Research",
    id: "a-research",
    tab: "Chats",
    sizes: ["wide", "phone"],
  },
  { name: "agent-idle", agent: "Reviewer", id: "a-reviewer", sizes: ["wide"] },
  { name: "agent-problem", agent: "Triage", id: "a-triage", sizes: ["wide"] },
  { name: "agent-stopped", agent: "Weekly report", id: "a-weekly", sizes: ["wide"] },
];
/** What the design's CPU meter said, for the built side's computer to say too. */
let cpuShown = 0;
/** The terminals the design's sample has. */
const TERMINALS = [
  { cmd: "zsh", running: false },
  { cmd: "npm run dev", running: true },
  { cmd: "npm test -- checkout", running: true },
];
/** The design's own windows, on Research's computer. */
const windowOf = async (page: Page, name: string) => {
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("button", { name: "Research", exact: true })
    .click();
  await page.getByRole("button", { name, exact: true }).click();
};
const terminalOf = (page: Page) => windowOf(page, "Terminal");
const browserOf = async (page: Page) => {
  await windowOf(page, "Browser");
  await ownTab(page);
};
/** One chat, opened from the list. */
const chatNamed = async (page: Page, title: RegExp) => {
  await page.getByRole("button", { name: /^Chats/ }).click();
  const panel = page.getByRole("complementary", { name: "Chats" });
  await panel.getByRole("button", { name: title }).click();
  await panel.getByRole("button", { name: "All chats" }).waitFor();
};
/** Where a chat has older messages than the page holds, the way to them is brought into view. */
const earlierInView = async (page: Page) => {
  const earlier = page.getByRole("button", { name: "Earlier messages" });
  if (await earlier.count()) await earlier.scrollIntoViewIfNeeded();
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
  ...(
    [
      ["chat-thread", (page: Page) => chatNamed(page, /Review #482/)],
      ["chat-problem", (page: Page) => chatNamed(page, /Route today's issues/)],
      [
        "chat-new",
        async (page: Page) => {
          await page.getByRole("button", { name: /^Chats/ }).click();
          await page.getByRole("button", { name: "New chat" }).click();
        },
      ],
    ] as const
  ).map(
    ([name, reach]): Screen => ({
      name,
      sizes: ["wide", "phone"],
      themes: ["dark", "light"],
      chats: true,
      design: reach,
      built: reach,
    }),
  ),
  // The cases the design draws for a chat, each from its own control.
  ...(
    [
      ["no-call", "noCall", "A step with no call"],
      ["limit", "limit", "Plan limit"],
      ["earlier", "long", "A long chat"],
    ] as const
  ).map(
    ([name, given, control]): Screen => ({
      name: `chat-${name}`,
      sizes: ["wide"],
      themes: ["dark", "light"],
      chats: true,
      given,
      design: async (page) => {
        await openSampleChat(page);
        await inDesign(page, control);
        await earlierInView(page);
      },
      built: async (page) => {
        await openSampleChat(page);
        await earlierInView(page);
      },
    }),
  ),
  ...(
    [
      ["refused", openSampleChat],
      ["refused-first", newChatWithFirst],
    ] as const
  ).map(
    ([name, reach]): Screen => ({
      name: `chat-${name}`,
      sizes: ["wide"],
      themes: ["dark", "light"],
      chats: true,
      design: async (page) => {
        await reach(page);
        await refuseSend(page);
      },
      built: async (page, gateway) => {
        await reach(page);
        await refuseSend(page, gateway);
      },
    }),
  ),
  {
    name: "home",
    sizes: ["wide", "phone"],
    themes: ["dark", "light"],
    chats: true,
    design: async () => {},
    // As many need you as in the design's sample: one with a problem, one with a reply not read.
    built: async (page, gateway) => {
      await noted(gateway);
      unreadReply(gateway, 1);
      await page.getByRole("region", { name: "Needs you" }).getByRole("button").nth(1).waitFor();
    },
  },
  ...AGENT_PAGES.map(
    ({ name, agent, id, tab, sizes, part }): Screen => ({
      name,
      sizes,
      themes: ["dark", "light"],
      agents: true,
      chats: true,
      hash: `#/a/${id}${tab === "Chats" ? "/chats" : ""}`,
      design: async (page) => {
        await openDesignAgent(page, agent, tab === "Chats" ? tab : undefined);
        if (tab === "Computer") cpuShown = await cpuOf(page);
      },
      built: async (page, gateway) => {
        await page.getByRole("main").getByRole("heading", { name: agent, level: 1 }).waitFor();
        if (tab !== "Computer") return;
        gateway.reading(sampleLoad(cpuShown));
        await cpuOf(page);
      },
      ...(part ? { part } : {}),
    }),
  ),
  {
    name: "agent-computer-stopped",
    sizes: ["wide"],
    themes: ["dark", "light"],
    agents: true,
    hash: "#/a/a-research",
    design: async (page) => {
      await openDesignAgent(page, "Research");
      await stopAgent(page, "Research");
    },
    built: (page) => stopAgent(page, "Research"),
  },
  ...(
    [
      ["window-expanded", ["wide", "phone"], false],
      ["window-beside-chat", ["wide", "rail"], true],
    ] as const
  ).map(
    ([name, sizes, beside]): Screen => ({
      name,
      sizes: [...sizes],
      themes: ["dark", "light"],
      agents: true,
      chats: true,
      hash: "#/a/a-research",
      design: async (page) => {
        await openDesignAgent(page, "Research");
        await openWindow(page, beside);
      },
      built: (page) => openWindow(page, beside),
    }),
  ),
  ...(["folder", "file"] as const).map(
    (state): Screen => ({
      name: `files-${state}`,
      sizes: ["wide"],
      themes: ["dark", "light"],
      agents: true,
      hash: "#/a/a-research",
      design: async (page) => {
        await openDesignAgent(page, "Research");
        await openFiles(page, state === "file" ? "README.md" : undefined);
      },
      built: (page) => openFiles(page, state === "file" ? "README.md" : undefined),
      part: (page) => page.getByRole("main").getByRole("group", { name: "Files" }),
    }),
  ),
  ...SIGN_INS.map(
    ([state, sizes]): Screen => ({
      name: `signin-${state}`,
      sizes: [...sizes],
      themes: ["dark", "light"],
      agents: true,
      signIn: state,
      hash: signInHash(state),
      design: (page) => signInState(page, state, true),
      built: (page) => signInState(page, state, false),
    }),
  ),
  {
    name: "agent-setup",
    sizes: ["wide", "phone"],
    themes: ["dark", "light"],
    agents: true,
    hash: "#/a/a-research",
    design: async (page) => {
      await openDesignAgent(page, "Research");
      await openSetup(page, "Research");
    },
    built: (page) => openSetup(page, "Research"),
  },
  {
    name: "chats-found",
    sizes: ["wide"],
    themes: ["dark", "light"],
    chats: true,
    design: (page) => page.getByRole("searchbox", { name: "Search" }).fill("Route today"),
    built: (page) => page.getByRole("searchbox", { name: "Search" }).fill("Route today"),
  },
  {
    name: "terminal",
    sizes: ["wide"],
    themes: ["dark", "light"],
    hash: "#/a/a-research",
    terminals: TERMINALS,
    design: terminalOf,
    built: async () => {},
    part: terminalWindow,
  },
  {
    name: "browser",
    sizes: ["wide"],
    themes: ["dark", "light"],
    hash: "#/a/a-research",
    browser: true,
    design: browserOf,
    built: ownTab,
    part: browserWindow,
  },
  // The cases the design draws from its own controls, and the built side from its service.
  ...(
    [
      [
        "refused",
        "Typing refused",
        async (page: Page, gateway: Gateway) => {
          gateway.live.terminal.full = true;
          await page.getByRole("button", { name: "New terminal" }).click();
          await page.getByRole("group", { name: "Terminal" }).getByRole("alert").waitFor();
        },
      ],
      [
        "closed",
        "View closed",
        async (page: Page, gateway: Gateway) => {
          // Once the view is open: its tabs are drawn from what the service sent it.
          await page.getByRole("tablist", { name: "Terminals" }).getByRole("tab").first().waitFor();
          for (const ws of gateway.live.terminal.sockets) ws.close(1000);
        },
      ],
      ["watch", "Watch only", async () => {}],
    ] as const
  ).map(
    ([name, control, built]): Screen => ({
      name: `terminal-${name}`,
      sizes: ["wide"],
      themes: ["dark", "light"],
      hash: "#/a/a-research",
      watch: name === "watch",
      terminals: TERMINALS,
      design: async (page) => {
        await terminalOf(page);
        await inDesign(page, control);
      },
      built,
      part: terminalWindow,
    }),
  ),
  ...(
    [
      [
        "closed",
        ["View closed"],
        async (page: Page, gateway: Gateway) => {
          await ownTab(page);
          for (const ws of gateway.live.screens.keys()) ws.close(1000);
        },
      ],
      ["no-tab", ["No tab"], closeEveryTab],
      ...(["confirm", "file", "choice"] as const).map(
        (kind, n) =>
          [
            `asks-${kind}`,
            // The design's control goes through them in this order: one press more for each.
            Array.from({ length: n + 1 }, () => /^Page asks/),
            async (page: Page, gateway: Gateway) => {
              await ownTab(page);
              gateway.screen(ASKS[kind]);
              await page.getByRole("dialog").getByText(ASKED[kind]).waitFor();
            },
          ] as const,
      ),
      ["watch", ["Watch only"], async () => {}],
      [
        "asks-watch",
        ["Watch only", /^Page asks/],
        async (page: Page, gateway: Gateway) => {
          // Once the view is open: a page that asks before then is heard by nobody.
          await page.getByRole("tab", { name: "New tab", selected: true }).waitFor();
          gateway.screen(ASKS.confirm);
          await page.getByRole("dialog").getByText(ASKED.confirm).waitFor();
        },
      ],
    ] as const
  ).map(
    ([name, controls, built]): Screen => ({
      name: `browser-${name}`,
      sizes: ["wide"],
      themes: ["dark", "light"],
      hash: "#/a/a-research",
      browser: true,
      watch: name.endsWith("watch"),
      design: async (page) => {
        await browserOf(page);
        for (const control of controls) await inDesign(page, control);
      },
      built,
      part: browserWindow,
    }),
  ),
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
          if (screen.agents) sampleAgents(gateway);
          if (screen.signIn) signInAccount(gateway, screen.signIn);
          if (screen.browser) computerWith(gateway, "browser", !screen.watch);
          // A watcher opens no tab of its own: the one in front is there already.
          if (screen.browser && screen.watch)
            gateway.live.tabs.push({ id: 2, url: "about:blank", title: "" });
          if (screen.terminals) {
            computerWith(gateway, "terminal", !screen.watch);
            startTerminals(
              gateway,
              screen.terminals.map((one) => ({ ...one, said: "ready\n" })),
              "/home/sam/Agents/Research",
            );
          }
          if (screen.signIn !== "gone")
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
          if (screen.chats) sampleChats(gateway, screen.given);
          if (screen.unread) {
            await noted(gateway);
            for (const n of [1, 2, 3]) unreadReply(gateway, n);
            readChat(gateway);
          }
          await screen.built(page, gateway);
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
