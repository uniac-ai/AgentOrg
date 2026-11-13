/**
 * The agents this one talks to: each one's conversations exposed to it, found by whose they are.
 * It sends to them from itself, so each knows who speaks, and reads only its own conversation
 * with each.
 */
import { chat } from "@agentorg/interfaces";
import type { Outcome } from "@agentorg/looper";
import { describeInterface, type ExposedSlot, type Slot } from "@agentorg/sdk";
import type { Candidate } from "./tools.js";
import { cut, fits } from "./work.js";

const SLOT = "agents";
const CHAT_ID = describeInterface(chat).id;
/** A read gives this many messages unless asked for another number. */
const READ = 20;
/** What one message's text keeps in a read, so the newest fits as a rule. */
const READ_TEXT = 20_000;

type Chats = Slot<typeof chat>["call"];

const none = (agent: unknown): Outcome => ({
  output: `You have no agent ${String(agent).slice(0, 128)} to talk to.`,
  ok: false,
  code: "unknown",
});

/** The two functions over the conversations exposed to the agent, if any are. */
export function agentTools(exposed: readonly ExposedSlot[]): Candidate[] {
  const reached = exposed.filter((one) => one.described.id === CHAT_ID);
  if (reached.length === 0) return [];
  const of = (agent: unknown) =>
    reached.find((one) => one.provider.actor === agent)?.call as Chats | undefined;
  // The ids it can reach, so the model needn't look them up.
  const agent = {
    type: "string",
    description: "The agent's id.",
    enum: reached.map((one) => one.provider.actor),
  };
  return [
    {
      slot: SLOT,
      name: "send",
      description:
        "Say a message to an agent you talk to, in your conversation with it. It returns at once; the agent works on its own and answers there.",
      parameters: {
        type: "object",
        properties: { agent, text: { type: "string", description: "What to say." } },
        required: ["agent", "text"],
        additionalProperties: false,
      },
      run: async (input) => {
        const { agent: id, text } = input as { agent?: unknown; text?: unknown };
        const to = of(id);
        if (!to) return none(id);
        const { messageId } = await to.send({ text } as { text: string });
        return { output: JSON.stringify({ messageId }), ok: true };
      },
    },
    {
      slot: SLOT,
      name: "read",
      description:
        "Your conversation with an agent you talk to, oldest first, a page at a time; whether it is working now; and, if a message in it got no answer, why.",
      parameters: {
        type: "object",
        properties: {
          agent,
          before: { type: "string", description: "Read the messages before this one's id." },
          limit: { type: "number", description: "How many messages, at most 200." },
        },
        required: ["agent"],
        additionalProperties: false,
      },
      run: async (input) => {
        const { agent: id, before, limit = READ } = input as Record<string, unknown>;
        const to = of(id);
        if (!to) return none(id);
        const [page, { state }, { conversations }] = await Promise.all([
          to.history({ before, limit } as { before?: string; limit: number }),
          to.state({}),
          to.list({}),
        ]);
        const problem = conversations[0]?.problem;
        const answer = {
          working: state === "working",
          ...(problem ? { problem } : {}),
          messages: page.messages.map(({ id: messageId, role, text, at }) => ({
            id: messageId,
            role,
            text: cut(text, READ_TEXT),
            at,
          })),
          more: page.more,
        };
        // Its oldest messages go first, so another agent's loop takes it whole.
        while (answer.messages.length > 1 && !fits(answer)) {
          answer.messages.shift();
          answer.more = true;
        }
        return { output: JSON.stringify(answer), ok: true };
      },
    },
  ];
}
