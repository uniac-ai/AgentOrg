// What the built side is given for the measured screens, as the design's sample has it: its
// computer and terminals, replies not yet read, sample chats to open, and what a page asks; and
// the design page's own controls, which put it in the cases it draws.
import type { Page } from "@playwright/test";
import type { Agent, standIn } from "../stand-in.ts";

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

/** Research's computer with one live surface, which may be operated or only watched. */
export function computerWith(gateway: Gateway, surface: "terminal" | "browser", operate = true) {
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
        surfaces: [
          {
            surface,
            protocol: surface === "terminal" ? "terminal@1" : "screencast@1",
            operate,
          },
        ],
      },
    },
  ];
}

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
