// The built side's chats for the measured screens: replies not yet read, one agent's at a time,
// one chat with nothing new in it, and the design's own sample chats to open.
import type { standIn } from "../stand-in.ts";

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

/** Two chats as the design's sample has them: one with a call and a reply, one with a problem. */
export function sampleChats(gateway: Gateway) {
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  gateway.addChat("a-reviewer", {
    id: "c-review",
    title: "Review #482",
    said: [
      { id: "v-u1", role: "user", text: "Review #482 before I merge it.", at: at(13) },
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
