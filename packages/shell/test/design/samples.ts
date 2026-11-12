// What the built side is given for the measured screens, as the design's sample has it: its
// agents and computer and terminals, replies not yet read, sample chats to open, and what a page asks; and
// the design page's own controls, which put it in the cases it draws.
import type { Page } from "@playwright/test";
import type { Agent, Creatable, standIn, Template, Units } from "../stand-in.ts";

type Gateway = Awaited<ReturnType<typeof standIn>>;

/** Once the shell has begun its note of what is read: a reply said from here on is new. */
export async function noted(gateway: Gateway) {
  while (!gateway.notes.has("ui/read")) await new Promise((done) => setTimeout(done, 20));
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
  if (n === 1) gateway.addMessage("a-reviewer", reply);
  else if (n === 2) gateway.addMessage("a-research", reply);
  else {
    gateway.addChat("a-triage", { id: "c-triage", title: "Route today's issues", said: [] });
    gateway.sayIn("a-triage", "c-triage", reply);
  }
}

/** A chat with nothing unread, to be seen beside the unread ones. */
export function readChat(gateway: Gateway) {
  gateway.addChat("a-research", {
    id: "c-read",
    title: "Which issues are oldest?",
    said: [
      { id: "said-1", role: "user", text: "Which issues are oldest?", at: "2026-01-01T10:00:00Z" },
    ],
  });
}

/** A case the design draws for a chat, which the built side's sample chat can be given. */
export type ChatCase = "noCall" | "limit" | "long";

/**
 * Two chats as the design's sample has them: one with a call and a reply, one with a problem. The
 * first can be given a case the design draws for a chat: a step with no call, the plan's limit
 * reached, or more said in it than a page holds.
 */
export function sampleChats(gateway: Gateway, given?: ChatCase) {
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  gateway.addChat("a-reviewer", {
    id: "c-review",
    title: "Review #482",
    ...(given === "limit"
      ? { problem: { code: "usage_limit", message: "You've reached your plan's limit." } }
      : {}),
    said: [
      ...(given === "long"
        ? Array.from({ length: 120 }, (_, n) => ({
            id: `v-old-${n}`,
            role: "assistant" as const,
            text: `An earlier note, ${n}.`,
            at: at(2000 - n),
          }))
        : []),
      { id: "v-u1", role: "user", text: "Review #482 before I merge it.", at: at(13) },
      ...(given === "noCall"
        ? [
            {
              id: "v-n1",
              role: "tool" as const,
              text: "Looked at the pull request",
              at: at(12),
            },
          ]
        : []),
      {
        id: "v-t1",
        role: "tool",
        text: "github_acme__get_file_contents",
        at: at(12),
        tool: {
          name: "github_acme__get_file_contents",
          state: "done",
          input: '{ "path": "src/cart/coupon.ts" }',
          output: "export function applyCoupon(cart, code) { … }",
        },
      },
      {
        id: "v-a1",
        role: "assistant",
        text: "Three comments on #482. The one that matters: `applyCoupon` runs before the cart is priced, so a percentage coupon is taken off zero. The other two are naming.",
        at: at(12),
      },
    ],
  });
  gateway.addChat("a-triage", {
    id: "c-route",
    title: "Route today's issues",
    said: [{ id: "t-u1", role: "user", text: "Route today's new issues.", at: at(60) }],
    problem: { code: "failed", message: "linear is down, so its tools are left out" },
  });
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
  gateway.addChat("a-weekly", {
    id: "c-monday",
    title: "Monday's numbers",
    said: [
      {
        id: "monday-1",
        role: "assistant",
        text: "Signups were up 4% on the week before.",
        at: new Date(Date.now() - 2 * 24 * 3600_000).toISOString(),
      },
    ],
  });
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
    { name: "terminal", description: "Runs commands, including long ones" },
    { name: "files", description: "Reads, searches and edits files" },
    { name: "computer", description: "Where things are, what persists, installing software" },
    { name: "browser", description: "Drives a browser, page by page" },
    { name: "web-research", description: "Searches, then reads the sources" },
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
    await main.getByRole("button", { name: "Message" }).click();
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

/** Opens the sample chat that has a call and a reply, from the list. */
export async function openSampleChat(page: Page) {
  if (!(await chats(page).count())) await page.getByRole("button", { name: /^Chats/ }).click();
  await chats(page)
    .getByRole("button", { name: /Review #482/ })
    .click();
  await chats(page).getByRole("heading", { name: "Review #482" }).waitFor();
}

/** Opens a chat about to be started, with the first agent that can be picked. */
export async function newChatWithFirst(page: Page) {
  if (!(await chats(page).count())) await page.getByRole("button", { name: /^Chats/ }).click();
  await chats(page).getByRole("button", { name: "New chat" }).click();
  await chats(page)
    .getByRole("list", { name: "Who with" })
    .locator("button:enabled")
    .first()
    .click();
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
          },
          { value: "container", title: "A new container" },
        ],
      },
      {
        id: "workspace",
        type: "directory",
        value: "string",
        title: "Workspace directory",
        required: true,
        placeholder: "~/Agents/Scout",
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
          { value: "terminal", title: "Files and terminal" },
          { value: "files", title: "Files" },
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
          { value: "on", title: "With a browser" },
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
          { value: "own", title: "In its own directory" },
          { value: "remote", title: "On an existing remote place" },
          { value: "new", title: "On a new computer" },
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
