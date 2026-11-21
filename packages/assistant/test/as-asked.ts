import { FRAME, OWN_FUNCTIONS } from "@agentorg/looper";

/**
 * A worker's request as the agent's host made it, without what the looper adds: its frame before
 * the agent's words and its words after them, its functions beside the agent's tools, and the
 * number each of the person's messages starts with. What the worker sent is put as the message it
 * said.
 */
/** What a worker is told without the looper's frame before it. */
const unframed = (text: string) =>
  text.startsWith(FRAME) ? text.slice(FRAME.length).replace(/^\n\n/, "") : text;
/** The looper's own functions, offered beside the agent's tools. */
const LOOPERS = OWN_FUNCTIONS;

export function asAsked<
  T extends {
    instructions?: string | undefined;
    tools?: { name: string }[] | undefined;
    input: unknown[];
  },
>(request: T): T {
  return {
    ...request,
    ...(request.instructions === undefined
      ? {}
      : {
          instructions: unframed(request.instructions).replace(
            /(\n\n)?This is one piece of work: [\s\S]*$/,
            "",
          ),
        }),
    ...(request.tools === undefined
      ? {}
      : { tools: request.tools.filter((tool) => !LOOPERS.includes(tool.name)) }),
    input: request.input.flatMap((item) => {
      const message = item as {
        type?: string;
        role?: string;
        content?: unknown;
        name?: string;
        callId?: string;
        arguments?: string;
        output?: string;
      };
      if (message.type === "function_call" && message.name === "send") {
        const { text } = JSON.parse(message.arguments ?? "{}") as { text?: string };
        return [{ type: "message", role: "assistant", content: text }];
      }
      if (message.type === "function_call_output" && message.output === "Sent.") {
        const call = request.input.find(
          (one) =>
            (one as { callId?: string }).callId === message.callId &&
            (one as { name?: string }).name === "send",
        );
        if (call) return [];
      }
      return message.type === "message" &&
        message.role === "user" &&
        typeof message.content === "string"
        ? [{ ...message, content: message.content.replace(/^\[\d+(\.\d+)?\] /, "") }]
        : [item];
    }) as T["input"],
  };
}

type Item = { type: string; [key: string]: unknown };
const NEWEST = "newest";
/**
 * A conversation's own loop passing the newest message it holds on (see `named`): to the work it
 * was told of first, in the last item of its request, which is what a follow-up is given to; or
 * with none, to new work.
 */
export const passOn = (input: readonly unknown[] = [], title = "Work"): Item => {
  const listed = String((input.at(-1) as { content?: unknown } | undefined)?.content ?? "");
  // Of the work this conversation has: another conversation's is not where its follow-ups go.
  const there = listed
    .split("\n")
    .find((line) => line.startsWith("- ") && !/; in another conversation\)/.test(line))
    ?.match(/^- ([^:\s]+): /)?.[1];
  return {
    type: "function_call",
    callId: crypto.randomUUID(),
    name: "route",
    arguments: JSON.stringify({ message: NEWEST, ...(there ? { work: there } : { title }) }),
  };
};
/** A worker's reply, sent to the newest message it read and hasn't handed back (see `named`). */
export const sendOf = (text: string): Item => ({
  type: "function_call",
  callId: crypto.randomUUID(),
  name: "send",
  arguments: JSON.stringify({ message: NEWEST, text }),
});
/** `output`'s `send`s and `no_reply_needed`s that name no message, as `sendOf` makes them, made to name the newest one `input` holds that wasn't handed back. */
export function named(output: Item[], input: Item[]): Item[] {
  // Handed back, or passed on by a conversation's own loop.
  const back = new Set(
    input.flatMap((item) =>
      item.type === "function_call" &&
      (item.name === "hand_back" || item.name === "route") &&
      input.some(
        (one) =>
          one.type === "function_call_output" &&
          one.callId === item.callId &&
          /^(Handed back|Passed on)/.test(String(one.output)),
      )
        ? [(JSON.parse(String(item.arguments)) as { message: number }).message]
        : [],
    ),
  );
  const newest = input
    .flatMap((item) =>
      item.type === "message" && item.role === "user"
        ? [Number(/^\[(\d+)\]/.exec(String(item.content))?.[1] ?? 0)]
        : [],
    )
    .findLast((number) => number > 0 && !back.has(number));
  return output.map((item) => {
    if (
      item.type !== "function_call" ||
      !["send", "no_reply_needed", "route"].includes(String(item.name))
    )
      return item;
    const args = JSON.parse(String(item.arguments)) as { message?: unknown };
    return args.message === NEWEST
      ? { ...item, arguments: JSON.stringify({ ...args, message: newest }) }
      : item;
  });
}
/**
 * Whether a request only follows what its worker sent, with nothing said since: a stand-in model
 * answers it with nothing, as a model that has said all it had.
 */
export const followsSend = (input: Item[]) => {
  const tail = input.at(-1);
  return (
    tail?.type === "function_call_output" &&
    tail.output === "Sent." &&
    input.some(
      (item) =>
        item.type === "function_call" && item.name === "send" && item.callId === tail.callId,
    )
  );
};
