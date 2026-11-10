// The built side's chats for the measured screens of the collapsed chat and its list: replies not
// yet read, one agent's at a time, and one chat with nothing new in it.
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
