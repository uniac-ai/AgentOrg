// What the built side is given for the measured screens, as the design's sample has it: its
// agents and computer and terminals, replies not yet read, sample chats to open, and what a page asks; and
// the design page's own controls, which put it in the cases it draws.
import { crc32, deflateSync } from "node:zlib";
import type { Page } from "@playwright/test";
import type { Agent, Creatable, Held, standIn, Template, Units } from "../stand-in.ts";

type Gateway = Awaited<ReturnType<typeof standIn>>;

/** Once the shell has begun its note of what is read: a reply said from here on is new. */
export async function noted(gateway: Gateway) {
  while (!gateway.notes.has("ui/read-conversations"))
    await new Promise((done) => setTimeout(done, 20));
  await new Promise((done) => setTimeout(done, 5));
}

/** The `n`th agent, of three, says something not yet read. */
export function unreadReply(gateway: Gateway, n: number) {
  const reply = {
    id: `unread-${n}`,
    role: "assistant" as const,
    text: "A reply you haven't read.",
    at: new Date().toISOString(),
  };
  gateway.addMessage(["a-reviewer", "a-research", "a-triage"][n - 1] as string, reply);
}

/** A conversation with nothing unread, to be seen beside the unread ones. */
export function readChat(gateway: Gateway) {
  gateway.converse("a-triage", [
    { id: "said-1", role: "user", text: "Monday's numbers?", at: "2026-01-01T10:00:00Z" },
  ]);
}

/** Another idle agent as the design's sample has it, with nothing said to it. */
export function likeAgent(gateway: Gateway, agent: string, name: string, purpose: string) {
  const like = gateway.agents.get("a-reviewer") as Agent;
  gateway.agents.set(agent, {
    ...like,
    agent,
    name,
    purpose,
    skills: [],
    mcp: [],
    chat: { status: { state: "idle" }, messages: [] },
  });
}
/** An agent you have never messaged, as the design's sample has Docs. */
export const docsAgent = (gateway: Gateway) => {
  likeAgent(gateway, "a-docs", "Docs", "Keeps the product docs in step with what ships");
  // A computer made for it, with its own browser, as the design's sample has it.
  computer(
    gateway,
    [
      { surface: "browser", protocol: "screencast@1", operate: true },
      { surface: "terminal", protocol: "terminal@1", operate: true },
      { surface: "files", protocol: "files@1", operate: true },
    ],
    "a-docs",
  );
};
/** Release notes, with a reply you haven't read, as the design's sample has it. */
export function releaseNotes(gateway: Gateway) {
  if (!gateway.agents.has("a-release"))
    likeAgent(
      gateway,
      "a-release",
      "Release notes",
      "Drafts release notes from merged pull requests",
    );
  gateway.addMessage("a-release", {
    id: "n-a1",
    role: "assistant",
    text: "Grouped 62 changes by area: 28 in checkout, 19 in search, 15 fixes. Should the notes cover 4.2 only?",
    // Said after the note of what is read was begun, so it is new.
    at: new Date().toISOString(),
  });
}

/** Research's conversation with Release notes, as the design's sample has it: read from either page. */
export function between(gateway: Gateway) {
  if (!gateway.agents.has("a-release"))
    likeAgent(
      gateway,
      "a-release",
      "Release notes",
      "Drafts release notes from merged pull requests",
    );
  // It has a computer of its own, as the design's sample has it.
  computer(gateway, [{ surface: "browser", protocol: "screencast@1", operate: true }], "a-release");
  const at = new Date(Date.now() - 9 * 60_000).toISOString();
  gateway.sayWith("a-release", "a-research", {
    id: "q-u1",
    role: "user",
    text: "Which changes since 4.1 touched checkout? I'm fixing a retry bug there.",
    at,
  });
  gateway.sayWith("a-release", "a-research", {
    id: "q-a1",
    role: "assistant",
    text: "28 of the 62. Three touch the retry path: #471, #476 and #480. #476 is the one that started reusing the session.",
    at,
  });
}

/** Opens the conversation between Release notes and Research, from Release notes' page. */
export async function openBetween(page: Page) {
  // The built bar names an agent after how it stands; the design's, by its name alone.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("button", { name: /(^| )Release notes$/ })
    .click();
  await page.getByRole("main").getByRole("tab", { name: "Chats" }).click();
  await page
    .getByRole("main")
    .getByRole("list", { name: "Release notes's chats with other agents" })
    .getByRole("button")
    .first()
    .click();
  await chats(page).getByRole("heading", { name: "Release notes and Research" }).waitFor();
}

/** A plain picture of a size, as a PNG in base64: the design's sample picture is 640 by 420. */
function png(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height, 0xf1);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
/** The picture the person sent in the design's sample chat. */
const SHOT = png(640, 420);

/** A case the design draws for a chat, which the built side's sample chat can be given. */
export type ChatCase = "limit" | "long";

/**
 * Two conversations as the design's sample has them: Reviewer's with a reply, Triage's with a
 * problem. The first can be given a case the design draws for a conversation: the plan's limit
 * reached, or more said in it than a page holds.
 */
export function sampleChats(gateway: Gateway, given?: ChatCase) {
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  gateway.converse(
    "a-reviewer",
    [
      ...(given === "long"
        ? Array.from({ length: 120 }, (_, n) => ({
            id: `v-old-${n}`,
            role: "assistant" as const,
            text: `An earlier note, ${n}.`,
            at: at(2000 - n),
          }))
        : []),
      {
        id: "v-u1",
        role: "user",
        text: "Review #482 before I merge it. This is what the coupon does on staging.",
        at: at(13),
        images: [{ mediaType: "image/png", data: SHOT }],
      },
      {
        id: "v-a1",
        role: "assistant",
        text: "Three comments on #482. The one that matters: `applyCoupon` runs before the cart is priced, so a percentage coupon is taken off zero. The other two are naming.",
        at: at(12),
      },
    ],
    given === "limit"
      ? { code: "usage_limit", message: "You've reached your plan's limit." }
      : undefined,
  );
  gateway.converse(
    "a-triage",
    [{ id: "t-u1", role: "user", text: "Route today's new issues.", at: at(60) }],
    { code: "failed", message: "linear is down, so its tools are left out" },
  );
}

/** What a page asks, as the design's sample has each. */
export const ASKS = {
  confirm: {
    type: "dialog",
    open: true,
    kind: "confirm",
    message: "Pay $48.00 with the card ending 4242?",
  },
  file: { type: "file-chooser", open: true, multiple: false },
  choice: {
    type: "choice",
    multiple: false,
    options: [
      { value: "standard", label: "Standard, 5 days", selected: true },
      { value: "express", label: "Express, 2 days", selected: false },
      { value: "next", label: "Next day", selected: false },
    ],
  },
};
/** Words of each to wait for. */
export const ASKED = { confirm: "Pay $48.00", file: "Choose a file", choice: "Express, 2 days" };

type Surface = NonNullable<NonNullable<Agent["units"]>[number]["status"]["surfaces"]>[number];
/** An agent given a computer with these surfaces: Research, unless another is named. */
export const computer = (gateway: Gateway, surfaces: Surface[], agent = "a-research") => {
  (gateway.agents.get(agent) as Agent).units = [
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
};

/** Research's computer with one live surface, which may be operated or only watched. */
export function computerWith(gateway: Gateway, surface: "terminal" | "browser", operate = true) {
  computer(gateway, [
    { surface, protocol: surface === "terminal" ? "terminal@1" : "screencast@1", operate },
  ]);
}

/**
 * The agents as the design's sample has them: what each is for, a chat with the one that is
 * stopped, and Research built from a template with a computer on this machine (a terminal, a
 * browser and its load to watch) and the web.
 */
export function sampleAgents(gateway: Gateway) {
  for (const [agent, purpose] of [
    ["a-research", "Digs through issues and docs, and writes up what it finds"],
    ["a-reviewer", "Reviews pull requests on acme/storefront"],
    ["a-triage", "Routes new Linear issues to the right team"],
    ["a-weekly", "Writes Monday's numbers from the analytics database"],
  ] as const)
    (gateway.agents.get(agent) as Agent).purpose = purpose;
  gateway.converse("a-weekly", [
    {
      id: "monday-1",
      role: "assistant",
      text: "Signups were up 4% on the week before.",
      at: new Date(Date.now() - 2 * 24 * 3600_000).toISOString(),
    },
  ]);
  computer(gateway, [
    { surface: "browser", protocol: "screencast@1", operate: true },
    { surface: "terminal", protocol: "terminal@1", operate: true },
    { surface: "files", protocol: "files@1", operate: true },
    { surface: "load", protocol: "metrics@1", operate: false },
  ]);
  // Its workspace, as the design's sample has it.
  const weeks = 3 * 7 * 24 * 60;
  gateway.putFile(
    "storefront/README.md",
    "# Storefront\n\nThe shop's web app. `npm run dev` serves it on port 4173.",
    weeks,
  );
  gateway.putFile(
    "storefront/package.json",
    '{\n  "name": "storefront",\n  "scripts": { "dev": "vite", "test": "vitest run" }\n}',
    weeks,
  );
  gateway.putFile(
    "storefront/src/checkout/form.ts",
    'import { session } from "./session";\n\nexport async function submit(cart) {\n  await session.pay(cart);\n}',
    weeks,
  );
  // The two files its task changed lately: one new, one edited.
  gateway.putFile("storefront/src/checkout/retry.test.ts", "t".repeat(344), 1);
  gateway.putFile("storefront/src/checkout/retry.ts", "r".repeat(1300), 0.5);
  // What Research was built from: the template, its two units as they were filled in, and as
  // many connections and skills as the design's has, under the same names.
  const research = gateway.agents.get("a-research") as Agent;
  research.template = "assistant";
  research.mcp = [
    { slot: "computer", connection: "c-notes", instance: "i-computer" },
    { slot: "web", connection: "c-postgres" },
    { slot: "github_acme", connection: "c-github" },
  ];
  research.skills = [
    { name: "terminal", description: "Runs commands, including long ones", instance: "i-computer" },
    { name: "files", description: "Reads, searches and edits files", instance: "i-computer" },
    {
      name: "computer",
      description: "Where things are, what persists, installing software",
      instance: "i-computer",
    },
    { name: "browser", description: "Drives a browser, page by page", instance: "i-computer" },
    { name: "web-research", description: "Searches, then reads the sources", instance: "i-web" },
    { name: "survey-a-topic", description: "Reads widely, then narrows to what matters" },
  ];
  const [built] = research.units as NonNullable<Agent["units"]>;
  if (built)
    built.values = {
      where: "local",
      access: "terminal",
      browser: true,
      workspace: "~/Agents/Research",
    };
  research.held = [heldComputer()];
  research.units?.push({
    instance: "i-web",
    provider: "units",
    unit: "web",
    title: "Web",
    values: { service: "exa" },
    needs: {},
    status: { state: "connected" },
  });
}

/** Triage as the design has it: its one skill, and its connection down with the design's why. */
export function downTriage(gateway: Gateway) {
  (gateway.agents.get("a-triage") as Agent).skills = [
    { name: "triage-issues", description: "Labels, de-duplicates and routes new issues" },
  ];
  const linear = gateway.connections.get("c-linear");
  if (linear?.status.state === "down") linear.status.detail = "its server didn't answer";
}

/**
 * Research's pieces of work as the design's sample has them when it opens: the one it works on,
 * the one whose message wasn't answered, and the oldest. Stopped, none is worked on.
 */
export function sampleWork(gateway: Gateway, stopped = false) {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  let n = 0;
  const run = (exit: number | "running", seconds: number, text: string) =>
    `exit_code: ${exit}\nseconds: ${seconds}\nsession_id: ${exit === "running" ? "s1" : "none"}\ntext:\n${text}`;
  const call = (
    name: string,
    input: unknown,
    output: string | undefined,
    minutes: number,
    state: "done" | "refused" | "running" = "done",
  ) => ({
    id: `s${++n}`,
    at: ago(minutes),
    call: {
      name,
      state,
      input: JSON.stringify(input),
      ...(output === undefined ? {} : { output }),
    },
  });
  const words = (text: string, minutes: number) => ({
    id: `s${++n}`,
    at: ago(minutes),
    words: text,
  });
  const OPEN = "http://localhost:4173/checkout";
  const shown = (snapshot: string) =>
    `### Page state\n- Page URL: ${OPEN}\n- Page Title: Checkout · Storefront\n- Page Snapshot:\n\`\`\`yaml\n${snapshot}\n\`\`\``;
  const diff = (path: string, body: string) =>
    `===================================================================\n--- ${path}\n+++ ${path}\n${body}\n`;
  const research = gateway.agents.get("a-research") as Agent;
  if (stopped) research.status = { state: "stopped" };
  research.works = [
    {
      id: "w-checkouts",
      title: "Why are checkouts failing?",
      state: stopped ? "stopped" : "working",
      at: ago(6),
      entries: [
        call("github_acme__search_issues", { q: "is:open checkout" }, "14 open issues", 12),
        words(
          "14 open issues, and 6 of them fail when a payment is retried. I'll look at how the session is kept.",
          12,
        ),
        call(
          "exa__web_search_exa",
          { query: "payment session expired when retrying checkout" },
          "Title: Sessions\nURL: https://docs.example.com/s\nTitle: Retries\nURL: https://docs.example.com/r\nTitle: Payments\nURL: https://docs.example.com/p",
          11,
        ),
        call(
          "exa__web_fetch_exa",
          { urls: ["https://docs.example.com/payments/sessions"] },
          "Sessions end when a payment is declined.",
          11,
        ),
        call(
          "computer__exec_command",
          { cmd: "git clone --depth 1 https://github.com/acme/storefront" },
          run(0, 3.8, "Cloning into 'storefront'..."),
          10,
        ),
        call("computer__read", { path: "storefront/src/checkout/retry.ts" }, "1\tx", 9),
        call("computer__read", { path: "storefront/src/checkout/session.ts" }, "1\ty", 9),
        call("computer__list", { path: "storefront/src/checkout" }, "retry.ts", 9),
        call("computer__search", { pattern: "session.pay" }, "retry.ts:4", 9),
        call(
          "computer__exec_command",
          { cmd: "npm ci", workdir: "storefront" },
          run(0, 22.1, "added 812"),
          8,
        ),
        call(
          "computer__exec_command",
          { cmd: "npm run dev", workdir: "storefront" },
          run("running", 3, "Local"),
          7,
        ),
        call(
          "web__browser_navigate",
          { url: OPEN },
          shown('- heading "Checkout" [level=1]\n- textbox "Card number" [ref=e14]'),
          6,
        ),
        call(
          "web__browser_type",
          { element: "Card number", ref: "e14", text: "4000 0000 0000 0002" },
          shown('- textbox "Card number" [ref=e14]: 4000 0000 0000 0002'),
          6,
        ),
        call(
          "web__browser_click",
          { element: "Pay now", ref: "e19" },
          shown("- alert: Your card was declined."),
          5,
        ),
        call(
          "web__browser_click",
          { element: "Pay now", ref: "e19" },
          shown("- alert: Your session has expired."),
          5,
        ),
        words("Reproduced it: the second Pay now reuses the session the declined card ended.", 4),
        call(
          "computer__edit",
          { path: "storefront/src/checkout/retry.test.ts", old_text: "" },
          diff("retry.test.ts", "@@ -0,0 +1,8 @@\n+a\n+b\n+c\n+d\n+e\n+f\n+g\n+h"),
          4,
        ),
        call(
          "computer__exec_command",
          { cmd: "npm test -- checkout", workdir: "storefront" },
          run(1, 9.2, "FAIL"),
          3,
        ),
        call(
          "computer__edit",
          { path: "storefront/src/checkout/retry.ts", old_text: "x" },
          "old_text isn't in the file.",
          2,
          "refused",
        ),
        call(
          "computer__edit",
          { path: "storefront/src/checkout/retry.ts", old_text: "y" },
          diff("retry.ts", "@@ -1,2 +1,2 @@\n-a\n-b\n+c\n+d"),
          1,
        ),
        call(
          "computer__exec_command",
          { cmd: "npm test -- checkout", workdir: "storefront", yield_time_ms: 10000 },
          undefined,
          0,
          "running",
        ),
      ],
    },
    {
      id: "w-pushed",
      title: "Is the branch pushed?",
      state: stopped ? "stopped" : "idle",
      at: ago(20),
      entries: [
        call(
          "computer__exec_command",
          { cmd: "git status -sb", workdir: "storefront" },
          run(0, 0.084, "## fix-retry-session"),
          20,
        ),
        words("The branch is local only: it has no upstream yet.", 20),
      ],
    },
    {
      id: "w-issues",
      title: "Which issues are oldest?",
      state: stopped ? "stopped" : "idle",
      at: ago(120),
      entries: [call("github_acme__search_issues", { q: "is:open sort:created-asc" }, "#212", 120)],
    },
  ];
}

/** A computer as the computer's capability declares one here: its views in its own order. */
export const heldComputer = (over: Partial<Held> = {}): Held => ({
  title: "Computer",
  state: "connected",
  surfaces: 2,
  slots: ["computer"],
  views: [
    {
      id: "where",
      place: "column",
      kind: "facts",
      fixed: [{ label: "Where", value: "This computer" }],
    },
    { id: "load", place: "column", kind: "meters", when: "reachable", surface: "load" },
    {
      id: "workspace",
      place: "column",
      kind: "facts",
      fixed: [
        { label: "Folder", value: "~/Agents/Research", path: true },
        { label: "Reaches", value: "Files and terminal, Browser" },
      ],
    },
    {
      id: "isolation",
      place: "column",
      kind: "facts",
      when: "reachable",
      operation: "about",
      slot: "computer",
      rows: ["Isolation"],
    },
  ],
  about: [
    { label: "Isolation", value: "None: it acts as you", caution: true },
    { label: "Not shown", value: "not one the view names" },
  ],
  ...over,
});

/** An agent's page in the design, reached as a person reaches it: from the bar, then its tab. */
export async function openDesignAgent(page: Page, name: string, tab?: string) {
  if ((page.viewportSize()?.width ?? 0) < 640)
    await page.getByRole("button", { name: "Menu" }).click();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("button", { name, exact: true })
    .last()
    .click();
  if (tab) await page.getByRole("main").getByRole("tab", { name: tab }).click();
}

/** An agent's setup, opened from its page: read, and slid in, so nothing in it still moves. */
export async function openSetup(page: Page, name: string) {
  await page.getByRole("main").getByRole("button", { name: "Setup" }).click();
  const sheet = page.getByRole("dialog", { name: `${name}'s setup` });
  await sheet.getByRole("region", { name: "Skills" }).waitFor();
  await sheet.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
  return sheet;
}

/** Research's computer as the layer's window: from Expand, or from a chat of its, beside it. */
export async function openWindow(page: Page, beside: boolean) {
  const main = page.getByRole("main");
  await main.getByRole("navigation", { name: "Dock" }).waitFor();
  if (beside) {
    await main.getByRole("tab", { name: "Chats" }).click();
    await main
      .getByRole("list", { name: "Chats with Research" })
      .getByRole("button")
      .first()
      .click();
    await page
      .getByRole("complementary", { name: "Chats" })
      .getByRole("button", { name: "Research's computer" })
      .click();
  } else await main.getByRole("button", { name: "Expand" }).click();
  await page.getByRole("group", { name: "Window" }).getByRole("navigation").waitFor();
}

/**
 * Research's files in front on its page, in its storefront folder: with a file open if one is
 * named, or what changed lately listed in the folder's place.
 */
export async function openFiles(page: Page, file?: string, changed = false) {
  const main = page.getByRole("main");
  await main
    .getByRole("navigation", { name: "Dock" })
    .getByRole("button", { name: "Files" })
    .click();
  const window = main.getByRole("group", { name: "Files" });
  await window.getByRole("button", { name: "storefront" }).click();
  await window.getByRole("button", { name: /README\.md/ }).waitFor();
  // How many changed is said once the files have been walked for it.
  await window.getByRole("tab", { name: /^Changed\s*\d/ }).waitFor();
  if (file) {
    await window.getByRole("button", { name: file }).click();
    await window.locator("pre").getByText("Storefront").waitFor();
  }
  if (changed) {
    await window.getByRole("tab", { name: /^Changed/ }).click();
    await window.getByRole("list", { name: "Changed files" }).getByRole("button").first().waitFor();
  }
}

/**
 * The states of the two sign-ins that are drawn, each with the widths it is shown at: the model
 * account's on Home, an agent's line and a chat's place while signed out of it, and a tab with
 * no AgentOrg sign-in of its own (`gone`).
 */
export const SIGN_INS = [
  ["out", ["wide", "rail", "phone"]],
  ["waiting", ["wide"]],
  ["starting", ["wide"]],
  ["ineligible", ["wide"]],
  ["line", ["wide"]],
  ["chat", ["wide"]],
  ["gone", ["wide", "phone"]],
] as const;
export type SignIn = (typeof SIGN_INS)[number][0];
/** The page a state is shown on, on the built side. */
export const signInHash = (state: SignIn) =>
  state === "line" || state === "chat" ? "#/a/a-reviewer" : "#/";
/** The built side's model account, as a state has it. */
export const signInAccount = (gateway: Gateway, state: SignIn) =>
  gateway.setAccount(state === "ineligible" ? "ineligible" : "signed_out", state !== "starting");

/**
 * A page put in one of the model account's states and shown where it bites. The built side's
 * account already stands that way; the design is put there by its own controls.
 */
export async function signInState(page: Page, state: SignIn, design: boolean) {
  const main = page.getByRole("main");
  if (design) {
    if (state === "gone") return inDesign(page, /^AgentOrg:/);
    // Its control goes from signed in to signed out, to starting, to not eligible.
    const presses = state === "starting" ? 2 : state === "ineligible" ? 3 : 1;
    for (let n = 0; n < presses; n++) await inDesign(page, /^ChatGPT:/);
    if (state === "line" || state === "chat") await openDesignAgent(page, "Reviewer");
  } else if (state === "gone") return main.getByRole("heading", { name: "AgentOrg" }).waitFor();
  if (state === "line") return main.getByRole("button", { name: "Set up" }).waitFor();
  if (state === "chat") {
    await main.getByRole("button", { name: "Message", exact: true }).click();
    return page.getByRole("group", { name: "Sign in to send" }).waitFor();
  }
  const place = main.getByRole("region", { name: "Set up" });
  await place.waitFor();
  if (state !== "waiting") return;
  // ChatGPT's page is answered here: nothing leaves this computer.
  await page
    .context()
    .route("https://auth.example/**", (route) => route.fulfill({ body: "ChatGPT" }));
  await place.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await place.getByRole("button", { name: "Waiting for ChatGPT…" }).waitFor();
}

/** An agent stopped from its page, as a person stops it. */
export async function stopAgent(page: Page, name: string) {
  const main = page.getByRole("main");
  await main.getByRole("button", { name: `More for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Stop" }).click();
  await main.getByText(`${name} is stopped`).waitFor();
}

/** What a page's CPU meter says, once it says it. */
export async function cpuOf(page: Page) {
  const meter = page.getByRole("main").getByRole("meter", { name: "CPU" });
  await meter.waitFor();
  return Number(await meter.getAttribute("aria-valuenow"));
}

/** A reading that says what the design's meters say: this much CPU, 9.2 of 16 GB, 212 of 494 GB. */
export const sampleLoad = (cpu: number) => ({
  cpuUsedPct: cpu,
  memUsed: Math.round(9.22 * 2 ** 30),
  memTotal: 16 * 2 ** 30,
  diskUsed: 212e9,
  diskTotal: 494e9,
});

/** Commands the agent started, in order: each still running, or ended. */
export function startTerminals(
  gateway: Gateway,
  terminals: readonly { cmd: string; running: boolean; said?: string }[],
  workdir = "/work",
) {
  const at = "2026-01-01T10:00:00Z";
  terminals.forEach(({ cmd, running, said }, i) => {
    const id = `t${i}`;
    gateway.terminal({ type: "start", id, by: "agent", cmd, workdir, tty: false, at });
    if (said) gateway.terminal({ type: "output", id, text: said });
    if (!running) gateway.terminal({ type: "exit", id, exitCode: 0, at });
  });
}

/** Closes each of the browser's tabs, one at a time: each is gone before the next is pressed. */
export async function closeEveryTab(page: Page) {
  const tabs = page.getByRole("tablist", { name: "Tabs" });
  await tabs.getByRole("tab").first().waitFor();
  for (let left = await tabs.getByRole("tab").count(); left > 0; left--) {
    await tabs
      .getByRole("button", { name: /^Close/ })
      .first()
      .click();
    await page.waitForFunction(
      (n) =>
        document.querySelectorAll('[role="tablist"][aria-label="Tabs"] [role="tab"]').length === n,
      left - 1,
    );
  }
}

/** Presses one of the design page's own controls, which put it in a case it draws. */
export const inDesign = (page: Page, name: string | RegExp) =>
  page
    .getByLabel("Draft controls")
    .getByRole("button", { name, exact: typeof name === "string" })
    .click();

const chats = (page: Page) => page.getByRole("complementary", { name: "Chats" });

/** Opens the sample conversation that has a reply, Reviewer's, from the list. */
export async function openSampleChat(page: Page) {
  await openConversation(page, "Reviewer");
}

/** Opens your conversation with an agent, by its name, from the list. */
export async function openConversation(page: Page, name: string) {
  if (!(await chats(page).count())) await page.getByRole("button", { name: /^Chats/ }).click();
  await chats(page)
    .getByRole("list", { name: "Chats" })
    .getByRole("button")
    .filter({ hasText: name })
    .click();
  await chats(page).getByRole("heading", { name }).waitFor();
}

/**
 * Reviewer's conversation ends on a message its work didn't answer, as the design's control puts
 * it: the design's by that control, the built side's by its service.
 */
export async function notAnswered(page: Page, gateway?: Gateway) {
  if (!gateway) return inDesign(page, "Not answered");
  const said = (gateway.agents.get("a-reviewer") as Agent).chat.messages;
  gateway.converse(
    "a-reviewer",
    [
      ...said,
      {
        id: "v-u2",
        role: "user",
        text: "Is #482 ready to merge now?",
        at: new Date().toISOString(),
      },
    ],
    { code: "not_answered", message: "Not answered" },
  );
}

/** Opens your conversation with Docs, never messaged, by its page's Message. */
export async function messageDocs(page: Page) {
  // The built bar names an agent after how it stands; the design's, by its name alone.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("button", { name: /(^| )Docs$/ })
    .click();
  await page.getByRole("main").getByRole("button", { name: "Message", exact: true }).click();
  await chats(page).getByRole("heading", { name: "Docs" }).waitFor();
}

/** What a refused send says, on both sides. */
export const REFUSAL = "It isn't connected right now. Try again in a moment.";

/**
 * A send is refused: the design's from its own control, the built side's by its service. What
 * was refused is back in the built side's box; emptied and left, the box is as the design's is.
 */
export async function refuseSend(page: Page, gateway?: Gateway) {
  if (!gateway) await inDesign(page, "Refused");
  else {
    gateway.refuseNext("chat.send", "unavailable", REFUSAL);
    const box = chats(page).getByRole("textbox", { name: "Message" });
    await box.fill("And the tests?");
    await chats(page).getByRole("button", { name: "Send" }).click();
    await chats(page).getByRole("alert").waitFor();
    await box.fill("");
    await box.blur();
  }
  await chats(page).getByRole("alert").getByText(REFUSAL).waitFor();
}

const FROM = { provider: "units", providerName: "AgentOrg" };
const skillsOf = (...names: string[]) => names.map((name) => ({ name, files: ["SKILL.md"] }));
const BUILD_BASES: Creatable[] = [
  {
    provider: "bundled",
    id: "assistant",
    title: "Assistant",
    description: "Chats and uses what you connect",
    instructions: "Help.",
    asks: [],
  },
];
const BUILD_UNITS: Units["units"] = [
  {
    ...FROM,
    id: "computer",
    title: "Computer",
    description: "A place to run commands and keep files",
    needs: [],
    gives: {
      slots: [{ name: "computer" }],
      skills: skillsOf("terminal", "files", "computer", "browser"),
      results: ["computer"],
    },
    form: [
      {
        id: "where",
        type: "choice",
        value: "string",
        title: "Where it resides",
        required: true,
        options: [
          {
            value: "local",
            title: "This computer",
            description: "Runs as you, with your files and no approvals.",
            caution: true,
          },
          {
            value: "container",
            title: "A new container",
            description: "Kept apart from your files and programs.",
          },
        ],
      },
      {
        id: "workspace",
        type: "directory",
        value: "string",
        title: "Workspace directory",
        description: "The folder it works in. Removing the agent leaves it.",
        required: true,
        placeholder: "~/Agents/{name}",
        visible: { field: "where", in: ["local"] },
      },
      {
        id: "access",
        type: "choice",
        value: "string",
        title: "What it reaches",
        required: true,
        default: "terminal",
        options: [
          {
            value: "terminal",
            title: "Files and terminal",
            description: "It can run any command.",
          },
          {
            value: "files",
            title: "Files",
            description: "It reads and changes files, and runs nothing.",
          },
        ],
      },
      {
        id: "browser",
        type: "choice",
        value: "string",
        title: "Browser",
        required: true,
        default: "on",
        options: [
          { value: "on", title: "With a browser", description: "It opens pages and acts on them." },
          { value: "off", title: "No browser" },
        ],
        visible: { field: "access", in: ["terminal"] },
      },
    ],
  },
  {
    ...FROM,
    id: "web",
    title: "Web",
    description: "Search the web and read pages",
    needs: [],
    gives: { slots: [{ name: "web" }], skills: skillsOf("web-research"), results: [] },
    form: [
      {
        id: "service",
        type: "choice",
        value: "string",
        title: "Service",
        required: true,
        default: "exa",
        options: [{ value: "exa", title: "Exa" }],
      },
    ],
  },
  {
    ...FROM,
    id: "agents",
    title: "Agent control",
    description: "Lets it create agents of its own",
    needs: [],
    gives: { slots: [{ name: "agents" }], skills: skillsOf("delegating"), results: [] },
    form: [
      {
        id: "templates",
        type: "choices",
        value: "strings",
        title: "Templates it may use",
        required: true,
        options: [
          { value: "assistant", title: "Assistant" },
          { value: "builder", title: "Builder" },
          { value: "repo-worker", title: "Storefront worker" },
        ],
      },
      {
        id: "places",
        type: "choices",
        value: "strings",
        title: "Where new agents go",
        required: true,
        options: [
          { value: "own", title: "In its own directory", description: "They share its files." },
          { value: "remote", title: "On an existing remote place" },
          {
            value: "new",
            title: "On a new computer",
            description: "Each gets a computer of its own.",
          },
        ],
      },
      {
        id: "named",
        type: "text",
        value: "string",
        title: "Remote places",
        required: true,
        placeholder: "build.acme.dev",
        visible: { field: "places", in: ["remote"] },
      },
      {
        id: "limit",
        type: "number",
        value: "number",
        title: "How many at once",
        description: "More than this wait their turn.",
        required: true,
        default: 3,
        min: 0,
      },
      {
        id: "depth",
        type: "number",
        value: "number",
        title: "Levels below it",
        required: true,
        default: 1,
        min: 0,
      },
    ],
  },
  {
    ...FROM,
    id: "skill",
    title: "Skill",
    description: "One of your skills",
    needs: [],
    gives: { slots: [], skills: [], results: [] },
    form: [
      {
        id: "skill",
        type: "choice",
        value: "string",
        title: "Skill",
        required: true,
        options: [{ value: "survey-a-topic", title: "survey-a-topic" }],
      },
    ],
  },
  {
    ...FROM,
    id: "connection",
    title: "Connection",
    description: "An MCP you've connected",
    needs: [],
    gives: { slots: [], skills: [], results: [] },
    form: [
      {
        id: "connection",
        type: "connection",
        value: "string",
        title: "Connection",
        required: true,
      },
    ],
  },
];
const BUILD_BASE = { provider: "AgentOrg", creatable: "assistant" };
const BUILD_TEMPLATES: Template[] = [
  {
    id: "assistant",
    shipped: true,
    title: "Assistant",
    description: "Works on a computer and on the web",
    base: BUILD_BASE,
    units: [
      { provider: "AgentOrg", unit: "computer" },
      { provider: "AgentOrg", unit: "web", values: { service: "exa" } },
    ],
  },
  {
    id: "builder",
    shipped: true,
    title: "Builder",
    description: "Makes and runs other agents",
    base: BUILD_BASE,
    units: [
      { provider: "AgentOrg", unit: "computer" },
      { provider: "AgentOrg", unit: "agents", values: { limit: 3, depth: 1 } },
    ],
  },
  {
    id: "repo-worker",
    title: "Storefront worker",
    description: "Works in the storefront repository",
    base: BUILD_BASE,
    units: [
      {
        provider: "AgentOrg",
        unit: "computer",
        values: {
          where: "local",
          workspace: "~/code/storefront",
          access: "terminal",
          browser: "off",
        },
      },
      { provider: "AgentOrg", unit: "web", values: { service: "exa" } },
    ],
  },
];

/** What an agent is built from, as the design's sample has it: one base, its units, its templates. */
export const sampleBuild = (gateway: Gateway) =>
  gateway.setCatalog({ bases: BUILD_BASES, units: BUILD_UNITS, templates: BUILD_TEMPLATES });

/**
 * The create window's states, each with the widths it is shown at: an empty stack; a template
 * with an answer chosen that grants something; one whose unit has boxes to tick and numbers; a
 * card folded; its two menus; saving the stack as a template; made while signed out of the model
 * account; and a new template.
 */
export const CREATES = [
  ["empty", ["wide", "phone"]],
  ["local", ["wide", "phone"]],
  ["builder", ["wide"]],
  ["folded", ["wide"]],
  ["add", ["wide"]],
  ["options", ["wide"]],
  ["save", ["wide"]],
  ["out", ["wide"]],
  ["template", ["wide"]],
] as const;
export type Create = (typeof CREATES)[number][0];

/** The create window in one of its states, reached as a person reaches it, and at rest. */
export async function createState(page: Page, state: Create, design: boolean) {
  const bar = async () => {
    if ((page.viewportSize()?.width ?? 0) < 640)
      await page.getByRole("button", { name: "Menu" }).click();
    return page.getByRole("navigation", { name: "Main" }).last();
  };
  if (state === "out" && design) await inDesign(page, /^ChatGPT:/);
  if (state === "template") {
    await (await bar()).getByRole("button", { name: "Templates" }).click();
    await page.getByRole("main").getByRole("button", { name: "New template", exact: true }).click();
  } else await (await bar()).getByRole("button", { name: "Create", exact: true }).click();
  const window = page.getByRole("dialog", {
    name: state === "template" ? "New template" : "Create",
  });
  await window.getByRole("list", { name: "Units" }).waitFor();
  const from = (name: string) =>
    window.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  const card = (name: string) => window.getByRole("listitem", { name });
  if (state === "local" || state === "folded" || state === "out") {
    await from("Assistant");
    await card("Web").waitFor();
  }
  if (state === "local") {
    await window.getByRole("combobox", { name: "Where it resides" }).click();
    await page.getByRole("option", { name: "This computer" }).click();
    await window.getByLabel("Workspace directory").waitFor();
  }
  if (state === "folded") await window.getByRole("button", { name: "Fold Computer" }).click();
  if (state === "builder" || state === "save") {
    await from("Builder");
    await card("Agent control").waitFor();
  }
  if (state === "add") {
    await window.getByRole("button", { name: "Add a unit" }).click();
    await page.getByRole("menu").waitFor();
  }
  if (state === "options" || state === "save") {
    await window.getByRole("button", { name: "Build options" }).click();
    await page.getByRole("menu").waitFor();
  }
  if (state === "save") {
    await page.getByRole("menuitem", { name: /^Save as template/ }).click();
    await page.getByRole("dialog", { name: "Save as template" }).waitFor();
  }
  // A press scrolls what it presses into view, by more one time than another: back to the start.
  await page.locator('nav[aria-label="Start from"]').evaluate((row) => {
    row.scrollLeft = 0;
  });
}

/** The Templates page, reached from the bar as a person reaches it, with its rows read. */
export async function openTemplates(page: Page) {
  if ((page.viewportSize()?.width ?? 0) < 640)
    await page.getByRole("button", { name: "Menu" }).click();
  await page
    .getByRole("navigation", { name: "Main" })
    .last()
    .getByRole("button", { name: "Templates" })
    .click();
  const main = page.getByRole("main");
  await main.getByRole("tab", { name: "Templates", selected: true }).waitFor();
  await main.getByText("Storefront worker").waitFor();
}

/** The sections of Settings that have a page of their own to measure, by their tab's words. */
export const SECTIONS = [
  ["skills", "Skills"],
  ["mcps", /^MCP/],
  ["providers", "Providers"],
  ["account", "Account"],
] as const;
export type Section = (typeof SECTIONS)[number][0];

/** One of Settings' sections, reached from the bar and then its tab, with its page read. */
export async function openSection(page: Page, section: Section) {
  if ((page.viewportSize()?.width ?? 0) < 640)
    await page.getByRole("button", { name: "Menu" }).click();
  await page
    .getByRole("navigation", { name: "Main" })
    .last()
    .getByRole("button", { name: "Settings" })
    .click();
  const main = page.getByRole("main");
  const name = SECTIONS.find(([id]) => id === section)?.[1] ?? "";
  await main.getByRole("tab", { name }).click();
  await main.getByRole("tab", { name, selected: true }).waitFor();
  await main.locator("li, section").first().waitFor();
}

/** What a section offers, opened from the end of the row: Skills' and MCP connections' dialogs. */
export async function openOffer(page: Page, section: "skills" | "mcps") {
  await openSection(page, section);
  const [offer, title] =
    section === "skills" ? ["Add skill", "Add skill"] : ["Connect", "Connect an MCP"];
  await page.getByRole("main").getByRole("button", { name: offer, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: title });
  await dialog.getByRole("textbox").first().waitFor();
  await dialog.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
}

/**
 * What Settings lists, as the design's sample has it where it shows: the agents, the first skill
 * in use by one of them, and as many tools on the first and last connections as the design's
 * have, since on a phone a row is as wide as its count's words leave.
 */
export function sampleSettings(gateway: Gateway) {
  sampleAgents(gateway);
  (gateway.agents.get("a-research") as Agent).skills.unshift({
    name: "cite-sources",
    description: "Links every claim to its source",
  });
  const listed = [...gateway.connections.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const [connection, count] of [
    [listed[0], 38],
    [listed.at(-1), 6],
  ] as const) {
    const tool = connection?.status.tools[0];
    if (connection && tool)
      connection.status.tools = Array.from({ length: count }, (_, n) => ({
        ...tool,
        name: `${tool.name}_${n}`,
      }));
  }
}
