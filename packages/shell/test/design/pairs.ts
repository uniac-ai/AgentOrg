// The design and the built shell side by side at the same size and theme, the design on the left.
//
//   node --experimental-strip-types test/design/pairs.ts <design.html> <out dir> [names]
//
// With `names`, a list like `home,create`, only the screens whose names start with one are shot.
//
// Build the shell first. A part added to the shell adds its screens here.
import { chromium, type Page } from "@playwright/test";
import { SESSION, standIn } from "../stand-in.ts";
import {
  ASKED,
  ASKS,
  type ChatCase,
  CREATES,
  type Create,
  closeEveryTab,
  computer,
  computerSays,
  computerWith,
  cpuOf,
  createState,
  designAgents,
  docsAgent,
  firstStart,
  inDesign,
  MOMENTS,
  type Moment,
  messageDocs,
  noted,
  openConversation,
  openDesignAgent,
  openFiles,
  openOffer,
  openSampleChat,
  openSection,
  openSettingsWindow,
  openSetup,
  openTemplates,
  openWindow,
  readChat,
  refuseSend,
  releaseNotes,
  researchSays,
  researchTypes,
  SECTIONS,
  SIGN_INS,
  type SignIn,
  SMALLS,
  type Small,
  sampleBuild,
  sampleChats,
  sampleLoad,
  sampleSettings,
  signInAccount,
  signInHash,
  signInState,
  smallSays,
  smallState,
  startTerminals,
  TYPING,
  type Typing,
  type UnitWindow,
  unreadReply,
  WINDOWS,
  windowSays,
  windowState,
  writeSoFar,
  youActed,
} from "./samples.ts";

const [design, out, only] = process.argv.slice(2);
if (!design || !out) throw new Error("usage: pairs.ts <design.html> <out dir> [names]");
const wanted = (name: string) => !only || only.split(",").some((one) => name.startsWith(one));

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
  /** The built side is at its first start: one agent, with no conversation begun. */
  firstStart?: boolean;
  /** The built side's Settings lists the design's sample where it shows. */
  settings?: boolean;
  /** The built side builds from the design's sample: its base, units and templates. */
  build?: boolean;
  /** A state of New template's window, whose Computer may say a line of its own. */
  create?: Create;
  /** A state of Create for an agent. */
  small?: Small;
  /** A state of the unit window, whose Computer its connector states. */
  unitWindow?: UnitWindow;
  /** The design's page is this much taller than its own bar makes it. */
  taller?: number;
  /** The state of the two sign-ins the built side is in. */
  signIn?: SignIn;
  /** A case the built side's sample chat is given. */
  given?: ChatCase;
  /** Research's conversation, built, at one of the design's moments for a reply's bubbles. */
  research?: Moment;
  /** Research's conversation, built, with the agent typing or done at one of the design's states. */
  types?: Typing;
  /** Terminals the built side is given, as the design's sample has them. */
  terminals?: { cmd: string; running: boolean }[];
  design(page: Page): Promise<unknown>;
  built(page: Page, gateway: Gateway): Promise<unknown>;
  part?: (page: Page) => ReturnType<Page["locator"]>;
}
const terminalWindow = (page: Page) =>
  page.getByRole("tablist", { name: "Terminals" }).locator("xpath=../../..");
const browserWindow = (page: Page) =>
  page.getByRole("tablist", { name: "Tabs" }).locator("xpath=../../..");
const ownTab = async (page: Page) => {
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await page.getByRole("tab", { name: "New tab", selected: true }).waitFor();
};
type Gateway = Awaited<ReturnType<typeof standIn>>;
/** The way to the chat page, in the design and built: the bar's Chat icon. */
const chatIcon = (page: Page) =>
  page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: /^Chat/ }).click();
/** Chat's compose icon, pressed, and its picker once it has opened. */
const composeIcon = async (page: Page) => {
  await page.getByRole("main").getByRole("button", { name: "Message", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Message" })
    .evaluate((e) => Promise.all(e.getAnimations({ subtree: true }).map((one) => one.finished)));
};
/** The bar's search, pressed, and its dialog once it has opened. */
const searchPlace = async (page: Page) => {
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("button", { name: "Search" })
    .click();
  await page
    .getByRole("dialog", { name: "Search" })
    .evaluate((e) => Promise.all(e.getAnimations({ subtree: true }).map((one) => one.finished)));
};
/** The way to the team page, in the design and built: the bar's Team icon. */
const teamIcon = (page: Page) =>
  page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Team" }).click();
/**
 * A place's label, beside it: shown from the keyboard, which the pointer moving away leaves. A
 * key pressed first makes it the keyboard's focus, ring and all, after the built side's Dismiss.
 */
const labelOf = async (page: Page, name: string) => {
  await page.keyboard.press("Shift");
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name }).focus();
  await page.locator('[data-slot="tooltip-content"]').waitFor();
};
/** A row of the team page's list, in the design or built. */
const teamRow = (page: Page, name: string) =>
  page
    .getByRole("main")
    .getByRole("list", { name: "Agents" })
    .getByRole("button", { name: new RegExp(name) });
/** A row of the built chat page's list. */
const chatRow = (page: Page, name: string) =>
  page
    .getByRole("main")
    .getByRole("list", { name: "Chats" })
    .getByRole("button", { name: new RegExp(name) });
/** The built side's conversations as the design's sample has them, Release notes' among them. */
async function asTheDesign(gateway: Gateway) {
  await noted(gateway);
  releaseNotes(gateway);
  gateway.changed();
}
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
/** Research's conversation in the floating chat: Team, Research, its Chats, the conversation. */
async function researchInFloatingChat(page: Page) {
  await openDesignAgent(page, "Research", "Chats");
  await page
    .getByRole("main")
    .getByRole("list", { name: "Chats with Research" })
    .getByRole("button")
    .first()
    .click();
  await page.getByRole("complementary", { name: "Chats" }).locator(".prose-chat").first().waitFor();
}
/** The design's own windows, on Research's computer. */
const windowOf = async (page: Page, name: string) => {
  await openDesignAgent(page, "Research");
  await page.getByRole("button", { name, exact: true }).click();
};
const terminalOf = (page: Page) => windowOf(page, "Terminal");
const browserOf = async (page: Page) => {
  await windowOf(page, "Browser");
  await ownTab(page);
};
/** One chat, opened from the list. */
/** Where a chat has older messages than the page holds, the way to them is brought into view. */
const earlierInView = async (page: Page) => {
  const earlier = page.getByRole("button", { name: "Earlier messages" });
  if (await earlier.count()) await earlier.scrollIntoViewIfNeeded();
};
/** The design's own control makes one more conversation say something: two unread, its most. */
const oneMoreReply = async (page: Page) => {
  await page.getByRole("button", { name: "A reply arrives" }).click();
  await page.getByRole("button", { name: "Chats, 2 new" }).waitFor();
};
const SCREENS: Screen[] = [
  // The frame: the bar, on Chat, where the app opens, with the design's sample in it.
  {
    name: "frame",
    sizes: ["wide", "rail", "phone"],
    themes: ["dark", "light"],
    chats: true,
    agents: true,
    design: async () => {},
    built: async (page, gateway) => {
      await asTheDesign(gateway);
      await chatRow(page, "Release notes").waitFor();
    },
  },
  {
    name: "frame-label",
    sizes: ["wide"],
    themes: ["dark", "light"],
    chats: true,
    agents: true,
    design: (page) => labelOf(page, "Team"),
    built: async (page, gateway) => {
      await asTheDesign(gateway);
      await chatRow(page, "Release notes").waitFor();
      await labelOf(page, "Team");
    },
  },
  // The floating chat, on Team: it is on every page but Chat.
  {
    name: "chat-collapsed",
    sizes: ["wide", "phone"],
    themes: ["dark", "light"],
    unread: true,
    hash: "#/team",
    design: async (page) => {
      await teamIcon(page);
      await oneMoreReply(page);
    },
    built: (page) => page.getByRole("button", { name: "Chats, 2 new" }).waitFor(),
  },
  {
    name: "chat-panel",
    sizes: ["wide", "phone"],
    themes: ["dark", "light"],
    unread: true,
    hash: "#/team",
    design: async (page) => {
      await teamIcon(page);
      await oneMoreReply(page);
      await page.getByRole("button", { name: "Chats, 2 new" }).click();
    },
    built: (page) => page.getByRole("button", { name: "Chats, 2 new" }).click(),
  },
  ...(
    [
      ["chat-thread", (page: Page) => openConversation(page, "Reviewer")],
      ["chat-problem", (page: Page) => openConversation(page, "Triage")],
    ] as const
  ).map(
    ([name, reach]): Screen => ({
      name,
      sizes: ["wide", "phone"],
      themes: ["dark", "light"],
      chats: true,
      hash: "#/team",
      design: async (page) => {
        await teamIcon(page);
        await reach(page);
      },
      built: reach,
    }),
  ),
  // The cases the design draws for a chat, each from its own control.
  ...(
    [
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
      hash: "#/team",
      design: async (page) => {
        await teamIcon(page);
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
      ["refused-first", messageDocs],
    ] as const
  ).map(
    ([name, reach]): Screen => ({
      name: `chat-${name}`,
      sizes: ["wide"],
      themes: ["dark", "light"],
      chats: true,
      hash: "#/team",
      design: async (page) => {
        await teamIcon(page);
        await reach(page);
        await refuseSend(page);
      },
      built: async (page, gateway) => {
        docsAgent(gateway);
        gateway.changed();
        await reach(page);
        await refuseSend(page, gateway);
      },
    }),
  ),
  // The chat page, by the bar's Chat icon on both sides.
  {
    name: "chat-page",
    sizes: ["wide"],
    themes: ["dark", "light"],
    chats: true,
    agents: true,
    design: chatIcon,
    built: async (page, gateway) => {
      await asTheDesign(gateway);
      await chatIcon(page);
      await page
        .getByRole("main")
        .getByRole("region", { name: /^Conversation with / })
        .waitFor();
    },
  },
  // Who to message, from Chat's head: the picker open.
  {
    name: "compose-picker",
    sizes: ["wide", "phone"],
    themes: ["dark", "light"],
    chats: true,
    agents: true,
    design: async (page) => {
      await chatIcon(page);
      await composeIcon(page);
    },
    built: async (page, gateway) => {
      await asTheDesign(gateway);
      await chatIcon(page);
      await composeIcon(page);
    },
  },
  // The search, from the bar: empty, the conversations.
  {
    name: "search-empty",
    sizes: ["wide", "phone"],
    themes: ["dark", "light"],
    chats: true,
    agents: true,
    design: searchPlace,
    built: async (page, gateway) => {
      await asTheDesign(gateway);
      await searchPlace(page);
    },
  },
  {
    name: "chat-page-list",
    sizes: ["rail", "phone"],
    themes: ["dark", "light"],
    chats: true,
    agents: true,
    design: chatIcon,
    built: async (page, gateway) => {
      await asTheDesign(gateway);
      await chatIcon(page);
      await chatRow(page, "Reviewer").waitFor();
    },
  },
  {
    name: "chat-page-conversation",
    sizes: ["rail", "phone"],
    themes: ["dark", "light"],
    chats: true,
    agents: true,
    design: async (page) => {
      await chatIcon(page);
      await page
        .getByRole("list", { name: "Conversations" })
        .getByRole("button", { name: /Reviewer/ })
        .click();
    },
    built: async (page, gateway) => {
      await asTheDesign(gateway);
      await chatIcon(page);
      await chatRow(page, "Reviewer").click();
      await page
        .getByRole("main")
        .getByRole("region", { name: "Conversation with Reviewer" })
        .waitFor();
    },
  },
  // An agent's computer beside the conversation on the chat page: Release notes', which holds
  // files only, so no page's address is in the picture.
  {
    name: "chat-page-computer",
    sizes: ["wide"],
    themes: ["dark", "light"],
    chats: true,
    agents: true,
    design: async (page) => {
      await chatIcon(page);
      await page
        .getByRole("list", { name: "Conversations" })
        .getByRole("button", { name: /Release notes/ })
        .click();
      await page.getByRole("button", { name: "Release notes's computer" }).click();
    },
    built: async (page, gateway) => {
      await asTheDesign(gateway);
      computer(gateway, [{ surface: "files", protocol: "files@1", operate: true }], "a-release");
      gateway.changed();
      await chatIcon(page);
      await chatRow(page, "Release notes").click();
      await page.getByRole("button", { name: "Release notes's computer" }).click();
      await page.locator('[data-beside="open"]').waitFor();
    },
  },
  // The first start: one agent, the Assistant, whose conversation hasn't begun, open on Chat while
  // the list says there are no chats; on a phone, the conversation alone.
  {
    name: "first-start",
    sizes: ["wide", "phone"],
    themes: ["dark", "light"],
    firstStart: true,
    design: (page) => inDesign(page, "A first start"),
    built: (page) =>
      page
        .getByRole("main")
        .getByRole("region", { name: "Conversation with Assistant" })
        .getByRole("textbox", { name: "Message" })
        .waitFor(),
  },
  // Out of reach: the notice over the blurred screen on Chat, Team and Settings, each open as the
  // service goes; and pressed, while its try runs. The design's bar is pressed by its event: an
  // open window keeps the rest of the page from the pointer.
  ...(
    [
      ["offline-chat", "#/chat", undefined],
      ["offline-team", "#/team", "Team"],
      ["offline-settings", "#/settings", "Settings"],
      ["offline-pressed", "#/chat", undefined],
    ] as const
  ).map(
    ([name, hash, place]): Screen => ({
      name,
      sizes: ["wide", "phone"],
      themes: ["dark", "light"],
      agents: true,
      hash,
      design: async (page) => {
        if (place)
          await page
            .getByRole("navigation", { name: "Main" })
            .getByRole("button", { name: place, exact: true })
            .click();
        await page
          .getByLabel("Draft controls")
          .getByRole("button", { name: "Out of reach", exact: true, includeHidden: true })
          .dispatchEvent("click");
        const notice = page.getByRole("button", { name: "You're offline. Check again" });
        await notice.waitFor();
        if (name === "offline-pressed") await notice.click();
      },
      built: async (page, gateway) => {
        // The page itself: with Settings open, it is hidden from the roles.
        await page.locator("main").waitFor();
        gateway.goAway(true, name === "offline-pressed" ? 60_000 : 0);
        const notice = page.getByRole("button", { name: "You're offline. Check again" });
        await notice.waitFor();
        if (name === "offline-pressed") {
          await notice.click();
          await page.getByRole("button", { name: "Reconnecting" }).waitFor();
        }
      },
    }),
  ),
  // The team page, with Reviewer's details, by the bar's Team icon on both sides.
  ...(
    [
      ["team-page", ["wide"], true],
      ["team-page-list", ["rail", "phone"], false],
      ["team-page-details", ["rail", "phone"], true],
    ] as const
  ).map(
    ([name, sizes, details]): Screen => ({
      name,
      sizes: [...sizes],
      themes: ["dark", "light"],
      agents: true,
      design: async (page) => {
        await teamIcon(page);
        if (details) await teamRow(page, "Reviewer").click();
      },
      built: async (page) => {
        await teamIcon(page);
        await teamRow(page, "Reviewer").waitFor();
        if (!details) return;
        await teamRow(page, "Reviewer").click();
        await page.getByRole("main").getByRole("heading", { name: "Reviewer", level: 1 }).waitFor();
      },
    }),
  ),
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
      built: async (page, gateway) => {
        await openWindow(page, beside);
        // Expand is pressed in its browser, which the design counts as acting there, for a few
        // seconds: its head says Research is told. The built side's computer says so.
        if (!beside) youActed(gateway);
      },
    }),
  ),
  ...(["folder", "file", "changed"] as const).map(
    (state): Screen => ({
      name: `files-${state}`,
      sizes: ["wide"],
      themes: ["dark", "light"],
      agents: true,
      hash: "#/a/a-research",
      design: async (page) => {
        await openDesignAgent(page, "Research");
        await openFiles(page, state === "file" ? "README.md" : undefined, state === "changed");
      },
      built: (page) =>
        openFiles(page, state === "file" ? "README.md" : undefined, state === "changed"),
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
      built: (page, gateway) => signInState(page, state, false, gateway),
    }),
  ),
  // The banner with the line that ChatGPT's page couldn't be opened.
  {
    name: "signin-refused",
    sizes: ["wide"],
    themes: ["dark", "light"],
    agents: true,
    signIn: "out",
    design: async (page) => {
      await inDesign(page, /^ChatGPT:/);
      await inDesign(page, "Action refused");
      await page.getByRole("region", { name: "Set up" }).getByRole("alert").waitFor();
    },
    built: async (page, gateway) => {
      const banner = page.getByRole("region", { name: "Set up" });
      gateway.refuseNext("login.start", "unavailable", "Not answering.");
      await banner.getByRole("button", { name: "Continue with ChatGPT" }).click();
      await banner.getByRole("alert").waitFor();
    },
  },
  // A reply as bubbles: Research's conversation at the design's moments, on Chat, in the floating
  // chat and on a phone. Shot against the design that draws them.
  ...(
    [
      ["reply-one-line", "oneLine", ["wide"], "chat"],
      ["reply-long", "long", ["wide", "phone"], "chat"],
      ["reply-writing", "writing", ["wide"], "chat"],
      ["reply-long-floating", "long", ["wide"], "floating"],
      ["reply-result", "result", ["wide"], "chat"],
    ] as const
  ).map(
    ([name, moment, sizes, where]): Screen => ({
      name,
      sizes: [...sizes],
      themes: ["dark", "light"],
      agents: true,
      chats: true,
      research: moment,
      hash: where === "chat" ? "#/chat/a-research" : "#/a/a-research",
      design: async (page) => {
        await inDesign(page, MOMENTS[moment]);
        // Shot 3.5 s in on its clock, as the design's own pair is: the runner waits 0.9 s more.
        if (moment === "writing") await page.waitForTimeout(2600);
        if (where === "floating") await researchInFloatingChat(page);
      },
      built: async (page, gateway) => {
        const main = page.getByRole("main");
        if (where === "floating") await researchInFloatingChat(page);
        const thread =
          where === "floating" ? page.getByRole("complementary", { name: "Chats" }) : main;
        await thread.locator(".whitespace-pre-wrap").last().waitFor();
        if (moment === "writing") writeSoFar(gateway);
        await thread.locator(".prose-chat").first().waitFor();
      },
    }),
  ),
  // The agent typing: Research's conversation at each of the design's states for it, on Chat. The
  // design's "opened later" leaves it for Team, and it is opened again from Chat.
  ...(Object.keys(TYPING) as Typing[]).map(
    (state): Screen => ({
      name: `typing-${state}`,
      sizes: ["wide", "phone"],
      themes: ["dark", "light"],
      agents: true,
      chats: true,
      types: state,
      hash: "#/chat/a-research",
      design: async (page) => {
        await inDesign(page, TYPING[state]);
        if (state === "late")
          await page
            .getByRole("navigation", { name: "Main" })
            .getByRole("button", { name: /^Chat/ })
            .click();
        const region = page.getByRole("region", { name: "Conversation with Research" });
        if (!(await region.count()))
          await page
            .getByRole("list", { name: "Conversations" })
            .getByRole("button")
            .filter({ hasText: "Research" })
            .click();
        await region.locator('[data-slot="bubble"]').first().waitFor();
      },
      built: async (page) => {
        await page.getByRole("main").locator('[data-slot="bubble"]').first().waitFor();
        if (state === "one" || state === "two" || state === "late")
          await page.locator(".typing-dot").first().waitFor();
      },
    }),
  ),
  // Create for an agent, small: as it opens, from a template, signed out, and refused.
  ...SMALLS.map(
    ([state, sizes]): Screen => ({
      name: `create-${state}`,
      sizes: [...sizes],
      themes: ["dark", "light"],
      build: true,
      // Centred in an odd height the design's window would sit on a half pixel.
      taller: 1,
      small: state,
      design: (page) => smallState(page, state, true),
      built: (page) => smallState(page, state, false),
    }),
  ),
  // New template's window, which builds a stack in its options.
  ...CREATES.map(
    ([state, sizes]): Screen => ({
      name: `new-template-${state}`,
      sizes: [...sizes],
      themes: ["dark", "light"],
      build: true,
      taller: 1,
      create: state,
      design: (page) => createState(page, state, true),
      built: (page) => createState(page, state, false),
    }),
  ),
  // The unit window: Change… on Research's computer from its setup, and a way forward's window.
  ...WINDOWS.map(
    ([state, sizes]): Screen => ({
      name: `unit-window-${state}`,
      sizes: [...sizes],
      themes: ["dark", "light"],
      agents: true,
      unitWindow: state,
      hash: "#/a/a-research",
      design: (page) => windowState(page, state, true),
      built: (page) => windowState(page, state, false),
    }),
  ),
  // Settings, a window over the place: as it opens, on Templates (on a phone, its sections first),
  // then a section with its action, a phone's second screen. MCP connections isn't shot: its
  // sample rows show local addresses.
  {
    name: "settings",
    sizes: ["wide", "rail", "phone"],
    themes: ["dark", "light"],
    build: true,
    design: openSettingsWindow,
    built: async (page) => {
      const window = await openSettingsWindow(page);
      if ((page.viewportSize()?.width ?? 0) >= 640)
        await window
          .getByRole("region", { name: "Templates" })
          .getByText("Storefront worker")
          .waitFor();
    },
  },
  {
    name: "templates",
    sizes: ["phone"],
    themes: ["dark", "light"],
    build: true,
    design: openTemplates,
    built: openTemplates,
  },
  ...SECTIONS.filter(([section]) => section !== "mcps").map(
    ([section]): Screen => ({
      name: `settings-${section}`,
      sizes: ["wide", "phone"],
      themes: ["dark", "light"],
      settings: true,
      design: (page) => openSection(page, section),
      built: (page) => openSection(page, section),
    }),
  ),
  ...(["skills"] as const).map(
    (section): Screen => ({
      name: `settings-offer-${section}`,
      sizes: ["wide"],
      themes: ["dark", "light"],
      settings: true,
      taller: 1,
      design: (page) => openOffer(page, section),
      built: (page) => openOffer(page, section),
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
for (const one of only?.split(",") ?? [])
  if (!SCREENS.some((screen) => screen.name.startsWith(one)))
    throw new Error(`no screen's name starts with "${one}"`);
for (const screen of SCREENS.filter((one) => wanted(one.name)))
  for (const size of screen.sizes)
    for (const theme of screen.themes) {
      const [width, height] = SIZES[size];
      const shots: string[] = [];
      for (const side of ["design", "built"] as const) {
        const gateway = side === "built" ? await standIn() : undefined;
        const page = await browser.newPage({
          viewport: {
            width,
            height: side === "design" ? height + CONTROLS + (screen.taller ?? 0) : height,
          },
        });
        if (gateway) {
          if (screen.agents) designAgents(gateway);
          // Before the page is read, as a conversation opened later reads it.
          if (screen.research) researchSays(gateway, screen.research);
          if (screen.types) researchTypes(gateway, screen.types);
          if (screen.firstStart) firstStart(gateway);
          if (screen.build) sampleBuild(gateway);
          if (screen.create) computerSays(gateway, screen.create);
          if (screen.small) smallSays(gateway, screen.small);
          if (screen.unitWindow) windowSays(gateway, screen.unitWindow);
          if (screen.settings) sampleSettings(gateway);
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
            for (const n of [1, 2]) unreadReply(gateway, n);
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
