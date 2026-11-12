/**
 * A worker's request as the agent's host made it, without what the looper adds: its words after
 * the agent's, its one function beside the agent's tools, and the number each of the person's
 * messages starts with.
 */
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
          instructions: request.instructions.replace(
            /(\n\n)?This is one piece of work: [\s\S]*$/,
            "",
          ),
        }),
    ...(request.tools === undefined
      ? {}
      : { tools: request.tools.filter((tool) => tool.name !== "hand_back") }),
    input: request.input.map((item) => {
      const message = item as { type?: string; role?: string; content?: unknown };
      return message.type === "message" &&
        message.role === "user" &&
        typeof message.content === "string"
        ? { ...message, content: message.content.replace(/^\[\d+(\.\d+)?\] /, "") }
        : item;
    }),
  };
}
