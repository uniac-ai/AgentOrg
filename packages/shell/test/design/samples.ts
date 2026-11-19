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
/**
 * The first start as the design's sample has it: one agent, Assistant, with a computer and with
 * nothing said to it yet.
 */
export function firstStart(gateway: Gateway) {
  likeAgent(gateway, "assistant", "Assistant", "Works on a computer and on the web");
  for (const id of [...gateway.agents.keys()]) if (id !== "assistant") gateway.agents.delete(id);
  gateway.noChats();
  computer(
    gateway,
    [
      { surface: "terminal", protocol: "terminal@1", operate: true },
      { surface: "files", protocol: "files@1", operate: true },
    ],
    "assistant",
  );
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
/**
 * Support, whose computer an earlier version made with no isolation, as the design's sample has
 * it: not started, with the ways on that the computer's provider gives.
 */
export function supportBefore(gateway: Gateway) {
  likeAgent(gateway, "a-support", "Support", "Answers the support inbox from the docs");
  computer(gateway, [], "a-support");
  gateway.setHeld("a-support", [
    heldComputer({
      // What it was, and the folder kept, as the design's sample says them.
      views: [
        {
          id: "where",
          place: "column",
          kind: "facts",
          fixed: [{ label: "Computer", value: "No isolation", note: "No longer made" }],
        },
        {
          id: "workspace",
          place: "column",
          kind: "facts",
          fixed: [{ label: "Its folder, kept", value: "~/Agents/Support", path: true }],
        },
      ],
      state: "down",
      detail:
        "A computer with no isolation is no longer made. Its folder is kept at ~/Agents/Support. Either way, its own browser and what it was signed in to aren't kept.",
      from: "i-computer",
      ways: [
        {
          title: "Attach this computer",
          description:
            "Its work happens in ~/Agents/Support, as before. Unlike before, it reaches the whole machine, as you.",
          unit: "computer",
          values: { where: "local", workspace: "~/Agents/Support", access: "terminal" },
        },
        {
          title: "Make a container",
          description: "Its workspace starts with what's in ~/Agents/Support.",
          unit: "computer",
          values: { where: "container", access: "terminal" },
        },
      ],
    }),
  ]);
}
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

/** Opens the conversation between Release notes and Research, from Release notes' details. */
export async function openBetween(page: Page) {
  await openAgent(page, "Release notes", "Chats");
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

const FENCE = "```";
/**
 * The design's sample conversations for a reply's bubbles: Research's, asked a one-line question,
 * asked for a long reply, and given work it answers with a receipt and later its result.
 */
export const SAID = {
  oneLineAsk: "How much free disk space is there?",
  oneLine: "There's 212 GB free of 494 GB.",
  longAsk: "What's in README.md?",
  long: `It's a small shop demo: a storefront, a cart and a fake card service.

The README is about 300 words. Most of it says how to run the demo and test it.

The code is in three folders, one for each part:

- **web**: the storefront's pages and styles
- **cart**: pricing, coupons and the checkout session
- **pay**: a stand-in for the card processor

To run it, the README gives one command:

${FENCE}sh
npm install && npm run dev
${FENCE}`,
  workAsk: "Go through the shop demo and write every TODO with its file and line to todos.md.",
  receipt: "I'll write every TODO in the shop demo to todos.md, with its file and line.",
  result: `todos.md has all 12 TODOs, from 5 files, each with its line.

Half are in the cart folder, and four of those are about coupons.`,
  unasked: `Two TODOs were added to pay/refund.ts after I wrote todos.md, so it's missing them.

Should I add them?`,
};
/** A reply as the design writes it out: a word at a time, a list's mark with the word after it. */
export const chunksOf = (text: string) => text.match(/(?:[-*+]|\d+\.)[ \t]+\S+\s*|\S+\s*/g) ?? [];
/** The long reply as far as the design has written it 3.5 s in. */
export const WRITTEN_SO_FAR = chunksOf(SAID.long).slice(0, 48).join("");

/** Research's conversation at one of the design's moments for a reply's bubbles, by its control. */
export const MOMENTS = {
  oneLine: "A one-line answer",
  long: "A long reply",
  receipt: "A receipt, the work going on",
  result: "The result arrived",
  unasked: "A message nobody asked for",
  writing: "A reply being written",
} as const;
export type Moment = keyof typeof MOMENTS;
/**
 * Research's conversation, built, at one of those moments, as the design's control puts it: each
 * moment its own conversation, Research working while the work goes on or a reply is written. A
 * reply being written is written as far as the design has it at the moment it is shown.
 */
export function researchSays(gateway: Gateway, moment: Moment) {
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const ask = (id: string, text: string, ago: number) => ({
    id,
    role: "user" as const,
    text,
    at: at(ago),
  });
  const said = (id: string, text: string, ago: number) => ({
    id,
    role: "assistant" as const,
    text,
    at: at(ago),
  });
  gateway.converse(
    "a-research",
    moment === "oneLine"
      ? [ask("v-u1", SAID.oneLineAsk, 2), said("v-a1", SAID.oneLine, 1)]
      : moment === "long"
        ? [ask("v-u2", SAID.longAsk, 2), said("v-a2", SAID.long, 1)]
        : moment === "writing"
          ? [ask("v-u2", SAID.longAsk, 1)]
          : [
              ask("v-u3", SAID.workAsk, 6),
              said("v-a3", SAID.receipt, 5),
              ...(moment === "receipt" ? [] : [said("v-a4", SAID.result, 2)]),
              ...(moment === "unasked" ? [said("v-a5", SAID.unasked, 1)] : []),
            ],
  );
  gateway.setChatStatus("a-research", {
    state: moment === "receipt" || moment === "writing" ? "working" : "idle",
  });
}
/** The reply being written, as far as the design has it: the words that have come. */
export const writeSoFar = (gateway: Gateway) => gateway.delta("a-research", "v-a2", WRITTEN_SO_FAR);

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
    { surface: "presence", protocol: "presence@1", operate: false },
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

/** Research working, in its browser and on its screen, as the design's sample has it. */
const RESEARCH_ACTING: { who: "agent"; name: string; capability: string }[] = [
  { who: "agent", name: "Research", capability: "browser" },
  { who: "agent", name: "Research", capability: "screen" },
];

/**
 * The agents as the design's sample has them, for the design measurement: those of `sampleAgents`,
 * made from the design's units, with Research as the design builds it. Its computer is this one,
 * from the design's Computer unit, with your screen and your browser, and it is working in its
 * browser and on its screen. Its model is GPT-5.5, and its web is an MCP made for it.
 */
export function designAgents(gateway: Gateway) {
  sampleAgents(gateway);
  sampleBuild(gateway);
  gateway.models.splice(
    0,
    gateway.models.length,
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.5-mini", name: "GPT-5.5 mini" },
  );
  const research = gateway.agents.get("a-research") as Agent;
  research.model = "gpt-5.5";
  const [built] = research.units as NonNullable<Agent["units"]>;
  if (built) {
    built.values = {
      kind: "this",
      workspace: "~/Agents/Research",
      access: "terminal",
      screen: "on",
      browser: "yours",
    };
    built.status.surfaces = built.status.surfaces?.flatMap((one) =>
      one.surface === "browser"
        ? [one, { surface: "screen", protocol: "screen@1", operate: true }]
        : [one],
    );
  }
  gateway.presence(RESEARCH_ACTING);
  // Its web, made for it by its Web unit.
  const notes = gateway.connections.get("c-notes");
  if (notes?.origin)
    gateway.connections.set("c-web", {
      ...notes,
      connection: "c-web",
      name: "Web for Research",
      origin: { ...notes.origin, kind: "url", target: "https://mcp.exa.ai" },
      status: {
        state: "connected",
        tools: [{ name: "web_search_exa" }, { name: "web_fetch_exa" }],
      },
    });
  research.mcp = research.mcp.map((one) =>
    one.slot === "web" ? { slot: "web", connection: "c-web", instance: "i-web" } : one,
  );
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
  // Its browser, terminal, files and load, as the computer's capability declares them.
  surfaces: 4,
  protocols: ["screencast@1", "terminal@1", "files@1", "metrics@1"],
  slots: ["computer"],
  // As the design's sample has it: this computer, what it acts as (asked of it while it can be
  // reached), where its work happens, what it reaches and its browser.
  views: [
    {
      id: "where",
      place: "column",
      kind: "facts",
      fixed: [{ label: "Computer", value: "This computer" }],
    },
    { id: "load", place: "column", kind: "meters", when: "reachable", surface: "load" },
    {
      id: "acts",
      place: "column",
      kind: "facts",
      when: "reachable",
      operation: "about",
      slot: "computer",
      rows: ["Acts as"],
    },
    {
      id: "workspace",
      place: "column",
      kind: "facts",
      fixed: [
        {
          label: "Its work happens in",
          value: "~/Agents/Research",
          path: true,
          note: "Said to it, not a wall",
        },
        { label: "Reaches", value: "Files and terminal, your screen" },
        { label: "Browser", value: "Your browser", note: "Signed in as you" },
      ],
    },
    // Who is acting on it now, after what it is.
    { id: "in-use", place: "column", kind: "presence", when: "reachable", surface: "presence" },
  ],
  about: [
    { label: "Acts as", value: "You, with all you can reach", caution: true },
    { label: "Not shown", value: "not one the view names" },
  ],
  ...over,
});

/**
 * An agent's details, reached as a person reaches them, in the design and built: the bar's Team,
 * the agent's row, then its tab.
 */
export async function openAgent(page: Page, name: string, tab?: string) {
  await toTeam(page);
  await page
    .getByRole("main")
    .getByRole("list", { name: "Agents" })
    .getByRole("button", { name: new RegExp(name) })
    .click();
  await page.getByRole("main").getByRole("heading", { name, level: 1 }).waitFor();
  if (tab) await page.getByRole("main").getByRole("tab", { name: tab }).click();
}
/** An agent's details in the design. */
export const openDesignAgent = openAgent;
/** Team, from the bar, in the design and built. */
export const toTeam = (page: Page) =>
  page
    .getByRole("navigation", { name: "Main" })
    .getByRole("button", { name: "Team", exact: true })
    .click();

/** An agent's setup, opened from its page: read, and slid in, so nothing in it still moves. */
export async function openSetup(page: Page, name: string) {
  await page.getByRole("main").getByRole("button", { name: "Setup" }).click();
  const sheet = page.getByRole("dialog", { name: `${name}'s setup` });
  await sheet.getByRole("region", { name: "Skills" }).waitFor();
  await sheet.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
  return sheet;
}

/**
 * The person acting in one of Research's windows, the most recent, as its computer says it: what
 * the design counts a press or a key in a window as, for a few seconds. Research works on.
 */
export const youActed = (gateway: Gateway, capability = "browser") =>
  gateway.presence([{ who: "person", capability }, ...RESEARCH_ACTING]);

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
 * account already stands that way; the design is put there by its own controls. Built, the way in
 * takes the tab to ChatGPT's page, so the wait is shown with the sign-in's start held.
 */
export async function signInState(page: Page, state: SignIn, design: boolean, gateway?: Gateway) {
  const main = page.getByRole("main");
  if (design) {
    if (state === "gone") return inDesign(page, /^AgentOrg:/);
    // Its control goes from signed in to signed out, to starting, to not eligible.
    const presses = state === "starting" ? 2 : state === "ineligible" ? 3 : 1;
    for (let n = 0; n < presses; n++) await inDesign(page, /^ChatGPT:/);
    if (state === "line" || state === "chat") await openDesignAgent(page, "Reviewer");
  } else if (state === "gone") return main.getByRole("heading", { name: "AgentOrg" }).waitFor();
  if (state === "line")
    return main
      .getByRole("status", { name: "State" })
      .getByText("Agents can't work until you sign in with ChatGPT.")
      .waitFor();
  if (state === "chat") {
    await main.getByRole("button", { name: "Message", exact: true }).click();
    return page.getByRole("group", { name: "Sign in to send" }).waitFor();
  }
  const place = page.getByRole("region", { name: "Set up" });
  await place.waitFor();
  if (state !== "waiting") return;
  gateway?.hold("login.start");
  // ChatGPT's page is answered here: nothing leaves this computer.
  await page
    .context()
    .route("https://auth.example/**", (route) => route.fulfill({ body: "ChatGPT" }));
  await place.getByRole("button", { name: "Continue with ChatGPT" }).click();
  await place.getByRole("button", { name: "Waiting for ChatGPT…" }).waitFor();
}

/** An agent stopped as something other than its page stops it: its page has no Stop. */
export function stopElsewhere(gateway: Gateway, agent: string) {
  const held = gateway.agents.get(agent) as Agent;
  held.status = { state: "stopped" };
  if (held.chat.status.state === "working") gateway.setChatStatus(agent, { state: "idle" });
  gateway.changed();
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
  // The layer's chats are over every place but Chat, which is a chat of its own: from Team, then.
  if (!(await chats(page).count())) {
    const tab = page.getByRole("button", { name: /^Chats/ });
    if (!(await tab.count())) await toTeam(page);
    await tab.click();
  }
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

/** Opens your conversation with Docs, never messaged, by its details' Message. */
export async function messageDocs(page: Page) {
  await openAgent(page, "Docs");
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
    description: "Talks with you and works with what it is given",
    instructions: "Help.",
    asks: [],
  },
];
const BUILD_UNITS: Units["units"] = [
  {
    ...FROM,
    id: "computer",
    title: "Computer",
    description: "Where it runs commands, keeps files and acts on a screen",
    needs: [],
    gives: {
      slots: [{ name: "computer" }],
      skills: skillsOf("terminal", "files", "computer", "browser"),
      results: ["computer"],
    },
    form: [
      {
        id: "kind",
        type: "choice",
        value: "string",
        title: "Which computer",
        required: true,
        options: [
          {
            value: "this",
            title: "This computer",
            description:
              "The whole machine: your files, apps, screen and signed-in browser. It acts as you, with everything you can reach.",
            caution: true,
          },
          {
            value: "new",
            title: "A new computer",
            description: "Made for this agent and kept apart from yours.",
          },
        ],
      },
      {
        id: "workspace",
        type: "directory",
        value: "string",
        title: "Where its work happens",
        description: "It's told to work here. Not a wall: the rest of your computer is open to it.",
        required: true,
        placeholder: "~/Agents/{name}",
        visible: { field: "kind", in: ["this"] },
      },
      {
        id: "made",
        type: "choice",
        value: "string",
        title: "Made as",
        required: true,
        default: "container",
        visible: { field: "kind", in: ["new"] },
        options: [
          {
            value: "container",
            title: "A container on this machine",
            description: "Commands and files, apart from yours.",
          },
          {
            value: "vm",
            title: "A virtual machine on this machine",
            unavailable: "The provider here can't make virtual machines yet.",
          },
          {
            value: "remote",
            title: "At another address",
            description: "A computer provider there makes it.",
          },
        ],
      },
      {
        id: "address",
        type: "text",
        value: "string",
        title: "Provider's address",
        required: true,
        placeholder: "computers.acme.dev",
        visible: { field: "made", in: ["remote"] },
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
        id: "screen",
        type: "choice",
        value: "string",
        title: "Screen",
        required: true,
        default: "on",
        visible: { field: "kind", in: ["this"] },
        options: [
          {
            value: "on",
            title: "Your screen",
            description: "It sees your screen and acts on it, as you would.",
          },
          { value: "off", title: "No screen" },
        ],
      },
      {
        id: "browser",
        type: "choice",
        value: "string",
        title: "Browser",
        required: true,
        default: "yours",
        visible: { field: "kind", in: ["this"] },
        options: [
          {
            value: "yours",
            title: "Your browser",
            description: "Signed in as you: it acts as you on every site you're signed in to.",
            caution: true,
          },
          { value: "none", title: "No browser" },
        ],
      },
      // A new computer's own browser goes with it; yours is an explicit pick, with the same caution.
      {
        id: "madeBrowser",
        type: "choice",
        value: "string",
        title: "Browser",
        required: true,
        default: "own",
        visible: { field: "kind", in: ["new"] },
        options: [
          {
            value: "own",
            title: "Its own browser",
            description: "In the computer made for it, apart from yours.",
          },
          {
            value: "yours",
            title: "Your browser",
            description: "Signed in as you: it acts as you on every site you're signed in to.",
            caution: true,
          },
          { value: "none", title: "No browser" },
        ],
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
        values: { kind: "this", workspace: "~/code/storefront" },
      },
      { provider: "AgentOrg", unit: "web", values: { service: "exa" } },
    ],
  },
];

/** What an agent is built from, as the design's sample has it: one base, its units, its templates. */
export const sampleBuild = (gateway: Gateway) =>
  gateway.setCatalog({ bases: BUILD_BASES, units: BUILD_UNITS, templates: BUILD_TEMPLATES });

/**
 * New template's window, which builds a stack in its options, in its states, each with the widths
 * it is shown at: an empty stack, as it opens; a template with an answer chosen that grants
 * something; a name and what it's for typed on its card; one whose unit has boxes to tick and
 * numbers; a card folded; the menu that adds a unit; its rail, the options scrolled between two
 * headings, and with the keyboard in it so its labels show; and each unit's line.
 */
export const CREATES = [
  ["empty", ["wide", "phone"]],
  ["local", ["wide", "phone"]],
  ["typed", ["wide", "phone"]],
  ["builder", ["wide"]],
  ["folded", ["wide"]],
  ["add", ["wide"]],
  ["between", ["wide", "phone"]],
  ["labels", ["wide"]],
  ["line-ready", ["wide", "rail", "phone"]],
  ["line-part", ["wide"]],
  ["line-none", ["wide"]],
  ["line-every", ["wide"]],
] as const;
export type Create = (typeof CREATES)[number][0];

const READY =
  "Sam's Mac mini, whole: your files and apps, its screen and your signed-in browser. It acts as you, with everything you can reach.";
/**
 * A unit's own line, at the design's states: what a computer already there says of itself (ready,
 * with a part not ready, and not to be had), and every unit with what it says. Each by the design's
 * control, and what the built side's Computer says, with a name that is nobody's.
 */
const LINES = {
  "line-ready": { control: "Computer ready", says: READY },
  "line-part": {
    control: "A part not ready",
    says: `${READY} Screen is turned off in the AgentOrg app.`,
  },
  "line-none": {
    control: "Not to be had",
    says: "The AgentOrg app isn't open on this Mac. Open it to use this computer.",
  },
  "line-every": { control: "Every unit's line", says: undefined },
} as const;
const lineOf = (state: Create) => (state in LINES ? LINES[state as keyof typeof LINES] : undefined);
/** The built side's Computer says what the state has it say, before the page is read. */
export function computerSays(gateway: Gateway, state: Create) {
  const says = lineOf(state)?.says;
  if (says) gateway.describeUnit("computer", says);
}

/**
 * The unit window's states: Change… on Research's computer, stated by its connector with a line
 * that says it is ready, that its screen is off, or what to install; and a way forward's window,
 * the computer ready. Each with the widths it is shown at, the design's control, and what the
 * built side's Computer says, with a name that is nobody's.
 */
export const WINDOWS = [
  ["change-ready", ["wide"]],
  ["change-part", ["wide", "phone"]],
  ["change-install", ["wide", "phone"]],
  ["way", ["wide"]],
] as const;
export type UnitWindow = (typeof WINDOWS)[number][0];
const WINDOW_SAYS: Record<UnitWindow, { control: string; says: string; off?: "screen" }> = {
  "change-ready": { control: "Change…, ready", says: READY },
  "change-part": {
    control: "Change…, a part not ready",
    says: "Sam's Mac mini, whole: your files and apps and your signed-in browser. It acts as you, with everything you can reach. Screen is turned off in the AgentOrg app. Turn it on there to choose it.",
    off: "screen",
  },
  "change-install": {
    control: "Change…, not to be had",
    says: "AgentComputer isn't installed on this computer. Install it with npm install -g @agentorg/computer and try again. AgentOrg starts it for you.",
  },
  way: { control: "A way forward", says: READY },
};
/** As the design's Research was filled in, in the stated Computer's own questions. */
const STATED_RESEARCH = {
  workspace: "~/Agents/Research",
  access: "terminal",
  screen: "on",
  ownBrowser: "yours",
};

/**
 * The built side at a state of the unit window, after the design's agents: the Computer stated as
 * the state has it, and Research built from it; for a way forward, Research's computer can't be
 * reached and its provider offers the design's two ways.
 */
export function windowSays(gateway: Gateway, state: UnitWindow) {
  const { says, off } = WINDOW_SAYS[state];
  gateway.stateComputer(says, off);
  const research = gateway.agents.get("a-research") as Agent;
  const [built] = research.units ?? [];
  if (built) built.values = { ...STATED_RESEARCH };
  if (state === "way")
    research.held = [
      heldComputer({
        state: "down",
        detail:
          "A computer with no isolation is no longer made. Its folder is kept at ~/Agents/Research. Either way, its own browser and what it was signed in to aren't kept.",
        from: "i-computer",
        ways: [
          {
            title: "Attach this computer",
            description:
              "Its work happens in ~/Agents/Research, as before. Unlike before, it reaches the whole machine, as you.",
            unit: "computer",
            values: { ...STATED_RESEARCH },
          },
          { title: "Make a container", unit: "computer", values: { access: "terminal" } },
        ],
      }),
    ];
}

/**
 * The unit window at one of its states, reached as a person reaches it (Research's setup, its
 * computer's "…", Change…; or its computer's way forward) or by the design's control, and at rest.
 */
export async function windowState(page: Page, state: UnitWindow, design: boolean) {
  if (design) await inDesign(page, WINDOW_SAYS[state].control);
  else if (state === "way")
    await page
      .getByRole("main")
      .getByRole("region", { name: "Research's computer" })
      .getByRole("button", { name: "Attach this computer" })
      .click();
  else {
    const sheet = await openSetup(page, "Research");
    await sheet
      .getByRole("region", { name: /^Built from/ })
      .getByRole("button", { name: "Computer options" })
      .click();
    await page.getByRole("menuitem", { name: "Change…" }).click();
  }
  const window = page.getByRole("dialog", { name: /'s computer$/ });
  await window.waitFor();
  await window.evaluate((e) =>
    Promise.allSettled(
      e
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished),
    ),
  );
}

/** The create window in one of its states, reached as a person reaches it, and at rest. */
export async function createState(page: Page, state: Create, design: boolean) {
  const line = lineOf(state);
  // A unit's line: the design's own control sets it, as it opens Create, which is closed again.
  if (line && design) {
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("button", { name: "Team", exact: true })
      .click();
    await inDesign(page, line.control);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Create New Agent" }).waitFor({ state: "detached" });
  }
  // The options are New template's, in Settings: Create for an agent has none. On a phone Settings
  // opens on its sections, and Templates is chosen from them.
  const settings = await openSettingsWindow(page);
  if ((page.viewportSize()?.width ?? 0) < 640)
    await settings
      .getByRole("navigation", { name: "Settings" })
      .getByRole("button", { name: "Templates" })
      .click();
  await settings.getByRole("button", { name: "New template", exact: true }).click();
  const window = page.getByRole("dialog", { name: "New template" });
  // Once its options are drawn and it has opened, so nothing in it still moves.
  await window.getByRole("region", { name: "Base", exact: true }).waitFor();
  await window.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
  const from = (name: string) =>
    window.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  const card = (name: string) => window.getByRole("region", { name, exact: true });
  if (["local", "typed", "folded", "between", "labels"].includes(state) || line) {
    await from("Assistant");
    await card("Web").waitFor();
  }
  // Every unit, each saying its own line: added as a person adds them, and the options brought to
  // Web's heading.
  if (state === "line-every") {
    for (const unit of ["Agent control", "Skill", "Connection"]) {
      await window.getByRole("button", { name: "Add a unit" }).click();
      await page.getByRole("menuitem", { name: new RegExp(`^${unit}`) }).click();
      await page.getByRole("menu").waitFor({ state: "detached" });
      await card(unit).waitFor();
    }
    await card("Web").evaluate((section) => section.scrollIntoView({ block: "start" }));
  }
  // The computer's own questions, which the design words as its sample's: this computer.
  if (state === "local") {
    await window.getByRole("combobox", { name: /^(Where it resides|Which computer)$/ }).click();
    await page.getByRole("option", { name: "This computer" }).click();
    await window.getByLabel(/^(Workspace directory|Where its work happens)$/).waitFor();
  }
  if (state === "typed") {
    await window.getByLabel("Name").fill("Foreman");
    await window.getByLabel("What it's for").fill("Keeps dependencies current");
  }
  if (state === "folded") await window.getByRole("button", { name: "Fold Computer" }).click();
  if (state === "builder") {
    await from("Builder");
    await card("Agent control").waitFor();
  }
  if (state === "add") {
    await window.getByRole("button", { name: "Add a unit" }).click();
    await page.getByRole("menu").waitFor();
  }
  const rail = window.getByRole("navigation", { name: "Sections" });
  const still = () =>
    rail.evaluate((nav) =>
      Promise.all(nav.getAnimations({ subtree: true }).map((one) => one.finished)),
    );
  // Halfway between the first two headings, once the rail is back at rest.
  if (state === "between") {
    await rail.evaluate((nav) => {
      const box = nav.previousElementSibling as HTMLElement;
      const top =
        box.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(box).paddingTop);
      const [first = 0, second = 0] = [
        ...box.querySelectorAll(":scope > section > div:first-child"),
      ].map((heading) => heading.getBoundingClientRect().top - top + box.scrollTop);
      box.scrollTop = (first + second) / 2;
    });
    await rail.and(page.locator("[data-scrolling]")).waitFor();
    await rail.and(page.locator(":not([data-scrolling])")).waitFor();
    await still();
  }
  // The keyboard in the rail, on its first logo, from the last of the options, which stays put.
  if (state === "labels") {
    await window
      .getByRole("button", { name: "Add a unit" })
      .evaluate((add: HTMLElement) => add.focus({ preventScroll: true }));
    await page.keyboard.press("Tab");
    await still();
  }
  // A press scrolls what it presses into view, by more one time than another: back to the start.
  await page.locator('ul[aria-label="Start from"]').evaluate((row) => {
    row.scrollLeft = 0;
  });
}

/**
 * Create for an agent, small, in its states: as it opens, from Assistant, from Builder, signed out
 * of the model account, and once Create's check has refused: the Computer that can't be had, and a
 * template's answer its unit no longer asks (Storefront worker's which computer). Each with the
 * widths it is shown at.
 */
export const SMALLS = [
  ["opens", ["wide", "phone"]],
  ["assistant", ["wide", "phone"]],
  ["builder", ["wide"]],
  ["out", ["wide"]],
  ["cant", ["wide", "phone"]],
  ["refused", ["wide"]],
] as const;
export type Small = (typeof SMALLS)[number][0];
/** The install steps, the Computer's connector's words while AgentComputer isn't there. */
const INSTALL_STEPS =
  "AgentComputer isn't installed on this computer. Install it with npm install -g @agentorg/computer and try again. AgentOrg starts it for you.";
/** The built side as the state has it, after the design's sample of what an agent is built from. */
export function smallSays(gateway: Gateway, state: Small) {
  if (state === "out") signInAccount(gateway, "out");
  if (state === "cant") gateway.computerRefuses(INSTALL_STEPS);
  // The Computer states this computer, so it asks no longer which.
  if (state === "refused") gateway.stateComputer(READY);
}
/**
 * Create for an agent in one of its states, reached as a person reaches it, and at rest. The
 * design draws its two refusals from its own bar; the built side presses Create.
 */
export async function smallState(page: Page, state: Small, design: boolean) {
  if (state === "out" && design) await inDesign(page, /^ChatGPT:/);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("button", { name: "Team", exact: true })
    .click();
  const window = page.getByRole("dialog", { name: "Create New Agent" });
  const refused = state === "cant" || state === "refused";
  if (design && refused)
    await inDesign(
      page,
      state === "cant" ? "Create: the Computer can't be had" : "Create: a refused template",
    );
  else {
    await page.getByRole("main").getByRole("button", { name: "Create", exact: true }).click();
    const start =
      state === "builder" ? "Builder" : state === "refused" ? "Storefront worker" : "Assistant";
    if (state !== "opens")
      await window.getByRole("button", { name: new RegExp(`^${start}`) }).click();
    if (refused) {
      await window.getByRole("button", { name: "Create", exact: true }).click();
      await window.getByRole("alert").waitFor();
    }
  }
  await window.getByRole("button", { name: "Create", exact: true }).waitFor();
  await window.evaluate((e) =>
    Promise.all(
      e
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
        .map((a) => a.finished),
    ),
  );
  // A press scrolls what it presses into view, the window too: both back to their start.
  await window.locator('ul[aria-label="Start from"]').evaluate((row) => {
    row.scrollLeft = 0;
  });
  await window.evaluate((e) => {
    e.scrollLeft = 0;
  });
}

/**
 * The Settings window, opened from the bar's Settings as a person opens it, at rest once it has
 * opened.
 */
export async function openSettingsWindow(page: Page) {
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("button", { name: "Settings" })
    .click();
  const window = page.getByRole("dialog", { name: "Settings" });
  await window.waitFor();
  await window.evaluate((e) => Promise.all(e.getAnimations().map((moving) => moving.finished)));
  return window;
}

/** Templates, the section Settings opens on, with its rows read. */
export async function openTemplates(page: Page) {
  const window = await openSettingsWindow(page);
  const templates = window.getByRole("region", { name: "Templates" });
  // On a phone the window opens on its sections, and Templates is chosen from them.
  if ((page.viewportSize()?.width ?? 0) < 640)
    await window
      .getByRole("navigation", { name: "Settings" })
      .getByRole("button", { name: "Templates" })
      .click();
  await templates.getByText("Storefront worker").waitFor();
}

/** The sections of Settings that have contents of their own to measure, by their row's words. */
export const SECTIONS = [
  ["skills", "Skills"],
  ["mcps", /^MCP/],
  ["providers", "Providers"],
  ["account", "Account"],
] as const;
export type Section = (typeof SECTIONS)[number][0];

/** One of Settings' sections, chosen in its window as a person chooses it, with its contents read. */
export async function openSection(page: Page, section: Section) {
  const window = await openSettingsWindow(page);
  const name = SECTIONS.find(([id]) => id === section)?.[1] ?? "";
  await window.getByRole("navigation", { name: "Settings" }).getByRole("button", { name }).click();
  await window.getByRole("region", { name }).locator("li, section").first().waitFor();
}

/** What a section offers, opened from the window's top line: Skills' and MCP connections' dialogs. */
export async function openOffer(page: Page, section: "skills" | "mcps") {
  await openSection(page, section);
  const [offer, title] =
    section === "skills" ? ["Add skill", "Add skill"] : ["Connect", "Connect an MCP"];
  await page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("button", { name: offer, exact: true })
    .click();
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
